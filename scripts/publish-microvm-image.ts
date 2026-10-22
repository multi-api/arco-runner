// Publishes the packaged image zip as a Lambda MicroVM image: upload to S3, create or update
// `arco-runner-php85` on the newest managed al2023 base, wait for the new version to build and
// pass /validate, then print the ARN and version the owner sets in Cloud (spec A4).
//   publish-microvm-image.ts --stage <s> --zip <path> --minor 8.5 [--os-capabilities-all]
// Env: ARTIFACT_BUCKET, BUILD_ROLE_ARN, AWS_REGION (+ AWS credentials); GITHUB_SHA (else git HEAD).
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  CreateMicrovmImageCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListManagedMicrovmImagesCommand,
  UpdateMicrovmImageCommand,
} from '@aws-sdk/client-lambda-microvms';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream } from 'node:fs';

export const POLL_INTERVAL_MS = 15_000;
export const POLL_TIMEOUT_MS = 60 * 60_000;
const ON = 'ENABLED' as const;

export interface PublishDeps {
  client: { send(command: unknown): Promise<any> };
  upload(bucket: string, key: string, path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
}

export interface PublishOptions {
  stage: string;
  zip: string;
  minor: string;
  osCapabilitiesAll: boolean;
  sha: string;
  bucket: string;
  buildRoleArn: string;
  region: string;
}

export class PublishFailed extends Error {}

const isNotFound = (e: unknown): boolean => (e as { name?: string })?.name === 'ResourceNotFoundException';

export function imageName(minor: string): string {
  return `arco-runner-php${minor.replace('.', '')}`;
}

/** The account id of an IAM role ARN (`arn:aws:iam::<account>:role/...`). */
export function accountOfRoleArn(roleArn: string): string {
  const account = /^arn:aws[\w-]*:iam::(\d{12}):role\//.exec(roleArn)?.[1];
  if (!account) throw new Error(`not an IAM role ARN: ${roleArn}`);
  return account;
}

/** The MicroVM APIs that take `imageIdentifier` want the image ARN, not its name. */
export function imageArnFor(region: string, account: string, minor: string): string {
  return `arn:aws:lambda:${region}:${account}:microvm-image:${imageName(minor)}`;
}

export function imageParams(opts: PublishOptions, baseImageArn: string) {
  const name = imageName(opts.minor);
  return {
    baseImageArn,
    buildRoleArn: opts.buildRoleArn,
    codeArtifact: { uri: `s3://${opts.bucket}/images/${name}/${opts.sha}.zip` },
    logging: { cloudWatch: { logGroup: `/aws/lambda-microvms/${name}` } },
    cpuConfigurations: [{ architecture: 'ARM_64' as const }],
    resources: [{ minimumMemoryInMiB: 4096 }],
    ...(opts.osCapabilitiesAll ? { additionalOsCapabilities: ['ALL' as const] } : {}),
    hooks: {
      port: 9000,
      microvmImageHooks: { ready: ON, readyTimeoutInSeconds: 120, validate: ON, validateTimeoutInSeconds: 900 },
      microvmHooks: {
        run: ON, runTimeoutInSeconds: 10,
        resume: ON, resumeTimeoutInSeconds: 10,
        suspend: ON, suspendTimeoutInSeconds: 30,
        terminate: ON, terminateTimeoutInSeconds: 10,
      },
    },
  };
}

async function newestAl2023Base(client: PublishDeps['client']): Promise<string> {
  const found: { imageArn: string; createdAt?: Date }[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListManagedMicrovmImagesCommand({ nextToken }));
    for (const item of page.items ?? []) if (/al2023/i.test(item.imageArn)) found.push(item);
    nextToken = page.nextToken;
  } while (nextToken);
  if (found.length === 0) throw new PublishFailed('no managed al2023 base image found (ListManagedMicrovmImages)');
  found.sort((a, b) => +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0));
  return found[0]!.imageArn;
}

export async function publish(opts: PublishOptions, deps: PublishDeps): Promise<{ imageArn: string; imageVersion: string }> {
  const { client, log } = deps;
  const name = imageName(opts.minor);
  const key = `images/${name}/${opts.sha}.zip`;
  log(`uploading ${opts.zip} to s3://${opts.bucket}/${key}`);
  await deps.upload(opts.bucket, key, opts.zip);

  const base = await newestAl2023Base(client);
  log(`base image: ${base}`);
  const params = imageParams(opts, base);
  const identifier = imageArnFor(opts.region, accountOfRoleArn(opts.buildRoleArn), opts.minor);

  let exists = true;
  try {
    await client.send(new GetMicrovmImageCommand({ imageIdentifier: identifier }));
  } catch (e) {
    if (!isNotFound(e)) throw e;
    exists = false;
  }
  let imageArn: string;
  let version: string;
  if (exists) {
    log(`updating image ${name} (${opts.stage})`);
    ({ imageArn, imageVersion: version } = await client.send(new UpdateMicrovmImageCommand({ imageIdentifier: identifier, ...params })));
  } else {
    log(`creating image ${name} (${opts.stage})`);
    ({ imageArn, imageVersion: version } = await client.send(new CreateMicrovmImageCommand({ name, ...params })));
  }

  const started = deps.now();
  log(`image version ${version} building`);

  const deadline = started + POLL_TIMEOUT_MS;
  for (;;) {
    const v = await client.send(new GetMicrovmImageVersionCommand({ imageIdentifier: imageArn, imageVersion: version }));
    if (v.state === 'SUCCESSFUL') break;
    if (v.state === 'FAILED' || v.state === 'DELETING' || v.state === 'DELETED' || v.state === 'DELETE_FAILED') {
      throw new PublishFailed(`image version ${version} ${v.state}: ${v.stateReason ?? '(no stateReason)'}`);
    }
    if (deps.now() >= deadline) throw new PublishFailed(`image version ${version} still ${v.state} after 60 minutes`);
    await deps.sleep(POLL_INTERVAL_MS);
  }
  log(`image_arn=${imageArn}`);
  log(`image_version=${version}`);
  return { imageArn, imageVersion: version };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, deps: PublishDeps): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      stage: { type: 'string' },
      zip: { type: 'string' },
      minor: { type: 'string' },
      'os-capabilities-all': { type: 'boolean', default: false },
    },
  });
  const need = (v: string | undefined, what: string): string => {
    if (!v) throw new Error(`missing ${what}`);
    return v;
  };
  try {
    const opts: PublishOptions = {
      stage: need(values.stage, '--stage'),
      zip: need(values.zip, '--zip'),
      minor: need(values.minor, '--minor'),
      osCapabilitiesAll: values['os-capabilities-all'] ?? false,
      sha: need(env.GITHUB_SHA ?? gitSha(), 'GITHUB_SHA'),
      bucket: need(env.ARTIFACT_BUCKET, 'ARTIFACT_BUCKET'),
      buildRoleArn: need(env.BUILD_ROLE_ARN, 'BUILD_ROLE_ARN'),
      region: need(env.AWS_REGION, 'AWS_REGION'),
    };
    await publish(opts, deps);
    return 0;
  } catch (e) {
    deps.log(`publish failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function gitSha(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const region = process.env.AWS_REGION;
  const s3 = new S3Client({ region });
  const deps: PublishDeps = {
    client: new LambdaMicrovmsClient({ region }),
    upload: async (Bucket, Key, path) => {
      await new Upload({ client: s3, params: { Bucket, Key, Body: createReadStream(path) } }).done();
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (l) => console.log(l),
  };
  process.exitCode = await main(process.argv.slice(2), process.env, deps);
}
