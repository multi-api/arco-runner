// Packages the runner image build context as a zip (Dockerfile at the root) for CreateMicrovmImage.
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import yazl from 'yazl';
import { parseArgs, phpEntry, readVersions, repoRoot } from './lib/versions.ts';

const MTIME = new Date('2026-01-01T00:00:00Z'); // fixed, so the same inputs give the same zip

/** Pins the Dockerfile to versions.json: base digest, PHP minor, runtime build, revision. */
export function renderDockerfile(template: string, opts: { digest: string; minor: string; runtimeBuild: string; revision: string }): string {
  const edits: [RegExp, string][] = [
    [/^(FROM \S+?)@sha256:[0-9a-f]+$/m, `$1@${opts.digest}`],
    [/^ARG PHP_MINOR=.*$/m, `ARG PHP_MINOR=${opts.minor}`],
    [/^ARG RUNTIME_BUILD=.*$/m, `ARG RUNTIME_BUILD=${opts.runtimeBuild}`],
    [/^ARG REVISION=.*$/m, `ARG REVISION=${opts.revision}`],
    [/^ENV ARCO_RUNNER_IMAGE=\S+/m, `ENV ARCO_RUNNER_IMAGE=php${opts.minor.replace('.', '')}`],
  ];
  return edits.reduce((text, [pattern, value]) => {
    if (!pattern.test(text)) throw new Error(`Dockerfile has no line matching ${pattern}`);
    return text.replace(pattern, value);
  }, template);
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), ['minor', 'inputs', 'out', 'agent', 'fixture']);
  const minor = args.minor!;
  const versions = readVersions();
  const php = phpEntry(versions, minor);
  const revision = args.revision ?? execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();

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
  });
  addBuffer(Buffer.from(dockerfile), 'Dockerfile', 0o644);

  const rootfs = join(repoRoot, 'image', 'rootfs');
  for (const f of walk(rootfs)) add(f, `rootfs/${relative(rootfs, f)}`, 0o644);

  const inputs = resolve(args.inputs!);
  add(join(inputs, 'php'), 'inputs/php', 0o755);
  add(join(inputs, 'frankenphp'), 'inputs/frankenphp', 0o755);
  add(join(inputs, 'composer.phar'), 'inputs/composer.phar', 0o755);

  add(resolve(args.agent!), 'agent/arco-runner.mjs', 0o644);

  const fixture = resolve(args.fixture!);
  for (const f of walk(fixture)) add(f, `fixture/${relative(fixture, f)}`, statSync(f).mode & 0o111 ? 0o755 : 0o644);
  // An empty fixture still needs a directory for the Dockerfile's COPY to find.
  zip.addEmptyDirectory('fixture', { mtime: MTIME });

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
