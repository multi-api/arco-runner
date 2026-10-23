import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, '..', 'fetch-inputs.ts');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const files: Record<string, Buffer> = {
  '/frankenphp-1.13.1-r1/php-linux-aarch64': Buffer.from('fake php cli'),
  '/frankenphp-1.13.1-r1/frankenphp-linux-aarch64': Buffer.from('fake frankenphp'),
  '/composer/2.10.3/composer.phar': Buffer.from('fake composer'),
  '/tini/v0.19.0/tini-static-arm64': Buffer.from('fake tini'),
  '/mysql/mysql-8.4.13-linux-glibc2.28-aarch64.tar.xz': Buffer.from('fake mysql tarball'),
};
const mysqlAsset = 'mysql-8.4.13-linux-glibc2.28-aarch64.tar.xz';

let server: Server;
let base: string;
let work: string;
let fakeBin: string;
let ghLog: string;

function versionsFile(overrides: { phpSha?: string; phpSize?: number; release?: string; tiniSha?: string; mysqlSha?: string } = {}): string {
  const path = join(work, `versions-${Math.random().toString(36).slice(2)}.json`);
  const php = files['/frankenphp-1.13.1-r1/php-linux-aarch64']!;
  const fp = files['/frankenphp-1.13.1-r1/frankenphp-linux-aarch64']!;
  writeFileSync(
    path,
    JSON.stringify({
      php: {
        '8.5': {
          release: overrides.release ?? 'frankenphp-1.13.1-r1',
          runtime_build: '1.13.1-r1',
          arco_build_id: 'php8.5.12-fp1.13.1-r1',
          php_cli_sha256: overrides.phpSha ?? sha(php),
          php_cli_size: overrides.phpSize ?? php.length,
          frankenphp_sha256: sha(fp),
          frankenphp_size: fp.length,
        },
      },
      composer: { version: '2.10.3', sha256: sha(files['/composer/2.10.3/composer.phar']!) },
      tini: { version: '0.19.0', sha256: overrides.tiniSha ?? sha(files['/tini/v0.19.0/tini-static-arm64']!), size: files['/tini/v0.19.0/tini-static-arm64']!.length },
      base_image_digest: 'sha256:0',
      services: {
        mysql: {
          version: '8.4.13',
          asset: mysqlAsset,
          url: `${base}/mysql/${mysqlAsset}`,
          sha256: overrides.mysqlSha ?? sha(files[`/mysql/${mysqlAsset}`]!),
          size: files[`/mysql/${mysqlAsset}`]!.length,
        },
        postgresql: { package: 'postgresql17-server' },
        redis: { package: 'redis6' },
      },
    }),
  );
  return path;
}

// Async spawn: the test's own HTTP server must keep serving while the script runs.
function run(versions: string, out: string, extraEnv: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', script, '--minor', '8.5', '--out', out], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      ARCO_VERSIONS_FILE: versions,
      ARCO_RUNTIME_RELEASE_BASE: base,
      COMPOSER_DOWNLOAD_BASE: `${base}/composer`,
      TINI_DOWNLOAD_BASE: `${base}/tini`,
      FAKE_GH_LOG: ghLog,
      ...extraEnv,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise((ok) => child.on('close', (status) => ok({ status, stdout, stderr })));
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'fetch-inputs-'));
  fakeBin = join(work, 'bin');
  mkdirSync(fakeBin);
  ghLog = join(work, 'gh.log');
  writeFileSync(join(fakeBin, 'gh'), '#!/bin/sh\necho "$@" >> "$FAKE_GH_LOG"\n[ -n "$FAKE_GH_FAIL" ] && { echo "no matching attestation" >&2; exit 1; }\nexit 0\n');
  chmodSync(join(fakeBin, 'gh'), 0o755);
  server = createServer((req, res) => {
    const body = files[req.url ?? ''];
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe('fetch-inputs', () => {
  it('exits 1 and names the file when a sha256 does not match', async () => {
    const out = join(work, 'out-bad');
    const r = await run(versionsFile({ phpSha: 'f'.repeat(64) }), out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('php-linux-aarch64');
    expect(r.stderr).toContain('sha256');
    expect(readdirSync(out)).toEqual([]);
  });

  it('exits 1 and names the file when the size does not match', async () => {
    const out = join(work, 'out-size');
    const r = await run(versionsFile({ phpSize: 1 }), out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('php-linux-aarch64');
    expect(r.stderr).toContain('size');
    expect(readdirSync(out)).toEqual([]);
  });

  it('exits 1 and names the file when attestation verification fails', async () => {
    const out = join(work, 'out-attest');
    const r = await run(versionsFile(), out, { FAKE_GH_FAIL: '1' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('php-linux-aarch64');
    expect(r.stderr).toContain('attestation');
    expect(readdirSync(out)).toEqual([]); // no unverified bytes left behind
  });

  it('exits 1 and names tini when its sha256 does not match', async () => {
    const out = join(work, 'out-tini');
    const r = await run(versionsFile({ tiniSha: 'e'.repeat(64) }), out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('tini-static-arm64');
    expect(r.stderr).toContain('sha256');
    expect(existsSync(join(out, 'tini'))).toBe(false);
  });

  it('exits 1 naming the MySQL asset when its sha256 does not match', async () => {
    const out = join(work, 'out-mysql');
    const r = await run(versionsFile({ mysqlSha: 'd'.repeat(64) }), out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(mysqlAsset);
    expect(r.stderr).toContain('sha256');
    expect(existsSync(join(out, 'mysql.tar.xz'))).toBe(false);
    expect(readdirSync(out).filter((f) => f.startsWith('mysql'))).toEqual([]); // no .part left behind
  });

  it('downloads and verifies the MySQL tarball', async () => {
    const out = join(work, 'out-mysql-ok');
    const r = await run(versionsFile(), out);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`ok ${mysqlAsset}`);
    expect(readFileSync(join(out, 'mysql.tar.xz'), 'utf8')).toBe('fake mysql tarball');
  });

  it('exits 1 when a download returns 404', async () => {
    const out = join(work, 'out-404');
    const r = await run(versionsFile({ release: 'frankenphp-0.0.0' }), out);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('HTTP 404');
    expect(readdirSync(out)).toEqual([]);
  });

  it('downloads, verifies and attests every input when values are correct', async () => {
    const out = join(work, 'out-ok');
    rmSync(ghLog, { force: true }); // earlier cases also call gh
    const r = await run(versionsFile(), out);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(join(out, 'php'), 'utf8')).toBe('fake php cli');
    expect(readFileSync(join(out, 'frankenphp'), 'utf8')).toBe('fake frankenphp');
    expect(readFileSync(join(out, 'composer.phar'), 'utf8')).toBe('fake composer');
    expect(readFileSync(join(out, 'tini'), 'utf8')).toBe('fake tini');
    expect(existsSync(ghLog)).toBe(true);
    const calls = readFileSync(ghLog, 'utf8').trim().split('\n').filter((l) => l.startsWith('attestation verify'));
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c).toContain('--repo multi-api/arco-runtime');
      expect(c).toContain('--signer-workflow multi-api/arco-runtime/.github/workflows/publish.yml');
    }
  });
});
