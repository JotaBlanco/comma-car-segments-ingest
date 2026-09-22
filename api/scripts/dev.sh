#!/usr/bin/env sh
# Start the API with auto-reload. Set TM_API_TOKEN first (see ../../.env.example).
cd "$(dirname "$0")/.." || exit 1
if [ -z "$TM_API_TOKEN" ]; then
  echo "Set TM_API_TOKEN first. See .env.example at the repo root." >&2
  exit 1
fi
uv run uvicorn api.main:app --reload --port "${TM_API_PORT:-8010}"
