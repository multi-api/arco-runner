import { describe, expect, it } from 'vitest';
import {
  CreateMicrovmImageCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  ListManagedMicrovmImagesCommand,
  UpdateMicrovmImageCommand,
} from '@aws-sdk/client-lambda-microvms';
import { accountOfRoleArn, imageArnFor, main, type PublishDeps } from '../publish-microvm-image.ts';

const ENV = { GITHUB_SHA: 'abc123', ARTIFACT_BUCKET: 'bkt', BUILD_ROLE_ARN: 'arn:aws:iam::844222058302:role/ArcoRunnerImageBuild', AWS_REGION: 'us-east-1' };
const IMAGE_ARN = 'arn:aws:lambda:us-east-1:844222058302:microvm-image:arco-runner-php85';
const ARGS = ['--stage', 'staging', '--zip', '/tmp/x.zip', '--minor', '8.5'];
const BASE = 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-2';

interface World { exists: boolean; versionStates: string[]; stateReason?: string }

function fake(world: World) {
  const calls: { name: string; input: any }[] = [];
  const logs: string[] = [];
  const uploads: string[][] = [];
  let polls = 0;
  const deps: PublishDeps = {
    client: {
      async send(command: any) {
        const name = command.constructor.name;
        calls.push({ name, input: command.input });
        if (command instanceof ListManagedMicrovmImagesCommand) {
          return { items: [
            { imageArn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1', createdAt: new Date(1) },
            { imageArn: BASE, createdAt: new Date(2) },
            { imageArn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2-9', createdAt: new Date(3) },
          ] };
        }
        if (command instanceof GetMicrovmImageCommand) {
          if (!world.exists) throw Object.assign(new Error('nf'), { name: 'ResourceNotFoundException' });
          return { imageArn: IMAGE_ARN };
        }
        if (command instanceof CreateMicrovmImageCommand || command instanceof UpdateMicrovmImageCommand) {
          return { imageArn: IMAGE_ARN, imageVersion: world.exists ? '2' : '1' };
        }
        if (command instanceof GetMicrovmImageVersionCommand) {
          const state = world.versionStates[Math.min(polls++, world.versionStates.length - 1)];
          return { state, stateReason: world.stateReason };
        }
        throw new Error(`unexpected ${name}`);
      },
    },
    upload: async (b, k, p) => { uploads.push([b, k, p]); },
    sleep: async () => {},
    now: () => 0,
    log: (l) => logs.push(l),
  };
  return { deps, calls, logs, uploads };
}

describe('publish-microvm-image', () => {
  it('creates a missing image with exactly the specified parameters and prints ARN and version', async () => {
    const f = fake({ exists: false, versionStates: ['IN_PROGRESS', 'SUCCESSFUL'] });
    expect(await main(ARGS, ENV, f.deps)).toBe(0);
    expect(f.uploads).toEqual([['bkt', 'images/arco-runner-php85/abc123.zip', '/tmp/x.zip']]);
    const create = f.calls.find((c) => c.name === 'CreateMicrovmImageCommand')!;
    expect(create.input).toEqual({
      name: 'arco-runner-php85',
      baseImageArn: BASE,
      buildRoleArn: ENV.BUILD_ROLE_ARN,
      codeArtifact: { uri: 's3://bkt/images/arco-runner-php85/abc123.zip' },
      logging: { cloudWatch: { logGroup: '/aws/lambda-microvms/arco-runner-php85' } },
      cpuConfigurations: [{ architecture: 'ARM_64' }],
      resources: [{ minimumMemoryInMiB: 4096 }],
      hooks: {
        port: 9000,
        microvmImageHooks: { ready: 'ENABLED', readyTimeoutInSeconds: 120, validate: 'ENABLED', validateTimeoutInSeconds: 900 },
        microvmHooks: {
          run: 'ENABLED', runTimeoutInSeconds: 10, resume: 'ENABLED', resumeTimeoutInSeconds: 10,
          suspend: 'ENABLED', suspendTimeoutInSeconds: 30, terminate: 'ENABLED', terminateTimeoutInSeconds: 10,
        },
      },
    });
    expect(f.calls.some((c) => c.name === 'UpdateMicrovmImageCommand')).toBe(false);
    expect(f.logs).toContain(`image_arn=${IMAGE_ARN}`);
    expect(f.logs).toContain('image_version=1');
  });

  it('updates an existing image and follows the new version, not the old one', async () => {
    const f = fake({ exists: true, versionStates: ['SUCCESSFUL'] });
    expect(await main(ARGS, ENV, f.deps)).toBe(0);
    const update = f.calls.find((c) => c.name === 'UpdateMicrovmImageCommand')!;
    expect(update.input.imageIdentifier).toBe(IMAGE_ARN);
    expect(f.calls.some((c) => c.name === 'CreateMicrovmImageCommand')).toBe(false);
    const get = f.calls.find((c) => c.name === 'GetMicrovmImageVersionCommand')!;
    expect(get.input).toEqual({ imageIdentifier: IMAGE_ARN, imageVersion: '2' });
    expect(f.logs).toContain('image_version=2');
  });

  it('exits 1 and prints stateReason when the version FAILED', async () => {
    const f = fake({ exists: false, versionStates: ['IN_PROGRESS', 'FAILED'], stateReason: 'validate: capabilities: setuid denied' });
    expect(await main(ARGS, ENV, f.deps)).toBe(1);
    expect(f.logs.join('\n')).toContain('capabilities: setuid denied');
    expect(f.logs.some((l) => l.startsWith('image_arn='))).toBe(false);
  });

  it('adds additionalOsCapabilities only with the flag', async () => {
    const off = fake({ exists: false, versionStates: ['SUCCESSFUL'] });
    await main(ARGS, ENV, off.deps);
    expect(off.calls.find((c) => c.name === 'CreateMicrovmImageCommand')!.input).not.toHaveProperty('additionalOsCapabilities');
    const on = fake({ exists: false, versionStates: ['SUCCESSFUL'] });
    await main([...ARGS, '--os-capabilities-all'], ENV, on.deps);
    expect(on.calls.find((c) => c.name === 'CreateMicrovmImageCommand')!.input.additionalOsCapabilities).toEqual(['ALL']);
  });

  it('gives up after 60 minutes of polling', async () => {
    const f = fake({ exists: false, versionStates: ['IN_PROGRESS'] });
    let t = 0;
    f.deps.now = () => t;
    f.deps.sleep = async (ms) => { t += ms; };
    expect(await main(ARGS, ENV, f.deps)).toBe(1);
    expect(f.logs.join('\n')).toContain('60 minutes');
  });

  it('passes the image ARN, never the bare name, as imageIdentifier', async () => {
    for (const exists of [false, true]) {
      const f = fake({ exists, versionStates: ['SUCCESSFUL'] });
      expect(await main(ARGS, ENV, f.deps)).toBe(0);
      const ids = f.calls.map((c) => c.input?.imageIdentifier).filter((v) => v !== undefined);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((v) => v === IMAGE_ARN)).toBe(true);
    }
  });

  it('builds the image ARN from the region and the build role account', () => {
    expect(accountOfRoleArn('arn:aws:iam::844222058302:role/ArcoRunnerImageBuild')).toBe('844222058302');
    expect(() => accountOfRoleArn('arco-runner-php85')).toThrow(/not an IAM role ARN/);
    expect(imageArnFor('us-east-1', '844222058302', '8.5')).toBe(IMAGE_ARN);
  });

  it('fails without AWS_REGION', async () => {
    const f = fake({ exists: false, versionStates: ['SUCCESSFUL'] });
    const { AWS_REGION: _r, ...env } = ENV;
    expect(await main(ARGS, env, f.deps)).toBe(1);
    expect(f.logs.join('\n')).toMatch(/missing AWS_REGION/);
  });
});
