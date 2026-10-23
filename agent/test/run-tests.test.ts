import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Batcher, Redactor, type Batcher as BatcherT } from '@multiapi/arco-cloud-client';
import { describe, expect, it } from 'vitest';
import type { JobDocument, ServiceName, TestsSpec } from '../src/job/document.js';
import { BuildFailure } from '../src/job/errors.js';
import { Steps } from '../src/job/steps.js';
import { registerJobSecrets } from '../src/mask.js';
import { ServiceStartError, type ServicesManager } from '../src/services/manager.js';
import { resolveProjectDir, type Paths } from '../src/system.js';
import { runTestPhase, type TestPhaseContext } from '../src/tests/run-tests.js';

const TOKEN = 'rt_runnertoken_0123456789abcdef';
const NONCE = 'nonce_0123456789abcdef';
const BUILD_SECRET = 'build-secret-value-SuperSecret-77';
const PARATEST_HINT = '`--parallel` needs brianium/paratest in composer.json (require-dev)';

const gitSync = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

/** A fake PHPUnit: writes the committed JUnit fixture (or FAKE_MODE's variant) to --log-junit, exits with tests/exit-code. */
const FAKE_PHPUNIT = `#!/bin/sh
out=""
for a in "$@"; do case "$a" in --log-junit=*) out="\${a#--log-junit=}";; esac; done
[ -n "$TEST_DUMP" ] && env > "$TEST_DUMP"
if [ -n "$out" ]; then
  case "$FAKE_MODE" in
    none) ;;
    link) ln -s "$FAKE_LINK_TARGET" "$out" ;;
    huge) head -c 67108865 /dev/zero > "$out" ;;
    corrupt) echo '<testsuites><testsuite>' > "$out" ;;
    *) [ -f tests/junit.xml ] && cp tests/junit.xml "$out" ;;
  esac
fi
exit "$(cat tests/exit-code 2>/dev/null || echo 0)"
`;

const junit = (cases: Array<'pass' | 'fail' | 'error' | 'skip'>): string => {
  const body = cases.map((c, i) => {
    const inner = c === 'fail' ? `<failure message="expected ${i} to be true"/>` : c === 'error' ? '<error message="boom"/>' : c === 'skip' ? '<skipped/>' : '';
    return `<testcase class="Tests\\Feature\\ExampleTest" name="test_${i}" time="0.01">${inner}</testcase>`;
  }).join('');
  return `<?xml version="1.0"?><testsuites><testsuite name="all">${body}</testsuite></testsuites>`;
};

interface WorldOptions {
  /** Committed JUnit fixture (absent: the fake writes no report). */
  report?: string | null;
  exitCode?: number;
  files?: Record<string, string>;
  rootDir?: string;
}

/** Origin repo, cloned into the build user's tree, plus an out dir for dumps. */
async function world(o: WorldOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'arco-tests-'));
  const origin = join(root, 'origin');
  const out = join(root, 'out');
  await mkdir(out);
  const base = join(origin, o.rootDir ?? '');
  await mkdir(join(base, 'vendor/bin'), { recursive: true });
  await mkdir(join(base, 'tests'), { recursive: true });
  gitSync(origin, 'init', '-q');
  await writeFile(join(base, 'composer.json'), '{"name":"t/t"}\n');
  await writeFile(join(base, 'phpunit.xml'), '<phpunit><php><env name="APP_ENV" value="testing"/></php></phpunit>\n');
  await writeFile(join(base, 'vendor/bin/phpunit'), FAKE_PHPUNIT);
  await chmod(join(base, 'vendor/bin/phpunit'), 0o755);
  await writeFile(join(base, 'tests/exit-code'), String(o.exitCode ?? 0));
  if (o.report !== null) await writeFile(join(base, 'tests/junit.xml'), o.report ?? junit(['pass', 'pass', 'pass']));
  for (const [f, c] of Object.entries(o.files ?? {})) {
    await mkdir(join(base, f, '..'), { recursive: true });
    await writeFile(join(base, f), c);
  }
  gitSync(origin, 'add', '-A');
  gitSync(origin, 'commit', '-q', '-m', 'init');
  const paths: Paths = {
    home: join(root, 'home'), repo: join(root, 'home/work/repo'), tmpDirs: [join(root, 'tmp')],
    agentDir: join(root, 'agent'), varDir: join(root, 'var'),
  };
  await mkdir(paths.tmpDirs[0]!);
  await mkdir(join(root, 'home/work'), { recursive: true });
  gitSync(join(root, 'home/work'), 'clone', '-q', origin, 'repo');
  const projectDir = await resolveProjectDir(paths.repo, o.rootDir ?? '');
  return { root, origin, out, paths, projectDir, rootDir: o.rootDir ?? '' };
}
type World = Awaited<ReturnType<typeof world>>;

interface Ev { key: string; status: string; message?: string; params: Record<string, unknown> }

interface RunOptions {
  tests?: Partial<TestsSpec>;
  env?: Record<string, string>;
  mask?: string[];
  services?: (() => ServicesManager) | undefined;
  kill?: (() => Promise<void>) | null;
  signal?: AbortSignal;
  buildDeadlineMs?: number;
  timeoutSeconds?: number;
  /** Shared trace: step events are recorded as `<key>:<status>`. */
  trace?: string[];
}

async function run(w: World, o: RunOptions = {}) {
  const tests: TestsSpec = {
    command: 'vendor/bin/phpunit', setup_commands: [], services: [], primary_database: null, timeout_seconds: 900,
    env: {}, mask: [], ...o.tests,
  };
  const doc: JobDocument = {
    deployment_id: 'dep_1', environment: 'production', mode: 'deploy', nonce: NONCE, runner_token: TOKEN,
    source: { clone_url: 'file:///x', auth_header: 'basic eA==', sha: '0'.repeat(40), root_dir: w.rootDir },
    php_version: '8.5', commands: ['echo build'], env: o.env ?? {}, mask: o.mask ?? [], timeout_seconds: o.timeoutSeconds ?? 600,
    cache: { restore_url: 'https://s3/x?X-Amz-Signature=a1', save_url: 'https://s3/y?X-Amz-Signature=b2', key: 'k' },
    defer_credentials: true, tests,
  };
  const redactor = new Redactor();
  registerJobSecrets(redactor, doc);
  redactor.add(TOKEN);
  redactor.add(NONCE);
  const payloads: unknown[] = [];
  const batcher = new Batcher({ send: async (p) => { payloads.push(p); }, redact: (t) => redactor.redact(t), intervalMs: 50 });
  const trace = o.trace ?? [];
  const recording = {
    addEvent: (e: Ev) => { trace.push(`${e.key}:${e.status}`); batcher.addEvent(e); },
    addLine: (l: string) => batcher.addLine(l),
  } as unknown as BatcherT;
  const ctx: TestPhaseContext = {
    doc, tests, projectDir: w.projectDir, paths: w.paths, identity: null, batcher, steps: new Steps(recording), redactor,
    signal: o.signal ?? new AbortController().signal, buildDeadlineMs: o.buildDeadlineMs ?? Date.now() + 600_000,
    services: o.services, killBuildProcesses: o.kill === undefined ? null : o.kill,
  };
  let error: unknown = null;
  try {
    await runTestPhase(ctx);
  } catch (e) {
    error = e;
  }
  await batcher.close();
  const sent = JSON.stringify(payloads);
  const events = payloads.flatMap((p) => ((p as { events?: Ev[] }).events ?? []));
  const lines = payloads.flatMap((p) => ((p as { lines?: Array<{ text?: string } | string> }).lines ?? []).map((l) => (typeof l === 'string' ? l : (l.text ?? JSON.stringify(l)))));
  return { error, events, lines, sent, trace };
}

const step = (events: Ev[], key: string, status: string) => events.find((e) => e.key === key && e.status === status);
const failure = (e: unknown) => {
  expect(e).toBeInstanceOf(BuildFailure);
  return { code: (e as BuildFailure).code, message: (e as BuildFailure).message };
};
const dumpOf = async (path: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
};

function fakeServices(trace: string[], o: { startError?: Error; waitAbort?: boolean; phpRedis?: boolean; passwords?: string[] } = {}): () => ServicesManager {
  return () => ({
    async start(services: ServiceName[], password: string, signal: AbortSignal) {
      trace.push('start');
      o.passwords?.push(password);
      if (o.waitAbort) {
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
        });
      }
      if (o.startError) throw o.startError;
      return Object.fromEntries(services.map((s) => [s, 7])) as Record<ServiceName, number>;
    },
    async dropDatabases() { trace.push('dropDatabases'); return ['testing']; },
    async stopAll() { trace.push('stopAll'); },
    async removeData() { trace.push('removeData'); },
    async phpRedis() { return o.phpRedis ?? true; },
  });
}

describe('runTestPhase: results', () => {
  it('passes: build.tests done with junit counts, then the build commands run', async () => {
    const w = await world({ report: junit(['pass', 'pass', 'skip']) });
    const r = await run(w);
    expect(r.error).toBeNull();
    expect(step(r.events, 'build.tests', 'started')?.params).toEqual({ command: 'vendor/bin/phpunit' });
    const done = step(r.events, 'build.tests', 'done')!;
    expect(done.params).toMatchObject({ passed: 2, failed: 0, errors: 0, skipped: 1, report: 'junit' });
    expect(typeof done.params.duration_s).toBe('number');
    expect(step(r.events, 'build.tests', 'warning')).toBeUndefined();
  }, 30_000);

  it('fails: build.tests warning with failures and finish build.tests_failed "2 tests failed"', async () => {
    const w = await world({ report: junit(['pass', 'fail', 'error']), exitCode: 1 });
    const r = await run(w);
    expect(failure(r.error)).toEqual({ code: 'build.tests_failed', message: '2 tests failed' });
    const warning = step(r.events, 'build.tests', 'warning')!;
    expect(warning.params).toMatchObject({ passed: 1, failed: 1, errors: 1, skipped: 0, report: 'junit' });
    expect(warning.params.failures).toEqual([
      { class: 'Tests\\Feature\\ExampleTest', name: 'test_1', message: 'expected 1 to be true' },
      { class: 'Tests\\Feature\\ExampleTest', name: 'test_2', message: 'boom' },
    ]);

    const one = await run(await world({ report: junit(['pass', 'fail']), exitCode: 1 }));
    expect(failure(one.error)).toEqual({ code: 'build.tests_failed', message: '1 test failed' });

    const zero = await run(await world({ report: junit(['pass']), exitCode: 2 }));
    expect(failure(zero.error)).toEqual({ code: 'build.tests_failed', message: 'The test command exited with code 2' });

    const none = await run(await world({ report: null, exitCode: 3 }));
    expect(failure(none.error)).toEqual({ code: 'build.tests_failed', message: 'The test command exited with code 3' });
    expect(step(none.events, 'build.tests', 'warning')!.params).toMatchObject({ report: 'none', passed: null });
  }, 60_000);

  it('runs setup commands as build.test_setup.<n> and fails build.test_setup_failed', async () => {
    const w = await world();
    const r = await run(w, { tests: { setup_commands: ['echo setup-one', 'npm ci', 'exit 4', 'echo never'] } });
    expect(failure(r.error)).toEqual({ code: 'build.test_setup_failed', message: '`exit 4` exited with code 4' });
    expect(step(r.events, 'build.test_setup.1', 'started')?.params).toEqual({ command: 'echo setup-one' });
    expect(step(r.events, 'build.test_setup.1', 'done')).toBeDefined();
    expect(step(r.events, 'build.test_setup.2', 'note')).toMatchObject({ message: 'Skipped: no package.json', params: { command: 'npm ci' } });
    expect(step(r.events, 'build.test_setup.3', 'started')).toBeDefined();
    expect(r.events.some((e) => e.key === 'build.test_setup.4' || e.key === 'build.tests')).toBe(false);
  }, 30_000);

  it('times out with build.tests_timeout after tests.timeout_seconds, and build.timeout when the build deadline comes first', async () => {
    const w = await world();
    const t0 = Date.now();
    const r = await run(w, { tests: { command: 'sleep 30', timeout_seconds: 1 } });
    expect(failure(r.error)).toEqual({ code: 'build.tests_timeout', message: 'The tests did not finish within 1 seconds' });
    expect(Date.now() - t0).toBeLessThan(10_000);

    const b = await run(await world(), { tests: { command: 'sleep 30' }, buildDeadlineMs: Date.now() + 1000, timeoutSeconds: 600 });
    expect(failure(b.error)).toEqual({ code: 'build.timeout', message: 'The build did not finish within 600 seconds' });
  }, 30_000);

  it('cancels during the test command: build.cancelled, cleanup ran', async () => {
    const w = await world({ files: { '.env.example': 'APP_NAME=x\n' } });
    const marker = join(w.out, 'sleeping');
    const ac = new AbortController();
    const poll = setInterval(() => { if (existsSync(marker)) ac.abort(); }, 50);
    const trace: string[] = [];
    try {
      const r = await run(w, {
        tests: { command: `echo changed >> composer.json; touch "${marker}"; sleep 30`, services: ['redis'] },
        services: fakeServices(trace), signal: ac.signal, trace,
      });
      expect(failure(r.error)).toEqual({ code: 'build.cancelled', message: 'Cancelled' });
    } finally {
      clearInterval(poll);
    }
    expect(trace.filter((t) => ['dropDatabases', 'stopAll', 'removeData'].includes(t))).toEqual(['dropDatabases', 'stopAll', 'removeData']);
    expect(readFileSync(join(w.projectDir, 'composer.json'), 'utf8')).toBe('{"name":"t/t"}\n');
    expect(existsSync(join(w.projectDir, '.env'))).toBe(false);
    expect(existsSync(join(w.paths.tmpDirs[0]!, 'arco-tests'))).toBe(false);
  }, 30_000);
});

describe('runTestPhase: environment', () => {
  it('the test env has test variables and non-secret build variables, never secret build variables, AWS or the runner token', async () => {
    const w = await world();
    const dump = join(w.out, 'env.txt');
    const r = await run(w, {
      env: { BUILD_SECRET, PUBLIC_BUILD: 'yes' }, mask: [BUILD_SECRET],
      tests: { env: { SANDBOX_KEY: 'sbx_test_value_1', PUBLIC_BUILD: 'yes', AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', TEST_DUMP: dump } },
    });
    expect(r.error).toBeNull();
    const text = await readFile(dump, 'utf8');
    const env = await dumpOf(dump);
    expect(env.SANDBOX_KEY).toBe('sbx_test_value_1');
    expect(env.PUBLIC_BUILD).toBe('yes');
    expect(env.APP_ENV).toBe('testing');
    expect(env.CI).toBe('true');
    expect(env.BUILD_SECRET).toBeUndefined();
    expect(text).not.toContain(BUILD_SECRET);
    expect(text.split('\n').filter((l) => /^aws_/i.test(l))).toEqual([]);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(NONCE);
  }, 30_000);

  it('copies .env.example and deletes it afterwards; keeps a committed .env', async () => {
    const w = await world({ files: { '.env.example': 'APP_NAME=example\n' } });
    const seen = join(w.out, 'env-seen');
    const r = await run(w, { tests: { command: `cp .env "${seen}"` } });
    expect(r.error).toBeNull();
    expect(await readFile(seen, 'utf8')).toBe('APP_NAME=example\n');
    expect(existsSync(join(w.projectDir, '.env'))).toBe(false);

    const c = await world({ files: { '.env.example': 'APP_NAME=example\n', '.env': 'APP_NAME=committed\n' } });
    const seen2 = join(c.out, 'env-seen');
    const r2 = await run(c, { tests: { command: `cp .env "${seen2}"` } });
    expect(r2.error).toBeNull();
    expect(await readFile(seen2, 'utf8')).toBe('APP_NAME=committed\n');
    expect(await readFile(join(c.projectDir, '.env'), 'utf8')).toBe('APP_NAME=committed\n');
  }, 30_000);

  it('injects a masked ephemeral APP_KEY only when none is configured', async () => {
    const w = await world();
    const dump = join(w.out, 'env.txt');
    const r = await run(w, { tests: { command: 'echo "key=$APP_KEY" && vendor/bin/phpunit', env: { TEST_DUMP: dump } } });
    expect(r.error).toBeNull();
    const key = (await dumpOf(dump)).APP_KEY!;
    expect(key).toMatch(/^base64:[A-Za-z0-9+/]{43}=$/);
    expect(r.sent).not.toContain(key.slice('base64:'.length));
    expect(r.lines.join('\n')).toContain('key=***');

    const given = await world();
    const dump2 = join(given.out, 'env.txt');
    await run(given, { tests: { env: { APP_KEY: 'base64:given', TEST_DUMP: dump2 } } });
    expect((await dumpOf(dump2)).APP_KEY).toBe('base64:given');

    // A .env copied from .env.example counts as configured (it is what Laravel reads during the tests).
    const example = await world({ files: { '.env.example': 'APP_KEY=base64:fromexample\n' } });
    const dump3 = join(example.out, 'env.txt');
    await run(example, { tests: { env: { TEST_DUMP: dump3 } } });
    expect((await dumpOf(dump3)).APP_KEY).toBeUndefined();

    const xml = await world({ files: { 'phpunit.xml': '<phpunit><php><env name="APP_KEY" value="base64:fromxml"/></php></phpunit>' } });
    const dump4 = join(xml.out, 'env.txt');
    await run(xml, { tests: { env: { TEST_DUMP: dump4 } } });
    expect((await dumpOf(dump4)).APP_KEY).toBeUndefined();
  }, 60_000);
});

describe('runTestPhase: isolation', () => {
  it('restores the tree after the tests: modified tracked files restored, untracked files and public/build removed, vendor and node_modules kept', async () => {
    const mutate = 'echo changed >> composer.json; rm phpunit.xml; mkdir -p public/build && touch public/build/app.js untracked.txt;'
      + ' mkdir -p node_modules/x && touch vendor/keep.txt node_modules/x/keep.js';
    for (const rootDir of ['', 'app']) {
      const w = await world({ rootDir });
      const r = await run(w, { tests: { command: mutate } });
      expect(r.error).toBeNull();
      const p = w.projectDir;
      expect(readFileSync(join(p, 'composer.json'), 'utf8')).toBe('{"name":"t/t"}\n');
      expect(existsSync(join(p, 'phpunit.xml'))).toBe(true);
      expect(existsSync(join(p, 'public'))).toBe(false);
      expect(existsSync(join(p, 'untracked.txt'))).toBe(false);
      expect(existsSync(join(p, 'vendor/keep.txt'))).toBe(true);
      expect(existsSync(join(p, 'node_modules/x/keep.js'))).toBe(true);
    }
  }, 30_000);

  it('kills processes the tests left behind before git restore', async () => {
    const w = await world();
    const pidFile = join(w.out, 'pid');
    const seen: string[] = [];
    const r = await run(w, {
      tests: { command: `echo changed >> composer.json; sleep 300 >/dev/null 2>&1 & echo $! > "${pidFile}"` },
      kill: async () => {
        seen.push(readFileSync(join(w.projectDir, 'composer.json'), 'utf8'));
        if (existsSync(pidFile)) {
          try { process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL'); } catch { /* gone */ }
        }
      },
    });
    expect(r.error).toBeNull();
    // Once after the setup (before services), at least once after the tests, while the tree is still unrestored.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBe('{"name":"t/t"}\n');
    expect(seen.at(-1)).toBe('{"name":"t/t"}\nchanged\n');
    expect(readFileSync(join(w.projectDir, 'composer.json'), 'utf8')).toBe('{"name":"t/t"}\n');
  }, 30_000);

  it('fails runner-internal (not a test failure) when the kill after the tests fails', async () => {
    const w = await world();
    let calls = 0;
    const r = await run(w, { kill: async () => { if (++calls > 1) throw new Error('1 process(es) of uid 1000 survived SIGKILL'); } });
    expect(r.error).not.toBeInstanceOf(BuildFailure);
    expect((r.error as Error).message).toMatch(/^could not isolate the build from the tests: /);
  }, 30_000);
});

describe('runTestPhase: report', () => {
  it('reports none with a note when the report is missing, a symlink, or larger than 64 MiB, and decides by exit code', async () => {
    for (const [mode, exitCode] of [['none', 0], ['link', 0], ['huge', 1], ['corrupt', 0]] as const) {
      const w = await world({ exitCode });
      const target = join(w.out, 'planted.xml');
      await writeFile(target, junit(['fail', 'fail']));
      const r = await run(w, { tests: { env: { FAKE_MODE: mode, FAKE_LINK_TARGET: target } } });
      const status = exitCode === 0 ? 'done' : 'warning';
      expect(step(r.events, 'build.tests', status)?.params, mode).toMatchObject({ report: 'none', passed: null, failed: null });
      const note = step(r.events, 'build.tests_hint', 'note');
      expect(note?.message, mode).toMatch(/JUnit report/);
      if (exitCode === 0) expect(r.error, mode).toBeNull();
      else expect(failure(r.error)).toEqual({ code: 'build.tests_failed', message: 'The test command exited with code 1' });
    }
  }, 60_000);

  it('gives no note when the command is not a PHP test runner', async () => {
    const w = await world();
    const r = await run(w, { tests: { command: 'true' } });
    expect(r.error).toBeNull();
    expect(step(r.events, 'build.tests', 'done')?.params).toMatchObject({ report: 'none' });
    expect(r.events.some((e) => e.key === 'build.tests_hint')).toBe(false);
  }, 30_000);

  it('adds the paratest hint when a --parallel command fails without vendor/brianium/paratest', async () => {
    const w = await world();
    const r = await run(w, { tests: { command: 'false --parallel' } });
    expect(failure(r.error)).toEqual({ code: 'build.tests_failed', message: 'The test command exited with code 1' });
    expect(step(r.events, 'build.tests_hint', 'note')?.message).toBe(PARATEST_HINT);

    const with_ = await world({ files: { 'vendor/brianium/paratest/composer.json': '{}' } });
    const r2 = await run(with_, { tests: { command: 'false --parallel' } });
    expect(r2.events.some((e) => e.key === 'build.tests_hint')).toBe(false);
  }, 30_000);

  it('runs the test command with pipefail', async () => {
    const w = await world({ report: junit(['fail']), exitCode: 1 });
    const r = await run(w, { tests: { command: 'vendor/bin/phpunit | cat' } });
    expect(failure(r.error)).toEqual({ code: 'build.tests_failed', message: 'The test command exited with code 1' });
    expect(step(r.events, 'build.tests', 'warning')?.params).toMatchObject({ report: 'none' });
  }, 30_000);
});

describe('runTestPhase: services', () => {
  it('starts services after setup, injects their variables, drops, stops and removes them on pass and on failure', async () => {
    for (const exitCode of [0, 1]) {
      const w = await world({ exitCode });
      const trace: string[] = [];
      const passwords: string[] = [];
      const dump = join(w.out, 'env.txt');
      const setupDump = join(w.out, 'setup-env.txt');
      const r = await run(w, {
        tests: { setup_commands: [`env > "${setupDump}"`], services: ['pgsql', 'redis'], primary_database: 'pgsql', env: { TEST_DUMP: dump } },
        services: fakeServices(trace, { phpRedis: false, passwords }), kill: async () => { trace.push('kill'); }, trace,
      });
      if (exitCode === 0) expect(r.error).toBeNull();
      else expect(failure(r.error).code).toBe('build.tests_failed');
      const order = trace.filter((t) => ['build.test_setup.1:done', 'kill', 'start', 'build.tests:started', 'dropDatabases', 'stopAll', 'removeData'].includes(t));
      expect(order).toEqual(['build.test_setup.1:done', 'kill', 'start', 'build.tests:started', 'kill', 'dropDatabases', 'stopAll', 'removeData']);
      const env = await dumpOf(dump);
      expect(env).toMatchObject({ DB_CONNECTION: 'pgsql', DB_PORT: '5432', DB_DATABASE: 'testing', DB_USERNAME: 'arco', REDIS_CLIENT: 'predis' });
      expect(env.DB_PASSWORD).toBe(passwords[0]);
      expect(passwords[0]).toMatch(/^[0-9a-f]{48}$/);
      expect((await dumpOf(setupDump)).DB_PASSWORD).toBeUndefined();
      expect(r.sent).not.toContain(passwords[0]);
      expect(step(r.events, 'build.test_services', 'started')?.params).toEqual({ services: ['pgsql', 'redis'] });
      expect(step(r.events, 'build.test_services', 'done')?.params).toEqual({ start_ms: { pgsql: 7, redis: 7 } });
      expect(step(r.events, 'build.test_services', 'note')?.message).toMatch(/predis\/predis/);
      expect(r.lines.join('\n')).toContain('Dropped test databases: testing');
    }
  }, 60_000);

  it('fails build.test_service_failed when a service does not become ready, still cleaning up', async () => {
    const w = await world();
    const trace: string[] = [];
    const ran = join(w.out, 'ran');
    const r = await run(w, {
      tests: { command: `touch "${ran}"`, services: ['mysql'] },
      services: fakeServices(trace, { startError: new ServiceStartError('mysql', 'MySQL did not become ready within 30 seconds') }),
    });
    expect(failure(r.error)).toEqual({ code: 'build.test_service_failed', message: 'MySQL did not become ready within 30 seconds' });
    expect(existsSync(ran)).toBe(false);
    expect(trace).toEqual(expect.arrayContaining(['stopAll', 'removeData']));
    expect(trace.indexOf('stopAll')).toBeLessThan(trace.indexOf('removeData'));

    const none = await run(await world(), { tests: { services: ['redis'] }, services: undefined });
    expect(failure(none.error)).toEqual({ code: 'build.test_service_failed', message: 'Test services are not available on this runner' });
  }, 30_000);

  it('a cancel while a service is starting finishes build.cancelled and still stops and removes it', async () => {
    const w = await world();
    const trace: string[] = [];
    const ac = new AbortController();
    const svc = fakeServices(trace, { waitAbort: true });
    const r = await run(w, {
      tests: { services: ['mysql'] }, signal: ac.signal,
      services: () => { const m = svc(); return { ...m, start: (...a) => { setTimeout(() => ac.abort(), 100); return m.start(...a); } }; },
    });
    expect(failure(r.error)).toEqual({ code: 'build.cancelled', message: 'Cancelled' });
    expect(trace).toEqual(['start', 'dropDatabases', 'stopAll', 'removeData']);
  }, 30_000);
});
