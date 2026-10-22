# The ARG defaults, the base digest and ARCO_RUNNER_IMAGE below are rewritten from image/versions.json
# by scripts/package-image.ts. Build from the zip it produces, not from this directory.
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

COPY inputs/php /usr/local/bin/php
COPY inputs/composer.phar /usr/local/bin/composer
COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/php /usr/local/bin/composer

# Arco re-checks size and sha256 before using a cached runtime binary.
COPY --chown=build:build inputs/frankenphp inputs/php /home/build/.arco/cache/runtime/${RUNTIME_BUILD}/
RUN chmod 0755 /home/build/.arco/cache/runtime/${RUNTIME_BUILD}/frankenphp /home/build/.arco/cache/runtime/${RUNTIME_BUILD}/php \
 && install -d -o build -g build -m 0755 /home/build/work

# Owned by root so the build user cannot modify the agent or the fixture.
COPY agent/ /opt/arco-runner/
COPY fixture/ /opt/arco-runner/fixture/
RUN chown -R root:root /opt/arco-runner \
 && chmod -R u=rwX,go=rX /opt/arco-runner

ENV ARCO_RUNNER_IMAGE=php85 ARCO_RUNNER_IMAGE_REVISION=$REVISION

EXPOSE 8080 9000
CMD ["/usr/bin/node", "/opt/arco-runner/arco-runner.mjs"]
