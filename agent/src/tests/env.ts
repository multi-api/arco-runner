import { randomBytes } from 'node:crypto';
import { lstat, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readPlainFile } from '../fsutil.js';
import type { ServiceName, TestsSpec } from '../job/document.js';
import { buildEnv, type Identity, type Paths } from '../system.js';

const MAX_FILE_BYTES = 1024 * 1024;
const DB = { mysql: { connection: 'mysql', port: '3306' }, pgsql: { connection: 'pgsql', port: '5432' } } as const;

/** The language of the code under test: decides Laravel's extras (PHP) or the URL variables Go libraries read (Go). */
export type TestLanguage = 'php' | 'go';

/**
 * Variables injected for the selected services (spec §5.3). The primary database gets DB_*, the other DB_<NAME>_*.
 * Go also gets URLs: DATABASE_URL for the primary database (DATABASE_<NAME>_URL for the other) and REDIS_URL. Redis has no
 * password, so a Go app gets no REDIS_PASSWORD (Laravel reads the string "null" as none) and no REDIS_CLIENT.
 */
export function serviceVariables(
  services: ServiceName[],
  primary: 'mysql' | 'pgsql' | null,
  password: string,
  redisClient: 'phpredis' | 'predis' | null,
  language: TestLanguage = 'php',
): Record<string, string> {
  const out: Record<string, string> = {};
  const dbs = (['mysql', 'pgsql'] as const).filter((d) => services.includes(d));
  const main = dbs.length === 1 ? dbs[0] : dbs.length === 2 ? (primary ?? 'mysql') : null;
  for (const d of dbs) {
    const prefix = d === main ? 'DB_' : `DB_${d.toUpperCase()}_`;
    if (d === main) out.DB_CONNECTION = DB[d].connection;
    out[`${prefix}HOST`] = '127.0.0.1';
    out[`${prefix}PORT`] = DB[d].port;
    out[`${prefix}DATABASE`] = 'testing';
    out[`${prefix}USERNAME`] = 'arco';
    out[`${prefix}PASSWORD`] = password;
    if (language === 'go') out[d === main ? 'DATABASE_URL' : `DATABASE_${d.toUpperCase()}_URL`] = databaseUrl(d, password);
  }
  if (services.includes('redis')) {
    out.REDIS_HOST = '127.0.0.1';
    out.REDIS_PORT = '6379';
    if (language === 'go') {
      out.REDIS_URL = 'redis://127.0.0.1:6379/0';
    } else {
      out.REDIS_PASSWORD = 'null';
      out.REDIS_CLIENT = redisClient ?? 'phpredis';
    }
  }
  return out;
}

/** The password is hex (generatePassword), so it needs no escaping. The local server has no TLS, hence sslmode=disable. */
const databaseUrl = (d: 'mysql' | 'pgsql', password: string): string => d === 'mysql'
  ? `mysql://arco:${password}@127.0.0.1:3306/testing`
  : `postgres://arco:${password}@127.0.0.1:5432/testing?sslmode=disable`;

/** Precedence: services > tests.env > build defaults (APP_ENV=testing for PHP). Never AWS credentials nor the permissions boundary. */
export function testEnv(
  paths: Paths, tests: TestsSpec, serviceVars: Record<string, string>, appKey: string | null, language: TestLanguage = 'php',
): NodeJS.ProcessEnv {
  const defaults: Record<string, string> = language === 'php' ? { APP_ENV: 'testing' } : {};
  const env = buildEnv(paths, { ...defaults, ...tests.env, ...serviceVars, ...(appKey ? { APP_KEY: appKey } : {}) });
  for (const k of Object.keys(env)) if (/^aws_/i.test(k) || k.toUpperCase() === 'ARCO_PERMISSIONS_BOUNDARY') delete env[k];
  return env;
}

const dotenvHasKey = (text: string): boolean => {
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?APP_KEY\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    const v = m[1]!.trim();
    const q = /^(["'])(.*?)\1/.exec(v);
    // Linear emptiness check: an unquoted value is empty when blank or when a comment starts it.
    if (q ? q[2]! !== '' : v !== '' && !v.startsWith('#')) return true;
  }
  return false;
};

/** Removes `<!-- -->` comments in one linear pass; an unterminated one runs to the end. */
const stripXmlComments = (text: string): string => {
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf('<!--', i);
    if (open < 0) return out + text.slice(i);
    out += text.slice(i, open);
    const close = text.indexOf('-->', open + 4);
    if (close < 0) return out;
    i = close + 3;
  }
};

const phpunitHasKey = (text: string): boolean => {
  // [^<>] (not [^>]) keeps the scan linear: a run of unterminated "<env" cannot rescan to the end each time.
  for (const tag of stripXmlComments(text).match(/<(?:env|server)\b[^<>]*>/gi) ?? []) {
    if (!/\bname\s*=\s*(["'])APP_KEY\1/.test(tag)) continue;
    const v = /\bvalue\s*=\s*(["'])(.*?)\1/.exec(tag);
    if (v && v[2]!.trim() !== '') return true;
  }
  return false;
};

/** True when a non-empty APP_KEY comes from env, .env.testing, .env, phpunit.xml or phpunit.xml.dist (links never followed). */
export async function hasAppKey(projectDir: string, env: Record<string, string>): Promise<boolean> {
  if ((env.APP_KEY ?? '') !== '') return true;
  for (const [file, check] of [
    ['.env.testing', dotenvHasKey], ['.env', dotenvHasKey], ['phpunit.xml', phpunitHasKey], ['phpunit.xml.dist', phpunitHasKey],
  ] as const) {
    const buf = await readPlainFile(join(projectDir, file), MAX_FILE_BYTES);
    if (buf && check(buf.toString('utf8'))) return true;
  }
  return false;
}

export const ephemeralAppKey = (): string => 'base64:' + randomBytes(32).toString('base64');

export const generatePassword = (): string => randomBytes(24).toString('hex');

/**
 * Copies `.env.example` to `.env` when `.env` is absent (lstat: a dangling link counts as present).
 * The source is read only if a regular file; the target is created O_EXCL and chowned to the build identity.
 */
export async function copyEnvExample(projectDir: string, identity: Identity | null): Promise<boolean> {
  const target = join(projectDir, '.env');
  try {
    await lstat(target);
    return false;
  } catch { /* absent */ }
  const content = await readPlainFile(join(projectDir, '.env.example'), MAX_FILE_BYTES);
  if (!content) return false;
  let fh;
  try {
    fh = await open(target, 'wx', 0o644);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    await fh.writeFile(content);
    if (identity) await fh.chown(identity.uid, identity.gid);
  } catch (e) {
    await fh.close();
    fh = undefined;
    await rm(target, { force: true });
    throw e;
  } finally {
    await fh?.close();
  }
  return true;
}
