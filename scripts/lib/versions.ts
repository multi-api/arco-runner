import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PhpEntry {
  release: string;
  runtime_build: string;
  arco_build_id: string;
  php_cli_sha256: string;
  php_cli_size: number;
  frankenphp_sha256: string;
  frankenphp_size: number;
}

export interface Versions {
  php: Record<string, PhpEntry>;
  composer: { version: string; sha256: string };
  corepack: { version: string };
  base_image_digest: string;
}

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const defaultVersionsPath = resolve(repoRoot, 'image', 'versions.json');

export function readVersions(path = defaultVersionsPath): Versions {
  return JSON.parse(readFileSync(path, 'utf8')) as Versions;
}

export function writeVersions(versions: Versions, path = defaultVersionsPath): void {
  writeFileSync(path, JSON.stringify(versions, null, 2) + '\n');
}

export function phpEntry(versions: Versions, minor: string): PhpEntry {
  const entry = versions.php[minor];
  if (!entry) throw new Error(`versions.json has no entry for PHP ${minor}`);
  return entry;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolveHash(hash.digest('hex')));
  });
}

/** Minimal `--flag value` parser; every flag takes a value. */
export function parseArgs(argv: string[], required: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith('--') || value === undefined) throw new Error(`bad arguments near "${flag ?? ''}"`);
    args[flag.slice(2)] = value;
  }
  for (const name of required) if (!args[name]) throw new Error(`missing --${name}`);
  return args;
}

/** Throws, naming `name`, unless the file at `path` has the expected size (when given) and sha256. */
export async function checkFile(path: string, name: string, sha256: string, size?: number): Promise<void> {
  if (size !== undefined) {
    const actual = statSync(path).size;
    if (actual !== size) throw new Error(`${name}: size ${actual} does not match versions.json (${size})`);
  }
  const actual = await sha256File(path);
  if (actual !== sha256) throw new Error(`${name}: sha256 ${actual} does not match versions.json (${sha256})`);
}
