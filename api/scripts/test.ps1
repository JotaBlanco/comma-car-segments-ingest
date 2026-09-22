# Run the test suite. Needs Docker Desktop for the mongo harness tests.
Set-Location (Join-Path $PSScriptRoot "..")
uv run --all-groups pytest @args
