// Driver helpers: talk to the runner the way Lambda (hooks, :9000) and Cloud (control, :8080) do, and to the
// fake Cloud's /admin endpoints to set up jobs and read what it recorded.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const INTEGRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
export const CONTROL = `http://127.0.0.1:${env.RUNNER_CONTROL_PORT ?? 38080}`;
export const HOOKS = `http://127.0.0.1:${env.RUNNER_HOOKS_PORT ?? 39000}/aws/lambda-microvms/runtime/v1`;
export const FAKE = `http://127.0.0.1:${env.FAKE_CLOUD_PORT ?? 38081}`;
/** How the runner (on the compose network) reaches the fake Cloud. */
export const API_BASE = 'http://fake-cloud:8081';
export const CACHE_KEY = 'cache/production';
export const ROOT_DIR = 'app';

const hex = (n: number) => randomBytes(n).toString('hex');
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Recorded {
  method: string; path: string; pathname: string; headers: Record<string, string | string[] | undefined>;
  at: number; size: number; body: string;
}
export interface GitRecorded { method: string; path: string; authorized: boolean; at: number }
/** A /suspend hook call the fake Cloud made while answering /idle (status 0: hook unreachable). */
export interface SuspendRecorded { deployment_id: string; status: number; at: number }

// ---------------------------------------------------------------- docker compose

export function compose(
  args: string[], o: { timeoutMs?: number; input?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('docker', ['compose', ...args], {
      cwd: INTEGRATION_DIR, timeout: o.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
    child.stdin?.end(o.input ?? '');
  });
}

/** A shell command inside the running runner container, as root. */
export const execRunner = (script: string) => compose(['exec', '-T', 'runner', 'sh', '-c', script]);

/** An ES module run by the image's own Node (stdin), as root. */
export const nodeInRunner = (source: string) => compose(['exec', '-T', 'runner', 'node', '--input-type=module'], { input: source });

// ---------------------------------------------------------------- HTTP

export async function http(method: string, url: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

export const hook = (name: string, body?: unknown) => http('POST', `${HOOKS}/${name}`, body);
export const healthz = async () => ((await http('GET', `${CONTROL}/healthz`)).json as { state: string }).state;

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 120_000, everyMs = 250): Promise<T> {
  const until = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}${lastError ? `: ${(lastError as Error).message}` : ''}`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------- fake Cloud admin

export async function commit(files: Record<string, string | null>, message = 'change', repo = 'app'): Promise<string> {
  const r = await http('POST', `${FAKE}/admin/commit`, { repo, files, message });
  if (r.status !== 200) throw new Error(`commit failed: ${JSON.stringify(r.json)}`);
  return (r.json as { sha: string }).sha;
}

export async function seedCache(manifest: unknown, files: Record<string, string>): Promise<void> {
  const r = await http('POST', `${FAKE}/admin/cache`, { key: CACHE_KEY, manifest, files });
  if (r.status !== 200) throw new Error(`seed failed: ${JSON.stringify(r.json)}`);
}

export async function requests(): Promise<{ cloud: Recorded[]; git: GitRecorded[]; suspends: SuspendRecorded[] }> {
  return (await http('GET', `${FAKE}/admin/requests`)).json as { cloud: Recorded[]; git: GitRecorded[]; suspends: SuspendRecorded[] };
}

// ---------------------------------------------------------------- jobs

export interface Credentials { accessKeyId: string; secretAccessKey: string; sessionToken: string }

export interface Job {
  ticket: string;
  doc: Record<string, unknown> & {
    deployment_id: string; runner_token: string; nonce: string; mode: string;
    source: { clone_url: string; auth_header: string; sha: string; root_dir: string };
    env: Record<string, string>; mask: string[]; cache: { restore_url: string; save_url: string; key: string };
  };
  credentials: Credentials;
  /** The ticket payload Lambda (`/run`) and Cloud (`/job`) deliver. */
  payload: { ticket: string; api_base: string; deployment_id: string };
  /** Index of the first recorded request that belongs to this job. */
  from: { cloud: number; git: number };
}

export const DEFAULT_COMMANDS = ['composer install --prefer-dist --no-interaction', 'npm ci --offline', 'npm run build'];

export interface JobOptions {
  sha: string;
  commands?: string[];
  mode?: 'deploy' | 'inventory';
  timeoutSeconds?: number;
  claimAnswers?: { status: number; body?: unknown }[];
  permissionsBoundary?: string | null;
  ticket?: string;
  /** Every start call gets this answer instead of the credentials. */
  startAnswer?: { status: number; body?: unknown };
  /** The cache object key (default CACHE_KEY, the seeded one). */
  cacheKey?: string;
  /** Whether the fake Cloud calls the runner's /suspend hook before answering /idle (default true; false for Fargate). */
  suspendOnIdle?: boolean;
  /** The document's `tests` (absent when undefined). */
  tests?: Record<string, unknown> | null;
}

/** Registers a fresh job (fresh ticket, tokens, secrets) with the fake Cloud and returns it. */
export async function newJob(name: string, o: JobOptions): Promise<Job> {
  const ticket = o.ticket ?? `ticket-${hex(16)}`;
  const cloneToken = `ghs_${hex(18)}`;
  const buildSecret = `build-secret-${hex(10)}`;
  const multiLine = `first-line-${hex(6)}\nsecond-line-${hex(6)}`;
  const deploymentId = `dep-${name}-${hex(4)}`;
  const cacheKey = o.cacheKey ?? CACHE_KEY;
  const signed = (sig: string) => `${API_BASE}/s3/${cacheKey}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${sig}`;
  const credentials: Credentials = {
    accessKeyId: `AKIA${hex(8).toUpperCase()}`,
    secretAccessKey: `fake/Secret+${hex(12)}/Key`,
    sessionToken: `FwoGZXIvYXdz${hex(20)}`,
  };
  const doc: Job['doc'] = {
    deployment_id: deploymentId,
    environment: 'production',
    mode: o.mode ?? 'deploy',
    nonce: `nonce-${hex(16)}`,
    runner_token: `runner-token-${hex(16)}`,
    source: {
      clone_url: `${API_BASE}/git/app.git`,
      auth_header: 'basic ' + Buffer.from(`x-access-token:${cloneToken}`).toString('base64'),
      sha: o.sha,
      root_dir: ROOT_DIR,
    },
    php_version: '8.5',
    commands: o.commands ?? DEFAULT_COMMANDS,
    env: { COMPOSER_DISABLE_NETWORK: '1', APP_SECRET: buildSecret, MULTI_LINE_SECRET: multiLine, APP_NAME: 'fixture' },
    mask: [buildSecret, multiLine],
    cache: { restore_url: signed(`restore${hex(16)}`), save_url: signed(`save${hex(16)}`), key: cacheKey },
    timeout_seconds: o.timeoutSeconds ?? 600,
    // Credentials come from /credentials once the build passed (the current image always asks for that).
    defer_credentials: true,
    ...(o.tests !== undefined ? { tests: o.tests } : {}),
  };
  const before = await requests();
  const r = await http('POST', `${FAKE}/admin/job`, {
    job: doc, ticket, credentials, claimAnswers: o.claimAnswers ?? [],
    permissionsBoundary: o.permissionsBoundary ?? null,
    ...(o.startAnswer ? { startAnswer: o.startAnswer } : {}),
    suspendOnIdle: o.suspendOnIdle ?? true,
  });
  if (r.status !== 204) throw new Error(`could not set the job: ${JSON.stringify(r.json)}`);
  return {
    ticket, doc, credentials,
    payload: { ticket, api_base: API_BASE, deployment_id: deploymentId },
    from: { cloud: before.cloud.length, git: before.git.length },
  };
}

/** What the fake Cloud recorded for this job (requests made after it was registered, and its /suspend calls). */
export async function recorded(job: Job): Promise<{ cloud: Recorded[]; git: GitRecorded[]; suspends: SuspendRecorded[] }> {
  const all = await requests();
  return {
    cloud: all.cloud.slice(job.from.cloud), git: all.git.slice(job.from.git),
    suspends: all.suspends.filter((s) => s.deployment_id === job.doc.deployment_id),
  };
}

export const isIdleCall = (r: Recorded) => r.pathname === '/api/v1/runner/idle';
export const isFinish = (r: Recorded) => r.pathname.endsWith('/finish');
export const isStart = (r: Recorded) => r.pathname.endsWith('/start');
export const isClaim = (r: Recorded) => r.pathname === '/api/v1/runner/claim';
export const isCachePut = (r: Recorded) => r.method === 'PUT' && r.pathname.startsWith('/s3/');
export const isCredentials = (r: Recorded) => r.pathname.endsWith('/credentials');

/**
 * The canned test phase (ruling Q7): `php artisan test` runs the fixture's offline fake PHPUnit, installed by an
 * offline `composer install` (the test phase runs before the build commands). `tests` overrides these fields;
 * its `env` is added to the defaults.
 */
export function testsJob(name: string, sha: string, tests: Record<string, unknown> = {}): Promise<Job> {
  const { env, ...rest } = tests;
  return newJob(name, {
    sha,
    tests: {
      command: 'php artisan test', setup_commands: ['composer install --no-interaction --prefer-dist'], services: [],
      primary_database: null, timeout_seconds: 300, mask: [],
      ...rest,
      env: { COMPOSER_DISABLE_NETWORK: '1', ...(env as Record<string, string> | undefined) },
    },
  });
}

/** Waits until the runner reported idle for this job (or, with `idle: false`, until it is idle again) and returns the recording. */
export async function untilDone(job: Job, o: { idleCall?: boolean; timeoutMs?: number } = {}) {
  const want = o.idleCall ?? true;
  await waitFor(`deployment ${job.doc.deployment_id} to end`, async () => {
    if (want && !(await recorded(job)).cloud.some(isIdleCall)) return false;
    return (await healthz()) === 'idle';
  }, o.timeoutMs ?? 180_000);
  return recorded(job);
}

// ---------------------------------------------------------------- reading the logs

export interface Step { key: string; status: string; message?: string; params?: Record<string, unknown> }

const logsBodies = (reqs: Recorded[]) =>
  reqs.filter((r) => r.pathname.endsWith('/logs')).map((r) => JSON.parse(r.body) as { seq: number; lines: string[]; events: Record<string, unknown>[] });

export const logLines = (reqs: Recorded[]): string[] => logsBodies(reqs).flatMap((b) => b.lines);
export const steps = (reqs: Recorded[]): Step[] =>
  logsBodies(reqs).flatMap((b) => b.events).filter((e) => e.type === 'step') as unknown as Step[];
export const statusesOf = (reqs: Recorded[], key: string) => steps(reqs).filter((s) => s.key === key).map((s) => s.status);

export function finishBody(reqs: Recorded[]): Record<string, unknown> {
  const f = reqs.filter(isFinish);
  if (f.length === 0) throw new Error('no finish recorded');
  return JSON.parse(f[f.length - 1]!.body) as Record<string, unknown>;
}

// ---------------------------------------------------------------- secrets

/** The variants the runner must mask (global constraints): raw, base64 (std/url, padded or not), URI, JSON, lines. */
export function variants(secret: string): string[] {
  const out = new Set<string>();
  const add = (v: string) => { if (v.length >= 4) out.add(v); };
  const one = (s: string) => {
    add(s);
    const b64 = Buffer.from(s).toString('base64');
    add(b64);
    add(b64.replace(/=+$/, ''));
    const url = Buffer.from(s).toString('base64url');
    add(url);
    add(url + '='.repeat((4 - (url.length % 4)) % 4));
    add(encodeURIComponent(s));
    add(JSON.stringify(s).slice(1, -1));
  };
  one(secret);
  if (secret.includes('\n')) for (const line of secret.split('\n')) one(line);
  return [...out];
}

/** Every secret of a job (global constraints): what must never reach Cloud unmasked. */
export function jobSecrets(job: Job): string[] {
  const token = Buffer.from(job.doc.source.auth_header.slice('basic '.length), 'base64').toString().slice('x-access-token:'.length);
  const sig = (u: string) => new URL(u).searchParams.get('X-Amz-Signature')!;
  return [
    job.ticket, job.doc.runner_token, job.doc.nonce, job.doc.source.auth_header, token,
    job.doc.cache.restore_url, job.doc.cache.save_url, sig(job.doc.cache.restore_url), sig(job.doc.cache.save_url),
    job.credentials.accessKeyId, job.credentials.secretAccessKey, job.credentials.sessionToken,
    ...job.doc.mask,
    ...(((job.doc.tests as { mask?: string[] } | null | undefined)?.mask) ?? []),
  ];
}

/**
 * The secrets (any variant) found in what the runner sent to Cloud. The claim (it carries the ticket), start (the
 * nonce) and the cache transfers are the protocol itself and are not scanned; every logs, finish and idle body is,
 * both as sent and with its JSON strings decoded.
 */
export function leakedSecrets(job: Job, reqs: Recorded[]): string[] {
  const texts: string[] = [];
  for (const r of reqs) {
    if (isClaim(r) || isStart(r) || r.pathname.startsWith('/s3/')) continue;
    texts.push(r.body);
    try {
      texts.push(...collectStrings(JSON.parse(r.body)));
    } catch { /* not JSON */ }
  }
  const leaks: string[] = [];
  for (const secret of jobSecrets(job)) {
    for (const v of variants(secret)) if (texts.some((t) => t.includes(v))) leaks.push(v);
  }
  return leaks;
}

function collectStrings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(collectStrings);
  if (v && typeof v === 'object') return Object.values(v).flatMap(collectStrings);
  return [];
}
