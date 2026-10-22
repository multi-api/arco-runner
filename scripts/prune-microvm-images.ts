// Deletes old versions of a MicroVM image: everything older than the version just before
// `--in-use-version`. Refuses when that would leave fewer than 2 versions or the version is unknown.
//   prune-microvm-images.ts --minor 8.5 --in-use-version <v> [--dry-run]
import { parseArgs } from 'node:util';
import { DeleteMicrovmImageVersionCommand, LambdaMicrovmsClient, ListMicrovmImageVersionsCommand } from '@aws-sdk/client-lambda-microvms';
import { imageName } from './publish-microvm-image.ts';

export interface VersionInfo { imageVersion: string; createdAt?: Date | string }

export function planPrune(versions: VersionInfo[], inUse: string): string[] {
  const sorted = [...versions].sort((a, b) => +new Date(a.createdAt ?? 0) - +new Date(b.createdAt ?? 0));
  const idx = sorted.findIndex((v) => v.imageVersion === inUse);
  if (idx < 0) throw new Error(`in-use version ${inUse} not found among ${sorted.length} versions`);
  const keepFrom = Math.max(idx - 1, 0);
  const doomed = sorted.slice(0, keepFrom).map((v) => v.imageVersion);
  if (sorted.length - doomed.length < 2) throw new Error(`refusing: pruning would leave ${sorted.length - doomed.length} version(s), need at least 2`);
  return doomed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { minor: { type: 'string' }, 'in-use-version': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  if (!values.minor || !values['in-use-version']) throw new Error('--minor and --in-use-version are required');
  const name = imageName(values.minor);
  const client = new LambdaMicrovmsClient({ region: process.env.AWS_REGION });
  const all: VersionInfo[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListMicrovmImageVersionsCommand({ imageIdentifier: name, nextToken }));
    all.push(...(page.items as VersionInfo[]));
    nextToken = page.nextToken;
  } while (nextToken);
  try {
    const doomed = planPrune(all, values['in-use-version']);
    console.log(`${name}: ${all.length} versions, deleting ${doomed.length}: ${doomed.join(', ') || '(none)'}`);
    if (!values['dry-run']) {
      for (const imageVersion of doomed) await client.send(new DeleteMicrovmImageVersionCommand({ imageIdentifier: name, imageVersion }));
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
