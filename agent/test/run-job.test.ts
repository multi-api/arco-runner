import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { secretVariants, toFinishPayload, type ArcoResult } from '@multiapi/arco-cloud-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CacheManifest } from '../src/job/cache.js';
import type { TicketPayload } from '../src/job/document.js';
import { cloneToken } from '../src/mask.js';
import { runJob, type JobDeps, type JobPhase } from '../src/job/run-job.js';
import { claim, reportIdle } from '../src/job/runner-api.js';
import type { Paths } from '../src/system.js';
import { wipe } from '../src/wipe.js';
import { startFakeCloud, type FakeCloud, type FakeCloudOptions } from '../src/loopback-cloud.js';

const gnuTar = /GNU tar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '');
const zstd = spawnSync('zstd', ['--version']).status === 0;
const tools = gnuTar && zstd;
if (!tools) console.warn('run-job cache tests needing GNU tar and zstd are skipped here; run `npm run test:linux`');
const itTar = it.skipIf(!tools);

const FAKE_ARCO = resolve(__dirname, 'fixtures/fake-arco.mjs');
const AUTH = 'basic ' + btoa('x-access-token:ghs_clonetoken0123456789');
const TOKEN = 'rt_runnertoken_0123456789abcdef';
const NONCE = 'nonce_0123456789abcdef';
const TICKET = 'tkt_0123456789abcdef';
const MASKED = 'mask-value-SuperSecret-42';
const ARCO_MISSING = 'vendor/bin/arco not found: add multiapi/arco to composer.json and install it in your build commands (dev dependencies included)';

const gitSync = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

const clouds: FakeCloud[] = [];
afterEach(async () => { for (const c of clouds.splice(0)) await c.close(); });

/** An origin repo, the build user's tree and an output dir for dumps (outside every wiped path). */
async function world(o: { withArco?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'arco-job-'));
  const origin = join(root, 'origin');
  const out = join(root, 'out');
  await mkdir(origin);
  await mkdir(out);
  gitSync(origin, 'init', '-q');
  await writeFile(join(origin, 'composer.json'), '{}');
  await writeFile(join(origin, 'composer.lock'), '{"packages":[]}');
  if (o.withArco !== false) {
    await mkdir(join(origin, 'vendor/bin'), { recursive: true });
    await writeFile(join(origin, 'vendor/bin/arco'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ARCO}" "$@"\n`);
    await chmod(join(origin, 'vendor/bin/arco'), 0o755);
  }
  gitSync(origin, 'add', '.');
  gitSync(origin, 'commit', '-q', '-m', 'init');
  const paths: Paths = {
    home: join(root, 'home'), repo: join(root, 'home/work/repo'), tmpDirs: [join(root, 'tmp')],
    agentDir: join(root, 'agent'), varDir: join(root, 'var'),
  };
  await mkdir(paths.tmpDirs[0]!);
  await mkdir(paths.repo, { recursive: true });
  let known: CacheManifest | null = null;
  const knownCache = { get: () => known, set: (m: CacheManifest) => { known = m; } };
  return { root, origin, out, paths, knownCache };
}
type World = Awaited<ReturnType<typeof world>>;

interface RunOptions {
  commands?: string[];
  env?: Record<string, string>;
  mask?: string[];
  cloud?: Partial<FakeCloudOptions>;
  deps?: Partial<JobDeps>;
  signal?: AbortSignal;
}

async function run(w: World, o: RunOptions = {}) {
  const cloud = await startFakeCloud({ job: {}, ticket: TICKET, ...o.cloud });
  clouds.push(cloud);
  const sha = gitSync(w.origin, 'rev-parse', 'HEAD');
  cloud.options.job = {
    deployment_id: 'dep_1', environment: 'production', mode: 'deploy', nonce: NONCE, runner_token: TOKEN,
    source: { clone_url: `file://${w.origin}`, auth_header: AUTH, sha, root_dir: null },
    php_version: '8.5', commands: o.commands ?? ['echo building'], env: o.env ?? {}, mask: o.mask ?? [MASKED],
    cache: {
      restore_url: `${cloud.url}/s3/cache?X-Amz-Signature=restoresignature0001`,
      save_url: `${cloud.url}/s3/cache?X-Amz-Signature=savesignature0002`,
      key: 'env-1',
    },
    timeout_seconds: 600,
  };
  const ticket: TicketPayload = { ticket: TICKET, api_base: cloud.url, deployment_id: 'dep_1' };
  const sleeps: number[] = [];
  const wipes: string[] = [];
  const phases: JobPhase[] = [];
  // How many idle requests Cloud had seen when the job entered its idle phase (R22: must be 0).
  let idleCallsAtIdlePhase: number | null = null;
  const logs: string[] = [];
  const deps: JobDeps = {
    paths: w.paths, identity: null, mode: 'microvm', signal: o.signal ?? new AbortController().signal,
    knownCache: w.knownCache, receivedAt: Date.now(),
    onPhase: (p) => { phases.push(p); if (p === 'idle') idleCallsAtIdlePhase = cloud.calls('/idle').length; },
    sleep: async (ms) => { sleeps.push(ms); },
    wipe: async (rootDir) => {
      wipes.push(rootDir);
      // identity is null here, so as root (test:linux) the tree is root-owned, which the real wipe rightly refuses
      // to keep: hand it to an unprivileged owner first, as if the build user had written it.
      // Given back afterwards: root's git refuses a repo directory another user owns.
      const asRoot = process.getuid?.() === 0;
      if (asRoot) execFileSync('chown', ['-R', '65534:65534', w.paths.home]);
      await wipe(w.paths, rootDir);
      if (asRoot) execFileSync('chown', ['-R', '0:0', w.paths.home]);
    },
    checkoutOptions: { extraGitArgs: ['-c', 'protocol.file.allow=always'], allowFileUrl: true },
    log: (m) => logs.push(m),
    ...o.deps,
  };
  const result = await runJob(ticket, deps);
  const api = cloud.requests.filter((r) => !r.pathname.startsWith('/s3/'));
  const finishes = cloud.calls('/finish').map((r) => JSON.parse(r.body.toString('utf8')));
  return {
    cloud, result, sleeps, wipes, phases, logs, api, finishes, idleCallsAtIdlePhase, order: api.map((r) => r.pathname.split('/').pop()),
  };
}

const fakeResult = {
  schema: 1, at: '2026-10-21T12:00:00Z', type: 'result', outcome: 'deployed', app: 'shop', environment: 'production',
  revision: 'r42', url: 'https://x.example', domains: [], rolled_back: false, cold_start_ms: 120, error: null,
} as ArcoResult;
const fakeInventory = {
  schema: 1, app: 'shop', environment: 'production', group: 'g',
  resources: [{ type: 'queue', name: 'jobs', arn: 'arn:q', retained: false, relations: [{ type: 'worker_of', target: 'fn' }] }],
};

describe('runJob: happy path', () => {
  it('claims, starts, streams logs, finishes like the action, wipes and reports idle', async () => {
    const w = await world();
    const r = await run(w);
    expect(r.order[0]).toBe('claim');
    expect(r.order[1]).toBe('start');
    expect(r.order.at(-2)).toBe('finish');
    expect(r.order.at(-1)).toBe('idle');
    const middle = r.order.slice(2, -2);
    expect(middle.length).toBeGreaterThan(0);
    expect(new Set(middle)).toEqual(new Set(['logs']));
    expect(r.finishes).toEqual([toFinishPayload(fakeResult, 0, '0.10.0', fakeInventory)]);
    expect(r.result).toEqual({ deploymentId: 'dep_1', finished: true, buildOk: true, idleReported: true });
    expect(r.wipes).toEqual(['']);
    // R22: idle (clean, suspendable) before the idle report, which Cloud answers only after suspending the VM.
    expect(r.phases).toEqual(['running', 'saving', 'wiping', 'idle']);
    expect(r.idleCallsAtIdlePhase).toBe(0);
    for (const req of r.api) {
      if (!req.pathname.endsWith('/claim')) expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(req.headers['x-arco-cloud-api']).toBe('1');
    }
    // A cold VM: the restore was tried (404, "No cache yet") before the build.
    expect(r.cloud.calls('/s3/cache', 'GET')).toHaveLength(1);
    const events = r.cloud.calls('/logs').flatMap((q) => JSON.parse(q.body.toString('utf8')).events as { key: string; status: string; message?: string }[]);
    expect(events).toContainEqual(expect.objectContaining({ key: 'build.cache_restore', status: 'note', message: 'No cache yet' }));
    expect(events).toContainEqual(expect.objectContaining({ key: 'build.command.1', status: 'done' }));
  }, 30_000);

  itTar('saves the cache after finish and remembers its manifest', async () => {
    const w = await world();
    const r = await run(w);
    expect(r.cloud.calls('/s3/cache', 'PUT')).toHaveLength(1);
    expect(w.knownCache.get()).toMatchObject({ version: 1, key: 'env-1', lock: { composer: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    // The save happens after finish: nothing reaches Cloud's logs after it.
    const finishAt = r.cloud.calls('/finish')[0]!.at;
    const put = r.cloud.calls('/s3/cache', 'PUT')[0]!;
    expect(put.at).toBeGreaterThanOrEqual(finishAt);
    expect(r.cloud.calls('/logs').every((q) => q.at <= finishAt)).toBe(true);
  }, 30_000);
});

describe('runJob: secrets', () => {
  it('sends no secret, in any encoding, in any logs, finish or idle body', async () => {
    const w = await world();
    const r = await run(w, {
      commands: [
        `echo "${MASKED}"`,
        'printf %s "$MY_SECRET" | base64',
        `echo ${TOKEN} ${NONCE}`,
        `echo "${AUTH}" ghs_clonetoken0123456789`,
      ],
      env: { MY_SECRET: MASKED },
    });
    expect(r.result.finished).toBe(true);
    const start = JSON.parse(r.cloud.calls('/start')[0]!.body.toString('utf8'));
    expect(start).toEqual({ nonce: NONCE });
    const c = { accessKeyId: 'AKIAFAKECLOUD0000001', secretAccessKey: 'fake/Secret+Access+Key/0123456789abcdefABCD', sessionToken: 'FwoGZXIvYXdzEFAKESESSIONTOKEN0123456789' };
    const job = r.cloud.options.job as { cache: { restore_url: string; save_url: string } };
    const secrets = [
      MASKED, TOKEN, NONCE, AUTH, cloneToken(AUTH)!, c.accessKeyId, c.secretAccessKey, c.sessionToken,
      job.cache.restore_url, job.cache.save_url, 'restoresignature0001', 'savesignature0002',
    ];
    const bodies = r.api.filter((q) => /\/(logs|finish|idle)$/.test(q.pathname)).map((q) => q.body.toString('utf8'));
    expect(bodies.length).toBeGreaterThan(2);
    const all = bodies.join('\n');
    for (const s of secrets) for (const v of secretVariants(s)) expect(all, `variant of ${s}`).not.toContain(v);
    expect(all).toContain('***');
    expect(r.logs.join('\n')).not.toContain(MASKED);
  }, 30_000);
});

describe('runJob: environments', () => {
  it('gives arco the AWS credentials and the build commands neither them nor the runner token', async () => {
    const w = await world();
    const arcoDump = join(w.out, 'arco-env.json');
    const buildDump = join(w.out, 'build-env.txt');
    const r = await run(w, { commands: ['env > "$BUILD_DUMP"'], env: { FAKE_ARCO_ENVDUMP: arcoDump, BUILD_DUMP: buildDump } });
    expect(r.result.buildOk).toBe(true);
    const arco = JSON.parse(await readFile(`${arcoDump}.deploy`, 'utf8')) as Record<string, string>;
    expect(arco.AWS_SECRET_ACCESS_KEY).toBe('fake/Secret+Access+Key/0123456789abcdefABCD');
    const build = await readFile(buildDump, 'utf8');
    expect(build).toContain('ARCO_RUNNER=1');
    expect(build.split('\n').filter((l) => l.startsWith('AWS_'))).toEqual([]);
    expect(build).not.toContain(TOKEN);
    expect(build).not.toContain(NONCE);
    expect(build).not.toContain('ghs_clonetoken0123456789');
  }, 30_000);
});

describe('runJob: errors and refusals', () => {
  it('stops on a 409 claim: no start, no finish, no idle', async () => {
    const w = await world();
    const r = await run(w, { cloud: { claimAnswers: [{ status: 409, body: { error: 'ticket_invalid' } }] } });
    expect(r.order).toEqual(['claim']);
    expect(r.result).toEqual({ deploymentId: 'dep_1', finished: false, buildOk: false, idleReported: false });
    expect(r.wipes).toEqual([]); // R15: no customer code ran
  });

  it('does not wipe when start fails, and still reports idle', async () => {
    const w = await world();
    const r = await run(w, { cloud: { startAnswer: { status: 500, body: { error: 'boom' } } } });
    expect(r.order).toEqual(['claim', 'start', 'idle']);
    expect(r.wipes).toEqual([]);
    expect(r.phases).toEqual(['running', 'idle']);
    expect(r.idleCallsAtIdlePhase).toBe(0);
    expect(r.result).toEqual({ deploymentId: 'dep_1', finished: false, buildOk: false, idleReported: true });
    expect(existsSync(join(w.paths.repo, 'composer.json'))).toBe(false);
  });

  it('skips the run without a wipe when cancelled before start', async () => {
    const w = await world();
    const ac = new AbortController();
    ac.abort();
    const r = await run(w, { signal: ac.signal });
    expect(r.order).toEqual([]);
    expect(r.wipes).toEqual([]);
    expect(r.result).toMatchObject({ finished: false, idleReported: false });
  });

  it('retries 503 claims with the 2 s, 4 s backoff and proceeds', async () => {
    const w = await world();
    const busy = { status: 503, body: { error: 'claim_unavailable' } };
    const r = await run(w, { cloud: { claimAnswers: [busy, busy] } });
    expect(r.sleeps).toEqual([2000, 4000]);
    expect(r.order.slice(0, 4)).toEqual(['claim', 'claim', 'claim', 'start']);
    expect(r.result.finished).toBe(true);
  }, 30_000);

  it('fails with arco.not_installed when vendor/bin/arco is missing', async () => {
    const w = await world({ withArco: false });
    const r = await run(w);
    expect(r.finishes).toEqual([{
      result: 'failed', revision: null, rolled_back: false, error_code: 'arco.not_installed', error_message: ARCO_MISSING, arco_version: null,
    }]);
    expect(r.result).toMatchObject({ finished: true, buildOk: false, idleReported: true });
    expect(r.cloud.calls('/s3/cache', 'PUT')).toHaveLength(0);
  }, 30_000);

  it('refuses arco deploy when the credentials expire in less than 20 minutes', async () => {
    const w = await world();
    const calls = join(w.out, 'arco-calls.txt');
    const r = await run(w, { env: { FAKE_ARCO_CALLS: calls }, cloud: { credentialsTtlMs: 10 * 60_000 } });
    expect(r.finishes).toHaveLength(1);
    expect(r.finishes[0]).toMatchObject({ result: 'failed', error_code: 'runner_credentials_expiring' });
    expect(existsSync(calls)).toBe(false);
  }, 30_000);

  it('fails with build.command_failed and saves no cache when a command fails', async () => {
    const w = await world();
    const r = await run(w, { commands: ['echo one', 'exit 3', 'echo never'] });
    expect(r.finishes).toEqual([{
      result: 'failed', revision: null, rolled_back: false, error_code: 'build.command_failed',
      error_message: '`exit 3` exited with code 3', arco_version: null,
    }]);
    expect(r.result).toMatchObject({ finished: true, buildOk: false, idleReported: true });
    expect(r.cloud.calls('/s3/cache', 'PUT')).toHaveLength(0);
    expect(w.knownCache.get()).toBeNull();
  }, 30_000);

  it('finishes build.cancelled within 7 s when aborted during a command', async () => {
    const w = await world();
    const marker = join(w.out, 'sleeping');
    const ac = new AbortController();
    let abortedAt = 0;
    const poll = setInterval(() => {
      if (!abortedAt && existsSync(marker)) { abortedAt = Date.now(); ac.abort(); }
    }, 50);
    try {
      const r = await run(w, { commands: [`touch "${marker}"; sleep 30`], signal: ac.signal });
      expect(abortedAt).toBeGreaterThan(0);
      expect(r.finishes).toHaveLength(1);
      expect(r.finishes[0]).toMatchObject({ result: 'failed', error_code: 'build.cancelled' });
      expect(r.cloud.calls('/finish')[0]!.at - abortedAt).toBeLessThan(7000);
      expect(r.cloud.calls('/s3/cache', 'PUT')).toHaveLength(0);
      expect(r.result).toMatchObject({ finished: true, buildOk: false, idleReported: true });
      expect(r.wipes).toHaveLength(1);
    } finally {
      clearInterval(poll);
    }
  }, 30_000);

  it('finishes build.cancelled when cancelled while arco deploy runs', async () => {
    const w = await world();
    const calls = join(w.out, 'arco-calls.txt');
    const ac = new AbortController();
    const poll = setInterval(async () => {
      if (!ac.signal.aborted && (await readFile(calls, 'utf8').catch(() => '')).includes('pid ')) ac.abort();
    }, 50);
    try {
      const r = await run(w, { env: { FAKE_ARCO_SCENARIO: 'hang', FAKE_ARCO_CALLS: calls }, signal: ac.signal });
      expect(ac.signal.aborted).toBe(true);
      expect(r.finishes).toEqual([{
        result: 'failed', revision: null, rolled_back: false, error_code: 'build.cancelled', error_message: 'Cancelled', arco_version: null,
      }]);
      // arco was stopped before `info`: only the deploy ran.
      expect((await readFile(calls, 'utf8')).split('\n').filter((l) => l && !l.startsWith('pid'))).toEqual(['deploy --env=production --yes --json']);
      expect(r.result).toMatchObject({ finished: true, buildOk: false, idleReported: true });
      expect(r.cloud.calls('/s3/cache', 'PUT')).toHaveLength(0);
      expect(r.wipes).toHaveLength(1);
    } finally {
      clearInterval(poll);
    }
  }, 30_000);

  it('reports buildOk false but finished true when arco reports a failed deploy', async () => {
    const w = await world();
    const r = await run(w, { env: { FAKE_ARCO_SCENARIO: 'failed' } });
    expect(r.finishes[0]).toMatchObject({ result: 'failed', error_code: 'deploy.health_check_failed' });
    expect(r.result).toMatchObject({ finished: true, buildOk: false, idleReported: true });
  }, 30_000);

  it('does not finish when Cloud answers logs with 409 lease_lost, but still wipes and reports idle', async () => {
    const w = await world();
    const r = await run(w, { commands: ['echo hi; sleep 30'], cloud: { logsAnswer: { status: 409, body: { error: 'lease_lost' } } } });
    expect(r.cloud.calls('/finish')).toHaveLength(0);
    expect(r.wipes).toHaveLength(1);
    expect(r.cloud.calls('/idle')).toHaveLength(1);
    expect(r.result).toMatchObject({ finished: false, buildOk: false, idleReported: true });
    expect(r.cloud.calls('/s3/cache', 'PUT')).toHaveLength(0);
  }, 30_000);
});

describe('runJob: cache rules', () => {
  itTar('skips restore and save when the VM knows the cache and the locks did not change', async () => {
    const w = await world();
    const first = await run(w);
    expect(first.cloud.calls('/s3/cache', 'PUT')).toHaveLength(1);
    const known = w.knownCache.get();
    expect(known).not.toBeNull();

    const second = await run(w);
    expect(second.result.buildOk).toBe(true);
    expect(second.cloud.calls('/s3/cache', 'GET')).toHaveLength(0);
    expect(second.cloud.calls('/s3/cache', 'PUT')).toHaveLength(0);

    await writeFile(join(w.origin, 'composer.lock'), '{"packages":[{"name":"a/b"}]}');
    gitSync(w.origin, 'commit', '-q', '-am', 'bump');
    const third = await run(w);
    expect(third.cloud.calls('/s3/cache', 'GET')).toHaveLength(0);
    expect(third.cloud.calls('/s3/cache', 'PUT')).toHaveLength(1);
    expect(w.knownCache.get()!.lock.composer).not.toBe(known!.lock.composer);
  }, 60_000);
});

describe('runJob: R13 kill before cache save', () => {
  itTar('kills the build processes before the save', async () => {
    const w = await world();
    let killedAt = 0;
    const r = await run(w, { deps: { killBuildProcesses: async () => { killedAt = Date.now(); } } });
    const put = r.cloud.calls('/s3/cache', 'PUT');
    expect(put).toHaveLength(1);
    expect(killedAt).toBeGreaterThanOrEqual(r.cloud.calls('/finish')[0]!.at);
    expect(killedAt).toBeLessThanOrEqual(put[0]!.at);
  }, 30_000);

  it('skips the save when the kill fails, and still wipes and reports idle', async () => {
    const w = await world();
    let kills = 0;
    // The kill before arco deploy (M3) succeeds; the one before the save fails.
    const r = await run(w, { deps: { killBuildProcesses: async () => { if (++kills === 2) throw new Error('1 process(es) of uid 1000 survived SIGKILL'); } } });
    expect(kills).toBe(2);
    expect(r.cloud.calls('/s3/cache', 'PUT')).toHaveLength(0);
    expect(w.knownCache.get()).toBeNull();
    expect(r.logs.some((l) => l.startsWith('cache save skipped'))).toBe(true);
    expect(r.wipes).toHaveLength(1);
    expect(r.result).toMatchObject({ finished: true, buildOk: true, idleReported: true });
  }, 30_000);
});

describe('runJob: fargate', () => {
  it('does not wipe in fargate mode', async () => {
    const w = await world();
    const r = await run(w, { deps: { mode: 'fargate' } });
    expect(r.wipes).toEqual([]);
    expect(r.result).toMatchObject({ finished: true, idleReported: true });
    expect(r.order.at(-1)).toBe('idle');
    expect(r.phases).not.toContain('idle'); // fargate reports idle, then exits

  }, 30_000);
});

describe('claim and reportIdle', () => {
  const ticket: TicketPayload = { ticket: TICKET, api_base: 'https://cloud.test/', deployment_id: 'dep_1' };
  const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });

  it('retries a connection reset and gives up 9 minutes after the ticket arrived', async () => {
    let t = 1_000_000;
    const seen: string[] = [];
    const sleeps: number[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url} ${String(init.body)}`);
      throw reset();
    }) as unknown as typeof fetch;
    const doc = await claim(ticket, { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, receivedAt: 1_000_000, fetchImpl });
    expect(doc).toBeNull();
    expect(seen[0]).toBe(`POST https://cloud.test/api/v1/runner/claim {"ticket":"${TICKET}"}`);
    expect(sleeps.slice(0, 6)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(9 * 60_000);
    // The last sleep is clamped to what is left of the window.
    expect(t - 1_000_000).toBe(9 * 60_000);
  });

  it('stops at once when cancelled, abandoning the backoff sleep', async () => {
    const ac = new AbortController();
    let n = 0;
    const fetchImpl = (async () => { n++; ac.abort(); return new Response('{"error":"claim_unavailable"}', { status: 503 }); }) as unknown as typeof fetch;
    const never = () => new Promise<void>(() => {});
    await expect(claim(ticket, { now: Date.now, sleep: never, receivedAt: Date.now(), fetchImpl, signal: ac.signal })).resolves.toBeNull();
    expect(n).toBe(1);
    const busy = (async () => new Response('{"error":"claim_unavailable"}', { status: 503 })) as unknown as typeof fetch;
    const ac2 = new AbortController();
    const pending = claim(ticket, { now: Date.now, sleep: never, receivedAt: Date.now(), fetchImpl: busy, signal: ac2.signal });
    setTimeout(() => ac2.abort(), 20);
    await expect(pending).resolves.toBeNull();
  });

  it('treats 204, 401, 404 and 409 from idle as done and retries anything else 3 times', async () => {
    for (const status of [204, 401, 404, 409]) {
      let n = 0;
      const f = (async () => { n++; return new Response(null, { status: status === 204 ? 204 : status }); }) as unknown as typeof fetch;
      await expect(reportIdle('https://cloud.test', TOKEN, 'dep_1', f)).resolves.toBeUndefined();
      expect(n).toBe(1);
    }
    let n = 0;
    const bodies: unknown[] = [];
    const failing = (async (_u: string, init: RequestInit) => {
      n++;
      bodies.push(JSON.parse(String(init.body)));
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      if (n === 1) throw reset();
      return new Response('{"error":"x"}', { status: 500 });
    }) as unknown as typeof fetch;
    const gaps: number[] = [];
    await expect(reportIdle('https://cloud.test', TOKEN, 'dep_1', failing, async (ms) => { gaps.push(ms); })).rejects.toThrow();
    expect(n).toBe(3);
    expect(gaps).toEqual([1000, 1000]);
    expect(bodies[0]).toEqual({ deployment_id: 'dep_1' });
  });
});

describe('runJob: I2 restore failures', () => {
  /** Answers the cache GET itself; everything else goes to the fake Cloud. */
  const cacheGet = (answer: () => Response): typeof fetch => async (input, init) => {
    const url = String(input);
    if (url.includes('/s3/cache') && (init?.method ?? 'GET') === 'GET') return answer();
    return fetch(input, init);
  };

  itTar('saves a fresh cache after a content failure (corrupt archive)', async () => {
    const w = await world();
    const r = await run(w, { deps: { fetchImpl: cacheGet(() => new Response(Buffer.from('this is not a zstd archive'))) } });
    expect(r.result.buildOk).toBe(true);
    expect(r.logs.join('\n')).not.toContain('cache not saved');
    expect(r.cloud.calls('/s3/cache', 'PUT')).toHaveLength(1);
    expect(w.knownCache.get()).toMatchObject({ key: 'env-1' });
  }, 30_000);

  it('saves nothing after a transient failure (HTTP 500)', async () => {
    const w = await world();
    const r = await run(w, { deps: { fetchImpl: cacheGet(() => new Response('boom', { status: 500 })) } });
    expect(r.result.buildOk).toBe(true);
    const events = r.cloud.calls('/logs').flatMap((q) => JSON.parse(q.body.toString('utf8')).events as { key: string; status: string; message?: string }[]);
    expect(events).toContainEqual(expect.objectContaining({ key: 'build.cache_restore', status: 'warning' }));
    expect(r.cloud.calls('/s3/cache', 'PUT')).toHaveLength(0);
    expect(w.knownCache.get()).toBeNull();
  }, 30_000);

  it.each([403, 503])('treats HTTP %i as transient', async (status) => {
    const w = await world();
    const r = await run(w, { deps: { fetchImpl: cacheGet(() => new Response('x', { status })) } });
    expect(r.cloud.calls('/s3/cache', 'PUT')).toHaveLength(0);
  }, 30_000);
});

describe('runJob: M2 permissions boundary', () => {
  it('never passes a customer-set ARCO_PERMISSIONS_BOUNDARY to arco', async () => {
    const w = await world();
    const dump = join(w.out, 'arco-env.json');
    const r = await run(w, { env: { FAKE_ARCO_ENVDUMP: dump, ARCO_PERMISSIONS_BOUNDARY: 'arn:aws:iam::1:policy/customer', arco_permissions_boundary: 'x-lower' } });
    expect(r.result.buildOk).toBe(true);
    for (const cmd of ['deploy', 'info', '--version']) {
      const env = JSON.parse(await readFile(`${dump}.${cmd}`, 'utf8')) as Record<string, string>;
      expect(env).not.toHaveProperty('ARCO_PERMISSIONS_BOUNDARY');
      expect(env).not.toHaveProperty('arco_permissions_boundary');
    }
  }, 30_000);

  it("passes Cloud's boundary to arco deploy only", async () => {
    const w = await world();
    const dump = join(w.out, 'arco-env.json');
    const boundary = 'arn:aws:iam::123:policy/cloud-boundary';
    await run(w, { env: { FAKE_ARCO_ENVDUMP: dump, ARCO_PERMISSIONS_BOUNDARY: 'arn:customer' }, cloud: { permissionsBoundary: boundary } });
    expect(JSON.parse(await readFile(`${dump}.deploy`, 'utf8')).ARCO_PERMISSIONS_BOUNDARY).toBe(boundary);
    expect(JSON.parse(await readFile(`${dump}.info`, 'utf8'))).not.toHaveProperty('ARCO_PERMISSIONS_BOUNDARY');
  }, 30_000);
});

describe('runJob: M3 kill before arco deploy', () => {
  it('kills the build processes after the build commands and before arco deploy', async () => {
    const w = await world();
    const built = join(w.out, 'built');
    const calls = join(w.out, 'arco-calls.txt');
    const seen: { built: boolean; arco: boolean }[] = [];
    const r = await run(w, {
      commands: [`touch "${built}"`], env: { FAKE_ARCO_CALLS: calls },
      deps: { killBuildProcesses: async () => { seen.push({ built: existsSync(built), arco: existsSync(calls) }); } },
    });
    expect(r.result.buildOk).toBe(true);
    expect(seen[0]).toEqual({ built: true, arco: false });
  }, 30_000);

  it('a kill failure before deploy finishes failed runner.internal_error, then wipes and reports idle', async () => {
    const w = await world();
    const calls = join(w.out, 'arco-calls.txt');
    const r = await run(w, {
      env: { FAKE_ARCO_CALLS: calls },
      deps: { killBuildProcesses: async () => { throw new Error('1 process(es) of uid 1000 survived SIGKILL'); } },
    });
    expect(existsSync(calls)).toBe(false);
    expect(r.finishes).toHaveLength(1);
    expect(r.finishes[0]).toMatchObject({ result: 'failed', error_code: 'runner.internal_error' });
    expect(r.cloud.calls('/s3/cache', 'PUT')).toHaveLength(0);
    expect(r.wipes).toHaveLength(1);
    expect(r.result).toMatchObject({ finished: true, buildOk: false, idleReported: true });
  }, 30_000);
});

describe('runJob: failure finish redaction', () => {
  it('a mask value equal to a JSON literal does not break the failure finish', async () => {
    const w = await world();
    const r = await run(w, { commands: ['exit 3'], mask: ['null', 'failed', MASKED] });
    // Strings are still masked (error_code included); the result enum, null and booleans are untouched.
    expect(r.finishes).toEqual([{
      result: 'failed', revision: null, rolled_back: false, error_code: 'build.command_***',
      error_message: '`exit 3` exited with code 3', arco_version: null,
    }]);
    expect(r.result).toMatchObject({ finished: true, idleReported: true });
  }, 30_000);
});
