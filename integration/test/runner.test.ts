// The Docker integration suite (spec §11.2): the real runner image in MicroVM mode, driven like Lambda and Cloud
// drive it, against the fake Cloud. The scenarios share one runner container and run in order: the second build
// relies on the first one's warm VM, as a resumed MicroVM would. vitest bails on the first failure (bail: 1): a
// later scenario would only fail for the state an earlier failure left behind.
//
// Like Cloud, the fake Cloud calls the runner's /suspend hook before it answers /idle (R22); every MicroVM
// scenario that reports idle checks that hook answered 200 (a 503 makes Cloud terminate the VM).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent as HttpAgent, request } from 'node:http';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  API_BASE, CACHE_KEY, CONTROL, HOOKS, INTEGRATION_DIR, compose, commit, execRunner, finishBody, healthz, hook, http,
  isCachePut, isClaim, isCredentials, isFinish, isIdleCall, isStart, leakedSecrets, logLines, newJob, nodeInRunner, recorded, seedCache,
  statusesOf, steps, testsJob, untilDone, waitFor, type Job, type Recorded,
} from './helpers.js';

const BOUNDARY = 'arn:aws:iam::123456789012:policy/ArcoBoundary';
const VENDOR = '/home/build/work/repo/app/vendor';
const ORIGINAL_LOCK = readFileSync(join(INTEGRATION_DIR, '../fixture/app/composer.lock'), 'utf8');

/** The fake Cloud's /suspend call while answering this job's /idle was accepted (exactly once). */
const expectSuspended = (r: { suspends: { status: number }[] }) => expect(r.suspends.map((x) => x.status)).toEqual([200]);

const postJob = async (job: Job) => {
  const r = await http('POST', `${CONTROL}/job`, job.payload);
  expect(r.status).toBe(202);
};

// ---------------------------------------------------------------- the test files (run by the fixture's fake PHPUnit)
// Each file returns array<string, Closure>: a closure that throws fails.

/** A round trip through PDO with the `<prefix>HOST`, `PORT`, `DATABASE`, `USERNAME`, `PASSWORD` variables. */
const pdoTest = (driver: 'mysql' | 'pgsql', prefix: string) => `<?php
return [
    '${driver} round trip through ${prefix}*' => function (): void {
        $e = fn (string $k): string => (string) getenv('${prefix}'.$k);
        if ('${prefix}' === 'DB_' && getenv('DB_CONNECTION') !== '${driver}') {
            throw new RuntimeException('DB_CONNECTION is '.getenv('DB_CONNECTION'));
        }
        $pdo = new PDO(sprintf('${driver}:host=%s;port=%s;dbname=%s', $e('HOST'), $e('PORT'), $e('DATABASE')), $e('USERNAME'), $e('PASSWORD'),
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE arco_${driver} (v VARCHAR(20))');
        $pdo->exec("INSERT INTO arco_${driver} VALUES ('round trip')");
        if ($pdo->query('SELECT v FROM arco_${driver}')->fetchColumn() !== 'round trip') {
            throw new RuntimeException('${driver}: the row did not come back');
        }
    },
];
`;

const SQLITE_TEST = `<?php
return [
    'sqlite round trip' => function (): void {
        if (getenv('DB_CONNECTION') !== 'sqlite') {
            throw new RuntimeException('DB_CONNECTION is not sqlite');
        }
        $pdo = new PDO('sqlite:'.getenv('DB_DATABASE'), null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE t (v TEXT)');
        $pdo->exec("INSERT INTO t VALUES ('round trip')");
        if ($pdo->query('SELECT v FROM t')->fetchColumn() !== 'round trip') {
            throw new RuntimeException('the row did not come back');
        }
    },
    'runs in the test environment' => function (): void {
        if (getenv('APP_ENV') !== 'testing' || ! str_starts_with((string) getenv('APP_KEY'), 'base64:')) {
            throw new RuntimeException('not the test environment');
        }
    },
];
`;

const FAILING_TEST = `<?php
return [
    'passes' => fn () => null,
    'fails on purpose' => function (): void {
        throw new RuntimeException('the assertion failed');
    },
];
`;

const ENV_TEST = `<?php
return [
    'dumps its environment' => function (): void {
        foreach (getenv() as $k => $v) {
            echo 'ENV ', $k, '=', str_replace("\n", '\\n', $v), "\n";
        }
    },
];
`;

const REDIS_TEST = `<?php
return [
    'redis round trip' => function (): void {
        if (getenv('REDIS_CLIENT') !== 'phpredis') {
            throw new RuntimeException('REDIS_CLIENT is '.getenv('REDIS_CLIENT'));
        }
        $redis = new Redis();
        $redis->connect(getenv('REDIS_HOST'), (int) getenv('REDIS_PORT'), 5.0);
        $redis->set('arco', 'round trip');
        if ($redis->get('arco') !== 'round trip') {
            throw new RuntimeException('the value did not come back');
        }
    },
];
`;

const SLEEP_TEST = `<?php
return [
    'sleeps' => function (): void {
        sleep(60);
    },
];
`;

const PGSQL_SLEEP_TEST = `<?php
return [
    'sleeps in PostgreSQL' => function (): void {
        $pdo = new PDO(sprintf('pgsql:host=%s;port=%s;dbname=%s', getenv('DB_HOST'), getenv('DB_PORT'), getenv('DB_DATABASE')),
            getenv('DB_USERNAME'), getenv('DB_PASSWORD'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        echo "sleeping in PostgreSQL\n";
        $pdo->query('SELECT pg_sleep(60)');
    },
];
`;

/** The test files committed so far (the fixture's ExampleTest first): each commitTests replaces them all. */
let testFiles = ['ExampleTest'];

/** Commits `files` as app/tests/<name>.php, deleting the test files of earlier commits; returns the sha. */
async function commitTests(files: Record<string, string>): Promise<string> {
  const change: Record<string, string | null> = Object.fromEntries(testFiles.map((n) => [`app/tests/${n}.php`, null]));
  for (const [name, source] of Object.entries(files)) change[`app/tests/${name}.php`] = source;
  testFiles = Object.keys(files);
  return commit(change, `tests: ${testFiles.join(', ')}`);
}

/** The events of a /logs request (none for any other request). */
const logsEvents = (r: Recorded): Record<string, unknown>[] =>
  r.pathname.endsWith('/logs') ? (JSON.parse(r.body) as { events: Record<string, unknown>[] }).events : [];

/** Runs a job whose tests use `services`, and checks the services started and the tests and the deploy passed. */
async function expectServicesPass(job: Job, services: string[]): Promise<Recorded[]> {
  await postJob(job);
  const done = await untilDone(job);
  const { cloud } = done;
  expectSuspended(done);
  expect(leakedSecrets(job, cloud)).toEqual([]);

  expect(statusesOf(cloud, 'build.test_services')).toEqual(['started', 'done']);
  const startMs = steps(cloud).find((s) => s.key === 'build.test_services' && s.status === 'done')?.params?.start_ms as Record<string, number>;
  expect(Object.keys(startMs).sort()).toEqual([...services].sort());
  for (const s of services) expect(startMs[s]).toBeGreaterThanOrEqual(0);
  expect(statusesOf(cloud, 'build.tests')).toEqual(['started', 'done']);
  expect(steps(cloud).find((s) => s.key === 'build.tests' && s.status === 'done')?.params).toMatchObject({ report: 'junit', failed: 0 });
  expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });
  expect(cloud.filter(isCredentials)).toHaveLength(1);
  return cloud;
}

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
    // A new VM: Lambda delivers RunMicrovm's runHookPayload (Cloud's JSON-encoded payload) wrapped in this envelope.
    expect((await hook('run', { microvmId: 'mvm-integration', runHookPayload: JSON.stringify(job.payload) })).status).toBe(200);
    const done = await untilDone(job);
    const { cloud, git } = done;
    expectSuspended(done);

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
    const seed = await execRunner(`test -f ${VENDOR}/.arco-seed && stat -c %u ${VENDOR}/.arco-seed`);
    expect(seed.code, seed.stderr).toBe(0);
    expect(seed.stdout.trim()).toBe('1000');
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
    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);

    expect(statusesOf(cloud, 'build.cache_restore')).toEqual([]);
    expect(logLines(cloud)).toContain('Nothing to install, update or remove');
    const after = await execRunner(`stat -c %i ${VENDOR}/multiapi/arco/composer.json`);
    expect(after.stdout).toBe(kept.stdout); // the same file: composer did not reinstall
    expect(cloud.filter(isCachePut)).toEqual([]);
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });
    expect(leakedSecrets(job, cloud)).toEqual([]);
  });

  test('lock change saves', async () => {
    sha3 = await commit({ 'app/composer.lock': `${ORIGINAL_LOCK}\n` }, 'touch composer.lock');
    const job = await newJob('lock', { sha: sha3 });
    await postJob(job);
    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);
    expect(leakedSecrets(job, cloud)).toEqual([]);

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
    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);
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
    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);
    expect(leakedSecrets(job, cloud)).toEqual([]);

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
    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);
    expect(leakedSecrets(job, cloud)).toEqual([]);

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

    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);
    expect(leakedSecrets(job, cloud)).toEqual([]);
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
    expect(leakedSecrets(job, cloud)).toEqual([]);
  });

  test('claim 503 then 200', async () => {
    const job = await newJob('claim503', {
      sha: sha3, commands: ['true'], claimAnswers: [{ status: 503, body: { error: 'claim_unavailable' } }],
    });
    await postJob(job);
    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);

    const claims = cloud.filter(isClaim);
    expect(claims).toHaveLength(2);
    expect(claims[1]!.at - claims[0]!.at).toBeGreaterThanOrEqual(1900); // the first backoff is 2 s
    expect(JSON.parse(claims[1]!.body)).toEqual({ ticket: job.ticket });
    expect(leakedSecrets(job, cloud)).toEqual([]);
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });
  });

  test('start failure', async () => {
    const job = await newJob('start', { sha: sha3, startAnswer: { status: 403, body: { error: 'not_runner' } } });
    await postJob(job);
    const done = await untilDone(job);
    const { cloud, git } = done;
    expectSuspended(done);
    expect(leakedSecrets(job, cloud)).toEqual([]);

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
    expectSuspended(first);
    expect(leakedSecrets(plant, first.cloud)).toEqual([]);
    expect(finishBody(first.cloud)).toMatchObject({ result: 'succeeded' });
    expect(logLines(first.cloud)).toContain(`url.${API_BASE}/evil/.insteadof ${API_BASE}/git/`);

    const next = await newJob('after-plant', { sha: sha3, commands: ['true'] });
    await postJob(next);
    const done = await untilDone(next);
    const { cloud, git } = done;
    expectSuspended(done);
    expect(leakedSecrets(next, cloud)).toEqual([]);

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

    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);
    expect(leakedSecrets(job, cloud)).toEqual([]);
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
    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);
    expect(leakedSecrets(job, cloud)).toEqual([]);

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

  test('/resume after a suspend on a kept-alive hook connection', async () => {
    // Lambda's hook caller sits outside the VM. A socket it kept alive from /suspend must not be
    // reset when the VM wakes (first staging warm deploy failed: "Resume lifecycle hook failed").
    // docker pause freezes the container like a suspend; the monotonic clock keeps running.
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    const post = (name: string) => new Promise<string>((resolve) => {
      const req = request(`${HOOKS}/${name}`, { method: 'POST', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(String(res.statusCode)));
      });
      req.on('error', (e: NodeJS.ErrnoException) => resolve(`error ${e.code ?? e.message}`));
      req.end('{}');
    });
    try {
      for (let i = 0; i < 3; i++) {
        expect(await post('suspend')).toBe('200');
        expect((await compose(['pause', 'runner'])).code).toBe(0);
        await new Promise((r) => setTimeout(r, 6000));
        expect((await compose(['unpause', 'runner'])).code).toBe(0);
        expect(await post('resume')).toBe('200');
      }
    } finally {
      agent.destroy();
      await compose(['unpause', 'runner']);
    }
    expect(await healthz()).toBe('idle');
  });

  // ---------------------------------------------------------------- tests before deploy (the fake PHPUnit)

  test('tests: SQLite suite passes, then build and deploy', async () => {
    const sha = await commitTests({ SqliteTest: SQLITE_TEST });
    const job = await testsJob('tests-sqlite', sha, { env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:' } });
    await postJob(job);
    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);
    expect(leakedSecrets(job, cloud)).toEqual([]);

    expect(statusesOf(cloud, 'build.tests')).toEqual(['started', 'done']);
    expect(steps(cloud).find((s) => s.key === 'build.tests' && s.status === 'done')?.params).toMatchObject({ report: 'junit', passed: 2, failed: 0 });
    // Credentials are issued once, after the tests and the build commands passed.
    const credentials = cloud.flatMap((r, i) => (isCredentials(r) ? [i] : []));
    expect(credentials).toHaveLength(1);
    const lastCommand = cloud.reduce((last, r, i) => (logsEvents(r).some((e) => String(e.key).startsWith('build.command.')) ? i : last), -1);
    expect(lastCommand).toBeGreaterThan(-1);
    expect(credentials[0]).toBeGreaterThan(lastCommand);
    expect(logLines(cloud)).toContain('fake-arco deploy invoked');
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded', error_code: null });
  });

  test('tests: failing suite stops the deploy', async () => {
    const sha = await commitTests({ FailingTest: FAILING_TEST });
    const job = await testsJob('tests-fail', sha);
    await postJob(job);
    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);
    expect(leakedSecrets(job, cloud)).toEqual([]);

    expect(finishBody(cloud)).toMatchObject({ result: 'failed', error_code: 'build.tests_failed', error_message: '1 test failed' });
    const warning = steps(cloud).find((s) => s.key === 'build.tests' && s.status === 'warning');
    expect(warning?.params).toMatchObject({ report: 'junit', passed: 1, failed: 1 });
    const failures = warning?.params?.failures as { class: string; name: string; message: string }[];
    expect(failures).toHaveLength(1);
    expect(failures[0]!.name).toBe('fails on purpose');
    expect(failures[0]!.message).toContain('the assertion failed');
    expect(statusesOf(cloud, 'build.command.1')).toEqual([]);
    expect(cloud.filter(isCredentials)).toEqual([]);
    expect(logLines(cloud)).not.toContain('fake-arco deploy invoked');
    expect(cloud.filter(isCachePut)).toEqual([]);
  });

  test('tests: env has no build secret, AWS, token or clone token', async () => {
    const sha = await commitTests({ EnvTest: ENV_TEST });
    const testSecret = `test-secret-${randomBytes(8).toString('hex')}`;
    const job = await testsJob('tests-env', sha, { env: { ARCO_TEST_VARIABLE: 'from-tests-env', TEST_SECRET: testSecret }, mask: [testSecret] });
    await postJob(job);
    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);
    expect(leakedSecrets(job, cloud)).toEqual([]);
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });

    const env = logLines(cloud).filter((l) => l.startsWith('ENV ')).map((l) => l.slice('ENV '.length));
    expect(env).toContain('APP_ENV=testing');
    expect(env).toContain('ARCO_TEST_VARIABLE=from-tests-env');
    expect(env).toContain('CI=true');
    expect(env.filter((l) => l.startsWith('APP_SECRET=') || l.startsWith('MULTI_LINE_SECRET='))).toEqual([]);
    expect(env.filter((l) => l.startsWith('AWS_') || l.startsWith('ARCO_RUNNER_') && l !== 'ARCO_RUNNER=1')).toEqual([]);
    expect(env.filter((l) => /^(GIT_|ARCO_PERMISSIONS)/.test(l))).toEqual([]);
    // The only masked values are the ephemeral APP_KEY and the masked test variable: no token, nonce or ticket.
    expect(env.filter((l) => l.includes('***')).sort()).toEqual(['APP_KEY=***', 'TEST_SECRET=***']);
  });

  test('tests: MySQL', async () => {
    const sha = await commitTests({ MysqlTest: pdoTest('mysql', 'DB_') });
    const job = await testsJob('tests-mysql', sha, { services: ['mysql'] });
    await expectServicesPass(job, ['mysql']);
  });

  test('tests: PostgreSQL', async () => {
    const sha = await commitTests({ PgsqlTest: pdoTest('pgsql', 'DB_') });
    const job = await testsJob('tests-pgsql', sha, { services: ['pgsql'] });
    await expectServicesPass(job, ['pgsql']);
  });

  test('tests: Redis', async () => {
    const sha = await commitTests({ RedisTest: REDIS_TEST });
    const job = await testsJob('tests-redis', sha, { services: ['redis'] });
    await expectServicesPass(job, ['redis']);
  });

  test('tests: both databases, pgsql primary', async () => {
    const sha = await commitTests({ PgsqlTest: pdoTest('pgsql', 'DB_'), MysqlTest: pdoTest('mysql', 'DB_MYSQL_') });
    const job = await testsJob('tests-both', sha, { services: ['mysql', 'pgsql'], primary_database: 'pgsql' });
    await expectServicesPass(job, ['mysql', 'pgsql']);
  });

  test('tests: --parallel databases are dropped', async () => {
    const sha = await commitTests({ MysqlTest: pdoTest('mysql', 'DB_') });
    const job = await testsJob('tests-parallel', sha, { command: 'php artisan test --parallel', services: ['mysql'] });
    const cloud = await expectServicesPass(job, ['mysql']);
    expect(logLines(cloud)).toContain('Dropped test databases: testing, testing_test_1, testing_test_2');
  });

  test('tests: timeout', async () => {
    const sha = await commitTests({ SleepTest: SLEEP_TEST });
    const job = await testsJob('tests-timeout', sha, { timeout_seconds: 3 });
    const t0 = Date.now();
    await postJob(job);
    await waitFor('finish', async () => (await recorded(job)).cloud.some(isFinish), 45_000);
    expect(Date.now() - t0).toBeLessThan(45_000);
    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);
    expect(leakedSecrets(job, cloud)).toEqual([]);

    expect(finishBody(cloud)).toMatchObject({
      result: 'failed', error_code: 'build.tests_timeout', error_message: 'The tests did not finish within 3 seconds',
    });
    expect(statusesOf(cloud, 'build.tests')).toEqual(['started', 'warning']);
    expect(cloud.filter(isCredentials)).toEqual([]);
  });

  test('tests: cancel during tests', async () => {
    const sha = await commitTests({ PgsqlSleepTest: PGSQL_SLEEP_TEST });
    const job = await testsJob('tests-cancel', sha, { services: ['pgsql'] });
    await postJob(job);
    await waitFor('the test to sleep in PostgreSQL', async () => logLines((await recorded(job)).cloud).includes('sleeping in PostgreSQL'), 120_000);

    const r = await http('POST', `${CONTROL}/cancel`, { deployment_id: job.doc.deployment_id });
    expect(r).toEqual({ status: 202, json: { state: 'cancelling' } });
    const done = await untilDone(job);
    const { cloud } = done;
    expectSuspended(done);
    expect(leakedSecrets(job, cloud)).toEqual([]);
    expect(finishBody(cloud)).toMatchObject({ result: 'failed', error_code: 'build.cancelled' });
    expect(cloud.filter(isCredentials)).toEqual([]);
    expect(await healthz()).toBe('idle');
  });

  test('tests: nothing remains after the wipe', async () => {
    const data = await execRunner('ls -A /var/lib/arco-services');
    expect(data.code, data.stderr).toBe(0);
    expect(data.stdout).toBe('');
    const procs = await execRunner('pgrep -u mysql,postgres,redis');
    expect(procs.stdout).toBe('');
    expect(procs.code).toBe(1); // pgrep: no process matched
    const report = await execRunner('test ! -e /tmp/arco-tests');
    expect(report.code, report.stderr).toBe(0);
    expect((await hook('suspend')).status).toBe(200);
    expect((await hook('resume')).status).toBe(200);
    expect(await healthz()).toBe('idle');
  });

  test('fargate mode', async () => {
    const job = await newJob('fargate', { sha: sha3, suspendOnIdle: false });
    const run = await compose([
      'run', '--rm', '--no-deps', '-T',
      '-e', `ARCO_RUNNER_TICKET=${job.ticket}`, '-e', `ARCO_RUNNER_API_BASE=${API_BASE}`,
      '-e', `ARCO_RUNNER_DEPLOYMENT_ID=${job.doc.deployment_id}`,
      'runner',
    ], { timeoutMs: 300_000 });
    expect(run.code, run.stdout + run.stderr).toBe(0);

    const { cloud, suspends } = await recorded(job);
    expect(suspends).toEqual([]); // a Fargate task is not suspended
    expect(cloud.some(isIdleCall)).toBe(true);
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });
    // A fresh task restores the cache saved by the MicroVM builds.
    expect(statusesOf(cloud, 'build.cache_restore')).toEqual(['started', 'done']);
    expect(leakedSecrets(job, cloud)).toEqual([]);
  });

  test('cold cache', async () => {
    // A VM that knows no cache, for a cache key nothing was saved under yet: a fresh process (a Fargate task, as the
    // shared MicroVM runner already knows its cache and would skip the restore).
    const job = await newJob('cold', { sha: sha3, cacheKey: 'cache/cold', suspendOnIdle: false });
    const run = await compose([
      'run', '--rm', '--no-deps', '-T',
      '-e', `ARCO_RUNNER_TICKET=${job.ticket}`, '-e', `ARCO_RUNNER_API_BASE=${API_BASE}`,
      '-e', `ARCO_RUNNER_DEPLOYMENT_ID=${job.doc.deployment_id}`,
      'runner',
    ], { timeoutMs: 300_000 });
    expect(run.code, run.stdout + run.stderr).toBe(0);

    const { cloud } = await recorded(job);
    expect(statusesOf(cloud, 'build.cache_restore')).toEqual(['started', 'note']);
    expect(steps(cloud).find((s) => s.key === 'build.cache_restore' && s.status === 'note')?.message).toBe('No cache yet');
    expect(finishBody(cloud)).toMatchObject({ result: 'succeeded' });
    const puts = cloud.filter(isCachePut);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.pathname).toBe('/s3/cache/cold');
    expect(leakedSecrets(job, cloud)).toEqual([]);
  });
});
