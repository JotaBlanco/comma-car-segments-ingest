#!/usr/bin/env sh
# Regenerate docs/openapi.v1.json from the app.
# Contract-first rule: change plans/API-CONTRACT.md before you run this.
cd "$(dirname "$0")/.." || exit 1
uv run python scripts/make_snapshot.py
