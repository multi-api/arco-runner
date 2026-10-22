// Points image/versions.json at Arco's newest runtime build of a PHP minor.
import { newestForMinor, parseManifest } from './lib/manifest.ts';
import { parseArgs, readVersions, writeVersions } from './lib/versions.ts';

const MANIFEST_URL = 'https://raw.githubusercontent.com/multi-api/arco/main/resources/runtime-builds.php';
const RELEASE_BASE = 'https://github.com/multi-api/arco-runtime/releases/download';

async function getText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function main(): Promise<void> {
  const { minor } = parseArgs(process.argv.slice(2), ['minor']);
  const build = newestForMinor(parseManifest(await getText(MANIFEST_URL)), minor!);
  const info = JSON.parse(await getText(`${RELEASE_BASE}/${build.release}/build.json`)) as {
    id: string;
    sha256: string;
    size: number;
    php_cli: { sha256: string; size: number };
  };

  const versions = readVersions();
  versions.php[minor!] = {
    release: build.release,
    runtime_build: info.id,
    arco_build_id: build.id,
    php_cli_sha256: info.php_cli.sha256,
    php_cli_size: info.php_cli.size,
    frankenphp_sha256: info.sha256,
    frankenphp_size: info.size,
  };
  writeVersions(versions);
  console.log(`PHP ${minor}: ${build.id} (${build.release})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
