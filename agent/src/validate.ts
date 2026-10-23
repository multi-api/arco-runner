import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { runCommand } from '@multiapi/arco-cloud-client';
import { removeTree } from './fsutil.js';
import { startFakeCloud, type FakeCloud } from './loopback-cloud.js';
import type { CacheManifest } from './job/cache.js';
import type { ServiceName, TicketPayload } from './job/document.js';
import { runJob, type JobResult } from './job/run-job.js';
import { SERVICE_LABELS, SERVICE_USERS, serviceUserIds } from './services/catalog.js';
import { createServicesManager, defaultServicePaths, type ServicePaths, type ServicesManager } from './services/manager.js';
import { buildEnv, type Identity, type Paths } from './system.js';
import { generatePassword, serviceVariables } from './tests/env.js';
import { killUserProcesses, wipe } from './wipe.js';

const execFileP = promisify(execFile);

/** The image's smoke test failed. A reason starting with `capabilities:` means the VM cannot switch uid or kill processes. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const ROOT_DIR = 'app';
const COMMANDS = ['composer install --no-interaction --prefer-dist', 'npm ci --offline', 'npm run build', 'sleep 300 &'];
/**
 * The first canned job also runs a test phase: the fixture's `php artisan test` runs the offline fake PHPUnit.
 * The setup installs it (offline): the test phase runs before the build commands, and the first job has no cache.
 */
const CANNED_TESTS = {
  command: 'php artisan test', setup_commands: ['composer install --no-interaction --prefer-dist'], services: [],
  primary_database: null, timeout_seconds: 300, env: { COMPOSER_DISABLE_NETWORK: '1' }, mask: [],
};
const GIT_ENV = (home: string): NodeJS.ProcessEnv => ({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' });
const PERMISSION_TROUBLE = /EPERM|operation not permitted|survived SIGKILL|setuid|setgid|cannot kill/i;

const tail = (lines: string[], max = 30): string => lines.slice(-max).join('\n').slice(-4000);

/** A bare clone of the bundle, owned by the build user (git refuses repositories another user owns). */
async function prepareSource(bundle: string, paths: Paths, identity: Identity | null): Promise<{ dir: string; url: string; sha: string }> {
  try {
    await access(bundle);
  } catch {
    throw new ValidationError(`fixture bundle not found: ${bundle}`);
  }
  const dir = await mkdtemp(join(paths.tmpDirs[0]!, 'arco-validate-'));
  const repo = join(dir, 'app.git');
  try {
    // A bundle is not a fetch source over file://: unpack it where the build user can fetch from it.
    await execFileP('git', ['clone', '--quiet', '--bare', '--', bundle, repo], { env: GIT_ENV(dir) });
    const sha = (await execFileP('git', ['-C', repo, 'rev-parse', 'HEAD'], { env: GIT_ENV(dir) })).stdout.trim();
    if (identity) await execFileP('chown', ['-R', `${identity.uid}:${identity.gid}`, dir]);
    return { dir, url: `file://${repo}`, sha };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw new ValidationError(`cannot unpack the fixture bundle: ${(e as Error).message.split('\n')[0]}`);
  }
}

interface Pass {
  result: JobResult;
  cloud: FakeCloud;
  logs: string[];
  killFailure: string | null;
}

/** One canned job through runJob with the real wipe, against an in-process Cloud on 127.0.0.1. */
async function cannedJob(o: {
  paths: Paths; identity: Identity | null; bundle: string; knownCache: CacheManifest | null; seed?: FakeCloud; withTests?: boolean;
}): Promise<Pass> {
  const { paths, identity } = o;
  const source = await prepareSource(o.bundle, paths, identity);
  const token = `rt_${randomBytes(12).toString('hex')}`;
  const ticket = `tkt_${randomBytes(12).toString('hex')}`;
  const cloud = await startFakeCloud({ job: {}, ticket });
  try {
    if (o.seed) for (const [k, v] of o.seed.objects) cloud.objects.set(k, v);
    cloud.options.job = {
      deployment_id: 'dep_validate', environment: 'production', mode: 'deploy', nonce: `nonce_${randomBytes(12).toString('hex')}`,
      runner_token: token,
      source: {
        clone_url: source.url, sha: source.sha, root_dir: ROOT_DIR,
        auth_header: 'basic ' + Buffer.from(`x-access-token:ghs_${randomBytes(12).toString('hex')}`).toString('base64'),
      },
      php_version: '8.5', commands: COMMANDS, env: { COMPOSER_DISABLE_NETWORK: '1' }, mask: [],
      cache: { restore_url: `${cloud.url}/s3/cache?X-Amz-Signature=sig${randomBytes(8).toString('hex')}`, save_url: `${cloud.url}/s3/cache?X-Amz-Signature=sig${randomBytes(8).toString('hex')}`, key: 'validate' },
      timeout_seconds: 600,
      ...(o.withTests ? { tests: CANNED_TESTS, defer_credentials: true } : {}),
    };
    const payload: TicketPayload = { ticket, api_base: cloud.url, deployment_id: 'dep_validate' };
    let known = o.knownCache;
    const logs: string[] = [];
    let killFailure: string | null = null;
    const result = await runJob(payload, {
      paths, identity, mode: 'microvm', signal: AbortSignal.timeout(14 * 60_000),
      knownCache: { get: () => known, set: (m) => { known = m; } },
      onPhase: () => {}, receivedAt: Date.now(),
      wipe: (rootDir) => wipe(paths, rootDir, identity ? { uid: identity.uid } : {}),
      // Same as runJob's default, but remembers a failure: the job only logs it, validation must fail on it.
      ...(identity ? { killBuildProcesses: async () => {
        try { await killUserProcesses(identity.uid); } catch (e) { killFailure = (e as Error).message; throw e; }
      } } : {}),
      checkoutOptions: { extraGitArgs: ['-c', 'protocol.file.allow=always'], allowFileUrl: true },
      log: (m) => { logs.push(m); console.log(`[validate] ${m}`); },
    });
    await rm(source.dir, { recursive: true, force: true });
    await removeBuildState(paths);
    return { result, cloud, logs, killFailure };
  } catch (e) {
    await cloud.close();
    await rm(source.dir, { recursive: true, force: true });
    await removeBuildState(paths).catch(() => {});
    throw e;
  }
}

/** What the job sent to Cloud's `logs` endpoint: the lines (for failure messages) and the step events. */
type SentEvent = { key: string; status: string; params?: Record<string, unknown> };
function sentLogs(cloud: FakeCloud): { lines: string[]; events: SentEvent[] } {
  const out = { lines: [] as string[], events: [] as SentEvent[] };
  for (const r of cloud.calls('/logs')) {
    try {
      const body = JSON.parse(r.body.toString('utf8')) as { lines?: string[]; events?: SentEvent[] };
      out.lines.push(...(body.lines ?? []));
      out.events.push(...(body.events ?? []));
    } catch { /* not a batch */ }
  }
  return out;
}
const cloudLines = (cloud: FakeCloud): string[] => sentLogs(cloud).lines;

/**
 * Nothing the canned jobs built may outlive them (as root, links unlinked and never followed): the checkout and
 * the dependency caches. Only `.arco/cache/runtime` (the image's own) stays.
 */
async function removeBuildState(paths: Paths): Promise<void> {
  for (const p of [paths.repo, join(paths.home, '.npm'), join(paths.home, '.cache')]) await removeTree(p);
}

async function processesOf(uid: number): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = await readFile(join('/proc', name, 'status'), 'utf8');
      const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
      // A zombie (exited, not yet reaped by its parent or by tini, PID 1) holds nothing and cannot be killed again.
      if (/^State:\s+[ZX]/m.test(status)) continue;
      if (ids && ids.slice(1, 5).some((v) => Number(v) === uid)) found.push(/^Name:\s+(.*)$/m.exec(status)?.[1] ?? name);
    } catch { /* exited meanwhile */ }
  }
  return found;
}

/** The build user must not be able to write the agent's directory. */
async function checkAgentDirReadOnly(paths: Paths, identity: Identity): Promise<void> {
  const probe = join(paths.agentDir, `.write-probe-${randomBytes(4).toString('hex')}`);
  let exitCode: number;
  const output: string[] = [];
  try {
    ({ exitCode } = await runCommand('/bin/bash', ['-c', ': > "$1"', '_', probe], {
      cwd: '/', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, onStdoutLine: (l) => output.push(l), onStderrLine: (l) => output.push(l), signal: AbortSignal.timeout(30_000),
      uid: identity.uid, gid: identity.gid,
    }));
  } catch (e) {
    throw new ValidationError(`capabilities: cannot run a command as uid ${identity.uid}: ${(e as Error).message}`);
  }
  const written = await access(probe).then(() => true, () => false);
  if (written) await rm(probe, { force: true });
  if (written || exitCode === 0) throw new ValidationError(`${paths.agentDir} is writable by the build user`);
  // Not writable for the right reason: a bash that failed to start or an uid that cannot enter the directory is not proof.
  if (!output.some((l) => /Permission denied/.test(l))) throw new ValidationError(`write probe in ${paths.agentDir} failed without "Permission denied": ${output.join(' ').slice(0, 300)}`);
}

const archiveToolsPresent = (): boolean =>
  /GNU tar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '') && spawnSync('zstd', ['--version']).status === 0;

/**
 * Reads every runtime binary the image pre-seeds under `.arco/cache/runtime/<build>/` in full, the way
 * `arco deploy` does when it checks their sha256. Lambda prefetches on every new VM the snapshot pages read
 * during /validate, so a cold deploy no longer pays ~30 s of demand paging for ~260 MB at `binary.using`.
 * Regular files only (lstat); returns how many files and bytes were read.
 */
export async function prefetchRuntimeCache(home: string): Promise<{ files: number; bytes: number }> {
  const root = join(home, '.arco', 'cache', 'runtime');
  let builds: string[];
  try {
    builds = await readdir(root);
  } catch {
    return { files: 0, bytes: 0 };
  }
  let files = 0;
  let bytes = 0;
  for (const build of builds) {
    const dir = join(root, build);
    if (!(await lstat(dir)).isDirectory()) continue;
    for (const name of await readdir(dir)) {
      const file = join(dir, name);
      if (!(await lstat(file)).isFile()) continue;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) {
        hash.update(chunk as Buffer);
        bytes += (chunk as Buffer).length;
      }
      hash.digest();
      files++;
    }
  }
  return { files, bytes };
}

/**
 * Connects as the app would, from the §5.3 variables: PDO for a database, phpredis for Redis (a raw PING when
 * the extension is missing). Prints "ok" or why it failed; never prints a variable's value.
 */
const SMOKE_PHP = `
$e = fn (string $k): string => (string) getenv($k);
try {
    if ($e('DB_CONNECTION') !== '') {
        $c = $e('DB_CONNECTION');
        $pdo = new PDO("{$c}:host={$e('DB_HOST')};port={$e('DB_PORT')};dbname={$e('DB_DATABASE')}", $e('DB_USERNAME'), $e('DB_PASSWORD'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
        $pdo->exec('CREATE TABLE arco_smoke (id integer)');
        $pdo->exec('INSERT INTO arco_smoke (id) VALUES (1)');
        if ((int) $pdo->query('SELECT count(*) FROM arco_smoke')->fetchColumn() !== 1) throw new RuntimeException('the inserted row was not read back');
    } elseif ($e('REDIS_HOST') !== '') {
        if ($e('REDIS_CLIENT') === 'phpredis') {
            $r = new Redis();
            $r->connect($e('REDIS_HOST'), (int) $e('REDIS_PORT'), 5.0);
            $r->set('arco_smoke', '1');
            if ($r->get('arco_smoke') !== '1') throw new RuntimeException('the value was not read back');
        } else {
            $s = fsockopen($e('REDIS_HOST'), (int) $e('REDIS_PORT'), $errno, $errstr, 5.0);
            if ($s === false) throw new RuntimeException("connect failed: {$errstr}");
            fwrite($s, "PING\\r\\n");
            if (fgets($s) !== "+PONG\\r\\n") throw new RuntimeException('no PONG');
        }
    } else {
        throw new RuntimeException('no service variables');
    }
    echo "ok\\n";
} catch (Throwable $t) {
    fwrite(STDERR, get_class($t) . ': ' . $t->getMessage() . "\\n");
    exit(1);
}
`;

const SMOKE_SERVICES: readonly ServiceName[] = ['mysql', 'pgsql', 'redis'];

async function entries(dir: string): Promise<string[]> {
  try { return await readdir(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}

/**
 * Starts each test service once (spec §8), connects to it from PHP as the build user with the §5.3 variables, then
 * drops its databases, stops it and removes its data, and checks that no process of the service user and no data
 * are left. Returns each start time (cold start plus database creation). Throws ValidationError, also when a service
 * user is missing: the wipe could not kill its processes and the survivor check would pass silently.
 */
export async function smokeServices(o: {
  manager: ServicesManager; identity: Identity; paths: Paths; log: (m: string) => void; servicePaths?: ServicePaths;
  /** Default /etc/passwd. */
  passwdPath?: string;
}): Promise<Record<ServiceName, number>> {
  const { manager, identity, paths } = o;
  const sp = o.servicePaths ?? defaultServicePaths();
  const out = {} as Record<ServiceName, number>;
  try {
    const { uids, missing } = serviceUserIds(await readFile(o.passwdPath ?? '/etc/passwd', 'utf8').catch(() => ''));
    const missingHere = SMOKE_SERVICES.map((s) => SERVICE_USERS[s]).filter((n) => missing.includes(n));
    if (missingHere.length > 0) throw new ValidationError(`services: system user missing from the image: ${missingHere.join(', ')}`);
    for (const s of SMOKE_SERVICES) {
      const label = SERVICE_LABELS[s];
      const password = generatePassword();
      const mask = (t: string) => t.split(password).join('***');
      let ms: number;
      try {
        ms = (await manager.start([s], password, AbortSignal.timeout(120_000)))[s];
      } catch (e) {
        throw new ValidationError(`services: ${label} did not start: ${mask((e as Error).message)}`);
      }
      const redisClient = s === 'redis' && !(await manager.phpRedis(buildEnv(paths, {}), identity)) ? 'predis' : 'phpredis';
      const output: string[] = [];
      let exitCode: number;
      try {
        ({ exitCode } = await runCommand('php', ['-r', SMOKE_PHP], {
          cwd: '/', env: buildEnv(paths, serviceVariables([s], null, password, redisClient)),
          onStdoutLine: (l) => output.push(l), onStderrLine: (l) => output.push(l), signal: AbortSignal.timeout(30_000),
          uid: identity.uid, gid: identity.gid,
        }));
      } catch (e) {
        throw new ValidationError(`services: cannot run PHP as uid ${identity.uid}: ${mask((e as Error).message)}`);
      }
      if (exitCode !== 0 || output.at(-1) !== 'ok') {
        throw new ValidationError(`services: PHP could not use ${label} (exit ${exitCode}): ${mask(output.join(' ')).slice(0, 1000)}`);
      }
      try {
        await manager.dropDatabases();
        await manager.stopAll();
        await manager.removeData();
      } catch (e) {
        throw new ValidationError(`services: cleaning up ${label} failed: ${mask((e as Error).message)}`);
      }
      const alive = await processesOf(uids[s]!);
      if (alive.length > 0) throw new ValidationError(`services: ${label} processes survived the stop: ${alive.join(', ')}`);
      const left = [...(await entries(sp.dataDir)), ...(await entries(sp.runDir))];
      if (left.length > 0) throw new ValidationError(`services: ${label} left data behind: ${left.join(', ')}`);
      out[s] = ms;
      o.log(`${s} ready in ${ms} ms`);
    }
    return out;
  } finally {
    // After a failure: nothing may run or stay (the snapshot is taken after /validate).
    await manager.stopAll().catch(() => {});
    await manager.removeData().catch(() => {});
  }
}

/**
 * The image's smoke test (spec §9.3): in the image, each test service is started once (smokeServices); then two
 * canned jobs run through the real pipeline against an in-process Cloud on 127.0.0.1 and no network. The first runs
 * a test phase, builds and saves the cache, the second restores it. Throws ValidationError.
 */
export async function runValidation(o: { paths: Paths; identity: Identity | null; fixtureDir: string }): Promise<void> {
  const { paths, identity } = o;
  const bundle = join(o.fixtureDir, 'app.bundle');
  // A dev machine may lack GNU tar or zstd; the image must have them, so with an identity the cache is required.
  const cache = identity !== null || archiveToolsPresent();
  const clouds: FakeCloud[] = [];

  // In the image the runtime cache is always pre-seeded; finding none means the image is broken.
  const prefetched = await prefetchRuntimeCache(paths.home);
  if (identity !== null && prefetched.files === 0) {
    throw new ValidationError(`no pre-seeded runtime binaries under ${join(paths.home, '.arco', 'cache', 'runtime')}`);
  }

  const check = (pass: Pass, label: string): void => {
    const fail = (why: string): never => {
      const out = `${label}: ${why}\n${tail([...cloudLines(pass.cloud), ...pass.logs])}`;
      throw new ValidationError(identity && PERMISSION_TROUBLE.test(out) ? `capabilities: ${out}` : out);
    };
    if (pass.killFailure) throw new ValidationError(`capabilities: ${label}: killing build processes failed: ${pass.killFailure}`);
    const finishes = pass.cloud.calls('/finish').map((r) => JSON.parse(r.body.toString('utf8')) as { result?: string });
    if (finishes.length !== 1 || finishes[0]!.result !== 'succeeded') return fail(`Cloud did not receive a finish with result succeeded (got ${JSON.stringify(finishes)})`);
    if (!pass.result.buildOk || !pass.result.finished) return fail(`job result ${JSON.stringify(pass.result)}`);
    if (!pass.result.idleReported) return fail('idle was not reported');
  };

  // The test services, each started once with nothing left behind; only in the image (as root, with the users).
  if (identity !== null) {
    try {
      await smokeServices({ manager: createServicesManager(defaultServicePaths()), identity, paths, log: (m) => console.log(`[validate] ${m}`) });
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      throw new ValidationError(`services: ${(e as Error).message}`);
    }
  }

  try {
    let first: Pass;
    try {
      first = await cannedJob({ paths, identity, bundle, knownCache: null, withTests: true });
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      const msg = (e as Error).message;
      throw new ValidationError(`${identity && PERMISSION_TROUBLE.test(msg) ? 'capabilities: ' : ''}the canned job threw: ${msg}`);
    }
    clouds.push(first.cloud);
    check(first, 'first job');
    const tests = sentLogs(first.cloud).events.find((ev) => ev.key === 'build.tests' && ev.status === 'done');
    if (!tests) throw new ValidationError(`first job: the test phase did not pass\n${tail([...cloudLines(first.cloud), ...first.logs])}`);
    console.log(`[validate] test phase passed: ${String(tests.params?.passed)} tests in ${String(tests.params?.duration_s)} s`);

    if (identity) {
      const alive = await processesOf(identity.uid);
      if (alive.length > 0) throw new ValidationError(`capabilities: build user processes survived the wipe: ${alive.join(', ')}`);
      await checkAgentDirReadOnly(paths, identity);
    }

    if (cache) {
      if (!first.cloud.objects.has('cache')) throw new ValidationError(`first job: the cache was not saved\n${tail(first.logs)}`);
      // A cold VM again: the second job restores the cache the first one uploaded.
      let second: Pass;
      try {
        second = await cannedJob({ paths, identity, bundle, knownCache: null, seed: first.cloud });
      } catch (e) {
        if (e instanceof ValidationError) throw e;
        throw new ValidationError(`the second canned job threw: ${(e as Error).message}`);
      }
      clouds.push(second.cloud);
      check(second, 'second job');
      const restored = sentLogs(second.cloud).events.some((ev) => ev.key === 'build.cache_restore' && ev.status === 'done');
      if (!restored) throw new ValidationError(`second job: the cache was not restored\n${tail([...cloudLines(second.cloud), ...second.logs])}`);
      // The first job removed everything it built, so composer finding vendor complete proves the archive supplied it.
      if (!cloudLines(second.cloud).some((l) => /Nothing to install, update or remove/.test(l))) {
        throw new ValidationError(`second job: composer did not find vendor restored from the cache\n${tail([...cloudLines(second.cloud), ...second.logs])}`);
      }
      if (identity && (await processesOf(identity.uid)).length > 0) throw new ValidationError('capabilities: build user processes survived the wipe');
    }
  } finally {
    for (const c of clouds) await c.close();
  }
}
