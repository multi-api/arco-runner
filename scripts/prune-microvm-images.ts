// Deletes old versions of a MicroVM image: everything older than the version just before
// `--in-use-version`. Refuses when that would leave fewer than 2 versions or the version is unknown.
//   prune-microvm-images.ts --minor 8.5 --in-use-version <v> [--dry-run]
import { parseArgs } from 'node:util';
import { DeleteMicrovmImageVersionCommand, LambdaMicrovmsClient, ListMicrovmImageVersionsCommand } from '@aws-sdk/client-lambda-microvms';
import { accountOfRoleArn, imageArnFor, imageName } from './publish-microvm-image.ts';

export interface VersionInfo { imageVersion: string; createdAt?: Date | string; state?: string }

export function planPrune(versions: VersionInfo[], inUse: string): string[] {
  const sorted = [...versions].sort((a, b) => +new Date(a.createdAt ?? 0) - +new Date(b.createdAt ?? 0));
  const good = sorted.filter((v) => v.state === 'SUCCESSFUL');
  const idx = good.findIndex((v) => v.imageVersion === inUse);
  if (idx < 0) throw new Error(`in-use version ${inUse} is not a SUCCESSFUL version (${good.length} successful of ${sorted.length})`);
  // Keep the in-use version, the SUCCESSFUL one before it, and everything newer; delete what is older.
  const cutoff = good[Math.max(idx - 1, 0)]!;
  const cutoffAt = sorted.indexOf(sorted.find((v) => v.imageVersion === cutoff.imageVersion)!);
  const doomed = sorted.slice(0, cutoffAt).filter((v) => v.imageVersion !== inUse).map((v) => v.imageVersion);
  const remainingGood = good.filter((v) => !doomed.includes(v.imageVersion)).length;
  if (remainingGood < 2) throw new Error(`refusing: pruning would leave ${remainingGood} successful version(s), need at least 2`);
  return doomed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { minor: { type: 'string' }, 'in-use-version': { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
  if (!values.minor || !values['in-use-version']) throw new Error('--minor and --in-use-version are required');
  const name = imageName(values.minor);
  const region = process.env.AWS_REGION;
  const roleArn = process.env.PUBLISHER_ROLE_ARN;
  if (!region || !roleArn) throw new Error('AWS_REGION and PUBLISHER_ROLE_ARN are required');
  // The MicroVM APIs want the image ARN as imageIdentifier, not the name.
  const identifier = imageArnFor(region, accountOfRoleArn(roleArn), values.minor);
  const client = new LambdaMicrovmsClient({ region: process.env.AWS_REGION });
  const all: VersionInfo[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListMicrovmImageVersionsCommand({ imageIdentifier: identifier, nextToken }));
    all.push(...((page.items ?? []) as VersionInfo[]));
    nextToken = page.nextToken;
  } while (nextToken);
  try {
    const doomed = planPrune(all, values['in-use-version']);
    console.log(`${name}: ${all.length} versions, deleting ${doomed.length}: ${doomed.join(', ') || '(none)'}`);
    if (!values['dry-run']) {
      for (const imageVersion of doomed) await client.send(new DeleteMicrovmImageVersionCommand({ imageIdentifier: identifier, imageVersion }));
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
