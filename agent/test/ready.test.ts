import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { selfCheck, writableBy } from '../src/ready.js';
import { defaultServicePaths } from '../src/services/catalog.js';

const id = { uid: 1000, gid: 1000 };

describe('writableBy', () => {
  it('root-owned 0755 is not writable by build', () => {
    expect(writableBy({ uid: 0, gid: 0, mode: 0o40755 }, id)).toBe(false);
  });
  it('detects owner, group and other write bits', () => {
    expect(writableBy({ uid: 1000, gid: 0, mode: 0o40755 }, id)).toBe(true);
    expect(writableBy({ uid: 0, gid: 1000, mode: 0o40775 }, id)).toBe(true);
    expect(writableBy({ uid: 0, gid: 0, mode: 0o40757 }, id)).toBe(true);
  });
});

describe('selfCheck with services', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'arco-ready-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    for (const t of ['php', 'composer', 'node', 'git', 'zstd', 'mysqld', 'postgres', 'redis-server']) {
      await writeFile(join(bin, t), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const proc = join(root, 'proc');
    await mkdir(proc);
    const svc = { ...defaultServicePaths(), dataDir: join(root, 'data'), runDir: join(root, 'run'), binDir: bin };
    const paths = { home: root, repo: root, tmpDirs: [], agentDir: root, varDir: root };
    return { root, proc, svc, paths };
  }
  const check = (s: Awaited<ReturnType<typeof setup>>, uids = [27]) =>
    selfCheck(s.paths, null, { paths: s.svc, uids, procDir: s.proc }, []);

  it('passes with no service process and no service data', async () => {
    const s = await setup();
    expect(await check(s)).toBeNull();
    await mkdir(s.svc.dataDir);
    expect(await check(s)).toBeNull();
  });

  it('fails the self-check while a service process runs or service data exists', async () => {
    const s = await setup();
    await mkdir(join(s.proc, '99'));
    await writeFile(join(s.proc, '99/status'), 'Name:\tmysqld\nState:\tS (sleeping)\nUid:\t27\t27\t27\t27\n');
    expect(await check(s)).toMatch(/process.*uid 27/);
    await rm(join(s.proc, '99'), { recursive: true });
    expect(await check(s)).toBeNull();
    await mkdir(join(s.svc.dataDir, 'mysql'), { recursive: true });
    expect(await check(s)).toMatch(/service data/);
  });

  it('fails when a service binary does not run', async () => {
    const s = await setup();
    await writeFile(join(s.root, 'bin/postgres'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    expect(await check(s)).toMatch(/postgres --version failed/);
  });
});
