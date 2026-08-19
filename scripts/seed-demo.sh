#!/usr/bin/env bash
# Populate the local stack with a demo: real requirements, a baseline, a run,
# real MF4 traces from the plant repo, an evaluation and the metrics.
#
# Every call is printed before it is made, so this doubles as the walkthrough
# script: you can read the curl line off the screen, or copy the same lines out
# of docs/LOCAL_DEVELOPMENT.md and paste them one at a time.
#
# Inputs (all real, none invented):
#   $ACC_PROJECT_DIR/Reqs/export/acc-system-requirements.reqif        ReqIF export
#   $ACC_PROJECT_DIR/Reqs/export/json/acc-system-requirements.json    canonical JSON
#   $ACC_PROJECT_DIR/Data/<scenario>/<run_id>.mf4                     37 plant traces
#   scripts/seed/signal-catalog.json   generated from acc_stim/mf4/signals.py
#   scripts/seed/test-specs.json       3 cases, thresholds quoted from the ReqIF
#   scripts/seed/acc_sys_tc_001.py     inert implementation (runner is deferred)
#
# What needs which part of the stack:
#   steps 1-8   core only        (mongodb + backend-api + frontend)
#   steps 9-12  --profile stream (MF4 upload publishes to the broker)
#
# Re-running is safe but not idempotent: each upload mints a new immutable
# artifact version (v0002, v0003, ...) and a new test run, which is the point of
# an append-only artifact store. It never deletes anything.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SEED_DIR="$SCRIPT_DIR/seed"
OUT_DIR="$REPO_ROOT/.tmp/seed"
mkdir -p "$OUT_DIR"

if [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env.local"
  set +a
fi

BASE="${BACKEND_BASE_URL:-http://localhost:${BACKEND_PORT:-8000}}"
ACC="${ACC_PROJECT_DIR:-C:/repos/acc_project}"

# curl here is the Windows binary, so it cannot open an MSYS path like /c/repos/x.
# $SCRIPT_DIR comes from `pwd`, which yields exactly that under Git Bash, while
# $ACC is already a drive-letter path. Normalise anything we hand to curl.
winpath() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s
' "$1" | sed -E 's|^/([a-zA-Z])/|:/|'
  fi
}

PY="${PYTHON:-python}"
UPLOADER="${SEED_UPLOADER:-seed-demo}"

DEVICE_ID="acc-plant-sim-01"
# From the MF4 sidecars: tool_name acc_stim, tool_version 0.2.0, asammdf 8.8.9,
# spec_ref dev-planning/acc-plant-mf4/spec.md (rev 2). The plant is a simulation,
# so its "hardware" version names the plant rather than a board.
SW_VERSION="acc_stim-0.2.0"
HW_VERSION="plant-sim"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

step() { echo -e "\n${BLUE}== $1${NC}"; }
ok() { echo -e "${GREEN}ok${NC}  $1"; }
warn() { echo -e "${YELLOW}!!${NC}  $1"; }
err() { echo -e "${RED}xx${NC}  $1" >&2; }

if ! command -v curl >/dev/null 2>&1; then
  err "curl is required"
  exit 1
fi
if ! "$PY" -c "import json" >/dev/null 2>&1; then
  err "a python interpreter is required for JSON extraction; set PYTHON=..."
  exit 1
fi

# jget <file> <key> [key ...] - read a nested value out of a JSON response.
jget() {
  local file="$1"
  shift
  "$PY" -c "
import json, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))
for key in sys.argv[2:]:
    doc = doc[int(key)] if isinstance(doc, list) else doc[key]
print(doc)
" "$file" "$@" 2>/dev/null
}

# call <name> <curl args...> - run curl, keep body in $OUT_DIR/<name>.json,
# set HTTP_CODE. Prints the command first.
HTTP_CODE=""
BODY_FILE=""
call() {
  local name="$1"
  shift
  BODY_FILE="$OUT_DIR/$name.json"
  echo "  curl $*" | sed "s#$BASE#\$BASE#g"
  HTTP_CODE="$(curl -sS -o "$BODY_FILE" -w '%{http_code}' "$@")" || HTTP_CODE="000"
  echo "  -> HTTP $HTTP_CODE  (body: $BODY_FILE)"
}

fail_out() {
  err "$1"
  if [ -n "$BODY_FILE" ] && [ -f "$BODY_FILE" ]; then
    head -c 1200 "$BODY_FILE"
    echo ""
  fi
  exit 1
}

require_file() {
  [ -f "$1" ] || fail_out "missing input file: $1"
}

# --------------------------------------------------------------------- 0 -----
step "0. Backend health and blob backend"
call health "$BASE/health"
[ "$HTTP_CODE" = "200" ] || fail_out "backend not answering on $BASE"
BLOB_BACKEND="$(jget "$BODY_FILE" blob_storage backend)"
BLOB_AVAILABLE="$(jget "$BODY_FILE" blob_storage available)"
MONGO_AVAILABLE="$(jget "$BODY_FILE" mongo available)"
echo "  blob backend: $BLOB_BACKEND (available=$BLOB_AVAILABLE), mongo available=$MONGO_AVAILABLE"
if [ "$BLOB_AVAILABLE" != "True" ]; then
  fail_out "blob storage unavailable: $(jget "$BODY_FILE" blob_storage reason)"
fi
if [ "$MONGO_AVAILABLE" != "True" ]; then
  fail_out "mongo unavailable: $(jget "$BODY_FILE" mongo reason)"
fi
ok "backend is ready with the $BLOB_BACKEND blob backend"

# --------------------------------------------------------------------- 1 -----
REQIF="$ACC/Reqs/export/acc-system-requirements.reqif"
REQJSON="$ACC/Reqs/export/json/acc-system-requirements.json"
require_file "$REQIF"
require_file "$REQJSON"

step "1. Upload requirements as ReqIF (37 requirements, real export)"
call uploads_requirements_reqif -X POST "$BASE/uploads/requirements" \
  -F "file=@$REQIF;type=application/xml" \
  -F "uploaded_by=$UPLOADER" \
  -F "notes=ReqIF export from acc_project/Reqs"
[ "$HTTP_CODE" = "200" ] || fail_out "ReqIF upload failed"
REQ_V_REQIF="$(jget "$BODY_FILE" version)"
ok "requirements $REQ_V_REQIF from ReqIF"

step "2. Upload the same requirements as canonical JSON (second version)"
call uploads_requirements_json -X POST "$BASE/uploads/requirements" \
  -F "file=@$REQJSON;type=application/json" \
  -F "uploaded_by=$UPLOADER" \
  -F "notes=canonical JSON export of the same document"
[ "$HTTP_CODE" = "200" ] || fail_out "JSON upload failed"
REQ_VERSION="$(jget "$BODY_FILE" version)"
ok "requirements $REQ_VERSION from JSON (the baseline below pins this one)"

step "3. Prove the two upload paths converge (no version minted)"
call convergence -X POST "$BASE/uploads/requirements/convergence-check" \
  -F "reqif_file=@$REQIF;type=application/xml" \
  -F "json_file=@$REQJSON;type=application/json"
if [ "$HTTP_CODE" = "200" ]; then
  echo "  converged: $(jget "$BODY_FILE" converged)"
  ok "convergence report in $BODY_FILE"
else
  warn "convergence check returned HTTP $HTTP_CODE (not fatal for the demo)"
fi

step "4. Upload the signal catalogue (65 channels from the plant table)"
require_file "$SEED_DIR/signal-catalog.json"
call uploads_signal_catalog -X POST "$BASE/uploads/signal-catalog" \
  -F "file=@$(winpath "$SEED_DIR/signal-catalog.json");type=application/json" \
  -F "uploaded_by=$UPLOADER" \
  -F "notes=generated from acc_stim/mf4/signals.py"
[ "$HTTP_CODE" = "200" ] || fail_out "signal catalogue upload failed"
CATALOG_VERSION="$(jget "$BODY_FILE" version)"
ok "signal_catalog $CATALOG_VERSION"

step "5. Upload the test specifications (3 cases over real requirements)"
require_file "$SEED_DIR/test-specs.json"
call uploads_test_specs -X POST "$BASE/uploads/test-specs" \
  -F "file=@$(winpath "$SEED_DIR/test-specs.json");type=application/json" \
  -F "uploaded_by=$UPLOADER" \
  -F "notes=demo seed cases for PRF-020, PRF-022, PRF-003"
[ "$HTTP_CODE" = "200" ] || fail_out "test-specs upload failed"
SPECS_VERSION="$(jget "$BODY_FILE" version)"
ok "test_specs $SPECS_VERSION"

step "6. Upload one test implementation (inert: the runner is deferred)"
require_file "$SEED_DIR/acc_sys_tc_001.py"
call uploads_test_impl -X POST "$BASE/uploads/test-impl" \
  -F "file=@$(winpath "$SEED_DIR/acc_sys_tc_001.py");type=text/x-python" \
  -F "tc_id=ACC-SYS-TC-001" \
  -F "entrypoint=acc_sys_tc_001.py" \
  -F "language=python" \
  -F "trace_required=true" \
  -F "uploaded_by=$UPLOADER"
[ "$HTTP_CODE" = "200" ] || fail_out "test-impl upload failed"
IMPL_VERSION="$(jget "$BODY_FILE" version)"
ok "test_impl $IMPL_VERSION"

# --------------------------------------------------------------------- 7 -----
step "7. Baseline: dry-run the pin, then mint it"
PIN_JSON="$OUT_DIR/baseline-pin.json"
cat >"$PIN_JSON" <<JSON
{
  "requirements_version": "$REQ_VERSION",
  "test_specs_version": "$SPECS_VERSION",
  "test_impl_version": "$IMPL_VERSION",
  "signal_catalog_version": "$CATALOG_VERSION",
  "label": "local demo baseline",
  "created_by": "$UPLOADER"
}
JSON
call baseline_dry_run -X POST "$BASE/baselines/dry-run" \
  -H "Content-Type: application/json" --data-binary "@$PIN_JSON"
if [ "$HTTP_CODE" = "200" ]; then
  echo "  would_be_accepted: $(jget "$BODY_FILE" would_be_accepted)" \
    "errors: $(jget "$BODY_FILE" error_count)" \
    "warnings: $(jget "$BODY_FILE" warning_count)"
fi
call baseline_create -X POST "$BASE/baselines" \
  -H "Content-Type: application/json" --data-binary "@$PIN_JSON"
[ "$HTTP_CODE" = "201" ] || fail_out "baseline creation failed"
BASELINE_ID="$(jget "$BODY_FILE" baseline_id)"
ok "baseline $BASELINE_ID pins $REQ_VERSION / $SPECS_VERSION / $IMPL_VERSION / $CATALOG_VERSION"

# --------------------------------------------------------------------- 8 -----
step "8. Register the plant device and its version, then create and submit a run"
call device_create -X POST "$BASE/devices" -H "Content-Type: application/json" -d "{
  \"device_id\": \"$DEVICE_ID\",
  \"name\": \"ACC plant simulation 01\",
  \"kind\": \"plant-sim\",
  \"description\": \"acc_stim plant, MF4 writer 0.2.0\"
}"
case "$HTTP_CODE" in
  201) ok "device $DEVICE_ID registered" ;;
  409) warn "device $DEVICE_ID already registered, continuing" ;;
  *) fail_out "device registration failed" ;;
esac

call device_version_create -X POST "$BASE/devices/$DEVICE_ID/versions" \
  -H "Content-Type: application/json" -d "{
  \"sw_version\": \"$SW_VERSION\",
  \"hw_version\": \"$HW_VERSION\",
  \"plant_spec_ref\": \"dev-planning/acc-plant-mf4/spec.md (rev 2)\",
  \"tool_name\": \"acc_stim\",
  \"tool_version\": \"0.2.0\",
  \"asammdf_version\": \"8.8.9\",
  \"make_current\": true
}"
case "$HTTP_CODE" in
  201) ok "device version $SW_VERSION / $HW_VERSION registered" ;;
  409) warn "device version already registered, continuing" ;;
  *) fail_out "device version registration failed" ;;
esac

call run_create -X POST "$BASE/test-runs" -H "Content-Type: application/json" -d "{
  \"baseline_id\": \"$BASELINE_ID\",
  \"device_id\": \"$DEVICE_ID\",
  \"device_sw_version\": \"$SW_VERSION\",
  \"device_hw_version\": \"$HW_VERSION\",
  \"scope\": {\"kind\": \"by_test_case\",
              \"tc_ids\": [\"ACC-SYS-TC-001\", \"ACC-SYS-TC-002\", \"ACC-SYS-TC-003\"]},
  \"label\": \"local demo run\",
  \"created_by\": \"$UPLOADER\"
}"
[ "$HTTP_CODE" = "201" ] || fail_out "run creation failed"
TEST_RUN_ID="$(jget "$BODY_FILE" test_run_id)"
ok "run $TEST_RUN_ID created (no config pinned, so no provenance check)"

call run_submit -X POST "$BASE/test-runs/$TEST_RUN_ID/submit"
[ "$HTTP_CODE" = "200" ] || fail_out "run submit failed"
ok "run $TEST_RUN_ID submitted; the plan is frozen"

echo ""
ok "core walkthrough complete without a broker:"
echo "    requirements $REQ_V_REQIF (ReqIF) + $REQ_VERSION (JSON), baseline $BASELINE_ID,"
echo "    run $TEST_RUN_ID. Open the UI at http://localhost:${FRONTEND_PORT:-8501}."

# --------------------------------------------------------------------- 9 -----
step "9. Upload three real MF4 traces (needs the broker: --profile stream)"
upload_trace() {
  local path="$1" tc_id="$2" name="$3"
  require_file "$path"
  call "trace_$name" -X POST "$BASE/uploads/traces" \
    -F "file=@$path;type=application/octet-stream" \
    -F "device_id=$DEVICE_ID" \
    -F "sw_version=$SW_VERSION" \
    -F "hw_version=$HW_VERSION" \
    -F "test_run_id=$TEST_RUN_ID" \
    -F "tc_ids=$tc_id" \
    -F "uploaded_by=$UPLOADER"
  if [ "$HTTP_CODE" = "503" ]; then
    warn "503 from the event bus - the broker is not running."
    warn "The object and the Mongo row were written; only the publish failed."
    warn "Start the broker and the stream services with:"
    warn "    ./scripts/dev.sh up stream"
    warn "then re-run this script (it will mint fresh versions) or re-upload"
    warn "this one file with the curl line printed above."
    return 1
  fi
  [ "$HTTP_CODE" = "200" ] || fail_out "trace upload failed for $path"
  ok "$tc_id <- $(jget "$BODY_FILE" trace_key)  ($(basename "$path"))"
  return 0
}

if ! upload_trace \
  "$ACC/Data/lead_brake_3mps2/lead_brake_3mps2__v100__f8aeb2756729.mf4" \
  "ACC-SYS-TC-001" "tc001"; then
  exit 0
fi
upload_trace \
  "$ACC/Data/cruise_set_speed/cruise_set_speed__v100__9a10ca54c894.mf4" \
  "ACC-SYS-TC-002" "tc002" || exit 0
upload_trace \
  "$ACC/Data/follow_steady_timegap/follow_steady_timegap__tau08__80c3cb927293.mf4" \
  "ACC-SYS-TC-003" "tc003" || exit 0

# -------------------------------------------------------------------- 10 -----
step "10. Wait for mf4-extractor to report the traces vectorised"
# The extractor reads each object from the shared blob volume, expands it into
# about 6 400 rows across four topics and publishes one completion event;
# mongo-writer sinks that event into the traces collection, which is what
# readiness reads.
READY=""
for attempt in $(seq 1 40); do
  call readiness "$BASE/test-runs/$TEST_RUN_ID/readiness" >/dev/null
  if [ "$HTTP_CODE" = "200" ]; then
    VECTORISED="$("$PY" -c "
import json, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))
traces = doc.get('traces') or []
print(sum(1 for t in traces if t.get('ingest_status') == 'vectorised'))
" "$BODY_FILE" 2>/dev/null)"
    echo "  attempt $attempt: vectorised traces = ${VECTORISED:-unknown}"
    if [ "${VECTORISED:-0}" -ge 3 ] 2>/dev/null; then
      READY="yes"
      break
    fi
  fi
  sleep 5
done
if [ -n "$READY" ]; then
  ok "all three traces vectorised"
else
  warn "not all traces reported vectorised within ~200 s."
  warn "Check: ./scripts/dev.sh logs mf4-extractor   and   logs mongo-writer"
  warn "Continuing: the evaluation below will report what is missing rather than"
  warn "inventing a verdict."
fi

# -------------------------------------------------------------------- 11 -----
step "11. Request an evaluation (asynchronous: the API only publishes)"
call evaluate -X POST "$BASE/test-runs/$TEST_RUN_ID/evaluate" \
  -H "Content-Type: application/json" \
  -d "{\"trigger\": \"manual\", \"requested_by\": \"$UPLOADER\"}"
[ "$HTTP_CODE" = "202" ] || fail_out "evaluation request rejected"
ok "evaluation requested; tm-evaluator picks it up off evaluation-requests"
sleep 15

# -------------------------------------------------------------------- 12 -----
step "12. Read the metrics and the requirement verdicts"
call metrics "$BASE/metrics/$TEST_RUN_ID/1"
if [ "$HTTP_CODE" = "200" ]; then
  "$PY" -c "
import json, sys
doc = json.load(open(sys.argv[1], encoding='utf-8'))
metrics = doc.get('metrics') or doc
for key in sorted(metrics):
    print(f'    {key}: {metrics[key]}')
" "$BODY_FILE"
else
  warn "metrics not available yet (HTTP $HTTP_CODE); the evaluator may still be"
  warn "running. Retry: curl $BASE/metrics/$TEST_RUN_ID/1"
fi
call requirement_verdicts "$BASE/requirement-verdicts/$TEST_RUN_ID/1"

echo ""
warn "Expected locally: every criterion that needs samples reports"
warn "reason_code 'lake_query_failed'. The evaluator reads test vectors only"
warn "through the Lakehouse Query API (tm-evaluator/lake_client.py), and there is"
warn "no local Iceberg catalog. See docs/LOCAL_DEVELOPMENT.md, 'What cannot be"
warn "tested locally'."
echo ""
ok "demo seeded: baseline $BASELINE_ID, run $TEST_RUN_ID"
echo "    UI:       http://localhost:${FRONTEND_PORT:-8501}"
echo "    metrics:  $BASE/metrics/$TEST_RUN_ID/1"
echo "    responses: $OUT_DIR"
