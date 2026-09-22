"""Work orders -> Dynamic Configuration: the push fires for new and changed
mirror rows only, carries the reference estate's body shape, and can never
hurt the sync. Ours (overlay), like the module it pins."""

from datetime import UTC, datetime

import httpx
import pytest

from api import config_push, planning_sync
from tests import factories

files_db = factories.files_db


class _RecordingClient:
    """A stand-in for httpx.Client mimicking the REAL service: POST answers
    409 once the (type, target_key) pair exists; PUT versions it."""

    calls: list[dict] = []
    existing: set[str] = set()
    fail = False
    fail_ids: set = set()

    def __init__(self, base_url="", headers=None, timeout=None):
        self.base_url = base_url
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def _record(self, method, url, json):
        _RecordingClient.calls.append(
            {"method": method, "url": url, "json": json, "headers": dict(self.headers)}
        )

    def post(self, url, json=None):
        if _RecordingClient.fail:
            raise httpx.ConnectError("configuration manager is away")
        key = json["metadata"]["target_key"]
        if key in _RecordingClient.fail_ids:
            raise httpx.ConnectError(f"{key} hangs the transport")
        if key in _RecordingClient.existing:
            return httpx.Response(
                409, request=httpx.Request("POST", "http://config" + url)
            )
        self._record("POST", url, json)
        _RecordingClient.existing.add(key)
        return httpx.Response(201, request=httpx.Request("POST", "http://config" + url))

    def put(self, url, json=None):
        if _RecordingClient.fail:
            raise httpx.ConnectError("configuration manager is away")
        self._record("PUT", url, json)
        return httpx.Response(200, request=httpx.Request("PUT", "http://config" + url))


@pytest.fixture(autouse=True)
def recording_client(monkeypatch):
    _RecordingClient.calls = []
    _RecordingClient.existing = set()
    _RecordingClient.fail = False
    _RecordingClient.fail_ids = set()
    monkeypatch.setattr(config_push.httpx, "Client", _RecordingClient)
    monkeypatch.setenv("CONFIG_API_URL", "http://configuration-manager")
    yield _RecordingClient


def _mirror(db, rows):
    planning_sync._mirror_work_orders(db, rows, datetime.now(UTC))


WO = {"id": "WO-2026-0990", "title": "Brake fade", "project": "EX90", "status": "active"}


def test_a_new_work_order_is_pushed_as_a_json_configuration(files_db, recording_client):
    _mirror(files_db, [WO])

    assert len(recording_client.calls) == 1
    call = recording_client.calls[0]
    assert call["method"] == "POST"
    assert call["url"] == "/api/v1/configurations"
    # The real models are extra=forbid — exactly these keys, nothing else
    # (the reference MOCK's `replace` flag would 422 here).
    assert call["json"] == {
        "metadata": {"type": "WorkOrder", "target_key": "WO-2026-0990"},
        "content": WO,
    }


def test_an_unchanged_pass_pushes_nothing(files_db, recording_client):
    """The sync re-mirrors every pass; identical rows must not count phantom
    versions in Dynamic Configuration."""
    _mirror(files_db, [WO])
    _mirror(files_db, [WO])

    assert len(recording_client.calls) == 1


def test_a_changed_work_order_is_pushed_again(files_db, recording_client):
    _mirror(files_db, [WO])
    _mirror(files_db, [{**WO, "status": "closed"}])

    assert len(recording_client.calls) == 2
    update = recording_client.calls[1]
    assert update["method"] == "PUT"
    # The service's own deterministic id: sha1("WorkOrder-<target_key>").
    import hashlib

    expected = hashlib.sha1(b"WorkOrder-WO-2026-0990").hexdigest()
    assert update["url"] == f"/api/v1/configurations/{expected}"
    assert update["json"] == {"content": {**WO, "status": "closed"}}


def test_no_config_api_url_disables_the_push(files_db, recording_client, monkeypatch):
    monkeypatch.delenv("CONFIG_API_URL")

    _mirror(files_db, [WO])

    assert recording_client.calls == []


def test_a_dead_config_api_never_hurts_the_mirror(files_db, recording_client):
    recording_client.fail = True

    _mirror(files_db, [WO])

    stored = files_db["work_orders"].find_one({"_id": "WO-2026-0990"})
    assert stored is not None and stored["raw"] == WO


def test_a_failed_push_retries_on_the_next_pass(files_db, recording_client):
    """The stamp is written only on success, so a push the config API missed
    is retried every pass instead of waiting for the next change."""
    recording_client.fail = True
    _mirror(files_db, [WO])
    assert recording_client.calls == []

    recording_client.fail = False
    _mirror(files_db, [WO])

    assert len(recording_client.calls) == 1
    _mirror(files_db, [WO])
    assert len(recording_client.calls) == 1  # delivered and stamped — done


def test_rows_that_predate_the_integration_backfill_once(files_db, recording_client):
    """A mirror row written before the integration existed carries no
    `config_pushed_at` stamp — the first pass pushes it once (the backfill),
    and the next pass stays quiet."""
    from datetime import UTC, datetime

    files_db["work_orders"].insert_one(
        {"_id": "WO-2026-0991", "raw": {**WO, "id": "WO-2026-0991"}}
    )

    _mirror(files_db, [{**WO, "id": "WO-2026-0991"}])

    assert len(recording_client.calls) == 1
    assert recording_client.calls[0]["json"]["metadata"]["target_key"] == "WO-2026-0991"

    _mirror(files_db, [{**WO, "id": "WO-2026-0991"}])
    assert len(recording_client.calls) == 1


def test_the_sdk_token_rides_as_the_bearer(files_db, recording_client, monkeypatch):
    monkeypatch.setenv("Quix__Sdk__Token", "sdk-secret")

    _mirror(files_db, [WO])

    assert recording_client.calls[0]["headers"]["Authorization"] == "Bearer sdk-secret"


def test_one_hanging_row_never_strands_the_rows_behind_it(files_db, recording_client):
    """A transport error on one work order used to abort the whole batch —
    and with a stable catalog order the SAME row starved everything behind
    it, pass after pass (25 Aug 2026). Per-row now: the healthy row lands
    and is stamped; the failed one stays unstamped and retries next pass."""
    recording_client.fail_ids = {"WO-2026-0990"}
    rows = [
        dict(WO),
        {"id": "WO-2026-0991", "title": "Thermal soak", "project": "EX90", "status": "active"},
    ]

    _mirror(files_db, rows)

    landed = {c["json"]["metadata"]["target_key"] for c in recording_client.calls if c["method"] == "POST"}
    assert landed == {"WO-2026-0991"}

    recording_client.fail_ids = set()
    recording_client.calls.clear()

    _mirror(files_db, rows)

    retried = {c["json"]["metadata"]["target_key"] for c in recording_client.calls}
    assert retried == {"WO-2026-0990"}, "only the failed row re-pushes"
