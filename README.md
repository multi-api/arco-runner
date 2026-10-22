# Arco Runner

The runner is what builds and deploys a customer's Laravel app for [Arco Cloud](https://github.com/multi-api). It is a small Node agent (`agent/`) plus an Amazon Linux 2023 image (`image/`) that runs either as a Lambda MicroVM (image `arco-runner-php85`) or as a Fargate task. Cloud hands the runner a one-time ticket; the runner claims the job, clones the repository, restores the dependency cache, runs the build commands, runs `arco deploy`, saves the cache, wipes itself and reports `idle`.

This repository is public and MIT licensed so customers can audit what runs their builds. Nothing secret lives in it.

## How the runner is trusted

- The agent is the only root process. It never runs customer code: `git`, build commands, `vendor/bin/arco` and cache archive/extract all run as the unprivileged user `build` (uid/gid 1000, home `/home/build`, checkout `/home/build/work/repo`), each in its own process group.
- `/opt/arco-runner` (agent bundle, fixture) is root-owned and not writable by `build`. The job document, runner token, nonce and clone token stay in memory; they are never put in argv, written to disk, or placed in the build user's environment. AWS credentials exist only in the environment of `arco` children.
- Everything sent to Cloud is masked first, including base64, URL-encoded and JSON-escaped variants of every secret.
- Before every `idle`, the agent wipes the VM: kills all uid 1000 processes, deletes the checkout (including `.git`), everything else in `/home/build` except the cache roots, `/tmp`, `/var/tmp`, `/dev/shm`, and any other file owned by uid 1000, then checks that the kept paths hold no root-owned or setuid files. Any failure marks the runner `dirty` and Cloud discards it.
- Residual risk (design spec 6.1 and 6.6): a build runs on a VM that is reused for later builds of the same environment, and the kept paths (`vendor/`, `node_modules/`, the Composer and npm caches) survive the wipe. A script a build planted inside them, such as `node_modules/.bin/x`, reaches the next build of the same environment. It does not cross environments. Also, processes of the build user can reach the local hook (9000) and control (8080) ports; that lets a build stop itself and nothing more.

## Layout

| Path | What |
| --- | --- |
| `agent/` | The agent (TypeScript, esbuild bundle `agent/dist/arco-runner.mjs`) |
| `image/` | `Dockerfile`, `versions.json` (pinned PHP, Composer, corepack, base digest), `rootfs/` |
| `scripts/` | Image tooling: `fetch-inputs`, `package-image`, `bump-php`, `publish-microvm-image`, `prune-microvm-images` |
| `fixture/` | Canned app used by `/validate` and the integration tests |
| `integration/` | Docker integration suite with a fake Cloud |
| `.github/workflows/` | `ci`, `publish`, `prune` |

## Local development

Node 24 and, for the unit tests, `zstd` and `git`.

```sh
npm ci
npm test              # vitest for scripts/ and agent/
npm run test:linux    # the same suite in a Linux container (canonical environment)
node agent/build.mjs  # bundle the agent
```

### Integration tests

They need Docker on arm64 (Apple silicon or an arm runner). They build the real image, start it next to a fake Cloud (claim/start/logs/finish/idle, a cache endpoint and a git HTTP endpoint) and drive the hooks and `POST /job` the way Lambda and Cloud do.

```sh
npx tsx scripts/fetch-inputs.ts --minor 8.5 --out build/inputs   # needs the gh CLI to verify attestations
npx tsx scripts/package-image.ts --minor 8.5 --inputs build/inputs --out build/image.zip \
  --agent agent/dist/arco-runner.mjs --fixture fixture
npm run test:integration
```

### Smoke against Herd

To try the image against a local Arco Cloud served by Herd (`*.test`), run the image with `ARCO_RUNNER_ALLOW_HTTP=1` (otherwise `api_base` must be `https://`), mint a ticket with `php artisan tinker` in Cloud, and `POST` it to `/job` on port 8080. `npm run smoke:herd` wraps this. It is manual and not part of CI.

## Publishing

`.github/workflows/publish.yml` runs on every push to `main` (stage `staging`), monthly (`0 6 1 * *`, staging) and by `workflow_dispatch` with `stage` (`staging` or `prod`) and `os_capabilities_all`. `prod` runs in the GitHub environment `prod`, where the owner sets a required reviewer. Per stage it:

1. assumes the publisher role through GitHub OIDC (`vars.PUBLISHER_ROLE_ARN`, `vars.AWS_REGION`);
2. downloads and verifies the PHP CLI, FrankenPHP and Composer, bundles the agent and packages `build/image.zip`;
3. runs `scripts/publish-microvm-image.ts`: uploads the zip to `s3://$ARTIFACT_BUCKET/images/arco-runner-php85/<sha>.zip`, creates or updates the MicroVM image `arco-runner-php85` on the newest managed `al2023` base, and waits (up to 60 minutes) for the new version to reach `SUCCESSFUL`, which includes the `/validate` fixture build. A `FAILED` version fails the job and prints its `stateReason`;
4. builds and pushes `$ECR_REPO:php85-<sha>` and registers a new revision of the Fargate task definition `arco-runner-php85` (2 vCPU / 4 GB, ARM64, 30 GiB ephemeral storage, no task role);
5. writes the three values below to the job summary.

Environment variables for each of `staging` and `prod`: `PUBLISHER_ROLE_ARN`, `AWS_REGION`, `ARTIFACT_BUCKET`, `BUILD_ROLE_ARN`, `ECR_REPO`, `FARGATE_EXECUTION_ROLE_ARN`.

### Owner steps after a publish

Images reach Cloud by hand, per stage; CI never switches Cloud to a new image. Copy the lines from the job summary into Cloud's configuration for that stage and redeploy Cloud:

```
CLOUD_RUNNERS_IMAGE_ARN_85=...
CLOUD_RUNNERS_IMAGE_VERSION_85=...
CLOUD_RUNNERS_TASK_DEFINITION_85=...
```

One-time setup: create the repository, the `staging` and `prod` environments and their variables, and the runners accounts with the publisher permissions the Cloud plan lists (`ecs:RegisterTaskDefinition`, `iam:PassRole` on the execution role, `GetMicrovmImage`, `ListMicrovmImageVersions`, `DeleteMicrovmImageVersion`, `ListManagedMicrovmImages`, ECR push, `s3:PutObject` on `images/*`).

### Pruning

`prune.yml` (`workflow_dispatch`, inputs `stage` and `in_use_version`) deletes `arco-runner-php85` versions older than the version just before `in_use_version`. It refuses if fewer than 2 versions would remain or the version is unknown. Pass the value currently set in `CLOUD_RUNNERS_IMAGE_VERSION_85`. ECR keeps its own last 10 images through a lifecycle rule.

## If `/validate` fails with `capabilities:`

`/validate` runs a canned build as the `build` user and checks that it cannot write `/opt/arco-runner` and that its processes are killed by the wipe. If switching user or killing processes is not permitted inside the MicroVM, the image build fails with `capabilities: <detail>`. Re-run `publish` by `workflow_dispatch` with `os_capabilities_all` ticked: the image is then created with `additionalOsCapabilities: ["ALL"]`. Leave it off otherwise.

## License

MIT
