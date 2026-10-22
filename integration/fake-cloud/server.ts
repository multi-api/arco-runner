// The integration suite's fake Arco Cloud (spec §11.2): one HTTP server on the compose network that
//   - forwards the runner protocol and the S3-like cache calls to a loopback-cloud.ts instance (one per job),
//   - serves git smart HTTP (`git http-backend`) under /git/, refusing any request without the current job's
//     `Authorization` header,
//   - lets the test driver set the job, commit to the repos, seed a cache object and read what was recorded (/admin/*).
// Runs with Node 24's type stripping: `node integration/fake-cloud/server.ts`.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startFakeCloud, type FakeCloud, type FakeCloudOptions } from '../../agent/src/loopback-cloud.ts';

const PORT = Number(process.env.FAKE_CLOUD_PORT ?? 8081);
const GIT_ROOT = process.env.FAKE_CLOUD_GIT_ROOT ?? '/srv/git';
const WORK_ROOT = process.env.FAKE_CLOUD_WORK_ROOT ?? '/srv/work';
const TEMPLATE = process.env.FAKE_CLOUD_TEMPLATE ?? '/srv/template';

interface GitRequest { method: string; path: string; authorized: boolean; at: number }

let cloud: FakeCloud | null = null;
/** Every protocol request of every job, in arrival order (each loopback instance only knows its own). */
const finishedJobs: FakeCloud[] = [];
const gitRequests: GitRequest[] = [];
/** Cache objects seeded before the first job; afterwards each job's instance inherits the previous one's. */
const pendingObjects = new Map<string, Buffer>();

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const json = (res: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) {
    res.writeHead(status, { 'content-length': 0 }).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
};

function run(cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Buffer } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}: ${Buffer.concat(err).toString()}`));
    });
    child.stdin.end(o.input);
  });
}

const git = (cwd: string, ...args: string[]) =>
  run('git', ['-c', 'user.email=fake-cloud@arco.test', '-c', 'user.name=fake-cloud', ...args], { cwd });

/** Creates the repo from the template on first use, applies `files` (null deletes), commits, pushes; returns the sha. */
async function commit(repo: string, files: Record<string, string | null>, message: string): Promise<string> {
  if (!/^[a-z0-9-]+$/.test(repo)) throw new Error('repo must be [a-z0-9-]+');
  const work = join(WORK_ROOT, repo);
  const bare = join(GIT_ROOT, `${repo}.git`);
  const exists = await readFile(join(work, '.git/HEAD')).then(() => true, () => false);
  if (!exists) {
    await mkdir(work, { recursive: true });
    await run('cp', ['-a', `${TEMPLATE}/.`, work]);
    await git(work, 'init', '-q', '-b', 'main');
    await run('git', ['init', '-q', '--bare', bare]);
    // The runner fetches one sha, not a ref.
    await git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    await git(bare, 'config', 'http.receivepack', 'false');
    await git(work, 'remote', 'add', 'origin', bare);
  }
  for (const [path, content] of Object.entries(files)) {
    const target = join(work, path);
    if (!target.startsWith(`${work}/`)) throw new Error(`bad path ${path}`);
    if (content === null) await rm(target, { force: true });
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '--allow-empty', '-m', message);
  await git(work, 'push', '-q', 'origin', 'HEAD:main');
  return (await git(work, 'rev-parse', 'HEAD')).toString().trim();
}

/** Builds a cache archive (tar | zstd) holding the manifest and `files` (paths relative to /home/build). */
async function seedCache(key: string, manifest: unknown, files: Record<string, string>): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'seed-'));
  try {
    await writeFile(join(dir, '.arco-cache.json'), JSON.stringify(manifest));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    // Members are named one by one (no parent directories such as work/): the runner refuses anything outside its roots.
    const archive = await run('tar', ['--zstd', '-cf', '-', '--owner=1000', '--group=1000', '-C', dir, '.arco-cache.json', ...Object.keys(files)]);
    (cloud?.objects ?? pendingObjects).set(key, archive);
    return archive.length;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** git smart HTTP through `git http-backend` (CGI). */
async function serveGit(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<void> {
  const expected = (cloud?.options.job.source as { auth_header?: string } | undefined)?.auth_header;
  const authorized = expected !== undefined && req.headers.authorization === expected;
  gitRequests.push({ method: req.method ?? '', path: url.pathname + url.search, authorized, at: Date.now() });
  if (!authorized) return json(res, 401, { error: 'unauthenticated' });
  const env: NodeJS.ProcessEnv = {
    GIT_PROJECT_ROOT: GIT_ROOT,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: url.pathname.slice('/git'.length),
    QUERY_STRING: url.search.replace(/^\?/, ''),
    REQUEST_METHOD: req.method ?? 'GET',
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    CONTENT_LENGTH: String(body.length),
    REMOTE_ADDR: req.socket.remoteAddress ?? '',
    REMOTE_USER: 'runner',
    ...(req.headers['git-protocol'] ? { HTTP_GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
    ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
  };
  const out = await run('git', ['http-backend'], { env, input: body });
  const sep = out.indexOf('\r\n\r\n') >= 0 ? out.indexOf('\r\n\r\n') : out.indexOf('\n\n');
  const sepLen = out.indexOf('\r\n\r\n') >= 0 ? 4 : 2;
  const head = out.subarray(0, sep).toString('latin1').split(/\r?\n/);
  const payload = out.subarray(sep + sepLen);
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of head) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (name.toLowerCase() === 'status') status = parseInt(value, 10);
    else headers[name] = value;
  }
  headers['content-length'] = String(payload.length);
  res.writeHead(status, headers).end(payload);
}

/** The runner protocol and the cache: forwarded to the current job's loopback instance. */
async function forward(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
  if (!cloud) return json(res, 409, { error: 'ticket_invalid' });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || ['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive'].includes(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  const answer = await fetch(cloud.url + (req.url ?? '/'), {
    method: req.method,
    headers,
    ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: new Uint8Array(body) }),
  });
  const data = Buffer.from(await answer.arrayBuffer());
  const out: Record<string, string> = { 'content-length': String(data.length) };
  const type = answer.headers.get('content-type');
  if (type) out['content-type'] = type;
  res.writeHead(answer.status, out).end(answer.status === 204 ? undefined : data);
}

const allRequests = () => [...finishedJobs, ...(cloud ? [cloud] : [])].flatMap((c) => c.requests);

const serialize = (r: FakeCloud['requests'][number]) => ({
  method: r.method, path: r.path, pathname: r.pathname, headers: r.headers, at: r.at,
  size: r.body.length,
  body: r.pathname.startsWith('/s3/') ? '' : r.body.toString('utf8'),
});

async function admin(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): Promise<void> {
  const input = body.length ? JSON.parse(body.toString('utf8')) : {};
  switch (`${req.method} ${url.pathname}`) {
    case 'POST /admin/job': {
      const previous = cloud;
      const next = await startFakeCloud(input as FakeCloudOptions);
      for (const [k, v] of previous?.objects ?? pendingObjects) next.objects.set(k, v);
      if (previous) {
        finishedJobs.push(previous);
        await previous.close();
      }
      cloud = next;
      return json(res, 204);
    }
    case 'POST /admin/commit':
      return json(res, 200, { sha: await commit(input.repo, input.files ?? {}, input.message ?? 'change') });
    case 'POST /admin/cache':
      return json(res, 200, { size: await seedCache(input.key, input.manifest, input.files ?? {}) });
    case 'GET /admin/requests':
      return json(res, 200, { cloud: allRequests().map(serialize), git: gitRequests });
    case 'GET /admin/objects':
      return json(res, 200, Object.fromEntries([...(cloud?.objects ?? pendingObjects)].map(([k, v]) => [k, v.length])));
    case 'GET /admin/health':
      return json(res, 200, { ok: true });
    default:
      return json(res, 404, { error: 'not_found' });
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://fake-cloud');
    const body = await readBody(req);
    if (url.pathname.startsWith('/admin/')) return admin(req, res, url, body);
    if (url.pathname.startsWith('/git/')) return serveGit(req, res, url, body);
    return forward(req, res, body);
  })().catch((e: Error) => {
    console.error(`fake-cloud: ${req.method} ${req.url}: ${e.message}`);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  });
});

await mkdir(GIT_ROOT, { recursive: true });
await mkdir(WORK_ROOT, { recursive: true });
server.listen(PORT, '0.0.0.0', () => console.log(`fake-cloud listening on ${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
