export interface ManifestBuild {
  id: string;
  php: string;
  /** Release tag taken from the build's download URL, e.g. frankenphp-1.13.1-r1. */
  release: string;
  hasPhpCli: boolean;
}

/**
 * Reads the builds out of Arco's resources/runtime-builds.php. The file is generated with a fixed
 * shape, so this scans for build keys instead of evaluating PHP. Builds are listed oldest first.
 */
export function parseManifest(source: string): ManifestBuild[] {
  const buildsAt = source.indexOf("'builds'");
  const aliasesAt = source.indexOf("'aliases'");
  const section = source.slice(buildsAt, aliasesAt === -1 ? undefined : aliasesAt);
  const headers = [...section.matchAll(/^\s{8}'(php[^']+)' => \[$/gm)];
  return headers.map((h, i) => {
    const body = section.slice(h.index + h[0].length, headers[i + 1]?.index ?? section.length);
    const php = /^\s{12}'php' => '([^']+)'/m.exec(body)?.[1];
    const release = /\/download\/([^/']+)\//.exec(body)?.[1];
    if (!php || !release) throw new Error(`manifest build ${h[1]} is missing php or url`);
    return { id: h[1]!, php, release, hasPhpCli: /^\s{12}'php_cli' => \[/m.test(body) };
  });
}

/** The newest build of a PHP minor that ships a PHP CLI. */
export function newestForMinor(builds: ManifestBuild[], minor: string): ManifestBuild {
  const match = builds.filter((b) => b.php.startsWith(`${minor}.`) && b.hasPhpCli).at(-1);
  if (!match) throw new Error(`no build of PHP ${minor} with a php_cli in Arco's manifest`);
  return match;
}
