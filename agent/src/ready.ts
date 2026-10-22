import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { buildEnv, type Identity, type Paths } from './system.js';

const execFileP = promisify(execFile);

const TOOLS: Array<[string, string[]]> = [
  ['php', ['-v']], ['composer', ['--version']], ['node', ['--version']], ['git', ['--version']], ['zstd', ['--version']],
];

/** Whether `id` could write to a path with this owner and mode (root aside). */
export function writableBy(st: { uid: number; gid: number; mode: number }, id: Identity): boolean {
  if (st.uid === id.uid) return (st.mode & 0o200) !== 0;
  if (st.gid === id.gid) return (st.mode & 0o020) !== 0;
  return (st.mode & 0o002) !== 0;
}

/**
 * Spec §9.2: the toolchain runs as `build` and the agent bundle is not writable by it. No network, no randomness,
 * no files. Resolves with the first problem, or null.
 */
export async function selfCheck(paths: Paths, identity: Identity | null): Promise<string | null> {
  try {
    if (identity) {
      const passwd = await readFile('/etc/passwd', 'utf8').catch(() => '');
      if (!passwd.split('\n').some((l) => l.split(':')[0] === 'build' && l.split(':')[2] === String(identity.uid))) {
        return `user build (uid ${identity.uid}) does not exist`;
      }
    }
    const env = buildEnv(paths, {});
    for (const [cmd, args] of TOOLS) {
      try {
        await execFileP(cmd, args, { env, timeout: 10_000, ...(identity ? { uid: identity.uid, gid: identity.gid } : {}) });
      } catch (e) {
        return `${cmd} ${args[0]} failed${(e as { code?: unknown }).code !== undefined ? ` (${String((e as { code?: unknown }).code)})` : ''}`;
      }
    }
    if (identity) {
      const st = await stat(paths.agentDir);
      if (writableBy(st, identity)) return `${paths.agentDir} is writable by the build user`;
    }
    return null;
  } catch (e) {
    return `self-check error: ${(e as Error).message}`;
  }
}
