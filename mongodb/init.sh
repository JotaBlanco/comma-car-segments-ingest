#!/bin/sh
set -e

# Entry point for the MongoDB deployment.
#
# mongod runs with --dbpath /app/state/mongodb, which is a Quix state volume
# that outlives the container. Two consequences drive this script:
#
#   1. The volume can be empty (first start) or provisioned root-owned, so the
#      directory has to be created and/or re-owned before mongod touches it.
#   2. Files inside it were written by a previous container. If their owner does
#      not match the UID mongod runs as, mongod can rename WiredTiger.wt (that
#      only needs write permission on the directory) but cannot open it, and
#      dies with "Operation not permitted" / Fatal assertion 28595.
#
# The fix for (2) is to own the files, on every start. Do NOT renumber the
# mongodb account to match the volume: that shifts the UID out from under files
# written by earlier runs and causes exactly the failure it appears to avoid.
#
# The official mongo docker-entrypoint.sh only chowns the hardcoded /data/db and
# /data/configdb paths, never a custom --dbpath, so it cannot do this for us.
#
# This script never deletes data. If the volume is unusable, that is a
# deliberate human operation, not something the entry point decides.

TARGET_DIR="/app/state/mongodb"
TARGET_USER="mongodb"
TARGET_GROUP="mongodb"

# Create the data directory if the volume is empty.
if [ ! -d "$TARGET_DIR" ]; then
  mkdir -p "$TARGET_DIR" || {
    echo "❌ Failed to create $TARGET_DIR"
    exit 1
  }
  echo "mongodb-init: created $TARGET_DIR"
fi

# Repair ownership on every start, recursively, before dropping privileges.
# Idempotent, and cheap at this data size.
if [ "$(id -u)" -eq 0 ]; then
  chown -R "$TARGET_USER:$TARGET_GROUP" "$TARGET_DIR" || {
    echo "❌ Failed to chown -R $TARGET_DIR to $TARGET_USER:$TARGET_GROUP"
    exit 1
  }
  echo "mongodb-init: $TARGET_DIR owned by $TARGET_USER:$TARGET_GROUP (recursive)"
else
  echo "⚠️  mongodb-init: not running as root (uid $(id -u)); cannot repair ownership of $TARGET_DIR"
fi

# Diagnostics: what mongod is about to see.
echo "mongodb-init: dbpath uid=$(stat -c '%u' "$TARGET_DIR") gid=$(stat -c '%g' "$TARGET_DIR"); $TARGET_USER uid=$(id -u "$TARGET_USER") gid=$(id -g "$TARGET_USER")"

# Hand over to the official entry point as the unprivileged mongodb user.
exec su -s /bin/sh "$TARGET_USER" -c "docker-entrypoint.sh mongod --bind_ip_all --dbpath '$TARGET_DIR'"
