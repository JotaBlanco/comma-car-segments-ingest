#!/bin/sh
set -e

# WiredTiger needs a data directory with full POSIX semantics.
#
# The Quix state mount (/app/state) does not provide them on this cluster:
# with a brand-new, correctly-owned, empty directory, WiredTiger still fails
# with EPERM when opening WiredTiger.wt, immediately after successfully
# renaming that same file. Rename (a directory operation) works while open (a
# file operation) does not - the signature of a network-backed filesystem.
# MongoDB does not support NFS/SMB for the data directory.
#
# MONGO_DBPATH therefore defaults to the container's local disk. That is
# EPHEMERAL: configuration is lost when the container restarts and has to be
# re-seeded. Point it back at a path under /app/state only if the mount is
# changed to block storage.
DBPATH="${MONGO_DBPATH:-/data/db}"
TARGET_USER="mongodb"
TARGET_GROUP="mongodb"

mkdir -p "$DBPATH"

echo "mongod dbpath: $DBPATH"
case "$DBPATH" in
  /app/state/*) echo "WARNING: dbpath is on the Quix state mount; WiredTiger may fail with EPERM" ;;
  *)            echo "NOTE: dbpath is on local disk - data does NOT survive a restart" ;;
esac

if [ "$(id -u)" = "0" ]; then
  if chown -R "$TARGET_USER:$TARGET_GROUP" "$DBPATH"; then
    exec su -s /bin/sh "$TARGET_USER" -c \
      "docker-entrypoint.sh mongod --bind_ip_all --dbpath $DBPATH"
  fi
  echo "WARN: could not chown $DBPATH; starting mongod as root instead"
fi

exec docker-entrypoint.sh mongod --bind_ip_all --dbpath "$DBPATH"
