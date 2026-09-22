#!/usr/bin/env sh
# Run the test suite. Needs Docker Desktop for the mongo harness tests.
cd "$(dirname "$0")/.." || exit 1
uv run --all-groups pytest "$@"
