import { describe, expect, it } from 'vitest';
import { InvalidJobDocument, InvalidTicketPayload, parseJobDocument, parseTicketPayload } from '../src/job/document.js';

const valid = () => ({
  deployment_id: 'd1', environment: 'production', mode: 'deploy', nonce: 'n-0123456789',
  runner_token: 'tok_abcdef',
  source: { clone_url: 'https://github.com/o/r.git', auth_header: 'basic eC1hY2Nlc3MtdG9rZW46Z2hz', sha: 'a'.repeat(40), root_dir: 'app' },
  php_version: '8.5', commands: ['composer install'], env: { A: 'b' }, mask: ['hunter22'],
  cache: { restore_url: 'https://s3/r?X-Amz-Signature=aa', save_url: 'https://s3/s?X-Amz-Signature=bb', key: 'k' },
  timeout_seconds: 600,
});

describe('parseJobDocument', () => {
  it('parses a full valid document', () => {
    expect(parseJobDocument(valid())).toEqual({ ...valid(), defer_credentials: false, tests: null });
  });
  it('throws on missing runner_token', () => {
    const d: any = valid(); delete d.runner_token;
    expect(() => parseJobDocument(d)).toThrow(InvalidJobDocument);
  });
  it('throws on unknown mode', () => {
    expect(() => parseJobDocument({ ...valid(), mode: 'other' })).toThrow(InvalidJobDocument);
  });
  it('normalises null root_dir to empty string', () => {
    const d: any = valid(); d.source.root_dir = null;
    expect(parseJobDocument(d).source!.root_dir).toBe('');
  });
  it('ignores extra keys', () => {
    const d: any = { ...valid(), extra: 1 }; d.source.more = 2;
    expect(parseJobDocument(d)).toEqual({ ...valid(), defer_credentials: false, tests: null });
  });
  it('rejects a bad sha', () => {
    const d: any = valid(); d.source.sha = 'ABC';
    expect(() => parseJobDocument(d)).toThrow(InvalidJobDocument);
  });
  it('accepts a remove document with null source', () => {
    const d = parseJobDocument({ ...valid(), mode: 'remove', source: null, commands: [], cache: null, tests: null });
    expect(d.mode).toBe('remove');
    expect(d.source).toBeNull();
    expect(d.cache).toBeNull();
    expect(d.commands).toEqual([]);
    expect(d.tests).toBeNull();
  });
  it('accepts a remove document with a source', () => {
    const d = parseJobDocument({ ...valid(), mode: 'remove', commands: [], cache: null });
    expect(d.source).toEqual({ ...valid().source });
    expect(d.cache).toBeNull();
  });
  it('drops a cache sent with a remove: a remove never restores or saves one', () => {
    expect(parseJobDocument({ ...valid(), mode: 'remove', commands: [] }).cache).toBeNull();
  });
  it('rejects null source for deploy', () => {
    expect(() => parseJobDocument({ ...valid(), source: null })).toThrow(InvalidJobDocument);
    expect(() => parseJobDocument({ ...valid(), mode: 'inventory', source: null })).toThrow(InvalidJobDocument);
  });
  it('rejects null cache for deploy and inventory', () => {
    expect(() => parseJobDocument({ ...valid(), cache: null })).toThrow(InvalidJobDocument);
    expect(() => parseJobDocument({ ...valid(), mode: 'inventory', cache: null })).toThrow(InvalidJobDocument);
  });
  it('accepts a tenants_restore document with null source', () => {
    const d = parseJobDocument({ ...valid(), mode: 'tenants_restore', source: null, commands: [], cache: null, tests: null });
    expect(d.mode).toBe('tenants_restore');
    expect(d.source).toBeNull();
    expect(d.cache).toBeNull();
    expect(d.tests).toBeNull();
  });
  it('accepts a tenants_restore document with a source', () => {
    const d = parseJobDocument({ ...valid(), mode: 'tenants_restore', commands: [], cache: null });
    expect(d.source).toEqual({ ...valid().source });
    expect(d.cache).toBeNull();
  });
  it('drops a cache sent with a tenants_restore', () => {
    expect(parseJobDocument({ ...valid(), mode: 'tenants_restore', commands: [] }).cache).toBeNull();
  });
  it('rejects a missing source for tenants_restore (null only)', () => {
    const d: any = { ...valid(), mode: 'tenants_restore', cache: null }; delete d.source;
    expect(() => parseJobDocument(d)).toThrow(InvalidJobDocument);
  });
  it('keeps no trace of the remove key: the agent never derives --force from the job document', () => {
    const d = parseJobDocument({ ...valid(), mode: 'remove', source: null, cache: null, remove: { force: true } });
    expect(d).not.toHaveProperty('remove');
  });
  it('rejects a missing source for remove (null only)', () => {
    const d: any = { ...valid(), mode: 'remove', cache: null }; delete d.source;
    expect(() => parseJobDocument(d)).toThrow(InvalidJobDocument);
  });
  it('rejects non-objects and wrong field types', () => {
    expect(() => parseJobDocument(null)).toThrow(InvalidJobDocument);
    expect(() => parseJobDocument({ ...valid(), commands: [1] })).toThrow(InvalidJobDocument);
    expect(() => parseJobDocument({ ...valid(), env: { A: 1 } })).toThrow(InvalidJobDocument);
    expect(() => parseJobDocument({ ...valid(), timeout_seconds: '5' })).toThrow(InvalidJobDocument);
  });
});

const testsBlock = () => ({
  command: 'php artisan test --parallel', setup_commands: ['composer install', 'npm ci', 'npm run build'],
  services: ['pgsql', 'redis'], primary_database: 'pgsql', timeout_seconds: 900,
  env: { SANDBOX_API_KEY: 'k' }, mask: ['sandbox-secret'],
});

describe('parseJobDocument tests block', () => {
  it('parses tests and defer_credentials', () => {
    const doc = parseJobDocument({ ...valid(), defer_credentials: true, tests: testsBlock() });
    expect(doc.tests!.services).toEqual(['pgsql', 'redis']);
    expect(doc.tests!.primary_database).toBe('pgsql');
    expect(doc.tests!.timeout_seconds).toBe(900);
    expect(doc.tests!.command).toBe('php artisan test --parallel');
    expect(doc.tests!.setup_commands).toHaveLength(3);
    expect(doc.tests!.env).toEqual({ SANDBOX_API_KEY: 'k' });
    expect(doc.tests!.mask).toEqual(['sandbox-secret']);
    expect(doc.defer_credentials).toBe(true);
  });
  it('treats absent or null tests as null and absent defer_credentials as false', () => {
    expect(parseJobDocument(valid()).tests).toBeNull();
    expect(parseJobDocument({ ...valid(), tests: null }).tests).toBeNull();
    expect(parseJobDocument(valid()).defer_credentials).toBe(false);
    expect(parseJobDocument({ ...valid(), defer_credentials: 'true' }).defer_credentials).toBe(false);
    expect(parseJobDocument({ ...valid(), defer_credentials: 1 }).defer_credentials).toBe(false);
  });
  it('defaults timeout_seconds to 900 and the primary to the first database listed', () => {
    const t = parseJobDocument({ ...valid(), tests: { ...testsBlock(), services: ['redis', 'mysql', 'pgsql'], primary_database: null, timeout_seconds: null } }).tests!;
    expect(t.primary_database).toBe('mysql');
    expect(t.timeout_seconds).toBe(900);
    const r = parseJobDocument({ ...valid(), tests: { ...testsBlock(), services: ['redis'], primary_database: null } }).tests!;
    expect(r.primary_database).toBeNull();
  });
  it('accepts floci, which is never a primary database', () => {
    const t = parseJobDocument({ ...valid(), tests: { ...testsBlock(), services: ['floci', 'pgsql'], primary_database: null } }).tests!;
    expect(t.services).toEqual(['floci', 'pgsql']);
    expect(t.primary_database).toBe('pgsql');
    expect(parseJobDocument({ ...valid(), tests: { ...testsBlock(), services: ['floci'], primary_database: null } }).tests!.primary_database).toBeNull();
  });
  it('accepts an empty JSON array as an empty env and treats a non-positive timeout as 900', () => {
    const d = parseJobDocument({ ...valid(), env: [], tests: { ...testsBlock(), env: [], timeout_seconds: 0 } });
    expect(d.env).toEqual({});
    expect(d.tests!.env).toEqual({});
    expect(d.tests!.timeout_seconds).toBe(900);
    expect(parseJobDocument({ ...valid(), tests: { ...testsBlock(), timeout_seconds: -5 } }).tests!.timeout_seconds).toBe(900);
    expect(() => parseJobDocument({ ...valid(), env: ['x'] })).toThrow(InvalidJobDocument);
    expect(() => parseJobDocument({ ...valid(), tests: { ...testsBlock(), env: ['x'] } })).toThrow(InvalidJobDocument);
    expect(() => parseJobDocument({ ...valid(), tests: { ...testsBlock(), timeout_seconds: '5' } })).toThrow(InvalidJobDocument);
  });
  it('rejects unknown services, duplicates, a primary that is not selected, and non-string env values', () => {
    const bad = (t: object) => expect(() => parseJobDocument({ ...valid(), tests: { ...testsBlock(), ...t } })).toThrow(InvalidJobDocument);
    bad({ services: ['mongo'] });
    bad({ services: ['redis', 'redis'] });
    bad({ services: ['floci'], primary_database: 'floci' });
    bad({ services: ['redis'], primary_database: 'pgsql' });
    bad({ env: { A: 1 } });
  });
});

describe('parseTicketPayload', () => {
  const t = { ticket: 'tk', api_base: 'https://cloud.example.com', deployment_id: 'd1' };
  it('parses a valid payload', () => {
    expect(parseTicketPayload({ ...t, extra: 1 }, false)).toEqual(t);
  });
  it('rejects http api_base unless allowHttp', () => {
    const h = { ...t, api_base: 'http://localhost:8000' };
    expect(() => parseTicketPayload(h, false)).toThrow(InvalidTicketPayload);
    expect(parseTicketPayload(h, true)).toEqual(h);
  });
  it('rejects missing fields', () => {
    expect(() => parseTicketPayload({ api_base: t.api_base }, false)).toThrow(InvalidTicketPayload);
  });
});
