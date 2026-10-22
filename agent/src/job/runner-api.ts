import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { parseJobDocument, type JobDocument, type TicketPayload } from './document.js';

const CLAIM_WINDOW_MS = 9 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_MS = [2000, 4000, 8000, 16000];
const MAX_BACKOFF_MS = 30_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A minimal fetch over a new TCP/TLS connection per request (`agent: false`, `Connection: close`).
 * A VM resumed hours after its last build may hold pooled sockets the peer closed long ago; the runner-only
 * calls (claim, idle) never reuse one, so a reset is always retried on a fresh connection.
 */
export const freshFetch = ((input: string | URL, init: RequestInit = {}): Promise<Response> =>
  new Promise((resolve, reject) => {
    const url = new URL(String(input));
    const body = init.body === undefined || init.body === null ? undefined : String(init.body);
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined), Connection: 'close' };
    if (body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(body));
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const req = send(url, { method: init.method ?? 'GET', headers, agent: false, ...(signal ? { signal } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) req.destroy(new Error('response too large'));
        else chunks.push(c);
      });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const nullBody = status === 204 || status === 304;
        resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status }));
      });
      res.on('error', reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  })) as typeof fetch;

const runnerHeaders = (token?: string): Record<string, string> => ({
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  'X-Arco-Cloud-Api': '1',
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

const endpoint = (apiBase: string, path: string) => `${apiBase.replace(/\/+$/, '')}/api/v1/runner/${path}`;

/**
 * Exchanges the ticket for the job document (spec §6.3 step 1). Null when Cloud refuses the ticket (409, any
 * other 4xx, an invalid document) or once 9 minutes have passed since the ticket arrived. 503, 5xx and network
 * errors are retried after 2, 4, 8, 16, 30, 30... s, each on a fresh connection.
 */
export async function claim(
  p: TicketPayload,
  o: {
    now: () => number; sleep: (ms: number) => Promise<void>; receivedAt: number; fetchImpl?: typeof fetch;
    /** Cancel: stops at once (an in-flight request or backoff sleep is abandoned) and returns null. */
    signal?: AbortSignal;
  },
): Promise<JobDocument | null> {
  const doFetch = o.fetchImpl ?? freshFetch;
  const giveUpAt = o.receivedAt + CLAIM_WINDOW_MS;
  const cancelled = new Promise<'cancelled'>((resolve) => {
    if (o.signal?.aborted) resolve('cancelled');
    else o.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true });
  });
  for (let attempt = 0; ; attempt++) {
    const left = giveUpAt - o.now();
    if (left <= 0 || o.signal?.aborted) return null;
    let res: Response | null = null;
    try {
      // Never wait past the claim window, nor past a cancel.
      const timeout = AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, left));
      res = await doFetch(endpoint(p.api_base, 'claim'), {
        method: 'POST', headers: runnerHeaders(), body: JSON.stringify({ ticket: p.ticket }),
        signal: o.signal ? AbortSignal.any([timeout, o.signal]) : timeout,
      });
    } catch {
      res = null; // network error or reset: retry
    }
    if (res) {
      if (res.status === 200) {
        try {
          return o.signal?.aborted ? null : parseJobDocument(await res.json());
        } catch {
          return null;
        }
      }
      await res.body?.cancel();
      const retryable = res.status === 503 || res.status === 429 || res.status >= 500;
      if (!retryable) return null;
    }
    if (o.signal?.aborted) return null;
    const pause = Math.min(BACKOFF_MS[attempt] ?? MAX_BACKOFF_MS, Math.max(0, giveUpAt - o.now()));
    if ((await Promise.race([o.sleep(pause), cancelled])) === 'cancelled') return null;
  }
}

/** Tells Cloud the VM is clean (spec §6.3 step 9). 204, 401, 404 and 409 all count as done; throws after 3 failed tries. */
export async function reportIdle(
  apiBase: string,
  token: string,
  deploymentId: string,
  fetchImpl: typeof fetch = freshFetch,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<void> {
  let last = 'no answer';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1000);
    try {
      const res = await fetchImpl(endpoint(apiBase, 'idle'), {
        method: 'POST', headers: runnerHeaders(token), body: JSON.stringify({ deployment_id: deploymentId }),
      });
      await res.body?.cancel();
      if ([200, 204, 401, 404, 409].includes(res.status)) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      const err = e as { code?: string; cause?: { code?: string } };
      last = `network error${err.cause?.code ?? err.code ? `: ${err.cause?.code ?? err.code}` : ''}`;
    }
  }
  throw new Error(`could not report idle to Arco Cloud (${last})`);
}
