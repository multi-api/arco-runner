import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const isRealDir = async (p: string): Promise<boolean> => {
  try { return (await lstat(p)).isDirectory(); } catch { return false; }
};

/**
 * Removes `p` itself (a link is unlinked, never followed). A tree nested deeper than PATH_MAX defeats
 * fs.rm (ENAMETOOLONG); `rm -rf` walks with directory fds, so it is the fallback (argv, no shell).
 */
export async function removeTree(p: string): Promise<void> {
  try {
    await rm(p, { recursive: true, force: true });
  } catch {
    await execFileP('rm', ['-rf', '--', p], { env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
  }
}

/** Makes `p` a real directory: a planted symlink or file is removed itself (never followed). */
export async function ensureRealDir(p: string): Promise<void> {
  try {
    if (!(await lstat(p)).isDirectory()) await rm(p, { force: true });
  } catch { /* missing */ }
  await mkdir(p, { recursive: true });
}

/** Keep paths must be relative, free of `..` and `.git` segments, so the old .git can never survive. */
export function sanitizeKeep(keep: string[]): string[] {
  const out: string[] = [];
  for (const k of keep) {
    const n = posix.normalize(k).replace(/\/+$/, '');
    if (!n || n === '.' || isAbsolute(n)) continue;
    const segs = n.split('/');
    if (segs.includes('..') || segs.includes('.git')) continue;
    out.push(n);
  }
  return out;
}

/**
 * Deletes everything under `dir` except the `keep` paths (relative to the wipe root) and their parents.
 * Every entry is lstat'ed: only real directories are recursed into or kept; symlinks and files that sit
 * where a kept directory (or its ancestor) should be are removed themselves, never followed.
 */
export async function wipeExcept(dir: string, keep: string[], prefix = ''): Promise<void> {
  for (const name of await readdir(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const full = join(dir, name);
    const real = await isRealDir(full);
    if (real && keep.includes(rel)) continue;
    if (real && keep.some((k) => k.startsWith(`${rel}/`))) {
      await wipeExcept(full, keep, rel);
      continue;
    }
    await removeTree(full);
  }
}

/** Reads a regular file without following a symlink in its last component; null if absent or not a plain file. */
export async function readPlainFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let fh;
  try {
    // O_NONBLOCK so that a planted FIFO cannot hang the agent; O_NOFOLLOW so a planted link is never read.
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    return await fh.readFile();
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}
