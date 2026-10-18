# Runs inside the sandbox before every check: `sh /opt/factory/bootstrap.sh <command...>`.
# Copies the read-only mounted worktree into the tmpfs at /work and points /work/.venv at the
# image's /deps/.venv (any host .venv in the copy is discarded: it is for another OS).
set -e
cp -a /src/. /work/
rm -rf /work/.venv
ln -s /deps/.venv /work/.venv
exec "$@"
