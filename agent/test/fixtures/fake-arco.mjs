#!/usr/bin/env node
// Stand-in for vendor/bin/arco. Behaviour is selected via env:
//   FAKE_ARCO_SCENARIO = deployed (default) | failed | refused | leakyfail | crash | opterror
//   (deploy scenarios hang | stubborn block until killed; stubborn ignores SIGTERM; both append `pid` to FAKE_ARCO_CALLS)
//   FAKE_ARCO_ENVDUMP  = file to write the child's environment (JSON) to
//   FAKE_ARCO_INFO     = ok (default) | bad | fail
//   FAKE_ARCO_CALLS    = file to append each invocation's argv to
import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_ARCO_CALLS) appendFileSync(process.env.FAKE_ARCO_CALLS, args.join(' ') + '\n');
if (process.env.FAKE_ARCO_ENVDUMP) writeFileSync(process.env.FAKE_ARCO_ENVDUMP, JSON.stringify(process.env));
if (process.env.FAKE_ARCO_ENVDUMP) writeFileSync(`${process.env.FAKE_ARCO_ENVDUMP}.${args[0]}`, JSON.stringify(process.env)); // per-command dump
const scenario = process.env.FAKE_ARCO_SCENARIO ?? 'deployed';
const at = '2026-10-21T12:00:00Z';
const emit = (o) => console.log(JSON.stringify({ schema: 1, at, ...o }));

if (args[0] === '--version') {
  console.log('Arco 0.10.0');
} else if (args[0] === 'deploy' && scenario === 'opterror') {
  console.error('The "--bogus" option does not exist.');
  process.exit(1);
} else if (args[0] === 'deploy') {
  // Register before the first output so a stop can never race ahead of these.
  if (scenario === 'stubborn') process.on('SIGTERM', () => {});
  if (scenario === 'hang' || scenario === 'stubborn') appendFileSync(process.env.FAKE_ARCO_CALLS, `pid ${process.pid}\n`);
  console.log('plain line before events');
  emit({ type: 'step', key: 'deploy.build', status: 'started', params: {} });
  // A leaky tool printing its environment: Cloud must never receive this.
  console.log(`debug AWS_SECRET_ACCESS_KEY=${process.env.AWS_SECRET_ACCESS_KEY} region=${process.env.AWS_REGION}`);
  emit({ type: 'progress', key: 'binary.download', percent: 50 });
  console.error('stderr line');
  if (scenario === 'hang' || scenario === 'stubborn') {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (scenario === 'crash') process.exit(2);
  if (scenario === 'refused') {
    emit({ type: 'result', outcome: 'refused', app: 'shop', environment: 'production', revision: null, url: null, domains: [], rolled_back: true, cold_start_ms: null, error: { key: 'deploy.confirm_required', message: 'Confirmation needed' } });
    process.exit(1);
  }
  if (scenario === 'failed') {
    emit({ type: 'result', outcome: 'failed', app: 'shop', environment: 'production', revision: 'r41', url: null, domains: [], rolled_back: true, cold_start_ms: null, error: { key: 'deploy.health_check_failed', message: 'Health check failed' } });
    process.exit(1);
  }
  if (scenario === 'leakyfail') {
    emit({ type: 'result', outcome: 'failed', app: 'shop', environment: 'production', revision: null, url: null, domains: [], rolled_back: false, cold_start_ms: null, error: { key: 'deploy.boom', message: `denied for ${process.env.AWS_SECRET_ACCESS_KEY}` } });
    process.exit(1);
  }
  const base = { type: 'result', outcome: 'deployed', app: 'shop', environment: 'production', revision: 'r42', url: 'https://x.example', domains: [], rolled_back: false, cold_start_ms: 120, error: null };
  // FAKE_ARCO_RESULT = JSON merged over the deployed result; a null value deletes the key.
  const over = JSON.parse(process.env.FAKE_ARCO_RESULT ?? '{}');
  const merged = { ...base, ...over };
  for (const k of Object.keys(merged)) if (merged[k] === '__absent__') delete merged[k];
  emit(merged);
} else if (args[0] === 'info') {
  const mode = process.env.FAKE_ARCO_INFO ?? 'ok';
  if (mode === 'fail') process.exit(1);
  if (mode === 'bad') console.log('not json');
  else console.log(JSON.stringify({ schema: 1, app: 'shop', environment: 'production', group: 'g', resources: [{ type: 'queue', name: 'jobs', arn: 'arn:q', retained: false, relations: [{ type: 'worker_of', target: 'fn' }] }] }));
}
