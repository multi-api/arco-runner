import { execFile, spawn } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { isRealDir, removeTree, sanitizeKeep, wipeExcept } from './fsutil.js';
import { cacheRoots } from './job/cache.js';
import type { Paths } from './system.js';

const execFileP = promisify(execFile);
const FIND_ENV: NodeJS.ProcessEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C' };

export class WipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WipeError';
  }
}

/** Paths (relative to home) that survive a wipe: the dependency caches without the manifest, plus the Arco runtime cache. */
export function keptPaths(rootDir: string): string[] {
  return [...cacheRoots(rootDir), '.arco/cache/runtime'];
}

type KillFn = (pid: number, signal: NodeJS.Signals) => unknown;
type Hooks = { killAllAs?: (uid: number) => Promise<void>; gapMs?: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pidsOfUid(uid: number, procDir: string): Promise<number[]> {
  const out: number[] = [];
  let names: string[];
  try {
    names = await readdir(procDir);
  } catch (e) {
    // Failing open here would report "no process left" for a VM whose /proc we could not even read.
    throw new WipeError(`cannot read ${procDir}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let status: string;
    try {
      status = await readFile(join(procDir, name, 'status'), 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') continue; // exited meanwhile
      throw new WipeError(`cannot read ${procDir}/${name}/status: ${code ?? 'error'}`);
    }
    const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (!ids || !ids.slice(1, 5).some((v) => Number(v) === uid)) continue; // real, effective, saved, fs
    if (/^State:\s+[ZX]/m.test(status)) continue; // a zombie holds nothing and cannot be killed again
    out.push(Number(name));
  }
  return out;
}

/**
 * kill(-1, SIGKILL) as the build user: the kernel signals every process of that uid in one call, so a
 * fork-and-exit chain cannot slip between a /proc scan and per-pid kills. The helper kills itself too; its
 * exit status is meaningless. Only root can switch uid, so this is a no-op on a dev machine.
 */
export async function killAllAs(uid: number): Promise<void> {
  if (process.getuid?.() !== 0) return;
  await new Promise<void>((resolve) => {
    try {
      const c = spawn(process.execPath, ['-e', 'process.kill(-1,"SIGKILL")'], { uid, gid: uid, cwd: '/', stdio: 'ignore', env: {} });
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 2000);
      c.once('error', () => { clearTimeout(t); resolve(); });
      c.once('exit', () => { clearTimeout(t); resolve(); });
    } catch { resolve(); }
  });
}

/**
 * SIGKILLs every process of `uid` (any of real/effective/saved/fs uid) until two consecutive /proc scans,
 * at least 50 ms apart, find none. Each round kills atomically with kill(-1) as that uid, then per pid.
 */
export async function killUserProcesses(
  uid: number,
  timeoutMs = 5000,
  procDir = '/proc',
  kill: KillFn = (pid, sig) => process.kill(pid, sig),
  hooks: Hooks = {},
): Promise<void> {
  if (!Number.isInteger(uid) || uid <= 0) throw new WipeError('refusing to kill processes of uid 0 or an invalid uid');
  const deadline = Date.now() + timeoutMs;
  const gap = hooks.gapMs ?? 50;
  let empty = 0;
  for (;;) {
    const pids = await pidsOfUid(uid, procDir);
    if (pids.length === 0) {
      if (++empty >= 2) return;
      await sleep(gap);
      continue;
    }
    empty = 0;
    if (Date.now() >= deadline) throw new WipeError(`${pids.length} process(es) of uid ${uid} survived SIGKILL`);
    try { await (hooks.killAllAs ?? killAllAs)(uid); } catch { /* the per-pid pass below still runs */ }
    for (const pid of pids) {
      try { kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await sleep(10);
  }
}

/** Parses /proc/sysvipc/{shm,sem,msg}: ids of objects whose owner or creator uid is `uid`. */
async function sysvIds(dir: string, file: string, idCol: string, uid: number): Promise<number[]> {
  let text: string;
  try { text = await readFile(join(dir, file), 'utf8'); } catch { return []; }
  const [head, ...rows] = text.split('\n');
  const cols = (head ?? '').trim().split(/\s+/);
  const id = cols.indexOf(idCol), u = cols.indexOf('uid'), cu = cols.indexOf('cuid');
  if (id < 0 || u < 0) return [];
  const out: number[] = [];
  for (const r of rows) {
    const f = r.trim().split(/\s+/);
    if (f.length < cols.length) continue;
    if (Number(f[u]) === uid || (cu >= 0 && Number(f[cu]) === uid)) out.push(Number(f[id]));
  }
  return out;
}

/** Removes SysV shm/sem/msg objects the build user owns (not files, so step 5 never sees them). */
async function removeSysvIpc(uid: number, dir: string, run: (flag: string, id: number) => Promise<void>): Promise<void> {
  for (const [file, col, flag] of [['shm', 'shmid', '-m'], ['sem', 'semid', '-s'], ['msg', 'msqid', '-q']] as const) {
    for (const id of await sysvIds(dir, file, col, uid)) await run(flag, id);
  }
}

const runIpcrm = async (flag: string, id: number) => {
  await execFileP('ipcrm', [flag, String(id)], { env: FIND_ENV });
};

/** Escapes find's -path glob metacharacters so a path is matched literally. */
const globEscape = (p: string) => p.replace(/[\\*?[]/g, '\\$&');

/** `-path` tests matching `p` itself and (optionally) everything below it. */
function pathTests(p: string, below: boolean): string[] {
  const e = globEscape(p);
  return below ? ['-path', e, '-o', '-path', `${e}/*`] : ['-path', e];
}

/** The argv of step 5. Never run through a shell, never follows symlinks (-P), stays on one filesystem. */
export function findOwnedArgs(
  uid: number,
  findRoot: string,
  home: string,
  tmpDirs: string[],
  kept: string[],
): string[] {
  const below: string[] = ['/proc', '/sys', ...kept.map((k) => join(home, k))];
  const exact = new Set<string>([findRoot, ...tmpDirs]);
  for (const k of kept) {
    // Every ancestor of a kept path up to home must survive (they hold the kept paths).
    for (let d = posix.dirname(k); d !== '.' && d !== '/'; d = posix.dirname(d)) exact.add(join(home, d));
  }
  exact.add(home);
  const tests: string[][] = [...below.map((p) => pathTests(p, true)), ...[...exact].map((p) => pathTests(p, false))];
  const expr: string[] = [];
  tests.forEach((t, i) => { if (i > 0) expr.push('-o'); expr.push(...t); });
  return ['-P', findRoot, '-xdev', '-uid', String(uid), '!', '(', ...expr, ')', '-delete'];
}

/** Runs find; a stderr made only of "No such file or directory" (something vanished meanwhile) is tolerated. */
export async function runFind(args: string[]): Promise<string> {
  try {
    return (await execFileP('find', args, { env: FIND_ENV, encoding: 'utf8', maxBuffer: 1 << 20 })).stdout;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    const lines = (err.stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every((l) => l.endsWith(': No such file or directory'))) return err.stdout ?? '';
    throw new WipeError(`find failed: ${(lines[0] ?? err.message).slice(0, 300)}`);
  }
}

/** Makes sure every directory from `home` down to `home/rel` is a real directory; the first impostor is unlinked itself. */
async function realChain(home: string, rel: string): Promise<boolean> {
  let cur = home;
  for (const seg of rel.split('/')) {
    cur = join(cur, seg);
    let st;
    try { st = await lstat(cur); } catch { return false; }
    if (!st.isDirectory()) { await removeTree(cur); return false; }
  }
  return true;
}

async function emptyDir(dir: string): Promise<void> {
  let names: string[];
  try { names = await readdir(dir); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  for (const n of names) await removeTree(join(dir, n));
}

/** Step 6: kept paths hold nothing root-owned and nothing setuid/setgid (both would run as root or escalate in a later build). */
async function checkKept(home: string, kept: string[]): Promise<void> {
  for (const k of kept) {
    const abs = join(home, k);
    try { await lstat(abs); } catch { continue; }
    const stdout = await runFind(['-P', abs, '-xdev', '(', '-uid', '0', '-o', '-perm', '-4000', '-o', '-perm', '-2000', ')', '-print']);
    const first = stdout.split('\n')[0];
    if (first) throw new WipeError(`kept path holds a root-owned or setuid/setgid file: ${relative(home, first)}`);
  }
}

export interface WipeOptions {
  /** The build user's uid; steps 1 and 5 run only when set. */
  uid?: number;
  /** Where step 5 searches; defaults to `/`. */
  findRoot?: string;
  /** Total time for step 1 (default 5000). */
  killTimeoutMs?: number;
  /** Other uid-owned state outside `-xdev` reach (R12); defaults to /dev/mqueue, /run/lock, /run/user. */
  extraRoots?: string[];
  /** Tests only. */
  procDir?: string;
  kill?: KillFn;
  killAllAs?: (uid: number) => Promise<void>;
  sysvDir?: string;
  ipcrm?: (flag: string, id: number) => Promise<void>;
}

/** Spec §6.6, steps 1-6 in order. Any failure is a WipeError (the caller marks the VM dirty). */
export async function wipe(paths: Paths, rootDir: string, o: WipeOptions = {}): Promise<void> {
  try {
    const home = paths.home;
    const kept = sanitizeKeep(keptPaths(rootDir));
    const repoRel = relative(home, paths.repo).split(sep).join('/');
    if (!repoRel || repoRel.startsWith('..')) throw new WipeError('repo is not inside home');

    // 1. no build process survives
    if (o.uid !== undefined) await killUserProcesses(o.uid, o.killTimeoutMs ?? 5000, o.procDir, o.kill, o.killAllAs ? { killAllAs: o.killAllAs } : {});

    const homeExists = await lstat(home).then(() => true, () => false);
    if (homeExists && !(await isRealDir(home))) throw new WipeError('home is not a real directory');
    if (homeExists) {
      // 2. repo: only the kept dependency dirs stay (lstat the whole chain first: `work` may be a planted link)
      if (await realChain(home, repoRel)) {
        const under = kept.filter((k) => k.startsWith(`${repoRel}/`)).map((k) => k.slice(repoRel.length + 1));
        await wipeExcept(paths.repo, under);
      }
      // 3. home: only the repo (as left by step 2) and the kept caches stay
      await wipeExcept(home, sanitizeKeep([repoRel, ...kept.filter((k) => !k.startsWith(`${repoRel}/`))]));
    }

    // 4. scratch dirs
    for (const d of paths.tmpDirs) await emptyDir(d);

    // 5. whatever else the build user owns
    if (o.uid !== undefined) {
      await runFind(findOwnedArgs(o.uid, o.findRoot ?? '/', home, paths.tmpDirs, kept));
      // R12: uid state that -xdev or "not a file" hides from the find above
      await removeSysvIpc(o.uid, o.sysvDir ?? '/proc/sysvipc', o.ipcrm ?? runIpcrm);
      for (const root of o.extraRoots ?? ['/dev/mqueue', '/run/lock', '/run/user']) {
        if (await isRealDir(root)) await runFind(findOwnedArgs(o.uid, root, home, paths.tmpDirs, kept));
      }
    }

    // 6. kept paths are clean
    await checkKept(home, kept);
  } catch (e) {
    if (e instanceof WipeError) throw e;
    const err = e as NodeJS.ErrnoException;
    throw new WipeError(`wipe failed: ${err.code ?? err.name}: ${err.message}`);
  }
}
