import { existsSync } from 'node:fs';
import { chown, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { runCommand } from '@multi-api/arco-cloud-client';
import { cloneToken } from '../mask.js';
import { type Identity, type Paths } from '../system.js';
import type { JobDocument } from './document.js';
import { BuildFailure } from './errors.js';

export const GIT_HARDENING: string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'protocol.file.allow=never',
  '-c', 'credential.helper=',
  '-c', 'core.fsmonitor=false',
];

/** The credential travels in git's environment only: never in argv, `.git/config` or the URL. */
export function gitEnv(base: NodeJS.ProcessEnv, authHeader: string, emptyHome: string): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: ${authHeader}`,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: emptyHome,
  };
}

export interface CheckoutContext {
  paths: Paths;
  identity: Identity | null;
  env: NodeJS.ProcessEnv;
  onLine: (l: string) => void;
  signal: AbortSignal;
  keep: string[];
  /** Inserted after GIT_HARDENING; only tests and offline validation use it (e.g. `-c protocol.file.allow=always`). */
  extraGitArgs?: string[];
}

/** Deletes everything under `dir` except the `keep` paths (relative to the root of the wipe) and their parents. */
async function wipeExcept(dir: string, keep: string[], prefix = ''): Promise<void> {
  for (const name of await readdir(dir)) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (keep.includes(rel)) continue;
    if (keep.some((k) => k.startsWith(`${rel}/`))) {
      await wipeExcept(join(dir, name), keep, rel);
      continue;
    }
    await rm(join(dir, name), { recursive: true, force: true });
  }
}

export async function checkout(doc: JobDocument, ctx: CheckoutContext): Promise<{ hasSubmodules: boolean }> {
  const { paths, identity } = ctx;
  const keep = ctx.keep.map((k) => posix.normalize(k).replace(/\/+$/, ''));
  await mkdir(paths.repo, { recursive: true });
  await wipeExcept(paths.repo, keep);

  const emptyHome = await mkdtemp(join(paths.tmpDirs[0]!, 'arco-git-home-'));
  try {
    if (identity) {
      await chown(emptyHome, identity.uid, identity.gid);
      await chown(paths.repo, identity.uid, identity.gid);
    }
    const env = gitEnv(ctx.env, doc.source.auth_header, emptyHome);
    const git = async (sub: string, args: string[]): Promise<void> => {
      const { exitCode } = await runCommand('git', [...GIT_HARDENING, ...(ctx.extraGitArgs ?? []), sub, ...args], {
        cwd: paths.repo,
        env,
        onStdoutLine: ctx.onLine,
        onStderrLine: ctx.onLine,
        signal: ctx.signal,
        ...(identity ? { uid: identity.uid, gid: identity.gid } : {}),
      });
      if (exitCode !== 0) throw new BuildFailure('build.clone_failed', `git ${sub} exited with code ${exitCode}`);
    };
    await git('init', ['-q']);
    await git('fetch', ['--depth=1', '--no-tags', doc.source.clone_url, doc.source.sha]);
    await git('checkout', ['-q', '--force', 'FETCH_HEAD']);
  } finally {
    await rm(emptyHome, { recursive: true, force: true });
  }
  return { hasSubmodules: existsSync(join(paths.repo, '.gitmodules')) };
}

/** Best effort: the installation token is single-purpose, so revoke it as soon as the checkout is done. */
export async function revokeGithubToken(
  cloneUrl: string,
  authHeader: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    if (new URL(cloneUrl).hostname !== 'github.com') return;
    const token = cloneToken(authHeader);
    if (!token) return;
    await fetchImpl('https://api.github.com/installation/token', {
      method: 'DELETE',
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // best effort
  }
}
