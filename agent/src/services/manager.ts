import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, constants, lstat, mkdir, open, readdir, type FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runCommand } from '@multiapi/arco-cloud-client';
import { ensureRealDir, isRealDir, removeTree } from '../fsutil.js';
import type { ServiceName } from '../job/document.js';
import type { Identity } from '../system.js';
import { killUserProcesses } from '../wipe.js';
import {
  SERVICE_LABELS,
  SERVICE_USERS,
  SYSTEM_DATABASES,
  adminArgv,
  createSql,
  dropSql,
  listDatabasesSql,
  probeArgv,
  serverArgv,
  type DatabaseService,
  type ServicePaths,
} from './catalog.js';

export { defaultServicePaths, type ServicePaths } from './catalog.js';

const execFileP = promisify(execFile);
const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';
const READY_TIMEOUT_MS = 30_000;
const PROBE_INTERVAL_MS = 250;
const STOP_GRACE_MS = 10_000;
const KILL_WAIT_MS = 5_000;
const ADMIN_TIMEOUT_MS = 60_000;
const LOG_TAIL_LINES = 20;
const LOG_TAIL_BYTES = 64 * 1024;

export interface ServicesManager {
  /** Starts each service in order; ms per service (cold start plus database creation). */
  start(services: ServiceName[], password: string, signal: AbortSignal): Promise<Record<ServiceName, number>>;
  /** Drops every non-system database on the running database servers; the names dropped. */
  dropDatabases(): Promise<string[]>;
  /** SIGTERM, SIGKILL after 10 s, then kill any process left of the service user. */
  stopAll(): Promise<void>;
  /** Deletes dataDir/* and runDir/* (never following links). */
  removeData(): Promise<void>;
  /** Whether the image's PHP has the `redis` extension (cached). */
  phpRedis(env: NodeJS.ProcessEnv, identity: Identity | null): Promise<boolean>;
}

export class ServiceStartError extends Error {
  constructor(readonly service: ServiceName, message: string) {
    super(message);
    this.name = 'ServiceStartError';
  }
}

export interface ServerProcess {
  /** Resolves when the server exits (or failed to spawn). */
  readonly exited: Promise<number | null>;
  /** Signals the server's process group. */
  kill(signal: NodeJS.Signals): void;
}

interface RunAs { uid: number; gid: number }
export interface SpawnServerOptions extends RunAs { logFd: number; cwd: string; env: NodeJS.ProcessEnv }
export interface AdminResult { exitCode: number; stdout: string; stderr: string }

export interface ServicesManagerOptions {
  spawnServer?: (s: ServiceName, argv: string[], o: SpawnServerOptions) => ServerProcess;
  probe?: (s: ServiceName, argv: string[], as: RunAs) => Promise<boolean>;
  admin?: (s: DatabaseService, argv: string[], sql: string, o: RunAs & { signal?: AbortSignal }) => Promise<AdminResult>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: resolves a service user's uid (its gid is taken to be the same). Default: /etc/passwd. */
  userUid?: (name: string) => number;
  /** Kills every process left of a service user. Default: killUserProcesses, as root only. */
  killUser?: (uid: number) => Promise<void>;
  /** Major version of redis-server (gates the Redis 7 flags). Default: `redis-server --version`. */
  redisMajor?: () => Promise<number>;
  phpHasRedis?: (env: NodeJS.ProcessEnv, identity: Identity | null) => Promise<boolean>;
}

const isRoot = () => process.getuid?.() === 0;
const asUser = (as: RunAs) => (isRoot() ? { uid: as.uid, gid: as.gid } : {});
const serverEnv = (home: string): NodeJS.ProcessEnv => ({ PATH: SYSTEM_PATH, LANG: 'C.UTF-8', HOME: home });

const abortError = () => new DOMException('The operation was aborted', 'AbortError');

function lookupUser(name: string): RunAs | null {
  let text: string;
  try { text = readFileSync('/etc/passwd', 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    const f = line.split(':');
    if (f[0] === name && f.length >= 4) return { uid: Number(f[2]), gid: Number(f[3]) };
  }
  return null;
}

function defaultSpawnServer(_s: ServiceName, argv: string[], o: SpawnServerOptions): ServerProcess {
  const [file, ...args] = argv;
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((r) => { resolveExit = r; });
  // Detached: its own process group, so a server's children (postgres backends) are signalled together.
  const child = spawn(file!, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', o.logFd, o.logFd], ...asUser(o) });
  child.once('exit', (code) => resolveExit(code));
  child.once('error', () => resolveExit(null));
  return {
    exited,
    kill(signal) {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* gone */ }
      }
    },
  };
}

async function defaultProbe(s: ServiceName, argv: string[], as: RunAs): Promise<boolean> {
  try {
    const { stdout } = await execFileP(argv[0]!, argv.slice(1), { env: serverEnv('/'), cwd: '/', timeout: 5000, encoding: 'utf8', ...asUser(as) });
    return s !== 'redis' || stdout.trim() === 'PONG';
  } catch {
    return false;
  }
}

/** Runs the admin client with the SQL on stdin (never in argv, which `ps` shows). Never rejects. */
function defaultAdmin(_s: DatabaseService, argv: string[], sql: string, o: RunAs & { signal?: AbortSignal }): Promise<AdminResult> {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd: '/', env: serverEnv('/'), stdio: ['pipe', 'pipe', 'pipe'], ...asUser(o) });
    } catch (e) {
      resolve({ exitCode: 127, stdout, stderr: (e as Error).message });
      return;
    }
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
    const timer = setTimeout(kill, ADMIN_TIMEOUT_MS);
    o.signal?.addEventListener('abort', kill, { once: true });
    child.stdout.setEncoding('utf8').on('data', (d: string) => { if (stdout.length < 1 << 20) stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < 1 << 16) stderr += d; });
    child.stdin.on('error', () => { /* the client exited early; its status says why */ });
    child.stdin.end(sql);
    const done = (code: number) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', kill);
      resolve({ exitCode: code, stdout, stderr });
    };
    child.once('error', (e) => { stderr += e.message; done(127); });
    child.once('close', (code) => done(code ?? 1));
  });
}

/** Last `LOG_TAIL_BYTES` of a file the service user could have replaced: lstat-free, O_NOFOLLOW, regular files only. */
async function readTail(path: string): Promise<string> {
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile()) return '';
    const len = Math.min(st.size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => {});
  }
}

const tailLines = (text: string, n: number) => text.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-n);

export function createServicesManager(p: ServicePaths, o: ServicesManagerOptions = {}): ServicesManager {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => delay(ms, undefined, { ref: false }));
  const spawnServer = o.spawnServer ?? defaultSpawnServer;
  const probe = o.probe ?? defaultProbe;
  const admin = o.admin ?? defaultAdmin;
  const killUser = o.killUser ?? (async (uid: number) => {
    // On a dev machine the "service user" may be the agent's own uid: never kill that.
    if (isRoot() && uid > 0) await killUserProcesses(uid);
  });
  let redisMajorP: Promise<number> | null = null;
  const redisMajor = o.redisMajor ?? (async () => {
    try {
      const { stdout } = await execFileP(`${p.binDir}/redis-server`, ['--version'], { env: serverEnv('/'), timeout: 5000, encoding: 'utf8' });
      return Number(/\bv=(\d+)\./.exec(stdout)?.[1] ?? 6);
    } catch {
      return 6; // no Redis 7-only flags: Redis 7 defaults them to "no" anyway
    }
  });
  let phpRedisP: Promise<boolean> | null = null;
  const phpHasRedis = o.phpHasRedis ?? (async (env: NodeJS.ProcessEnv, identity: Identity | null) => {
    const { exitCode } = await runCommand('php', ['-r', "exit(extension_loaded('redis') ? 0 : 1);"], {
      cwd: '/',
      env,
      ...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
    });
    return exitCode === 0;
  });

  const running: Array<{ s: ServiceName; proc: ServerProcess; uid: number }> = [];
  /** Service users whose leftovers have not been killed yet (kept until a kill succeeds). */
  const pendingUsers = new Set<number>();

  const ids = (s: ServiceName): RunAs => {
    const name = SERVICE_USERS[s];
    if (o.userUid) { const uid = o.userUid(name); return { uid, gid: uid }; }
    const u = lookupUser(name);
    if (!u || !Number.isInteger(u.uid) || !Number.isInteger(u.gid)) throw new ServiceStartError(s, `${SERVICE_LABELS[s]}: system user ${name} is missing`);
    return u;
  };

  async function logTail(s: ServiceName, password: string): Promise<string> {
    const files = [join(p.dataDir, s, 'server.log'), ...(s === 'mysql' ? [join(p.dataDir, s, 'error.log')] : [])];
    const text = (await Promise.all(files.map(readTail))).join('\n');
    const lines = tailLines(text, LOG_TAIL_LINES).map((l) => (password ? l.split(password).join('***') : l));
    return lines.length ? `\n${lines.join('\n')}` : '';
  }

  /** Fresh data and socket dirs for `s`, owned by its user; returns the open server log (created by root, never through a link). */
  async function prepare(s: ServiceName, as: RunAs): Promise<FileHandle> {
    const data = join(p.dataDir, s);
    const run = join(p.runDir, s);
    await ensureRealDir(p.dataDir);
    await ensureRealDir(p.runDir);
    await removeTree(data);
    await removeTree(run);
    if (s === 'redis') {
      await mkdir(data, { mode: 0o700 });
    } else {
      const template = join(p.templateDir, s);
      if (!(await isRealDir(template))) throw new ServiceStartError(s, `${SERVICE_LABELS[s]}: template ${template} is missing`);
      await execFileP('cp', ['-a', '--', template, data], { env: { PATH: SYSTEM_PATH } });
    }
    await chmod(data, 0o700);
    await mkdir(run, { mode: 0o700 });
    if (isRoot()) {
      // -P: never follow a link (the copy comes from the root-owned template; nothing of the user runs yet).
      await execFileP('chown', ['-R', '-P', `${as.uid}:${as.gid}`, '--', data, run], { env: { PATH: SYSTEM_PATH } });
    }
    return open(join(data, 'server.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  }

  async function startOne(s: ServiceName, password: string, signal: AbortSignal, aborted: Promise<void>): Promise<number> {
    const t0 = now();
    const label = SERVICE_LABELS[s];
    const as = ids(s);
    let log: FileHandle;
    try {
      log = await prepare(s, as);
    } catch (e) {
      if (e instanceof ServiceStartError) throw e;
      throw new ServiceStartError(s, `${label} could not be prepared: ${(e as Error).message}`);
    }
    if (signal.aborted) { await log.close(); throw abortError(); }
    const argv = serverArgv(s, p, s === 'redis' ? await (redisMajorP ??= redisMajor()) : 0);
    let proc: ServerProcess;
    try {
      proc = spawnServer(s, argv, { ...as, logFd: log.fd, cwd: join(p.dataDir, s), env: serverEnv(join(p.dataDir, s)) });
    } catch (e) {
      throw new ServiceStartError(s, `${label} could not be started: ${(e as Error).message}`);
    } finally {
      await log.close(); // the server holds its own copy
    }
    running.push({ s, proc, uid: as.uid });
    pendingUsers.add(as.uid);
    let exited = false;
    void proc.exited.then(() => { exited = true; });

    const deadline = now() + READY_TIMEOUT_MS;
    for (;;) {
      if (signal.aborted) throw abortError();
      if (exited) throw new ServiceStartError(s, `${label} exited before becoming ready${await logTail(s, password)}`);
      if (await probe(s, probeArgv(s, p), as)) break;
      if (signal.aborted) throw abortError();
      if (now() >= deadline) throw new ServiceStartError(s, `${label} did not become ready within 30 seconds${await logTail(s, password)}`);
      await Promise.race([sleep(PROBE_INTERVAL_MS), aborted]);
    }

    if (s !== 'redis') {
      const r = await admin(s, adminArgv(s, p), createSql(s, password), { ...as, signal });
      if (signal.aborted) throw abortError();
      if (r.exitCode !== 0) {
        const why = tailLines(r.stderr, 5).map((l) => (password ? l.split(password).join('***') : l)).join('\n');
        throw new ServiceStartError(s, `${label}: creating the test database failed (exit ${r.exitCode})${why ? `\n${why}` : ''}`);
      }
    }
    return now() - t0;
  }

  async function stopOne(proc: ServerProcess): Promise<void> {
    proc.kill('SIGTERM');
    const outcome = await Promise.race([proc.exited.then(() => 'exited' as const), sleep(STOP_GRACE_MS).then(() => 'timeout' as const)]);
    if (outcome === 'exited') return;
    proc.kill('SIGKILL');
    await Promise.race([proc.exited, sleep(KILL_WAIT_MS)]);
  }

  async function stopAll(): Promise<void> {
    const procs = running.splice(0).reverse();
    for (const r of procs) await stopOne(r.proc);
    let first: unknown = null;
    for (const uid of [...pendingUsers]) {
      try {
        await killUser(uid);
        pendingUsers.delete(uid);
      } catch (e) {
        first ??= e;
      }
    }
    if (first) throw first;
  }

  return {
    async start(services, password, signal) {
      const out = {} as Record<ServiceName, number>;
      let onAbort: () => void = () => {};
      const aborted = new Promise<void>((r) => { onAbort = r; signal.addEventListener('abort', onAbort, { once: true }); });
      try {
        for (const s of new Set(services)) {
          if (signal.aborted) throw abortError();
          out[s] = await startOne(s, password, signal, aborted);
        }
        return out;
      } catch (e) {
        // Stop what was started; a failure here is left to the caller's cleanup (stopAll again, then the wipe).
        await stopAll().catch(() => {});
        throw e;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },

    async dropDatabases() {
      const dropped: string[] = [];
      for (const { s } of running) {
        if (s === 'redis') continue;
        const as = ids(s);
        const list = await admin(s, adminArgv(s, p), listDatabasesSql(s), as);
        if (list.exitCode !== 0) throw new Error(`${SERVICE_LABELS[s]}: listing databases failed (exit ${list.exitCode})`);
        const names = list.stdout.split('\n').map((l) => l.trim()).filter((n) => n && !SYSTEM_DATABASES[s].includes(n));
        if (names.length === 0) continue;
        const drop = await admin(s, adminArgv(s, p), dropSql(s, names), as);
        if (drop.exitCode !== 0) throw new Error(`${SERVICE_LABELS[s]}: dropping databases failed (exit ${drop.exitCode})`);
        dropped.push(...names);
      }
      return dropped;
    },

    stopAll,

    async removeData() {
      for (const dir of [p.dataDir, p.runDir]) {
        let st;
        try { st = await lstat(dir); } catch { continue; }
        if (!st.isDirectory()) { await removeTree(dir); continue; } // a planted link is unlinked, never followed
        for (const name of await readdir(dir)) await removeTree(join(dir, name));
      }
    },

    phpRedis(env, identity) {
      return (phpRedisP ??= phpHasRedis(env, identity).catch(() => false));
    },
  };
}
