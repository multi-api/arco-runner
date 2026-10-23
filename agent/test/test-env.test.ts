import { mkdtemp, readFile, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestsSpec } from '../src/job/document.js';
import type { Paths } from '../src/system.js';
import { copyEnvExample, ephemeralAppKey, generatePassword, hasAppKey, serviceVariables, testEnv } from '../src/tests/env.js';

const paths: Paths = { home: '/home/build', repo: '/r', tmpDirs: [], agentDir: '/a', varDir: '/v' };
const tests = (env: Record<string, string> = {}): TestsSpec => ({
  command: 'php artisan test', setup_commands: [], services: [], primary_database: null, timeout_seconds: 900, env, mask: [],
});

describe('serviceVariables', () => {
  it('injects the MySQL, PostgreSQL and Redis variables of spec §5.3', () => {
    expect(serviceVariables(['mysql'], 'mysql', 'pw', 'phpredis')).toEqual({
      DB_CONNECTION: 'mysql', DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_DATABASE: 'testing', DB_USERNAME: 'arco', DB_PASSWORD: 'pw',
    });
    expect(serviceVariables(['pgsql'], 'pgsql', 'pw', 'phpredis')).toEqual({
      DB_CONNECTION: 'pgsql', DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_DATABASE: 'testing', DB_USERNAME: 'arco', DB_PASSWORD: 'pw',
    });
    expect(serviceVariables(['redis'], null, 'pw', 'phpredis')).toEqual({
      REDIS_HOST: '127.0.0.1', REDIS_PORT: '6379', REDIS_PASSWORD: 'null', REDIS_CLIENT: 'phpredis',
    });
  });
  it('gives the primary DB_* and the other database DB_<MYSQL|PGSQL>_*', () => {
    const v = serviceVariables(['mysql', 'pgsql'], 'pgsql', 'pw', 'phpredis');
    expect(v.DB_CONNECTION).toBe('pgsql');
    expect(v.DB_PORT).toBe('5432');
    expect(v.DB_MYSQL_PORT).toBe('3306');
    expect(v.DB_MYSQL_USERNAME).toBe('arco');
    expect(Object.keys(v).some((k) => k.startsWith('DB_PGSQL_'))).toBe(false);
  });
  it('uses predis when phpredis is missing', () => {
    expect(serviceVariables(['redis'], null, 'pw', 'predis').REDIS_CLIENT).toBe('predis');
  });
});

describe('testEnv', () => {
  it('applies precedence: services > test variables > defaults; PATH/HOME/USER fixed', () => {
    const svc = serviceVariables(['mysql'], 'mysql', 'pw', 'phpredis');
    const env = testEnv(paths, tests({ DB_HOST: 'x', APP_ENV: 'local', PATH: '/evil' }), svc, null);
    expect(env.DB_HOST).toBe('127.0.0.1');
    expect(env.APP_ENV).toBe('local');
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(testEnv(paths, tests(), {}, null).APP_ENV).toBe('testing');
    expect(testEnv(paths, tests(), {}, 'base64:k').APP_KEY).toBe('base64:k');
  });
  it('never carries AWS variables or the permissions boundary', () => {
    const env = testEnv(paths, tests({ AWS_SECRET_ACCESS_KEY: 's', AWS_REGION: 'r', ARCO_PERMISSIONS_BOUNDARY: 'b', KEEP: '1' }), {}, null);
    expect(Object.keys(env).filter((k) => k.startsWith('AWS_') || k === 'ARCO_PERMISSIONS_BOUNDARY')).toEqual([]);
    expect(env.KEEP).toBe('1');
  });
});

describe('files', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tenv-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('finds an APP_KEY in env, .env.testing, .env, phpunit.xml and phpunit.xml.dist, ignoring empty values', async () => {
    expect(await hasAppKey(dir, {})).toBe(false);
    expect(await hasAppKey(dir, { APP_KEY: 'base64:abc' })).toBe(true);
    expect(await hasAppKey(dir, { APP_KEY: '' })).toBe(false);
    const cases: Array<[string, string]> = [
      ['.env.testing', 'FOO=1\nAPP_KEY="base64:abc"\n'],
      ['.env', 'APP_KEY=base64:abc'],
      ['phpunit.xml', '<phpunit><php><env name="APP_KEY" value="base64:abc"/></php></phpunit>'],
      ['phpunit.xml.dist', '<phpunit><php><server name="APP_KEY" value="base64:abc"/></php></phpunit>'],
    ];
    for (const [file, body] of cases) {
      const d = await mkdtemp(join(tmpdir(), 'tenv-'));
      await writeFile(join(d, file), body);
      expect(await hasAppKey(d, {}), file).toBe(true);
      await rm(d, { recursive: true, force: true });
    }
    for (const body of ['APP_KEY=', 'APP_KEY=""', '# APP_KEY=base64:x', 'XAPP_KEY=base64:x']) {
      await writeFile(join(dir, '.env'), body);
      expect(await hasAppKey(dir, {}), body).toBe(false);
    }
    await writeFile(join(dir, 'phpunit.xml'), '<env name="APP_KEY" value=""/>');
    expect(await hasAppKey(dir, {})).toBe(false);
  });
  it('does not read a .env that is a symlink', async () => {
    await writeFile(join(dir, 'real'), 'APP_KEY=base64:abc');
    await symlink(join(dir, 'real'), join(dir, '.env'));
    expect(await hasAppKey(dir, {})).toBe(false);
  });
  it('ephemeralAppKey is base64: plus 32 bytes', () => {
    const k = ephemeralAppKey();
    expect(k.startsWith('base64:')).toBe(true);
    expect(Buffer.from(k.slice(7), 'base64')).toHaveLength(32);
    expect(ephemeralAppKey()).not.toBe(k);
  });
  it('generatePassword is 48 hex characters and random', () => {
    expect(generatePassword()).toMatch(/^[0-9a-f]{48}$/);
    expect(generatePassword()).not.toBe(generatePassword());
  });
  it('copies .env.example only when .env is absent, never over a committed or dangling .env', async () => {
    await writeFile(join(dir, '.env.example'), 'A=1\n');
    expect(await copyEnvExample(dir, null)).toBe(true);
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('A=1\n');
    expect(await copyEnvExample(dir, null)).toBe(false);
    expect(await readFile(join(dir, '.env'), 'utf8')).toBe('A=1\n');

    const d = await mkdtemp(join(tmpdir(), 'tenv-'));
    await writeFile(join(d, '.env.example'), 'A=1\n');
    await symlink(join(d, 'nowhere'), join(d, '.env'));
    expect(await copyEnvExample(d, null)).toBe(false);
    await expect(lstat(join(d, 'nowhere'))).rejects.toThrow();
    await rm(d, { recursive: true, force: true });
  });
  it('does not follow a symlinked .env.example', async () => {
    await writeFile(join(dir, 'secret'), 'S=1');
    await symlink(join(dir, 'secret'), join(dir, '.env.example'));
    expect(await copyEnvExample(dir, null)).toBe(false);
    await expect(lstat(join(dir, '.env'))).rejects.toThrow();
  });
  it('returns false when there is no .env.example', async () => {
    expect(await copyEnvExample(dir, null)).toBe(false);
  });
});
