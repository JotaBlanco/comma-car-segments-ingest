#!/usr/bin/env bash
# Test Manager local development / demo wrapper.
#
# Modelled on C:/repos/TestManager/Quix.TestManager/scripts/dev.sh, with this
# repo's layering: the default target is the demo core (mongodb + backend-api +
# frontend) and the broker plus the stream services are additive profiles, so a
# failure in an optional part can never take the UI down.
#
# Usage: ./scripts/dev.sh <command> [args]
#   up [core|stream|tools|all]   start (default: core)
#   down                         stop, keep volumes
#   logs [service]               last 100 lines
#   logs-f [service]             follow
#   shell <service>              bash, falling back to sh
#   status                       compose ps plus the URL list
#   seed                         run scripts/seed-demo.sh
#   rebuild [target]             down, then up --build
#   clean                        down -v (DELETES the blob store and Mongo data)
#
# Runs from anywhere: it cd's to the repo root itself.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}--${NC} $1"; }
ok() { echo -e "${GREEN}ok${NC} $1"; }
warn() { echo -e "${YELLOW}!!${NC} $1"; }
err() { echo -e "${RED}xx${NC} $1" >&2; }

header() {
  echo ""
  echo "=================================================="
  echo "  $1"
  echo "=================================================="
  echo ""
}

# --env-file is only added when the file exists; the compose defaults are the
# same values, so its absence changes nothing.
COMPOSE=(docker compose)
if [ -f "$REPO_ROOT/.env.local" ]; then
  COMPOSE=(docker compose --env-file "$REPO_ROOT/.env.local")
  # Also load it into this shell, so the URL list below prints the ports that
  # were actually used rather than the compose defaults.
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env.local"
  set +a
fi

check_docker() {
  if ! docker info >/dev/null 2>&1; then
    err "Docker is not running. Start Docker Desktop and retry."
    exit 1
  fi
}

# Translate a target name into the compose profile flags.
profile_flags() {
  case "${1:-core}" in
    core) printf '%s' "" ;;
    stream) printf '%s' "--profile stream" ;;
    tools) printf '%s' "--profile stream --profile tools" ;;
    all) printf '%s' "--profile stream --profile tools --profile lakehouse" ;;
    *)
      err "unknown target '$1' (use core|stream|tools|all)"
      exit 1
      ;;
  esac
}

urls() {
  local backend_port frontend_port dcm_port console_port
  backend_port="${BACKEND_PORT:-8000}"
  frontend_port="${FRONTEND_PORT:-8501}"
  dcm_port="${DCM_PORT:-8002}"
  console_port="${CONSOLE_PORT:-8080}"
  echo ""
  info "Frontend (Streamlit):  http://localhost:${frontend_port}"
  info "Backend API:           http://localhost:${backend_port}"
  info "API docs:              http://localhost:${backend_port}/docs"
  info "Backend health:        http://localhost:${backend_port}/health"
  info "Dynamic Config Mgr:    http://localhost:${dcm_port}  (profile: stream)"
  info "Redpanda Console:      http://localhost:${console_port}  (profile: tools)"
  info "Kafka from the host:   localhost:${REDPANDA_EXTERNAL_PORT:-19092}  (profile: stream)"
  echo ""
}

up() {
  local target="${1:-core}"
  header "Starting local stack (target: $target)"
  check_docker
  # shellcheck disable=SC2046,SC2086
  "${COMPOSE[@]}" $(profile_flags "$target") up -d
  ok "containers started"
  if [ "$target" = "core" ]; then
    warn "core only: no broker. MF4 upload and evaluate answer 503 naming the"
    warn "cause until you run: ./scripts/dev.sh up stream"
  fi
  status
}

down() {
  header "Stopping local stack"
  # Bring down every profile so nothing is left running from an earlier target.
  "${COMPOSE[@]}" --profile stream --profile tools --profile lakehouse down
  ok "containers stopped (volumes kept)"
}

rebuild() {
  local target="${1:-core}"
  header "Rebuilding (target: $target)"
  check_docker
  "${COMPOSE[@]}" --profile stream --profile tools --profile lakehouse down
  # shellcheck disable=SC2046,SC2086
  "${COMPOSE[@]}" $(profile_flags "$target") up -d --build
  ok "rebuilt and started"
  status
}

status() {
  header "Status"
  "${COMPOSE[@]}" --profile stream --profile tools --profile lakehouse ps
  urls
}

logs() {
  if [ -z "${1:-}" ]; then
    "${COMPOSE[@]}" --profile stream --profile tools --profile lakehouse logs --tail=100
  else
    "${COMPOSE[@]}" --profile stream --profile tools --profile lakehouse logs --tail=100 "$1"
  fi
}

logs_follow() {
  if [ -z "${1:-}" ]; then
    "${COMPOSE[@]}" --profile stream --profile tools --profile lakehouse logs -f
  else
    "${COMPOSE[@]}" --profile stream --profile tools --profile lakehouse logs -f "$1"
  fi
}

shell_in() {
  local service="${1:-}"
  if [ -z "$service" ]; then
    err "usage: ./scripts/dev.sh shell <service>"
    echo "services: mongodb backend-api frontend redpanda dynamic-config-manager \\"
    echo "          mf4-extractor tm-evaluator mongo-writer test-vectors-sink"
    exit 1
  fi
  info "opening a shell in $service"
  "${COMPOSE[@]}" --profile stream --profile tools --profile lakehouse \
    exec "$service" /bin/bash 2>/dev/null ||
    "${COMPOSE[@]}" --profile stream --profile tools --profile lakehouse \
      exec "$service" /bin/sh
}

seed() {
  header "Seeding the demo"
  "$SCRIPT_DIR/seed-demo.sh" "$@"
}

clean() {
  header "Clean"
  warn "This deletes the Mongo data volume, the local blob store (every uploaded"
  warn "requirement, baseline and MF4) and the Redpanda log."
  printf 'Type "yes" to continue: '
  read -r confirm
  if [ "$confirm" != "yes" ]; then
    info "cancelled"
    exit 0
  fi
  "${COMPOSE[@]}" --profile stream --profile tools --profile lakehouse down -v
  ok "containers and volumes removed"
}

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  up) up "${2:-core}" ;;
  down) down ;;
  rebuild) rebuild "${2:-core}" ;;
  status | ps) status ;;
  logs) logs "${2:-}" ;;
  logs-f) logs_follow "${2:-}" ;;
  shell) shell_in "${2:-}" ;;
  seed)
    shift
    seed "$@"
    ;;
  clean) clean ;;
  help | --help | -h) usage ;;
  "")
    err "no command given"
    usage
    exit 1
    ;;
  *)
    err "unknown command: $1"
    usage
    exit 1
    ;;
esac
