import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Paths } from '../src/system.js';
import { WipeError, findOwnedArgs, keptPaths, killUserProcesses, runFind, wipe } from '../src/wipe.js';

const isRoot = process.getuid?.() === 0;
// Running as root (test:linux) every fixture file is root-owned, which step 6 refuses; chown the tree to the build user.
const UID = isRoot ? 1000 : process.getuid!();
const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

const put = async (p: string, data = 'x') => { await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, data); };
const chownTree = (p: string) => { if (isRoot) execFileSync('chown', ['-R', '-h', '1000:1000', p]); };

async function fixture(rootDir = '') {
  const root = await mkdtemp(join(tmpdir(), 'arco-wipe-'));
  roots.push(root);
  const fs = join(root, 'fs'); // what step 5 may search; `outside` and `proc` are beyond its reach
  const paths: Paths = {
    home: join(fs, 'home'), repo: join(fs, 'home/work/repo'),
    tmpDirs: [join(fs, 'tmp'), join(fs, 'vartmp'), join(fs, 'shm')],
    agentDir: join(fs, 'agent'), varDir: join(fs, 'vartmp/arco-runner'),
  };
  for (const d of paths.tmpDirs) await mkdir(d, { recursive: true });
  const emptyProc = join(root, 'proc');
  await mkdir(emptyProc);
  const outside = join(root, 'outside'); // stands for a root-owned location a link could point at
  await put(join(outside, 'precious'), 'keep me');
  await mkdir(join(outside, 'dir'));
  const opts = {
    uid: UID, findRoot: fs, procDir: emptyProc, extraRoots: [] as string[], sysvDir: join(root, 'no-sysvipc'),
    killAllAs: async () => undefined,
  };
  return { root, fs, paths, outside, opts, rootDir };
}

async function populate(f: Awaited<ReturnType<typeof fixture>>) {
  const { paths: p } = f;
  for (const rel of ['.npmrc', '.config/composer/auth.json', '.gitconfig', '.arco/config.php', '.bash_history', 'work/stray']) {
    await put(join(p.home, rel));
  }
  for (const rel of ['.env', '.git/config', 'src/a.php', 'composer.json']) await put(join(p.repo, rel));
  for (const rel of ['vendor/a', 'node_modules/b', 'app/vendor/c', 'app/node_modules/d', 'app/src/e.php']) await put(join(p.repo, rel));
  for (const rel of ['.cache/composer/x', '.npm/y', '.arco/cache/runtime/z', '.cache/other/q', '.arco/cache/other/r']) await put(join(p.home, rel));
  for (const d of p.tmpDirs) { await put(join(d, 'junk')); await put(join(d, '.hidden/deep/file')); }
}

describe('keptPaths', () => {
  it('is the cache roots without the manifest plus the Arco runtime cache', () => {
    expect(keptPaths('')).toEqual(['work/repo/vendor', 'work/repo/node_modules', '.cache/composer', '.npm', '.arco/cache/runtime']);
    expect(keptPaths('app')).toContain('work/repo/app/vendor');
    expect(keptPaths('app').some((k) => k.includes('.arco-cache.json'))).toBe(false);
  });
});

describe('wipe', () => {
  it('removes secrets, the checkout and scratch files; keeps only the dependency dirs', async () => {
    const f = await fixture('app');
    await populate(f);
    chownTree(f.root);
    await wipe(f.paths, 'app', f.opts);
    const { home, repo, tmpDirs } = f.paths;
    for (const gone of ['.npmrc', '.config', '.gitconfig', '.arco/config.php', '.bash_history', 'work/stray', '.cache/other', '.arco/cache/other']) {
      expect(existsSync(join(home, gone)), gone).toBe(false);
    }
    for (const gone of ['.env', '.git', 'src', 'composer.json', 'app/src']) expect(existsSync(join(repo, gone)), gone).toBe(false);
    for (const ok of ['vendor/a', 'node_modules/b', 'app/vendor/c', 'app/node_modules/d']) expect(existsSync(join(repo, ok)), ok).toBe(true);
    for (const ok of ['.cache/composer/x', '.npm/y', '.arco/cache/runtime/z']) expect(existsSync(join(home, ok)), ok).toBe(true);
    for (const d of tmpDirs) expect(await readdir(d)).toEqual([]);
  });

  it('works without a uid (steps 1 and 5 are skipped)', async () => {
    const f = await fixture();
    await populate(f);
    chownTree(f.root);
    await wipe(f.paths, '');
    expect(existsSync(join(f.paths.home, '.npmrc'))).toBe(false);
    expect(existsSync(join(f.paths.repo, 'vendor/a'))).toBe(true);
    expect(existsSync(f.paths.agentDir)).toBe(false);
  });

  it('is a no-op on a VM whose home does not exist yet', async () => {
    const f = await fixture();
    await wipe(f.paths, '', f.opts);
  });

  it('unlinks a symlinked work, .cache and .arco without touching the target', async () => {
    const f = await fixture();
    const { home } = f.paths;
    await mkdir(home, { recursive: true });
    await put(join(f.outside, 'work-t/repo/vendor/x'));
    await symlink(join(f.outside, 'work-t'), join(home, 'work'));
    await symlink(f.outside, join(home, '.cache'));
    await symlink(join(f.outside, 'dir'), join(home, '.arco'));
    chownTree(f.root);
    await wipe(f.paths, '', f.opts);
    for (const l of ['work', '.cache', '.arco']) expect(existsSync(join(home, l)) || lstatExists(join(home, l)), l).toBe(false);
    expect(await readFile(join(f.outside, 'precious'), 'utf8')).toBe('keep me');
    expect(existsSync(join(f.outside, 'work-t/repo/vendor/x'))).toBe(true);
    expect(await readdir(f.outside)).toEqual(expect.arrayContaining(['precious', 'dir', 'work-t']));
  });

  it('unlinks a symlinked work/repo and a symlinked .arco/cache without touching the target', async () => {
    const f = await fixture();
    const { home } = f.paths;
    await mkdir(join(home, 'work'), { recursive: true });
    await mkdir(join(home, '.arco'), { recursive: true });
    await symlink(f.outside, join(home, 'work/repo'));
    await symlink(f.outside, join(home, '.arco/cache'));
    chownTree(f.root);
    await wipe(f.paths, '', f.opts);
    expect(lstatExists(join(home, 'work/repo'))).toBe(false);
    expect(lstatExists(join(home, '.arco/cache'))).toBe(false);
    expect(await readFile(join(f.outside, 'precious'), 'utf8')).toBe('keep me');
  });

  it('removes a kept path that is a symlink (or a plain file) instead of keeping or following it', async () => {
    const f = await fixture('app');
    const { home, repo } = f.paths;
    await mkdir(join(repo, 'app'), { recursive: true });
    await symlink(f.outside, join(repo, 'vendor'));
    await writeFile(join(repo, 'node_modules'), 'file where a dir belongs');
    await symlink(join(f.outside, 'dir'), join(repo, 'app/vendor'));
    await mkdir(join(home, '.cache'));
    await symlink(f.outside, join(home, '.cache/composer'));
    await symlink(f.outside, join(home, '.npm'));
    await mkdir(join(home, '.arco/cache'), { recursive: true });
    await symlink(f.outside, join(home, '.arco/cache/runtime'));
    chownTree(f.root);
    await wipe(f.paths, 'app', f.opts);
    for (const p of [join(repo, 'vendor'), join(repo, 'node_modules'), join(repo, 'app/vendor'), join(home, '.cache/composer'), join(home, '.npm'), join(home, '.arco/cache/runtime')]) {
      expect(lstatExists(p), p).toBe(false);
    }
    expect(await readFile(join(f.outside, 'precious'), 'utf8')).toBe('keep me');
    expect(existsSync(join(f.outside, 'dir'))).toBe(true);
  });

  it('keeps symlinks inside kept paths as links (never follows them) and clears scratch links without following', async () => {
    const f = await fixture();
    await put(join(f.paths.repo, 'vendor/real'));
    await symlink('real', join(f.paths.repo, 'vendor/link'));
    await symlink(f.outside, join(f.paths.tmpDirs[0]!, 'evil'));
    chownTree(f.root);
    await wipe(f.paths, '', f.opts);
    expect(lstatSync(join(f.paths.repo, 'vendor/link')).isSymbolicLink()).toBe(true);
    expect(lstatExists(join(f.paths.tmpDirs[0]!, 'evil'))).toBe(false);
    expect(existsSync(join(f.outside, 'precious'))).toBe(true);
  });

  it('step 5 deletes leftovers of the build uid outside the kept paths and never follows links into them', async () => {
    const f = await fixture('a[x]*');
    await put(join(f.paths.repo, 'a[x]*/vendor/keep'));
    await put(join(f.paths.home, '.npm/keep'));
    await put(join(f.fs, 'srv/leftover'));
    await put(join(f.fs, 'srv/sub/deeper/leftover2'));
    await symlink(join(f.paths.home, '.npm'), join(f.fs, 'srv/link-to-kept'));
    await symlink(join(f.paths.repo, 'a[x]*/vendor'), join(f.fs, 'srv/link-to-kept2'));
    chownTree(f.root);
    await wipe(f.paths, 'a[x]*', f.opts);
    expect(existsSync(join(f.fs, 'srv/leftover'))).toBe(false);
    expect(existsSync(join(f.fs, 'srv/sub'))).toBe(false);
    expect(lstatExists(join(f.fs, 'srv/link-to-kept'))).toBe(false);
    expect(lstatExists(join(f.fs, 'srv/link-to-kept2'))).toBe(false);
    expect(existsSync(join(f.paths.home, '.npm/keep'))).toBe(true);
    expect(existsSync(join(f.paths.repo, 'a[x]*/vendor/keep'))).toBe(true);
    expect(await readFile(join(f.outside, 'precious'), 'utf8')).toBe('keep me');
  });

  it('step 5 uses an argv for find: no shell, kept paths matched literally', () => {
    const args = findOwnedArgs(1000, '/', '/home/build', ['/tmp'], ['.cache/composer', 'work/repo/a b$(x)*/vendor']);
    expect(Array.isArray(args)).toBe(true);
    expect(args.slice(0, 5)).toEqual(['-P', '/', '-xdev', '-uid', '1000']);
    expect(args.at(-1)).toBe('-delete');
    expect(args).toContain('/proc');
    expect(args).toContain('/sys');
    expect(args).toContain('/home/build/.cache/composer');
    expect(args).toContain('/home/build/.cache/composer/*');
    expect(args).toContain('/home/build/work/repo/a b$(x)\\*/vendor');
    expect(args).toContain('/home/build/.cache');
    expect(args).toContain('/home/build/work/repo');
    expect(args).toContain('/home/build');
    expect(args.some((a) => a === '-follow' || a === '-L' || a === '-H')).toBe(false);
  });

  it('refuses a setuid or setgid file inside a kept path', async () => {
    for (const mode of [0o4755, 0o2755]) {
      const f = await fixture();
      await put(join(f.paths.repo, 'vendor/bin/evil'));
      chownTree(f.root); // chown clears setuid bits, so chmod after it
      await chmod(join(f.paths.repo, 'vendor/bin/evil'), mode);
      await expect(wipe(f.paths, '', f.opts)).rejects.toBeInstanceOf(WipeError);
    }
  });

  it.skipIf(!isRoot)('refuses a root-owned file inside a kept path (root only: needs chown)', async () => {
    for (const where of ['.npm/rootfile', 'work/repo/node_modules/x/rootfile', '.arco/cache/runtime/rootfile']) {
      const f = await fixture();
      await put(join(f.paths.home, where));
      chownTree(f.root);
      execFileSync('chown', ['0:0', join(f.paths.home, where)]);
      await expect(wipe(f.paths, '', f.opts), where).rejects.toThrow(/root-owned/);
    }
  });

  it('removes FIFOs and tolerates one inside a kept path (nothing opens it)', async () => {
    const f = await fixture();
    await mkdir(f.paths.repo, { recursive: true });
    execFileSync('mkfifo', [join(f.paths.repo, 'pipe'), join(f.paths.home, 'pipe')]);
    await put(join(f.paths.repo, 'vendor/keep'));
    execFileSync('mkfifo', [join(f.paths.repo, 'vendor/fifo')]);
    chownTree(f.root);
    await wipe(f.paths, '', f.opts);
    expect(lstatExists(join(f.paths.repo, 'pipe'))).toBe(false);
    expect(lstatExists(join(f.paths.home, 'pipe'))).toBe(false);
    expect(lstatExists(join(f.paths.repo, 'vendor/fifo'))).toBe(true);
  });

  it('removes a tree nested deeper than PATH_MAX', async () => {
    const f = await fixture();
    await mkdir(f.paths.repo, { recursive: true });
    const script = `const fs=require('fs');process.chdir(process.argv[1]);for(let i=0;i<900;i++){fs.mkdirSync('dddddddd');process.chdir('dddddddd');}fs.writeFileSync('f','x');`;
    await mkdir(join(f.paths.repo, 'deep'));
    execFileSync(process.execPath, ['-e', script, join(f.paths.repo, 'deep')], { stdio: 'inherit' });
    execFileSync(process.execPath, ['-e', script, f.paths.tmpDirs[0]!], { stdio: 'inherit' });
    chownTree(f.root);
    await wipe(f.paths, '', f.opts);
    expect(existsSync(join(f.paths.repo, 'deep'))).toBe(false);
    expect(await readdir(f.paths.tmpDirs[0]!)).toEqual([]);
  });

  it('R12: removes SysV IPC objects owned by the build uid and sweeps the extra roots', async () => {
    const f = await fixture();
    const ipc = join(f.root, 'sysvipc');
    await mkdir(ipc);
    await writeFile(join(ipc, 'shm'), `       key      shmid perms  size cpid lpid nattch   uid   gid  cuid  cgid\n 0 11 666 4096 1 1 0 ${UID} ${UID} ${UID} ${UID}\n 0 12 666 4096 1 1 0 0 0 0 0\n`);
    await writeFile(join(ipc, 'sem'), `key semid perms nsems uid gid cuid cgid\n 0 21 666 1 ${UID} ${UID} ${UID} ${UID}\n`);
    await writeFile(join(ipc, 'msg'), `key msqid perms cbytes qnum lspid lrpid uid gid cuid cgid\n 0 31 666 0 0 0 0 ${UID} ${UID} ${UID} ${UID}\n`);
    const mq = join(f.root, 'mq');
    await put(join(mq, 'queue'));
    await mkdir(join(f.root, 'not-a-dir-root'));
    await writeFile(join(f.root, 'lockfile'), 'x');
    chownTree(f.root);
    const calls: string[] = [];
    await wipe(f.paths, '', {
      ...f.opts, findRoot: f.fs, sysvDir: ipc, ipcrm: async (fl, id) => { calls.push(`${fl} ${id}`); },
      extraRoots: [mq, join(f.root, 'lockfile'), join(f.root, 'absent')],
    });
    expect(calls).toEqual(['-m 11', '-s 21', '-q 31']);
    expect(existsSync(join(mq, 'queue'))).toBe(false);
    expect(existsSync(join(f.root, 'lockfile'))).toBe(true);
  });

  it('surfaces a surviving build process as WipeError', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'proc/4242'));
    await writeFile(join(f.root, 'proc/4242/status'), 'Name:\tx\nState:\tS (sleeping)\nUid:\t1000\t1000\t1000\t1000\n');
    await expect(wipe(f.paths, '', { ...f.opts, uid: 1000, kill: () => undefined, killTimeoutMs: 150 })).rejects.toThrow(WipeError);
  });
});

function lstatExists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

describe('runFind', () => {
  it('tolerates only "No such file or directory" on stderr', async () => {
    await expect(runFind(['-P', '/nonexistent-arco-path'])).resolves.toBe('');
    await expect(runFind(['-P', '.', '-nosuchpredicate'])).rejects.toBeInstanceOf(WipeError);
  });
});

describe('killUserProcesses', () => {
  async function fakeProc(entries: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'arco-proc-'));
    roots.push(dir);
    for (const [pid, status] of Object.entries(entries)) {
      await mkdir(join(dir, pid));
      await writeFile(join(dir, pid, 'status'), status);
    }
    await mkdir(join(dir, 'self'));
    await writeFile(join(dir, 'cpuinfo'), 'x');
    return dir;
  }
  const noAll = { killAllAs: async () => undefined };
  const status = (uid: number, state = 'S (sleeping)') => `Name:\tp\nState:\t${state}\nUid:\t${uid}\t0\t0\t0\nGid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;

  it('signals only pids whose real uid matches, with SIGKILL', async () => {
    const dir = await fakeProc({ 10: status(1000), 11: status(0), 12: status(1001), 13: status(1000), 14: status(1000, 'Z (zombie)') });
    const calls: [number, string][] = [];
    await killUserProcesses(1000, 2000, dir, (pid, sig) => {
      calls.push([pid, sig]);
      rmSync(join(dir, String(pid)), { recursive: true });
    }, noAll);
    expect(calls.sort()).toEqual([[10, 'SIGKILL'], [13, 'SIGKILL']]);
  });

  it('loops until no process is left, catching children forked meanwhile', async () => {
    const dir = await fakeProc({ 20: status(1000) });
    const calls: number[] = [];
    await killUserProcesses(1000, 2000, dir, (pid) => {
      calls.push(pid);
      if (pid === 20) { mkdirSync(join(dir, '21')); writeFileSync(join(dir, '21/status'), status(1000)); }
      rmSync(join(dir, String(pid)), { recursive: true });
    }, noAll);
    expect(calls).toEqual([20, 21]);
  });

  it('throws WipeError when a process survives the timeout, and ignores a kill that fails', async () => {
    const dir = await fakeProc({ 30: status(1000) });
    let n = 0;
    await expect(killUserProcesses(1000, 150, dir, () => { n++; throw new Error('EPERM'); }, noAll)).rejects.toBeInstanceOf(WipeError);
    expect(n).toBeGreaterThan(1);
  });

  it('matches on any of the four uid fields', async () => {
    const dir = await fakeProc({
      40: 'State:\tS\nUid:\t0\t1000\t0\t0\n', 41: 'State:\tS\nUid:\t0\t0\t1000\t0\n', 42: 'State:\tS\nUid:\t0\t0\t0\t1000\n',
    });
    const seen: number[] = [];
    await killUserProcesses(1000, 2000, dir, (pid) => { seen.push(pid); rmSync(join(dir, String(pid)), { recursive: true }); }, noAll);
    expect(seen.sort()).toEqual([40, 41, 42]);
  });

  it('needs two consecutive empty scans and calls the atomic killer while processes exist', async () => {
    const dir = await fakeProc({ 50: status(1000) });
    const t0 = Date.now();
    let atomic = 0;
    await killUserProcesses(1000, 2000, dir, (pid) => rmSync(join(dir, String(pid)), { recursive: true }), {
      killAllAs: async () => { atomic++; },
    });
    expect(atomic).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  });

  it('fails closed when /proc cannot be read, and on a status read error other than a vanished pid', async () => {
    await expect(killUserProcesses(1000, 100, '/nonexistent-proc', () => undefined, noAll)).rejects.toBeInstanceOf(WipeError);
    const dir = await fakeProc({});
    await mkdir(join(dir, '60'));
    await mkdir(join(dir, '60/status')); // reading a directory: EISDIR
    await expect(killUserProcesses(1000, 100, dir, () => undefined, noAll)).rejects.toBeInstanceOf(WipeError);
  });

  it('refuses uid 0', async () => {
    await expect(killUserProcesses(0, 100, '/nonexistent', () => undefined)).rejects.toBeInstanceOf(WipeError);
  });

  it.skipIf(!isRoot)('a uid-1000 fork-and-exit chain is fully gone after step 1 and stays gone (root only)', async () => {
    const code = `setTimeout(()=>{require('child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[1]],{detached:true,stdio:'ignore'}).unref();process.exit(0)},15)`;
    const first = spawn(process.execPath, ['-e', code, code], { uid: 1000, gid: 1000, cwd: '/', stdio: 'ignore', detached: true, env: {} });
    first.unref();
    await new Promise((r) => setTimeout(r, 300));
    const count = () => Number(execFileSync('sh', ['-c', "ps -eo uid= | awk '$1==1000' | wc -l"], { encoding: 'utf8' }).trim());
    expect(count()).toBeGreaterThan(0);
    await killUserProcesses(1000, 5000);
    expect(count()).toBe(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(count()).toBe(0);
  });

  it.skipIf(!isRoot)('kills real processes of uid 1000, forking ones included (root only)', async () => {
    const child = spawn('sh', ['-c', 'while :; do sleep 60 & sleep 60 & wait; done'], { uid: 1000, gid: 1000, stdio: 'ignore', detached: true });
    child.unref();
    await new Promise((r) => setTimeout(r, 200));
    await killUserProcesses(1000, 5000);
    const left = execFileSync('sh', ['-c', 'ps -eo uid | awk \'$1==1000\' | wc -l'], { encoding: 'utf8' }).trim();
    expect(left).toBe('0');
  });
});
