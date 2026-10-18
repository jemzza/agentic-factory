# Sandbox profile "node22": checks of Node.js projects (npm).
#
# Build context (assembled by the factory, src/quality/sandbox.ts): this Dockerfile,
# bootstrap.sh and deps/ = the project's `profile.dependency_files` (package.json and
# package-lock.json). Dependencies are installed HERE, at build time, with network access.
# At check time the container runs with --network none, a read-only root filesystem and a
# non-root user; the code under test is copied into a tmpfs at /work by bootstrap.sh and
# node_modules is linked to /deps.
#
# Base image pinned by multi-arch digest: Node 22.23.3, Debian bookworm slim.
FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

ENV CI=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_LOGLEVEL=warn

# Drop package managers we do not use (npm stays: checks run via `npm run`).
RUN rm -rf /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /usr/local/bin/corepack /usr/local/lib/node_modules/corepack

COPY bootstrap.sh /opt/factory/bootstrap.sh

WORKDIR /deps
COPY deps/ ./
RUN npm ci --no-audit --no-fund \
 && npm cache clean --force \
 && rm -rf /root/.npm

# Unprivileged user from the base image (uid/gid 1000). /deps stays root-owned (read-only).
USER node
WORKDIR /work
