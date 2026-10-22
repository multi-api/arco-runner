#!/bin/sh
# Runs the whole unit suite on Linux (the canonical environment) in a throwaway container.
# The repo is mounted read-only at /w and copied to /t so the container never touches the host node_modules.
set -eu
cd "$(dirname "$0")/.."
exec docker run --rm -v "$PWD":/w:ro node:24-bookworm sh -ec '
  apt-get update -qq >/dev/null && apt-get install -y -qq zstd git >/dev/null
  mkdir /t && cd /w && tar --exclude=node_modules --exclude=.git --exclude=dist -cf - . | tar -xf - -C /t
  cd /t && npm ci --no-audit --no-fund >/dev/null && npm test
'
