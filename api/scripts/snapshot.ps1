# Regenerate docs/openapi.v1.json from the app.
# Contract-first rule: change plans/API-CONTRACT.md before you run this.
Set-Location (Join-Path $PSScriptRoot "..")
uv run python scripts/make_snapshot.py
