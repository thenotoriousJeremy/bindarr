#!/bin/sh
# Runs as root, fixes ownership of the persisted volume, then drops to the
# unprivileged `node` user. A named volume created by an older root-running
# image is root-owned; without this, the non-root process hits EACCES writing the
# database or a scan catalog (see issue #17).
set -e

# Only the volume root. Subdirectories (models/, ssl/) are created by the server
# at startup, as the node user, precisely so they cannot be born root-owned inside
# a volume this script has already handed over — which is what made them
# permanently unwritable.
mkdir -p /app/database

# Everything not owned by node, not just the top directory. The guard used to be
# `stat /app/database != node`, which is true of a volume that has ALREADY been
# handed over once — so a root-owned subdirectory inside it (the mkdir above on
# an upgrade that first introduced it, or files copied into the volume from the
# host) was never fixed, and stayed unwritable forever. That is EACCES writing a
# catalog into /app/database/models with a database directory that looks perfectly
# fine.
#
# find touches only what is actually wrong, so a correct volume costs one stat
# walk and no writes at all.
if [ -n "$(find /app/database ! -user node -print -quit)" ]; then
  echo "entrypoint: taking ownership of /app/database for node user..."
  find /app/database ! -user node -exec chown node:node {} +
fi

# exec, and gosu execs in turn, so node replaces this shell as PID 1 and is the
# process `docker stop` signals. A shell left in between would swallow SIGTERM
# and the server's graceful shutdown (utils/shutdown.js) would never run.
exec gosu node "$@"
