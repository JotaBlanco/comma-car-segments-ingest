# Start the API with auto-reload. Set TM_API_TOKEN first (see ..\..\.env.example).
Set-Location (Join-Path $PSScriptRoot "..")
if (-not $env:TM_API_TOKEN) {
    Write-Error "Set TM_API_TOKEN first. See .env.example at the repo root."
    exit 1
}
$port = 8010
if ($env:TM_API_PORT) { $port = $env:TM_API_PORT }
uv run uvicorn api.main:app --reload --port $port
