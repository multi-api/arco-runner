import { Redactor } from '@multi-api/arco-cloud-client';
import { describe, expect, it } from 'vitest';
import { parseJobDocument } from '../src/job/document.js';
import { BuildFailure } from '../src/job/errors.js';
import { cloneToken, registerJobSecrets, shortMaskValues } from '../src/mask.js';

const doc = () => parseJobDocument({
  deployment_id: 'd1', environment: 'production', mode: 'deploy', nonce: 'nonce-secret-77',
  runner_token: 'runner-token-xyz',
  source: { clone_url: 'https://github.com/o/r.git', auth_header: 'basic ' + btoa('x-access-token:ghs_abc123'), sha: 'a'.repeat(40), root_dir: null },
  php_version: '8.5', commands: [], env: {}, mask: ['hunter22', 'ab'],
  cache: { restore_url: 'https://s3/r?X-Amz-Signature=sigRESTORE99&a=b', save_url: 'https://s3/s?a=b&X-Amz-Signature=sigSAVE1234', key: 'k' },
  timeout_seconds: 60,
});

describe('cloneToken', () => {
  it('decodes the basic auth header', () => {
    expect(cloneToken('basic ' + btoa('x-access-token:ghs_abc123'))).toBe('ghs_abc123');
  });
  it('returns null for anything else', () => {
    expect(cloneToken('bearer abc')).toBeNull();
    expect(cloneToken('basic ' + btoa('user:pw'))).toBeNull();
  });
});

describe('registerJobSecrets', () => {
  it('redacts every secret, the clone token and signature values', () => {
    const d = doc();
    const r = new Redactor();
    registerJobSecrets(r, d);
    const line = [d.mask[0], d.runner_token, d.nonce, d.source.auth_header, 'ghs_abc123',
      d.cache.restore_url, d.cache.save_url, 'sigRESTORE99', 'sigSAVE1234'].join(' | ');
    const out = r.redact(line);
    for (const s of ['hunter22', 'runner-token-xyz', 'nonce-secret-77', 'ghs_abc123', 'sigRESTORE99', 'sigSAVE1234', 's3/r?', 's3/s?']) {
      expect(out).not.toContain(s);
    }
  });
  it('shortMaskValues counts values under 4 chars', () => {
    expect(shortMaskValues(doc())).toBe(1);
  });
});

describe('BuildFailure', () => {
  it('carries a code', () => {
    const e = new BuildFailure('build.timeout', 'x');
    expect(e.code).toBe('build.timeout');
    expect(e.message).toBe('x');
  });
});
