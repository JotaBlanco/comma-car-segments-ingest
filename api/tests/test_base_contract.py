# Base contract guards that the snapshot compare cannot see.
# These pin response bodies and model behavior, not the OpenAPI shape.

from datetime import UTC, datetime

UTC_NOW = datetime(2026, 8, 14, 9, 41, 33, tzinfo=UTC)


def test_doc_models_accept_the_mongo_id_key():
    # The collections store the natural key in _id (BE-PLAN §3). The lanes
    # validate Mongo documents directly, so every doc-backed model accepts
    # _id on input and keeps the domain name on the wire.
    from api.models.files import FileBody
    from api.models.journal import JournalEntry
    from api.models.planning import (
        WorkOrderDefinition,
        WorkOrderDetail,
        WorkOrderRow,
        WorkOrderRun,
    )
    from api.models.results import ResultBody
    from api.models.runs import RecentRun, RunListItem
    from api.models.signals import SignalRow

    for model, field in [
        (RunListItem, "run_id"),
        (RecentRun, "run_id"),
        (WorkOrderRow, "wo_id"),
        (WorkOrderDetail, "wo_id"),
        (WorkOrderDefinition, "td_id"),
        (WorkOrderRun, "run_id"),
        (FileBody, "file_id"),
        (SignalRow, "name"),
        (ResultBody, "result_id"),
        (JournalEntry, "id"),
    ]:
        assert model.model_fields[field].validation_alias == "_id", model.__name__

    doc = {
        "_id": "TAS-1",
        "description": None,
        "definition_id": None,
        "work_order_id": None,
        "project": None,
        "rig_id": "RIG-04",
        "test_cell": None,
        "file_count": 0,
        "signal_count": 0,
        "first_data_at": UTC_NOW,
        "status": "awaiting_work_order",
        "invalid": {"flagged": False, "reason": None, "actor": None, "at": None},
    }
    item = RunListItem.model_validate(doc)
    assert item.run_id == "TAS-1"
    dumped = item.model_dump(by_alias=True)
    assert "run_id" in dumped and "_id" not in dumped
    # The stub path still populates by the field name.
    by_name = dict(doc)
    by_name["run_id"] = by_name.pop("_id")
    assert RunListItem.model_validate(by_name).run_id == "TAS-1"


def test_journal_helper_output_validates_as_the_wire_model():
    from api.models.common import Source
    from api.models.journal import JournalEntry
    from api.provenance import add_event

    entry = JournalEntry.model_validate(
        add_event("run", "TAS-1", "run.registered", Source.EMBEDDED, "ingestion")
    )
    assert entry.id.startswith("j-")
    assert entry.kind == "event"


def test_toggle_offline_keeps_the_null_status_fields(client, seeded_db, planning_offline):
    # Contract #21: the toggle answers the full status body (#20), and nothing
    # more. The null fields stay in the body. The answer carried a demo_reset
    # field until 20 Aug 2026, and no toggle deletes a row now.
    body = client.post("/api/v1/planning-sync/toggle", json={"online": False}).json()
    assert body["online"] is False
    assert body["last_sync_at"] is None
    assert body["last_sync_result"] is None
    assert body["work_orders_mirrored"] == 42
    assert "demo_reset" not in body


def test_run_files_response_is_typed_in_the_openapi(app):
    # The FE generates types from the snapshot. Contract #6 must expose
    # its items envelope as a named schema, not a bare object.
    schema = app.openapi()["paths"]["/api/v1/test-runs/{run_id}/files"]["get"][
        "responses"
    ]["200"]["content"]["application/json"]["schema"]
    assert "$ref" in schema


def test_toggle_online_answers_the_full_status_body(client, routed_db, planning_offline):
    body = client.post("/api/v1/planning-sync/toggle", json={"online": True}).json()
    assert set(body) == {
        "online",
        "last_sync_at",
        "last_sync_result",
        "work_orders_mirrored",
    }
