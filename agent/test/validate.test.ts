import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ValidationError, prefetchRuntimeCache, runValidation, smokeServices } from '../src/validate.js';
import type { ServicesManager } from '../src/services/manager.js';
import type { Paths } from '../src/system.js';

// The agent's build PATH (/usr/local/bin:/usr/bin:/bin) is the image's; a dev machine has php/composer elsewhere.
vi.mock('../src/system.js', async (orig) => {
  const mod = await orig<typeof import('../src/system.js')>();
  return { ...mod, buildEnv: (p: Paths, e: Record<string, string>) => ({ ...mod.buildEnv(p, e), PATH: process.env.PATH }) };
});

const have = (cmd: string, arg = '--version') => spawnSync(cmd, [arg], { stdio: 'ignore' }).status === 0;
const tools = have('php', '-v') && have('composer') && have('node') && have('npm') && have('git');
if (!tools) console.warn('validate tests need php, composer, node, npm and git on PATH: skipped here');
const itTools = it.skipIf(!tools);

const FIXTURE = resolve(__dirname, '../../fixture');
const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();

/** The fixture as the image ships it: a bundle of the fixture dir (app/ and packages/). */
async function world(o: { breakArco?: boolean; failTests?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'arco-validate-'));
  roots.push(root);
  const src = join(root, 'src');
  await cp(FIXTURE, src, { recursive: true });
  if (o.breakArco) await writeFile(join(src, 'packages/fake-arco/bin/arco'), '#!/usr/bin/env php\n<?php\nfwrite(STDERR, "boom\\n");\nexit(1);\n');
  if (o.failTests) {
    await mkdir(join(src, 'app/tests'), { recursive: true });
    await writeFile(join(src, 'app/tests/ExampleTest.php'), "<?php\nreturn ['it fails' => function () { throw new RuntimeException('expected failure'); }];\n");
  }
  git(src, 'init', '-q');
  git(src, 'add', '.');
  git(src, 'commit', '-q', '-m', 'fixture');
  const fixtureDir = join(root, 'fixture');
  await mkdir(fixtureDir);
  git(src, 'bundle', 'create', join(fixtureDir, 'app.bundle'), '--all');
  const paths: Paths = {
    home: join(root, 'home'), repo: join(root, 'home/work/repo'), tmpDirs: [join(root, 'tmp')],
    agentDir: join(root, 'agent'), varDir: join(root, 'var'),
  };
  await mkdir(paths.tmpDirs[0]!);
  await mkdir(paths.agentDir);
  return { paths, fixtureDir };
}

describe('runValidation', () => {
  itTools('builds the real fixture through the real pipeline, offline', async () => {
    const w = await world();
    await expect(runValidation({ ...w, identity: null })).resolves.toBeUndefined();
    // Nothing the canned jobs built may be left behind.
    for (const p of ['work/repo/app/vendor', 'work/repo/app/node_modules', 'work/repo', '.npm', '.cache']) {
      expect(existsSync(join(w.paths.home, p)), p).toBe(false);
    }
  }, 240_000);

  itTools('fails with a ValidationError when arco deploy exits 1', async () => {
    const w = await world({ breakArco: true });
    const err = await runValidation({ ...w, identity: null }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/did not receive a finish with result succeeded/);
  }, 240_000);

  itTools('runs the canned test phase and fails validation when the fixture tests fail', async () => {
    const w = await world({ failTests: true });
    const err = await runValidation({ ...w, identity: null }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain('build.tests_failed');
  }, 240_000);

  it('fails with a ValidationError when the bundle is missing', async () => {
    const w = await world();
    await rm(join(w.fixtureDir, 'app.bundle'));
    await expect(runValidation({ ...w, identity: null })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('smokeServices', () => {
  it('stops and removes everything, and never shows the password, when a server does not start', async () => {
    let password = '';
    const calls: string[] = [];
    const manager: ServicesManager = {
      start: async (_s, p) => { password = p; calls.push('start'); throw new Error(`MySQL did not become ready (password ${p})`); },
      dropDatabases: async () => { calls.push('drop'); return []; },
      stopAll: async () => { calls.push('stop'); },
      removeData: async () => { calls.push('remove'); },
      phpRedis: async () => true,
    };
    const root = await mkdtemp(join(tmpdir(), 'smoke-'));
    roots.push(root);
    const paths: Paths = { home: root, repo: join(root, 'repo'), tmpDirs: [root], agentDir: root, varDir: root };
    const err = await smokeServices({
      manager, identity: { uid: 1000, gid: 1000 }, paths, log: () => {},
      servicePaths: { dataDir: join(root, 'data'), runDir: join(root, 'run'), templateDir: join(root, 't'), binDir: root },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/^services: MySQL did not start: .*password \*\*\*\)/);
    expect(password.length).toBeGreaterThan(0);
    expect((err as Error).message).not.toContain(password);
    expect(calls).toEqual(['start', 'stop', 'remove']);
  });
});

describe('prefetchRuntimeCache', () => {
  it('reads every pre-seeded runtime binary in full, regular files only', async () => {
    const home = await mkdtemp(join(tmpdir(), 'prefetch-'));
    try {
      const dir = join(home, '.arco', 'cache', 'runtime', 'php8.5.12-fp1.13.1-r1');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'frankenphp'), Buffer.alloc(3 * 1024 * 1024, 1));
      await writeFile(join(dir, 'php'), Buffer.alloc(1024, 2));
      const outside = join(home, 'outside.bin');
      await writeFile(outside, Buffer.alloc(5000, 3));
      await symlink(outside, join(dir, 'link'));
      expect(await prefetchRuntimeCache(home)).toEqual({ files: 2, bytes: 3 * 1024 * 1024 + 1024 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reads nothing when there is no runtime cache', async () => {
    const home = await mkdtemp(join(tmpdir(), 'prefetch-'));
    try {
      expect(await prefetchRuntimeCache(home)).toEqual({ files: 0, bytes: 0 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
