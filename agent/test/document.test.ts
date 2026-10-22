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
    expect(parseJobDocument(valid())).toEqual(valid());
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
    expect(parseJobDocument(d).source.root_dir).toBe('');
  });
  it('ignores extra keys', () => {
    const d: any = { ...valid(), extra: 1 }; d.source.more = 2;
    expect(parseJobDocument(d)).toEqual(valid());
  });
  it('rejects a bad sha', () => {
    const d: any = valid(); d.source.sha = 'ABC';
    expect(() => parseJobDocument(d)).toThrow(InvalidJobDocument);
  });
  it('rejects non-objects and wrong field types', () => {
    expect(() => parseJobDocument(null)).toThrow(InvalidJobDocument);
    expect(() => parseJobDocument({ ...valid(), commands: [1] })).toThrow(InvalidJobDocument);
    expect(() => parseJobDocument({ ...valid(), env: { A: 1 } })).toThrow(InvalidJobDocument);
    expect(() => parseJobDocument({ ...valid(), timeout_seconds: '5' })).toThrow(InvalidJobDocument);
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
