import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CacheCtx, type CacheManifest, CacheError, UnsafeArchive, cacheRoots, checkArchiveEntries, lockHashes,
  restoreCache, saveCache, shouldSave,
} from '../src/job/cache.js';
import type { Paths } from '../src/system.js';

const has = (cmd: string, arg = '--version') => spawnSync(cmd, [arg], { encoding: 'utf8' });
const gnuTar = /GNU tar/.test(has('tar').stdout ?? '');
const zstd = has('zstd').status === 0;
const tools = gnuTar && zstd;
if (!tools) console.warn('cache tests needing GNU tar and zstd are skipped here; run `npm run test:linux`');
const itTar = it.skipIf(!tools);

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

/** A local stand-in for S3: GET/PUT of one object at /obj. */
async function s3() {
  const state = { body: null as Buffer | null, puts: 0, putLength: '' };
  const server = createServer((req, res) => {
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      state.putLength = String(req.headers['content-length']);
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { state.body = Buffer.concat(chunks); state.puts++; res.writeHead(200).end(); });
    } else if (state.body) {
      res.writeHead(200, { 'content-length': state.body.length }).end(state.body);
    } else {
      res.writeHead(404).end();
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/obj`;
  return { url, state };
}

async function env() {
  const root = await mkdtemp(join(tmpdir(), 'arco-cache-'));
  const mk = (n: string): Paths => ({
    home: join(root, n, 'home'), repo: join(root, n, 'home/work/repo'), tmpDirs: [join(root, 'tmp')],
    agentDir: join(root, 'agent'), varDir: join(root, n, 'var'),
  });
  const a = mk('a');
  const b = mk('b');
  for (const p of [a, b]) { await mkdir(p.repo, { recursive: true }); await mkdir(p.varDir, { recursive: true }); }
  const ctx = (paths: Paths, extra: Partial<CacheCtx> = {}): CacheCtx => ({ paths, identity: null, rootDir: '', ...extra });
  return { root, a, b, ctx };
}

const manifest: CacheManifest = {
  version: 1, key: 'k1', lock: { composer: 'aa', npm: null, yarn: null, pnpm: 'bb' }, created_at: '2026-10-22T00:00:00Z',
};

describe('cacheRoots', () => {
  it('lists the global roots and adds the root_dir ones', () => {
    expect(cacheRoots('')).toEqual([
      'work/repo/vendor', 'work/repo/node_modules', '.cache/composer', '.npm',
    ]);
    expect(cacheRoots('app')).toEqual([
      'work/repo/vendor', 'work/repo/node_modules', 'work/repo/app/vendor', 'work/repo/app/node_modules',
      '.cache/composer', '.npm',
    ]);
  });
});

describe('shouldSave', () => {
  const locks = { composer: 'a', npm: 'b', yarn: null, pnpm: null };
  it('saves when nothing is known or any lock differs, else not', () => {
    expect(shouldSave(locks, null)).toBe(true);
    expect(shouldSave({ ...locks, composer: 'z' }, { ...manifest, lock: locks })).toBe(true);
    expect(shouldSave({ ...locks, yarn: 'y' }, { ...manifest, lock: locks })).toBe(true);
    expect(shouldSave(locks, { ...manifest, lock: { ...locks } })).toBe(false);
  });
});

describe('lockHashes', () => {
  it('hashes the lockfiles that exist and never follows a symlinked lockfile', async () => {
    const { root } = await env();
    const dir = join(root, 'proj');
    await mkdir(dir);
    await writeFile(join(dir, 'composer.lock'), 'abc');
    await writeFile(join(root, 'secret'), 'root only');
    await symlink(join(root, 'secret'), join(dir, 'yarn.lock'));
    const l = await lockHashes(dir);
    expect(l.composer).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(l).toMatchObject({ npm: null, yarn: null, pnpm: null });
  });
});

describe('checkArchiveEntries', () => {
  const roots = cacheRoots('');
  const f = (path: string) => ({ path, type: 'file' as const });
  const link = (path: string, target: string) => ({ path, type: 'symlink' as const, target });

  it('accepts files, dirs, the manifest and a symlink that stays inside its root', () => {
    expect(() => checkArchiveEntries([
      { path: 'work/repo/node_modules/', type: 'dir' },
      f('work/repo/node_modules/vite/bin/vite.js'),
      link('work/repo/node_modules/.bin/vite', '../vite/bin/vite.js'),
      f('.npm/_cacache/x'),
      f('.arco-cache.json'),
    ], roots)).not.toThrow();
  });

  it.each([
    ['symlink to an absolute target', [link('work/repo/vendor/x', '/opt/arco-runner')]],
    ['symlink climbing out of the root', [link('work/repo/vendor/x', '../../../../etc')]],
    ['symlink climbing into a sibling root', [link('work/repo/vendor/x', '../node_modules/y')]],
    ['symlink target that descends then climbs (lexical vs physical mismatch)', [link('work/repo/vendor/sub/m', 'l/../..')]],
    ['absolute member', [f('/etc/passwd')]],
    ['dot-dot member', [f('work/repo/vendor/../src/a.php')]],
    ['member outside the roots', [f('work/repo/src/a.php')]],
    ['member next to a root name', [f('work/repo/vendorx/a')]],
    ['other type (device, fifo, hardlink)', [{ path: 'work/repo/vendor/n', type: 'other' as const }]],
    ['manifest that is not a file', [link('.arco-cache.json', 'work/repo/vendor/a')]],
    ['file written through a symlink listed earlier', [
      link('work/repo/vendor/a', '.'), f('work/repo/vendor/a/b'),
    ]],
  ])('refuses %s', (_n, entries) => {
    expect(() => checkArchiveEntries(entries, roots)).toThrow(UnsafeArchive);
  });
});

describe('archive round trip (GNU tar + zstd)', () => {
  async function populate(home: string) {
    await mkdir(join(home, 'work/repo/vendor/pkg'), { recursive: true });
    await writeFile(join(home, 'work/repo/vendor/pkg/a name with spaces.php'), '<?php // a');
    await mkdir(join(home, 'work/repo/node_modules/.bin'), { recursive: true });
    await mkdir(join(home, 'work/repo/node_modules/vite/bin'), { recursive: true });
    await writeFile(join(home, 'work/repo/node_modules/vite/bin/vite.js'), 'v');
    await symlink('../vite/bin/vite.js', join(home, 'work/repo/node_modules/.bin/vite'));
    await mkdir(join(home, '.npm/_cacache'), { recursive: true });
    await writeFile(join(home, '.npm/_cacache/idx'), 'n');
    await writeFile(join(home, 'work/repo/src.php'), 'not cached');
  }

  itTar('saves, then restores the same files and manifest into an empty home', async () => {
    const { a, b, ctx } = await env();
    await populate(a.home);
    const { url, state } = await s3();

    expect(await saveCache(url, manifest, ctx(a), Date.now() + 60_000)).toBe('saved');
    expect(state.puts).toBe(1);
    expect(state.putLength).toBe(String(state.body!.length));
    expect(existsSync(join(a.home, '.arco-cache.json'))).toBe(false);
    expect(await readdir(a.varDir)).toEqual([]);

    const res = await restoreCache(url, ctx(b));
    expect(res).toEqual({ status: 'restored', manifest });
    expect(await readFile(join(b.home, 'work/repo/vendor/pkg/a name with spaces.php'), 'utf8')).toBe('<?php // a');
    expect(await readFile(join(b.home, 'work/repo/node_modules/vite/bin/vite.js'), 'utf8')).toBe('v');
    expect(await readlink(join(b.home, 'work/repo/node_modules/.bin/vite'))).toBe('../vite/bin/vite.js');
    expect(await readFile(join(b.home, '.npm/_cacache/idx'), 'utf8')).toBe('n');
    expect(existsSync(join(b.home, 'work/repo/src.php'))).toBe(false);
    expect(existsSync(join(b.home, '.arco-cache.json'))).toBe(false);
    expect(await readdir(b.varDir)).toEqual([]);
  });

  itTar('stores hardlinked files as plain copies so restore never meets a hardlink', async () => {
    const { a, b, ctx } = await env();
    await populate(a.home);
    execFileSync('ln', [join(a.home, '.npm/_cacache/idx'), join(a.home, '.npm/_cacache/idx2')]);
    const { url } = await s3();
    expect(await saveCache(url, manifest, ctx(a), Date.now() + 60_000)).toBe('saved');
    expect((await restoreCache(url, ctx(b))).status).toBe('restored');
    expect(await readFile(join(b.home, '.npm/_cacache/idx2'), 'utf8')).toBe('n');
  });

  itTar('does not follow a symlinked manifest path or a symlinked root when saving', async () => {
    const { a, root, ctx } = await env();
    await populate(a.home);
    await writeFile(join(root, 'victim'), 'precious');
    await symlink(join(root, 'victim'), join(a.home, '.arco-cache.json'));
    await writeFile(join(root, 'outside'), 'outside-data');
    await symlink(root, join(a.home, '.cache-link'));
    const { url, state } = await s3();
    expect(await saveCache(url, manifest, ctx(a), Date.now() + 60_000)).toBe('saved');
    expect(await readFile(join(root, 'victim'), 'utf8')).toBe('precious');
    const listing = execFileSync('tar', ['--zstd', '-tf', '-'], { input: state.body!, encoding: 'utf8' });
    expect(listing).toContain('.arco-cache.json');
    expect(listing).not.toContain('outside');
  });

  itTar('restore of a 404 is missing', async () => {
    const { a, ctx } = await env();
    const { url } = await s3();
    expect(await restoreCache(url, ctx(a))).toEqual({ status: 'missing', manifest: null });
  });

  itTar('restore of a non-404 failure throws CacheError without leaking the url', async () => {
    const { a, ctx } = await env();
    const fetchImpl = (async () => new Response('no', { status: 500 })) as typeof fetch;
    const err = await restoreCache('https://bucket.s3/obj?X-Amz-Signature=SECRET', ctx(a, { fetchImpl })).catch((e) => e);
    expect(err).toBeInstanceOf(CacheError);
    expect(String(err.message)).not.toContain('SECRET');
  });

  itTar('refuses a tampered archive and extracts nothing', async () => {
    const { root, a, ctx } = await env();
    const src = join(root, 'tamper');
    await mkdir(join(src, 'work/repo/vendor'), { recursive: true });
    await mkdir(join(src, 'work/repo/src'), { recursive: true });
    await writeFile(join(src, 'work/repo/vendor/ok.php'), 'ok');
    await writeFile(join(src, 'work/repo/src/evil.php'), 'evil');
    const tar = execFileSync('tar', ['-C', src, '-I', 'zstd -3', '-cf', '-', 'work/repo/vendor', 'work/repo/src']);
    const { url, state } = await s3();
    state.body = tar;
    await expect(restoreCache(url, ctx(a))).rejects.toBeInstanceOf(UnsafeArchive);
    expect(existsSync(join(a.home, 'work/repo/vendor/ok.php'))).toBe(false);
    expect(existsSync(join(a.home, 'work/repo/src/evil.php'))).toBe(false);
    expect(await readdir(a.varDir)).toEqual([]);
  });

  itTar('refuses an archive holding an escaping symlink, even with spaces and arrows in names', async () => {
    const { root, a, ctx } = await env();
    const src = join(root, 'tamper2');
    await mkdir(join(src, 'work/repo/vendor'), { recursive: true });
    await symlink('/opt/arco-runner', join(src, 'work/repo/vendor/x'));
    await symlink('/opt/arco-runner', join(src, 'work/repo/vendor/y -> ok'));
    const tar = execFileSync('tar', ['-C', src, '-I', 'zstd -3', '-cf', '-', 'work/repo/vendor']);
    const { url, state } = await s3();
    state.body = tar;
    await expect(restoreCache(url, ctx(a))).rejects.toBeInstanceOf(UnsafeArchive);
    expect(existsSync(join(a.home, 'work/repo/vendor'))).toBe(false);
  });

  itTar('refuses an archive holding a hardlink', async () => {
    const { root, a, ctx } = await env();
    const src = join(root, 'tamper3');
    await mkdir(join(src, 'work/repo/vendor'), { recursive: true });
    await writeFile(join(src, 'work/repo/vendor/a'), 'a');
    execFileSync('ln', [join(src, 'work/repo/vendor/a'), join(src, 'work/repo/vendor/b')]);
    const tar = execFileSync('tar', ['-C', src, '-I', 'zstd -3', '-cf', '-', 'work/repo/vendor']);
    const { url, state } = await s3();
    state.body = tar;
    await expect(restoreCache(url, ctx(a))).rejects.toBeInstanceOf(UnsafeArchive);
  });

  itTar('restore does not follow or touch a planted symlink at the manifest path', async () => {
    const { root, a, b, ctx } = await env();
    await populate(a.home);
    const { url } = await s3();
    await saveCache(url, manifest, ctx(a), Date.now() + 60_000);
    await writeFile(join(root, 'victim'), 'precious');
    await symlink(join(root, 'victim'), join(b.home, '.arco-cache.json'));
    const res = await restoreCache(url, ctx(b));
    expect(res.manifest).toEqual(manifest);
    expect(await readFile(join(root, 'victim'), 'utf8')).toBe('precious');
    expect(existsSync(join(b.home, '.arco-cache.json'))).toBe(false);
  });

  itTar('saveCache with a deadline already past returns timeout and leaves nothing behind', async () => {
    const { a, ctx } = await env();
    await populate(a.home);
    const { url, state } = await s3();
    expect(await saveCache(url, manifest, ctx(a), Date.now() - 1)).toBe('timeout');
    expect(state.puts).toBe(0);
    expect(await readdir(a.varDir)).toEqual([]);
    expect(existsSync(join(a.home, '.arco-cache.json'))).toBe(false);
  });

  itTar('saveCache aborts the upload at the deadline and cleans up', async () => {
    const { a, ctx } = await env();
    await populate(a.home);
    const fetchImpl = ((_u: unknown, init: RequestInit) => new Promise((_r, rej) => {
      init.signal!.addEventListener('abort', () => rej(init.signal!.reason));
    })) as typeof fetch;
    expect(await saveCache('http://x/obj', manifest, ctx(a, { fetchImpl }), Date.now() + 1500)).toBe('timeout');
    expect(await readdir(a.varDir)).toEqual([]);
    expect(existsSync(join(a.home, '.arco-cache.json'))).toBe(false);
  });

  itTar('a replaced varDir symlink is not followed', async () => {
    const { root, a, ctx } = await env();
    await populate(a.home);
    const { rm } = await import('node:fs/promises');
    await rm(a.varDir, { recursive: true });
    await mkdir(join(root, 'elsewhere'));
    await symlink(join(root, 'elsewhere'), a.varDir);
    const { url } = await s3();
    expect(await saveCache(url, manifest, ctx(a), Date.now() + 60_000)).toBe('saved');
    expect(await readdir(join(root, 'elsewhere'))).toEqual([]);
    expect((await lstat(a.varDir)).isDirectory()).toBe(true);
  });
});
