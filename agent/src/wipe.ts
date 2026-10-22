import { execFile } from 'node:child_process';
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

async function pidsOfUid(uid: number, procDir: string): Promise<number[]> {
  const out: number[] = [];
  let names: string[];
  try { names = await readdir(procDir); } catch { return out; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let status: string;
    try { status = await readFile(join(procDir, name, 'status'), 'utf8'); } catch { continue; } // exited meanwhile
    const real = /^Uid:\s+(\d+)/m.exec(status);
    if (!real || Number(real[1]) !== uid) continue;
    if (/^State:\s+[ZX]/m.test(status)) continue; // a zombie holds nothing and cannot be killed again
    out.push(Number(name));
  }
  return out;
}

/** SIGKILLs every process whose real uid is `uid`, again and again (a fork can outrun one pass), until none is left. */
export async function killUserProcesses(
  uid: number,
  timeoutMs = 5000,
  procDir = '/proc',
  kill: KillFn = (pid, sig) => process.kill(pid, sig),
): Promise<void> {
  if (!Number.isInteger(uid) || uid <= 0) throw new WipeError('refusing to kill processes of uid 0 or an invalid uid');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = await pidsOfUid(uid, procDir);
    if (pids.length === 0) return;
    if (Date.now() >= deadline) throw new WipeError(`${pids.length} process(es) of uid ${uid} survived SIGKILL`);
    for (const pid of pids) {
      try { kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

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
    const { stdout } = await execFileP(
      'find',
      ['-P', abs, '-xdev', '(', '-uid', '0', '-o', '-perm', '-4000', '-o', '-perm', '-2000', ')', '-print'],
      { env: FIND_ENV, encoding: 'utf8', maxBuffer: 1 << 20 },
    );
    const first = stdout.split('\n')[0];
    if (first) throw new WipeError(`kept path holds a root-owned or setuid/setgid file: ${relative(home, first)}`);
  }
}

export interface WipeOptions {
  /** The build user's uid; steps 1 and 5 run only when set. */
  uid?: number;
  /** Where step 5 searches; defaults to `/`. */
  findRoot?: string;
  /** Tests only. */
  procDir?: string;
  kill?: KillFn;
}

/** Spec §6.6, steps 1-6 in order. Any failure is a WipeError (the caller marks the VM dirty). */
export async function wipe(paths: Paths, rootDir: string, o: WipeOptions = {}): Promise<void> {
  try {
    const home = paths.home;
    const kept = sanitizeKeep(keptPaths(rootDir));
    const repoRel = relative(home, paths.repo).split(sep).join('/');
    if (!repoRel || repoRel.startsWith('..')) throw new WipeError('repo is not inside home');

    // 1. no build process survives
    if (o.uid !== undefined) await killUserProcesses(o.uid, 5000, o.procDir, o.kill);

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
      const args = findOwnedArgs(o.uid, o.findRoot ?? '/', home, paths.tmpDirs, kept);
      try {
        await execFileP('find', args, { env: FIND_ENV, encoding: 'utf8', maxBuffer: 1 << 20 });
      } catch (e) {
        const err = e as { stderr?: string; message: string };
        throw new WipeError(`find -uid ${o.uid} failed: ${(err.stderr || err.message).trim().split('\n')[0]}`);
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
