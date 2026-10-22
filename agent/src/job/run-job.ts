import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CloudApi, Redactor, buildFailure, deployAndFinish, finishWithRetry, startRun, type RunSession,
} from '@multi-api/arco-cloud-client';
import { registerJobSecrets, shortMaskValues } from '../mask.js';
import { buildEnv, cutLine, resolveProjectDir, type Identity, type Paths } from '../system.js';
import { killUserProcesses } from '../wipe.js';
import { type CacheManifest, cacheRoots, lockHashes, restoreCache, saveCache, shouldSave } from './cache.js';
import { runBuildCommands } from './commands.js';
import type { JobDocument, TicketPayload } from './document.js';
import { BuildFailure } from './errors.js';
import { claim, reportIdle } from './runner-api.js';
import { checkout, revokeGithubToken, type CheckoutContext } from './source.js';
import { Steps } from './steps.js';

export type JobPhase = 'running' | 'saving' | 'wiping';

export interface JobDeps {
  paths: Paths;
  identity: Identity | null;
  mode: 'microvm' | 'fargate';
  /** Aborted by `/cancel` (or `/terminate`). */
  signal: AbortSignal;
  /** The manifest of the cache this VM last restored or saved (kept in memory across suspends). */
  knownCache: { get(): CacheManifest | null; set(m: CacheManifest): void };
  onPhase(p: JobPhase): void;
  /** Date.now() when the ticket arrived. */
  receivedAt: number;
  now?: () => number;
  /** Claim backoff only. */
  sleep?: (ms: number) => Promise<void>;
  /** Runner-only calls (claim, idle), the GitHub token revocation and the cache transfers. */
  fetchImpl?: typeof fetch;
  /** Spec §6.6; a rejection means the VM is dirty and propagates to the caller (no idle is reported). */
  wipe: (rootDir: string) => Promise<void>;
  /** Tests and offline validation only (file:// clones). */
  checkoutOptions?: Pick<CheckoutContext, 'extraGitArgs' | 'allowFileUrl'>;
  /** Agent diagnostics (stdout). Every message is redacted first. */
  log?: (message: string) => void;
}

export interface JobResult { deploymentId: string; finished: boolean; buildOk: boolean; idleReported: boolean }

const KEEP_ALIVE_MS = 60_000;
const SAVE_TIME_BOX_MS = 8 * 60_000;
const MIN_CREDENTIAL_TTL_MS = 20 * 60_000;
const ARCO_BIN = 'vendor/bin/arco';
const ARCO_MISSING =
  'vendor/bin/arco not found: add multiapi/arco to composer.json and install it in your build commands (dev dependencies included)';
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const messageOf = (e: unknown): string => {
  const err = e as { message?: unknown } | null;
  const m = typeof err?.message === 'string' && err.message ? err.message : String(e);
  return m.split('\n')[0]!.slice(0, 1000);
};

/** `vendor/bin/arco` exists, is a file, and the identity that runs it may execute it. */
async function arcoInstalled(projectDir: string, identity: Identity | null): Promise<boolean> {
  const bin = join(projectDir, ARCO_BIN);
  try {
    const st = await stat(bin);
    if (!st.isFile()) return false;
    if (!identity) {
      await access(bin, constants.X_OK);
      return true;
    }
    const bit = st.uid === identity.uid ? 0o100 : st.gid === identity.gid ? 0o010 : 0o001;
    return (st.mode & bit) !== 0;
  } catch {
    return false;
  }
}

/** Cache roots under the repo, relative to it: the checkout keeps them (spec §6.3 step 4). */
const repoKeep = (rootDir: string): string[] =>
  cacheRoots(rootDir).filter((r) => r.startsWith('work/repo/')).map((r) => r.slice('work/repo/'.length));

/**
 * One job, from ticket to idle, in the order of spec §6.3: claim, mask, start, source, cache restore (only when
 * the VM knows no cache), build commands, deploy + finish, cache save, wipe (MicroVM only), idle.
 */
export async function runJob(p: TicketPayload, deps: JobDeps): Promise<JobResult> {
  const now = deps.now ?? Date.now;
  const redactor = new Redactor();
  const log = (m: string) => (deps.log ?? ((x: string) => console.log(`[arco-runner] ${x}`)))(redactor.redact(m));
  const result: JobResult = { deploymentId: p.deployment_id, finished: false, buildOk: false, idleReported: false };
  deps.onPhase('running');

  // 1. Claim
  const doc = await claim(p, { now, sleep: deps.sleep ?? realSleep, receivedAt: deps.receivedAt, fetchImpl: deps.fetchImpl });
  if (!doc) {
    log(`claim for deployment ${p.deployment_id} refused or timed out; no Cloud calls are possible`);
    deps.onPhase('wiping');
    if (deps.mode === 'microvm') await deps.wipe('');
    return result;
  }
  const deadlineMs = now() + doc.timeout_seconds * 1000;

  // 2. Mask: before anything is logged
  registerJobSecrets(redactor, doc);

  // 3. Start
  const api = new CloudApi(p.api_base, doc.runner_token, doc.deployment_id);
  let session: RunSession | null = null;
  try {
    session = await startRun({
      api, nonce: doc.nonce, token: doc.runner_token, redactor, warn: log, batcher: { keepAliveMs: KEEP_ALIVE_MS },
    });
  } catch (e) {
    log(`start failed for deployment ${doc.deployment_id}: ${messageOf(e)}`);
  }

  let restoreFailed = false;
  if (session) {
    const s = session;
    const runSignal = AbortSignal.any([deps.signal, s.signal]);
    const steps = new Steps(s.batcher);
    let deployed = false;
    try {
      restoreFailed = await build(doc, deps, s, steps, runSignal, deadlineMs);
      await deploy(doc, deps, s, runSignal, now);
      deployed = true;
      result.finished = true;
      result.buildOk = true;
    } catch (e) {
      if (s.abortMessage() !== null) {
        // Cloud ended the run (lease lost, finished, not the runner): nothing more is reported.
        log(s.abortMessage()!);
      } else {
        const failure = deps.signal.aborted
          ? buildFailure('build.cancelled', 'Cancelled')
          : e instanceof BuildFailure
            ? buildFailure(e.code, e.message)
            : buildFailure('runner.internal_error', messageOf(e));
        if (!(e instanceof BuildFailure) && !deps.signal.aborted) {
          log(`internal error in deployment ${doc.deployment_id}: ${messageOf(e)}`);
        }
        await s.batcher.flush();
        await finishWithRetry(api, JSON.parse(s.redact(JSON.stringify(failure))), undefined, log);
        result.finished = true;
      }
    } finally {
      await s.batcher.close();
    }

    // 8. Cache save: after finish, only after a deploy ran, never after a failed restore
    deps.onPhase('saving');
    if (deployed && !restoreFailed) await save(doc, deps, now, log);
  } else {
    deps.onPhase('saving');
  }

  // 9. Wipe, then idle
  deps.onPhase('wiping');
  if (deps.mode === 'microvm') await deps.wipe(doc.source.root_dir);
  try {
    await reportIdle(p.api_base, doc.runner_token, doc.deployment_id, deps.fetchImpl);
    result.idleReported = true;
  } catch (e) {
    log(messageOf(e));
  }
  return result;
}

/** Steps 4-6: source, cache restore, build commands. Returns whether a restore failed (other than 404). */
async function build(
  doc: JobDocument, deps: JobDeps, s: RunSession, steps: Steps, signal: AbortSignal, deadlineMs: number,
): Promise<boolean> {
  const { paths, identity } = deps;
  const env = buildEnv(paths, doc.env);
  const cancelled = () => { if (signal.aborted) throw new BuildFailure('build.cancelled', 'Cancelled'); };

  // 4. Source
  const short = shortMaskValues(doc);
  if (short > 0) steps.warning('build.clone', `${short} secret value(s) shorter than 4 characters are not masked`);
  steps.start('build.clone');
  const { hasSubmodules } = await checkout(doc, {
    paths, identity, env, signal, keep: repoKeep(doc.source.root_dir),
    onLine: (l) => s.batcher.addLine(cutLine(l)),
    ...deps.checkoutOptions,
  });
  await revokeGithubToken(doc.source.clone_url, doc.source.auth_header, deps.fetchImpl);
  if (hasSubmodules) steps.note('build.clone', 'Submodules are not checked out');
  const projectDir = await resolveProjectDir(paths.repo, doc.source.root_dir);
  steps.done('build.clone');
  cancelled();

  // 5. Cache restore: only when this VM has not built with a cache yet
  let restoreFailed = false;
  if (deps.knownCache.get() === null) {
    steps.start('build.cache_restore');
    try {
      const r = await restoreCache(doc.cache.restore_url, {
        paths, identity, rootDir: doc.source.root_dir, signal, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      if (r.status === 'missing') steps.note('build.cache_restore', 'No cache yet');
      else {
        if (r.manifest) deps.knownCache.set(r.manifest);
        steps.done('build.cache_restore');
      }
    } catch (e) {
      cancelled();
      restoreFailed = true;
      steps.warning('build.cache_restore', `Cache restore failed, building without it: ${messageOf(e)}`);
    }
  }
  cancelled();

  // 6. Build commands
  await runBuildCommands(doc.commands, {
    projectDir, env, identity, batcher: s.batcher, steps, deadlineMs, signal, timeoutSeconds: doc.timeout_seconds,
  });
  return restoreFailed;
}

/** Step 7: arco checks, then the shared deploy phase, which sends finish. Re-resolves root_dir: the build may have swapped it. */
async function deploy(doc: JobDocument, deps: JobDeps, s: RunSession, signal: AbortSignal, now: () => number): Promise<void> {
  const projectDir = await resolveProjectDir(deps.paths.repo, doc.source.root_dir);
  if (!(await arcoInstalled(projectDir, deps.identity))) throw new BuildFailure('arco.not_installed', ARCO_MISSING);
  const expiresAt = Date.parse(s.started.credentials.expiration);
  if (!Number.isFinite(expiresAt) || expiresAt - now() < MIN_CREDENTIAL_TTL_MS) {
    throw new BuildFailure('runner_credentials_expiring', 'The deploy credentials expire in less than 20 minutes; arco deploy was not started');
  }
  if (signal.aborted) throw new BuildFailure('build.cancelled', 'Cancelled');
  // A cancel stops arco like a run Cloud ended; the RunAbortedError it causes is reported as build.cancelled.
  const view: RunSession = { ...s, signal, abortMessage: () => s.abortMessage() ?? (deps.signal.aborted ? 'Cancelled' : null) };
  await deployAndFinish(view, {
    mode: doc.mode, environment: doc.environment, cwd: projectDir, env: buildEnv(deps.paths, doc.env),
    ...(deps.identity ? { uid: deps.identity.uid, gid: deps.identity.gid } : {}),
  });
}

/** Step 8, after finish: nothing reaches Cloud's logs any more, diagnostics go to stdout only. */
async function save(doc: JobDocument, deps: JobDeps, now: () => number, log: (m: string) => void): Promise<void> {
  const savedBy = now() + SAVE_TIME_BOX_MS;
  try {
    // Ruling R13: no build process may be alive while the cache roots are walked and archived.
    if (deps.identity) {
      try {
        await killUserProcesses(deps.identity.uid);
      } catch (e) {
        log(`cache save skipped: build processes survived (${messageOf(e)})`);
        return;
      }
    }
    const projectDir = await resolveProjectDir(deps.paths.repo, doc.source.root_dir);
    const lock = await lockHashes(projectDir);
    const known = deps.knownCache.get();
    if (!shouldSave(lock, known && known.key === doc.cache.key ? known : null)) return;
    const manifest: CacheManifest = { version: 1, key: doc.cache.key, lock, created_at: new Date(now()).toISOString() };
    const outcome = await saveCache(doc.cache.save_url, manifest, {
      paths: deps.paths, identity: deps.identity, rootDir: doc.source.root_dir, signal: deps.signal,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }, savedBy);
    if (outcome === 'saved') deps.knownCache.set(manifest);
    else log(`cache not saved: ${outcome === 'too_large' ? 'archive larger than 2 GiB' : 'time box of 8 minutes exceeded'}`);
  } catch (e) {
    log(`cache not saved: ${messageOf(e)}`);
  }
}
