import { CloudApiError, Redactor } from '@multiapi/arco-cloud-client';
import { afterEach, describe, expect, it } from 'vitest';
import { completeSession, issueCredentials, MalformedAnswer, openSession, RUNNER_CAPABILITIES } from '../src/job/session.js';
import { startFakeCloud, type FakeCloud, type FakeCloudOptions } from '../src/loopback-cloud.js';

const TOKEN = 'rt_runnertoken_0123456789abcdef';
const NONCE = 'nonce_0123456789abcdef';
const FAKE_KEY = 'AKIAFAKECLOUD0000001';
const FAKE_SECRET = 'fake/Secret+Access+Key/0123456789abcdefABCD';

const clouds: FakeCloud[] = [];
afterEach(async () => { for (const c of clouds.splice(0)) await c.close(); });

async function cloud(o: Partial<FakeCloudOptions> = {}): Promise<FakeCloud> {
  const c = await startFakeCloud({
    job: { deployment_id: 'dep_1', runner_token: TOKEN, environment: 'production', mode: 'deploy', tests: null },
    ticket: 'tkt', ...o,
  });
  clouds.push(c);
  return c;
}

const open = (c: FakeCloud, redactor: Redactor, defer = true) =>
  openSession({ apiBase: c.url, token: TOKEN, deploymentId: 'dep_1', nonce: NONCE, defer, redactor, warn: () => {}, keepAliveMs: 60_000 });

describe('config layer', () => {
  it.each([[{ schema: 1 }], [null]])('carries config %j from start into the completed session', async (config) => {
    const c = await cloud({ config });
    const opened = await open(c, new Redactor());
    expect(opened.config).toEqual(config);
    const issued = await issueCredentials({ apiBase: c.url, token: TOKEN, deploymentId: 'dep_1' });
    expect(completeSession(opened, issued, new Redactor()).started.config).toEqual(config);
  });

  it('throws a MalformedAnswer naming the field when config is not an object', async () => {
    const c = await cloud({ startAnswer: { status: 200, body: { environment: 'production', mode: 'deploy', credentials: null, config: [1] } } });
    const e = await open(c, new Redactor()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MalformedAnswer);
    expect((e as Error).message).toBe('Arco Cloud start answer was malformed (config)');
  });
});

describe('RUNNER_CAPABILITIES', () => {
  it('is what start announces', () => {
    expect(RUNNER_CAPABILITIES).toEqual(['external_dns']);
  });
});

describe('openSession', () => {
  it('sends defer_credentials and returns no credentials', async () => {
    const c = await cloud();
    const o = await open(c, new Redactor());
    try {
      expect(JSON.parse(c.calls('/start')[0]!.body.toString('utf8'))).toEqual({ nonce: NONCE, defer_credentials: true, capabilities: ['external_dns'], supports_config_layer: true });
      expect(o.issued).toBeNull();
      expect(o.environment).toBe('production');
      expect(o.mode).toBe('deploy');
    } finally {
      await o.session.batcher.close();
    }
  });

  it('accepts credentials from an older Cloud that ignores the flag', async () => {
    const c = await cloud({ ignoreDefer: true });
    const o = await open(c, new Redactor());
    try {
      expect(o.issued?.credentials.accessKeyId).toBe(FAKE_KEY);
      expect(o.issued?.region).toBe('us-east-1');
    } finally {
      await o.session.batcher.close();
    }
  });
});

const DNS = {
  profile: 'arco-dns',
  credentials: { accessKeyId: 'AKIADNSZONE00000001', secretAccessKey: 'dns/Secret/Key0123456789abcdefABCDEF', sessionToken: 'DNSSESSIONTOKEN0123456789abcdef', expiration: '2030-01-01T00:00:00.000Z' },
};
const CF = 'cf_token_0123456789abcdefABCDEF';

describe('external DNS', () => {
  it('sends the external_dns capability on a non-deferred start too', async () => {
    const c = await cloud({ ignoreDefer: true });
    const o = await open(c, new Redactor(), false);
    try {
      expect(JSON.parse(c.calls('/start')[0]!.body.toString('utf8'))).toEqual({ nonce: NONCE, capabilities: ['external_dns'], supports_config_layer: true });
    } finally {
      await o.session.batcher.close();
    }
  });

  it('carries dns and the Cloudflare token from /credentials into the session and the redactor', async () => {
    const c = await cloud({ dns: DNS, cloudflareToken: CF });
    const redactor = new Redactor();
    const o = await open(c, redactor);
    try {
      const issued = await issueCredentials({ apiBase: c.url, token: TOKEN, deploymentId: 'dep_1' });
      expect(issued.dns).toEqual(DNS);
      expect(issued.cloudflareToken).toBe(CF);
      const session = completeSession(o, issued, redactor);
      expect(session.dns).toEqual(DNS);
      expect(session.cloudflareToken).toBe(CF);
      for (const v of [DNS.credentials.accessKeyId, DNS.credentials.secretAccessKey, DNS.credentials.sessionToken, CF]) {
        expect(redactor.redact(`x ${v} y`)).toBe('x *** y');
      }
    } finally {
      await o.session.batcher.close();
    }
  });

  it('rejects a malformed dns in a non-deferred start answer without quoting it', async () => {
    const secret = 'LEAKY_SECRET_VALUE_123';
    const c = await cloud({ startAnswer: { status: 200, body: {
      environment: 'production', mode: 'deploy',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c', expiration: 'x' }, region: 'us-east-1',
      dns: { profile: 'arco-dns', credentials: secret },
    } } });
    const err = await open(c, new Redactor(), false).catch((e) => e);
    expect(err).toBeInstanceOf(MalformedAnswer);
    expect(err.message).toBe('Arco Cloud start answer was malformed (dns.credentials)');
    expect(err.message).not.toContain(secret);
  });

  it('masks them from an older Cloud start answer', async () => {
    const c = await cloud({ ignoreDefer: true, dns: DNS, cloudflareToken: CF });
    const redactor = new Redactor();
    const o = await open(c, redactor, false);
    try {
      expect(o.issued?.dns).toEqual(DNS);
      expect(o.issued?.cloudflareToken).toBe(CF);
      expect(redactor.redact(CF)).toBe('***');
      expect(redactor.redact(DNS.credentials.secretAccessKey)).toBe('***');
    } finally {
      await o.session.batcher.close();
    }
  });

  it('works without them (older Cloud): both null', async () => {
    const c = await cloud();
    const redactor = new Redactor();
    const o = await open(c, redactor);
    try {
      const issued = await issueCredentials({ apiBase: c.url, token: TOKEN, deploymentId: 'dep_1' });
      expect(issued).toMatchObject({ dns: null, cloudflareToken: null });
      const session = completeSession(o, issued, redactor);
      expect(session.dns).toBeNull();
      expect(session.cloudflareToken).toBeNull();
    } finally {
      await o.session.batcher.close();
    }
  });

  it('rejects a malformed dns answer without quoting it', async () => {
    const secret = 'LEAKY_SECRET_VALUE_123';
    const c = await cloud({ credentialsAnswer: { status: 200, body: {
      credentials: { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 'c', expiration: 'x' }, region: 'us-east-1',
      dns: { profile: 'arco-dns', credentials: secret },
    } } });
    const err = await issueCredentials({ apiBase: c.url, token: TOKEN, deploymentId: 'dep_1' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('malformed');
    expect(err.message).not.toContain(secret);
  });
});

describe('issueCredentials', () => {
  it('issues credentials once and masks them once completed', async () => {
    const c = await cloud();
    const redactor = new Redactor();
    const o = await open(c, redactor);
    try {
      const issued = await issueCredentials({ apiBase: c.url, token: TOKEN, deploymentId: 'dep_1' });
      expect(c.calls('/credentials')[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(c.calls('/credentials')[0]!.body.toString('utf8'))).toEqual({});
      expect(redactor.redact(FAKE_SECRET)).toBe(FAKE_SECRET);
      const session = completeSession(o, issued, redactor);
      expect(redactor.redact(FAKE_SECRET)).toBe('***');
      expect(session.awsEnv.AWS_REGION).toBe('us-east-1');
      expect(session.awsEnv.AWS_ACCESS_KEY_ID).toBe(FAKE_KEY);
      expect(session.started).toMatchObject({ environment: 'production', mode: 'deploy', region: 'us-east-1', permissionsBoundary: null });
      const again = await issueCredentials({ apiBase: c.url, token: TOKEN, deploymentId: 'dep_1' }).catch((e) => e);
      expect(again).toBeInstanceOf(CloudApiError);
      expect(again).toMatchObject({ status: 409, code: 'credentials_already_issued' });
    } finally {
      await o.session.batcher.close();
    }
  });

  it('retries a 503 credentials answer twice, then gives up', async () => {
    const c = await cloud({ credentialsAnswer: { status: 503 } });
    const sleeps: number[] = [];
    const err = await issueCredentials({
      apiBase: c.url, token: TOKEN, deploymentId: 'dep_1', sleep: async (ms) => { sleeps.push(ms); },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CloudApiError);
    expect(err).toMatchObject({ status: 503 });
    expect(c.calls('/credentials')).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('throws a 4xx at once', async () => {
    const c = await cloud({ credentialsAnswer: { status: 403, body: { error: 'forbidden' } } });
    const sleeps: number[] = [];
    const err = await issueCredentials({
      apiBase: c.url, token: TOKEN, deploymentId: 'dep_1', sleep: async (ms) => { sleeps.push(ms); },
    }).catch((e) => e);
    expect(err).toMatchObject({ status: 403, code: 'forbidden' });
    expect(c.calls('/credentials')).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('rejects a malformed answer without quoting it', async () => {
    const secret = 'SECRETVALUE0123456789';
    const bodies = [
      `{"credentials":{"accessKeyId":"${secret}"`,
      JSON.stringify({ credentials: { accessKeyId: secret, secretAccessKey: secret, sessionToken: secret }, region: 'us-east-1' }),
      JSON.stringify({ credentials: { accessKeyId: secret, secretAccessKey: secret, sessionToken: secret, expiration: 'x' }, region: 'us-east-1', permissionsBoundary: 7 }),
      JSON.stringify({ credentials: null, region: 'us-east-1' }),
    ];
    for (const body of bodies) {
      const sleeps: number[] = [];
      const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
      const err = await issueCredentials({
        apiBase: 'http://cloud.invalid', token: TOKEN, deploymentId: 'dep_1', fetchImpl, sleep: async (ms) => { sleeps.push(ms); },
      }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('Arco Cloud credentials answer was malformed');
      expect(sleeps).toEqual([]);
    }
  });

  it('stops the retry sleep and gives up at once when the signal aborts', async () => {
    const c = await cloud({ credentialsAnswer: { status: 503 } });
    const ac = new AbortController();
    const err = await issueCredentials({
      apiBase: c.url, token: TOKEN, deploymentId: 'dep_1', signal: ac.signal,
      sleep: () => { ac.abort(); return new Promise<void>(() => {}); },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Arco Cloud credentials call was cancelled');
    expect(c.calls('/credentials')).toHaveLength(1);
  });

  it('answers 409 finished after a finish', async () => {
    const c = await cloud();
    await fetch(`${c.url}/api/v1/deployments/dep_1/finish`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: '{}' });
    const err = await issueCredentials({ apiBase: c.url, token: TOKEN, deploymentId: 'dep_1' }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'finished' });
  });
});

describe('fake Cloud start', () => {
  it('refuses a start without the flag when the job has tests', async () => {
    const c = await cloud();
    c.options.job = { ...c.options.job, tests: { services: [] } };
    const err = await open(c, new Redactor(), false).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'runner_outdated' });
  });
});
