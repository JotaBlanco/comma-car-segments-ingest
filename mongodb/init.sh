#!/bin/sh
set -e

# Quix mounts persistent state at /app/state; keep the WiredTiger files in a
# dedicated subdirectory below it.
#
# The upstream template aligned the mongodb *user* to the directory's UID with
# usermod. That is fragile: if the mount reports a different UID on a later
# start, the mongodb uid shifts with it, and mongod can then write the
# directory but not open files it wrote under the previous uid. WiredTiger
# fails with EPERM on WiredTiger.wt, renames it aside, retries, and the
# container crash-loops.
#
# Inverting the fix is stable - chown the data to the mongodb user on every
# start, so ownership is correct regardless of what the mount reports.
#
# The directory name differs from the template's ("mongodb") deliberately: the
# original path holds files from the crash-looping runs, owned by a uid that no
# longer exists in this container.
TARGET_DIR="/app/state/mongodb-data"
TARGET_USER="mongodb"
TARGET_GROUP="mongodb"

mkdir -p "$TARGET_DIR"

if [ "$(id -u)" = "0" ]; then
  if chown -R "$TARGET_USER:$TARGET_GROUP" "$TARGET_DIR"; then
    exec su -s /bin/sh "$TARGET_USER" -c \
      "docker-entrypoint.sh mongod --bind_ip_all --dbpath $TARGET_DIR"
  fi
  echo "WARN: could not chown $TARGET_DIR; starting mongod as root instead"
fi

exec docker-entrypoint.sh mongod --bind_ip_all --dbpath "$TARGET_DIR"
