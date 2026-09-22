"""Requirements documents on a test definition.

A definition carries requirements documents, and two sources write one.
Planning sends a document with the definition through the sync push. A person
uploads one in the Test Manager.

The two live in separate stores, so neither can delete the other's work:
planning owns `requirements_files` and replaces it on every pass, and a person
owns `manual_requirements_files`. The detail read merges them, manual first.

Every manual write leaves one journal entry with the real actor
(`plans/design/MANUAL-ATTACH.md` §6).
"""

from datetime import UTC, datetime

import httpx
import pytest

from api import quix_identity
from api.routers import test_definitions as test_definitions_router
from api.services import file_bytes, file_writes
from api.services.file_bytes import FileBytesUnavailable
from tests.conftest import TEST_TOKEN
from tests.factories_planning import make_definition, make_work_order

PORTAL = "https://portal-api.test.quix.io"

# A test-only value. It is not a real credential.
LIVE_TOKEN = "live-platform-token-not-a-secret"

PROFILE = {
    "userId": "auth0|64f0c1",
    "email": "emanuel@volvo.test",
    "firstName": "Emanuel",
    "lastName": "Nilsson",
}

# The name the platform proves for LIVE_TOKEN.
VERIFIED = "Emanuel Nilsson"

# The name the demo path records: the static token proves no person.
STATIC = "static token holder"

TD = "TD-EM-201"
WO = "WO-2026-0847"

PLANNING_DOC = {
    "name": "TR-EM-201-requirements.md",
    "content": "# Requirements\n\nHold each operating point for 120 seconds.\n",
}

ROUTE = f"/api/v1/test-definitions/{TD}/requirements-files"


@pytest.fixture(autouse=True)
def no_workspace(monkeypatch):
    """Ask the platform for the identity only, never for the blob store."""
    monkeypatch.delenv(quix_identity.WORKSPACE_VAR, raising=False)


@pytest.fixture
def platform(monkeypatch):
    """Turn the platform identity check on, and name one person."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == quix_identity.PERMISSIONS_PATH:
            return httpx.Response(200, json=True)
        return httpx.Response(200, json=PROFILE)

    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL)
    quix_identity.TRANSPORT = httpx.MockTransport(handler)
    return {"Authorization": f"Bearer {LIVE_TOKEN}"}


@pytest.fixture
def mirror(routed_db):
    """One work order and one definition, with no document on it."""
    routed_db["work_orders"].insert_one(make_work_order(wo_id=WO))
    routed_db["test_definitions"].insert_one(make_definition(td_id=TD, work_order_id=WO))
    return routed_db


def _push(client, documents) -> httpx.Response:
    return client.post(
        "/api/v1/planning/sync",
        json={
            "work_orders": [{"id": WO, "title": "E-machine", "project": "EX90"}],
            "test_definitions": [
                {
                    "id": TD,
                    "work_order_id": WO,
                    "title": "E-machine efficiency map",
                    "planned_runs": 2,
                    "requirements_files": documents,
                }
            ],
            "links": [],
        },
    )


def _detail(client) -> dict:
    response = client.get(f"/api/v1/test-definitions/{TD}")
    assert response.status_code == 200, response.text
    return response.json()


def _upload(client, name, content, headers=None) -> httpx.Response:
    return client.post(ROUTE, json={"name": name, "content": content}, headers=headers)


def _entries(db) -> list[dict]:
    """The journal entries the two write routes left, oldest first.

    A sync push journals the mirror write too. The filter keeps that entry out,
    so a count here counts the manual writes only.
    """
    query = {"field": {"$regex": "^test_definition.requirements_file_"}}
    return list(db["journal_entries"].find(query).sort("at", 1))


# --- part 1: planning sends the documents -----------------------------------


def test_the_push_stores_the_documents(client, routed_db) -> None:
    assert _push(client, [PLANNING_DOC]).status_code == 200

    stored = routed_db["test_definitions"].find_one({"_id": TD})["requirements_files"]

    assert [document["name"] for document in stored] == [PLANNING_DOC["name"]]
    assert stored[0]["content"] == PLANNING_DOC["content"]


def test_a_pushed_document_is_always_planning_and_names_no_person(client, routed_db) -> None:
    """The registry states the provenance. Planning can never claim a person."""
    _push(client, [PLANNING_DOC])

    stored = routed_db["test_definitions"].find_one({"_id": TD})["requirements_files"][0]

    assert stored["source"] == "planning"
    assert stored["updated_by"] is None
    assert isinstance(stored["updated_at"], datetime)


def test_the_detail_returns_the_pushed_documents(client, routed_db) -> None:
    _push(client, [PLANNING_DOC])

    documents = _detail(client)["requirements_files"]

    assert len(documents) == 1
    assert documents[0]["name"] == PLANNING_DOC["name"]
    assert documents[0]["content"] == PLANNING_DOC["content"]
    assert documents[0]["source"] == "planning"
    assert documents[0]["updated_by"] is None
    assert documents[0]["updated_at"].endswith("Z")


def test_a_push_without_the_field_is_legal(client, routed_db) -> None:
    """The field is optional. A planning system with no document still pushes."""
    response = client.post(
        "/api/v1/planning/sync",
        json={"test_definitions": [{"id": TD, "title": "E-machine"}]},
    )

    assert response.status_code == 200
    assert routed_db["test_definitions"].find_one({"_id": TD})["requirements_files"] == []


def test_a_pushed_document_with_an_unknown_key_answers_422(client, routed_db) -> None:
    """The document shape forbids an extra key, so a typo never loses text."""
    response = _push(client, [{**PLANNING_DOC, "contents": "typo"}])

    assert response.status_code == 422


def test_a_second_push_replaces_the_planning_documents(client, routed_db) -> None:
    """Planning owns its list wholesale, exactly as it owns the title."""
    _push(client, [PLANNING_DOC])
    _push(client, [{"name": "TR-EM-201-v2.md", "content": "# Version 2\n"}])

    stored = routed_db["test_definitions"].find_one({"_id": TD})["requirements_files"]

    assert [document["name"] for document in stored] == ["TR-EM-201-v2.md"]


def _stamp(db) -> object:
    """The `updated_at` of the one planning document of the definition."""
    return db["test_definitions"].find_one({"_id": TD})["requirements_files"][0]["updated_at"]


def test_a_re_push_of_the_same_text_keeps_the_stamp(client, routed_db) -> None:
    """`updated_at` names the moment the text changed, not the last pass."""
    _push(client, [PLANNING_DOC])
    first = _stamp(routed_db)

    _push(client, [PLANNING_DOC])

    assert _stamp(routed_db) == first


def test_a_push_of_new_text_moves_the_stamp(client, routed_db) -> None:
    _push(client, [PLANNING_DOC])
    first = _stamp(routed_db)

    _push(client, [{"name": PLANNING_DOC["name"], "content": "# Rewritten\n"}])

    assert _stamp(routed_db) > first


def test_a_definition_with_no_document_reads_an_empty_list(client, mirror) -> None:
    assert _detail(client)["requirements_files"] == []


def test_the_list_row_carries_no_document(client, routed_db) -> None:
    """The list response must not grow. The documents are detail-only."""
    _push(client, [PLANNING_DOC])

    row = client.get("/api/v1/test-definitions").json()["items"][0]

    assert "requirements_files" not in row


# --- part 2: a person uploads a document ------------------------------------


def test_the_upload_stores_a_manual_document(client, mirror) -> None:
    response = _upload(client, "notes.md", "# Bench notes\n")

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "notes.md"
    assert body["content"] == "# Bench notes\n"
    assert body["source"] == "manual"
    assert body["updated_by"] == STATIC


def test_the_upload_needs_the_bearer_token(bare_client, mirror) -> None:
    response = bare_client.post(ROUTE, json={"name": "notes.md", "content": "x"})

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_the_upload_refuses_an_unknown_definition(client, routed_db) -> None:
    response = _upload(client, "notes.md", "x")

    assert response.status_code == 404
    assert response.json()["code"] == "td_not_found"


def test_the_upload_refuses_an_empty_name(client, mirror) -> None:
    response = _upload(client, "   ", "# Bench notes\n")

    assert response.status_code == 422
    assert response.json()["code"] == "name_required"


def test_the_upload_refuses_an_empty_body(client, mirror) -> None:
    response = _upload(client, "notes.md", "   \n")

    assert response.status_code == 422
    assert response.json()["code"] == "content_required"


def test_the_upload_refuses_a_body_over_the_cap(client, mirror) -> None:
    """256 KiB of UTF-8. The cap counts bytes, never characters."""
    response = _upload(client, "notes.md", "a" * (256 * 1024 + 1))

    assert response.status_code == 413
    assert response.json()["code"] == "file_too_large"


def test_a_body_at_the_cap_passes(client, mirror) -> None:
    assert _upload(client, "notes.md", "a" * (256 * 1024)).status_code == 201


def test_the_upload_refuses_an_unknown_field(client, mirror) -> None:
    """Every request model of this repo forbids an extra key."""
    response = client.post(ROUTE, json={"name": "notes.md", "content": "x", "source": "planning"})

    assert response.status_code == 422


def test_a_caller_cannot_claim_the_planning_source(client, mirror) -> None:
    """The server sets the provenance, so an upload is always manual."""
    _upload(client, "notes.md", "# Bench notes\n")

    stored = mirror["test_definitions"].find_one({"_id": TD})

    assert stored["manual_requirements_files"][0]["source"] == "manual"
    assert stored.get("requirements_files") is None


# --- the sort and the shared name -------------------------------------------


def test_the_detail_sorts_manual_first_then_by_name(client, routed_db) -> None:
    _push(client, [{"name": "b-plan.md", "content": "b"}, {"name": "a-plan.md", "content": "a"}])
    _upload(client, "z-notes.md", "z")
    _upload(client, "m-notes.md", "m")

    documents = _detail(client)["requirements_files"]

    assert [document["name"] for document in documents] == [
        "m-notes.md",
        "z-notes.md",
        "a-plan.md",
        "b-plan.md",
    ]
    assert [document["source"] for document in documents] == [
        "manual",
        "manual",
        "planning",
        "planning",
    ]


def test_a_shared_name_keeps_both_documents(client, routed_db) -> None:
    """The manual document wins the order. Neither document is deleted."""
    _push(client, [PLANNING_DOC])
    _upload(client, PLANNING_DOC["name"], "# My own version\n")

    documents = _detail(client)["requirements_files"]

    assert [document["source"] for document in documents] == ["manual", "planning"]
    assert documents[0]["content"] == "# My own version\n"
    assert documents[1]["content"] == PLANNING_DOC["content"]


def test_a_later_push_never_deletes_a_manual_document(client, routed_db) -> None:
    _push(client, [PLANNING_DOC])
    _upload(client, "notes.md", "# Bench notes\n")
    _push(client, [])

    documents = _detail(client)["requirements_files"]

    assert [document["name"] for document in documents] == ["notes.md"]


# --- the repeat upload ------------------------------------------------------


def test_a_repeat_upload_replaces_the_manual_document(client, mirror) -> None:
    _upload(client, "notes.md", "# First\n")
    _upload(client, "notes.md", "# Second\n")

    stored = mirror["test_definitions"].find_one({"_id": TD})["manual_requirements_files"]

    assert len(stored) == 1
    assert stored[0]["content"] == "# Second\n"


def test_a_repeat_upload_leaves_the_planning_document_alone(client, routed_db) -> None:
    _push(client, [PLANNING_DOC])
    _upload(client, PLANNING_DOC["name"], "# First\n")
    _upload(client, PLANNING_DOC["name"], "# Second\n")

    stored = routed_db["test_definitions"].find_one({"_id": TD})

    assert len(stored["requirements_files"]) == 1
    assert stored["requirements_files"][0]["content"] == PLANNING_DOC["content"]
    assert len(stored["manual_requirements_files"]) == 1


def test_a_repeat_upload_journals_the_replacement(client, mirror) -> None:
    _upload(client, "notes.md", "# First\n")
    _upload(client, "notes.md", "# Second\n")

    fields = [entry["field"] for entry in _entries(mirror)]

    assert fields == [
        "test_definition.requirements_file_added",
        "test_definition.requirements_file_replaced",
    ]


# --- the delete -------------------------------------------------------------


def test_the_delete_removes_a_manual_document(client, mirror) -> None:
    _upload(client, "notes.md", "# Bench notes\n")

    response = client.delete(f"{ROUTE}/notes.md")

    assert response.status_code == 204
    assert mirror["test_definitions"].find_one({"_id": TD})["manual_requirements_files"] == []


def test_the_delete_needs_the_bearer_token(bare_client, mirror) -> None:
    response = bare_client.delete(f"{ROUTE}/notes.md")

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_the_delete_refuses_a_planning_document(client, routed_db) -> None:
    _push(client, [PLANNING_DOC])

    response = client.delete(f"{ROUTE}/{PLANNING_DOC['name']}")

    assert response.status_code == 409
    assert response.json()["code"] == "planning_owned_file"
    assert len(routed_db["test_definitions"].find_one({"_id": TD})["requirements_files"]) == 1


def test_the_delete_of_a_shared_name_keeps_the_planning_document(client, routed_db) -> None:
    _push(client, [PLANNING_DOC])
    _upload(client, PLANNING_DOC["name"], "# My own version\n")

    assert client.delete(f"{ROUTE}/{PLANNING_DOC['name']}").status_code == 204

    documents = _detail(client)["requirements_files"]
    assert [document["source"] for document in documents] == ["planning"]


def test_the_delete_refuses_an_unknown_name(client, mirror) -> None:
    response = client.delete(f"{ROUTE}/nothing.md")

    assert response.status_code == 404
    assert response.json()["code"] == "requirements_file_not_found"


def test_the_delete_refuses_an_unknown_definition(client, routed_db) -> None:
    response = client.delete(f"{ROUTE}/notes.md")

    assert response.status_code == 404
    assert response.json()["code"] == "td_not_found"


def test_a_refused_delete_writes_no_journal_entry(client, routed_db) -> None:
    _push(client, [PLANNING_DOC])

    client.delete(f"{ROUTE}/{PLANNING_DOC['name']}")

    assert _entries(routed_db) == []


# --- the journal and the real actor -----------------------------------------


def test_the_upload_journals_one_entry(client, mirror) -> None:
    _upload(client, "notes.md", "# Bench notes\n")

    entries = _entries(mirror)

    assert len(entries) == 1
    assert entries[0]["entity_id"] == TD
    assert entries[0]["field"] == "test_definition.requirements_file_added"
    assert entries[0]["source"] == "manual"
    assert entries[0]["note"] == "Added the requirements file notes.md."


def test_the_delete_journals_one_entry(client, mirror) -> None:
    _upload(client, "notes.md", "# Bench notes\n")
    client.delete(f"{ROUTE}/notes.md")

    fields = [entry["field"] for entry in _entries(mirror)]

    assert fields[-1] == "test_definition.requirements_file_removed"


def test_the_upload_journals_the_verified_actor(client, mirror, platform) -> None:
    """The platform names the caller, so the audit record names a person."""
    assert _upload(client, "notes.md", "# Bench notes\n", headers=platform).status_code == 201

    entries = _entries(mirror)

    assert entries[0]["actor"] == VERIFIED
    assert entries[0]["actor_id"] == PROFILE["userId"]


def test_the_stored_document_names_the_verified_actor(client, mirror, platform) -> None:
    body = _upload(client, "notes.md", "# Bench notes\n", headers=platform).json()

    assert body["updated_by"] == VERIFIED


def test_the_delete_journals_the_verified_actor(client, mirror, platform) -> None:
    _upload(client, "notes.md", "# Bench notes\n", headers=platform)
    assert client.delete(f"{ROUTE}/notes.md", headers=platform).status_code == 204

    entries = _entries(mirror)

    assert [entry["actor"] for entry in entries] == [VERIFIED, VERIFIED]
    assert entries[-1]["actor_id"] == PROFILE["userId"]


def test_the_static_token_never_names_a_person(client, mirror) -> None:
    """The demo path proves a token holder, so the journal says exactly that."""
    _upload(
        client,
        "notes.md",
        "# Bench notes\n",
        headers={"Authorization": f"Bearer {TEST_TOKEN}"},
    )

    entries = _entries(mirror)

    assert entries[0]["actor"] == STATIC
    assert entries[0].get("actor_id") is None


def test_the_entry_carries_the_moment_the_server_wrote_it(client, mirror) -> None:
    before = datetime.now(UTC).replace(microsecond=0)
    _upload(client, "notes.md", "# Bench notes\n")

    entry = _entries(mirror)[0]

    assert entry["at"].replace(tzinfo=UTC) >= before


# --- the seed and the mock cast ---------------------------------------------


def test_the_planning_cast_ships_two_requirements_documents() -> None:
    """The demo shows the documents, so the cast has to carry real text."""
    from seed import fixtures as fx

    carrying = {
        row["_id"]: row["requirements_files"]
        for row in fx.NAMED_DEFINITIONS
        if row["requirements_files"]
    }

    assert set(carrying) == {"TD-BAT-091", "TD-EM-201"}
    for documents in carrying.values():
        text = documents[0]["content"]
        assert documents[0]["source"] == "planning"
        assert documents[0]["updated_by"] is None
        assert text.startswith("# ")
        assert "\n## " in text
        assert "\n- " in text
        assert "| --- |" in text
        assert len(text.split()) >= 200


# --- part 4: a binary requirements document ---------------------------------
#
# A requirement does not always arrive as text. `POST .../requirements-files/
# upload` takes a PDF, a Word file, a spreadsheet or an image. The bytes go to
# blob storage and never to Mongo, and `GET .../{name}/download` streams them
# back. The two routes copy `POST /results/upload` and its download sibling.

UPLOAD_ROUTE = f"{ROUTE}/upload"

PDF_BYTES = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"


class _FakeWrites:
    """A stub writer. It keeps the bytes in memory so a test can read them back.

    `ordering` records `"bytes_written"` when the write starts, and the
    recording collection records `"journal_insert"`. The bytes must come first,
    the way `POST /results/upload` orders them.
    """

    def __init__(self, ordering: list[str] | None = None) -> None:
        self.stored: dict[str, bytes] = {}
        self._ordering = ordering

    def check_ready(self) -> None:
        return None

    def write(self, key: str, chunks) -> int:
        if self._ordering is not None:
            self._ordering.append("bytes_written")
        data = b"".join(chunks)
        self.stored[key] = data
        return len(data)


class _RefusingWrites:
    """A writer with no store behind it. It refuses before the audit entry."""

    def check_ready(self) -> None:
        raise FileBytesUnavailable("Storage unreachable - nothing is bound here.")

    def write(self, key: str, chunks) -> int:
        raise FileBytesUnavailable("Storage unreachable - the store took no write.")


class _FakeBytes:
    """A byte provider over the stub writer's memory."""

    def __init__(self, writer: _FakeWrites) -> None:
        self._writer = writer

    def open(self, storage_ref):
        key = (storage_ref or "").split("://", 1)[-1]
        data = self._writer.stored.get(key)
        if data is None:
            raise FileBytesUnavailable(f"blob is not present: {key}", "blob_missing")
        return iter([data]), len(data)


@pytest.fixture
def store(app):
    """Install one in-memory store for the write leg and the read leg."""
    writer = _FakeWrites()
    app.dependency_overrides[file_writes.get_file_writer] = lambda: writer
    app.dependency_overrides[file_bytes.get_file_bytes_provider] = lambda: _FakeBytes(
        writer
    )
    yield writer
    app.dependency_overrides.pop(file_writes.get_file_writer, None)
    app.dependency_overrides.pop(file_bytes.get_file_bytes_provider, None)


def _post_bytes(
    client, filename, payload, content_type="application/pdf", name=None, headers=None
):
    """Send one multipart upload the way the screen sends it."""
    return client.post(
        UPLOAD_ROUTE,
        files={"file": (filename, payload, content_type)},
        data={} if name is None else {"name": name},
        headers=headers,
    )


def test_a_binary_document_round_trips(client, mirror, store) -> None:
    """The bytes go out and come back, and the row names the stored blob."""
    created = _post_bytes(client, "requirements.pdf", PDF_BYTES)

    assert created.status_code == 201, created.text
    body = created.json()
    assert body["name"] == "requirements.pdf"
    assert body["content"] == ""
    assert body["source"] == "manual"
    assert body["content_type"] == "application/pdf"
    assert body["size_bytes"] == len(PDF_BYTES)
    assert body["storage_ref"].startswith("blob://")
    # Bytes carry no markdown, so the screen shows no switch for one.
    assert body["render_markdown"] is None

    served = client.get(f"{ROUTE}/requirements.pdf/download")

    assert served.status_code == 200, served.text
    assert served.content == PDF_BYTES
    assert served.headers["content-type"].startswith("application/pdf")
    assert served.headers["x-content-type-options"] == "nosniff"
    assert "attachment" in served.headers["content-disposition"]
    assert served.headers["content-length"] == str(len(PDF_BYTES))


def test_no_byte_reaches_mongo(client, mirror, store) -> None:
    """The document row holds the reference. The store holds the bytes."""
    _post_bytes(client, "requirements.pdf", PDF_BYTES)

    stored = mirror["test_definitions"].find_one({"_id": TD})["manual_requirements_files"]

    assert stored[0]["content"] == ""
    assert stored[0]["storage_ref"][len("blob://") :] in store.stored


def test_the_binary_upload_needs_the_bearer_token(bare_client, mirror, store) -> None:
    response = _post_bytes(bare_client, "requirements.pdf", PDF_BYTES)

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"
    assert store.stored == {}


def test_the_binary_download_needs_the_bearer_token(
    client, bare_client, mirror, store
) -> None:
    _post_bytes(client, "requirements.pdf", PDF_BYTES)

    response = bare_client.get(f"{ROUTE}/requirements.pdf/download")

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_the_binary_upload_journals_the_write(client, mirror, store) -> None:
    _post_bytes(client, "requirements.pdf", PDF_BYTES)

    fields = [entry["field"] for entry in _entries(mirror)]

    assert fields == ["test_definition.requirements_file_added"]


def test_the_binary_upload_names_the_verified_person(
    client, platform, mirror, store
) -> None:
    """The actor is the caller the platform proved, never a name a body states."""
    _post_bytes(client, "requirements.pdf", PDF_BYTES, headers=platform)

    stored = mirror["test_definitions"].find_one({"_id": TD})["manual_requirements_files"]

    assert stored[0]["updated_by"] == VERIFIED
    assert [entry["actor"] for entry in _entries(mirror)] == [VERIFIED]


def test_the_binary_download_journals_before_the_bytes(client, mirror, store) -> None:
    """Audit-before-bytes: a read leaves a trace even when the read then fails."""
    _post_bytes(client, "requirements.pdf", PDF_BYTES)

    client.get(f"{ROUTE}/requirements.pdf/download")

    fields = [entry["field"] for entry in _entries(mirror)]
    assert fields[-1] == "test_definition.requirements_file_downloaded"


def test_an_oversized_upload_is_refused(client, mirror, store, monkeypatch) -> None:
    """The cap refuses the file, and nothing reaches the store."""
    monkeypatch.setattr(test_definitions_router, "MAX_UPLOAD_BYTES", 1024)

    response = _post_bytes(client, "requirements.pdf", b"a" * 4096)

    assert response.status_code == 413
    assert response.json()["code"] == "file_too_large"
    assert store.stored == {}
    assert mirror["test_definitions"].find_one({"_id": TD}).get(
        "manual_requirements_files"
    ) is None


def test_a_file_at_the_cap_passes(client, mirror, store, monkeypatch) -> None:
    monkeypatch.setattr(test_definitions_router, "MAX_UPLOAD_BYTES", 1024)

    response = _post_bytes(client, "requirements.pdf", b"a" * 1024)

    assert response.status_code == 201, response.text


def test_an_empty_file_is_refused(client, mirror, store) -> None:
    response = _post_bytes(client, "requirements.pdf", b"")

    assert response.status_code == 422
    assert response.json()["code"] == "content_required"


def test_the_name_defaults_to_the_filename(client, mirror, store) -> None:
    body = _post_bytes(client, "spec sheet.xlsx", PDF_BYTES).json()

    assert body["name"] == "spec sheet.xlsx"


def test_a_stated_name_wins(client, mirror, store) -> None:
    body = _post_bytes(client, "tmp-4711.bin", PDF_BYTES, name="Rig photo").json()

    assert body["name"] == "Rig photo"


def test_an_unknown_definition_is_refused(client, routed_db, store) -> None:
    response = client.post(
        "/api/v1/test-definitions/TD-NOTHING/requirements-files/upload",
        files={"file": ("requirements.pdf", PDF_BYTES, "application/pdf")},
    )

    assert response.status_code == 404
    assert response.json()["code"] == "td_not_found"
    assert store.stored == {}


def test_a_binary_upload_never_overwrites_a_planning_document(
    client, routed_db, store
) -> None:
    """The manual store and the planning store stay apart, as on the text route."""
    _push(client, [PLANNING_DOC])
    _post_bytes(client, PLANNING_DOC["name"], PDF_BYTES)

    stored = routed_db["test_definitions"].find_one({"_id": TD})

    assert len(stored["requirements_files"]) == 1
    assert stored["requirements_files"][0]["content"] == PLANNING_DOC["content"]
    assert stored["manual_requirements_files"][0]["storage_ref"].startswith("blob://")


def test_a_binary_upload_replaces_the_manual_document_of_that_name(
    client, mirror, store
) -> None:
    _post_bytes(client, "requirements.pdf", b"first")
    _post_bytes(client, "requirements.pdf", b"second")

    stored = mirror["test_definitions"].find_one({"_id": TD})["manual_requirements_files"]

    assert len(stored) == 1
    served = client.get(f"{ROUTE}/requirements.pdf/download")
    assert served.content == b"second"


def test_a_refused_store_writes_no_journal_entry(client, mirror, app) -> None:
    """The server never fabricates a trace for bytes that never moved."""
    app.dependency_overrides[file_writes.get_file_writer] = _RefusingWrites
    try:
        response = _post_bytes(client, "requirements.pdf", PDF_BYTES)
    finally:
        app.dependency_overrides.pop(file_writes.get_file_writer, None)

    assert response.status_code == 503
    assert response.json()["code"] == "storage_unreachable"
    assert _entries(mirror) == []


def test_the_download_refuses_a_text_document(client, mirror, store) -> None:
    """A text document is complete. It simply holds no bytes to stream."""
    _upload(client, "notes.md", "# Bench notes\n")

    response = client.get(f"{ROUTE}/notes.md/download")

    assert response.status_code == 409
    assert response.json()["code"] == "requirements_file_has_no_bytes"


def test_the_download_refuses_an_unknown_name(client, mirror, store) -> None:
    response = client.get(f"{ROUTE}/nothing.pdf/download")

    assert response.status_code == 404
    assert response.json()["code"] == "requirements_file_not_found"


def test_the_download_refuses_unreachable_bytes(client, mirror, store) -> None:
    """A stored reference with no object behind it answers 503, never fake bytes."""
    _post_bytes(client, "requirements.pdf", PDF_BYTES)
    store.stored.clear()

    response = client.get(f"{ROUTE}/requirements.pdf/download")

    assert response.status_code == 503
    assert response.json()["code"] == "storage_unreachable"


@pytest.mark.parametrize(
    "stated",
    ["text/html\r\nX-Evil: 1", "not a media type", "", "text/", "  "],
)
def test_a_broken_content_type_becomes_the_safe_default(stated) -> None:
    """The stated type is a display label. A broken one never reaches a header."""
    assert (
        test_definitions_router._display_content_type(stated)
        == "application/octet-stream"
    )


def test_a_html_label_still_downloads_as_an_attachment(client, mirror, store) -> None:
    """The label decides no code path. `attachment` and `nosniff` hold for every type."""
    _post_bytes(client, "trap.htm", PDF_BYTES, content_type="text/html")

    served = client.get(f"{ROUTE}/trap.htm/download")

    assert served.headers["content-type"].startswith("text/html")
    assert served.headers["x-content-type-options"] == "nosniff"
    assert served.headers["content-disposition"].startswith("attachment")


def test_the_stated_content_type_keeps_its_media_type_only(
    client, mirror, store
) -> None:
    body = _post_bytes(
        client, "notes.csv", PDF_BYTES, content_type="text/CSV; charset=utf-8"
    ).json()

    assert body["content_type"] == "text/csv"


def test_the_binary_delete_removes_the_document(client, mirror, store) -> None:
    """The delete route reads the manual store, so it removes a binary too."""
    _post_bytes(client, "requirements.pdf", PDF_BYTES)

    assert client.delete(f"{ROUTE}/requirements.pdf").status_code == 204
    assert mirror["test_definitions"].find_one({"_id": TD})["manual_requirements_files"] == []


# --- part 5: the markdown switch --------------------------------------------
#
# A text document renders as markdown or as plain text, and the reader decides.
# The default comes off the name: `.md` renders as markdown, and every other
# name renders as plain text.


def test_a_md_name_defaults_to_markdown(client, mirror) -> None:
    assert _upload(client, "notes.md", "# Bench notes\n").json()["render_markdown"] is True


def test_another_name_defaults_to_plain_text(client, mirror) -> None:
    assert _upload(client, "notes.txt", "# Bench notes\n").json()["render_markdown"] is False


def test_the_flag_survives_a_write_and_a_read(client, mirror) -> None:
    """The caller states the flag, the store keeps it, and the detail reads it."""
    response = client.post(
        ROUTE,
        json={"name": "notes.md", "content": "# Bench notes\n", "render_markdown": False},
    )

    assert response.status_code == 201, response.text
    assert response.json()["render_markdown"] is False

    stored = mirror["test_definitions"].find_one({"_id": TD})["manual_requirements_files"]
    assert stored[0]["render_markdown"] is False

    documents = _detail(client)["requirements_files"]
    assert documents[0]["render_markdown"] is False


def test_the_flag_turns_markdown_on_for_any_name(client, mirror) -> None:
    response = client.post(
        ROUTE,
        json={"name": "notes.txt", "content": "# Bench notes\n", "render_markdown": True},
    )

    assert response.json()["render_markdown"] is True


def test_a_planning_document_reads_the_default_off_its_name(client, routed_db) -> None:
    """Planning states no flag, so the name decides for a planning document too."""
    _push(client, [PLANNING_DOC, {"name": "limits.csv", "content": "a,b\n1,2\n"}])

    documents = {doc["name"]: doc for doc in _detail(client)["requirements_files"]}

    assert documents[PLANNING_DOC["name"]]["render_markdown"] is True
    assert documents["limits.csv"]["render_markdown"] is False


def test_a_document_stored_before_the_flag_reads_the_default(client, mirror) -> None:
    """No migration ran. The detail read fills the flag from the name."""
    mirror["test_definitions"].update_one(
        {"_id": TD},
        {
            "$set": {
                "manual_requirements_files": [
                    {
                        "name": "old-notes.md",
                        "content": "# Old\n",
                        "source": "manual",
                        "updated_at": datetime.now(UTC),
                        "updated_by": STATIC,
                    }
                ]
            }
        },
    )

    documents = _detail(client)["requirements_files"]

    assert documents[0]["render_markdown"] is True


# --- part 6: the edit ---------------------------------------------------------
#
# A person may change the text of a manual document without removing it and
# adding it again. `PATCH .../requirements-files/{name}` does that, and the
# journal entry states what changed. The route never changes the name: the name
# is the identity of the document, and a rename is a different operation.


def _edit(client, name, content, headers=None, **extra) -> httpx.Response:
    return client.patch(
        f"{ROUTE}/{name}", json={"content": content, **extra}, headers=headers
    )


def _stored(db, index=0) -> dict:
    return db["test_definitions"].find_one({"_id": TD})["manual_requirements_files"][index]


def test_the_edit_changes_the_content(client, mirror) -> None:
    _upload(client, "notes.md", "# First\n")

    response = _edit(client, "notes.md", "# Second\n")

    assert response.status_code == 200, response.text
    assert response.json()["content"] == "# Second\n"
    assert _stored(mirror)["content"] == "# Second\n"


def test_the_edit_keeps_one_document(client, mirror) -> None:
    """An edit replaces the text in place. It never adds a second row."""
    _upload(client, "notes.md", "# First\n")

    _edit(client, "notes.md", "# Second\n")

    stored = mirror["test_definitions"].find_one({"_id": TD})["manual_requirements_files"]
    assert len(stored) == 1
    assert stored[0]["name"] == "notes.md"
    assert stored[0]["source"] == "manual"


def test_the_edit_needs_the_bearer_token(bare_client, mirror) -> None:
    response = bare_client.patch(f"{ROUTE}/notes.md", json={"content": "x"})

    assert response.status_code == 401
    assert response.json()["code"] == "unauthorized"


def test_the_edit_names_the_verified_person(client, mirror, platform) -> None:
    """The actor is the caller the platform proved, never a name a body states."""
    _upload(client, "notes.md", "# First\n")

    body = _edit(client, "notes.md", "# Second\n", headers=platform).json()

    assert body["updated_by"] == VERIFIED
    assert _entries(mirror)[-1]["actor"] == VERIFIED
    assert _entries(mirror)[-1]["actor_id"] == PROFILE["userId"]


def test_the_edit_refuses_a_name_in_the_body(client, mirror) -> None:
    """The name is the identity. The body carries no `name` key at all."""
    _upload(client, "notes.md", "# First\n")

    response = client.patch(
        f"{ROUTE}/notes.md", json={"content": "# Second\n", "name": "renamed.md"}
    )

    assert response.status_code == 422
    assert _stored(mirror)["name"] == "notes.md"


# --- the edit journal ---------------------------------------------------------


def test_the_edit_journals_what_changed(client, mirror) -> None:
    """The owner's condition: the history has to say what the edit did."""
    _upload(client, "notes.md", "# First\n")

    _edit(client, "notes.md", "# A much longer second version\n")

    entry = _entries(mirror)[-1]
    assert entry["field"] == "test_definition.requirements_file_edited"
    assert entry["source"] == "manual"
    assert entry["entity_id"] == TD
    assert entry["note"] == (
        "Edited the requirements file notes.md. The content changed from 8 to "
        "31 bytes. The markdown flag stayed on."
    )


def test_the_edit_journals_the_flag_change(client, mirror) -> None:
    _upload(client, "notes.md", "# First\n")

    _edit(client, "notes.md", "# First\n", render_markdown=False)

    note = _entries(mirror)[-1]["note"]
    assert "The content did not change." in note
    assert "The markdown flag went from on to off." in note


def test_the_edit_journal_never_carries_the_text(client, mirror) -> None:
    """A 256 KiB document must never land in the history."""
    _upload(client, "notes.md", "# First\n")

    _edit(client, "notes.md", "SECRET-BENCH-TEXT-" * 64)

    note = _entries(mirror)[-1]["note"]
    assert "SECRET-BENCH-TEXT" not in note
    assert len(note) < 200


def test_the_edit_journals_one_entry(client, mirror) -> None:
    _upload(client, "notes.md", "# First\n")

    _edit(client, "notes.md", "# Second\n")

    fields = [entry["field"] for entry in _entries(mirror)]
    assert fields == [
        "test_definition.requirements_file_added",
        "test_definition.requirements_file_edited",
    ]


# --- the markdown flag on an edit ---------------------------------------------


def test_the_flag_survives_an_edit(client, mirror) -> None:
    """An absent flag keeps the stored one. Editing text never re-renders it."""
    client.post(
        ROUTE, json={"name": "notes.md", "content": "# First\n", "render_markdown": False}
    )

    body = _edit(client, "notes.md", "# Second\n").json()

    assert body["render_markdown"] is False
    assert _stored(mirror)["render_markdown"] is False
    assert _detail(client)["requirements_files"][0]["render_markdown"] is False


def test_the_edit_changes_the_flag(client, mirror) -> None:
    _upload(client, "notes.md", "# First\n")

    body = _edit(client, "notes.md", "# Second\n", render_markdown=False).json()

    assert body["render_markdown"] is False
    assert _stored(mirror)["render_markdown"] is False


def test_an_edit_of_a_document_stored_before_the_flag_reads_the_default(
    client, mirror
) -> None:
    """No migration ran, so the edit fills the flag from the name, as the read does."""
    mirror["test_definitions"].update_one(
        {"_id": TD},
        {
            "$set": {
                "manual_requirements_files": [
                    {
                        "name": "old-notes.md",
                        "content": "# Old\n",
                        "source": "manual",
                        "updated_at": datetime.now(UTC),
                        "updated_by": STATIC,
                    }
                ]
            }
        },
    )

    body = _edit(client, "old-notes.md", "# New\n").json()

    assert body["render_markdown"] is True
    assert "The markdown flag stayed on." in _entries(mirror)[-1]["note"]


# --- the edit refusals --------------------------------------------------------


def test_the_edit_refuses_a_planning_document(client, routed_db) -> None:
    """A person owns the manual store only, exactly as the delete says."""
    _push(client, [PLANNING_DOC])

    response = _edit(client, PLANNING_DOC["name"], "# Mine now\n")

    assert response.status_code == 409
    assert response.json()["code"] == "planning_owned_file"
    stored = routed_db["test_definitions"].find_one({"_id": TD})["requirements_files"]
    assert stored[0]["content"] == PLANNING_DOC["content"]


def test_the_edit_of_a_shared_name_reaches_the_manual_document(client, routed_db) -> None:
    """Both stores hold the name. The edit changes the manual document only."""
    _push(client, [PLANNING_DOC])
    _upload(client, PLANNING_DOC["name"], "# My own version\n")

    assert _edit(client, PLANNING_DOC["name"], "# My second version\n").status_code == 200

    documents = _detail(client)["requirements_files"]
    assert documents[0]["content"] == "# My second version\n"
    assert documents[1]["content"] == PLANNING_DOC["content"]


def test_the_edit_refuses_a_binary_document(client, mirror, store) -> None:
    """Bytes are replaced by uploading again, never by typing."""
    _post_bytes(client, "requirements.pdf", PDF_BYTES)

    response = _edit(client, "requirements.pdf", "# Typed over the bytes\n")

    assert response.status_code == 409
    assert response.json()["code"] == "requirements_file_has_no_text"
    assert _stored(mirror)["content"] == ""
    assert _stored(mirror)["storage_ref"].startswith("blob://")


def test_the_edit_refuses_a_body_over_the_cap(client, mirror) -> None:
    """256 KiB of UTF-8, the same cap the add route holds."""
    _upload(client, "notes.md", "# First\n")

    response = _edit(client, "notes.md", "a" * (256 * 1024 + 1))

    assert response.status_code == 413
    assert response.json()["code"] == "file_too_large"
    assert _stored(mirror)["content"] == "# First\n"


def test_an_edit_at_the_cap_passes(client, mirror) -> None:
    _upload(client, "notes.md", "# First\n")

    assert _edit(client, "notes.md", "a" * (256 * 1024)).status_code == 200


def test_the_edit_refuses_an_empty_body(client, mirror) -> None:
    _upload(client, "notes.md", "# First\n")

    response = _edit(client, "notes.md", "   \n")

    assert response.status_code == 422
    assert response.json()["code"] == "content_required"
    assert _stored(mirror)["content"] == "# First\n"


def test_the_edit_refuses_an_unknown_name(client, mirror) -> None:
    response = _edit(client, "nothing.md", "# Text\n")

    assert response.status_code == 404
    assert response.json()["code"] == "requirements_file_not_found"


def test_the_edit_refuses_an_unknown_definition(client, routed_db) -> None:
    response = _edit(client, "notes.md", "# Text\n")

    assert response.status_code == 404
    assert response.json()["code"] == "td_not_found"


def test_a_refused_edit_writes_no_journal_entry(client, mirror) -> None:
    _upload(client, "notes.md", "# First\n")

    _edit(client, "notes.md", "   \n")
    _edit(client, "nothing.md", "# Text\n")

    fields = [entry["field"] for entry in _entries(mirror)]
    assert fields == ["test_definition.requirements_file_added"]
