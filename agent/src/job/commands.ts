import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, type Batcher } from '@multi-api/arco-cloud-client';
import { cutLine, type Identity } from '../system.js';
import { BuildFailure } from './errors.js';
import type { Steps } from './steps.js';

const JS_TOOLS = new Set(['npm', 'npx', 'yarn', 'pnpm', 'corepack']);

/** True when the first word, after leading `FOO=bar` assignments, is a JS package-manager command. */
export function isJsCommand(command: string): boolean {
  const words = command.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
  return JS_TOOLS.has(words[i] ?? '');
}

export interface BuildCommandsContext {
  projectDir: string;
  env: NodeJS.ProcessEnv;
  identity: Identity | null;
  batcher: Batcher;
  steps: Steps;
  /** Absolute deadline, compared with Date.now(). */
  deadlineMs: number;
  signal: AbortSignal;
  /** Only used for the timeout message; defaults to the time left when the commands started. */
  timeoutSeconds?: number;
}

/** Runs the build commands one by one as the build identity (spec §6.3 step 6). */
export async function runBuildCommands(commands: string[], ctx: BuildCommandsContext): Promise<void> {
  const timeoutSeconds = ctx.timeoutSeconds ?? Math.max(0, Math.round((ctx.deadlineMs - Date.now()) / 1000));
  for (const [i, command] of commands.entries()) {
    const key = `build.command.${i + 1}`;
    if (isJsCommand(command) && !existsSync(join(ctx.projectDir, 'package.json'))) {
      ctx.steps.note(key, 'Skipped: no package.json', { command });
      continue;
    }
    ctx.steps.start(key, { command });
    const exitCode = await runOne(command, ctx, timeoutSeconds);
    if (exitCode !== 0) throw new BuildFailure('build.command_failed', `\`${command}\` exited with code ${exitCode}`);
    ctx.steps.done(key);
  }
}

async function runOne(command: string, ctx: BuildCommandsContext, timeoutSeconds: number): Promise<number> {
  const timeout = new BuildFailure('build.timeout', `The build did not finish within ${timeoutSeconds} seconds`);
  if (ctx.signal.aborted) throw new BuildFailure('build.cancelled', 'Cancelled');
  const killer = new AbortController();
  let timedOut = false;
  const onAbort = () => killer.abort();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const tick = setInterval(() => {
    if (Date.now() >= ctx.deadlineMs) {
      timedOut = true;
      killer.abort();
    }
  }, 1000);
  tick.unref();
  if (Date.now() >= ctx.deadlineMs) {
    timedOut = true;
    killer.abort();
  }
  const onLine = (line: string) => ctx.batcher.addLine(cutLine(line));
  try {
    const { exitCode } = await runCommand('/bin/bash', ['-c', command], {
      cwd: ctx.projectDir,
      env: ctx.env,
      signal: killer.signal,
      onStdoutLine: onLine,
      onStderrLine: onLine,
      settleAfterExitMs: 2000,
      ...(ctx.identity ? { uid: ctx.identity.uid, gid: ctx.identity.gid } : {}),
    });
    if (timedOut) throw timeout;
    if (ctx.signal.aborted) throw new BuildFailure('build.cancelled', 'Cancelled');
    return exitCode;
  } catch (e) {
    if (e instanceof BuildFailure) throw e;
    if (timedOut) throw timeout;
    if (ctx.signal.aborted) throw new BuildFailure('build.cancelled', 'Cancelled');
    throw e;
  } finally {
    clearInterval(tick);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}
