import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { revokeGithubToken } from '../src/job/source.js';
import { buildEnv, cutLine, defaultPaths, resolveProjectDir } from '../src/system.js';

describe('buildEnv', () => {
  it('keeps PATH/HOME/USER, lets the job override the rest, and inherits nothing', () => {
    process.env.LEAK_CHECK = '1';
    const env = buildEnv(defaultPaths(), { PATH: 'x', HOME: '/root', USER: 'root', FOO: 'bar', CI: 'false' });
    delete process.env.LEAK_CHECK;
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(env.HOME).toBe('/home/build');
    expect(env.USER).toBe('build');
    expect(env.FOO).toBe('bar');
    expect(env.CI).toBe('false');
    expect(env.COMPOSER_CACHE_DIR).toBe('/home/build/.cache/composer');
    expect(env.LEAK_CHECK).toBeUndefined();
  });
});

describe('cutLine', () => {
  it('leaves short lines alone and cuts long ones within the limit', () => {
    expect(cutLine('hello')).toBe('hello');
    const cut = cutLine('a'.repeat(20000));
    expect(cut.endsWith(' …[truncated]')).toBe(true);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(16384 + 14);
  });
  it('never splits a multibyte character', () => {
    const cut = cutLine('é'.repeat(20000));
    expect(cut).not.toContain('�');
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(16384);
  });
});

describe('resolveProjectDir', () => {
  const setup = async () => {
    const repo = await mkdtemp(join(tmpdir(), 'arco-rd-'));
    await mkdir(join(repo, 'app'));
    return repo;
  };
  it('resolves inside the repo', async () => {
    const repo = await setup();
    expect(await resolveProjectDir(repo, 'app')).toBe(join(await import('node:fs/promises').then((m) => m.realpath(repo)), 'app'));
    expect(await resolveProjectDir(repo, '')).toBe(await import('node:fs/promises').then((m) => m.realpath(repo)));
  });
  it('refuses .. segments, symlink escapes and missing dirs', async () => {
    const repo = await setup();
    await symlink('/etc', join(repo, 'link'));
    for (const bad of ['../x', 'app/../../x', 'link', 'nope', '/etc', '.git', 'app/.git/x']) {
      await expect(resolveProjectDir(repo, bad)).rejects.toMatchObject({ code: 'build.invalid_root_dir' });
    }
  });
});

describe('revokeGithubToken', () => {
  const auth = 'basic ' + btoa('x-access-token:ghs_abc123');
  it('revokes only for github.com', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    await revokeGithubToken('https://github.com/o/r.git', auth, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/installation/token');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).Authorization).toBe('token ghs_abc123');
    await revokeGithubToken('https://gitlab.com/o/r.git', auth, f as unknown as typeof fetch);
    await revokeGithubToken('https://github.com.evil.test/o/r.git', auth, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('swallows errors', async () => {
    const f = vi.fn(async () => { throw new Error('boom'); });
    await expect(revokeGithubToken('https://github.com/o/r.git', auth, f as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});
