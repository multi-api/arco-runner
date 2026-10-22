# The fake Arco Cloud of the integration suite. Built from the repository root (see docker-compose.yml) so it can
# reuse agent/src/loopback-cloud.ts and the fixture app; Dockerfile.dockerignore keeps the context small.
FROM node:24-bookworm-slim
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends git zstd tar ca-certificates >/dev/null \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN echo '{"type":"module"}' > package.json
COPY agent/src/loopback-cloud.ts agent/src/loopback-cloud.ts
COPY integration/fake-cloud/server.ts integration/fake-cloud/server.ts
# The test repository: the fixture app under app/ (root_dir) and its path packages, with an env-dumping fake arco.
COPY fixture/app /srv/template/app
COPY fixture/packages /srv/template/packages
COPY integration/fake-cloud/fake-arco /srv/template/packages/fake-arco/bin/arco
RUN printf '# Fixture app\n' > /srv/template/README \
 && chmod 0755 /srv/template/packages/fake-arco/bin/arco
EXPOSE 8081
HEALTHCHECK --interval=1s --timeout=2s --retries=30 CMD ["node", "-e", "fetch('http://127.0.0.1:8081/admin/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "integration/fake-cloud/server.ts"]
