/** Pins the Dockerfile to versions.json: base digest (every stage), PHP minor, runtime build, revision, services. */
export function renderDockerfile(
  template: string,
  opts: { digest: string; minor: string; runtimeBuild: string; revision: string; corepack: string; mysqlVersion: string; redisPackage: string },
): string {
  const edits: [RegExp, string][] = [
    [/^(FROM \S+?)@sha256:[0-9a-f]+((?: AS \S+)?)$/gm, `$1@${opts.digest}$2`],
    [/^ARG PHP_MINOR=.*$/m, `ARG PHP_MINOR=${opts.minor}`],
    [/^ARG RUNTIME_BUILD=.*$/m, `ARG RUNTIME_BUILD=${opts.runtimeBuild}`],
    [/^ARG COREPACK_VERSION=.*$/m, `ARG COREPACK_VERSION=${opts.corepack}`],
    [/^ARG REVISION=.*$/m, `ARG REVISION=${opts.revision}`],
    [/^ARG MYSQL_VERSION=.*$/m, `ARG MYSQL_VERSION=${opts.mysqlVersion}`],
    [/^ARG REDIS_PACKAGE=.*$/m, `ARG REDIS_PACKAGE=${opts.redisPackage}`],
    [/^ENV ARCO_RUNNER_IMAGE=\S+/m, `ENV ARCO_RUNNER_IMAGE=php${opts.minor.replace('.', '')}`],
  ];
  return edits.reduce((text, [pattern, value]) => {
    pattern.lastIndex = 0;
    if (!pattern.test(text)) throw new Error(`Dockerfile has no line matching ${pattern}`);
    pattern.lastIndex = 0;
    return text.replace(pattern, value);
  }, template);
}
