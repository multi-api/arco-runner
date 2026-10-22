import { runJob, type JobDeps, type JobPhase } from './job/run-job.js';
import type { CacheManifest } from './job/cache.js';
import type { TicketPayload } from './job/document.js';

export type AgentState = 'idle' | 'running' | 'saving' | 'wiping' | 'dirty';

export type AgentDeps = Omit<JobDeps, 'signal' | 'onPhase' | 'receivedAt' | 'knownCache'>;

const TERMINATE_WAIT_MS = 8000;
const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

const messageOf = (e: unknown): string => {
  const m = (e as { message?: unknown } | null)?.message;
  return (typeof m === 'string' && m ? m : String(e)).split('\n')[0]!.slice(0, 1000);
};

/** Spec §6.2: one job at a time, `dirty` is terminal. */
export class Agent {
  private current: AgentState = 'idle';
  private job: { deploymentId: string; abort: AbortController; done: Promise<void> } | null = null;
  private cache: CacheManifest | null = null;
  private jobEverAccepted = false;
  private validationResult: 'running' | 'passed' | 'failed' | null = null;

  constructor(private readonly deps: AgentDeps) {}

  get state(): AgentState { return this.current; }

  accept(p: TicketPayload): 'accepted' | 'busy' {
    if (this.current !== 'idle') return 'busy';
    this.current = 'running';
    this.jobEverAccepted = true;
    const receivedAt = Date.now();
    let resolveDone!: () => void;
    const job = { deploymentId: p.deployment_id, abort: new AbortController(), done: new Promise<void>((r) => { resolveDone = r; }) };
    this.job = job;
    setImmediate(() => { void this.execute(p, job, receivedAt).finally(resolveDone); });
    return 'accepted';
  }

  /** The job still owns the slot (it has not reached its idle phase, which detaches it). */
  private owns(job: NonNullable<Agent['job']>): boolean { return this.job === job; }

  /**
   * R22: Cloud's `/idle` suspends this VM before it answers, so once the wipe is done (phase `idle`) the agent is
   * idle and the slot is free at once; the idle report then runs detached and its outcome is only logged.
   */
  private detach(job: NonNullable<Agent['job']>): void {
    if (!this.owns(job) || this.current === 'dirty') return;
    this.current = 'idle';
    this.job = null;
  }

  private async execute(p: TicketPayload, job: NonNullable<Agent['job']>, receivedAt: number): Promise<void> {
    const log = this.deps.log ?? ((m: string) => console.log(`[arco-runner] ${m}`));
    try {
      await runJob(p, {
        ...this.deps,
        signal: job.abort.signal,
        receivedAt,
        knownCache: { get: () => this.cache, set: (m) => { this.cache = m; } },
        onPhase: (ph: JobPhase) => {
          if (!this.owns(job) || this.current === 'dirty') return;
          if (ph === 'idle') this.detach(job);
          else this.current = ph;
        },
      });
      if (this.owns(job)) this.current = 'idle';
    } catch (e) {
      if (this.owns(job)) {
        // runJob only rejects when the wipe failed (or something unforeseen after customer code ran): the VM
        // cannot be trusted any more, so it never takes another job and /suspend answers 503 until Cloud ends it.
        this.current = 'dirty';
        log(`deployment ${p.deployment_id} left the VM dirty: ${messageOf(e)}`);
      } else {
        // After the idle phase the VM was already clean; a newer job may own the slot now.
        log(`deployment ${p.deployment_id} failed after it was idle: ${messageOf(e)}`);
      }
    } finally {
      if (this.owns(job)) this.job = null;
    }
  }

  /** The cached result of the image validation, null before it was asked for. */
  get validation(): 'running' | 'passed' | 'failed' | null { return this.validationResult; }

  /**
   * R18: the image validation (spec 9.3) runs inside the state machine: `running` meanwhile (so /job is busy and
   * /suspend 503), `dirty` if it fails. Only on a VM that never accepted a job; repeated calls return the cached result.
   */
  validate(fn: () => Promise<void>): 'started' | 'busy' | 'refused' {
    if (this.jobEverAccepted) return 'refused';
    if (this.validationResult !== null) return 'started';
    if (this.current !== 'idle') return 'busy';
    this.validationResult = 'running';
    this.current = 'running';
    const log = this.deps.log ?? ((m: string) => console.log(`[arco-runner] ${m}`));
    let started: Promise<void>;
    try { started = fn(); } catch (e) { started = Promise.reject(e); }
    const done = started.then(
      () => { this.validationResult = 'passed'; this.current = 'idle'; },
      (e) => { this.validationResult = 'failed'; this.current = 'dirty'; log(`validation failed: ${messageOf(e)}`); },
    );
    this.job = { deploymentId: '', abort: new AbortController(), done };
    void done.finally(() => { this.job = null; });
    return 'started';
  }

  cancel(deploymentId: string): 'cancelling' | 'idle' {
    if (this.job && this.job.deploymentId !== '' && this.job.deploymentId === deploymentId && this.current !== 'dirty') {
      this.job.abort.abort();
      return 'cancelling';
    }
    return 'idle';
  }

  canSuspend(): boolean { return this.current === 'idle'; }

  /**
   * After a suspend: the claim and idle calls open a fresh connection each time, but the global fetch (the run
   * session's start/logs/finish) pools sockets. Swap Node's global undici dispatcher for a new one of the same
   * class and close the old one, so no dead keep-alive socket from before the snapshot is reused. A no-op while
   * nothing has used the global dispatcher yet.
   */
  resume(): void {
    const g = globalThis as Record<symbol, unknown>;
    const old = g[GLOBAL_DISPATCHER] as { constructor: new () => unknown; close?: () => Promise<void> } | undefined;
    if (!old) return;
    try {
      g[GLOBAL_DISPATCHER] = new old.constructor();
      void old.close?.().catch(() => {});
    } catch {
      /* keep the old dispatcher: a stale socket is retried by the callers */
    }
  }

  /** Aborts any job and resolves once it has ended (its children are killed by the abort) or after 8 s. */
  async terminate(): Promise<void> {
    const job = this.job;
    if (!job) return;
    job.abort.abort();
    await Promise.race([job.done, new Promise<void>((r) => setTimeout(r, TERMINATE_WAIT_MS).unref())]);
  }

  async whenIdle(): Promise<void> {
    while (this.job) await this.job.done;
  }
}
