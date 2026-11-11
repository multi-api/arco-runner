// Packages the runner image build context as a zip (Dockerfile at the root) for CreateMicrovmImage.
//   --minor 8.5 (or --image php85) | --image go; the go image ships go.tar.gz instead of FrankenPHP.
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import yazl from 'yazl';
import { renderDockerfile } from './lib/dockerfile.ts';
import { bundleFixture } from './lib/fixture-bundle.ts';
import { imageSpec } from './lib/images.ts';
import { checkFile, defaultVersionsPath, parseArgs, readVersions, repoRoot } from './lib/versions.ts';

const MTIME = new Date('2026-01-01T00:00:00Z'); // fixed, so the same inputs give the same zip

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ['inputs', 'out', 'agent', 'fixture']);
  const versions = readVersions(process.env.ARCO_VERSIONS_FILE ?? defaultVersionsPath);
  const image = imageSpec(versions, args);
  const minor = image.phpMinor;
  const php = image.php;
  const revision = args.revision ?? execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();

  // Re-check the inputs: they may have sat on disk since fetch-inputs verified them.
  const inputs = resolve(args.inputs!);
  await checkFile(join(inputs, 'php'), 'php', php.php_cli_sha256, php.php_cli_size);
  if (image.go) await checkFile(join(inputs, 'go.tar.gz'), 'go.tar.gz', image.go.sha256, image.go.size);
  else await checkFile(join(inputs, 'frankenphp'), 'frankenphp', php.frankenphp_sha256, php.frankenphp_size);
  await checkFile(join(inputs, 'composer.phar'), 'composer.phar', versions.composer.sha256);
  await checkFile(join(inputs, 'tini'), 'tini', versions.tini.sha256, versions.tini.size);
  await checkFile(join(inputs, 'mysql.tar.xz'), 'mysql.tar.xz', versions.services.mysql.sha256, versions.services.mysql.size);

  const zip = new yazl.ZipFile();
  const add = (file: string, name: string, mode: number) =>
    zip.addFile(file, name, { mtime: MTIME, mode: 0o100000 | mode });
  const addBuffer = (buf: Buffer, name: string, mode: number) =>
    zip.addBuffer(buf, name, { mtime: MTIME, mode: 0o100000 | mode });

  const dockerfile = renderDockerfile(readFileSync(join(repoRoot, 'image', 'Dockerfile'), 'utf8'), {
    digest: versions.base_image_digest,
    minor,
    runtimeBuild: php.arco_build_id,
    revision,
    corepack: versions.corepack.version,
    mysqlVersion: versions.services.mysql.version,
    redisPackage: versions.services.redis.package,
    image: { id: image.id, kind: image.kind },
    ...(image.go ? { goVersion: image.go.version } : {}),
  });
  addBuffer(Buffer.from(dockerfile), 'Dockerfile', 0o644);

  const rootfs = join(repoRoot, 'image', 'rootfs');
  for (const f of walk(rootfs)) add(f, `rootfs/${relative(rootfs, f)}`, 0o644);

  add(join(inputs, 'php'), 'inputs/php', 0o755);
  if (image.go) add(join(inputs, 'go.tar.gz'), 'inputs/go.tar.gz', 0o644);
  else add(join(inputs, 'frankenphp'), 'inputs/frankenphp', 0o755);
  add(join(inputs, 'composer.phar'), 'inputs/composer.phar', 0o755);
  add(join(inputs, 'tini'), 'inputs/tini', 0o755);
  add(join(inputs, 'mysql.tar.xz'), 'inputs/mysql.tar.xz', 0o644);

  add(resolve(args.agent!), 'agent/arco-runner.mjs', 0o644);
  // Optional: the standalone /validate runner used by image smoke tests.
  if (args['validate-cli']) add(resolve(args['validate-cli']), 'agent/validate-cli.mjs', 0o644);

  // The fixture is plain files in this repo; /validate clones it from a git bundle, so only the bundle ships.
  const bundleDir = mkdtempSync(join(tmpdir(), 'arco-bundle-'));
  const bundle = join(bundleDir, 'app.bundle');
  bundleFixture(resolve(args.fixture!), bundle);
  addBuffer(readFileSync(bundle), 'fixture/app.bundle', 0o644);
  rmSync(bundleDir, { recursive: true, force: true });

  const out = resolve(args.out!);
  mkdirSync(dirname(out), { recursive: true });
  return new Promise((done, fail) => {
    zip.outputStream.pipe(createWriteStream(out)).on('close', done).on('error', fail);
    zip.end();
  });
}

main().then(
  () => console.log('packaged'),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
