# Sandbox profile "python312": checks of Python projects (pip, hash-locked dev dependencies).
#
# Build context (assembled by the factory, src/quality/sandbox.ts): this Dockerfile,
# bootstrap.sh and deps/ = the project's `profile.dependency_files`, which must be a single
# `requirements-dev.lock` with hashes (pip-compile --generate-hashes). The tools are installed
# HERE, at build time, with network access, into /deps/.venv. At check time the container runs
# with --network none, a read-only root filesystem and a non-root user; bootstrap.sh copies the
# code into a tmpfs at /work and links /work/.venv to /deps/.venv, so checks use the same
# `.venv/bin/<tool>` paths as on the host.
#
# Base image pinned by multi-arch digest: Python 3.12.15, Debian bookworm slim.
FROM python:3.12.15-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY bootstrap.sh /opt/factory/bootstrap.sh
COPY deps/ /deps-src/
RUN python -m venv /deps/.venv \
 && /deps/.venv/bin/pip install --quiet --require-hashes --no-deps -r /deps-src/requirements-dev.lock \
 && rm -rf /deps-src /root/.cache

# Unprivileged user (uid/gid 1000, like the other profiles). /deps stays root-owned.
RUN groupadd --gid 1000 runner && useradd --uid 1000 --gid 1000 --no-create-home runner
USER runner
WORKDIR /work
