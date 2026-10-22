#!/usr/bin/env node
// `npm run test:integration`: builds the runner image from the packaged zip (unless ARCO_RUNNER_IMAGE names an
// image that is already built), starts the compose project, runs the vitest scenarios, and always tears the
// project down (containers, networks, volumes), on failure and on Ctrl-C too.
//
//   ARCO_RUNNER_IMAGE   use this image as is (CI builds it in an earlier step)
//   ARCO_RUNNER_ZIP     the package-image.ts zip to build from (default build/image.zip)
//   extra arguments are passed to vitest (e.g. -t 'warm')
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const DEFAULT_IMAGE = 'arco-runner:php85-dev';

const sh = (cmd, args, o = {}) =>
  new Promise((ok) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: here, ...o });
    child.on('error', (e) => { console.error(e.message); ok(127); });
    child.on('close', (code, signal) => ok(code ?? (signal ? 1 : 0)));
  });

const must = async (cmd, args, o) => {
  const code = await sh(cmd, args, o);
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${code}`);
};

async function buildImage() {
  const zip = resolve(root, process.env.ARCO_RUNNER_ZIP ?? 'build/image.zip');
  if (!existsSync(zip)) {
    throw new Error(`${zip} not found: run scripts/fetch-inputs.ts and scripts/package-image.ts first (see README), or set ARCO_RUNNER_IMAGE`);
  }
  const ctx = await mkdtemp(join(tmpdir(), 'arco-runner-image-'));
  try {
    await must('unzip', ['-q', zip, '-d', ctx]);
    await must('docker', ['build', '--platform', 'linux/arm64', '-t', DEFAULT_IMAGE, ctx]);
  } finally {
    await rm(ctx, { recursive: true, force: true });
  }
  return DEFAULT_IMAGE;
}

let tornDown = false;
async function down(failed) {
  if (tornDown) return;
  tornDown = true;
  if (failed) await sh('docker', ['compose', 'logs', '--no-color', '--timestamps']);
  await sh('docker', ['compose', 'down', '--volumes', '--remove-orphans', '--timeout', '5']);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { void down(true).finally(() => process.exit(130)); });
}

let code = 1;
try {
  const image = process.env.ARCO_RUNNER_IMAGE || (await buildImage());
  process.env.ARCO_RUNNER_IMAGE = image;
  // A project left over by an interrupted run would hold the ports.
  await sh('docker', ['compose', 'down', '--volumes', '--remove-orphans', '--timeout', '5']);
  await must('docker', ['compose', 'up', '-d', '--build', '--wait']);
  code = await sh('npx', ['vitest', 'run', ...process.argv.slice(2)]);
} catch (e) {
  console.error(`integration: ${e.message}`);
  code = 1;
} finally {
  await down(code !== 0);
}
process.exit(code);
