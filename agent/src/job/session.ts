// The runner's own start and credentials calls (spec §4.1). The shared client's startRun always expects credentials
// from start; the runner asks start to defer them and fetches them from /credentials right before arco deploy.
import {
  Batcher, CloudApi, CloudApiError, isRunLost, type Credentials, type Redactor, type RunSession, type StartResponse,
} from '@multiapi/arco-cloud-client';

/** The deploy credentials, from /credentials or from an older Cloud's start answer. */
export interface Issued {
  credentials: Credentials;
  region: string;
  permissionsBoundary: string | null;
}

export interface OpenSession {
  /** A run session without credentials yet: logs and finish work, arco cannot run. */
  session: Omit<RunSession, 'started' | 'awsEnv'>;
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
/** The start answer's environment and mode, per open session: completeSession puts them back into `started`. */
const startAnswers = new WeakMap<OpenSession['session'], { environment: string; mode: string }>();

/** POSTs `body` the way CloudApi does; non-2xx throws CloudApiError (so isRunLost works), a timeout a plain Error. */
async function post(
  apiBase: string, token: string, deploymentId: string, path: string, body: unknown, fetchImpl: typeof fetch,
): Promise<unknown> {
  const url = `${apiBase.replace(/\/+$/, '')}/api/v1/deployments/${encodeURIComponent(deploymentId)}/${path}`;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
    return await response.json();
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`Arco Cloud ${path} timed out after ${TIMEOUT_MS} ms`);
    }
    throw e;
  }
}

const toIssued = (a: { credentials: Credentials; region: string; permissionsBoundary?: string | null }): Issued => ({
  credentials: a.credentials,
  region: a.region,
  permissionsBoundary: a.permissionsBoundary ?? null,
});

/** Calls start (deferring the credentials when `defer`) and wires the log batcher exactly as the shared startRun does. */
export async function openSession(o: {
  apiBase: string; token: string; deploymentId: string; nonce: string; defer: boolean; redactor: Redactor;
  warn: (m: string) => void; keepAliveMs: number; fetchImpl?: typeof fetch;
}): Promise<OpenSession> {
  const body = o.defer ? { nonce: o.nonce, defer_credentials: true } : { nonce: o.nonce };
  const started = (await post(o.apiBase, o.token, o.deploymentId, 'start', body, o.fetchImpl ?? fetch)) as
    Omit<StartResponse, 'credentials'> & { credentials: Credentials | null };
  const { redactor } = o;
  redactor.add(o.token);
  redactor.add(o.nonce);
  const issued = started.credentials ? toIssued({ ...started, credentials: started.credentials }) : null;
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
  startAnswers.set(session, { environment: started.environment, mode: started.mode });
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
 * at once as CloudApiError.
 */
export async function issueCredentials(o: {
  apiBase: string; token: string; deploymentId: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>;
}): Promise<Issued> {
  const sleep = o.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      const answer = await post(o.apiBase, o.token, o.deploymentId, 'credentials', {}, o.fetchImpl ?? fetch);
      return toIssued(answer as Issued);
    } catch (e) {
      const clientError = e instanceof CloudApiError && e.status < 500;
      if (clientError || attempt >= CREDENTIAL_RETRY_SLEEPS_MS.length) throw e;
      await sleep(CREDENTIAL_RETRY_SLEEPS_MS[attempt]!);
    }
  }
}

const credentialValues = (i: Issued): string[] =>
  [i.credentials.accessKeyId, i.credentials.secretAccessKey, i.credentials.sessionToken];

/** Masks the credentials, then returns the full run session arco deploys with. `open` must be openSession's own object. */
export function completeSession(open: OpenSession['session'], issued: Issued, redactor: Redactor): RunSession {
  for (const v of credentialValues(issued)) redactor.add(v);
  const { credentials, region, permissionsBoundary } = issued;
  const start = startAnswers.get(open);
  if (!start) throw new Error('completeSession needs the session object openSession returned');
  return {
    ...open,
    secrets: [...redactor.secrets],
    started: { credentials, region, permissionsBoundary, environment: start.environment, mode: start.mode },
    awsEnv: {
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_SESSION_TOKEN: credentials.sessionToken,
      AWS_REGION: region,
      AWS_DEFAULT_REGION: region,
    },
  };
}
