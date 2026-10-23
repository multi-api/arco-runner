import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceName } from '../src/job/document.js';
import {
  SERVICE_PORTS,
  SYSTEM_DATABASES,
  adminArgv,
  createSql,
  dropSql,
  listDatabasesSql,
  probeArgv,
  serverArgv,
  serviceUserIds,
  type ServicePaths,
} from '../src/services/catalog.js';
import { ServiceStartError, createServicesManager, type ServerProcess } from '../src/services/manager.js';

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function makePaths(): Promise<ServicePaths> {
  const root = await mkdtemp(join(tmpdir(), 'arco-services-'));
  roots.push(root);
  const p: ServicePaths = {
    dataDir: join(root, 'var/lib/arco-services'),
    runDir: join(root, 'run/arco-services'),
    templateDir: join(root, 'opt/arco-services/templates'),
    binDir: '/usr/local/bin',
  };
  for (const s of ['mysql', 'pgsql']) {
    await mkdir(join(p.templateDir, s), { recursive: true });
    await writeFile(join(p.templateDir, s, 'pristine'), s);
  }
  return p;
}

interface FakeProc extends ServerProcess {
  argv: string[];
  signals: Array<{ signal: NodeJS.Signals; at: number }>;
}

/** Fakes for every side effect: a manual clock, servers that obey (or ignore) SIGTERM, probes, admin SQL. */
function harness(o: { ready?: (s: ServiceName) => boolean; ignoreTerm?: boolean; listing?: string; onSleep?: (t: number) => void } = {}) {
  let t = 0;
  const procs: Record<string, FakeProc> = {};
  const probes: string[][] = [];
  const admins: Array<{ s: ServiceName; argv: string[]; sql: string }> = [];
  const killedUsers: number[] = [];
  const fakes = {
    now: () => t,
    sleep: async (ms: number) => { t += ms; o.onSleep?.(t); },
    userUid: () => process.getuid!(),
    redisMajor: async () => 7,
    killUser: async (uid: number) => { killedUsers.push(uid); },
    spawnServer: (s: ServiceName, argv: string[]): ServerProcess => {
      let exit!: (code: number | null) => void;
      const exited = new Promise<number | null>((r) => { exit = r; });
      const proc: FakeProc = {
        argv,
        signals: [],
        exited,
        kill(signal) {
          proc.signals.push({ signal, at: t });
          if (signal === 'SIGKILL' || !o.ignoreTerm) exit(null);
        },
      };
      procs[s] = proc;
      return proc;
    },
    probe: async (_s: ServiceName, argv: string[]) => {
      probes.push(argv);
      return o.ready ? o.ready(_s) : true;
    },
    admin: async (s: ServiceName, argv: string[], sql: string) => {
      admins.push({ s, argv, sql });
      return { exitCode: 0, stdout: /^(SHOW|SELECT)/.test(sql) ? (o.listing ?? '') : '', stderr: '' };
    },
  };
  return { fakes, procs, probes, admins, killedUsers, clock: () => t };
}

describe('catalog', () => {
  it('looks up the service users in passwd and names the missing ones', () => {
    const passwd = 'root:x:0:0::/root:/bin/sh\nmysql:x:27:27::/var/lib/mysql:/sbin/nologin\nredis:x:0:0::/:/sbin/nologin\nbuild:x:1000:1000::/home/build:/bin/bash\n';
    expect(serviceUserIds(passwd)).toEqual({ uids: { mysql: 27 }, missing: ['postgres', 'redis'] });
    expect(serviceUserIds('')).toEqual({ uids: {}, missing: ['mysql', 'postgres', 'redis'] });
  });
  it('binds every server to 127.0.0.1 on its port and never puts the password in argv', async () => {
    const p = await makePaths();
    const password = "S3cr3t'pw-xyz";
    for (const s of ['mysql', 'pgsql', 'redis'] as const) {
      for (const argv of [serverArgv(s, p, 7), probeArgv(s, p)]) {
        expect(argv.join(' ')).toContain('127.0.0.1');
        expect(argv.join(' ')).toContain(String(SERVICE_PORTS[s]));
      }
    }
    expect(serverArgv('mysql', p, 7)).toEqual(expect.arrayContaining([
      '--bind-address=127.0.0.1', '--port=3306', '--mysqlx=OFF', '--skip-log-bin', '--secure-file-priv=NULL',
      '--performance-schema=OFF', '--innodb-flush-log-at-trx-commit=0', '--innodb-redo-log-capacity=8M', '--skip-name-resolve',
      `--socket=${p.runDir}/mysql/mysqld.sock`, `--log-error=${p.dataDir}/mysql/error.log`,
    ]));
    expect(serverArgv('pgsql', p, 7).slice(1).join(' ')).toBe(
      `-D ${p.dataDir}/pgsql -c listen_addresses=127.0.0.1 -c port=5432 -k ${p.runDir}/pgsql -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c hba_file=${p.runDir}/pg_hba.conf -c password_encryption=scram-sha-256`,
    );
    expect(serverArgv('redis', p, 7).slice(1)).toEqual([
      '--bind', '127.0.0.1', '--port', '6379', '--dir', `${p.dataDir}/redis`, '--save', '', '--appendonly', 'no',
      '--protected-mode', 'yes', '--enable-protected-configs', 'no', '--enable-module-command', 'no',
      '--rename-command', 'DEBUG', '',
    ]);
    // Redis 6 (AL2023 redis6) has no enable-* switches: MODULE, CONFIG and DEBUG are renamed away instead.
    expect(serverArgv('redis', p, 6).slice(1)).toEqual([
      '--bind', '127.0.0.1', '--port', '6379', '--dir', `${p.dataDir}/redis`, '--save', '', '--appendonly', 'no',
      '--protected-mode', 'yes', '--rename-command', 'MODULE', '', '--rename-command', 'CONFIG', '',
      '--rename-command', 'DEBUG', '',
    ]);

    // Through the manager: no argv it runs carries the password; the password only travels on stdin.
    const h = harness();
    const m = createServicesManager(p, h.fakes);
    await m.start(['mysql', 'pgsql', 'redis'], password, new AbortController().signal);
    const argvs = [...Object.values(h.procs).map((x) => x.argv), ...h.probes, ...h.admins.map((a) => a.argv)];
    expect(argvs.length).toBeGreaterThan(5);
    for (const argv of argvs) for (const a of argv) expect(a).not.toContain('S3cr3t');
    expect(h.admins.some((a) => a.sql.includes("S3cr3t''pw-xyz"))).toBe(true);
    expect(h.admins.map((a) => a.argv)).toEqual([adminArgv('mysql', p), adminArgv('pgsql', p)]);
  });

  it('creates testing and arco with the CREATEDB / testing% grant', () => {
    expect(createSql('mysql', 'pw')).toBe(
      "CREATE DATABASE testing; CREATE USER 'arco'@'%' IDENTIFIED BY 'pw'; GRANT ALL ON `testing%`.* TO 'arco'@'%';",
    );
    expect(createSql('pgsql', 'pw')).toBe("CREATE ROLE arco LOGIN CREATEDB PASSWORD 'pw'; CREATE DATABASE testing OWNER arco;");
    expect(createSql('mysql', "a'b")).toContain("IDENTIFIED BY 'a''b'");
    expect(createSql('mysql', 'a\\b')).toContain("IDENTIFIED BY 'a\\\\b'");
    expect(createSql('pgsql', "a'b")).toContain("PASSWORD 'a''b'");
    expect(listDatabasesSql('mysql')).toBe('SHOW DATABASES;');
    expect(listDatabasesSql('pgsql')).toBe('SELECT datname FROM pg_database;');
    expect(dropSql('mysql', ['testing', 'we`ird'])).toBe('DROP DATABASE IF EXISTS `testing`; DROP DATABASE IF EXISTS `we``ird`;');
    expect(dropSql('pgsql', ['testing', 'we"ird'])).toBe('DROP DATABASE IF EXISTS "testing" WITH (FORCE); DROP DATABASE IF EXISTS "we""ird" WITH (FORCE);');
    expect(SYSTEM_DATABASES.mysql).toEqual(['mysql', 'information_schema', 'performance_schema', 'sys']);
    expect(SYSTEM_DATABASES.pgsql).toEqual(['postgres', 'template0', 'template1']);
  });
});

describe('services manager', () => {
  it('writes a root-owned pg_hba.conf that refuses every TCP login but arco, and removeData deletes it', async () => {
    const p = await makePaths();
    const h = harness();
    const m = createServicesManager(p, h.fakes);
    await m.start(['pgsql'], 'pw', new AbortController().signal);
    const hba = join(p.runDir, 'pg_hba.conf');
    expect(h.procs.pgsql!.argv).toContain(`hba_file=${hba}`);
    expect(readFileSync(hba, 'utf8')).toBe(
      'local all postgres peer\nhost all arco 127.0.0.1/32 scram-sha-256\nhost all all 0.0.0.0/0 reject\nhost all all ::/0 reject\n',
    );
    const st = lstatSync(hba);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o644);
    expect(st.uid).toBe(process.getuid!());
    await m.stopAll();
    await m.removeData();
    expect(existsSync(hba)).toBe(false);
  });

  it('never writes pg_hba.conf through a link planted at its path', async () => {
    const p = await makePaths();
    const outside = await mkdtemp(join(tmpdir(), 'arco-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'target'), 'keep');
    await mkdir(p.runDir, { recursive: true });
    await symlink(join(outside, 'target'), join(p.runDir, 'pg_hba.conf'));
    const m = createServicesManager(p, harness().fakes);
    await m.start(['pgsql'], 'pw', new AbortController().signal);
    expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('keep');
    expect(lstatSync(join(p.runDir, 'pg_hba.conf')).isFile()).toBe(true);
  });

  it('never gives a probe more time than is left before the 30 s deadline', async () => {
    const p = await makePaths();
    const h = harness({ ready: () => false });
    const timeouts: Array<{ at: number; ms: number }> = [];
    const m = createServicesManager(p, {
      ...h.fakes,
      probe: async (_s, _argv, _as, ms) => { timeouts.push({ at: h.clock(), ms }); return false; },
    });
    await m.start(['redis'], 'pw', new AbortController().signal).catch(() => {});
    expect(timeouts.length).toBeGreaterThan(100);
    for (const t of timeouts) {
      expect(t.ms).toBeGreaterThan(0);
      expect(t.ms).toBeLessThanOrEqual(5_000);
      expect(t.at + t.ms).toBeLessThanOrEqual(30_000);
    }
  });

  it('never signals a server that has already exited', async () => {
    const p = await makePaths();
    const h = harness();
    const m = createServicesManager(p, h.fakes);
    await m.start(['redis'], 'pw', new AbortController().signal);
    h.procs.redis!.kill('SIGTERM'); // it exits on its own
    h.procs.redis!.signals.length = 0;
    await new Promise((r) => setImmediate(r));
    await m.stopAll();
    expect(h.procs.redis!.signals).toEqual([]);
  });

  it('bounds the drop statements with a signal', async () => {
    const p = await makePaths();
    const signals: Array<AbortSignal | undefined> = [];
    const h = harness({ listing: 'testing\n' });
    const m = createServicesManager(p, {
      ...h.fakes,
      admin: async (s, argv, sql, o) => { signals.push(o.signal); return h.fakes.admin(s, argv, sql); },
    });
    await m.start(['pgsql'], 'pw', new AbortController().signal);
    signals.length = 0;
    expect(await m.dropDatabases()).toEqual(['testing']);
    expect(signals).toHaveLength(2);
    for (const sg of signals) expect(sg).toBeInstanceOf(AbortSignal);
  });

  it('drops every non-system database', async () => {
    const p = await makePaths();
    const h = harness({ listing: 'testing\ntesting_test_1\nmysql\nsys\n' });
    const m = createServicesManager(p, h.fakes);
    await m.start(['mysql'], 'pw', new AbortController().signal);
    expect(await m.dropDatabases()).toEqual(['testing', 'testing_test_1']);
    expect(h.admins.at(-1)!.sql).toBe('DROP DATABASE IF EXISTS `testing`; DROP DATABASE IF EXISTS `testing_test_1`;');
  });

  it('starts from a fresh copy of the template, owned by the service user, and reports ms per service', async () => {
    const p = await makePaths();
    const h = harness();
    const m = createServicesManager(p, h.fakes);
    const ms = await m.start(['mysql', 'redis'], 'pw', new AbortController().signal);
    expect(ms).toEqual({ mysql: 0, redis: 0 });
    expect(readFileSync(join(p.dataDir, 'mysql', 'pristine'), 'utf8')).toBe('mysql');
    expect(existsSync(join(p.dataDir, 'redis'))).toBe(true);
    expect(existsSync(join(p.dataDir, 'mysql', 'server.log'))).toBe(true);
  });

  it('fails with ServiceStartError after 30 s without readiness and stops what it started', async () => {
    const p = await makePaths();
    const h = harness({ ready: () => false });
    const m = createServicesManager(p, h.fakes);
    const err = await m.start(['mysql'], 'pw', new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceStartError);
    expect((err as ServiceStartError).service).toBe('mysql');
    expect((err as Error).message).toContain('MySQL did not become ready within 30 seconds');
    expect(h.clock()).toBeGreaterThanOrEqual(30_000);
    expect(h.procs.mysql!.signals[0]!.signal).toBe('SIGTERM');
    expect(h.killedUsers).toContain(process.getuid!());
  });

  it('includes the redacted tail of the server log in the start error', async () => {
    const p = await makePaths();
    const h = harness({ ready: () => false });
    const m = createServicesManager(p, {
      ...h.fakes,
      spawnServer: (s, argv) => {
        const log = join(p.dataDir, 'pgsql', 'server.log');
        writeFileSync(log, `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}\nFATAL: password pw-secret-1 rejected\n`);
        return h.fakes.spawnServer(s, argv);
      },
    });
    const err = (await m.start(['pgsql'], 'pw-secret-1', new AbortController().signal).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('PostgreSQL did not become ready within 30 seconds');
    expect(err.message).toContain('FATAL: password *** rejected');
    expect(err.message).not.toContain('pw-secret-1');
    expect(err.message).not.toContain('line 10\n');
    expect(err.message).toContain('line 11');
  });

  it('stops with SIGTERM, then SIGKILL after 10 s', async () => {
    const p = await makePaths();
    const h = harness({ ignoreTerm: true });
    const m = createServicesManager(p, h.fakes);
    await m.start(['redis'], 'pw', new AbortController().signal);
    const t0 = h.clock();
    await m.stopAll();
    expect(h.procs.redis!.signals).toEqual([{ signal: 'SIGTERM', at: t0 }, { signal: 'SIGKILL', at: t0 + 10_000 }]);
    expect(h.killedUsers).toEqual([process.getuid!()]);
  });

  it('a server that exits on SIGTERM is never SIGKILLed', async () => {
    const p = await makePaths();
    const h = harness();
    const m = createServicesManager(p, h.fakes);
    await m.start(['redis'], 'pw', new AbortController().signal);
    await m.stopAll();
    expect(h.procs.redis!.signals.map((s) => s.signal)).toEqual(['SIGTERM']);
  });

  it('aborting during readiness stops the server and rejects with AbortError, not ServiceStartError', async () => {
    const p = await makePaths();
    const ac = new AbortController();
    const h = harness({ ready: () => false, onSleep: (t) => { if (t >= 5_000) ac.abort(); } });
    const m = createServicesManager(p, h.fakes);
    const err = await m.start(['pgsql'], 'pw', ac.signal).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ServiceStartError);
    expect((err as Error).name).toBe('AbortError');
    expect(h.clock()).toBeLessThan(30_000);
    expect(h.procs.pgsql!.signals[0]!.signal).toBe('SIGTERM');
    // The data dir is still there for the caller's cleanup, which deletes it.
    expect(existsSync(join(p.dataDir, 'pgsql'))).toBe(true);
    await m.removeData();
    expect(await readdir(p.dataDir)).toEqual([]);
  });

  it('an aborted signal before start never spawns a server', async () => {
    const p = await makePaths();
    const ac = new AbortController();
    ac.abort();
    const h = harness();
    const err = await createServicesManager(p, h.fakes).start(['mysql'], 'pw', ac.signal).catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(h.procs.mysql).toBeUndefined();
  });

  it('removeData deletes the data and run dirs without following links', async () => {
    const p = await makePaths();
    const outside = await mkdtemp(join(tmpdir(), 'arco-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'keep'), 'keep');
    await mkdir(join(p.dataDir, 'mysql'), { recursive: true });
    await mkdir(join(p.runDir, 'pgsql'), { recursive: true });
    await symlink(outside, join(p.dataDir, 'link'));
    await symlink(outside, join(p.dataDir, 'mysql', 'inner-link'));
    await writeFile(join(p.runDir, 'pgsql', '.s.PGSQL.5432'), '');
    const m = createServicesManager(p, harness().fakes);
    await m.removeData();
    expect(await readdir(p.dataDir)).toEqual([]);
    expect(await readdir(p.runDir)).toEqual([]);
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('keep');
  });

  it('removeData never follows a data dir that is itself a link', async () => {
    const p = await makePaths();
    const outside = await mkdtemp(join(tmpdir(), 'arco-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'keep'), 'keep');
    await mkdir(join(p.dataDir, '..'), { recursive: true });
    await symlink(outside, p.dataDir);
    await createServicesManager(p, harness().fakes).removeData();
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('keep');
  });

  it('phpRedis is cached', async () => {
    const p = await makePaths();
    let calls = 0;
    const m = createServicesManager(p, { ...harness().fakes, phpHasRedis: async () => { calls++; return false; } });
    expect(await m.phpRedis({}, null)).toBe(false);
    expect(await m.phpRedis({}, null)).toBe(false);
    expect(calls).toBe(1);
  });
});

// Opt-in: real servers, only where they are installed (the runner image, as root).
const have = (bin: string) => { try { execFileSync('sh', ['-c', `command -v ${bin}`]); return true; } catch { return false; } };
describe.skipIf(!(process.getuid?.() === 0 && have('redis-server')))('real redis', () => {
  it('starts, answers and stops', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arco-real-'));
    roots.push(root);
    const bin = execFileSync('sh', ['-c', 'dirname "$(command -v redis-server)"'], { encoding: 'utf8' }).trim();
    const p: ServicePaths = { dataDir: join(root, 'data'), runDir: join(root, 'run'), templateDir: join(root, 't'), binDir: bin };
    const m = createServicesManager(p);
    const ms = await m.start(['redis'], 'pw', new AbortController().signal);
    expect(ms.redis).toBeGreaterThan(0);
    await m.stopAll();
    await m.removeData();
  }, 60_000);
});
