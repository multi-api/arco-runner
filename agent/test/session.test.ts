import { CloudApiError, Redactor } from '@multiapi/arco-cloud-client';
import { afterEach, describe, expect, it } from 'vitest';
import { completeSession, issueCredentials, openSession } from '../src/job/session.js';
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

describe('openSession', () => {
  it('sends defer_credentials and returns no credentials', async () => {
    const c = await cloud();
    const o = await open(c, new Redactor());
    try {
      expect(JSON.parse(c.calls('/start')[0]!.body.toString('utf8'))).toEqual({ nonce: NONCE, defer_credentials: true });
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
      const session = completeSession(o.session, issued, redactor);
      expect(redactor.redact(FAKE_SECRET)).toBe('***');
      expect(session.awsEnv.AWS_REGION).toBe('us-east-1');
      expect(session.awsEnv.AWS_ACCESS_KEY_ID).toBe(FAKE_KEY);
      expect(session.started).toMatchObject({ environment: 'production', mode: 'deploy', region: 'us-east-1', permissionsBoundary: null });
      const again = await issueCredentials({ apiBase: c.url, token: TOKEN, deploymentId: 'dep_1' }).catch((e) => e);
      expect(again).toBeInstanceOf(CloudApiError);
      expect(again).toMatchObject({ status: 409, code: 'credentials_issued' });
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
