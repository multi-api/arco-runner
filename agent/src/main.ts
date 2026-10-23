import { readFileSync } from 'node:fs';
import { Agent } from './agent.js';
import type { CacheManifest } from './job/cache.js';
import { parseTicketPayload, type TicketPayload } from './job/document.js';
import { runJob } from './job/run-job.js';
import { selfCheck } from './ready.js';
import { SERVICE_USERS, defaultServicePaths } from './services/catalog.js';
import { startServers } from './servers.js';
import { buildIdentity, defaultPaths } from './system.js';
import { runValidation } from './validate.js';
import { createServicesManager } from './services/manager.js';
import { wipe } from './wipe.js';

const HOOKS_PORT = 9000;
const CONTROL_PORT = 8080;
const FIXTURE_DIR = '/opt/arco-runner/fixture';
const FARGATE_EXIT_MS = 25_000;

const log = (m: string) => console.log(`[arco-runner] ${m}`);
const paths = defaultPaths();
const identity = buildIdentity();
const allowHttp = process.env.ARCO_RUNNER_ALLOW_HTTP === '1';
const fargateTicket = process.env.ARCO_RUNNER_TICKET;
const fargate = fargateTicket !== undefined && fargateTicket !== '';

// R14: customer code must never share root with the agent.
if (identity === null && process.env.ARCO_RUNNER_ALLOW_NONROOT !== '1') {
  console.log('arco-runner must run as root (it drops to the build user for customer code); set ARCO_RUNNER_ALLOW_NONROOT=1 only for development');
  process.exit(1);
}

process.on('uncaughtException', (e) => {
  console.error(`[arco-runner] uncaught exception: ${(e as Error).message}`);
  process.exit(1);
});

// The test services' uids, by name from /etc/passwd; a missing user (dev machine) is skipped.
const servicePaths = defaultServicePaths();
const serviceUids = (() => {
  let passwd = '';
  try { passwd = readFileSync('/etc/passwd', 'utf8'); } catch { /* none */ }
  const names: string[] = Object.values(SERVICE_USERS);
  return passwd.split('\n').map((l) => l.split(':')).filter((f) => names.includes(f[0] ?? '') && /^\d+$/.test(f[2] ?? ''))
    .map((f) => Number(f[2])).filter((u) => u > 0);
})();
const jobWipe = (rootDir: string) => wipe(paths, rootDir, {
  ...(identity ? { uid: identity.uid } : {}),
  services: { uids: serviceUids, dataDir: servicePaths.dataDir, runDir: servicePaths.runDir },
});
// ARCO_RUNNER_ALLOW_HTTP=1 (integration tests only) also lets the fake Cloud serve the clone over http://.
const checkoutOptions = allowHttp ? { allowHttpUrl: true } : undefined;
const services = () => createServicesManager(defaultServicePaths());

async function runFargate(): Promise<void> {
  let payload: TicketPayload;
  try {
    payload = parseTicketPayload(
      { ticket: fargateTicket, api_base: process.env.ARCO_RUNNER_API_BASE, deployment_id: process.env.ARCO_RUNNER_DEPLOYMENT_ID },
      allowHttp,
    );
  } catch (e) {
    console.log(`invalid Fargate environment: ${(e as Error).message}`);
    process.exit(1);
  }
  // The ticket is single-use and lives in memory only from here on.
  delete process.env.ARCO_RUNNER_TICKET;
  const abort = new AbortController();
  let cache: CacheManifest | null = null;
  process.on('SIGTERM', () => {
    log('SIGTERM: cancelling the job');
    abort.abort();
    setTimeout(() => process.exit(1), FARGATE_EXIT_MS).unref();
  });
  try {
    await runJob(payload, {
      paths, identity, mode: 'fargate', signal: abort.signal, receivedAt: Date.now(),
      knownCache: { get: () => cache, set: (m) => { cache = m; } },
      onPhase: () => {}, wipe: jobWipe, log, checkoutOptions, services,
    });
    process.exit(0);
  } catch (e) {
    console.error(`[arco-runner] job crashed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function runMicroVm(): Promise<void> {
  const agent = new Agent({ paths, identity, mode: 'microvm', wipe: jobWipe, log, checkoutOptions, services });

  let readyResult: Promise<boolean> | null = null;
  const ready = () => (readyResult ??= selfCheck(paths, identity, { paths: servicePaths, uids: serviceUids }).then((problem) => {
    if (problem) log(`self-check failed: ${problem}`);
    return problem === null;
  }));

  const servers = await startServers(agent, {
    hooksPort: HOOKS_PORT, controlPort: CONTROL_PORT, ready, allowHttp, validate: () => runValidation({ paths, identity, fixtureDir: FIXTURE_DIR }), log,
    onTerminate: () => { void agent.terminate().finally(() => process.exit(0)); },
  });
  log(`listening: hooks ${servers.hooksPort}, control ${servers.controlPort}`);
  process.on('SIGTERM', () => { void agent.terminate().finally(() => process.exit(0)); });
}

await (fargate ? runFargate() : runMicroVm());
