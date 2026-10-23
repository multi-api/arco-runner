import { chmod, lchown, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand, type Batcher, type Redactor } from '@multiapi/arco-cloud-client';
import { readPlainFile, removeTree } from '../fsutil.js';
import { runBuildCommands, runShell, type BuildCommandsContext } from '../job/commands.js';
import type { JobDocument, TestsSpec } from '../job/document.js';
import { BuildFailure } from '../job/errors.js';
import { GIT_HARDENING } from '../job/source.js';
import type { Steps } from '../job/steps.js';
import { ServiceStartError, type ServicesManager } from '../services/manager.js';
import { cutLine, type Identity, type Paths } from '../system.js';
import { copyEnvExample, ephemeralAppKey, generatePassword, hasAppKey, serviceVariables, testEnv } from './env.js';
import { parseJUnit, summarize, withJUnit, type JUnitCase } from './junit.js';

const REPORT_MAX_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;
const PHP_REDIS_TIMEOUT_MS = 10_000;
const GIT_PATH = '/usr/local/bin:/usr/bin:/bin';
const PARATEST_HINT = '`--parallel` needs brianium/paratest in composer.json (require-dev)';
const NO_SERVICES = 'Test services are not available on this runner';
const PREDIS_NOTE = 'The PHP of this runner has no redis extension: REDIS_CLIENT=predis, so the app needs predis/predis';

export interface TestPhaseContext {
  doc: JobDocument;
  tests: TestsSpec;
  /** resolveProjectDir-validated project directory. */
  projectDir: string;
  paths: Paths;
  identity: Identity | null;
  batcher: Batcher;
  steps: Steps;
  redactor: Redactor;
  signal: AbortSignal;
  /** Absolute build deadline (claim + timeout_seconds), compared with Date.now(). */
  buildDeadlineMs: number;
  services: (() => ServicesManager) | undefined;
  /** Kills every build-user process; null when there is no build user (tests without identity). */
  killBuildProcesses: (() => Promise<void>) | null;
  now?: () => number;
}

class IsolationError extends Error {
  constructor(detail: string) {
    super(`could not isolate the build from the tests: ${detail}`);
    this.name = 'IsolationError';
  }
}

const messageOf = (e: unknown): string => {
  const m = (e as { message?: unknown } | null)?.message;
  return (typeof m === 'string' && m ? m : String(e)).split('\n')[0]!.slice(0, 1000);
};

/** `p`, unless `signal` aborts or `ms` pass first (then rejects; `p` is left to settle on its own). */
async function untilAborted<T>(p: Promise<T>, signal: AbortSignal, ms: number): Promise<T> {
  const bound = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(signal.aborted ? 'aborted' : `no answer within ${ms / 1000} seconds`));
    if (bound.aborted) onAbort();
    else bound.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([p, aborted]);
  } finally {
    bound.removeEventListener('abort', onAbort);
  }
}

const exists = async (p: string): Promise<boolean> => {
  try { await lstat(p); return true; } catch { return false; }
};

/** gitignore pattern for a literal path segment run. */
const literalPattern = (p: string): string => p.replace(/[\\*?[]/g, '\\$&');

/** `-e` excludes for exactly the dependency dirs the cache keeps (cacheRoots), relative to the repository root. */
export function cleanExcludes(rootDir: string): string[] {
  const dirs = ['/vendor/', '/node_modules/'];
  const segs = rootDir.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  if (segs.length > 0) {
    const base = segs.map(literalPattern).join('/');
    dirs.push(`/${base}/vendor/`, `/${base}/node_modules/`);
  }
  return [...new Set(dirs)].flatMap((d) => ['-e', d]);
}

/**
 * The test phase (spec §4.2, §5.4): setup commands, services, the test command with JUnit, the build.tests step,
 * then cleanup and isolation, which run in every case (pass, fail, timeout, cancel). Throws BuildFailure on a
 * failed gate; an Error (runner.internal_error) when the build could not be isolated from the tests.
 */
export async function runTestPhase(ctx: TestPhaseContext): Promise<void> {
  const { doc, tests, projectDir, paths, identity, steps, redactor } = ctx;
  const now = ctx.now ?? Date.now;
  const line = (m: string) => ctx.batcher.addLine(cutLine(m));
  const testsDir = join(paths.tmpDirs[0]!, 'arco-tests');
  let manager: ServicesManager | null = null;
  let copiedEnv = false;
  /** Set once every build process was killed after the test command; cleanup then need not kill again. */
  let killedAfterTests = false;

  /** Why the build processes could not all be killed, or null. */
  const killFailure = async (): Promise<string | null> => {
    if (!ctx.killBuildProcesses) return null;
    try {
      await ctx.killBuildProcesses();
      return null;
    } catch (e) {
      return `build processes survived: ${messageOf(e)}`;
    }
  };
  const kill = async (): Promise<void> => {
    const why = await killFailure();
    if (why) throw new IsolationError(why);
  };

  const shell = (env: NodeJS.ProcessEnv): BuildCommandsContext => ({
    projectDir, env, identity, batcher: ctx.batcher, steps, deadlineMs: ctx.buildDeadlineMs, signal: ctx.signal,
    timeoutSeconds: doc.timeout_seconds,
  });

  async function startServices(m: ServicesManager, baseEnv: NodeJS.ProcessEnv): Promise<Record<string, string>> {
    const password = generatePassword();
    redactor.add(password);
    steps.start('build.test_services', { services: tests.services });
    // The build deadline also bounds the start (the test timeout only bounds the test command).
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), Math.min(2 ** 31 - 1, Math.max(0, ctx.buildDeadlineMs - Date.now())));
    timer.unref();
    const signal = AbortSignal.any([ctx.signal, deadline.signal]);
    let startMs;
    let redisClient: 'phpredis' | 'predis' = 'phpredis';
    try {
      startMs = await m.start(tests.services, password, signal);
      if (tests.services.includes('redis') && !(await untilAborted(m.phpRedis(baseEnv, identity), signal, PHP_REDIS_TIMEOUT_MS))) {
        redisClient = 'predis';
      }
    } catch (e) {
      const failure = ctx.signal.aborted
        ? new BuildFailure('build.cancelled', 'Cancelled')
        : deadline.signal.aborted
          ? new BuildFailure('build.timeout', `The build did not finish within ${doc.timeout_seconds} seconds`)
          : e instanceof ServiceStartError
            ? new BuildFailure('build.test_service_failed', e.message)
            : new BuildFailure('build.test_service_failed', `Test services could not be started: ${messageOf(e)}`);
      steps.warning('build.test_services', failure.message);
      throw failure;
    } finally {
      clearTimeout(timer);
    }
    steps.done('build.test_services', undefined, { start_ms: startMs });
    if (redisClient === 'predis') steps.note('build.test_services', PREDIS_NOTE);
    return serviceVariables(tests.services, tests.primary_database, password, redisClient);
  }

  /** A fresh real directory for the report, owned by the build user, 0700; returns its identity. */
  async function prepareTestsDir(): Promise<{ dev: number; ino: number }> {
    await removeTree(testsDir);
    await mkdir(testsDir, { mode: 0o700 });
    const st = await lstat(testsDir);
    if (!st.isDirectory()) throw new Error(`${testsDir} is not a directory`);
    await chmod(testsDir, 0o700);
    if (identity) await lchown(testsDir, identity.uid, identity.gid);
    return { dev: st.dev, ino: st.ino };
  }

  /** The parsed report, or why there is none. Only called once no build process is alive (nothing can swap the dir). */
  async function readReport(dir: { dev: number; ino: number }): Promise<{ cases: JUnitCase[] } | { reason: string }> {
    let st;
    try { st = await lstat(testsDir); } catch { return { reason: `${testsDir} was removed` }; }
    if (!st.isDirectory() || st.dev !== dir.dev || st.ino !== dir.ino) return { reason: `${testsDir} was replaced` };
    const buf = await readPlainFile(join(testsDir, 'junit.xml'), REPORT_MAX_BYTES);
    if (!buf) return { reason: 'missing, not a regular file or larger than 64 MiB' };
    try {
      return { cases: parseJUnit(buf.toString('utf8')) };
    } catch (e) {
      return { reason: messageOf(e) };
    }
  }

  async function git(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    const { exitCode } = await runCommand('git', [...GIT_HARDENING, '-c', 'core.attributesFile=/dev/null', ...args], {
      cwd: paths.repo, env, signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
      ...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
    });
    if (exitCode !== 0) throw new Error(`git ${args[0]} exited with code ${exitCode}`);
  }

  /** As the build user in the repository root: tracked files restored, untracked ones removed, dependencies kept. */
  async function restoreTree(): Promise<void> {
    const emptyHome = await mkdtemp(join(paths.tmpDirs[0]!, 'arco-git-home-'));
    try {
      if (identity) await lchown(emptyHome, identity.uid, identity.gid);
      const env: NodeJS.ProcessEnv = { PATH: GIT_PATH, LANG: 'C.UTF-8', HOME: emptyHome, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
      // From the deployed commit, not the index or HEAD: a test that staged a change or moved HEAD changes nothing.
      await git(['reset', '-q', '--hard', doc.source.sha], env);
      // -ff: untracked nested repositories too.
      await git(['clean', '-ffdx', ...cleanExcludes(doc.source.root_dir)], env);
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  }

  async function body(): Promise<void> {
    // .env first: a .env just copied from .env.example is what Laravel reads during the tests, so its APP_KEY counts.
    copiedEnv = await copyEnvExample(projectDir, identity);
    const appKey = (await hasAppKey(projectDir, tests.env)) ? null : ephemeralAppKey();
    if (appKey) {
      redactor.add(appKey);
      redactor.add(appKey.slice('base64:'.length));
    }
    const baseEnv = testEnv(paths, tests, {}, appKey);

    // Created up front, so that cleanup also stops and removes leftovers when the setup fails.
    if (tests.services.length > 0) {
      if (!ctx.services) throw new BuildFailure('build.test_service_failed', NO_SERVICES);
      manager = ctx.services();
    }

    await runBuildCommands(tests.setup_commands, { ...shell(baseEnv), keyPrefix: 'build.test_setup', failureCode: 'build.test_setup_failed' });
    // A background process of the setup could squat a service port or the report directory.
    await kill();

    const serviceVars = manager ? await startServices(manager, baseEnv) : {};
    const dir = await prepareTestsDir();
    const junit = withJUnit(tests.command, join(testsDir, 'junit.xml'));

    steps.start('build.tests', { command: tests.command });
    const testsDeadline = now() + tests.timeout_seconds * 1000;
    const timeoutFailure = testsDeadline <= ctx.buildDeadlineMs
      ? new BuildFailure('build.tests_timeout', `The tests did not finish within ${tests.timeout_seconds} seconds`)
      : new BuildFailure('build.timeout', `The build did not finish within ${doc.timeout_seconds} seconds`);
    const t0 = now();
    let exitCode: number;
    try {
      exitCode = await runShell(junit.command, shell(testEnv(paths, tests, serviceVars, appKey)), {
        deadlineMs: Math.min(testsDeadline, ctx.buildDeadlineMs), timeoutFailure, pipefail: true,
      });
    } catch (e) {
      if (e instanceof BuildFailure) steps.warning('build.tests', e.message, { ...summarize(null, now() - t0, redactor) });
      throw e;
    }
    const durationMs = now() - t0;
    await kill();
    killedAfterTests = true;

    let cases: JUnitCase[] | null = null;
    if (junit.report === 'junit') {
      const r = await readReport(dir);
      if ('cases' in r) cases = r.cases;
      else steps.note('build.tests_hint', `No usable JUnit report (${r.reason}); the result comes from the exit code`);
    }
    const params = summarize(cases, durationMs, redactor);
    if (exitCode === 0) {
      steps.done('build.tests', undefined, { ...params });
      return;
    }
    const failed = (params.failed ?? 0) + (params.errors ?? 0);
    const message = failed > 0 ? `${failed} ${failed === 1 ? 'test' : 'tests'} failed` : `The test command exited with code ${exitCode}`;
    steps.warning('build.tests', message, { ...params });
    if (/(?:^|\s)--parallel(?:[\s=]|$)/.test(tests.command) && !(await exists(join(projectDir, 'vendor/brianium/paratest')))) {
      steps.note('build.tests_hint', PARATEST_HINT);
    }
    throw new BuildFailure('build.tests_failed', message);
  }

  /** Spec §5.4: every part is attempted. Returns what failed to isolate the build (kill, git restore). */
  async function cleanup(): Promise<string[]> {
    const isolation: string[] = [];
    if (!killedAfterTests) {
      const why = await killFailure();
      if (why) isolation.push(why);
    }
    const m = manager as ServicesManager | null;
    if (m) {
      // Left to the wipe when it fails: logged only.
      try {
        const dropped = await m.dropDatabases();
        if (dropped.length > 0) line(`Dropped test databases: ${dropped.join(', ')}`);
      } catch (e) {
        line(`Dropping the test databases failed: ${messageOf(e)}`);
      }
      try { await m.stopAll(); } catch (e) { line(`Stopping the test services failed: ${messageOf(e)}`); }
      try { await m.removeData(); } catch (e) { line(`Removing the test services data failed: ${messageOf(e)}`); }
    }
    try { await removeTree(testsDir); } catch (e) { line(`Removing ${testsDir} failed: ${messageOf(e)}`); }
    if (copiedEnv) {
      try { await rm(join(projectDir, '.env'), { force: true }); } catch (e) { line(`Removing the copied .env failed: ${messageOf(e)}`); }
    }
    try { await restoreTree(); } catch (e) { isolation.push(`restoring the working tree failed: ${messageOf(e)}`); }
    // git itself may have run something of the build user's (a filter in a .git/config the tests wrote): the build
    // commands must start with no build process alive.
    const why = await killFailure();
    if (why) isolation.push(why);
    return isolation;
  }

  let failure: unknown = null;
  try {
    await body();
  } catch (e) {
    failure = e;
  }
  const isolation = await cleanup();
  if (isolation.length > 0) throw new IsolationError(isolation.join('; '));
  if (failure !== null) throw failure;
}
