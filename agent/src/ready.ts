import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ServicePaths } from './services/catalog.js';
import { pidsOfUid } from './wipe.js';
import { buildEnv, type Identity, type Paths } from './system.js';

const execFileP = promisify(execFile);

const TOOLS: Array<[string, string[]]> = [
  ['php', ['-v']], ['composer', ['--version']], ['node', ['--version']], ['git', ['--version']], ['zstd', ['--version']],
];

const SERVICE_BINARIES = ['mysqld', 'postgres', 'redis-server'];

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
export async function selfCheck(
  paths: Paths,
  identity: Identity | null,
  services?: { paths: ServicePaths; uids: number[]; procDir?: string },
  tools: Array<[string, string[]]> = TOOLS, // tests only
): Promise<string | null> {
  try {
    if (identity) {
      const passwd = await readFile('/etc/passwd', 'utf8').catch(() => '');
      if (!passwd.split('\n').some((l) => l.split(':')[0] === 'build' && l.split(':')[2] === String(identity.uid))) {
        return `user build (uid ${identity.uid}) does not exist`;
      }
    }
    const env = buildEnv(paths, {});
    for (const [cmd, args] of tools) {
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
    if (services) {
      for (const bin of SERVICE_BINARIES) {
        try {
          await execFileP(`${services.paths.binDir}/${bin}`, ['--version'], { env, timeout: 10_000 });
        } catch (e) {
          return `${bin} --version failed${(e as { code?: unknown }).code !== undefined ? ` (${String((e as { code?: unknown }).code)})` : ''}`;
        }
      }
      for (const uid of services.uids) {
        if ((await pidsOfUid(uid, services.procDir ?? '/proc')).length > 0) return `a process of service uid ${uid} is running`;
      }
      const left = await readdir(services.paths.dataDir).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : Promise.reject(e)));
      if (left.length > 0) return `service data exists in ${services.paths.dataDir}`;
    }
    return null;
  } catch (e) {
    return `self-check error: ${(e as Error).message}`;
  }
}
