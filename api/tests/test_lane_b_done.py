"""B-19 — the Lane B definition of done, proven end to end.

The lane's guards live in many modules. This module re-runs the named ones
against real Mongo in one place, and it fails when somebody removes a guard.

It closes three boxes on `plans/lanes/LANE-B.md`:
- The quarantine matrix, guard tests #6, #9, #10, #12 and the provenance
  reject-vs-flag split are green.
- A byte-identical `POST /results` replay returns 200 and mints no version.
- No validation, permission check, journal write or provenance gate was
  removed or weakened.

This module owns no route and no model. It copies no unit test. It states the
behavior a caller sees, so a change inside the code that keeps the behavior
leaves it green.
"""

import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import quote

import pytest

from api.db import ensure_indexes
from tests.factories import upsert_run
from tests.factories_results import provenance, result_body, seed_file
from tests.factories_signals import make_signal

FILES = "/api/v1/files"
SIGNALS = "/api/v1/signals"
RESULTS = "/api/v1/results"
RUN = "TAS-88214"
SIGNAL = "HV_Batt_Cell_Temp_Max"
ACTOR = "a.bergstrom"

# The six provenance keys the contract makes mandatory on every result.
PROVENANCE_KEYS = (
    "tool",
    "tool_version",
    "parameters",
    "input_file_ids",
    "produced_by",
    "produced_at",
)


@pytest.fixture(autouse=True)
def mongo_stats(stub_lake):
    """This run has no lake and no bucket. The stub lake serves the numbers."""


@pytest.fixture
def lane_db(routed_db):
    """The per-test database with every index and the run, routed into the app.

    `POST /results` refuses a result whose run this system never registered
    (21 Aug 2026), so the run has to exist before a result may name it. The
    quarantine cases state their own `run_id`, so the seeded run never hides
    a "no run key" case.
    """
    ensure_indexes(routed_db)
    upsert_run(routed_db)
    return routed_db


def _checksum() -> str:
    return uuid.uuid4().hex * 2


def _file_body(**overrides) -> dict:
    """A valid POST /files body. Every file test starts from this shape."""
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": RUN,
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1024,
        "checksum_sha256": _checksum(),
        "checksum_state": "verified",
    }
    body.update(overrides)
    return body


def _patch_body(**overrides) -> dict:
    """A valid PATCH /signals/{name} body."""
    body = {"unit": "°C", "actor": ACTOR, "note": "Set from the rig sheet."}
    body.update(overrides)
    return body


def _signal_path(name: str = SIGNAL) -> str:
    return f"{SIGNALS}/{quote(name, safe='')}"


def _results(db) -> int:
    return db["processed_results"].count_documents({})


def _journal(db, **query) -> list[dict]:
    return list(db["journal_entries"].find(query))


# ---------------------------------------------------------------------------
# Box 901 (a) — the quarantine matrix, through the API, against real Mongo.
# ---------------------------------------------------------------------------
#
# The contract states three rules in this order. A later rule never overrides
# an earlier one, and no rule ever drops the file.

QUARANTINE_MATRIX = [
    ("rule 1 checksum", {"checksum_state": "mismatch"}, "checksum mismatch"),
    ("rule 2 null run", {"run_id": None}, "no run key"),
    ("rule 2 unknown run", {"run_id": "TAS-00001"}, "no run key"),
    ("rule 3 caller", {"quarantine_reason": "unparseable header"}, "unparseable header"),
    (
        "rule 1 beats rule 2 and rule 3",
        {"checksum_state": "mismatch", "run_id": None, "quarantine_reason": "bad header"},
        "checksum mismatch",
    ),
    (
        "rule 2 beats rule 3",
        {"run_id": None, "quarantine_reason": "bad header"},
        "no run key",
    ),
]


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [case[1:] for case in QUARANTINE_MATRIX],
    ids=[case[0] for case in QUARANTINE_MATRIX],
)
def test_the_quarantine_matrix_holds_in_contract_order(client, lane_db, overrides, reason):
    upsert_run(lane_db)

    response = client.post(FILES, json=_file_body(**overrides))

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "quarantined"
    assert body["quarantine_reason"] == reason
    # The file reaches Mongo, and the deep link finds it there.
    stored = lane_db["files"].find_one({"_id": body["file_id"]})
    assert stored is not None
    assert stored["status"] == "quarantined"
    listed = client.get(FILES, params={"status": "quarantined"}).json()
    assert [item["file_id"] for item in listed["items"]] == [body["file_id"]]


def test_a_clean_file_registers_and_carries_no_reason(client, lane_db):
    """The matrix refuses a good file no more than it drops a bad one."""
    upsert_run(lane_db)

    response = client.post(FILES, json=_file_body())

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "registered"
    assert body["quarantine_reason"] is None


def test_a_quarantined_file_keeps_its_partial_metadata(client, lane_db):
    """Guard test #6. The registry keeps what it read from a bad file."""
    upsert_run(lane_db)

    response = client.post(
        FILES,
        json=_file_body(
            checksum_state="mismatch",
            size_bytes=4096,
            time_start="2026-08-14T09:41:07Z",
            time_end="2026-08-14T11:18:52Z",
        ),
    )

    assert response.status_code == 201, response.text
    detail = client.get(f"{FILES}/{response.json()['file_id']}").json()
    assert detail["status"] == "quarantined"
    assert detail["size_bytes"] == 4096
    assert detail["time_start"] is not None
    assert detail["time_end"] is not None


def test_guard_9_a_null_field_keeps_the_stored_value(client, lane_db):
    """Guard test #9. A field sent as null counts as absent, never as a wipe."""
    make_signal(lane_db, SIGNAL, unit="°C", unit_source="embedded", description="Old text")

    response = client.patch(
        _signal_path(), json={"unit": None, "description": "New text", "actor": ACTOR}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["unit"] == "°C"
    assert body["unit_source"] == "embedded"
    assert body["description"] == "New text"
    stored = lane_db["signals"].find_one({"_id": SIGNAL})
    assert stored["unit"] == "°C"
    assert "unit" not in stored["field_sources"]


def test_guard_10_non_ascii_text_survives_the_round_trip(client, lane_db):
    """Guard test #10. The real characters go in and come back out."""
    name = "Temp_Bergström"
    unit = "°C"
    sensor = "PT100-Ångström-B4"
    make_signal(lane_db, name, unit=None, description=None, sensor_ref=None)

    written = client.patch(
        _signal_path(name),
        json={"unit": unit, "sensor_ref": sensor, "actor": "a.bergström"},
    )

    assert written.status_code == 200, written.text
    assert written.json()["unit"] == unit
    assert written.json()["sensor_ref"] == sensor
    detail = client.get(_signal_path(name))
    assert detail.status_code == 200
    assert detail.json()["unit"] == unit
    assert detail.json()["sensor_ref"] == sensor
    # RFC 8259 fixes JSON at UTF-8, so the bytes are the thing to check.
    assert unit.encode("utf-8") in detail.content
    assert b"\\u00b0" not in detail.content


def test_malformed_provenance_is_a_reject_and_stores_nothing(client, lane_db):
    """The reject side of the split: a malformed body answers 422."""
    malformed = provenance()
    malformed.pop("tool_version")

    response = client.post(RESULTS, json=result_body(provenance=malformed))

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "provenance_required"
    assert "tool_version" in response.json()["detail"]
    assert _results(lane_db) == 0


def test_unverifiable_provenance_is_a_flag_and_stores_the_result(client, lane_db):
    """The flag side of the split: an unresolvable input id answers 201."""
    response = client.post(
        RESULTS, json=result_body(provenance=provenance(input_file_ids=["f-missing"]))
    )

    assert response.status_code == 201, response.text
    assert response.json()["provenance_status"] == "flagged"
    assert _results(lane_db) == 1


def test_a_resolved_input_file_id_stays_verified(client, lane_db):
    """The flag must fire on a bad id only, never on every result."""
    known = seed_file(lane_db)

    response = client.post(
        RESULTS, json=result_body(provenance=provenance(input_file_ids=[known["_id"]]))
    )

    assert response.status_code == 201, response.text
    assert response.json()["provenance_status"] == "verified"


# ---------------------------------------------------------------------------
# Box 901 (b) — the four named guard tests still exist under those node ids.
# ---------------------------------------------------------------------------
#
# A rename may lose a guard in silence. pytest's own collection answers which
# tests exist, so a text search cannot fool this check.

GUARD_NODE_IDS = (
    "tests/test_files_quarantine.py::test_checksum_mismatch_registers_quarantined",
    "tests/test_signals_patch.py::test_null_keeps_stored_value",
    "tests/test_encoding.py::test_utf8_roundtrip",
    "tests/test_results.py::test_byte_identical_replay_no_new_version",
)

API_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def collected_node_ids() -> set[str]:
    """Ask pytest which tests exist in the four guard modules.

    Collection imports the modules only. It starts no container.
    """
    modules = sorted({node.split("::")[0] for node in GUARD_NODE_IDS})
    finished = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "--collect-only",
            "-q",
            "-p",
            "no:cacheprovider",
            # The suite runs with `-n auto`. Collection needs no worker, and
            # 20 of them would start here once per worker that asks.
            "-n0",
            *modules,
        ],
        cwd=API_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert finished.returncode == 0, finished.stdout + finished.stderr
    return {
        line.strip().replace("\\", "/")
        for line in finished.stdout.splitlines()
        if "::" in line
    }


@pytest.mark.parametrize("node_id", GUARD_NODE_IDS)
def test_the_named_guard_test_still_exists(collected_node_ids, node_id):
    assert node_id in collected_node_ids, (
        f"{node_id} is gone. A guard test keeps its node id, or the lane loses it."
    )


# ---------------------------------------------------------------------------
# Box 902 — the byte-identical POST /results replay.
# ---------------------------------------------------------------------------


def test_guard_12_a_byte_identical_replay_returns_200_and_mints_no_version(client, lane_db):
    body = result_body()

    first = client.post(RESULTS, json=body)
    replay = client.post(RESULTS, json=body)

    assert first.status_code == 201, first.text
    assert replay.status_code == 200, replay.text
    # The replay serves the stored body, not a second one that looks like it.
    assert replay.json() == first.json()
    versions = sorted(doc["version"] for doc in lane_db["processed_results"].find({}))
    assert versions == [1]
    assert len(_journal(lane_db, field="run.result_written")) == 1


def test_a_changed_body_still_mints_the_next_version(client, lane_db):
    """The replay rule must not swallow a real change."""
    first = client.post(RESULTS, json=result_body())
    second = client.post(RESULTS, json=result_body(description="Rerun"))

    assert second.status_code == 201, second.text
    assert second.json()["version"] == 2
    assert second.json()["supersedes"] == first.json()["result_id"]


# ---------------------------------------------------------------------------
# Box 907 — the guard inventory. It fails when somebody removes a guard.
# ---------------------------------------------------------------------------

LANE_B_TAGS = {"files", "signals", "results"}

# (method, path template, a concrete path)
LANE_B_ROUTES = [
    ("GET", "/api/v1/files", FILES),
    ("POST", "/api/v1/files", FILES),
    ("GET", "/api/v1/files/{file_id}", f"{FILES}/f-missing"),
    ("PATCH", "/api/v1/files/{file_id}", f"{FILES}/f-missing"),
    ("DELETE", "/api/v1/files/{file_id}", f"{FILES}/f-missing"),
    ("POST", "/api/v1/files/{file_id}/archive", f"{FILES}/f-missing/archive"),
    ("POST", "/api/v1/files/{file_id}/restore", f"{FILES}/f-missing/restore"),
    ("POST", "/api/v1/files/{file_id}/invalid-flag", f"{FILES}/f-missing/invalid-flag"),
    ("DELETE", "/api/v1/files/{file_id}/invalid-flag", f"{FILES}/f-missing/invalid-flag"),
    ("GET", "/api/v1/files/{file_id}/download", f"{FILES}/f-missing/download"),
    ("GET", "/api/v1/files/export", f"{FILES}/export"),
    ("GET", "/api/v1/files/{file_id}/versions", f"{FILES}/f-missing/versions"),
    ("POST", "/api/v1/files/{file_id}/versions", f"{FILES}/f-missing/versions"),
    ("GET", "/api/v1/signals", SIGNALS),
    ("GET", "/api/v1/signals/facets", f"{SIGNALS}/facets"),
    ("GET", "/api/v1/signals/export", f"{SIGNALS}/export"),
    ("GET", "/api/v1/signals/{name}", _signal_path()),
    ("PATCH", "/api/v1/signals/{name}", _signal_path()),
    ("GET", "/api/v1/signals/{name}/stats", f"{_signal_path()}/stats"),
    ("GET", "/api/v1/test-runs/{run_id}/signals", f"/api/v1/test-runs/{RUN}/signals"),
    ("GET", "/api/v1/results", RESULTS),
    ("POST", "/api/v1/results", RESULTS),
    ("POST", "/api/v1/results/upload", f"{RESULTS}/upload"),
    ("GET", "/api/v1/results/{result_id}", f"{RESULTS}/res-missing"),
    ("PATCH", "/api/v1/results/{result_id}", f"{RESULTS}/res-missing"),
    ("GET", "/api/v1/results/{result_id}/download", f"{RESULTS}/res-missing/download"),
]


def test_the_route_inventory_names_every_lane_b_route(app):
    """A new Lane B route joins this list, or the token sweep misses it.

    The app reports its own routes through the schema. Nothing reads the
    committed snapshot file, so a stale snapshot cannot hide a new route.
    """
    live = {
        (method.upper(), path)
        for path, operations in app.openapi()["paths"].items()
        for method, operation in operations.items()
        if LANE_B_TAGS.intersection(operation.get("tags") or [])
    }

    assert live == {(method, template) for method, template, _ in LANE_B_ROUTES}


@pytest.mark.parametrize(
    ("method", "path"),
    [(method, path) for method, _, path in LANE_B_ROUTES],
    ids=[f"{method} {template}" for method, template, _ in LANE_B_ROUTES],
)
def test_every_lane_b_route_refuses_a_call_with_no_token(bare_client, method, path):
    # The token check runs before the route, so no seed is needed.
    response = bare_client.request(method, path)

    assert response.status_code == 401, response.text
    assert response.json()["code"] == "unauthorized"


# The three Lane B write bodies. Each one forbids an unknown field.
WRITE_BODIES = [
    ("POST", FILES, _file_body()),
    ("PATCH", _signal_path(), _patch_body()),
    ("POST", RESULTS, result_body()),
]


@pytest.mark.parametrize(
    ("method", "path", "body"),
    WRITE_BODIES,
    ids=[f"{method} {path}" for method, path, _ in WRITE_BODIES],
)
def test_every_lane_b_write_body_rejects_an_unknown_field(client, lane_db, method, path, body):
    response = client.request(method, path, json={**body, "wrong_field": 1})

    assert response.status_code == 422, response.text
    assert "wrong_field" in response.json()["detail"]


def test_no_post_files_call_ever_drops_a_file(client, lane_db):
    """The never-drop rule. Every POST /files leaves one more document."""
    upsert_run(lane_db)
    cases = [
        {},
        {"checksum_state": "mismatch"},
        {"run_id": None},
        {"run_id": "TAS-00001"},
        {"quarantine_reason": "unparseable header"},
    ]

    for count, overrides in enumerate(cases, start=1):
        response = client.post(FILES, json=_file_body(**overrides))
        assert response.status_code == 201, response.text
        assert lane_db["files"].count_documents({}) == count


def _provenance_gate_cases() -> list[tuple[str, dict]]:
    """Build one case per missing key, null value and blank value."""
    cases: list[tuple[str, dict]] = [
        ("block missing", {}),
        ("block null", {"provenance": None}),
    ]
    for key in PROVENANCE_KEYS:
        missing = provenance()
        missing.pop(key)
        cases.append((f"{key} missing", {"provenance": missing}))
        cases.append((f"{key} null", {"provenance": provenance(**{key: None})}))
        blank = [" "] if key == "input_file_ids" else "   "
        cases.append((f"{key} blank", {"provenance": provenance(**{key: blank})}))
    return cases


PROVENANCE_GATE_CASES = _provenance_gate_cases()


@pytest.mark.parametrize(
    "overrides",
    [case[1] for case in PROVENANCE_GATE_CASES],
    ids=[case[0] for case in PROVENANCE_GATE_CASES],
)
def test_the_provenance_gate_rejects_and_stores_nothing(client, lane_db, overrides):
    body = result_body()
    if "provenance" in overrides:
        body["provenance"] = overrides["provenance"]
    else:
        body.pop("provenance")

    response = client.post(RESULTS, json=body)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "provenance_required"
    assert _results(lane_db) == 0
    assert lane_db["journal_entries"].count_documents({}) == 0


# The actor gate. A blank name and a placeholder name both answer 422.
BAD_ACTORS = ["", "   ", "current-user", "unknown", "system", "quix user", "  System  "]


@pytest.mark.parametrize("actor", BAD_ACTORS)
def test_the_patch_actor_gate_refuses_a_name_that_names_nobody(client, lane_db, actor):
    make_signal(lane_db, SIGNAL, unit=None)

    response = client.patch(_signal_path(), json=_patch_body(actor=actor))

    assert response.status_code == 422, response.text
    assert "actor" in response.json()["detail"]
    assert lane_db["journal_entries"].count_documents({}) == 0


@pytest.mark.parametrize("actor", BAD_ACTORS)
def test_the_result_actor_gate_refuses_a_name_that_names_nobody(client, lane_db, actor):
    response = client.post(
        RESULTS, json=result_body(provenance=provenance(produced_by=actor))
    )

    assert response.status_code == 422, response.text
    assert "produced_by" in response.json()["detail"]
    assert _results(lane_db) == 0
    assert lane_db["journal_entries"].count_documents({}) == 0


def test_a_real_actor_still_passes_both_write_bodies(client, lane_db):
    """The gate must refuse a placeholder and never a real name."""
    make_signal(lane_db, SIGNAL, unit=None)

    patched = client.patch(_signal_path(), json=_patch_body())
    written = client.post(RESULTS, json=result_body())

    assert patched.status_code == 200, patched.text
    assert written.status_code == 201, written.text


def test_post_files_writes_the_journal(client, lane_db):
    upsert_run(lane_db)

    response = client.post(FILES, json=_file_body())

    assert response.status_code == 201, response.text
    entries = _journal(lane_db, entity_type="file", entity_id=response.json()["file_id"])
    assert len(entries) == 1
    assert entries[0]["field"] == "file.registered"
    assert entries[0]["kind"] == "event"
    assert entries[0]["actor"]


def test_patch_signals_writes_the_journal(client, lane_db):
    make_signal(lane_db, SIGNAL, unit=None)

    response = client.patch(_signal_path(), json=_patch_body())

    assert response.status_code == 200, response.text
    entries = _journal(lane_db, entity_type="signal", entity_id=SIGNAL)
    assert len(entries) == 1
    assert entries[0]["field"] == f"signal.{SIGNAL}.unit"
    assert entries[0]["actor"] == ACTOR


def test_post_results_writes_the_journal(client, lane_db):
    response = client.post(RESULTS, json=result_body())

    assert response.status_code == 201, response.text
    # The entry names the RESULT since 21 Aug 2026, and `context_run_id` keeps
    # it on the run timeline. See §18's journal note in plans/API-CONTRACT.md.
    entries = _journal(
        lane_db,
        entity_type="result",
        entity_id=response.json()["result_id"],
        field="run.result_written",
    )
    assert len(entries) == 1
    assert entries[0]["kind"] == "event"
    assert entries[0]["actor"] == provenance()["produced_by"]
