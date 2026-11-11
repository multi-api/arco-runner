import type { ImageKind } from './images.ts';

/**
 * Pins the Dockerfile to versions.json: base digest (every stage), PHP minor, runtime build, revision, services,
 * Go, and the image id; keeps only the `# @<kind>-begin` … `# @<kind>-end` blocks of the image's kind.
 */
export function renderDockerfile(
  template: string,
  opts: {
    digest: string; minor: string; runtimeBuild: string; revision: string; corepack: string; mysqlVersion: string; redisPackage: string;
    /** Default: the PHP image of `minor` (`php85`). */
    image?: { id: string; kind: ImageKind };
    /** Required for the go image. */
    goVersion?: string;
  },
): string {
  const image = opts.image ?? { id: `php${opts.minor.replace('.', '')}`, kind: 'php' as const };
  if (image.kind === 'go' && !opts.goVersion) throw new Error('the go image needs a Go version');
  const drop = image.kind === 'go' ? 'php' : 'go';
  const block = (kind: string) => new RegExp(`^# @${kind}-begin\\n[\\s\\S]*?^# @${kind}-end\\n`, 'gm');
  for (const kind of ['php', 'go']) {
    if (!block(kind).test(template)) throw new Error(`Dockerfile has no # @${kind}-begin/# @${kind}-end block`);
  }
  const kept = template.replace(block(drop), '').replace(/^# @(?:php|go)-(?:begin|end)\n/gm, '');
  const edits: [RegExp, string][] = [
    [/^(FROM \S+?)@sha256:[0-9a-f]+((?: AS \S+)?)$/gm, `$1@${opts.digest}$2`],
    [/^ARG PHP_MINOR=.*$/m, `ARG PHP_MINOR=${opts.minor}`],
    [/^ARG RUNTIME_BUILD=.*$/m, `ARG RUNTIME_BUILD=${opts.runtimeBuild}`],
    [/^ARG COREPACK_VERSION=.*$/m, `ARG COREPACK_VERSION=${opts.corepack}`],
    [/^ARG REVISION=.*$/m, `ARG REVISION=${opts.revision}`],
    [/^ARG MYSQL_VERSION=.*$/m, `ARG MYSQL_VERSION=${opts.mysqlVersion}`],
    [/^ARG REDIS_PACKAGE=.*$/m, `ARG REDIS_PACKAGE=${opts.redisPackage}`],
    [/^ARG GO_VERSION=.*$/m, `ARG GO_VERSION=${opts.goVersion ?? 'none'}`],
    [/^ENV ARCO_RUNNER_IMAGE=\S+/m, `ENV ARCO_RUNNER_IMAGE=${image.id}`],
  ];
  return edits.reduce((text, [pattern, value]) => {
    pattern.lastIndex = 0;
    if (!pattern.test(text)) throw new Error(`Dockerfile has no line matching ${pattern}`);
    pattern.lastIndex = 0;
    return text.replace(pattern, value);
  }, kept);
}
