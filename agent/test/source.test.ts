import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from '@multi-api/arco-cloud-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseJobDocument } from '../src/job/document.js';
import { checkout } from '../src/job/source.js';
import type { Paths } from '../src/system.js';

vi.mock('@multi-api/arco-cloud-client', async (orig) => {
  const mod = await orig<typeof import('@multi-api/arco-cloud-client')>();
  return { ...mod, runCommand: vi.fn(mod.runCommand) };
});

const AUTH = 'basic ' + btoa('x-access-token:ghs_secrettoken');
const gitSync = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'arco-src-'));
  const origin = join(root, 'origin');
  await mkdir(origin);
  gitSync(origin, 'init', '-q');
  await writeFile(join(origin, 'composer.json'), '{}');
  gitSync(origin, 'add', '.');
  gitSync(origin, 'commit', '-q', '-m', 'init');
  const sha = gitSync(origin, 'rev-parse', 'HEAD');
  const paths: Paths = {
    home: join(root, 'home'), repo: join(root, 'home/work/repo'), tmpDirs: [join(root, 'tmp')],
    agentDir: join(root, 'agent'), varDir: join(root, 'var'),
  };
  await mkdir(paths.tmpDirs[0]!);
  await mkdir(paths.repo, { recursive: true });
  const doc = parseJobDocument({
    deployment_id: 'd1', environment: 'production', mode: 'deploy', nonce: 'n', runner_token: 't',
    source: { clone_url: `file://${origin}`, auth_header: AUTH, sha, root_dir: null },
    php_version: '8.5', commands: [], env: {}, mask: [],
    cache: { restore_url: 'https://s3/r', save_url: 'https://s3/s', key: 'k' }, timeout_seconds: 60,
  });
  const ctx = (keep: string[] = [], env: NodeJS.ProcessEnv = { PATH: process.env.PATH }) => ({
    paths, identity: null, env, onLine: () => {},
    signal: new AbortController().signal, keep, extraGitArgs: ['-c', 'protocol.file.allow=always'], allowFileUrl: true,
  });
  return { paths, doc, ctx, root };
}

afterEach(() => vi.mocked(client.runCommand).mockClear());

describe('checkout', () => {
  it('checks out the commit with a fresh .git, ignoring planted hooks and config', async () => {
    const { paths, doc, ctx } = await fixture();
    const marker = join(paths.repo, 'hook-ran');
    await mkdir(join(paths.repo, '.git/hooks'), { recursive: true });
    await writeFile(join(paths.repo, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    await writeFile(join(paths.repo, '.git/config'), '[url "http://evil/"]\n\tinsteadOf = file://\n');
    await mkdir(join(paths.repo, 'vendor'));
    await writeFile(join(paths.repo, 'vendor/keep.txt'), 'k');
    await mkdir(join(paths.repo, 'src'));
    await writeFile(join(paths.repo, 'src/old.php'), 'old');

    const res = await checkout(doc, ctx(['vendor']));

    expect(res.hasSubmodules).toBe(false);
    expect(await readFile(join(paths.repo, 'composer.json'), 'utf8')).toBe('{}');
    expect(existsSync(marker)).toBe(false);
    expect(await readFile(join(paths.repo, '.git/config'), 'utf8')).not.toContain('evil');
    expect(existsSync(join(paths.repo, 'vendor/keep.txt'))).toBe(true);
    expect(existsSync(join(paths.repo, 'src/old.php'))).toBe(false);
  });

  it('keeps nested keep paths and wipes their siblings', async () => {
    const { paths, doc, ctx } = await fixture();
    await mkdir(join(paths.repo, 'app/vendor'), { recursive: true });
    await writeFile(join(paths.repo, 'app/vendor/x'), 'x');
    await writeFile(join(paths.repo, 'app/other'), 'o');
    await checkout(doc, ctx(['app/vendor']));
    expect(existsSync(join(paths.repo, 'app/vendor/x'))).toBe(true);
    expect(existsSync(join(paths.repo, 'app/other'))).toBe(false);
  });

  it('never puts the credential in argv; passes it through the environment', async () => {
    const { doc, ctx } = await fixture();
    await checkout(doc, ctx());
    const calls = vi.mocked(client.runCommand).mock.calls;
    expect(calls.map((c) => c[1].find((a) => ['init', 'fetch', 'checkout'].includes(a)))).toEqual(['init', 'fetch', 'checkout']);
    for (const [file, args, opts] of calls) {
      const argv = [file, ...args].join(' ');
      expect(argv).not.toContain('ghs_secrettoken');
      expect(argv).not.toContain(AUTH);
      expect(opts.env!.GIT_CONFIG_VALUE_0).toBe(`Authorization: ${AUTH}`);
      expect(opts.env!.GIT_TERMINAL_PROMPT).toBe('0');
    }
  });

  it('reports a failed fetch as build.clone_failed', async () => {
    const { doc, ctx } = await fixture();
    const bad = { ...doc, source: { ...doc.source, sha: 'f'.repeat(40) } };
    await expect(checkout(bad, ctx())).rejects.toMatchObject({
      code: 'build.clone_failed', message: expect.stringMatching(/^git fetch exited with code \d+$/),
    });
  });

  it('removes a symlinked repo dir without touching its target', async () => {
    const { paths, doc, ctx, root } = await fixture();
    const target = join(root, 'target');
    await mkdir(target);
    await writeFile(join(target, 'precious'), 'p');
    await rm(paths.repo, { recursive: true });
    await symlink(target, paths.repo);
    await checkout(doc, ctx());
    expect(await readdir(target)).toEqual(['precious']);
    expect(existsSync(join(paths.repo, 'composer.json'))).toBe(true);
  });

  it('removes a symlinked work dir without touching its target', async () => {
    const { paths, doc, ctx, root } = await fixture();
    const target = join(root, 'target');
    await mkdir(join(target, 'repo'), { recursive: true });
    await writeFile(join(target, 'repo/precious'), 'p');
    await rm(join(paths.home, 'work'), { recursive: true });
    await symlink(target, join(paths.home, 'work'));
    await checkout(doc, ctx());
    expect(await readdir(join(target, 'repo'))).toEqual(['precious']);
    expect(existsSync(join(paths.repo, 'composer.json'))).toBe(true);
  });

  it('removes a symlinked ancestor of a nested keep, and symlinked/file keeps', async () => {
    const { paths, doc, ctx, root } = await fixture();
    const target = join(root, 'target');
    await mkdir(join(target, 'vendor'), { recursive: true });
    await writeFile(join(target, 'vendor/precious'), 'p');
    await symlink(target, join(paths.repo, 'app'));
    await symlink(target, join(paths.repo, 'vendor'));
    await writeFile(join(paths.repo, 'node_modules'), 'file');
    await checkout(doc, ctx(['app/vendor', 'vendor', 'node_modules']));
    expect(await readFile(join(target, 'vendor/precious'), 'utf8')).toBe('p');
    for (const n of ['app', 'vendor', 'node_modules']) expect(existsSync(join(paths.repo, n))).toBe(false);
  });

  it('never keeps anything inside .git or outside the repo', async () => {
    const { paths, doc, ctx } = await fixture();
    await mkdir(join(paths.repo, '.git/vendor'), { recursive: true });
    await writeFile(join(paths.repo, '.git/vendor/x'), 'x');
    await writeFile(join(paths.repo, 'sibling'), 's');
    await checkout(doc, ctx(['.git/vendor', '../x', '/etc', 'a/../sibling']));
    expect(existsSync(join(paths.repo, '.git/vendor'))).toBe(false);
    expect(existsSync(join(paths.repo, 'sibling'))).toBe(false);
  });

  it('keeps customer git env out of git and puts -- before the URL', async () => {
    const { doc, ctx } = await fixture();
    await checkout(doc, ctx([], { PATH: process.env.PATH, GIT_CONFIG_PARAMETERS: "'x.y=z'", GIT_SSH_COMMAND: 'evil' }));
    for (const [, args, opts] of vi.mocked(client.runCommand).mock.calls) {
      expect(opts.env!.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(opts.env!.GIT_SSH_COMMAND).toBeUndefined();
      if (args.includes('fetch')) expect(args[args.indexOf('fetch') + 3]).toBe('--');
    }
  });

  it('rejects non-https clone URLs unless file URLs are allowed', async () => {
    const { doc, ctx } = await fixture();
    await expect(checkout(doc, { ...ctx(), allowFileUrl: false })).rejects.toMatchObject({ code: 'build.clone_failed' });
    const ssh = { ...doc, source: { ...doc.source, clone_url: '--upload-pack=x' } };
    await expect(checkout(ssh, ctx())).rejects.toMatchObject({ code: 'build.clone_failed' });
  });
});
