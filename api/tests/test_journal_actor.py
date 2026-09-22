"""The journal actor comes from the verified caller, never from the body.

`POST /results` stamped the journal actor from `body.provenance.produced_by`
(`api/routers/results.py`). A client typed that string, so the audit record
repeated a claim. Five more routes had the same defect: the run patch, the two
invalid-flag routes, the run note and the signal patch.

The rule now: a proven identity replaces the body actor. With the platform
check off nothing changes at all, because that is the demo path.

Every route below runs three branches:

- the switch is off, so the body actor stands;
- the switch is on and the two names agree;
- the switch is on and the two names disagree.

The third branch is the guard. It fails the moment somebody restores the body
as the source of the actor.

No test here opens a socket. `httpx.MockTransport` answers the Portal calls,
and `conftest.no_platform_check` clears the switch, the transport and the cache
around every test.
"""

from datetime import UTC, datetime

import httpx
import pytest

from api import quix_identity
from api.db import ensure_indexes
from tests.conftest import TEST_TOKEN
from tests.factories_planning import make_run
from tests.factories_results import provenance, result_body
from tests.factories_signals import make_signal

PORTAL = "https://portal-api.test.quix.io"

# A test-only value. It is not a real credential.
LIVE_TOKEN = "live-platform-token-not-a-secret"

PROFILE = {
    "userId": "auth0|64f0c1",
    "email": "emanuel@volvo.test",
    "firstName": "Emanuel",
    "lastName": "Nilsson",
}

# The name the platform proves.
VERIFIED = "Emanuel Nilsson"

# The name a client types into the body. It names somebody else.
CLAIMED = "e.lindqvist"

RUN = "TAS-88214"
SIGNAL = "HV_Batt_Cell_Temp_Max"
FILE = "f-9a41c2d0"

FLAGGED = {
    "flagged": True,
    "reason": "Torque flange calibration expired",
    "actor": "seed",
    "at": datetime(2026, 8, 14, 9, 0, tzinfo=UTC),
}


@pytest.fixture(autouse=True)
def no_workspace(monkeypatch):
    """Ask for identity only. The blob store reads the same name, so clear it."""
    monkeypatch.delenv(quix_identity.WORKSPACE_VAR, raising=False)


def _portal() -> httpx.MockTransport:
    """A Portal that names one person and grants every workspace."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == quix_identity.PERMISSIONS_PATH:
            return httpx.Response(200, json=True)
        return httpx.Response(200, json=PROFILE)

    return httpx.MockTransport(handler)


def _headers(switch: str) -> dict:
    """The bearer for one branch. The static token keeps the demo path."""
    token = TEST_TOKEN if switch == "off" else LIVE_TOKEN
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def switch(request, monkeypatch):
    """Turn the platform check on for the two platform branches."""
    if request.param != "off":
        monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL)
        quix_identity.TRANSPORT = _portal()
    return request.param


def _stamped(db) -> str:
    """The actor of the one journal entry the route wrote."""
    entries = list(db["journal_entries"].find())
    assert len(entries) == 1, entries
    return entries[0]["actor"]


# --- one seed and one call per route ----------------------------------------


def _seed_results(db) -> None:
    # `POST /results` refuses a result whose run is absent (21 Aug 2026).
    ensure_indexes(db)
    db["test_runs"].insert_one(make_run(run_id=RUN))


def _post_result(client, headers, actor) -> None:
    body = result_body(provenance=provenance(produced_by=actor))
    response = client.post("/api/v1/results", json=body, headers=headers)
    assert response.status_code == 201, response.text


def _seed_run(db) -> None:
    db["test_runs"].insert_one(make_run(run_id=RUN))


def _patch_run(client, headers, actor) -> None:
    response = client.patch(
        f"/api/v1/test-runs/{RUN}",
        json={"operator": "A. Bergström", "actor": actor},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def _flag_run(client, headers, actor) -> None:
    response = client.post(
        f"/api/v1/test-runs/{RUN}/invalid-flag",
        json={"reason": "Readings suspect", "actor": actor},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def _seed_flagged_run(db) -> None:
    db["test_runs"].insert_one(make_run(run_id=RUN, invalid=dict(FLAGGED)))


def _clear_flag(client, headers, actor) -> None:
    response = client.request(
        "DELETE",
        f"/api/v1/test-runs/{RUN}/invalid-flag",
        json={"reason": "Calibration redone", "actor": actor},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def _add_note(client, headers, actor) -> None:
    response = client.post(
        f"/api/v1/test-runs/{RUN}/journal",
        json={"note": "Rig swapped mid-run.", "actor": actor},
        headers=headers,
    )
    assert response.status_code == 201, response.text


def _seed_file(db) -> None:
    # The event route checks that the file exists. It reads no other key.
    db["files"].insert_one({"_id": FILE})


def _post_journal_event(client, headers, actor) -> None:
    response = client.post(
        "/api/v1/journal",
        json={
            "entity_type": "file",
            "entity_id": FILE,
            "field": "file.detected",
            "kind": "event",
            "note": "New file observed in blob storage.",
            "source": "embedded",
            "actor": actor,
            "at": "2026-08-14T09:41:12Z",
        },
        headers=headers,
    )
    assert response.status_code == 201, response.text


def _seed_signal(db) -> None:
    make_signal(db, SIGNAL)


def _patch_signal(client, headers, actor) -> None:
    response = client.patch(
        f"/api/v1/signals/{SIGNAL}",
        json={"unit": "K", "actor": actor},
        headers=headers,
    )
    assert response.status_code == 200, response.text


# The five routes the ticket names, and the delete half of the invalid flag.
ROUTES = {
    "post_results": (_seed_results, _post_result),
    "patch_run": (_seed_run, _patch_run),
    "post_invalid_flag": (_seed_run, _flag_run),
    "delete_invalid_flag": (_seed_flagged_run, _clear_flag),
    "post_run_note": (_seed_run, _add_note),
    "patch_signal": (_seed_signal, _patch_signal),
    "post_journal_event": (_seed_file, _post_journal_event),
}

ROUTE_IDS = list(ROUTES)


def _run_route(route: str, client, db, actor: str, switch: str) -> str:
    seed, call = ROUTES[route]
    seed(db)
    call(client, _headers(switch), actor)
    return _stamped(db)


# --- branch 1: the switch is off, so nothing changes -------------------------


@pytest.mark.parametrize("route", ROUTE_IDS)
@pytest.mark.parametrize("switch", ["off"], indirect=True)
def test_with_the_switch_off_the_body_actor_still_stands(
    route, bare_client, routed_db, switch
):
    """The demo path. The static token names nobody, so the body is all we have."""
    assert _run_route(route, bare_client, routed_db, CLAIMED, switch) == CLAIMED


# --- branch 2: the switch is on and the names agree --------------------------


@pytest.mark.parametrize("route", ROUTE_IDS)
@pytest.mark.parametrize("switch", ["on"], indirect=True)
def test_with_the_switch_on_an_agreeing_body_keeps_the_name(
    route, bare_client, routed_db, switch
):
    """The client sent the true name. The stamped actor reads the same."""
    assert _run_route(route, bare_client, routed_db, VERIFIED, switch) == VERIFIED


# --- branch 3: the switch is on and the names disagree -----------------------


@pytest.mark.parametrize("route", ROUTE_IDS)
@pytest.mark.parametrize("switch", ["on"], indirect=True)
def test_with_the_switch_on_a_disagreeing_body_never_wins(
    route, bare_client, routed_db, switch
):
    """The guard. A body that names somebody else is overwritten, not trusted."""
    stamped = _run_route(route, bare_client, routed_db, CLAIMED, switch)
    assert stamped == VERIFIED
    assert stamped != CLAIMED


# --- the disagreement reaches the log ----------------------------------------


@pytest.mark.parametrize("switch", ["on"], indirect=True)
def test_a_disagreement_reaches_the_log(bare_client, routed_db, switch, caplog):
    """The overwrite is not silent. An operator can see both names."""
    with caplog.at_level("INFO", logger="api.auth"):
        _run_route("post_run_note", bare_client, routed_db, CLAIMED, switch)

    messages = [record.getMessage() for record in caplog.records]
    assert any(CLAIMED in message and VERIFIED in message for message in messages)


# --- the run document, not only the journal ----------------------------------


@pytest.mark.parametrize("switch", ["on"], indirect=True)
def test_the_invalid_flag_record_also_names_the_verified_caller(
    bare_client, routed_db, switch
):
    """The flag is stored on the run as well. Both copies must agree."""
    _run_route("post_invalid_flag", bare_client, routed_db, CLAIMED, switch)

    stored = routed_db["test_runs"].find_one({"_id": RUN})
    assert stored["invalid"]["actor"] == VERIFIED


@pytest.mark.parametrize("switch", ["on"], indirect=True)
def test_the_field_source_of_a_patched_run_names_the_verified_caller(
    bare_client, routed_db, switch
):
    """The source map carries an actor too. It is the same audit claim."""
    _run_route("patch_run", bare_client, routed_db, CLAIMED, switch)

    stored = routed_db["test_runs"].find_one({"_id": RUN})
    assert stored["field_sources"]["operator"]["actor"] == VERIFIED


# --- the result body is not the journal --------------------------------------


@pytest.mark.parametrize("switch", ["on"], indirect=True)
def test_produced_by_stays_as_the_body_sent_it(bare_client, routed_db, switch):
    """`produced_by` names the tool that made the data, not the caller.

    A disagreement there is normal, so the route keeps it and overwrites only
    the journal actor. Losing this line would rewrite the data provenance.
    """
    _run_route("post_results", bare_client, routed_db, CLAIMED, switch)

    stored = routed_db["processed_results"].find_one({})
    assert stored["provenance"]["produced_by"] == CLAIMED
    assert _stamped(routed_db) == VERIFIED


# --- the stable identifier, beside the name ----------------------------------
#
# A display name does not point at one person for ever. A person renames a
# Portal profile, and two people can carry the same name. So a proven row also
# stores `actor_id`, the Portal `userId`. See api/provenance.py "The actor id".


def _entry(db) -> dict:
    """The one journal entry the route wrote, whole."""
    entries = list(db["journal_entries"].find())
    assert len(entries) == 1, entries
    return entries[0]


@pytest.mark.parametrize("route", ROUTE_IDS)
@pytest.mark.parametrize("switch", ["on"], indirect=True)
def test_a_proven_row_stores_the_platform_user_id(route, bare_client, routed_db, switch):
    """The guard. Every route that stamps a verified name stamps the id too."""
    seed, call = ROUTES[route]
    seed(routed_db)
    call(bare_client, _headers(switch), CLAIMED)

    entry = _entry(routed_db)
    assert entry["actor"] == VERIFIED
    assert entry["actor_id"] == PROFILE["userId"]


@pytest.mark.parametrize("route", ROUTE_IDS)
@pytest.mark.parametrize("switch", ["off"], indirect=True)
def test_the_demo_path_stores_no_identifier(route, bare_client, routed_db, switch):
    """The static token proves no person, so the row keeps only the name.

    The key is absent, never null. A row written before this field existed is
    absent in the same way, so a reader has one case to handle.
    """
    seed, call = ROUTES[route]
    seed(routed_db)
    call(bare_client, _headers(switch), CLAIMED)

    entry = _entry(routed_db)
    assert entry["actor"] == CLAIMED
    assert "actor_id" not in entry


@pytest.mark.parametrize("switch", ["on"], indirect=True)
def test_the_field_source_of_a_patched_run_stores_the_identifier(
    bare_client, routed_db, switch
):
    """The source map is an audit claim too, so it carries the id as well."""
    _run_route("patch_run", bare_client, routed_db, CLAIMED, switch)

    stored = routed_db["test_runs"].find_one({"_id": RUN})
    assert stored["field_sources"]["operator"]["actor_id"] == PROFILE["userId"]


@pytest.mark.parametrize("switch", ["on"], indirect=True)
def test_a_rename_leaves_both_rows_on_one_person(bare_client, routed_db, switch):
    """The point of the whole field.

    The person writes one note, renames the Portal profile, and writes a
    second. The two names differ. The identifier is the only thing that still
    says the two rows belong to one person.
    """
    _seed_run(routed_db)
    _add_note(bare_client, _headers(switch), CLAIMED)

    renamed = dict(PROFILE, lastName="Nilsson-Berg")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == quix_identity.PERMISSIONS_PATH:
            return httpx.Response(200, json=True)
        return httpx.Response(200, json=renamed)

    quix_identity.TRANSPORT = httpx.MockTransport(handler)
    # The identity cache holds the old name for a minute. Drop it, or the
    # second call never asks the Portal again.
    quix_identity.reset_cache()
    _add_note(bare_client, _headers(switch), CLAIMED)

    rows = sorted(routed_db["journal_entries"].find(), key=lambda row: row["at"])
    assert len(rows) == 2, rows
    assert rows[0]["actor"] == "Emanuel Nilsson"
    assert rows[1]["actor"] == "Emanuel Nilsson-Berg"
    assert rows[0]["actor_id"] == rows[1]["actor_id"] == PROFILE["userId"]


# --- the identifier reaches the wire, not only the row -----------------------
#
# A row that carries the id helps nobody while the response drops it. A reader
# of the API must see the difference between a proven actor and a claim.
# Contract §A "Journal entry": the key is always present, and null means the
# platform proved nobody.


def _wire_entry(client, switch: str) -> dict:
    """The one journal entry the run timeline returns."""
    response = client.get(f"/api/v1/test-runs/{RUN}/journal", headers=_headers(switch))
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert len(items) == 1, items
    return items[0]


@pytest.mark.parametrize("switch", ["on"], indirect=True)
def test_the_wire_carries_the_platform_user_id(bare_client, routed_db, switch):
    """The platform path. Both the write answer and the read carry the id."""
    _seed_run(routed_db)
    written = bare_client.post(
        f"/api/v1/test-runs/{RUN}/journal",
        json={"note": "Rig swapped mid-run.", "actor": CLAIMED},
        headers=_headers(switch),
    )
    assert written.status_code == 201, written.text
    assert written.json()["actor_id"] == PROFILE["userId"]

    entry = _wire_entry(bare_client, switch)
    assert entry["actor"] == VERIFIED
    assert entry["actor_id"] == PROFILE["userId"]


@pytest.mark.parametrize("switch", ["off"], indirect=True)
def test_the_wire_reads_null_on_the_demo_path(bare_client, routed_db, switch):
    """The demo path. The key is present, and null is the honest answer.

    The row itself holds no key at all. The response model turns that absence
    into null, so a reader has one case to handle.
    """
    _seed_run(routed_db)
    written = bare_client.post(
        f"/api/v1/test-runs/{RUN}/journal",
        json={"note": "Rig swapped mid-run.", "actor": CLAIMED},
        headers=_headers(switch),
    )
    assert written.status_code == 201, written.text
    assert written.json()["actor_id"] is None

    entry = _wire_entry(bare_client, switch)
    assert entry["actor"] == CLAIMED
    assert "actor_id" in entry
    assert entry["actor_id"] is None


# --- POST /files names whoever registered the file ---------------------------
#
# Finding 13b (21 Aug 2026). The route took no identity, so every write
# recorded the actor "ingestion" — including a file a person registered by
# hand. The pipeline keeps that name on purpose: it holds the shared token.

FILE_BODY = {
    "filename": "bat_cyc_20260814_0941.mf4",
    "run_id": None,
    "source_system": "TAS",
    "format": "MDF 4.10",
    "size_bytes": 1024,
    "checksum_sha256": "c" * 64,
    "checksum_state": "verified",
}


def _register_file(client, headers) -> None:
    response = client.post("/api/v1/files", json=FILE_BODY, headers=headers)
    assert response.status_code == 201, response.text


@pytest.mark.parametrize("switch", ["off"], indirect=True)
def test_the_shared_token_keeps_the_ingestion_actor(bare_client, routed_db, switch):
    """The ingestion pipeline posts with the shared token. Its rows never move."""
    ensure_indexes(routed_db)
    _register_file(bare_client, _headers(switch))

    assert _stamped(routed_db) == "ingestion"


@pytest.mark.parametrize("switch", ["on"], indirect=True)
def test_a_person_who_registers_a_file_is_named(bare_client, routed_db, switch):
    """A Portal token proves a person, so the journal states the person."""
    ensure_indexes(routed_db)
    _register_file(bare_client, _headers(switch))

    assert _stamped(routed_db) == VERIFIED


# --- a display name that names nobody never answers 500 ----------------------
#
# Finding 13c (21 Aug 2026). `provenance._check_actor` refuses "quix user",
# "user" and "system", because a browser sends those without anybody typing
# them. A Portal profile is free text, so a person may really carry one. The
# refusal raised inside the download route, which had already passed every
# check, and the caller got a 500. The stable Portal user id stands in.


@pytest.fixture
def placeholder_person(monkeypatch):
    """A Portal that names a person whose display name names nobody."""
    profile = {**PROFILE, "firstName": "Quix", "lastName": "User"}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == quix_identity.PERMISSIONS_PATH:
            return httpx.Response(200, json=True)
        return httpx.Response(200, json=profile)

    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL)
    quix_identity.TRANSPORT = httpx.MockTransport(handler)


def test_a_placeholder_display_name_downloads_and_names_the_user_id(
    bare_client, routed_db, placeholder_person
):
    from api.services import file_bytes

    ensure_indexes(routed_db)
    routed_db["files"].insert_one(
        {
            "_id": FILE,
            "filename": "bat_cyc_20260814_0941.mf4",
            "status": "registered",
            "checksum_sha256": "d" * 64,
            "checksum_state": "verified",
            "storage_ref": "blob://test/file",
        }
    )

    class _Bytes:
        def open(self, storage_ref):
            return iter([b"payload"]), 7

    bare_client.app.dependency_overrides[file_bytes.get_file_bytes_provider] = (
        lambda: _Bytes()
    )
    try:
        response = bare_client.get(
            f"/api/v1/files/{FILE}/download",
            headers={"Authorization": f"Bearer {LIVE_TOKEN}"},
        )
    finally:
        bare_client.app.dependency_overrides.pop(
            file_bytes.get_file_bytes_provider, None
        )

    assert response.status_code == 200, response.text
    entry = _stamped(routed_db)
    assert entry == PROFILE["userId"]
