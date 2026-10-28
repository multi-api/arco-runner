// The runner's own start and credentials calls (spec §4.1). The shared client's startRun always expects credentials
// from start; the runner asks start to defer them and fetches them from /credentials right before arco deploy.
import {
  Batcher, CloudApi, CloudApiError, isRunLost, parseExternalDns, type Credentials, type ExternalDns, type Redactor, type RunSession, type StartResponse,
} from '@multiapi/arco-cloud-client';

/** The deploy credentials, from /credentials or from an older Cloud's start answer. */
export interface Issued {
  credentials: Credentials;
  region: string;
  permissionsBoundary: string | null;
  /** Route 53 credentials for a zone in another account, when the deployment uses external DNS. */
  dns: ExternalDns | null;
  cloudflareToken: string | null;
}

export interface OpenSession {
  /** A run session without credentials yet: logs and finish work, arco cannot run. */
  session: Omit<RunSession, 'started' | 'awsEnv' | 'dns' | 'cloudflareToken'>;
  /** Non-null when start returned credentials (an older Cloud that ignored defer_credentials). */
  issued: Issued | null;
  environment: string;
  mode: string;
  /** Ends the run like a fatal logs answer does: sets the abort message and aborts session.signal. */
  markRunLost(e: unknown): void;
}

const TIMEOUT_MS = 30_000;
const CREDENTIAL_RETRY_SLEEPS_MS = [1000, 2000];
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The caller's signal ended the call (a cancel or a run Cloud ended): never retried. */
class CallAborted extends Error {
  constructor(path: string) {
    super(`Arco Cloud ${path} call was cancelled`);
    this.name = 'CallAborted';
  }
}

/** A 2xx answer that is not JSON or lacks a field: never retried, and never quotes the body. */
class MalformedAnswer extends Error {
  constructor(path: string) {
    super(`Arco Cloud ${path} answer was malformed`);
    this.name = 'MalformedAnswer';
  }
}

/** `sleep(ms)`, cut short when `signal` aborts. */
async function abortableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return;
  let onAbort = () => {};
  const aborted = new Promise<void>((r) => { onAbort = () => r(); signal.addEventListener('abort', onAbort, { once: true }); });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * POSTs `body` the way CloudApi does; non-2xx throws CloudApiError (so isRunLost works), a timeout a plain Error,
 * an abort of `signal` a CallAborted. A 2xx body that is not JSON throws a fixed message: V8's SyntaxError quotes
 * the body, which may hold unmasked credentials.
 */
async function post(
  apiBase: string, token: string, deploymentId: string, path: string, body: unknown, fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = `${apiBase.replace(/\/+$/, '')}/api/v1/deployments/${encodeURIComponent(deploymentId)}/${path}`;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Arco-Cloud-Api': '1',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let code: string | null = null;
      try {
        const answer = (await response.json()) as { error?: unknown } | null;
        if (typeof answer?.error === 'string') code = answer.error;
      } catch {
        // body is not JSON: no error code
      }
      throw new CloudApiError(`Arco Cloud ${path} failed with HTTP ${response.status}`, response.status, code);
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new MalformedAnswer(path);
    }
  } catch (e) {
    if (signal?.aborted) throw new CallAborted(path);
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`Arco Cloud ${path} timed out after ${TIMEOUT_MS} ms`);
    }
    throw e;
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';

/** The credentials, region and boundary of an answer, checked field by field; `path` names the call in the error. */
function toIssued(a: unknown, path: string): Issued {
  const x = (a ?? {}) as { credentials?: Record<string, unknown> | null; region?: unknown; permissionsBoundary?: unknown };
  const c = x.credentials;
  const boundary = x.permissionsBoundary ?? null;
  if (
    !c || typeof c !== 'object' || !isString(c.accessKeyId) || !isString(c.secretAccessKey) || !isString(c.sessionToken)
    || !isString(c.expiration) || !isString(x.region) || (boundary !== null && !isString(boundary))
  ) {
    throw new MalformedAnswer(path);
  }
  // Absent keys mean null (an older Cloud); a bad shape throws a message that names the field, never the value.
  const { dns, cloudflareToken } = parseExternalDns(a, path);
  return {
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken, expiration: c.expiration },
    region: x.region,
    permissionsBoundary: boundary,
    dns,
    cloudflareToken,
  };
}

/** Calls start (deferring the credentials when `defer`) and wires the log batcher exactly as the shared startRun does. */
export async function openSession(o: {
  apiBase: string; token: string; deploymentId: string; nonce: string; defer: boolean; redactor: Redactor;
  warn: (m: string) => void; keepAliveMs: number; fetchImpl?: typeof fetch;
}): Promise<OpenSession> {
  const capabilities = ['external_dns'];
  const body = o.defer ? { nonce: o.nonce, defer_credentials: true, capabilities } : { nonce: o.nonce, capabilities };
  const started = (await post(o.apiBase, o.token, o.deploymentId, 'start', body, o.fetchImpl ?? fetch)) as
    Omit<StartResponse, 'credentials'> & { credentials: Credentials | null };
  const { redactor } = o;
  redactor.add(o.token);
  redactor.add(o.nonce);
  const issued = started.credentials ? toIssued(started, 'start') : null;
  if (issued) for (const v of credentialValues(issued)) redactor.add(v);

  const api = new CloudApi(o.apiBase, o.token, o.deploymentId);
  const redact = (text: string) => redactor.redact(text);
  const controller = new AbortController();
  let abortMessage: string | null = null;
  const markRunLost = (e: unknown) => {
    if (abortMessage !== null) return;
    abortMessage = `Arco Cloud ended this run (${(e as Error).message}); stopped Arco and did not report a result.`;
    controller.abort();
  };
  const batcher = new Batcher({
    isFatal: isRunLost,
    onAbort: markRunLost,
    send: (p) => api.logs(p),
    redact,
    onError: o.warn,
    keepAliveMs: o.keepAliveMs,
  });
  const session: OpenSession['session'] = {
    api, secrets: [...redactor.secrets], redact, batcher, signal: controller.signal,
    abortMessage: () => abortMessage, warn: o.warn,
  };
  return {
    session,
    issued,
    environment: started.environment,
    mode: started.mode,
    markRunLost,
  };
}

/**
 * POSTs `{}` to /credentials. A network error, a timeout or a 5xx is retried twice (1 s, then 2 s); a 4xx is thrown
 * at once as CloudApiError, and so is a malformed 200 answer ("Arco Cloud credentials answer was malformed").
 * An abort of `signal` (a cancel, or Cloud ending the run) stops the request and the retry sleep at once.
 */
export async function issueCredentials(o: {
  apiBase: string; token: string; deploymentId: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<Issued> {
  const sleep = o.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    if (o.signal?.aborted) throw new CallAborted('credentials');
    let answer: unknown;
    try {
      answer = await post(o.apiBase, o.token, o.deploymentId, 'credentials', {}, o.fetchImpl ?? fetch, o.signal);
    } catch (e) {
      const final = e instanceof CallAborted || e instanceof MalformedAnswer || (e instanceof CloudApiError && e.status < 500);
      if (final || attempt >= CREDENTIAL_RETRY_SLEEPS_MS.length) throw e;
      await abortableSleep(sleep, CREDENTIAL_RETRY_SLEEPS_MS[attempt]!, o.signal);
      continue;
    }
    return toIssued(answer, 'credentials');
  }
}

const credentialValues = (i: Issued): string[] => [
  i.credentials.accessKeyId, i.credentials.secretAccessKey, i.credentials.sessionToken,
  ...(i.dns ? [i.dns.credentials.accessKeyId, i.dns.credentials.secretAccessKey, i.dns.credentials.sessionToken] : []),
  ...(i.cloudflareToken ? [i.cloudflareToken] : []),
];

/** Masks the credentials, then returns the full run session arco deploys with. */
export function completeSession(open: OpenSession, issued: Issued, redactor: Redactor): RunSession {
  for (const v of credentialValues(issued)) redactor.add(v);
  const { credentials, region, permissionsBoundary, dns, cloudflareToken } = issued;
  return {
    ...open.session,
    secrets: [...redactor.secrets],
    dns,
    cloudflareToken,
    started: { credentials, region, permissionsBoundary, environment: open.environment, mode: open.mode },
    awsEnv: {
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_SESSION_TOKEN: credentials.sessionToken,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
    },
  };
}
