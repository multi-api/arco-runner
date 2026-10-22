import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobDeps } from '../src/job/run-job.js';
import { WipeError } from '../src/wipe.js';

const hoisted = vi.hoisted(() => ({ impl: null as null | ((p: unknown, deps: unknown) => Promise<unknown>) }));
vi.mock('../src/job/run-job.js', () => ({ runJob: (p: unknown, deps: unknown) => hoisted.impl!(p, deps) }));

const { Agent } = await import('../src/agent.js');
const { claim } = await import('../src/job/runner-api.js');

const P = { ticket: 'tkt_0123456789abcdef', api_base: 'https://cloud.example', deployment_id: 'dep-1' };
const baseDeps = { paths: {} as never, identity: null, mode: 'microvm' as const, wipe: async () => {} };
const tick = () => new Promise((r) => setTimeout(r, 10));

/** A stub job the test drives by hand. */
function stubJob() {
  const seen: { deps?: JobDeps; p?: unknown } = {};
  let finish!: (e?: unknown) => void;
  const done = new Promise<void>((res, rej) => { finish = (e) => (e ? rej(e) : res()); });
  hoisted.impl = async (p, deps) => { seen.p = p; seen.deps = deps as JobDeps; await done; return {}; };
  return { seen, finish };
}

describe('Agent', () => {
  beforeEach(() => { hoisted.impl = async () => ({}); });

  it('accepts one job at a time', async () => {
    const job = stubJob();
    const a = new Agent(baseDeps);
    expect(a.accept(P)).toBe('accepted');
    expect(a.state).toBe('running');
    expect(a.accept(P)).toBe('busy');
    job.finish();
    await a.whenIdle();
    expect(a.state).toBe('idle');
    expect(a.accept(P)).toBe('accepted');
  });

  it('cannot suspend while the job is running, saving or wiping, only after', async () => {
    const job = stubJob();
    const a = new Agent(baseDeps);
    expect(a.canSuspend()).toBe(true);
    a.accept(P);
    await tick();
    for (const phase of ['running', 'saving', 'wiping'] as const) {
      job.seen.deps!.onPhase(phase);
      expect(a.state).toBe(phase);
      expect(a.canSuspend()).toBe(false);
    }
    job.finish();
    await a.whenIdle();
    expect(a.canSuspend()).toBe(true);
  });

  it('a wipe that throws leaves the agent dirty for good', async () => {
    hoisted.impl = async (_p, deps) => { await (deps as JobDeps).wipe('.'); return {}; };
    const logs: string[] = [];
    const a = new Agent({ ...baseDeps, wipe: async () => { throw new WipeError('cannot kill'); }, log: (m) => logs.push(m) });
    a.accept(P);
    await a.whenIdle();
    expect(a.state).toBe('dirty');
    expect(a.canSuspend()).toBe(false);
    expect(a.accept(P)).toBe('busy');
    expect(a.cancel('dep-1')).toBe('idle');
    expect(logs.join('\n')).toContain('cannot kill');
  });

  it('any job rejection is dirty (customer code may have run)', async () => {
    hoisted.impl = async () => { throw new Error('boom'); };
    const a = new Agent({ ...baseDeps, log: () => {} });
    a.accept(P);
    await a.whenIdle();
    expect(a.state).toBe('dirty');
  });

  it('cancel with another deployment id is idle and does not abort', async () => {
    const job = stubJob();
    const a = new Agent(baseDeps);
    a.accept(P);
    await tick();
    expect(a.cancel('other')).toBe('idle');
    expect(job.seen.deps!.signal.aborted).toBe(false);
    expect(a.cancel('dep-1')).toBe('cancelling');
    expect(job.seen.deps!.signal.aborted).toBe(true);
    job.finish();
    await a.whenIdle();
    expect(a.cancel('dep-1')).toBe('idle');
  });

  it('cancel right after accept (before the job starts) still reaches the signal', async () => {
    const job = stubJob();
    const a = new Agent(baseDeps);
    a.accept(P);
    expect(a.cancel('dep-1')).toBe('cancelling');
    await tick();
    expect(job.seen.deps!.signal.aborted).toBe(true);
    job.finish();
    await a.whenIdle();
  });

  it('keeps the known cache in memory across jobs', async () => {
    const seenCaches: unknown[] = [];
    hoisted.impl = async (_p, deps) => {
      const d = deps as JobDeps;
      seenCaches.push(d.knownCache.get());
      d.knownCache.set({ version: 1, key: 'k', lock: {} as never, created_at: 'x' });
      return {};
    };
    const a = new Agent(baseDeps);
    a.accept(P); await a.whenIdle();
    a.accept(P); await a.whenIdle();
    expect(seenCaches[0]).toBeNull();
    expect((seenCaches[1] as { key: string }).key).toBe('k');
  });

  it('terminate aborts the job and resolves once it has ended', async () => {
    let ended = false;
    hoisted.impl = async (_p, deps) => {
      await new Promise<void>((r) => (deps as JobDeps).signal.addEventListener('abort', () => r()));
      await tick(); ended = true; return {};
    };
    const a = new Agent(baseDeps);
    a.accept(P);
    await tick();
    await a.terminate();
    expect(ended).toBe(true);
  });

  // Review Focus 3: a VM resumed hours later holds idle keep-alive sockets the peer has since reset.
  describe('after resume', () => {
    let server: Server;
    afterEach(() => new Promise((r) => server.close(() => r(null))));

    it('claims successfully against a server that destroyed the idle sockets', async () => {
      const sockets = new Set<import('node:net').Socket>();
      let claims = 0;
      server = createServer((req, res) => {
        if (req.url === '/api/v1/runner/claim') claims++;
        res.writeHead(claims > 0 && req.url?.endsWith('claim') ? 409 : 200, { 'Content-Type': 'application/json', 'Keep-Alive': 'timeout=600' });
        res.end('{}');
      });
      server.keepAliveTimeout = 600_000;
      server.on('connection', (s) => sockets.add(s));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

      await (await fetch(`${base}/warm`)).text(); // pools a keep-alive socket in the global dispatcher
      const g = globalThis as Record<symbol, unknown>;
      const before = g[Symbol.for('undici.globalDispatcher.1')];
      for (const s of sockets) s.destroy(); // the peer resets everything while the VM was suspended

      const a = new Agent(baseDeps);
      a.resume();
      expect(g[Symbol.for('undici.globalDispatcher.1')]).not.toBe(before);

      const doc = await claim({ ...P, api_base: base }, { now: Date.now, sleep: async () => {}, receivedAt: Date.now() });
      expect(claims).toBe(1); // reached the server on the first try (refused 409 -> null, but delivered)
      expect(doc).toBeNull();
    });
  });
});
