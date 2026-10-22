import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CloudApi, Redactor, buildFailure, deployAndFinish, finishWithRetry, redactValue, startRun, type RunSession,
} from '@multi-api/arco-cloud-client';
import { registerJobSecrets, shortMaskValues } from '../mask.js';
import { buildEnv, cutLine, resolveProjectDir, type Identity, type Paths } from '../system.js';
import { killUserProcesses } from '../wipe.js';
import { CacheError, type CacheManifest, cacheRoots, lockHashes, restoreCache, saveCache, shouldSave } from './cache.js';
import { runBuildCommands } from './commands.js';
import type { JobDocument, TicketPayload } from './document.js';
import { BuildFailure } from './errors.js';
import { claim, reportIdle } from './runner-api.js';
import { checkout, revokeGithubToken, type CheckoutContext } from './source.js';
import { Steps } from './steps.js';

/** `idle`: the VM is clean again (after the wipe, before the idle report); MicroVM mode only. */
export type JobPhase = 'running' | 'saving' | 'wiping' | 'idle';

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
  /** Claim backoff and the gap between idle tries. */
  sleep?: (ms: number) => Promise<void>;
  /** Runner-only calls (claim, idle), the GitHub token revocation and the cache transfers. */
  fetchImpl?: typeof fetch;
  /**
   * Spec §6.6; a rejection means the VM is dirty and propagates to the caller (no idle is reported).
   * Ruling R15: only called when customer code may have run (the checkout started), never after a refused claim,
   * a failed start or a cancel before start.
   */
  wipe: (rootDir: string) => Promise<void>;
  /**
   * Kills every build-user process: before arco deploy (M3; a rejection fails the run with runner.internal_error)
   * and before the cache save (R13; a rejection skips the save).
   * Defaults to killUserProcesses(identity.uid) when an identity is set, else nothing.
   */
  killBuildProcesses?: () => Promise<void>;
  /** Tests and offline validation only (file:// clones), and http:// clones under ARCO_RUNNER_ALLOW_HTTP=1. */
  checkoutOptions?: Pick<CheckoutContext, 'extraGitArgs' | 'allowFileUrl' | 'allowHttpUrl'>;
  /** Agent diagnostics (stdout). Every message is redacted first. */
  log?: (message: string) => void;
}

export interface JobResult {
  deploymentId: string;
  /** Cloud accepted a finish for this run (false when none was sent, or Cloud rejected or never answered it). */
  finished: boolean;
  /** The build and the deploy phase succeeded (deployAndFinish returned 0). */
  buildOk: boolean;
  idleReported: boolean;
}

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

  const sleep = deps.sleep ?? realSleep;

  // 1. Claim. Refused, timed out or cancelled: no Cloud call is possible and no customer code ran (R15: no wipe).
  const doc = await claim(p, { now, sleep, receivedAt: deps.receivedAt, fetchImpl: deps.fetchImpl, signal: deps.signal });
  if (!doc) {
    log(`claim for deployment ${p.deployment_id} refused, timed out or cancelled; no Cloud calls are possible`);
    return result;
  }
  const deadlineMs = now() + doc.timeout_seconds * 1000;

  // 2. Mask: before anything is logged
  registerJobSecrets(redactor, doc);

  // 3. Start
  const api = new CloudApi(p.api_base, doc.runner_token, doc.deployment_id);
  let session: RunSession | null = null;
  if (deps.signal.aborted) {
    log(`deployment ${doc.deployment_id} cancelled before start`);
  } else {
    try {
      session = await startRun({
        api, nonce: doc.nonce, token: doc.runner_token, redactor, warn: log, batcher: { keepAliveMs: KEEP_ALIVE_MS },
      });
    } catch (e) {
      log(`start failed for deployment ${doc.deployment_id}: ${messageOf(e)}`);
    }
  }

  if (session) {
    const s = session;
    const runSignal = AbortSignal.any([deps.signal, s.signal]);
    const steps = new Steps(s.batcher);
    let restoreTransientFailure = false;
    // Set once deployAndFinish returned (finish sent): the save time box starts there.
    let saveBy: number | null = null;
    // finishWithRetry warns exactly when Cloud did not accept the finish (run lost, or no answer after retries).
    let finishRejected = false;
    const finishWarn = (m: string) => { finishRejected = true; log(m); };
    try {
      restoreTransientFailure = await build(doc, deps, s, steps, runSignal, deadlineMs);
      const exitCode = await deploy(doc, deps, { ...s, warn: finishWarn }, runSignal, now);
      saveBy = now() + SAVE_TIME_BOX_MS;
      result.finished = !finishRejected;
      result.buildOk = exitCode === 0;
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
        // Closed (not just flushed) first, so no keep-alive batch can follow the finish.
        await s.batcher.close();
        // `result` is our own enum: kept even if a mask value equals "failed".
        await finishWithRetry(api, { ...redactValue(failure, s.redact), result: failure.result }, undefined, finishWarn);
        result.finished = !finishRejected;
      }
    } finally {
      await s.batcher.close();
    }

    // 8. Cache save: after finish, only after a deploy ran, never after a transient restore failure (R23: the
    // object may be fine, so it is not overwritten; after a content failure a fresh cache replaces it)
    deps.onPhase('saving');
    if (saveBy !== null && !restoreTransientFailure) await save(doc, deps, now, log, saveBy);

    // 9. Wipe (the checkout ran: customer code may have run)
    deps.onPhase('wiping');
    if (deps.mode === 'microvm') await deps.wipe(doc.source.root_dir);
  }

  // 9. Idle. R22 (MicroVM): Cloud's /idle suspends this VM before it answers, so the agent must already be idle
  // (suspendable, free for the next job) when the request goes out. Fargate reports idle, then exits.
  if (deps.mode === 'microvm') deps.onPhase('idle');
  try {
    await reportIdle(p.api_base, doc.runner_token, doc.deployment_id, deps.fetchImpl, sleep);
    result.idleReported = true;
  } catch (e) {
    log(messageOf(e));
  }
  return result;
}

/** Steps 4-6: source, cache restore, build commands. Returns whether the restore failed transiently (R23). */
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
  let hasSubmodules: boolean;
  try {
    ({ hasSubmodules } = await checkout(doc, {
      paths, identity, env, signal, keep: repoKeep(doc.source.root_dir),
      onLine: (l) => s.batcher.addLine(cutLine(l)),
      ...deps.checkoutOptions,
    }));
  } finally {
    // Also after a failed clone: the token is single-purpose either way.
    await revokeGithubToken(doc.source.clone_url, doc.source.auth_header, deps.fetchImpl);
  }
  if (hasSubmodules) steps.note('build.clone', 'Submodules are not checked out');
  const projectDir = await resolveProjectDir(paths.repo, doc.source.root_dir);
  steps.done('build.clone');
  cancelled();

  // 5. Cache restore: only when this VM has not built with a cache yet
  let restoreTransientFailure = false;
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
      // Only CacheError carries a kind; anything else is a local failure, not a reason to keep a bad object.
      restoreTransientFailure = e instanceof CacheError && e.kind === 'transient';
      steps.warning('build.cache_restore', `Cache restore failed, building without it: ${messageOf(e)}`);
    }
  }
  cancelled();

  // 6. Build commands
  await runBuildCommands(doc.commands, {
    projectDir, env, identity, batcher: s.batcher, steps, deadlineMs, signal, timeoutSeconds: doc.timeout_seconds,
  });
  return restoreTransientFailure;
}

/** Kills every build-user process (R13); null when there is no build user to kill (tests without identity). */
function buildProcessKiller(deps: JobDeps): (() => Promise<void>) | null {
  const identity = deps.identity;
  return deps.killBuildProcesses ?? (identity ? () => killUserProcesses(identity.uid) : null);
}

/** The customer's env for arco: Cloud's start answer is the only source of ARCO_PERMISSIONS_BOUNDARY. */
function arcoJobEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== 'ARCO_PERMISSIONS_BOUNDARY'));
}

/**
 * Step 7: arco checks, then the shared deploy phase, which sends finish; returns its exit code (0 = success).
 * Re-resolves root_dir: the build may have swapped it.
 */
async function deploy(doc: JobDocument, deps: JobDeps, s: RunSession, signal: AbortSignal, now: () => number): Promise<number> {
  const projectDir = await resolveProjectDir(deps.paths.repo, doc.source.root_dir);
  if (!(await arcoInstalled(projectDir, deps.identity))) throw new BuildFailure('arco.not_installed', ARCO_MISSING);
  const expiresAt = Date.parse(s.started.credentials.expiration);
  if (!Number.isFinite(expiresAt) || expiresAt - now() < MIN_CREDENTIAL_TTL_MS) {
    throw new BuildFailure('runner_credentials_expiring', 'The deploy credentials expire in less than 20 minutes; arco deploy was not started');
  }
  if (signal.aborted) throw new BuildFailure('build.cancelled', 'Cancelled');
  // M3: no background build process may live next to arco (it could read /proc/<arco>/environ). A failure is an
  // internal error (finish failed runner.internal_error, then the usual wipe).
  const kill = buildProcessKiller(deps);
  if (kill) {
    try {
      await kill();
    } catch (e) {
      throw new Error(`build processes survived before arco deploy: ${messageOf(e)}`);
    }
  }
  // A cancel stops arco like a run Cloud ended; the RunAbortedError it causes is reported as build.cancelled.
  const view: RunSession = { ...s, signal, abortMessage: () => s.abortMessage() ?? (deps.signal.aborted ? 'Cancelled' : null) };
  return await deployAndFinish(view, {
    mode: doc.mode, environment: doc.environment, cwd: projectDir, env: buildEnv(deps.paths, arcoJobEnv(doc.env)),
    ...(deps.identity ? { uid: deps.identity.uid, gid: deps.identity.gid } : {}),
  });
}

/** Step 8, after finish: nothing reaches Cloud's logs any more, diagnostics go to stdout only. */
async function save(doc: JobDocument, deps: JobDeps, now: () => number, log: (m: string) => void, savedBy: number): Promise<void> {
  try {
    // Ruling R13: no build process may be alive while the cache roots are walked and archived.
    const kill = buildProcessKiller(deps);
    if (kill) {
      try {
        await kill();
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
