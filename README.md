# Arco Runner

The runner is what builds and deploys a customer's Laravel or Go app for [Arco Cloud](https://github.com/multi-api). It is a small Node agent (`agent/`) plus Amazon Linux 2023 images (`image/`) that run either as a Lambda MicroVM (images `arco-runner-php85` and `arco-runner-go`) or as a Fargate task. Cloud hands the runner a one-time ticket; the runner claims the job, clones the repository, restores the dependency cache, runs the build commands, runs `arco deploy`, saves the cache, wipes itself and reports `idle`.

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
| `image/` | `Dockerfile` (one template for both images), `versions.json` (pinned PHP, Go, Composer, corepack, base digest, test services), `rootfs/` |
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

## The go image

Go apps (Cloud's `CLOUD_LANGUAGES_GO`) build on one image for every Go version, `go`, next to `php85`. Both come from the same `image/Dockerfile`: `package-image` keeps the `# @go-begin`…`# @go-end` blocks for the go image and the `# @php-begin`…`# @php-end` blocks (the FrankenPHP runtime pre-seed) for the PHP images.

| What | In the go image |
| --- | --- |
| Go | The official `go<version>.linux-arm64.tar.gz` pinned in `versions.json` (`go.version`, `sha256`, `size`; verified by `fetch-inputs` and `package-image`), extracted in its own stage to `/usr/local/go`, `go` and `gofmt` linked into `/usr/local/bin` |
| Other Go versions | The agent's build env sets `GOTOOLCHAIN=auto`: a `go.mod` whose `go` or `toolchain` line asks for a newer Go downloads that toolchain into the module cache |
| Module cache | `GOMODCACHE=/home/build/.cache/go-mod` (with `GOFLAGS=-modcacherw`), a cache root: the wipe keeps it on a warm VM and the S3 cache archives it; `go.sum` is one of the lock hashes that decide when the cache is saved again |
| Build cache | `GOCACHE=/home/build/.cache/go-build`, also a cache root, so a Standard build (a fresh machine) does not recompile every dependency, once for the tests and once for the build. Saved with the rest when a lock hash changes; an archive written before this root existed (manifest `layout` below 2) is saved again once. `GOPATH=/home/build/go` is wiped after every build |
| PHP and Composer | The PHP CLI of `versions.go.php_minor` (8.5, which must match Cloud's `RunnerJobs::GO_PHP_VERSION` and its `arco-deploy-go.yml` stub) and Composer, only to run Arco |
| Arco | Not baked in. Cloud's first build command is `composer global require multiapi/arco:<pinned version> --no-interaction` and its job env has `ARCO_BIN=arco`. The agent's build PATH ends with Composer's global bin dir (`/home/build/.config/composer/vendor/bin`, last so nothing there shadows a system tool), and the agent checks and runs `$ARCO_BIN` there instead of `vendor/bin/arco`. The global install itself is wiped after each build; the downloaded packages stay in the Composer cache (`~/.cache/composer`, a cache root) |
| Node, test services, tini | As in `php85`. JS build commands (`npm`, `npx`, `yarn`, `pnpm`, `corepack`) are still skipped when the app has no `package.json` |
| `ARCO_RUNNER_IMAGE` | `go`: `/validate` then skips the FrankenPHP runtime pre-seed check (no Go app uses it) and builds and runs a Go program as the build user, offline, besides the usual fixture jobs and service smoke |
| Tests | With `ARCO_RUNNER_IMAGE=go` the test phase runs Go's way (Cloud's default command is `go test ./...`, no setup commands): no `.env` copied from `.env.example`, no `APP_KEY`, no `APP_ENV=testing`, no phpredis check. Services get the usual `DB_*`, `REDIS_HOST` and `REDIS_PORT` plus `DATABASE_URL` (`postgres://…?sslmode=disable` or `mysql://…`; `DATABASE_<MYSQL\|PGSQL>_URL` for the second database) and `REDIS_URL`. When the last command of the chain is `go test`, the agent adds `-json`, tees the events to `/tmp/arco-tests/go-test.json` and filters them back to `go test`'s usual text for the log (`node -e`, under pipefail), then counts passed, failed and skipped tests (subtests included) from the events. A package that fails without a failed test (a build error, a panic) counts as one error named `(package)` with its output. Any other command is judged by its exit code |

`ARCO_BIN` defaults to `vendor/bin/arco`, so Laravel builds behave as before. A value with a slash resolves against the app directory; a bare name is looked up on the build PATH. If it is missing, the run fails `arco.not_installed` naming it.

To move the go image to a newer Go, take the `linux-arm64` `archive` entry from `https://go.dev/dl/?mode=json` and update `go.version`, `go.sha256` and `go.size` in `versions.json`. Projects keep working either way: `GOTOOLCHAIN=auto` fetches what their `go.mod` asks for.

### Building the go image locally

```sh
npx tsx scripts/fetch-inputs.ts --image go --out build/inputs-go   # needs the gh CLI to verify the PHP CLI attestation
node agent/build.mjs
npx tsx scripts/package-image.ts --image go --inputs build/inputs-go --out build/image-go.zip \
  --agent agent/dist/arco-runner.mjs --fixture fixture --validate-cli agent/dist/validate-cli.mjs
mkdir -p build/context-go && unzip -q -o build/image-go.zip -d build/context-go
docker build --platform linux/arm64 -t arco-runner:go-dev build/context-go
docker run --rm --network none --user 0 arco-runner:go-dev /usr/bin/node /opt/arco-runner/validate-cli.mjs
```

`--minor 8.5` (or `--image php85`) still selects the PHP image in every script.

## Remove jobs

Cloud deletes an environment with a job whose `mode` is `remove` (always on its Fargate runner). It needs `@multiapi/arco-cloud-client` 0.1.11 or newer, which runs `arco remove --env=<env> --yes --json --no-wait-interfaces` and finishes `removed` or `failed`, with the kept resources as `notes` and Arco's error `params` as `error_params`.

| What | In a remove job |
| --- | --- |
| Document | `cache` is always treated as `null` and `tests` are never run. `source` may be `null` (only in remove mode; a deploy or inventory without a source is an invalid document) |
| Source | With a source, the repository is checked out as usual so Arco can read the project's own configuration. With `source: null` there is no clone: the agent empties `/home/build/work/repo`, runs there and logs `No repository checkout: removing with the Cloud configuration only.` Arco then works from Cloud's configuration layer alone |
| Cache | Never restored and never saved |
| Build commands | Still run: Cloud installs Arco with them (`composer global require multiapi/arco:<version> --no-interaction`) |
| Arco binary | Always the global install at its absolute path, `/home/build/.config/composer/vendor/bin/arco` (Composer's global bin dir), never `vendor/bin/arco` and never a PATH lookup: a bare `ARCO_BIN` (Cloud sends `arco`) is ignored, an absolute one is honoured. Missing or not executable after the commands: the run fails `arco.not_installed` with `arco not installed globally: the maintenance job's install command failed` |
| Credentials, wipe, idle | As for a deploy |

### Forced removes (customer domains)

When the environment has customer (tenant) domains, Cloud may run one Remove that deletes them: its `/start` answer carries `remove: {"force": true}`. The agent hands the `/start` answer's `remove` key to the shared client untouched, and the client (0.2.0 or newer) appends `--force` to `arco remove` only when `remove.force` is exactly `true`. The agent never adds `--force` itself and ignores the `remove` key of the job document. It advertises the client's capabilities at `/start` (`external_dns`, `extensions`, `tenant_domains`); without `tenant_domains` Cloud answers a forced Remove with `409 client_outdated` and issues no credentials.

## Tenant restore jobs

Cloud re-enables an environment's customer domains with a job whose `mode` is `tenants_restore` (Arco 0.25.0 or newer). It needs `@multiapi/arco-cloud-client` 0.2.0 or newer, which runs `arco tenants:restore --env=<env> --json` and finishes `succeeded` (outcome `restored`, `already_enabled`, `limit_kept` or `nothing_to_restore`) or `failed`, with the outcome as `restore_outcome` and Arco's error `params` as `error_params`. The job is handled exactly like a remove job (table above): no cache, no tests, `source` may be `null`, the build commands install Arco globally and the global Arco runs. Without a source the agent logs `No repository checkout: restoring with the Cloud configuration only.`

## Image

Besides PHP, FrankenPHP, Composer, Node and tini, the image carries the test services (design spec §5), stopped:

| Service | Version | Source | Binaries (`/usr/local/bin`) | Pristine template |
| --- | --- | --- | --- | --- |
| MySQL | 8.4.13 LTS | official `mysql-8.4.13-linux-glibc2.28-aarch64.tar.xz` (pinned in `versions.json`, verified by `fetch-inputs` and `package-image`; fetched from `cdn.mysql.com/Downloads/MySQL-8.4/`, falling back to `cdn.mysql.com/archives/mysql-8.4/` once a newer 8.4 replaces it), extracted to `/opt/mysql` and trimmed (see below) | `mysqld`, `mysql`, `mysqladmin` | `/opt/arco-services/templates/mysql` (`--initialize-insecure --innodb-redo-log-capacity=8M`, then its `*.pem` keys and `auto.cnf` removed, owner `mysql`, `0700`) |
| PostgreSQL | 17.11 | AL2023 `postgresql17-server`, `postgresql17` | `postgres`, `initdb`, `pg_isready`, `psql` | `/opt/arco-services/templates/pgsql` (`initdb -U postgres --auth-local=trust --auth-host=scram-sha-256 -E UTF8`, `LC_ALL=C.UTF-8`, owner `postgres`, `0700`) |
| Redis | 6.2.20 | AL2023 `redis6`: `redis7` does not exist on AL2023 arm64 (`dnf repoquery redis7`, 2026-10-23) | `redis-server`, `redis-cli` | none |
| Floci | 2.3.0 | the native linux/arm64 binary of the official `floci/floci:2.3.0` image on Docker Hub (see below), in `/opt/floci` | `floci-aws` | none |

Each server has its own system user (`mysql`, `postgres`, `redis`, `floci`). `/var/lib/arco-services` (where the agent copies a template at start) and `/run/arco-services` are root `0755` and empty; the last `RUN` fails the build if a server process is running or `/var/lib/arco-services` is not empty. MySQL is extracted in a separate build stage, so the tarball itself never lands in an image layer. dev.mysql.com lists no `-minimal` aarch64 tarball for 8.4, so the full one is used and trimmed in that stage: `bin/mysqld-debug` and `lib/plugin/debug` are not extracted, every ELF binary and shared library is stripped (`strip --strip-unneeded`; `binutils` exists only in the build stage), and `include/`, `man/`, `docs/` (after the `INFO_SRC` release check), `lib/mecab` (dictionaries for the opt-in MeCab full-text parser), the static `*.a` libraries, `lib/pkgconfig` and `share/aclocal` are deleted. Every binary, `lib/plugin`, `lib/private` and `share/` stay, so the server is the same release with the same plugins (the `information_schema.plugins` list, collations, character sets and time zones are identical to the untrimmed build).

The template's redo log is 8 MB instead of the default 100 MB, and the agent starts `mysqld` with the same `--innodb-redo-log-capacity=8M`, so no start resizes it. Tests run with `--innodb-flush-log-at-trx-commit=0` on a throwaway copy, so the smaller redo log only means more frequent checkpoints.

The MySQL template carries no TLS/RSA keys and no `auto.cnf`, so VMs never share keys or a server UUID: `mysqld` regenerates them at its first start from the copy. Measured locally (6 starts each, template copy to `mysqladmin ping`): 440–560 ms with baked keys, 550–840 ms without, about +150 ms at the median. With the trimmed build and the 8 MB redo log (the agent's argv, as user `mysql`, TCP ping as the agent probes): 548–706 ms over 10 starts, medians 559 and 662 ms over two runs of 5. A `caching_sha2_password` user still logs in over TCP from `mysql -h127.0.0.1` (TLS) and PHP's PDO.

The image's PHP has `pdo_mysql`, `pdo_pgsql`, `pdo_sqlite` and the `redis` extension (`php -m`), so the agent sets `REDIS_CLIENT=phpredis`.

### Floci (local AWS emulator)

[Floci](https://github.com/floci-io/floci) emulates AWS (S3, SQS, SNS, DynamoDB, SES, Secrets Manager, SSM and more) behind one endpoint, so a suite that talks to AWS can run its tests on the runner, which has no Docker.

- **Where the binary comes from.** Floci is one native executable that links only glibc. Its releases 2.0.1 to 2.5.0 attach no standalone binary (checked 2026-11-21), so `fetch-inputs` downloads the layer of the official image that holds it: an anonymous pull from Docker Hub of the blob `services.floci.layer_sha256` of `floci/floci` (the linux/arm64 manifest `services.floci.manifest_digest`). A registry blob is content-addressed, so the pinned sha256 and size are the check, as for MySQL; `package-image` checks them again. A Dockerfile stage extracts only `app/application` from that layer and compares it with `services.floci.binary_sha256`; the layer never lands in the runner image. To bump Floci, read the new arm64 manifest and its largest layer from the registry and update the five values together.
- **How it runs.** As user `floci`, in an empty `0700` directory under `/var/lib/arco-services`, with `-Dquarkus.http.host=127.0.0.1 -Dquarkus.http.port=4566 -Dfloci.storage.mode=memory -Dfloci.services.ec2.enabled=false`. Storage is in memory, so the only file it writes is its log. EC2 is switched off because it alone opens a second listener (its metadata server, `0.0.0.0:9169`); with it off, `127.0.0.1:4566` is the only socket (`ss -ltn`, 2026-11-21). The services Floci backs with containers (Lambda invocations, RDS, ECS, EKS, OpenSearch, ElastiCache, MSK) cannot work here: there is no Docker socket, and Floci logs three warnings about that at start.
- **Readiness and the bucket.** Floci ships no client, so the probe is the agent's own Node asking `GET /_floci/health`. Once it answers, the agent creates the S3 bucket `testing` (an unsigned `PUT /testing`), the counterpart of the `testing` database.
- **What the tests get.** `AWS_ENDPOINT_URL=http://127.0.0.1:4566`, `AWS_ACCESS_KEY_ID=test`, `AWS_SECRET_ACCESS_KEY=test`, `AWS_REGION` and `AWS_DEFAULT_REGION` (`us-east-1`) and `AWS_BUCKET=testing`; a PHP app also gets the names Laravel's config files read: `AWS_ENDPOINT`, `AWS_USE_PATH_STYLE_ENDPOINT=true`, `AWS_URL` and `DYNAMODB_ENDPOINT`. `test`/`test` are the emulator's conventional credentials and open nothing real.
- **The rule about AWS variables still holds.** The test environment drops every `AWS_*` variable, whoever set it (a test variable, the build defaults), and then puts back only the ones the agent built for Floci. So a test variable can never carry real credentials into the tests, with or without Floci, and a test variable such as `AWS_BUCKET` is ignored: a suite that needs another bucket creates it from its own code against the endpoint.

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

`/validate` starts each service once before the canned jobs (`smokeServices`): it copies the template, starts the server as its user, creates database `testing` and user `arco`, connects from PHP as `build` with the injected variables (PDO for MySQL and PostgreSQL, phpredis for Redis, an S3 object written to and read back from the `testing` bucket for Floci; the password is masked in any failure), then drops the databases, stops the server, deletes its data and fails unless no process of the service user and nothing in `/var/lib/arco-services` or `/run/arco-services` is left. The first canned job also runs a test phase (`php artisan test`, setup `composer install`, offline) against the fixture's fake PHPUnit (`fixture/packages/fake-phpunit`), so a broken service or test phase fails the image build. Start times as `/validate` logs them (`[validate] <service> ready in N ms`: template copy, cold start and database creation), measured locally (Docker Desktop, arm64, 2026-10-23; three `validate-cli` runs and one through the hooks):

| Service | Start time | Runs |
| --- | --- | --- |
| MySQL 8.4.13 (98 MB template copy) | 880–911 ms | 911, 882, 880, 886 |
| PostgreSQL 17.11 | 369–433 ms | 433, 384, 369, 374 |
| Redis 6.2.20 | 14–271 ms | 271, 14, 268, 270 |
| Floci 2.3.0 (start, health check and bucket; one `validate-cli` run, 2026-11-21) | 129 ms | 129 |
| Fixture test phase (`build.tests`, 2 tests through the fake PHPUnit) | 0.1 s | 0.1 s in every run |

The whole `/validate` (service smoke plus both canned jobs) took 9.9–10.3 s (10.1 s with Floci, one run).

Floci adds 216 MB on disk (`du -sh /opt/floci`; the binary is 226,363,576 B) and about 78 MB to the compressed image (its layer is 78,263,174 B): the php85 image built locally on 2026-11-21 is 471,902,532 B (`docker image inspect --format '{{.Size}}'`) and 2.09 GB in `docker images`. Snapshot growth is recorded after the first staging publish.

## Publishing

`.github/workflows/publish.yml` runs on every push to `main` (stage `staging`), monthly (`0 6 1 * *`, staging) and by `workflow_dispatch` with `stage` (`staging` or `prod`) and `os_capabilities_all`. `prod` runs in the GitHub environment `prod`, where the owner sets a required reviewer. It publishes both images, `php85` and `go`, as a matrix (one failing does not cancel the other). Per stage and image (`<image>` below) it:

1. assumes the publisher role through GitHub OIDC (`vars.PUBLISHER_ROLE_ARN`, `vars.AWS_REGION`);
2. downloads and verifies the PHP CLI, FrankenPHP (`php85`) or Go (`go`), Composer, tini and the MySQL tarball, bundles the agent and packages `build/image.zip`;
3. runs `scripts/publish-microvm-image.ts`: uploads the zip to `s3://$ARTIFACT_BUCKET/images/arco-runner-<image>/<sha>.zip`, creates or updates the MicroVM image `arco-runner-<image>` on the newest managed `al2023` base, and waits (up to 60 minutes) for the new version to reach `SUCCESSFUL`, which includes the `/validate` fixture build. A `FAILED` version fails the job and prints its `stateReason`;
4. builds and pushes `$ECR_REPO:<image>-<sha>-<run id>-<run attempt>` (`php85-…` or `go-…`; ECR tags are immutable, so every run, including the monthly rebuild of an unchanged `main` and re-runs, gets its own tag) and registers a new revision of the Fargate task definition `arco-runner-<image>` (2 vCPU / 4 GB, ARM64, 30 GiB ephemeral storage, no task role, log stream prefix `<image>` in `/ecs/arco-runner`);
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

and, from the `go` matrix job (Cloud's `runners.go_image`):

```
CLOUD_RUNNERS_IMAGE_ARN_GO=arn:aws:lambda:<region>:<runners account>:microvm-image:arco-runner-go
CLOUD_RUNNERS_IMAGE_VERSION_GO=<the version the publish waited for>
CLOUD_RUNNERS_TASK_DEFINITION_GO=arn:aws:ecs:<region>:<runners account>:task-definition/arco-runner-go:<revision>
```

The task definition is only read with `CLOUD_RUNNERS_BACKEND=fargate`. Go builds also need Cloud's `CLOUD_PROCESS_ARCO_VERSION` (and optionally `CLOUD_PROCESS_ARCO_VERSIONS`), the Arco versions Cloud pins in `composer global require`; nothing in this repository depends on them.

**First `go` publish, per stage:** the publisher role creates a new MicroVM image (`arco-runner-go`), its log group `/aws/lambda-microvms/arco-runner-go`, and a new task definition family `arco-runner-go`. If the role's policy scopes those by name (`arco-runner-php85`), widen it to `arco-runner-*` before the first run; the S3 key prefix `images/*` and the ECR repository are shared.

One-time setup: create the repository, the `staging` and `prod` environments and their variables, and the runners accounts with the publisher permissions the Cloud plan lists (`ecs:RegisterTaskDefinition`, `iam:PassRole` on the execution role, `GetMicrovmImage`, `ListMicrovmImageVersions`, `DeleteMicrovmImageVersion`, `ListManagedMicrovmImages`, ECR push, `s3:PutObject` on `images/*`).

Restrict the `prod` environment to deployments from the `main` branch, and limit the publisher role's trust policy to the subjects `repo:multi-api/arco-runner:environment:<stage>` (one per stage account), so only that environment can assume it.

### Pruning

`prune.yml` (`workflow_dispatch`, inputs `stage`, `image` (`php85` or `go`) and `in_use_version`) deletes `arco-runner-<image>` versions older than the version just before `in_use_version`. Only `SUCCESSFUL` versions count when choosing the previous version and when checking that at least 2 remain; it never deletes the in-use version, and refuses if the version is not a successful one. Pass the value currently set in `CLOUD_RUNNERS_IMAGE_VERSION_85` (or `_GO` for the go image). ECR keeps its own last 10 images through a lifecycle rule.

## If `/validate` fails with `capabilities:`

`/validate` runs a canned build as the `build` user and checks that it cannot write `/opt/arco-runner` and that its processes are killed by the wipe. If switching user or killing processes is not permitted inside the MicroVM, the image build fails with `capabilities: <detail>`. Re-run `publish` by `workflow_dispatch` with `os_capabilities_all` ticked: the image is then created with `additionalOsCapabilities: ["ALL"]`. Leave it off otherwise.

## License

MIT
