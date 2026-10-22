// Downloads the PHP CLI, FrankenPHP and Composer for one PHP minor and verifies them against
// image/versions.json: size, sha256 and the arco-runtime build attestation. Any mismatch exits 1.
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultVersionsPath, parseArgs, phpEntry, readVersions, sha256File } from './lib/versions.ts';

const RELEASE_BASE = process.env.ARCO_RUNTIME_RELEASE_BASE ?? 'https://github.com/multi-api/arco-runtime/releases/download';
const COMPOSER_BASE = process.env.COMPOSER_DOWNLOAD_BASE ?? 'https://getcomposer.org/download';
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

async function verify(input: Input): Promise<void> {
  if (input.size !== undefined) {
    const size = statSync(input.dest).size;
    if (size !== input.size) throw new Error(`${input.asset}: size ${size} does not match versions.json (${input.size})`);
  }
  const actual = await sha256File(input.dest);
  if (actual !== input.sha256) {
    throw new Error(`${input.asset}: sha256 ${actual} does not match versions.json (${input.sha256})`);
  }
  if (input.attest) {
    try {
      execFileSync('gh', ['attestation', 'verify', input.dest, '--repo', ATTEST_REPO, '--signer-workflow', ATTEST_SIGNER], {
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
  ];

  for (const input of inputs) {
    await download(input.url, input.dest);
    await verify(input);
    console.log(`ok ${input.asset}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
