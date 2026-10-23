import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Agent } from './agent.js';
import { InvalidTicketPayload, parseTicketPayload, type TicketPayload } from './job/document.js';

const HOOK_PREFIX = '/aws/lambda-microvms/runtime/v1/';
const MAX_BODY_BYTES = 64 * 1024;

export interface ServerOptions {
  hooksPort: number;
  controlPort: number;
  ready: () => Promise<boolean>;
  /** The image validation; run through agent.validate (R18). */
  validate: () => Promise<void>;
  allowHttp: boolean;
  onTerminate: () => void;
  log?: (message: string) => void;
}

export interface RunningServers { hooksPort: number; controlPort: number; close(): Promise<void> }

class BadBody extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadBody('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** '' -> undefined (no payload); anything else must be JSON. */
function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new BadBody('body is not valid JSON');
  }
}

// Every response closes its connection. Lambda's hook caller (and the MicroVM proxy) live outside
// the VM and may keep a socket alive across a suspend; when the VM resumes, the agent's keep-alive
// timer fires at once (suspended time counts) and resets that socket just as /resume arrives on it.
const send = (res: ServerResponse, status: number, body?: unknown) => {
  if (body === undefined) {
    res.writeHead(status, { 'Content-Length': 0, Connection: 'close' }).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Connection: 'close' }).end(text);
};

const listen = (server: Server, port: number) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve((server.address() as { port: number }).port));
  });

/** Spec §6.1/§6.2: the hooks server (Lambda lifecycle) and the control server (Cloud's /job and /cancel). */
export async function startServers(agent: Agent, o: ServerOptions): Promise<RunningServers> {
  const log = o.log ?? ((m: string) => console.log(`[arco-runner] ${m}`));

  /** A parsed ticket payload, or an explanation of why not (never echoing the values). */
  const ticketOf = (body: unknown): TicketPayload | { error: string } => {
    try {
      return parseTicketPayload(body, o.allowHttp);
    } catch (e) {
      return { error: e instanceof InvalidTicketPayload ? e.message : 'invalid payload' };
    }
  };

  const hooks = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method !== 'POST' && req.method !== 'GET') return send(res, 405);
      if (!url.pathname.startsWith(HOOK_PREFIX)) return send(res, 404);
      const hook = url.pathname.slice(HOOK_PREFIX.length);
      switch (hook) {
        case 'ready': return send(res, (await o.ready()) ? 200 : 503);
        case 'validate': {
          const started = agent.validate(o.validate);
          if (started === 'refused') return send(res, 409, { error: 'refused' });
          if (started === 'busy') return send(res, 503);
          const r = agent.validation;
          return send(res, r === 'passed' ? 200 : r === 'failed' ? 500 : 503);
        }
        case 'run': {
          let body: unknown;
          try {
            body = parseJson(await readBody(req));
          } catch (e) {
            log(`/run ignored: ${(e as Error).message}`);
            return send(res, 200);
          }
          // Lambda wraps RunMicrovm's runHookPayload: {"microvmId": "...", "runHookPayload": "<string>"}.
          // Cloud's payload is that string, JSON-encoded. A bare payload (local tests) is accepted too.
          if (typeof body === 'object' && body !== null && 'microvmId' in body) {
            const raw = (body as { runHookPayload?: unknown }).runHookPayload;
            if (typeof raw !== 'string' || raw === '') {
              log('/run without a runHookPayload: nothing to do');
              return send(res, 200);
            }
            try {
              body = JSON.parse(raw);
            } catch {
              log('/run ignored: runHookPayload is not JSON');
              return send(res, 200);
            }
          }
          const hasTicket = typeof body === 'object' && body !== null && 'ticket' in body;
          if (!hasTicket) return send(res, 200); // no ticket: a validate run or an empty run is a no-op
          const p = ticketOf(body);
          if ('error' in p) log(`/run ignored: ${p.error}`);
          else if (agent.accept(p) === 'busy') log(`/run for deployment ${p.deployment_id} refused: agent busy`);
          return send(res, 200);
        }
        case 'resume': agent.resume(); return send(res, 200);
        case 'suspend': return send(res, agent.canSuspend() ? 200 : 503);
        case 'terminate':
          res.on('finish', () => o.onTerminate());
          return send(res, 200);
        default: return send(res, 404);
      }
    } catch (e) {
      log(`hook error: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500);
    }
  });

  const control = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { state: agent.state });
      if (req.method === 'POST' && url.pathname === '/job') {
        let body: unknown;
        try {
          body = parseJson(await readBody(req));
        } catch (e) {
          return send(res, 400, { error: (e as Error).message });
        }
        const p = ticketOf(body);
        if ('error' in p) return send(res, 400, { error: p.error });
        return agent.accept(p) === 'accepted' ? send(res, 202, { state: 'accepted' }) : send(res, 409, { error: 'busy' });
      }
      if (req.method === 'POST' && url.pathname === '/cancel') {
        let body: unknown;
        try {
          body = parseJson(await readBody(req));
        } catch (e) {
          return send(res, 400, { error: (e as Error).message });
        }
        const id = (body as { deployment_id?: unknown } | undefined)?.deployment_id;
        if (typeof id !== 'string' || !id) return send(res, 400, { error: 'deployment_id is required' });
        return agent.cancel(id) === 'cancelling' ? send(res, 202, { state: 'cancelling' }) : send(res, 200, { state: 'idle' });
      }
      return send(res, 404);
    } catch (e) {
      log(`control error: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500);
    }
  });

  for (const s of [hooks, control]) { s.requestTimeout = 10_000; s.headersTimeout = 10_000; }
  const hooksPort = await listen(hooks, o.hooksPort);
  const controlPort = await listen(control, o.controlPort).catch((e) => { hooks.close(); throw e; });
  const close = async () => {
    await Promise.all([hooks, control].map((s) => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); })));
  };
  return { hooksPort, controlPort, close };
}
