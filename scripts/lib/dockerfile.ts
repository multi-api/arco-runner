/** Pins the Dockerfile to versions.json: base digest, PHP minor, runtime build, revision. */
export function renderDockerfile(template: string, opts: { digest: string; minor: string; runtimeBuild: string; revision: string; corepack: string }): string {
  const edits: [RegExp, string][] = [
    [/^(FROM \S+?)@sha256:[0-9a-f]+$/m, `$1@${opts.digest}`],
    [/^ARG PHP_MINOR=.*$/m, `ARG PHP_MINOR=${opts.minor}`],
    [/^ARG RUNTIME_BUILD=.*$/m, `ARG RUNTIME_BUILD=${opts.runtimeBuild}`],
    [/^ARG COREPACK_VERSION=.*$/m, `ARG COREPACK_VERSION=${opts.corepack}`],
    [/^ARG REVISION=.*$/m, `ARG REVISION=${opts.revision}`],
    [/^ENV ARCO_RUNNER_IMAGE=\S+/m, `ENV ARCO_RUNNER_IMAGE=php${opts.minor.replace('.', '')}`],
  ];
  return edits.reduce((text, [pattern, value]) => {
    if (!pattern.test(text)) throw new Error(`Dockerfile has no line matching ${pattern}`);
    return text.replace(pattern, value);
  }, template);
}
