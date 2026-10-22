import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/agent.js';
import { startServers } from '../src/servers.js';

const HOOK = '/aws/lambda-microvms/runtime/v1';
const GOOD = { ticket: 'tkt_0123456789abcdef', api_base: 'https://cloud.example', deployment_id: 'dep-1' };

function fakeAgent(over: Partial<Record<string, unknown>> = {}) {
  const a = {
    state: 'idle',
    accept: vi.fn(() => 'accepted'),
    cancel: vi.fn(() => 'idle'),
    canSuspend: vi.fn(() => true),
    resume: vi.fn(),
    ...over,
  };
  return a as unknown as Agent & typeof a;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

async function boot(agent: Agent, o: Partial<Parameters<typeof startServers>[1]> = {}) {
  const logs: string[] = [];
  const onTerminate = vi.fn();
  const s = await startServers(agent, {
    hooksPort: 0, controlPort: 0, ready: async () => true, validate: async () => 'passed', allowHttp: false,
    onTerminate, log: (m) => logs.push(m), ...o,
  });
  closers.push(s.close);
  const hooks = (p: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${s.hooksPort}${HOOK}/${p}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  const ctl = (method: string, p: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${s.controlPort}${p}`, { method, body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body) });
  return { hooks, ctl, logs, onTerminate };
}

describe('hooks server', () => {
  it('/run with {} or an empty body is a no-op 200', async () => {
    const agent = fakeAgent();
    const { hooks } = await boot(agent);
    expect((await hooks('run', {})).status).toBe(200);
    expect((await hooks('run')).status).toBe(200);
    expect(agent.accept).not.toHaveBeenCalled();
  });

  it('/run with a ticket accepts it; busy is logged but still 200', async () => {
    const agent = fakeAgent();
    const { hooks, logs } = await boot(agent);
    expect((await hooks('run', GOOD)).status).toBe(200);
    expect(agent.accept).toHaveBeenCalledWith(GOOD);
    agent.accept.mockReturnValueOnce('busy');
    expect((await hooks('run', GOOD)).status).toBe(200);
    expect(logs.join('\n')).toMatch(/busy/);
    expect(logs.join('\n')).not.toContain(GOOD.ticket);
  });

  it('/run with an invalid api_base is 200, logged, nothing starts', async () => {
    const agent = fakeAgent();
    const { hooks, logs } = await boot(agent);
    expect((await hooks('run', { ...GOOD, api_base: 'http://cloud.example' })).status).toBe(200);
    expect(agent.accept).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/api_base/);
    expect(logs.join('\n')).not.toContain(GOOD.ticket);
  });

  it('allowHttp lets an http api_base through', async () => {
    const agent = fakeAgent();
    const { hooks } = await boot(agent, { allowHttp: true });
    await hooks('run', { ...GOOD, api_base: 'http://127.0.0.1:1' });
    expect(agent.accept).toHaveBeenCalled();
  });

  it('/ready is 200 or 503', async () => {
    let ok = false;
    const { hooks } = await boot(fakeAgent(), { ready: async () => ok });
    expect((await hooks('ready')).status).toBe(503);
    ok = true;
    expect((await hooks('ready')).status).toBe(200);
  });

  it('/validate maps running, passed, failed to 503, 200, 500', async () => {
    let r: 'running' | 'passed' | 'failed' = 'running';
    const { hooks } = await boot(fakeAgent(), { validate: async () => r });
    expect((await hooks('validate')).status).toBe(503);
    r = 'passed';
    expect((await hooks('validate')).status).toBe(200);
    r = 'failed';
    expect((await hooks('validate')).status).toBe(500);
  });

  it('/resume calls agent.resume; /suspend follows canSuspend', async () => {
    const agent = fakeAgent();
    const { hooks } = await boot(agent);
    expect((await hooks('resume')).status).toBe(200);
    expect(agent.resume).toHaveBeenCalled();
    expect((await hooks('suspend')).status).toBe(200);
    agent.canSuspend.mockReturnValue(false);
    expect((await hooks('suspend')).status).toBe(503);
  });

  it('/terminate answers 200 then calls onTerminate', async () => {
    const { hooks, onTerminate } = await boot(fakeAgent());
    expect((await hooks('terminate')).status).toBe(200);
    await vi.waitFor(() => expect(onTerminate).toHaveBeenCalled());
  });

  it('unknown hook path is 404', async () => {
    const { hooks } = await boot(fakeAgent());
    expect((await hooks('nope')).status).toBe(404);
  });
});

describe('control server', () => {
  it('POST /job: 202 accepted, 409 busy, 400 invalid', async () => {
    const agent = fakeAgent();
    const { ctl } = await boot(agent);
    expect((await ctl('POST', '/job', GOOD)).status).toBe(202);
    agent.accept.mockReturnValueOnce('busy');
    const busy = await ctl('POST', '/job', GOOD);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'busy' });
    expect((await ctl('POST', '/job', { ...GOOD, api_base: 'http://x' })).status).toBe(400);
    expect((await ctl('POST', '/job', {})).status).toBe(400);
  });

  it('POST /job with malformed JSON is 400', async () => {
    const { ctl } = await boot(fakeAgent());
    expect((await ctl('POST', '/job', '{nope')).status).toBe(400);
  });

  it('POST /cancel: 202 cancelling or 200 idle', async () => {
    const agent = fakeAgent();
    const { ctl } = await boot(agent);
    const idle = await ctl('POST', '/cancel', { deployment_id: 'dep-1' });
    expect(idle.status).toBe(200);
    expect(await idle.json()).toEqual({ state: 'idle' });
    agent.cancel.mockReturnValueOnce('cancelling');
    const c = await ctl('POST', '/cancel', { deployment_id: 'dep-1' });
    expect(c.status).toBe(202);
    expect(await c.json()).toEqual({ state: 'cancelling' });
    expect(agent.cancel).toHaveBeenCalledWith('dep-1');
  });

  it('GET /healthz reports the state', async () => {
    const { ctl } = await boot(fakeAgent({ state: 'running' }));
    const res = await ctl('GET', '/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'running' });
  });
});
