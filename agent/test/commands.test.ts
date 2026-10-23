import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Batcher } from '@multiapi/arco-cloud-client';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildFailure } from '../src/job/errors.js';
import { isJsCommand, runBuildCommands, runShell } from '../src/job/commands.js';
import { Steps } from '../src/job/steps.js';

const dirs: string[] = [];
async function setup(opts: { packageJson?: boolean; deadlineIn?: number; signal?: AbortSignal } = {}) {
  const projectDir = await mkdtemp(join(tmpdir(), 'arco-cmd-'));
  dirs.push(projectDir);
  if (opts.packageJson) await writeFile(join(projectDir, 'package.json'), '{}');
  const lines: string[] = [];
  const events: any[] = [];
  const batcher = { addLine: (l: string) => lines.push(l), addEvent: (e: unknown) => events.push(e) } as unknown as Batcher;
  const steps = new Steps(batcher);
  const ctx = {
    projectDir,
    env: { PATH: process.env.PATH, HOME: projectDir },
    identity: null,
    batcher,
    steps,
    deadlineMs: Date.now() + (opts.deadlineIn ?? 60_000),
    signal: opts.signal ?? new AbortController().signal,
  };
  return { ctx, lines, events, projectDir };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('isJsCommand', () => {
  it('detects package-manager commands after env assignments', () => {
    expect(isJsCommand('npm ci')).toBe(true);
    expect(isJsCommand('FOO=1 npm run build')).toBe(true);
    expect(isJsCommand('A=1 B=2 corepack enable')).toBe(true);
    expect(isJsCommand('composer install')).toBe(false);
    expect(isJsCommand('echo npm')).toBe(false);
  });
});

describe('runBuildCommands', () => {
  it('runs steps in order and fails on non-zero exit', async () => {
    const { ctx, events } = await setup();
    await expect(runBuildCommands(['echo one', 'exit 3'], ctx)).rejects.toMatchObject({
      code: 'build.command_failed',
      message: '`exit 3` exited with code 3',
    });
    expect(events.map((e) => [e.key, e.status])).toEqual([
      ['build.command.1', 'started'],
      ['build.command.1', 'done'],
      ['build.command.2', 'started'],
    ]);
    expect(events[0].params.command).toBe('echo one');
    expect(events[2].params.command).toBe('exit 3');
    expect(events[1].elapsed_ms).toBeTypeOf('number');
  });

  it('skips JS commands without package.json', async () => {
    const { ctx, events } = await setup();
    await runBuildCommands(['npm ci', 'FOO=1 npm run build'], ctx);
    expect(events.map((e) => [e.key, e.status])).toEqual([
      ['build.command.1', 'note'],
      ['build.command.2', 'note'],
    ]);
    expect(events[0].message).toBe('Skipped: no package.json');
    expect(events[0].params.command).toBe('npm ci');
  });

  it('does not skip JS commands when package.json exists', async () => {
    const { ctx, events } = await setup({ packageJson: true });
    await expect(runBuildCommands(['npm --version >/dev/null; exit 0'], ctx)).resolves.toBeUndefined();
    expect(events[0].status).toBe('started');
  });

  it('times out at the deadline and kills the process group', async () => {
    const { ctx } = await setup({ deadlineIn: 1000 });
    const t0 = Date.now();
    await expect(runBuildCommands(['sleep 5'], ctx)).rejects.toMatchObject({ code: 'build.timeout' });
    expect(Date.now() - t0).toBeLessThan(7000);
  }, 10_000);

  it('reports a timeout message with seconds', async () => {
    const { ctx } = await setup({ deadlineIn: 1000 });
    await expect(runBuildCommands(['sleep 5'], { ...ctx, timeoutSeconds: 42 } as typeof ctx)).rejects.toThrow(
      'The build did not finish within 42 seconds',
    );
  }, 10_000);

  it('cancels on abort', async () => {
    const ac = new AbortController();
    const { ctx } = await setup({ signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    await expect(runBuildCommands(['sleep 30'], ctx)).rejects.toMatchObject({ code: 'build.cancelled', message: 'Cancelled' });
  }, 10_000);

  it('survives invalid UTF-8 and a last line without newline', async () => {
    const { ctx, lines } = await setup();
    await runBuildCommands([`printf '\\xff\\xfe bad\\nlast-no-newline'`], ctx);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('last-no-newline');
  });

  it('cuts very long lines', async () => {
    const { ctx, lines } = await setup();
    await runBuildCommands([`head -c 20000 /dev/zero | tr '\\0' a; echo`], ctx);
    expect(lines).toHaveLength(1);
    expect(Buffer.byteLength(lines[0]!)).toBeLessThanOrEqual(16_384);
    expect(lines[0]).toContain('…[truncated]');
  });

  it('completes when a background process holds stdout (settleAfterExitMs)', async () => {
    const { ctx, events } = await setup();
    const marker = `arco-leftover-${process.pid}-${Date.now()}`;
    const t0 = Date.now();
    try {
      await runBuildCommands([`sleep 300 & echo started # ${marker}`], ctx);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(events.at(-1)).toMatchObject({ key: 'build.command.1', status: 'done' });
    } finally {
      await import('node:child_process').then((c) => c.spawnSync('pkill', ['-f', marker]));
      await import('node:child_process').then((c) => c.spawnSync('pkill', ['-f', 'sleep 300']));
    }
  }, 10_000);
});

describe('reusable runner', () => {
  it('uses the key prefix and failure code it is given', async () => {
    const { ctx, events } = await setup();
    await expect(
      runBuildCommands(['echo hi', 'exit 2'], { ...ctx, keyPrefix: 'build.test_setup', failureCode: 'build.test_setup_failed' }),
    ).rejects.toMatchObject({ code: 'build.test_setup_failed' });
    expect(events.map((e) => e.key)).toEqual(['build.test_setup.1', 'build.test_setup.1', 'build.test_setup.2']);
  });

  it('runShell kills at its own deadline with the given failure', async () => {
    const { ctx } = await setup();
    const timeoutFailure = new BuildFailure('build.tests_timeout', 'too slow');
    const started = Date.now();
    await expect(runShell('sleep 30', ctx, { deadlineMs: Date.now() + 1000, timeoutFailure })).rejects.toBe(timeoutFailure);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('runShell honours pipefail', async () => {
    const { ctx } = await setup();
    const failure = new BuildFailure('build.timeout', 'x');
    const o = { deadlineMs: Date.now() + 30_000, timeoutFailure: failure };
    expect(await runShell('false | cat', ctx, o)).toBe(0);
    expect(await runShell('false | cat', ctx, { ...o, pipefail: true })).toBe(1);
  });
});
