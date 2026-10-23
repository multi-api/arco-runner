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
| `image/` | `Dockerfile`, `versions.json` (pinned PHP, Composer, corepack, base digest, test services), `rootfs/` |
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

They need Docker on arm64 (Apple silicon or an arm runner). `npm run test:integration` builds the real image from `build/image.zip`, starts it (MicroVM mode, `ARCO_RUNNER_ALLOW_HTTP=1`) next to a fake Cloud (`integration/fake-cloud`: claim/start/logs/finish/idle, an S3-like cache endpoint and a git smart-HTTP endpoint that requires the job's `Authorization` header; with `ARCO_RUNNER_ALLOW_HTTP=1` the agent accepts an `http://` `api_base` and clone URL), drives the hooks and `POST /job` the way Lambda and Cloud do, and always removes the containers, network and volumes afterwards.

```sh
npx tsx scripts/fetch-inputs.ts --minor 8.5 --out build/inputs   # needs the gh CLI to verify attestations
node agent/build.mjs
npx tsx scripts/package-image.ts --minor 8.5 --inputs build/inputs --out build/image.zip \
  --agent agent/dist/arco-runner.mjs --fixture fixture --validate-cli agent/dist/validate-cli.mjs
npm ci --prefix integration
npm run test:integration                 # extra arguments go to vitest, e.g. -- -t 'warm'
```

Set `ARCO_RUNNER_IMAGE=<image>` to test an image you already built instead (CI does). The scenarios share one runner container and must run in order (each builds on the state the previous ones left; a filter such as `-t 'warm'` alone only works for scenarios that need no earlier one), so vitest stops at the first failure (`bail: 1`). Like Cloud, the fake Cloud calls the runner's `/suspend` hook before it answers `/idle`, and the MicroVM scenarios check that hook answered 200. The published ports are `127.0.0.1:38080` (control), `39000` (hooks) and `38081` (fake Cloud), overridable with `RUNNER_CONTROL_PORT`, `RUNNER_HOOKS_PORT` and `FAKE_CLOUD_PORT`.

### Smoke against Herd

To try the image against a local Arco Cloud served by Herd (`*.test`), mint a ticket for a deployment dispatched to the `arco-runner` build provider:

```sh
php artisan tinker --execute 'echo App\Runners\RunnerTickets::mint(App\Models\Deployment::findOrFail(<id>));'
```

then run, from this repository:

```sh
ARCO_SMOKE_TICKET=<ticket> npm run smoke:herd -- --deployment <id>
```

It runs the image with `ARCO_RUNNER_ALLOW_HTTP=1` and `--add-host arco-cloud.test:host-gateway`, trusts Herd's CA in the agent (`NODE_EXTRA_CA_CERTS`), waits for the control port, posts the ticket to `/job`, follows `/healthz` until the runner is idle again, prints the agent's output and removes the container. If the site is not secured in Herd, pass `--api-base http://arco-cloud.test`. The project's own `vendor/bin/arco` runs for real, so use a deployment whose app and AWS account you are happy to deploy to. It is manual and not part of CI.

## Image

Besides PHP, FrankenPHP, Composer, Node and tini, the image carries the test services (design spec §5), stopped:

| Service | Version | Source | Binaries (`/usr/local/bin`) | Pristine template |
| --- | --- | --- | --- | --- |
| MySQL | 8.4.13 LTS | official `mysql-8.4.13-linux-glibc2.28-aarch64.tar.xz` (pinned in `versions.json`, verified by `fetch-inputs` and `package-image`; fetched from `cdn.mysql.com/Downloads/MySQL-8.4/`, falling back to `cdn.mysql.com/archives/mysql-8.4/` once a newer 8.4 replaces it), extracted to `/opt/mysql` and trimmed (see below) | `mysqld`, `mysql`, `mysqladmin` | `/opt/arco-services/templates/mysql` (`--initialize-insecure --innodb-redo-log-capacity=8M`, then its `*.pem` keys and `auto.cnf` removed, owner `mysql`, `0700`) |
| PostgreSQL | 17.11 | AL2023 `postgresql17-server`, `postgresql17` | `postgres`, `initdb`, `pg_isready`, `psql` | `/opt/arco-services/templates/pgsql` (`initdb -U postgres --auth-local=trust --auth-host=scram-sha-256 -E UTF8`, `LC_ALL=C.UTF-8`, owner `postgres`, `0700`) |
| Redis | 6.2.20 | AL2023 `redis6`: `redis7` does not exist on AL2023 arm64 (`dnf repoquery redis7`, 2026-10-23) | `redis-server`, `redis-cli` | none |

Each server has its own system user (`mysql`, `postgres`, `redis`). `/var/lib/arco-services` (where the agent copies a template at start) and `/run/arco-services` are root `0755` and empty; the last `RUN` fails the build if a server process is running or `/var/lib/arco-services` is not empty. MySQL is extracted in a separate build stage, so the tarball itself never lands in an image layer. dev.mysql.com lists no `-minimal` aarch64 tarball for 8.4, so the full one is used and trimmed in that stage: `bin/mysqld-debug` and `lib/plugin/debug` are not extracted, every ELF binary and shared library is stripped (`strip --strip-unneeded`; `binutils` exists only in the build stage), and `include/`, `man/`, `docs/` (after the `INFO_SRC` release check), `lib/mecab` (dictionaries for the opt-in MeCab full-text parser), the static `*.a` libraries, `lib/pkgconfig` and `share/aclocal` are deleted. Every binary, `lib/plugin`, `lib/private` and `share/` stay, so the server is the same release with the same plugins (the `information_schema.plugins` list, collations, character sets and time zones are identical to the untrimmed build).

The template's redo log is 8 MB instead of the default 100 MB, and the agent starts `mysqld` with the same `--innodb-redo-log-capacity=8M`, so no start resizes it. Tests run with `--innodb-flush-log-at-trx-commit=0` on a throwaway copy, so the smaller redo log only means more frequent checkpoints.

The MySQL template carries no TLS/RSA keys and no `auto.cnf`, so VMs never share keys or a server UUID: `mysqld` regenerates them at its first start from the copy. Measured locally (6 starts each, template copy to `mysqladmin ping`): 440–560 ms with baked keys, 550–840 ms without, about +150 ms at the median. With the trimmed build and the 8 MB redo log (the agent's argv, as user `mysql`, TCP ping as the agent probes): 548–706 ms over 10 starts, medians 559 and 662 ms over two runs of 5. A `caching_sha2_password` user still logs in over TCP from `mysql -h127.0.0.1` (TLS) and PHP's PDO.

The image's PHP has `pdo_mysql`, `pdo_pgsql`, `pdo_sqlite` and the `redis` extension (`php -m`), so the agent sets `REDIS_CLIENT=phpredis`.

Measured locally (Docker Desktop, arm64, 2026-10-23; "before" is the image at `c88c9f8`, "untrimmed" the first build with the services, "after" the trimmed MySQL):

| Measure | Before | Untrimmed | After | Growth (after vs before) |
| --- | --- | --- | --- | --- |
| `docker image inspect --format '{{.Size}}'` (compressed content) | 266,136,832 B | 885,697,327 B | 393,656,463 B | +128 MB |
| `docker images` disk usage | 1.12 GB | 3.24 GB | 1.78 GB | +0.66 GB |
| `du -sx /` in the container | 803 MiB | 2.17 GiB | 1,303 MiB | +500 MiB |

| What | On disk |
| --- | --- |
| `/opt/mysql`, trimmed (`bin` 159 MB, `lib` 39 MB: `lib/private` 23 MB, `lib/plugin` 9 MB; `share` 11 MB). Untrimmed it was 1.1 GB | 209 MB |
| `/opt/arco-services/templates/mysql` (8 MB redo log; `mysql.ibd` 28 MB, two undo tablespaces 16 MB each, `ibdata1` 12 MB, doublewrite 12 MB). With the default redo log it was 190 MB | 98 MB |
| `/opt/arco-services/templates/pgsql` | 39 MB |
| PostgreSQL packages (`postgresql17-server`, `postgresql17`, `postgresql17-private-libs`) | 49 MB |
| `redis6` package | 5 MB |
| the services' `dnf` layer in total, with the required `systemd`, `selinux-policy`, `libicu` and `util-linux` dependencies | 169 MB |

**MySQL adds about 307 MB on disk (209 MB binaries + 98 MB template), within the 600 MB checkpoint (spec §5.2).** Untrimmed it added about 1.29 GB. Owner's decision: keep the official MySQL 8.4 LTS tarball, trimmed (strip, no MeCab dictionaries, static libraries or headers). MariaDB was considered and rejected for parity with production (MySQL's default collation `utf8mb4_0900_ai_ci` and its native `JSON` type); it may be added later as a fourth service.

`/validate` starts each service once before the canned jobs (`smokeServices`): it copies the template, starts the server as its user, creates database `testing` and user `arco`, connects from PHP as `build` with the injected variables (PDO for MySQL and PostgreSQL, phpredis for Redis; the password is masked in any failure), then drops the databases, stops the server, deletes its data and fails unless no process of the service user and nothing in `/var/lib/arco-services` or `/run/arco-services` is left. The first canned job also runs a test phase (`php artisan test`, setup `composer install`, offline) against the fixture's fake PHPUnit (`fixture/packages/fake-phpunit`), so a broken service or test phase fails the image build. Start times as `/validate` logs them (`[validate] <service> ready in N ms`: template copy, cold start and database creation), measured locally (Docker Desktop, arm64, 2026-10-23; three `validate-cli` runs and one through the hooks):

| Service | Start time | Runs |
| --- | --- | --- |
| MySQL 8.4.13 (98 MB template copy) | 880–911 ms | 911, 882, 880, 886 |
| PostgreSQL 17.11 | 369–433 ms | 433, 384, 369, 374 |
| Redis 6.2.20 | 14–271 ms | 271, 14, 268, 270 |
| Fixture test phase (`build.tests`, 2 tests through the fake PHPUnit) | 0.1 s | 0.1 s in every run |

The whole `/validate` (service smoke plus both canned jobs) took 9.9–10.3 s. Snapshot growth is recorded after the first staging publish.

## Publishing

`.github/workflows/publish.yml` runs on every push to `main` (stage `staging`), monthly (`0 6 1 * *`, staging) and by `workflow_dispatch` with `stage` (`staging` or `prod`) and `os_capabilities_all`. `prod` runs in the GitHub environment `prod`, where the owner sets a required reviewer. Per stage it:

1. assumes the publisher role through GitHub OIDC (`vars.PUBLISHER_ROLE_ARN`, `vars.AWS_REGION`);
2. downloads and verifies the PHP CLI, FrankenPHP, Composer, tini and the MySQL tarball, bundles the agent and packages `build/image.zip`;
3. runs `scripts/publish-microvm-image.ts`: uploads the zip to `s3://$ARTIFACT_BUCKET/images/arco-runner-php85/<sha>.zip`, creates or updates the MicroVM image `arco-runner-php85` on the newest managed `al2023` base, and waits (up to 60 minutes) for the new version to reach `SUCCESSFUL`, which includes the `/validate` fixture build. A `FAILED` version fails the job and prints its `stateReason`;
4. builds and pushes `$ECR_REPO:php85-<sha>-<run id>-<run attempt>` (ECR tags are immutable, so every run, including the monthly rebuild of an unchanged `main` and re-runs, gets its own tag) and registers a new revision of the Fargate task definition `arco-runner-php85` (2 vCPU / 4 GB, ARM64, 30 GiB ephemeral storage, no task role);
5. writes the three values below to the job summary.

**First staging publish:** `publish-microvm-image.ts` picks the managed base whose ARN contains `al2023` (the newest match). Before trusting it, confirm in the publish log (or `ListManagedMicrovmImages`) that the chosen base is the same `al2023-minimal` flavour the Dockerfile builds on (`public.ecr.aws/lambda/microvms:al2023-minimal`); if a non-minimal al2023 base is picked, tighten the match in the script before the image is used.

Environment variables for each of `staging` and `prod`: `PUBLISHER_ROLE_ARN`, `AWS_REGION`, `ARTIFACT_BUCKET`, `BUILD_ROLE_ARN`, `ECR_REPO`, `FARGATE_EXECUTION_ROLE_ARN`.

### Owner steps after a publish

Images reach Cloud by hand, per stage; CI never switches Cloud to a new image. Copy the lines from the job summary into Cloud's configuration for that stage and redeploy Cloud:

```
CLOUD_RUNNERS_IMAGE_ARN_85=...
CLOUD_RUNNERS_IMAGE_VERSION_85=...
CLOUD_RUNNERS_TASK_DEFINITION_85=...
```

One-time setup: create the repository, the `staging` and `prod` environments and their variables, and the runners accounts with the publisher permissions the Cloud plan lists (`ecs:RegisterTaskDefinition`, `iam:PassRole` on the execution role, `GetMicrovmImage`, `ListMicrovmImageVersions`, `DeleteMicrovmImageVersion`, `ListManagedMicrovmImages`, ECR push, `s3:PutObject` on `images/*`).

Restrict the `prod` environment to deployments from the `main` branch, and limit the publisher role's trust policy to the subjects `repo:multi-api/arco-runner:environment:<stage>` (one per stage account), so only that environment can assume it.

### Pruning

`prune.yml` (`workflow_dispatch`, inputs `stage` and `in_use_version`) deletes `arco-runner-php85` versions older than the version just before `in_use_version`. Only `SUCCESSFUL` versions count when choosing the previous version and when checking that at least 2 remain; it never deletes the in-use version, and refuses if the version is not a successful one. Pass the value currently set in `CLOUD_RUNNERS_IMAGE_VERSION_85`. ECR keeps its own last 10 images through a lifecycle rule.

## If `/validate` fails with `capabilities:`

`/validate` runs a canned build as the `build` user and checks that it cannot write `/opt/arco-runner` and that its processes are killed by the wipe. If switching user or killing processes is not permitted inside the MicroVM, the image build fails with `capabilities: <detail>`. Re-run `publish` by `workflow_dispatch` with `os_capabilities_all` ticked: the image is then created with `additionalOsCapabilities: ["ALL"]`. Leave it off otherwise.

## License

MIT
