import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderDockerfile } from '../lib/dockerfile.ts';
import { readVersions } from '../lib/versions.ts';
import { createHash } from 'node:crypto';

const script = resolve(import.meta.dirname, '..', 'package-image.ts');
let work: string;

function run(inputs: string, out: string, env: Record<string, string> = {}): Promise<{ status: number | null; stderr: string }> {
  return new Promise((done) => {
    const c = spawn(process.execPath, ['--import', 'tsx', script, '--minor', '8.5', '--inputs', inputs, '--out', out,
      '--agent', join(work, 'agent.mjs'), '--fixture', join(work, 'fixture'), '--revision', 'abc'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
    let stderr = '';
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (status) => done({ status, stderr }));
  });
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'package-image-'));
  mkdirSync(join(work, 'fixture'));
  writeFileSync(join(work, 'agent.mjs'), '//');
  mkdirSync(join(work, 'inputs'));
  for (const f of ['php', 'frankenphp', 'composer.phar']) writeFileSync(join(work, 'inputs', f), 'tampered');
});

describe('package-image', () => {
  it('exits 1 naming the file when an input does not match versions.json', async () => {
    const r = await run(join(work, 'inputs'), join(work, 'out.zip'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('php:');
  });
});

describe('package-image tini', () => {
  it('re-checks tini against versions.json too', async () => {
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    const inputs = join(work, 'inputs-tini');
    mkdirSync(inputs);
    for (const [f, c] of [['php', 'p'], ['frankenphp', 'f'], ['composer.phar', 'c'], ['tini', 'tampered']] as const) writeFileSync(join(inputs, f), c);
    const v = readVersions();
    v.php['8.5'] = { ...v.php['8.5']!, php_cli_sha256: sha('p'), php_cli_size: 1, frankenphp_sha256: sha('f'), frankenphp_size: 1 };
    v.composer.sha256 = sha('c');
    v.tini = { version: '0.19.0', sha256: sha('tini'), size: 4 };
    const file = join(work, 'versions-tini.json');
    writeFileSync(file, JSON.stringify(v));
    const r = await run(inputs, join(work, 'out-tini.zip'), { ARCO_VERSIONS_FILE: file });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('tini:');
  });
});

describe('renderDockerfile', () => {
  it('pins digest, args and image name from versions.json', () => {
    const v = readVersions();
    const text = renderDockerfile(readFileSync(resolve(import.meta.dirname, '../../image/Dockerfile'), 'utf8'), {
      digest: 'sha256:' + 'a'.repeat(64), minor: '8.6', runtimeBuild: 'php8.6.0-fp9-r1', revision: 'deadbee', corepack: v.corepack.version,
    });
    expect(text).toContain('@sha256:' + 'a'.repeat(64));
    expect(text).toContain('ARG PHP_MINOR=8.6');
    expect(text).toContain('ARG RUNTIME_BUILD=php8.6.0-fp9-r1');
    expect(text).toContain('ARG REVISION=deadbee');
    expect(text).toContain('ENV ARCO_RUNNER_IMAGE=php86 ');
  });
});
