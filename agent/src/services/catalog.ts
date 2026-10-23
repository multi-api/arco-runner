import type { ServiceName } from '../job/document.js';

/** Where the test services live (spec §5.1). */
export interface ServicePaths {
  /** /var/lib/arco-services: one fresh `<service>` dir per build. */
  dataDir: string;
  /** /run/arco-services: sockets, one `<service>` dir each. */
  runDir: string;
  /** /opt/arco-services/templates: pristine initialised data dirs (mysql, pgsql). */
  templateDir: string;
  /** /usr/local/bin: server, probe and client binaries. */
  binDir: string;
}

export const defaultServicePaths = (): ServicePaths => ({
  dataDir: '/var/lib/arco-services',
  runDir: '/run/arco-services',
  templateDir: '/opt/arco-services/templates',
  binDir: '/usr/local/bin',
});

export type DatabaseService = Exclude<ServiceName, 'redis'>;

export const SERVICE_PORTS = { mysql: 3306, pgsql: 5432, redis: 6379 } as const satisfies Record<ServiceName, number>;
export const SERVICE_USERS = { mysql: 'mysql', pgsql: 'postgres', redis: 'redis' } as const satisfies Record<ServiceName, string>;
/**
 * The test services' system users looked up in `/etc/passwd` text: each one's uid, and the names that are missing.
 * A user with uid 0 or a malformed uid counts as missing.
 */
export function serviceUserIds(passwd: string): { uids: Partial<Record<ServiceName, number>>; missing: string[] } {
  const rows = passwd.split('\n').map((l) => l.split(':'));
  const uids: Partial<Record<ServiceName, number>> = {};
  const missing: string[] = [];
  for (const [s, name] of Object.entries(SERVICE_USERS) as Array<[ServiceName, string]>) {
    const uid = rows.find((f) => f[0] === name)?.[2] ?? '';
    if (/^\d+$/.test(uid) && Number(uid) > 0) uids[s] = Number(uid);
    else missing.push(name);
  }
  return { uids, missing };
}
export const SERVICE_LABELS = { mysql: 'MySQL', pgsql: 'PostgreSQL', redis: 'Redis' } as const satisfies Record<ServiceName, string>;

export const SYSTEM_DATABASES: Record<DatabaseService, readonly string[]> = {
  mysql: ['mysql', 'information_schema', 'performance_schema', 'sys'],
  pgsql: ['postgres', 'template0', 'template1'],
};

const HOST = '127.0.0.1';

/** The PostgreSQL client-authentication file, root-owned in the root-owned runDir. */
export const pgHbaPath = (p: ServicePaths) => `${p.runDir}/pg_hba.conf`;

/** Superuser only over the 0700 socket by peer; `arco` over 127.0.0.1 by password; every other TCP login refused. */
export const PG_HBA = [
  'local all postgres peer',
  'host all arco 127.0.0.1/32 scram-sha-256',
  'host all all 0.0.0.0/0 reject',
  'host all all ::/0 reject',
  '',
].join('\n');

/** The server argv (argv[0] is the binary). Never carries a secret. `redisMajor` gates the Redis 7-only flags. */
export function serverArgv(s: ServiceName, p: ServicePaths, redisMajor: number): string[] {
  const data = `${p.dataDir}/${s}`;
  switch (s) {
    case 'mysql':
      return [
        `${p.binDir}/mysqld`,
        '--no-defaults', // must come first: no /etc/my.cnf from the packages
        `--datadir=${data}`,
        `--socket=${p.runDir}/mysql/mysqld.sock`,
        `--bind-address=${HOST}`,
        // The template's root@localhost has no password: without name resolution a 127.0.0.1 TCP connection
        // never matches `localhost`, so those accounts are reachable only through the 0700 socket.
        '--skip-name-resolve',
        `--port=${SERVICE_PORTS.mysql}`,
        '--mysqlx=OFF',
        '--skip-log-bin',
        '--secure-file-priv=NULL',
        '--performance-schema=OFF',
        '--innodb-flush-log-at-trx-commit=0',
        '--innodb-redo-log-capacity=8M', // the template is initialised with the same 8M, so no redo resize at start
        `--log-error=${data}/error.log`,
      ];
    case 'pgsql':
      return [
        `${p.binDir}/postgres`,
        '-D', data,
        '-c', `listen_addresses=${HOST}`,
        '-c', `port=${SERVICE_PORTS.pgsql}`,
        '-k', `${p.runDir}/pgsql`,
        '-c', 'fsync=off',
        '-c', 'synchronous_commit=off',
        '-c', 'full_page_writes=off',
        // Never the template's pg_hba.conf (initdb trusts host lines): ours is written by root at start.
        '-c', `hba_file=${pgHbaPath(p)}`,
        '-c', 'password_encryption=scram-sha-256',
      ];
    case 'redis':
      return [
        `${p.binDir}/redis-server`,
        '--bind', HOST,
        '--port', String(SERVICE_PORTS.redis),
        '--dir', data,
        '--save', '',
        '--appendonly', 'no',
        '--protected-mode', 'yes',
        // Redis 6 has no enable-* switches: the commands are disabled by renaming them to "" instead.
        ...(redisMajor >= 7
          ? ['--enable-protected-configs', 'no', '--enable-module-command', 'no']
          : ['--rename-command', 'MODULE', '', '--rename-command', 'CONFIG', '']),
        '--rename-command', 'DEBUG', '',
      ];
  }
}

/** Readiness probe over TCP, so "ready" means the 127.0.0.1 listener the tests use is up. */
export function probeArgv(s: ServiceName, p: ServicePaths): string[] {
  switch (s) {
    case 'mysql':
      // mysqladmin exits 0 whenever the server is running, even on "Access denied" (MySQL manual, mysqladmin):
      // root has no TCP access (--skip-name-resolve), and a running server still counts as ready.
      return [`${p.binDir}/mysqladmin`, '--no-defaults', '--protocol=TCP', `--host=${HOST}`, `--port=${SERVICE_PORTS.mysql}`, '--user=root', '--connect-timeout=2', 'ping'];
    case 'pgsql':
      return [`${p.binDir}/pg_isready`, '-h', HOST, '-p', String(SERVICE_PORTS.pgsql), '-t', '2'];
    case 'redis':
      return [`${p.binDir}/redis-cli`, '-h', HOST, '-p', String(SERVICE_PORTS.redis), 'ping'];
  }
}

/** The admin client over the server's socket (root for MySQL, `postgres` for PostgreSQL). SQL goes on stdin. */
export function adminArgv(s: DatabaseService, p: ServicePaths): string[] {
  switch (s) {
    case 'mysql':
      return [`${p.binDir}/mysql`, '--no-defaults', `--socket=${p.runDir}/mysql/mysqld.sock`, '--user=root', '--batch', '--skip-column-names'];
    case 'pgsql':
      return [`${p.binDir}/psql`, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', `${p.runDir}/pgsql`, '-p', String(SERVICE_PORTS.pgsql), '-U', 'postgres', '-d', 'postgres'];
  }
}

/** A SQL string literal. MySQL also treats a backslash as an escape (default sql_mode). */
const literal = (s: DatabaseService, v: string) =>
  `'${(s === 'mysql' ? v.replace(/\\/g, '\\\\') : v).replace(/'/g, "''")}'`;

const identifier = (s: DatabaseService, name: string) =>
  s === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`;

/** Database `testing` and user `arco`, who may create more `testing*` databases (`--parallel`). */
export function createSql(s: DatabaseService, password: string): string {
  return s === 'mysql'
    ? `CREATE DATABASE testing; CREATE USER 'arco'@'%' IDENTIFIED BY ${literal(s, password)}; GRANT ALL ON \`testing%\`.* TO 'arco'@'%';`
    : `CREATE ROLE arco LOGIN CREATEDB PASSWORD ${literal(s, password)}; CREATE DATABASE testing OWNER arco;`;
}

export function listDatabasesSql(s: DatabaseService): string {
  return s === 'mysql' ? 'SHOW DATABASES;' : 'SELECT datname FROM pg_database;';
}

/** One statement per database: PostgreSQL cannot drop a database inside a transaction block. */
export function dropSql(s: DatabaseService, names: string[]): string {
  return names.map((n) => `DROP DATABASE IF EXISTS ${identifier(s, n)}${s === 'pgsql' ? ' WITH (FORCE)' : ''};`).join(' ');
}
