// Downloads the PHP CLI, FrankenPHP, Composer and tini for one PHP minor and verifies them against
// image/versions.json: size, sha256 and the arco-runtime build attestation. Any mismatch exits 1.
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFile, defaultVersionsPath, parseArgs, phpEntry, readVersions } from './lib/versions.ts';

const RELEASE_BASE = process.env.ARCO_RUNTIME_RELEASE_BASE ?? 'https://github.com/multi-api/arco-runtime/releases/download';
const COMPOSER_BASE = process.env.COMPOSER_DOWNLOAD_BASE ?? 'https://getcomposer.org/download';
const TINI_BASE = process.env.TINI_DOWNLOAD_BASE ?? 'https://github.com/krallin/tini/releases/download';
const ATTEST_REPO = 'multi-api/arco-runtime';
const ATTEST_SIGNER = 'multi-api/arco-runtime/.github/workflows/publish.yml';

interface Input {
  asset: string;
  url: string;
  dest: string;
  sha256: string;
  size?: number;
  attest: boolean;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function verify(input: Input, path: string): Promise<void> {
  await checkFile(path, input.asset, input.sha256, input.size);
  if (input.attest) {
    try {
      execFileSync('gh', ['attestation', 'verify', path, '--repo', ATTEST_REPO, '--signer-workflow', ATTEST_SIGNER], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      const detail = String((e as { stderr?: Buffer }).stderr ?? e).trim();
      throw new Error(`${input.asset}: attestation verification failed: ${detail}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ['minor', 'out']);
  const versions = readVersions(process.env.ARCO_VERSIONS_FILE ?? defaultVersionsPath);
  const php = phpEntry(versions, args.minor!);
  const out = args.out!;
  mkdirSync(out, { recursive: true });

  const inputs: Input[] = [
    {
      asset: 'php-linux-aarch64',
      url: `${RELEASE_BASE}/${php.release}/php-linux-aarch64`,
      dest: join(out, 'php'),
      sha256: php.php_cli_sha256,
      size: php.php_cli_size,
      attest: true,
    },
    {
      asset: 'frankenphp-linux-aarch64',
      url: `${RELEASE_BASE}/${php.release}/frankenphp-linux-aarch64`,
      dest: join(out, 'frankenphp'),
      sha256: php.frankenphp_sha256,
      size: php.frankenphp_size,
      attest: true,
    },
    {
      asset: 'composer.phar',
      url: `${COMPOSER_BASE}/${versions.composer.version}/composer.phar`,
      dest: join(out, 'composer.phar'),
      sha256: versions.composer.sha256,
      attest: false,
    },
    {
      // tini publishes no attestation: the pinned size and sha256 in versions.json are the only check.
      asset: 'tini-static-arm64',
      url: `${TINI_BASE}/v${versions.tini.version}/tini-static-arm64`,
      dest: join(out, 'tini'),
      sha256: versions.tini.sha256,
      size: versions.tini.size,
      attest: false,
    },
  ];

  for (const input of inputs) {
    // Unverified bytes only ever exist under a temp name, and are removed on any failure.
    const temp = `${input.dest}.part`;
    try {
      await download(input.url, temp);
      await verify(input, temp);
      renameSync(temp, input.dest);
    } finally {
      rmSync(temp, { force: true });
    }
    console.log(`ok ${input.asset}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
