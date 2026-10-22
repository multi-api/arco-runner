// The Docker integration suite (spec §11.2): the real runner image in MicroVM mode, driven like Lambda and Cloud
// drive it, against the fake Cloud. The scenarios share one runner container and run in order: the second build
// relies on the first one's warm VM, as a resumed MicroVM would.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  API_BASE, CACHE_KEY, CONTROL, INTEGRATION_DIR, compose, commit, execRunner, finishBody, healthz, hook, http,
  isCachePut, isClaim, isFinish, isIdleCall, isStart, leakedSecrets, logLines, newJob, nodeInRunner, recorded, seedCache, statusesOf,
  steps, untilDone, waitFor, type Job,
} from './helpers.js';

const BOUNDARY = 'arn:aws:iam::123456789012:policy/ArcoBoundary';
const VENDOR = '/home/build/work/repo/app/vendor';
const ORIGINAL_LOCK = readFileSync(join(INTEGRATION_DIR, '../fixture/app/composer.lock'), 'utf8');

const postJob = async (job: Job) => {
  const r = await http('POST', `${CONTROL}/job`, job.payload);
  expect(r.status).toBe(202);
};

let sha1 = '';
let sha3 = '';

beforeAll(async () => {
  // Lambda: /ready, then the image's /validate (the snapshot every VM resumes from is taken after it).
  await waitFor('/ready', async () => (await hook('ready').catch(() => ({ status: 0 }))).status === 200, 120_000);
  const validated = await waitFor('/validate', async () => {
    const { status } = await hook('validate');
    return status === 200 || status === 500 ? status : null;
  }, 900_000, 1000);
  expect(validated).toBe(200);
  expect(await healthz()).toBe('idle');

  sha1 = await commit({}, 'initial');
  // A cache saved by an earlier VM of this environment: lock hashes unknown, so the first build also saves.
  await seedCache(
    { version: 1, key: CACHE_KEY, lock: { composer: null, npm: null, yarn: null, pnpm: null }, created_at: '2026-10-01T00:00:00Z' },
    { 'work/repo/app/vendor/.arco-seed': 'restored from the cache\n' },
  );
}, 1_000_000);

describe('runner image against a fake Cloud', () => {
  test('deploy happy path', async () => {
    const job = await newJob('happy', { sha: sha1 });
    expect((await hook('run', job.payload)).status).toBe(200); // a new VM: Lambda delivers the ticket to /run
    const { cloud, git } = await untilDone(job);

    for (const key of ['build.clone', 'build.cache_restore', 'build.command.1', 'build.command.2', 'build.command.3']) {
      expect(statusesOf(cloud, key), key).toEqual(['started', 'done']);
    }
    expect(steps(cloud).find((s) => s.key === 'build.command.2')?.params).toEqual({ command: 'npm ci --offline' });
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded', error_code: null, arco_version: '0.10.0' });
    expect(cloud.some(isIdleCall)).toBe(true);
    expect(cloud.findIndex(isIdleCall)).toBeGreaterThan(cloud.findIndex(isFinish));
    expect(git.length).toBeGreaterThan(0);

    // The secrets did reach the build and arco (masked on the way out) ...
    const lines = logLines(cloud);
    expect(lines).toContain('fake-arco env APP_SECRET=***');
    expect(lines).toContain('fake-arco env-b64 AWS_SECRET_ACCESS_KEY=***');
    // ... and no secret, in any variant, is in anything Cloud received.
    expect(leakedSecrets(job, cloud)).toEqual([]);
    // The restored cache was extracted (as build), then the save replaced it.
    expect(cloud.filter(isCachePut)).toHaveLength(1);
  });

  test('warm second build', async () => {
    // The wipe kept vendor/ (and only the cache roots) in the checkout.
    const kept = await execRunner(`test -x ${VENDOR}/bin/arco && test ! -e /home/build/work/repo/README && stat -c %i ${VENDOR}/multiapi/arco/composer.json`);
    expect(kept.code, kept.stderr).toBe(0);
    const sha2 = await commit({ README: '# Fixture app\n\nOnly the README changes.\n' }, 'readme');

    // Lambda suspends the idle VM and resumes it; Cloud then posts the ticket to /job.
    expect((await hook('suspend')).status).toBe(200);
    expect((await hook('resume')).status).toBe(200);
    const job = await newJob('warm', { sha: sha2 });
    await postJob(job);
    const { cloud } = await untilDone(job);

    expect(statusesOf(cloud, 'build.cache_restore')).toEqual([]);
    expect(logLines(cloud)).toContain('Nothing to install, update or remove');
    const after = await execRunner(`stat -c %i ${VENDOR}/multiapi/arco/composer.json`);
    expect(after.stdout).toBe(kept.stdout); // the same file: composer did not reinstall
    expect(cloud.filter(isCachePut)).toEqual([]);
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });
  });

  test('lock change saves', async () => {
    sha3 = await commit({ 'app/composer.lock': `${ORIGINAL_LOCK}\n` }, 'touch composer.lock');
    const job = await newJob('lock', { sha: sha3 });
    await postJob(job);
    const { cloud } = await untilDone(job);

    const puts = cloud.filter(isCachePut);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.pathname).toBe(`/s3/${CACHE_KEY}`);
    expect(puts[0]!.path).toContain(new URL(job.doc.cache.save_url).search);
    expect(puts[0]!.size).toBeGreaterThan(0);
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });
  });

  test('env separation', async () => {
    const job = await newJob('env', {
      sha: sha3, permissionsBoundary: BOUNDARY,
      commands: ['composer install --prefer-dist --no-interaction', 'env > /tmp/e && cat /tmp/e'],
    });
    await postJob(job);
    const { cloud } = await untilDone(job);
    const lines = logLines(cloud);

    // The build command's environment: the build variables (secrets masked), nothing of AWS or the agent's own.
    expect(lines).toContain('ARCO_RUNNER=1');
    expect(lines).toContain('APP_SECRET=***');
    expect(lines.filter((l) => l.startsWith('AWS_'))).toEqual([]);
    expect(lines.filter((l) => /^ARCO_RUNNER_(ALLOW|TICKET|API|DEPLOY)/.test(l))).toEqual([]);
    // arco's environment: the AWS credentials (masked), and the boundary for deploy only.
    expect(lines).toContain('fake-arco env AWS_SECRET_ACCESS_KEY=***');
    expect(lines).toContain('fake-arco env AWS_ACCESS_KEY_ID=***');
    expect(lines).toContain('fake-arco env AWS_REGION=us-east-1');
    expect(lines).toContain(`fake-arco env ARCO_PERMISSIONS_BOUNDARY=${BOUNDARY}`);
    expect(lines).toContain('fake-arco info has AWS_SECRET_ACCESS_KEY=yes');
    expect(lines).toContain('fake-arco info ARCO_PERMISSIONS_BOUNDARY=');
    expect(leakedSecrets(job, cloud)).toEqual([]);
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });
  });

  test('failing command', async () => {
    const job = await newJob('fail', { sha: sha3, commands: ['echo about to fail', 'exit 3', 'echo never'] });
    await postJob(job);
    const { cloud } = await untilDone(job);

    expect(finishBody(cloud)).toMatchObject({
      result: 'failed', error_code: 'build.command_failed', error_message: '`exit 3` exited with code 3',
    });
    expect(statusesOf(cloud, 'build.command.1')).toEqual(['started', 'done']);
    expect(statusesOf(cloud, 'build.command.2')).toEqual(['started']);
    expect(statusesOf(cloud, 'build.command.3')).toEqual([]);
    expect(logLines(cloud)).not.toContain('never');
    expect(cloud.some(isIdleCall)).toBe(true);
  });

  test('timeout', async () => {
    const job = await newJob('timeout', { sha: sha3, timeoutSeconds: 5, commands: ['sleep 60'] });
    const t0 = Date.now();
    await postJob(job);
    const { cloud } = await untilDone(job);

    expect(finishBody(cloud)).toMatchObject({
      result: 'failed', error_code: 'build.timeout', error_message: 'The build did not finish within 5 seconds',
    });
    expect(Date.now() - t0).toBeLessThan(45_000);
    expect(cloud.some(isIdleCall)).toBe(true);
  });

  test('cancel mid-command', async () => {
    const job = await newJob('cancel', { sha: sha3, commands: ['sleep 60'] });
    await postJob(job);
    await waitFor('sleep 60 to start', async () => statusesOf((await recorded(job)).cloud, 'build.command.1').includes('started'));

    const t0 = Date.now();
    const r = await http('POST', `${CONTROL}/cancel`, { deployment_id: job.doc.deployment_id });
    expect(r).toEqual({ status: 202, json: { state: 'cancelling' } });
    await waitFor('finish', async () => (await recorded(job)).cloud.some(isFinish), 10_000);
    expect(Date.now() - t0).toBeLessThan(10_000);

    const { cloud } = await untilDone(job);
    expect(finishBody(cloud)).toMatchObject({ result: 'failed', error_code: 'build.cancelled' });
    expect(cloud.filter(isCachePut)).toEqual([]);
    // A cancel for a job that is not running is idempotent.
    expect(await http('POST', `${CONTROL}/cancel`, { deployment_id: job.doc.deployment_id })).toEqual({ status: 200, json: { state: 'idle' } });
  });

  test('ticket_invalid', async () => {
    const job = await newJob('invalid', { sha: sha3 });
    await postJob({ ...job, payload: { ...job.payload, ticket: 'not-the-ticket-cloud-issued' } });
    await waitFor('the refused claim', async () => (await recorded(job)).cloud.some(isClaim));
    await waitFor('idle', async () => (await healthz()) === 'idle', 10_000);
    const { cloud, git } = await recorded(job);

    expect(cloud.filter(isClaim)).toHaveLength(1);
    expect(cloud.filter(isStart)).toEqual([]);
    expect(cloud.filter(isIdleCall)).toEqual([]);
    expect(git).toEqual([]);
    expect(await healthz()).toBe('idle');
  });

  test('claim 503 then 200', async () => {
    const job = await newJob('claim503', {
      sha: sha3, commands: ['true'], claimAnswers: [{ status: 503, body: { error: 'claim_unavailable' } }],
    });
    await postJob(job);
    const { cloud } = await untilDone(job);

    const claims = cloud.filter(isClaim);
    expect(claims).toHaveLength(2);
    expect(claims[1]!.at - claims[0]!.at).toBeGreaterThanOrEqual(1900); // the first backoff is 2 s
    expect(JSON.parse(claims[1]!.body)).toEqual({ ticket: job.ticket });
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });
  });

  test('start failure', async () => {
    const job = await newJob('start', { sha: sha3, startAnswer: { status: 403, body: { error: 'not_runner' } } });
    await postJob(job);
    const { cloud, git } = await untilDone(job);

    expect(cloud.filter(isStart).length).toBeGreaterThan(0);
    expect(cloud.filter(isFinish)).toEqual([]);
    expect(cloud.filter((r) => r.pathname.endsWith('/logs'))).toEqual([]);
    expect(git).toEqual([]); // nothing was cloned
  });

  test('planted git hook', async () => {
    const plant = await newJob('plant', {
      sha: sha3,
      commands: [
        `mkdir -p ../.git/hooks && printf '#!/bin/sh\\ntouch ${VENDOR}/hook-ran\\n' > ../.git/hooks/post-checkout && chmod +x ../.git/hooks/post-checkout`,
        `git config -f ../.git/config url.${API_BASE}/evil/.insteadOf ${API_BASE}/git/`,
        'git config -f ../.git/config --get-regexp insteadof',
      ],
    });
    await postJob(plant);
    const first = await untilDone(plant);
    expect(finishBody(first.cloud)).toMatchObject({ result: 'succeeded' });
    expect(logLines(first.cloud)).toContain(`url.${API_BASE}/evil/.insteadof ${API_BASE}/git/`);

    const next = await newJob('after-plant', { sha: sha3, commands: ['true'] });
    await postJob(next);
    const { cloud, git } = await untilDone(next);

    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });
    expect(git.length).toBeGreaterThan(0);
    for (const g of git) {
      expect(g.path.startsWith('/git/app.git/')).toBe(true);
      expect(g.authorized).toBe(true);
    }
    const marker = await execRunner(`test ! -e ${VENDOR}/hook-ran`);
    expect(marker.code).toBe(0);
  });

  test('wipe', async () => {
    const job = await newJob('wipe', {
      sha: sha3,
      commands: ['echo registry=http://registry.invalid/ > ~/.npmrc; echo x > /tmp/x; sleep 1000 &', 'sleep 5'],
    });
    await postJob(job);
    await waitFor('the second command', async () => statusesOf((await recorded(job)).cloud, 'build.command.2').includes('started'));

    expect((await hook('suspend')).status).toBe(503);
    const during = await execRunner('test -e /home/build/.npmrc && test -e /tmp/x && pgrep -u 1000 -f "sleep 1000"');
    expect(during.code, during.stderr).toBe(0);

    const { cloud } = await untilDone(job);
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });
    expect((await hook('suspend')).status).toBe(200);
    const files = await execRunner('test ! -e /home/build/.npmrc && test ! -e /tmp/x');
    expect(files.code, files.stderr).toBe(0);
    const procs = await execRunner('pgrep -u 1000');
    expect(procs.stdout).toBe('');
    expect(procs.code).toBe(1); // pgrep: no process matched
  });

  test('inventory mode', async () => {
    const job = await newJob('inventory', { sha: sha3, mode: 'inventory', commands: ['composer install --prefer-dist --no-interaction'] });
    await postJob(job);
    const { cloud } = await untilDone(job);

    expect(logLines(cloud)).not.toContain('fake-arco deploy invoked');
    const finish = finishBody(cloud);
    expect(finish).toMatchObject({ result: 'succeeded', revision: null, arco_version: '0.10.0' });
    expect(finish.inventory).toMatchObject({ app: 'fixture', resources: [{ type: 'queue', name: 'jobs' }] });
  });

  test("Node's global fetch uses the dispatcher that /resume swaps", async () => {
    // agent.resume() replaces globalThis[Symbol.for('undici.globalDispatcher.1')]; check on the image's Node 24
    // that fetch really dispatches through whatever is stored there, before and after a swap.
    const script = `
      const sym = Symbol.for('undici.globalDispatcher.1');
      const url = '${API_BASE}/admin/health';
      await fetch(url);
      const spy = (d) => { let n = 0; const orig = d.dispatch.bind(d); d.dispatch = (o, h) => { n++; return orig(o, h); }; return () => n; };
      const first = globalThis[sym];
      const firstCount = spy(first);
      await fetch(url);
      const swapped = new first.constructor();
      globalThis[sym] = swapped;
      await first.close();
      const swappedCount = spy(swapped);
      const r = await fetch(url);
      console.log(JSON.stringify({ version: process.version, first: firstCount(), swapped: swappedCount(), status: r.status }));
    `;
    const r = await nodeInRunner(script);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as { version: string; first: number; swapped: number; status: number };
    expect(out.version).toMatch(/^v24\./);
    expect(out).toMatchObject({ first: 1, swapped: 1, status: 200 });
  });

  test('fargate mode', async () => {
    const job = await newJob('fargate', { sha: sha3 });
    const run = await compose([
      'run', '--rm', '--no-deps', '-T',
      '-e', `ARCO_RUNNER_TICKET=${job.ticket}`, '-e', `ARCO_RUNNER_API_BASE=${API_BASE}`,
      '-e', `ARCO_RUNNER_DEPLOYMENT_ID=${job.doc.deployment_id}`,
      'runner',
    ], { timeoutMs: 300_000 });
    expect(run.code, run.stdout + run.stderr).toBe(0);

    const { cloud } = await recorded(job);
    expect(cloud.some(isIdleCall)).toBe(true);
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });
    // A fresh task restores the cache saved by the MicroVM builds.
    expect(statusesOf(cloud, 'build.cache_restore')).toEqual(['started', 'done']);
    expect(leakedSecrets(job, cloud)).toEqual([]);
  });
});
