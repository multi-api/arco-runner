import { existsSync } from 'node:fs';
import { lchown, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runCommand } from '@multiapi/arco-cloud-client';
import { ensureRealDir, sanitizeKeep, wipeExcept } from '../fsutil.js';
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
  /** Allows a `file://` clone_url; only tests and offline validation set it. */
  allowFileUrl?: boolean;
  /** Allows an `http://` clone_url; set by `ARCO_RUNNER_ALLOW_HTTP=1` (integration tests only, like an http api_base). */
  allowHttpUrl?: boolean;
}

export async function checkout(doc: JobDocument, ctx: CheckoutContext): Promise<{ hasSubmodules: boolean }> {
  const { paths, identity } = ctx;
  const url = doc.source.clone_url;
  const allowed = url.startsWith('https://') || (ctx.allowFileUrl && url.startsWith('file://'))
    || (ctx.allowHttpUrl && url.startsWith('http://'));
  if (!allowed) {
    throw new BuildFailure('build.clone_failed', 'clone_url must use https');
  }
  const keep = sanitizeKeep(ctx.keep);
  for (const d of new Set([paths.home, dirname(paths.repo), paths.repo])) await ensureRealDir(d);
  await wipeExcept(paths.repo, keep);

  const emptyHome = await mkdtemp(join(paths.tmpDirs[0]!, 'arco-git-home-'));
  try {
    if (identity) {
      await lchown(emptyHome, identity.uid, identity.gid);
      await lchown(paths.repo, identity.uid, identity.gid);
    }
    // Minimal base: customer env (GIT_CONFIG_PARAMETERS, GIT_SSH_COMMAND, GIT_EXEC_PATH...) never reaches git.
    const base: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'LANG', 'TMPDIR']) if (ctx.env[k] !== undefined) base[k] = ctx.env[k];
    const env = gitEnv(base, doc.source.auth_header, emptyHome);
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
    await git('fetch', ['--depth=1', '--no-tags', '--', url, doc.source.sha]);
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
