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

  constructor(private readonly deps: AgentDeps) {}

  get state(): AgentState { return this.current; }

  accept(p: TicketPayload): 'accepted' | 'busy' {
    if (this.current !== 'idle') return 'busy';
    this.current = 'running';
    const abort = new AbortController();
    const receivedAt = Date.now();
    const done = new Promise<void>((resolve) => {
      setImmediate(() => { void this.execute(p, abort, receivedAt).finally(resolve); });
    });
    this.job = { deploymentId: p.deployment_id, abort, done };
    return 'accepted';
  }

  private async execute(p: TicketPayload, abort: AbortController, receivedAt: number): Promise<void> {
    const log = this.deps.log ?? ((m: string) => console.log(`[arco-runner] ${m}`));
    try {
      await runJob(p, {
        ...this.deps,
        signal: abort.signal,
        receivedAt,
        knownCache: { get: () => this.cache, set: (m) => { this.cache = m; } },
        onPhase: (ph: JobPhase) => { if (this.current !== 'dirty') this.current = ph; },
      });
      this.current = 'idle';
    } catch (e) {
      // runJob only rejects when the wipe failed (or something unforeseen after customer code ran): the VM
      // cannot be trusted any more, so it never takes another job and /suspend answers 503 until Cloud ends it.
      this.current = 'dirty';
      log(`deployment ${p.deployment_id} left the VM dirty: ${messageOf(e)}`);
    } finally {
      this.job = null;
    }
  }

  cancel(deploymentId: string): 'cancelling' | 'idle' {
    if (this.job && this.job.deploymentId === deploymentId && this.current !== 'dirty') {
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
