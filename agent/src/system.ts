import { realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { BuildFailure } from './job/errors.js';

export interface Paths { home: string; repo: string; tmpDirs: string[]; agentDir: string; varDir: string }

export const defaultPaths = (): Paths => ({
  home: '/home/build',
  repo: '/home/build/work/repo',
  tmpDirs: ['/tmp', '/var/tmp', '/dev/shm'],
  agentDir: '/opt/arco-runner',
  varDir: '/var/tmp/arco-runner',
});

export interface Identity { uid: number; gid: number }

/** The unprivileged identity customer code runs as; null when the agent itself is unprivileged (dev machines). */
export function buildIdentity(): Identity | null {
  return process.getuid?.() === 0 ? { uid: 1000, gid: 1000 } : null;
}

const PROTECTED_ENV = new Set(['PATH', 'HOME', 'USER']);

/** The build environment (spec §6.5). Nothing is inherited from the agent's own environment. */
export function buildEnv(paths: Paths, jobEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: paths.home,
    USER: 'build',
    LANG: 'C.UTF-8',
    CI: 'true',
    ARCO_RUNNER: '1',
    COMPOSER_HOME: `${paths.home}/.config/composer`,
    COMPOSER_CACHE_DIR: `${paths.home}/.cache/composer`,
    npm_config_cache: `${paths.home}/.npm`,
    COMPOSER_NO_INTERACTION: '1',
    TMPDIR: '/tmp',
  };
  for (const [k, v] of Object.entries(jobEnv)) if (!PROTECTED_ENV.has(k)) env[k] = v;
  return env;
}

const MAX_LINE_BYTES = 16_384;
const MARKER = ' …[truncated]';

/** Cuts a line so that, marker included, it is at most 16 384 bytes (never splits a UTF-8 character). */
export function cutLine(line: string): string {
  if (Buffer.byteLength(line) <= MAX_LINE_BYTES) return line;
  const buf = Buffer.from(line);
  let end = MAX_LINE_BYTES - Buffer.byteLength(MARKER);
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8') + MARKER;
}

/** Resolves `root_dir` inside the checkout; refuses `..` segments and symlink escapes. */
export async function resolveProjectDir(repo: string, rootDir: string): Promise<string> {
  const invalid = (why: string) => new BuildFailure('build.invalid_root_dir', `root_dir ${why}`);
  if (rootDir.split(/[\\/]/).includes('..')) throw invalid('must not contain ".."');
  if (rootDir.split(/[\\/]/).includes('.git')) throw invalid('must not contain ".git"');
  if (isAbsolute(rootDir)) throw invalid('must be relative to the repository');
  try {
    const realRepo = await realpath(repo);
    const resolved = await realpath(join(realRepo, rootDir));
    if (resolved !== realRepo && !resolved.startsWith(realRepo + sep)) throw invalid('resolves outside the repository');
    return resolved;
  } catch (e) {
    if (e instanceof BuildFailure) throw e;
    throw invalid('does not exist in the repository');
  }
}
