# The quarantine alert (FR-DM-004).
#
# The acceptance clause reads: "the file is quarantined (isolated), an alert is
# raised, and error details are logged". The quarantine and the error report
# already passed. Nothing raised an alert, and `api/api/services/alerts.py` is
# that alert now.
#
# The channel is a structured WARNING log line. No SMTP host and no webhook URL
# reaches this deployment, so a log rule and the Home needs-attention panel are
# the two things an operator really has. See the module docstring.
#
# The hard rule this file guards: the alert must NEVER fail the ingestion. The
# registry never drops a file, so a broken alert loses the alert and keeps the
# file.
#
# Style follows tests/test_files_quarantine.py.

import logging
import uuid

from api.services import alerts
from tests import factories
from tests.factories import upsert_run

files_db = factories.files_db

FILES = "/api/v1/files"


def _body(**overrides) -> dict:
    body = {
        "filename": "bat_cyc_20260814_0941.mf4",
        "run_id": "TAS-88214",
        "source_system": "TAS",
        "format": "MDF 4.10",
        "size_bytes": 1024,
        "checksum_sha256": uuid.uuid4().hex * 2,
        "checksum_state": "verified",
        "storage_ref": f"blob://test/{uuid.uuid4()}",
        "signals": [],
    }
    body.update(overrides)
    return body


def _post(client, **overrides):
    return client.post(FILES, json=_body(**overrides))


def _alert_lines(caplog) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if record.levelno == logging.WARNING
        and record.getMessage().startswith(alerts.ALERT_PREFIX)
    ]


def test_a_quarantined_file_raises_one_alert(client, files_db, caplog):
    # No run key is the second quarantine rule in contract order.
    with caplog.at_level(logging.WARNING, logger=alerts.logger.name):
        response = _post(client, run_id=None)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "quarantined"

    lines = _alert_lines(caplog)
    assert len(lines) == 1
    message = lines[0].getMessage()
    assert body["file_id"] in message
    assert "no run key" in message


def test_the_alert_names_the_checksum_mismatch(client, files_db, caplog):
    # The error detail rides the alert, so the line an operator reads says why.
    upsert_run(files_db)
    with caplog.at_level(logging.WARNING, logger=alerts.logger.name):
        response = _post(client, checksum_state="mismatch")

    assert response.json()["status"] == "quarantined"
    assert "checksum mismatch" in _alert_lines(caplog)[0].getMessage()


def test_a_registered_file_raises_no_alert(client, files_db, caplog):
    upsert_run(files_db)
    with caplog.at_level(logging.WARNING, logger=alerts.logger.name):
        response = _post(client)

    assert response.json()["status"] == "registered"
    assert _alert_lines(caplog) == []


def test_a_failed_alert_never_fails_the_quarantine(client, files_db, monkeypatch):
    """The ingestion path outranks the alert. A broken channel drops the alert."""

    def broken(*args, **kwargs):
        raise RuntimeError("the alert channel is down")

    monkeypatch.setattr(alerts.logger, "warning", broken)

    response = _post(client, run_id=None)

    assert response.status_code == 201, response.text
    file_id = response.json()["file_id"]
    stored = files_db["files"].find_one({"_id": file_id})
    assert stored is not None, "the never-drop rule keeps the file"
    assert stored["status"] == "quarantined"


def test_the_alert_carries_no_bearer_token(client, files_db, caplog):
    # A log line is read by more people than a request is. It names the file,
    # the run and the reason, and no credential.
    with caplog.at_level(logging.WARNING, logger=alerts.logger.name):
        _post(client, run_id=None)

    message = _alert_lines(caplog)[0].getMessage()
    assert "Bearer" not in message
    assert "token" not in message.lower()


# --- The in-app half of "an alert is raised" (FR-DM-004, UC-001 step 7) ------
#
# The log line above reaches an operator with a log rule. A person inside the
# application reads the topbar notification bell, and the bell reads the newest
# slice of `GET /journal` (`frontend/components/shell/notification-bell.tsx`).
# `POST /files` writes the file's journal entry BEFORE it raises the alert, so
# the quarantine already travels that path.
#
# The test below drives the whole chain: it quarantines a file, then reads the
# journal with the exact request the bell sends, and holds the entry to what
# the bell renders — the entity id it prints, the note it prints as the one
# summary line, and the entity type its link map turns into `/files/{id}`.

# The bell's request, verbatim: `BELL_FILTERS` in the component, which the
# client sends as `/journal?page=1&page_size=20`. It names no `since`, no
# `kind` and no `entity_type`, and it filters by time in the browser instead.
BELL_QUERY = {"page": 1, "page_size": 20}


def _bell_entries(client) -> list[dict]:
    """Read the journal the way the notification bell reads it."""
    response = client.get("/api/v1/journal", params=BELL_QUERY)
    assert response.status_code == 200, response.text
    return response.json()["items"]


def test_a_quarantined_file_reaches_the_notification_bell(client, files_db):
    """The bell shows the quarantine: which file, and why."""
    response = _post(client, run_id=None)
    assert response.status_code == 201, response.text
    file_id = response.json()["file_id"]

    entries = _bell_entries(client)

    # The bell prints the newest 20 and counts them all. The quarantine is in
    # that slice, so a person sees it without any filter of ours.
    matches = [entry for entry in entries if entry["entity_id"] == file_id]
    assert len(matches) == 1, "the quarantine writes exactly one journal entry"
    entry = matches[0]

    # `entriesOf` keeps an entry only when `id` and `entity_id` are strings.
    assert isinstance(entry["id"], str)
    assert isinstance(entry["entity_id"], str)

    # `journalEntityHref` maps this entity type to `/files/{entity_id}`, so the
    # row is a link to the quarantined file itself.
    assert entry["entity_type"] == "file"
    assert entry["kind"] == "event"
    assert entry["field"] == "file.registered"

    # `summaryOf` prints the note first, so the note is the one line the person
    # reads. It has to say why the file was quarantined.
    assert entry["note"] == "Quarantined: no run key."

    # `entryTime` parses `at`. An unparsable stamp reads as 0 and never counts.
    assert entry["at"] is not None


def test_the_bell_entry_names_the_checksum_mismatch(client, files_db):
    """The second quarantine rule reaches the bell with its own reason."""
    upsert_run(files_db)
    file_id = _post(client, checksum_state="mismatch").json()["file_id"]

    entry = next(e for e in _bell_entries(client) if e["entity_id"] == file_id)

    assert "checksum mismatch" in (entry["note"] or "")


def test_a_registered_file_says_nothing_about_quarantine(client, files_db):
    """A clean arrival still journals, and its line never says quarantined."""
    upsert_run(files_db)
    file_id = _post(client).json()["file_id"]

    entry = next(e for e in _bell_entries(client) if e["entity_id"] == file_id)

    assert entry["note"] == "Linked to run TAS-88214."
