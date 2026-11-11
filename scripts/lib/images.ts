import { phpEntry, type GoEntry, type PhpEntry, type Versions } from './versions.ts';

/**
 * The runner images: one per PHP minor (`php85`, Laravel apps) and one `go` image for every Go version (Go apps;
 * GOTOOLCHAIN=auto fetches the version go.mod asks for). The go image carries the PHP CLI of `versions.go.php_minor`
 * and Composer only to run Arco, which each Go build installs with `composer global require`.
 */
export type ImageKind = 'php' | 'go';

export interface ImageSpec {
  /** `php85` or `go`: ARCO_RUNNER_IMAGE, the MicroVM image `arco-runner-<id>`, ECR tags `<id>-...`. */
  id: string;
  kind: ImageKind;
  /** The PHP minor whose CLI the image ships. */
  phpMinor: string;
  php: PhpEntry;
  go: GoEntry | null;
}

/** `8.5` → `php85`; an image id (`php85`, `go`) is returned as is. */
export function imageId(minorOrImage: string): string {
  if (/^\d+\.\d+$/.test(minorOrImage)) return `php${minorOrImage.replace('.', '')}`;
  if (/^(php\d+|go)$/.test(minorOrImage)) return minorOrImage;
  throw new Error(`unknown runner image "${minorOrImage}" (expected a PHP minor such as 8.5, php85 or go)`);
}

/** The image a script works on: `--image go`, `--image php85` or `--minor 8.5` (= php85). */
export function imageSpec(versions: Versions, args: Record<string, string>): ImageSpec {
  const given = args.image ?? args.minor;
  if (!given) throw new Error('missing --image (php85, go) or --minor (8.5)');
  if (args.image && args.minor) throw new Error('pass --image or --minor, not both');
  const id = imageId(given);
  if (id === 'go') {
    if (!versions.go) throw new Error('versions.json has no go entry');
    return { id, kind: 'go', phpMinor: versions.go.php_minor, php: phpEntry(versions, versions.go.php_minor), go: versions.go };
  }
  const minor = `${id.slice(3, -1)}.${id.slice(-1)}`;
  return { id, kind: 'php', phpMinor: minor, php: phpEntry(versions, minor), go: null };
}
