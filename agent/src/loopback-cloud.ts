// An in-process stand-in for Arco Cloud's runner endpoints and an S3 bucket reached through presigned URLs.
// Self-contained (node built-ins only): tests use it, and `/validate` runs it on 127.0.0.1 for its canned job.
//
//   POST /api/v1/runner/claim                 {ticket} -> 200 job | 409 ticket_invalid | 503 claim_unavailable
//   POST /api/v1/deployments/{id}/start       {nonce}  -> 200 credentials
//   POST /api/v1/deployments/{id}/logs        {seq, lines, events} -> 204 (or the configured answer)
//   POST /api/v1/deployments/{id}/finish      payload -> 204 | 409 finished
//   POST /api/v1/runner/idle                  {deployment_id} -> 204 | 409 not_finished | 404
//   GET|PUT /s3/<key>                          object store (presigned query strings are ignored)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface RecordedRequest {
  method: string;
  path: string;
  /** Path without the query string. */
  pathname: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  at: number;
}

export interface CannedAnswer { status: number; body?: unknown }

export interface FakeCloudOptions {
  /** The job document `claim` returns; its runner_token is the only bearer token accepted. */
  job: Record<string, unknown>;
  /** The ticket `claim` accepts; any other ticket gets 409. */
  ticket: string;
  /** Answers given to the first claims, in order, before the job is handed out (e.g. two 503s). */
  claimAnswers?: CannedAnswer[];
  /** `credentials.expiration` relative to now. Default 1 hour. */
  credentialsTtlMs?: number;
  /** The `start` answer's credentials (defaults are fixed example values). */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  region?: string;
  permissionsBoundary?: string | null;
  /** When set, every start request gets this answer instead of the credentials. */
  startAnswer?: CannedAnswer;
  /** When set, every logs request gets this answer instead of 204. */
  logsAnswer?: CannedAnswer;
}

export interface FakeCloud {
  url: string;
  requests: RecordedRequest[];
  /** S3 objects by key. */
  objects: Map<string, Buffer>;
  options: FakeCloudOptions;
  /** Requests whose pathname ends with `suffix` (e.g. 'finish', 'claim', '/s3/cache'). */
  calls(suffix: string, method?: string): RecordedRequest[];
  close(): Promise<void>;
}

const json = (res: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
};

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const parse = (b: Buffer): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(b.toString('utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export async function startFakeCloud(options: FakeCloudOptions): Promise<FakeCloud> {
  const requests: RecordedRequest[] = [];
  const objects = new Map<string, Buffer>();
  const claimAnswers = [...(options.claimAnswers ?? [])];
  let claimed = false;
  let finished = false;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    const path = req.url ?? '/';
    const pathname = path.split('?')[0]!;
    requests.push({ method: req.method ?? '', path, pathname, headers: req.headers, body, at: Date.now() });

    if (pathname.startsWith('/s3/')) {
      const key = pathname.slice(4);
      if (req.method === 'PUT') {
        objects.set(key, body);
        json(res, 200);
        return;
      }
      const obj = objects.get(key);
      if (!obj) {
        json(res, 404);
        return;
      }
      res.writeHead(200, { 'content-length': obj.length }).end(obj);
      return;
    }

    if (req.method !== 'POST') return json(res, 405);
    const token = options.job.runner_token as string;
    const authorized = req.headers.authorization === `Bearer ${token}`;
    const id = options.job.deployment_id as string;

    if (pathname === '/api/v1/runner/claim') {
      const canned = claimAnswers.shift();
      if (canned) return json(res, canned.status, canned.body);
      if (claimed || parse(body)?.ticket !== options.ticket) return json(res, 409, { error: 'ticket_invalid' });
      claimed = true;
      return json(res, 200, options.job);
    }
    if (pathname === '/api/v1/runner/idle') {
      if (!authorized) return json(res, 401, { error: 'unauthenticated' });
      if (parse(body)?.deployment_id !== id) return json(res, 404, { error: 'not_found' });
      if (!finished) return json(res, 409, { error: 'not_finished' });
      return json(res, 204);
    }
    const m = /^\/api\/v1\/deployments\/([^/]+)\/(start|logs|finish)$/.exec(pathname);
    if (!m) return json(res, 404, { error: 'not_found' });
    if (!authorized || decodeURIComponent(m[1]!) !== id) return json(res, 403, { error: 'not_runner' });
    const action = m[2];
    if (action === 'start') {
      if (options.startAnswer) return json(res, options.startAnswer.status, options.startAnswer.body);
      const c = options.credentials ?? {
        accessKeyId: 'AKIAFAKECLOUD0000001',
        secretAccessKey: 'fake/Secret+Access+Key/0123456789abcdefABCD',
        sessionToken: 'FwoGZXIvYXdzEFAKESESSIONTOKEN0123456789',
      };
      return json(res, 200, {
        credentials: { ...c, expiration: new Date(Date.now() + (options.credentialsTtlMs ?? 3_600_000)).toISOString() },
        region: options.region ?? 'us-east-1',
        environment: options.job.environment,
        mode: options.job.mode,
        permissionsBoundary: options.permissionsBoundary ?? null,
      });
    }
    if (finished) return json(res, 409, { error: 'finished' });
    if (action === 'logs') {
      if (options.logsAnswer) return json(res, options.logsAnswer.status, options.logsAnswer.body);
      return json(res, 204);
    }
    finished = true;
    return json(res, 204);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    objects,
    options,
    calls: (suffix, method) => requests.filter((r) => r.pathname.endsWith(suffix) && (!method || r.method === method)),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
