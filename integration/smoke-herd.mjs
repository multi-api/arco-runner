#!/usr/bin/env node
// `npm run smoke:herd`: runs the runner image against a local Arco Cloud served by Herd (spec §11.3). Manual, not
// in CI. It starts the image in MicroVM mode with ARCO_RUNNER_ALLOW_HTTP=1 and arco-cloud.test mapped to the host,
// waits for /ready, posts the ticket to /job the way Cloud does on a resumed VM, follows /healthz until the job is
// over, prints the agent's output and removes the container.
//
//   npm run smoke:herd -- --ticket <ticket> --deployment <id> [--api-base https://arco-cloud.test]
//                         [--image arco-runner:php85-dev] [--ca <Herd CA pem>]
//
// The ticket can also come from ARCO_SMOKE_TICKET (keeps it out of your shell history). Mint one in Cloud with
//   php artisan tinker --execute 'echo App\Runners\RunnerTickets::mint(App\Models\Deployment::findOrFail(<id>));'
// for a deployment that is dispatched to the `arco-runner` build provider. If the site is not secured in Herd
// (`herd secure arco-cloud`), pass `--api-base http://arco-cloud.test`.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    ticket: { type: 'string' },
    deployment: { type: 'string' },
    'api-base': { type: 'string', default: 'https://arco-cloud.test' },
    host: { type: 'string', default: 'arco-cloud.test' },
    image: { type: 'string', default: 'arco-runner:php85-dev' },
    ca: { type: 'string', default: join(homedir(), 'Library/Application Support/Herd/config/valet/CA/LaravelValetCASelfSigned.pem') },
    port: { type: 'string', default: '48080' },
    'timeout-minutes': { type: 'string', default: '30' },
  },
});
const ticket = a.ticket ?? process.env.ARCO_SMOKE_TICKET;
if (!ticket || !a.deployment) {
  console.error('usage: npm run smoke:herd -- --ticket <ticket> --deployment <id> [--api-base https://arco-cloud.test]');
  process.exit(2);
}

const NAME = 'arco-runner-smoke';
const control = `http://127.0.0.1:${a.port}`;
const docker = (args, inherit = true) =>
  new Promise((ok) => {
    const c = spawn('docker', args, { stdio: inherit ? 'inherit' : 'ignore' });
    c.on('close', (code) => ok(code ?? 1));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url) => {
  try {
    const r = await fetch(url);
    return { status: r.status, json: await r.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
};

const args = [
  'run', '-d', '--name', NAME, '--platform', 'linux/arm64',
  '-e', 'ARCO_RUNNER_ALLOW_HTTP=1',
  '--add-host', `${a.host}:host-gateway`,
  '-p', `127.0.0.1:${a.port}:8080`,
];
// Herd's sites use certificates from its own CA: trust it in the agent's Node (git and Composer are not affected).
if (a['api-base'].startsWith('https://') && existsSync(a.ca)) {
  args.push('-v', `${a.ca}:/etc/arco-smoke-ca.pem:ro`, '-e', 'NODE_EXTRA_CA_CERTS=/etc/arco-smoke-ca.pem');
}
args.push(a.image);

await docker(['rm', '-f', NAME], false);
let code = 1;
try {
  if ((await docker(args)) !== 0) throw new Error('docker run failed');
  // /ready is on the hooks port, which is not published: /healthz answering means the servers listen.
  for (let i = 0; i < 120 && (await get(`${control}/healthz`)).status !== 200; i++) await sleep(500);
  const res = await fetch(`${control}/job`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket, api_base: a['api-base'], deployment_id: a.deployment }),
  });
  console.log(`POST /job -> ${res.status} ${await res.text()}`);
  if (res.status !== 202) throw new Error('the runner did not accept the job');
  const until = Date.now() + Number(a['timeout-minutes']) * 60_000;
  let last = '';
  let unreachable = 0;
  for (;;) {
    const state = (await get(`${control}/healthz`)).json?.state ?? 'unreachable';
    if (state !== last) console.log(`state: ${state}`);
    last = state;
    if (state === 'idle' || state === 'dirty') { code = state === 'idle' ? 0 : 1; break; }
    unreachable = state === 'unreachable' ? unreachable + 1 : 0;
    if (unreachable > 10) throw new Error('the runner stopped answering (did the container exit?)');
    if (Date.now() > until) throw new Error('timed out');
    await sleep(1000);
  }
} catch (e) {
  console.error(`smoke: ${e.message}`);
} finally {
  await docker(['logs', NAME]);
  await docker(['rm', '-f', NAME], false);
}
process.exit(code);
