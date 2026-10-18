# Runs inside the sandbox before every check: `sh /opt/factory/bootstrap.sh <command...>`.
# Copies the read-only mounted worktree into the tmpfs at /work, then builds a writable
# /work/node_modules made of symlinks into the image's /deps/node_modules. It must be a real
# directory because tools (vite/vitest) write temp files into node_modules. Any node_modules
# from the host copy is discarded: host binaries are for another OS.
set -e
cp -a /src/. /work/
rm -rf /work/node_modules
mkdir /work/node_modules
for e in /deps/node_modules/* /deps/node_modules/.[!.]*; do [ -e "$e" ] && ln -s "$e" /work/node_modules/; done
exec "$@"
