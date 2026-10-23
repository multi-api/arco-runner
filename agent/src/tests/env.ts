import { randomBytes } from 'node:crypto';
import { lstat, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readPlainFile } from '../fsutil.js';
import type { ServiceName, TestsSpec } from '../job/document.js';
import { buildEnv, type Identity, type Paths } from '../system.js';

const MAX_FILE_BYTES = 1024 * 1024;
const DB = { mysql: { connection: 'mysql', port: '3306' }, pgsql: { connection: 'pgsql', port: '5432' } } as const;

/** Variables injected for the selected services (spec §5.3). The primary database gets DB_*, the other DB_<NAME>_*. */
export function serviceVariables(
  services: ServiceName[],
  primary: 'mysql' | 'pgsql' | null,
  password: string,
  redisClient: 'phpredis' | 'predis',
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
  }
  if (services.includes('redis')) {
    out.REDIS_HOST = '127.0.0.1';
    out.REDIS_PORT = '6379';
    out.REDIS_PASSWORD = 'null';
    out.REDIS_CLIENT = redisClient;
  }
  return out;
}

/** Precedence: services > tests.env > build defaults. Never AWS credentials nor the permissions boundary. */
export function testEnv(paths: Paths, tests: TestsSpec, serviceVars: Record<string, string>, appKey: string | null): NodeJS.ProcessEnv {
  const env = buildEnv(paths, { APP_ENV: 'testing', ...tests.env, ...serviceVars, ...(appKey ? { APP_KEY: appKey } : {}) });
  for (const k of Object.keys(env)) if (k.startsWith('AWS_') || k === 'ARCO_PERMISSIONS_BOUNDARY') delete env[k];
  return env;
}

const dotenvHasKey = (text: string): boolean => {
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?APP_KEY\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[1]!.trim();
    const q = /^(["'])(.*?)\1/.exec(v);
    v = q ? q[2]! : v.replace(/\s+#.*$/, '').trim();
    if (v !== '') return true;
  }
  return false;
};

const phpunitHasKey = (text: string): boolean => {
  for (const tag of text.match(/<(?:env|server)\b[^>]*>/gi) ?? []) {
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
  } catch {
    return false;
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
