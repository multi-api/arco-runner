# The ARG defaults, the base digest and ARCO_RUNNER_IMAGE below are rewritten from image/versions.json
# by scripts/package-image.ts. Build from the zip it produces, not from this directory.

# MySQL is extracted in its own stage so the tarball (inputs/mysql.tar.xz, verified by fetch-inputs and
# package-image) never lands in a layer of the runner image; only the trimmed /opt/mysql is copied over.
FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:53cdb05519dd396022a51cadd61935665a8c056c733e8a56f8ab13a3e7288108 AS mysql
ARG MYSQL_VERSION=8.4.13
COPY inputs/mysql.tar.xz /tmp/mysql.tar.xz
# Dropped: the debug server and debug plugins (the tarball ships no test directories).
RUN dnf install -y tar xz \
 && mkdir /opt/mysql \
 && tar -xJf /tmp/mysql.tar.xz -C /opt/mysql --strip-components=1 --no-same-owner \
      --exclude='*/bin/mysqld-debug' --exclude='*/lib/plugin/debug' \
 && test -x /opt/mysql/bin/mysqld && test ! -e /opt/mysql/bin/mysqld-debug \
 && grep -qx "branch: mysql-${MYSQL_VERSION}-release" /opt/mysql/docs/INFO_SRC

FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:53cdb05519dd396022a51cadd61935665a8c056c733e8a56f8ab13a3e7288108

ARG PHP_MINOR=8.5
# Arco's build id for the pre-seeded runtime cache (the manifest key, e.g. php8.5.12-fp1.13.1-r1).
ARG RUNTIME_BUILD=php8.5.12-fp1.13.1-r1
ARG COREPACK_VERSION=0.36.0
ARG REVISION=dev

# The dnf Node 24 does not ship corepack, so install a pinned one (yarn/pnpm shims for customers).
RUN dnf install -y nodejs24 nodejs24-npm git-core zstd tar unzip shadow-utils util-linux-core findutils procps-ng ca-certificates \
 && dnf clean all \
 && npm install -g corepack@${COREPACK_VERSION} \
 && corepack enable

RUN useradd -u 1000 -U -m -s /bin/bash build

# Test services (spec §5): MySQL 8.4 LTS (official tarball), PostgreSQL 17 and Redis (AL2023 packages).
# Each runs as its own system user; the agent starts them only for a build that selects them.
# REDIS_PACKAGE comes from versions.json; its binaries are /usr/bin/${REDIS_PACKAGE}-server and -cli.
ARG REDIS_PACKAGE=redis6
RUN dnf install -y --setopt=install_weak_deps=0 postgresql17-server postgresql17 ${REDIS_PACKAGE} libaio numactl-libs \
 && dnf clean all
COPY --from=mysql /opt/mysql /opt/mysql
RUN chown -R root:root /opt/mysql && chmod -R u=rwX,go=rX /opt/mysql \
 && for u in mysql postgres redis; do getent passwd "$u" >/dev/null || useradd -r -U -M -s /sbin/nologin "$u"; done \
 && for b in mysqld mysql mysqladmin; do ln -s /opt/mysql/bin/$b /usr/local/bin/$b; done \
 && for b in postgres initdb pg_isready psql; do ln -s /usr/bin/$b /usr/local/bin/$b; done \
 && for b in server cli; do ln -s /usr/bin/${REDIS_PACKAGE}-$b /usr/local/bin/redis-$b; done \
 && for b in mysqld mysql mysqladmin postgres initdb pg_isready psql redis-server redis-cli; do test -x /usr/local/bin/$b || { echo "missing $b"; exit 1; }; done \
 && install -d -o root -g root -m 0755 /opt/arco-services /opt/arco-services/templates /var/lib/arco-services /run/arco-services
# Pristine data templates: the agent copies one to /var/lib/arco-services/<service> at start. No server keeps running.
# The MySQL TLS/RSA keys and server UUID are deleted so no VM shares them; mysqld regenerates them on first start.
RUN mysqld --no-defaults --initialize-insecure --user=mysql --basedir=/opt/mysql --datadir=/opt/arco-services/templates/mysql \
 && install -d -o postgres -g postgres -m 0700 /opt/arco-services/templates/pgsql \
 && LC_ALL=C.UTF-8 runuser -u postgres -- initdb -D /opt/arco-services/templates/pgsql -U postgres --auth-local=trust --auth-host=scram-sha-256 -E UTF8 --no-instructions \
 && chown -R mysql:mysql /opt/arco-services/templates/mysql \
 && chmod 0700 /opt/arco-services/templates/mysql /opt/arco-services/templates/pgsql \
 && rm -f /opt/arco-services/templates/mysql/*.pid /opt/arco-services/templates/pgsql/postmaster.pid \
 && rm -f /opt/arco-services/templates/mysql/*.pem /opt/arco-services/templates/mysql/auto.cnf

COPY inputs/php /usr/local/bin/php
COPY inputs/composer.phar /usr/local/bin/composer
COPY inputs/tini /usr/local/bin/tini
COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/php /usr/local/bin/composer /usr/local/bin/tini

# Arco re-checks size and sha256 before using a cached runtime binary.
COPY --chown=build:build inputs/frankenphp inputs/php /home/build/.arco/cache/runtime/${RUNTIME_BUILD}/
RUN chmod 0755 /home/build/.arco/cache/runtime/${RUNTIME_BUILD}/frankenphp /home/build/.arco/cache/runtime/${RUNTIME_BUILD}/php \
 && install -d -o build -g build -m 0755 /home/build/work

# Owned by root so the build user cannot modify the agent or the fixture.
COPY agent/ /opt/arco-runner/
COPY fixture/ /opt/arco-runner/fixture/
RUN chown -R root:root /opt/arco-runner \
 && chmod -R u=rwX,go=rX /opt/arco-runner

# No test server may be running or hold data when the image is snapshotted.
# pgrep exits 1 only when nothing matches (2 and 3 are errors, which must fail the build too).
RUN pgrep -x 'mysqld|postgres|redis-server|redis6-server'; test $? -eq 1 \
 && test -z "$(ls -A /var/lib/arco-services)"

ENV ARCO_RUNNER_IMAGE=php85 ARCO_RUNNER_IMAGE_REVISION=$REVISION

EXPOSE 8080 9000
# tini is PID 1: it reaps the orphans build commands leave behind and forwards SIGTERM to node.
ENTRYPOINT ["/usr/local/bin/tini", "--"]
CMD ["/usr/bin/node", "/opt/arco-runner/arco-runner.mjs"]
