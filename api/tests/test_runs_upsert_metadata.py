"""POST /test-runs — the run metadata the front end renders.

The run detail screen draws a meta cell for the operator and for the bench
software. Only a hand edit could fill them, so every run the ingestion
pipeline registered showed a dash. The body takes both now.

Every field here is optional. A body that states none of them registers the
run exactly as before, because ingestion never waits for context.
"""

from datetime import UTC, datetime

RUN = "TAS-95002"


def _post(client, **overrides) -> tuple[int, dict]:
    body = {"run_id": RUN, "rig_id": "RIG-04"}
    body.update(overrides)
    response = client.post("/api/v1/test-runs", json=body)
    return response.status_code, response.json()


def test_the_body_takes_the_operator_and_the_bench_software(client, routed_db) -> None:
    status, body = _post(client, operator="A. Bergström", bench_sw="TAS-Bench 4.2.1")

    assert status == 201
    assert body["operator"] == "A. Bergström"
    assert body["bench_sw"] == "TAS-Bench 4.2.1"


def test_a_body_without_them_still_registers_the_run(client, routed_db) -> None:
    """Both fields are optional. Nothing about the old body changed."""
    status, body = _post(client)

    assert status == 201
    assert body["operator"] is None
    assert body["bench_sw"] is None


def test_the_two_fields_carry_the_source_the_body_states(client, routed_db) -> None:
    _status, body = _post(client, bench_sw="TAS-Bench 4.2.1", source="api:config")

    assert body["field_sources"]["bench_sw"]["source"] == "api:config"


def test_the_two_fields_default_to_the_embedded_tag(client, routed_db) -> None:
    _status, body = _post(client, operator="A. Bergström")

    assert body["field_sources"]["operator"]["source"] == "embedded"


def test_a_later_call_fills_a_field_the_first_call_left_empty(client, routed_db) -> None:
    """Context joins when it is available. The run lands first."""
    _post(client)
    status, body = _post(client, operator="A. Bergström")

    assert status == 200
    assert body["operator"] == "A. Bergström"


def test_a_manual_edit_outranks_a_later_pipeline_write(client, routed_db) -> None:
    """The precedence guard holds. A person is never overwritten by a rig."""
    _post(client, operator="ingested name")
    client.patch(
        f"/api/v1/test-runs/{RUN}",
        json={"operator": "A. Bergström", "actor": "a.bergstrom"},
    )

    _status, body = _post(client, operator="ingested name again")

    assert body["operator"] == "A. Bergström"
    assert body["field_sources"]["operator"]["source"] == "manual"


def test_a_replay_of_the_same_metadata_writes_no_journal_entry(client, routed_db) -> None:
    """An unchanged replay stays silent. A restarting pipeline adds no noise."""
    _post(client, operator="A. Bergström")
    before = routed_db["journal_entries"].count_documents({"entity_id": RUN})

    _post(client, operator="A. Bergström")

    assert routed_db["journal_entries"].count_documents({"entity_id": RUN}) == before


def test_an_unknown_body_field_is_still_refused(client, routed_db) -> None:
    """`extra="forbid"` did not move. Every new field is additive only."""
    status, _body = _post(client, operator_name="A. Bergström")

    assert status == 422


def test_the_run_counts_still_derive_from_the_rows(client, routed_db) -> None:
    """`run_facts` owns the counts. This route writes none of them by hand."""
    _status, body = _post(client, operator="A. Bergström", started_at=_stamp())

    assert body["file_count"] == 0
    assert body["signal_count"] == 0


def _stamp() -> str:
    return datetime(2026, 8, 14, 9, 41, tzinfo=UTC).isoformat().replace("+00:00", "Z")
