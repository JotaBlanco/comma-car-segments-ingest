#!/bin/sh
# Compose the connection URL from the pieces the Configuration Manager is configured with.
set -eu
: "${MONGO_HOST:=config-mongo}"
: "${MONGO_PORT:=27017}"
: "${MONGO_USER:?MONGO_USER is required}"
: "${MONGO_PASSWORD:?MONGO_PASSWORD is required}"
# URL-encode the credentials: a password with @ : / ? # or % must not break the URL.
enc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
export MONGOKU_DEFAULT_HOST="mongodb://$(enc "$MONGO_USER"):$(enc "$MONGO_PASSWORD")@${MONGO_HOST}:${MONGO_PORT}"
exec node build
