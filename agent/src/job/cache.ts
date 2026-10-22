import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chown, lstat, mkdir, open, readdir, readlink, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { runCommand } from '@multiapi/arco-cloud-client';
import type { Identity, Paths } from '../system.js';

export type Locks = { composer: string | null; npm: string | null; yarn: string | null; pnpm: string | null };
export type CacheManifest = { version: 1; key: string; lock: Locks; created_at: string };
export type CacheCtx = {
  paths: Paths;
  identity: Identity | null;
  rootDir: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Resource caps; tests lower them. */
  limits?: Partial<Limits>;
};
export type ArchiveEntry = { path: string; type: 'file' | 'dir' | 'symlink' | 'other'; target?: string };

export const MAX_ARCHIVE_BYTES = 2_147_483_648;
export const MANIFEST_NAME = '.arco-cache.json';
const ARCHIVE_NAME = 'cache.tar.zst';
const TAR_ENV: NodeJS.ProcessEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C' };

export type Limits = {
  maxMembers: number; maxLineBytes: number; maxListingBytes: number; maxSymlinkBytes: number;
  maxSegments: number; maxWalked: number; maxExcludes: number;
};
const LIMITS: Limits = {
  maxMembers: 2_000_000, maxLineBytes: 64 * 1024, maxListingBytes: 512 * 1024 * 1024, maxSymlinkBytes: 64 * 1024 * 1024,
  maxSegments: 4096, maxWalked: 5_000_000, maxExcludes: 100_000,
};
const limitsOf = (ctx: CacheCtx): Limits => ({ ...LIMITS, ...ctx.limits });

/**
 * `transient`: the object could not be fetched right now (network error or timeout, HTTP 5xx, HTTP 403 from an
 * expired presigned URL); trying again later may work. `content`: the object itself (or extracting it) is bad.
 */
export type CacheErrorKind = 'transient' | 'content';

export class CacheError extends Error {
  constructor(message: string, readonly kind: CacheErrorKind = 'content') {
    super(message);
    this.name = 'CacheError';
  }
}

/** An archive member that could write or point outside the cache roots. */
export class UnsafeArchive extends CacheError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeArchive';
  }
}

/** The retained-symlink budget ran out: a resource limit, not a verdict on one member. */
export class SymlinkBudgetExceeded extends UnsafeArchive {
  constructor(message: string) {
    super(message);
    this.name = 'SymlinkBudgetExceeded';
  }
}

/** Cache roots relative to `home`, without the manifest. A `root_dir` that is not a plain relative path adds none. */
export function cacheRoots(rootDir: string): string[] {
  const roots = ['work/repo/vendor', 'work/repo/node_modules'];
  const segs = rootDir.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  if (segs.length > 0 && !segs.includes('..') && !rootDir.startsWith('/')) {
    const base = `work/repo/${segs.join('/')}`;
    roots.push(`${base}/vendor`, `${base}/node_modules`);
  }
  roots.push('.cache/composer', '.npm');
  return [...new Set(roots)];
}

/** Reads a regular file without following a symlink in its last component; null if absent or not a plain file. */
async function readPlainFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let fh;
  try {
    // O_NONBLOCK so that a planted FIFO cannot hang the agent; O_NOFOLLOW so a planted link is never read.
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile() || st.size > maxBytes) return null;
    return await fh.readFile();
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

const LOCK_FILES: Record<keyof Locks, string> = {
  composer: 'composer.lock', npm: 'package-lock.json', yarn: 'yarn.lock', pnpm: 'pnpm-lock.yaml',
};

export async function lockHashes(projectDir: string): Promise<Locks> {
  const out: Locks = { composer: null, npm: null, yarn: null, pnpm: null };
  for (const k of Object.keys(LOCK_FILES) as (keyof Locks)[]) {
    const data = await readPlainFile(join(projectDir, LOCK_FILES[k]), 256 * 1024 * 1024);
    if (data) out[k] = createHash('sha256').update(data).digest('hex');
  }
  return out;
}

export function shouldSave(current: Locks, known: CacheManifest | null): boolean {
  if (!known) return true;
  return (Object.keys(LOCK_FILES) as (keyof Locks)[]).some((k) => current[k] !== known.lock[k]);
}

/**
 * Validates the archive listing before anything is extracted. Rules:
 * - every path is relative, free of `..`, and equals or lies under one cache root (or is the manifest file);
 * - only files and directories, plus symlinks; every other type (devices, fifos, hardlinks) is refused;
 * - a symlink target is relative, climbs only with leading `..` segments (so lexical and physical resolution
 *   agree) and resolves, from the link's own directory, inside the root the link is in;
 * - no member may lie below a symlink listed earlier (tar would write through it).
 */
export function checkArchiveEntries(entries: ArchiveEntry[], roots: string[]): void {
  const check = createEntryChecker(roots);
  for (const e of entries) check(e);
}

/** The stateful form of `checkArchiveEntries`: feed members in archive order, it throws on the first unsafe one. */
export function createEntryChecker(
  roots: string[],
  caps: { maxSegments: number; maxSymlinkBytes: number } = LIMITS,
): (e: ArchiveEntry) => void {
  const symlinks = new Set<string>();
  let symlinkBytes = 0;
  return (e) => {
    if (e.path === '' || e.path.startsWith('/')) throw new UnsafeArchive(`absolute or empty member path: ${e.path}`);
    const segs = e.path.split('/').filter((s) => s !== '' && s !== '.');
    if (segs.includes('..')) throw new UnsafeArchive(`member path contains "..": ${e.path}`);
    const path = segs.join('/');
    if (e.type === 'other') throw new UnsafeArchive(`unsupported member type: ${path}`);
    if (segs.length > caps.maxSegments) throw new UnsafeArchive('member path has too many segments');
    if (symlinks.size > 0) {
      let prefix = '';
      for (let i = 0; i < segs.length - 1; i++) {
        prefix = i === 0 ? segs[0]! : `${prefix}/${segs[i]}`;
        if (symlinks.has(prefix)) throw new UnsafeArchive(`member below a symlink: ${path}`);
      }
    }
    if (path === MANIFEST_NAME) {
      if (e.type !== 'file') throw new UnsafeArchive(`${MANIFEST_NAME} must be a regular file`);
      return;
    }
    const root = roots.find((r) => path === r || path.startsWith(`${r}/`));
    if (!root) throw new UnsafeArchive(`member outside the cache roots: ${path}`);
    if (e.type !== 'symlink') return;
    const target = e.target ?? '';
    if (target === '' || target.startsWith('/')) throw new UnsafeArchive(`symlink with absolute or empty target: ${path}`);
    const tsegs = target.split('/');
    const firstPlain = tsegs.findIndex((s) => s !== '..');
    if (firstPlain >= 0 && tsegs.slice(firstPlain).includes('..')) {
      throw new UnsafeArchive(`symlink target climbs after descending: ${path}`);
    }
    const resolved = posix.normalize(posix.join(posix.dirname(path), target)).replace(/\/+$/, '');
    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
      throw new UnsafeArchive(`symlink leaves its cache root: ${path}`);
    }
    symlinkBytes += Buffer.byteLength(path);
    if (symlinkBytes > caps.maxSymlinkBytes) throw new SymlinkBudgetExceeded('too many symlinks in the archive');
    symlinks.add(path);
  };
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, ' ': 32 };

/** Decodes GNU tar `--quoting-style=escape` (backslash escapes, octal bytes) into the real name. */
function unescapeName(s: string): string {
  const bytes: number[] = [];
  const raw = Buffer.from(s, 'utf8');
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== 0x5c) { bytes.push(c); continue; }
    const m = /^[0-7]{1,3}/.exec(raw.subarray(i + 1, i + 4).toString('latin1'));
    if (m) { bytes.push(parseInt(m[0], 8) & 0xff); i += m[0].length; continue; }
    const esc = String.fromCharCode(raw[i + 1] ?? 0);
    if (esc in ESCAPES) { bytes.push(ESCAPES[esc]!); i++; continue; }
    bytes.push(c);
  }
  return Buffer.from(bytes).toString('utf8');
}

const LIST_LINE = /^(\S)\S{9}\S* +\S+ +[\d,]+ \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? (.*)$/;

/**
 * Parses one line of `tar --list --verbose --numeric-owner --quoting-style=escape` (GNU tar):
 * `<type><perms> <uid>/<gid> <size> <date> <time> <name>[ -> <target> | link to <target>]`.
 * `--quoting-style=escape` makes a name always one line (newlines and control bytes are escaped). The only
 * remaining ambiguity is a name or target that itself contains " -> ", so a symlink line with more than one
 * arrow, or a hardlink (type `h`, always refused as `other`), is never split: it is refused outright.
 * A line that does not match the format is refused too (fail closed).
 */
export function parseListLine(line: string): ArchiveEntry {
  const m = LIST_LINE.exec(line);
  if (!m) throw new UnsafeArchive('unparseable archive listing line');
  const [, kind, rest] = m as unknown as [string, string, string];
  if (kind === 'l') {
    const parts = rest.split(' -> ');
    if (parts.length !== 2) throw new UnsafeArchive('ambiguous symlink entry in archive listing');
    return { path: unescapeName(parts[0]!), type: 'symlink', target: unescapeName(parts[1]!) };
  }
  if (kind === 'h') return { path: unescapeName(rest.split(' link to ')[0]!), type: 'other' };
  const path = unescapeName(rest);
  if (kind === '-') return { path, type: 'file' };
  if (kind === 'd') return { path, type: 'dir' };
  return { path, type: 'other' };
}

/** `varDir` must be a real directory owned by the agent; anything else (a link or a dir the build user made) is replaced. */
async function ensureVarDir(varDir: string): Promise<void> {
  try {
    const st = await lstat(varDir);
    const mine = process.getuid === undefined || st.uid === process.getuid();
    if (!st.isDirectory() || !mine) await rm(varDir, { recursive: true, force: true });
  } catch { /* missing */ }
  await mkdir(varDir, { recursive: true, mode: 0o755 });
}

async function ensureHome(home: string, identity: Identity | null): Promise<void> {
  try {
    if ((await lstat(home)).isDirectory()) return;
    await rm(home, { force: true });
  } catch { /* missing */ }
  await mkdir(home, { recursive: true });
  if (identity) await chown(home, identity.uid, identity.gid);
}

const asBuild = (identity: Identity | null) => (identity ? { uid: identity.uid, gid: identity.gid } : {});

function parseManifest(buf: Buffer | null): CacheManifest | null {
  if (!buf) return null;
  try {
    const j = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
    const lock = j.lock as Record<string, unknown> | undefined;
    const lockOk = !!lock && (['composer', 'npm', 'yarn', 'pnpm'] as const).every(
      (k) => lock[k] === null || typeof lock[k] === 'string',
    );
    if (j.version !== 1 || typeof j.key !== 'string' || typeof j.created_at !== 'string' || !lockOk) return null;
    const l = lock as Locks;
    return { version: 1, key: j.key, lock: { composer: l.composer, npm: l.npm, yarn: l.yarn, pnpm: l.pnpm }, created_at: j.created_at };
  } catch {
    return null;
  }
}

const netMessage = (what: string, e: unknown): string => {
  const x = e as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = x?.cause?.code ?? x?.code;
  return `${what} (network error${typeof code === 'string' ? `: ${code}` : ''})`;
};

/**
 * Removes the manifest file itself. The build user owns `home`, so the path may be swapped at any time:
 * only a regular file or a symlink is unlinked (non-recursive, never following); anything else is left alone.
 */
async function removeManifest(path: string): Promise<void> {
  let st;
  try { st = await lstat(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new CacheError('cannot inspect the cache manifest path');
  }
  if (!st.isFile() && !st.isSymbolicLink()) throw new CacheError(`${MANIFEST_NAME} is not a regular file`);
  try { await unlink(path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new CacheError(`cannot remove ${MANIFEST_NAME}`);
  }
}


/**
 * Streams `tar --list` as the build user and hands each parsed member to `onEntry`, keeping no copy of the output.
 * The first parse/check error, or exceeding the member or line cap, kills tar's process group and throws.
 */
function listArchive(archive: string, ctx: CacheCtx, onEntry: (e: ArchiveEntry) => void): Promise<void> {
  const { maxMembers, maxLineBytes, maxListingBytes } = limitsOf(ctx);
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn('tar', ['--zstd', '--list', '--verbose', '--numeric-owner', '--quoting-style=escape', '-f', archive], {
        cwd: ctx.paths.varDir, env: TAR_ENV, detached: true, stdio: ['ignore', 'pipe', 'ignore'], ...asBuild(ctx.identity),
      });
    } catch { reject(new CacheError('cannot start tar')); return; }
    let failure: Error | null = null;
    let members = 0;
    let total = 0;
    let pending: Buffer = Buffer.alloc(0);
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const fail = (e: Error) => { if (!failure) { failure = e; kill(); } };
    const line = (buf: Buffer) => {
      if (buf.length === 0 || failure) return;
      if (++members > maxMembers) { fail(new CacheError(`cache archive has more than ${maxMembers} members`)); return; }
      try { onEntry(parseListLine(buf.toString('utf8'))); } catch (e) { fail(e as Error); }
    };
    const onAbort = () => fail(new CacheError('cache restore cancelled'));
    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout!.on('data', (chunk: Buffer) => {
      if (failure) return;
      total += chunk.length;
      if (total > maxListingBytes) { fail(new CacheError('archive listing is too large')); return; }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let nl: number;
      while (!failure && (nl = pending.indexOf(0x0a)) >= 0) {
        if (nl > maxLineBytes) { fail(new CacheError('archive listing line too long')); break; }
        line(pending.subarray(0, nl));
        pending = pending.subarray(nl + 1);
      }
      if (pending.length > maxLineBytes) fail(new CacheError('archive listing line too long'));
    });
    child.once('error', () => { ctx.signal?.removeEventListener('abort', onAbort); reject(new CacheError('cannot run tar')); });
    child.once('close', (code) => {
      ctx.signal?.removeEventListener('abort', onAbort);
      if (!failure && pending.length) line(pending);
      if (failure) reject(failure);
      else if (code !== 0) reject(new CacheError(`cache archive listing failed (tar exit ${code})`));
      else resolve();
    });
  });
}

async function download(url: string, dest: string, ctx: CacheCtx): Promise<'ok' | 'missing'> {
  const doFetch = ctx.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
  } catch (e) {
    throw new CacheError(netMessage('cache download failed', e), 'transient');
  }
  if (res.status === 404) { await res.body?.cancel(); return 'missing'; }
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    const transient = res.status >= 500 || res.status === 403;
    throw new CacheError(`cache download failed (HTTP ${res.status})`, transient ? 'transient' : 'content');
  }
  let size = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      cb(size > MAX_ARCHIVE_BYTES ? new CacheError('cache archive is larger than 2 GiB') : null, chunk);
    },
  });
  try {
    // 'wx': never writes through an existing file or link. 0644: the build user reads it to list and extract.
    await pipeline(Readable.fromWeb(res.body as never), cap, createWriteStream(dest, { flags: 'wx', mode: 0o644 }));
  } catch (e) {
    // The connection broke mid-body: a network failure, not a verdict on the object.
    throw e instanceof CacheError ? e : new CacheError('cache download failed (stream error)', 'transient');
  }
  return 'ok';
}

/**
 * Precondition (ruling R13): no build process is alive. The job runner restores before any build command starts.
 * Every filesystem operation by the agent over build-owned paths uses lstat/unlink and never follows links.
 */
export async function restoreCache(
  url: string,
  ctx: CacheCtx,
): Promise<{ status: 'restored' | 'missing'; manifest: CacheManifest | null }> {
  const { paths, identity } = ctx;
  const archive = join(paths.varDir, ARCHIVE_NAME);
  const manifestPath = join(paths.home, MANIFEST_NAME);
  await ensureVarDir(paths.varDir);
  await rm(archive, { recursive: true, force: true });
  try {
    if ((await download(url, archive, ctx)) === 'missing') return { status: 'missing', manifest: null };

    const check = createEntryChecker(cacheRoots(ctx.rootDir), limitsOf(ctx));
    await listArchive(archive, ctx, check);

    await ensureHome(paths.home, identity);
    await removeManifest(manifestPath);
    const ex = await runCommand(
      'tar',
      ['--zstd', '--extract', '--no-same-owner', '--no-same-permissions', '--delay-directory-restore',
        '-f', archive, '-C', paths.home],
      { cwd: paths.home, env: { ...TAR_ENV, HOME: paths.home }, ...asBuild(identity), ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (ex.exitCode !== 0) throw new CacheError(`cache extraction failed (tar exit ${ex.exitCode})`);

    const manifest = parseManifest(await readPlainFile(manifestPath, 64 * 1024));
    await removeManifest(manifestPath);
    return { status: 'restored', manifest };
  } finally {
    await rm(archive, { recursive: true, force: true });
  }
}

/**
 * Walks the roots with lstat only (never following a link) and returns every member that `restoreCache` would
 * refuse: symlinks `checkArchiveEntries` rejects, and anything that is not a regular file, directory or symlink.
 */
async function unrestorableMembers(
  home: string, present: string[], rootDir: string, signal: AbortSignal, limits: Limits,
): Promise<string[]> {
  const check = createEntryChecker(cacheRoots(rootDir), limits);
  const out: string[] = [];
  let walked = 0;
  const addExclude = (rel: string): void => {
    out.push(rel);
    if (out.length > limits.maxExcludes) throw new CacheError('too many members to exclude from the cache');
  };
  const visit = async (rel: string): Promise<void> => {
    if (++walked > limits.maxWalked) throw new CacheError('cache roots hold too many entries');
    if (walked % 1000 === 0 && signal.aborted) throw new CacheError('cache save aborted');
    let st;
    try { st = await lstat(join(home, rel)); } catch { return; }
    const entry: ArchiveEntry = st.isDirectory() ? { path: rel, type: 'dir' }
      : st.isFile() ? { path: rel, type: 'file' }
        : st.isSymbolicLink() ? { path: rel, type: 'symlink' } : { path: rel, type: 'other' };
    if (entry.type === 'symlink') {
      try { entry.target = await readlink(join(home, rel)); } catch { addExclude(rel); return; }
    }
    try { check(entry); } catch (e) {
      if (e instanceof SymlinkBudgetExceeded) throw new CacheError('too many symlinks in the cache roots');
      addExclude(rel);
      return;
    }
    // lstat said real directory: only then do we descend; a link or anything else is never entered.
    if (entry.type !== 'dir') return;
    let names: string[];
    try { names = await readdir(join(home, rel)); } catch { return; }
    for (const n of names) await visit(`${rel}/${n}`);
  };
  for (const r of present) await visit(r);
  return out;
}

/** Runs tar as the build user with stdout written straight into `fd` (opened by the agent, so build needs no write access). */
function tarToFd(args: string[], cwd: string, identity: Identity | null, fd: number, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn('tar', args, { cwd, env: { ...TAR_ENV, HOME: cwd }, detached: true, stdio: ['ignore', fd, 'ignore'], ...asBuild(identity) });
    } catch (e) { reject(e); return; }
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    if (signal.aborted) kill();
    signal.addEventListener('abort', kill, { once: true });
    child.once('error', (e) => { signal.removeEventListener('abort', kill); reject(e); });
    child.once('close', (code) => { signal.removeEventListener('abort', kill); resolve(code ?? -1); });
  });
}

/**
 * Precondition (ruling R13): no build process is alive (the runner kills every build-user process before saving),
 * so the walk over the roots cannot race a build swapping entries.
 */
export async function saveCache(
  url: string,
  manifest: CacheManifest,
  ctx: CacheCtx,
  deadlineMs: number,
): Promise<'saved' | 'too_large' | 'timeout'> {
  const { paths, identity } = ctx;
  if (Date.now() >= deadlineMs) return 'timeout';
  const archive = join(paths.varDir, ARCHIVE_NAME);
  const manifestPath = join(paths.home, MANIFEST_NAME);
  const deadline = AbortSignal.timeout(Math.max(1, deadlineMs - Date.now()));
  const signal = ctx.signal ? AbortSignal.any([deadline, ctx.signal]) : deadline;
  const timedOut = () => deadline.aborted || Date.now() >= deadlineMs;
  try {
    await ensureVarDir(paths.varDir);
    await rm(archive, { recursive: true, force: true });
    await ensureHome(paths.home, identity);
    await removeManifest(manifestPath);
    try {
      await writeFile(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o644 });
    } catch {
      throw new CacheError(`cannot write ${MANIFEST_NAME}`);
    }

    const present: string[] = [];
    for (const r of cacheRoots(ctx.rootDir)) {
      try { if ((await lstat(join(paths.home, r))).isDirectory()) present.push(r); } catch { /* absent */ }
    }
    // Members restore would refuse (escaping symlinks, FIFOs, sockets, devices) are left out: the package managers
    // recreate such links on install, and one of them must not make every restore refuse the whole archive.
    let excludes: string[];
    try {
      excludes = await unrestorableMembers(paths.home, present, ctx.rootDir, signal, limitsOf(ctx));
    } catch (e) {
      if (timedOut()) return 'timeout';
      throw e;
    }
    if (signal.aborted) {
      if (timedOut()) return 'timeout';
      throw new CacheError('cache save cancelled');
    }
    const excludeFile = join(paths.varDir, 'exclude.list');
    // tar reads --exclude-from one name per line (--null does not apply to it), so a name holding a newline
    // cannot be excluded literally: the save fails cleanly rather than archive something restore would refuse.
    if (excludes.some((x) => x.includes('\n'))) throw new CacheError('a cache file name contains a newline');
    // ...and --exclude-from strips trailing whitespace from each line, so such a name cannot be matched literally.
    if (excludes.some((x) => /[ \t\r\v\f]$/.test(x))) throw new CacheError('a cache file name ends in whitespace');
    await writeFile(excludeFile, excludes.map((x) => `${x}\n`).join(''), { flag: 'w', mode: 0o644 });
    const fh = await open(archive, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let code: number;
    try {
      // No -h: symlinks are archived as links, never dereferenced. --hard-dereference: a hardlinked file is stored
      // as a plain copy, so the archive never holds hardlink members (restore refuses them).
      code = await tarToFd(
        ['-I', 'zstd -3 -T0', '--create', '--file', '-', '--hard-dereference', '--numeric-owner',
          '--no-wildcards', '--anchored', '--exclude-from', excludeFile, '-C', paths.home, '--',
          MANIFEST_NAME, ...present],
        paths.home, identity, fh.fd, signal,
      );
    } finally {
      await fh.close();
    }
    if (timedOut()) return 'timeout';
    if (ctx.signal?.aborted) throw new CacheError('cache save cancelled');
    if (code !== 0 && code !== 1) throw new CacheError(`cache archive failed (tar exit ${code})`);

    const { size } = await stat(archive);
    if (size > MAX_ARCHIVE_BYTES) return 'too_large';

    const doFetch = ctx.fetchImpl ?? fetch;
    try {
      const res = await doFetch(url, {
        method: 'PUT',
        headers: { 'Content-Length': String(size) },
        body: Readable.toWeb(createReadStream(archive)) as never,
        duplex: 'half',
        signal,
      } as RequestInit);
      await res.body?.cancel();
      if (!res.ok) throw new CacheError(`cache upload failed (HTTP ${res.status})`);
    } catch (e) {
      if (timedOut()) return 'timeout';
      if (e instanceof CacheError) throw e;
      throw new CacheError(netMessage('cache upload failed', e));
    }
    return 'saved';
  } finally {
    await rm(archive, { recursive: true, force: true });
    await rm(join(paths.varDir, 'exclude.list'), { recursive: true, force: true });
    await removeManifest(manifestPath).catch(() => {});
  }
}
