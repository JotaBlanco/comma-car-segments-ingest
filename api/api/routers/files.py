"""Contract #12, #13, the ★ registration, the ★ download and the ★ manual link.

Owner: Lane B.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import StreamingResponse
from pymongo import ASCENDING, DESCENDING
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError, PyMongoError

from api.auth import journal_actor_or_id, require_token
from api.db import get_db
from api.errors import ApiError
from api.models.common import Pagination, Source, pagination_params
from api.models.files import (
    FileBody,
    FileDetail,
    FileInvalidFlagRequest,
    FileLifecycle,
    FileLifecycleRequest,
    FileListEnvelope,
    FilePage,
    FilePatchRequest,
    FileRegisterRequest,
    FileStatus,
    FileVersionRegisterRequest,
    SourceSystem,
)
from api.models.sorting import ResolvedSort, sort_params
from api.provenance import add_event, set_field
from api.quix_identity import Identity
from api.services import alerts, exports, queries_runs, queries_signals
from api.services.file_bytes import (
    FileBytesProvider,
    FileBytesUnavailable,
    content_disposition,
    get_file_bytes_provider,
)

router = APIRouter(tags=["files"])


# Contract §2.3: /files sort whitelist.
_files_sort = sort_params(
    whitelist=("registered_at", "size_bytes"),
    default_key="registered_at",
    default_directions={"registered_at": "desc", "size_bytes": "desc"},
)


@router.get("/files")
def list_files(
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params())],
    sort: Annotated[ResolvedSort, Depends(_files_sort)],
    status: Annotated[list[FileStatus] | None, Query()] = None,
    source_system: Annotated[list[SourceSystem] | None, Query()] = None,
    lifecycle: Annotated[list[FileLifecycle] | None, Query()] = None,
    run: str | None = None,
    unlinked: bool | None = None,
    invalid: bool | None = None,
    source: Annotated[list[Source] | None, Query()] = None,
    q: str | None = None,
) -> FilePage:
    """List the files from Mongo, newest registration first by default.

    Multi-value ``status``/``source_system``/``lifecycle`` via repeated params
    (§2.2). Sort by ``registered_at`` or ``size_bytes`` (§2.3). The q filter is
    word-AND over filename, checksum and run id: every word must appear in
    at least one of the three, in any order.

    A caller that names no ``lifecycle`` gets the plain table: the active
    files. A deleted file and an archived file both stay out of it, because
    both routes take the row off the daily table. ``lifecycle=deleted`` serves
    the recycle bin and ``lifecycle=archived`` serves the archive.

    ``source`` answers TR-011. It reads the ``field_sources`` map of the row,
    so a document matches when at least one of its fields carries one of the
    named tags. A document the server never tagged matches no source.

    ``invalid=true`` serves the files a person marked invalid, and
    ``invalid=false`` serves the rest. A caller that names neither gets both,
    because the mark hides no row. A file registered before 24 Aug 2026 holds
    no ``invalid`` key at all, and it counts as not flagged.
    """
    return queries_signals.list_files(
        db,
        pagination,
        sort_spec=sort.as_mongo(),
        status=status,
        source_system=source_system,
        run=run,
        unlinked=unlinked,
        invalid=invalid,
        source=[value.value for value in source or []],
        q=q,
        # The plain table is the active table (21 Aug 2026). The service's own
        # default only hid the deleted files, so an archived file stayed in
        # the list and the Archive button looked like it did nothing.
        lifecycle=lifecycle or ["active"],
    )


# This route must stay ABOVE ``GET /files/{file_id}``. FastAPI matches the
# routes in declaration order, so a later position would read "export" as a
# file id and answer 404.
@router.get("/files/export")
def export_files(
    request: Request,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    sort: Annotated[ResolvedSort, Depends(_files_sort)],
    columns: Annotated[list[str] | None, Query()] = None,
    status: Annotated[list[FileStatus] | None, Query()] = None,
    source_system: Annotated[list[SourceSystem] | None, Query()] = None,
    lifecycle: Annotated[list[FileLifecycle] | None, Query()] = None,
    run: str | None = None,
    unlinked: bool | None = None,
    invalid: bool | None = None,
    source: Annotated[list[Source] | None, Query()] = None,
    q: str | None = None,
) -> Response:
    """Stream the WHOLE filtered files list as CSV (FR-DM-043, export half).

    Every filter and both sort params are the ones ``GET /files`` takes, and
    they reach Mongo through the same ``files_query`` builder, so the file and
    the table hold the same rows in the same order. A caller that names no
    ``lifecycle`` exports the active files, exactly as the plain table shows
    them.

    ``columns`` repeats the header of each column the caller wants. None means
    every column. ``api/api/services/exports.py`` holds the list, the row cap
    and the audit rule.
    """
    return exports.csv_export(
        db,
        list_name="files",
        collection="files",
        query=queries_signals.files_query(
            status=status,
            source_system=source_system,
            run=run,
            unlinked=unlinked,
            invalid=invalid,
            source=[value.value for value in source or []],
            q=q,
            lifecycle=lifecycle or ["active"],
        ),
        sort=sort.as_mongo(),
        columns=columns,
        actor=journal_actor_or_id(identity, identity.display_name),
        filters=request.url.query,
    )


@router.get("/files/{file_id}")
def get_file(
    file_id: str,
    db: Annotated[Database, Depends(get_db)],
    signals_limit: Annotated[int, Query(ge=1)] = 200,
) -> FileDetail:
    """Serve the whole File-detail screen in one call.

    The ingestion timeline comes from the journal in chronological order.
    """
    return queries_signals.get_file_detail(db, file_id, signals_limit)


# The stage outcomes of one file (FR-DM-006b). The pipeline runs the sync, the
# upload and the conversion outside this repository and reports each outcome
# here. `stage_error` carries the error detail of a failed stage.
_STAGE_FIELDS = ("sync_status", "upload_status", "conversion_status", "stage_error")

# The patchable fields of a file. Every other field is refused, and the body
# model refuses it with 422 (`extra="forbid"`).
#
# The checksum, the size, the format and the checksum state are embedded facts
# about the bytes. The audit rests on them: the download route serves the
# checksum in a header, and a registered file replays on it. The status, the
# quarantine reason and the signal count are derived at the registry's door.
# The filename, the storage reference, the source system and the job id name
# the stored object and its producer, and the storage reference is the replay
# identity of a quarantined file.
_PATCHABLE_FIELDS = ("run_id", *_STAGE_FIELDS)

# The fields the bytes and the header of the file prove, so the registration
# tags every one of them `embedded` (TR-011). It tagged two until 24 Aug 2026,
# and the other six then read as "nobody recorded a source" although the file
# itself stated them.
#
# `run_id`, `status`, `quarantine_reason` and `signal_count` stay out. The
# registry derives those at its own door, so they are not the file's word. A
# stage outcome stays out for the same reason (`_derived_stages`).
_EMBEDDED_FIELDS = (
    "filename",
    "format",
    "source_system",
    "size_bytes",
    "checksum_sha256",
    "storage_ref",
    "time_start",
    "time_end",
    "vehicle",
)

# The quarantine reason a run link repairs. The registration writes this exact
# string, in the contract order (see `register_file_document`).
_MISSING_LINK_REASON = "no run key"

# The file detail serves this many signal rows, as GET /files/{file_id} does.
_DETAIL_SIGNALS_LIMIT = 200


def _leaves_quarantine(file_doc: dict) -> bool:
    """Report whether a run link ends this file's quarantine.

    `status` says whether the registry accepted the file. `quarantine_reason`
    names the ONE reason it refused, so a link repairs the file only when the
    missing link was that reason.

    A file with bad bytes keeps its quarantine. This route reads no byte, so it
    can say nothing about the bytes, and a metadata edit must never make a
    mismatched file look accepted. The reason and the checksum state both carry
    that verdict, so both close the door.
    """
    if file_doc.get("status") != "quarantined":
        return False
    if file_doc.get("checksum_state") == "mismatch":
        return False
    return file_doc.get("quarantine_reason") == _MISSING_LINK_REASON


def _lifecycle(file_doc: dict) -> str:
    """Read the lifecycle of a file. A document without the field is active.

    The field arrived on 20 Aug 2026. Every file registered before that day
    carries no value, and every one of them is active.
    """
    return file_doc.get("lifecycle") or "active"


def _load_file(db: Database, file_id: str) -> dict:
    """Read one file document, or refuse with 404."""
    file_doc = db["files"].find_one({"_id": file_id})
    if file_doc is None:
        raise ApiError(404, f"File {file_id} not found", "file_not_found")
    return file_doc


def _write_lifecycle(
    db: Database, file_doc: dict, value: str, event: str, actor: str, note: str | None
) -> None:
    """Move one file to a lifecycle value and journal the step.

    The write order copies `patch_file`: the document first, the journal entry
    second. This never reads a byte and never touches `storage_ref`, so the
    stored object stays exactly as it is.

    **The write is a compare-and-set** (21 Aug 2026). The three routes read the
    document, decide, and then write, and two presses of one button ran that
    read at the same time: both saw an active file, both wrote, and the journal
    kept two ``file.deleted`` rows for one delete. The filter names the
    lifecycle this call read, so the second write matches nothing and journals
    nothing. A stored document with no field matches ``None``, which is the
    same document `_lifecycle` reads as active.

    **The source tag comes from the provenance helper.** A raw ``$set`` wrote
    the value with no `field_sources` entry, so no screen could say who took
    the file off the table. The helper's own return value is a ``change`` row,
    and the timeline states one ``event`` row for this step, so this route
    keeps the field-source keys and drops the row — `register_file_document`
    drops its rows the same way.
    """
    file_id = file_doc["_id"]
    update: dict = {}
    set_field(
        update,
        "lifecycle",
        value,
        Source.MANUAL,
        actor,
        note=note,
        current_doc=file_doc,
        entity_type="file",
        entity_id=file_id,
        field_label="file.lifecycle",
    )
    update["updated_at"] = datetime.now(UTC)
    result = db["files"].update_one(
        {"_id": file_id, "lifecycle": file_doc.get("lifecycle")}, {"$set": update}
    )
    if result.modified_count == 0:
        # Another writer moved this file between the read and this write. It
        # journalled its own step, and a second entry would state a change
        # that never happened.
        return
    db["journal_entries"].insert_one(
        add_event("file", file_id, event, Source.MANUAL, actor, note=note)
    )


@router.patch("/files/{file_id}")
def patch_file(
    file_id: str,
    body: FilePatchRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> FileDetail:
    """Link one file to a run by hand, or report a stage outcome.

    A file that names no run is orphaned. The registration quarantines it with
    the reason "no run key" and keeps it, and the registry can no longer read
    the bytes, so it can no longer resolve the key by itself. A person states
    the link here, and the file leaves quarantine when the missing link was the
    reason it was refused.

    The pipeline reports a later stage outcome here too (FR-DM-006b):
    ``sync_status``, ``upload_status``, ``conversion_status`` and
    ``stage_error``. A body may state the stage fields alone. Each change
    carries the manual source and writes one journal entry, so a re-run
    conversion shows in the ingestion timeline. **A stage outcome never ends a
    quarantine.** Only a ``run_id`` change reaches the promotion path.

    Errors:

    * ``400 no_fields_to_update`` — the body states no field. A field sent as
      null counts as absent, so this route never clears a value.
    * ``404 file_not_found`` — the id names no file document.
    * ``409 file_deleted`` / ``409 file_archived`` — the file left the active
      table. A person restores it first, then edits it. The route writes
      nothing (20 Aug 2026).
    * ``422 unknown_run`` — no test_runs row holds the stated id. The manual
      run link (contract §B #4) refuses an unknown id the same way.
    * ``409 checksum_already_registered`` — a registered file already holds
      this checksum, so the promotion would mint a second one. The file keeps
      its quarantine and the route writes nothing.
    """
    # A field sent as null counts as absent, as PATCH /test-runs does.
    changes = {
        key: value
        for key, value in body.model_dump(exclude_unset=True, exclude_none=True).items()
        if key in _PATCHABLE_FIELDS
    }
    if not changes:
        raise ApiError(400, "no fields to update", "no_fields_to_update")

    file_doc = _load_file(db, file_id)
    # An edit belongs to the active table. A file a person deleted or archived
    # is out of that table, so the route refuses before it writes anything.
    lifecycle = _lifecycle(file_doc)
    if lifecycle != "active":
        code = "file_deleted" if lifecycle == "deleted" else "file_archived"
        raise ApiError(
            409,
            f"File {file_id} is {lifecycle}. Restore it before you edit it.",
            code,
        )

    actor = journal_actor_or_id(identity, body.actor)
    update: dict = {}
    entries: list[dict] = []
    # A file quarantined for "no run key" KEEPS the key it could not resolve,
    # so a person may repair it by stating the same id after the run lands.
    # An unchanged id therefore writes no link and still ends the quarantine.
    old_run_id = file_doc.get("run_id")
    run_id = changes.get("run_id")
    relinked = "run_id" in changes
    if relinked:
        if db["test_runs"].find_one({"_id": run_id}, {"_id": 1}) is None:
            raise ApiError(422, f"No run {run_id} is registered here", "unknown_run")
        if old_run_id != run_id:
            entry = set_field(
                update,
                "run_id",
                run_id,
                Source.MANUAL,
                actor,
                note=body.note,
                # The run's journal unions the entries that name it as the
                # context, so the run timeline shows the file that joined it.
                context_run_id=run_id,
                current_doc=file_doc,
                entity_type="file",
                entity_id=file_id,
                field_label="file.run",
            )
            if entry is not None:
                entries.append(entry)
        if _leaves_quarantine(file_doc):
            # Derived, never stated: the two values follow the link the way the
            # registration derives them from the body. So they carry no source
            # tag.
            update["status"] = "registered"
            update["quarantine_reason"] = None
            entries.append(
                add_event(
                    "file",
                    file_id,
                    "file.unquarantined",
                    Source.MANUAL,
                    actor,
                    note=f"Linked to run {run_id}. The file leaves quarantine.",
                )
            )
    # A stage outcome states what the pipeline did to the bytes elsewhere. It
    # reaches no quarantine rule and no promotion, so it stays out of the block
    # above. Only a run link repairs a file.
    for field in _STAGE_FIELDS:
        if field not in changes:
            continue
        if file_doc.get(field) == changes[field]:
            # The pipeline reported this outcome before. Nothing changed, so
            # nothing is written and the timeline states no change. A repeated
            # report used to journal "success → success" (21 Aug 2026).
            # `PATCH /signals/{name}` skips an unchanged field the same way.
            continue
        entry = set_field(
            update,
            field,
            changes[field],
            Source.MANUAL,
            actor,
            note=body.note,
            current_doc=file_doc,
            entity_type="file",
            entity_id=file_id,
            field_label=f"file.{field}",
        )
        if entry is not None:
            entries.append(entry)
    if not update:
        # The file already names this run and it holds no repairable
        # quarantine. Nothing changed, so nothing is written or journalled.
        return queries_signals.get_file_detail(db, file_id, _DETAIL_SIGNALS_LIMIT)
    update["updated_at"] = datetime.now(UTC)

    try:
        db["files"].update_one({"_id": file_id}, {"$set": update})
    except DuplicateKeyError as error:
        # One registered file per checksum. The quarantined file stays as it
        # is, which keeps the never-drop rule.
        raise ApiError(
            409,
            f"A registered file already holds the checksum of {file_id}",
            "checksum_already_registered",
        ) from error

    if relinked:
        # The inventory rows follow the file. `run_facts` counts a run's
        # signals from these rows, so a row left behind would count on the old
        # run for ever.
        db["file_signals"].update_many(
            {"file_id": file_id}, {"$set": {"run_id": run_id}}
        )
    if entries:
        db["journal_entries"].insert_many(entries)

    if relinked:
        # Both runs re-derive their counts AND their time windows. The rollup
        # reads `run_facts` and the run's files, and writes no count and no
        # time of its own, so both stored windows follow the rows this route
        # moved. The old run drops the times of the file it no longer holds.
        #
        # A stage-only patch moves no row and changes no count, so it runs no
        # rollup.
        stored = db["files"].find_one({"_id": file_id})
        queries_runs.apply_file_rollup(db, run_id, stored)
        if old_run_id is not None and old_run_id != run_id:
            queries_runs.apply_file_rollup(db, old_run_id, stored)
    return queries_signals.get_file_detail(db, file_id, _DETAIL_SIGNALS_LIMIT)


@router.delete("/files/{file_id}")
def delete_file(
    file_id: str,
    body: FileLifecycleRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> FileDetail:
    """Delete one file from the table, and keep every byte (20 Aug 2026).

    This is a soft delete. The route writes ``lifecycle: "deleted"`` on the
    document and nothing else. It never calls the bytes provider and never
    touches ``storage_ref``, so the stored object stays where it is.

    **The retention purge empties the bin** (FR-DM-042). A file that stays
    deleted for ``TM_FILE_RETENTION_DAYS`` days loses its registry record: the
    ``files`` document and its ``file_signals`` rows go, the journal keeps a
    ``file.purged`` entry, and the stored object still stays. A restore before
    that day stops the purge. See ``api/api/services/retention.py``.

    The file leaves the plain ``GET /files`` table and it answers 410 on the
    download. It stays on its run, so no reference dangles. A restore brings
    it back with the same ``status``.

    A repeat is idempotent: a deleted file answers 200 and the route writes
    nothing, so the journal keeps one ``file.deleted`` entry.

    Errors: ``404 file_not_found`` — the id names no file document.
    """
    file_doc = _load_file(db, file_id)
    if _lifecycle(file_doc) != "deleted":
        _write_lifecycle(
            db,
            file_doc,
            "deleted",
            "file.deleted",
            journal_actor_or_id(identity, body.actor),
            body.note,
        )
    return queries_signals.get_file_detail(db, file_id, _DETAIL_SIGNALS_LIMIT)


@router.post("/files/{file_id}/archive")
def archive_file(
    file_id: str,
    body: FileLifecycleRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> FileDetail:
    """Move one file out of the daily table and keep it whole (20 Aug 2026).

    An archived file keeps every byte and it still downloads. Only the table
    changes: ``GET /files`` shows it under ``lifecycle=archived``, and an edit
    refuses with 409 until a person restores it.

    A repeat is idempotent: an archived file answers 200 and writes nothing.

    Errors:

    * ``404 file_not_found`` — the id names no file document.
    * ``409 file_deleted`` — the file is deleted. A person restores it first.
    """
    file_doc = _load_file(db, file_id)
    lifecycle = _lifecycle(file_doc)
    if lifecycle == "deleted":
        raise ApiError(
            409,
            f"File {file_id} is deleted. Restore it before you archive it.",
            "file_deleted",
        )
    if lifecycle != "archived":
        _write_lifecycle(
            db,
            file_doc,
            "archived",
            "file.archived",
            journal_actor_or_id(identity, body.actor),
            body.note,
        )
    return queries_signals.get_file_detail(db, file_id, _DETAIL_SIGNALS_LIMIT)


@router.post("/files/{file_id}/restore")
def restore_file(
    file_id: str,
    body: FileLifecycleRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> FileDetail:
    """Bring one archived or deleted file back to the table (20 Aug 2026).

    The route writes ``lifecycle: "active"`` and nothing else. **It never
    touches ``status``**, so a quarantined file restores to quarantined. A
    restore says nothing about the bytes, so it can never promote a file.

    A repeat is idempotent: an active file answers 200 and writes nothing.

    Errors: ``404 file_not_found`` — the id names no file document.
    """
    file_doc = _load_file(db, file_id)
    if _lifecycle(file_doc) != "active":
        _write_lifecycle(
            db,
            file_doc,
            "active",
            "file.restored",
            journal_actor_or_id(identity, body.actor),
            body.note,
        )
    return queries_signals.get_file_detail(db, file_id, _DETAIL_SIGNALS_LIMIT)


def _invalid(file_doc: dict) -> dict:
    """Read the invalid block of a file. A document without the field is clear.

    The field arrived on 24 Aug 2026. Every file registered before that day
    carries no value, and none of them is flagged.
    """
    return file_doc.get("invalid") or {}


def _write_invalid_flag(
    db: Database, file_doc: dict, flagged: bool, reason: str, actor: str
) -> None:
    """Store one side of the file's invalid flag and journal the judgment.

    This is `queries_runs._write_flag`, read at file level. The stored block
    holds who judged the file, why and when, the provenance helper stamps the
    write `manual`, and the journal entry carries the flag state rather than
    the block, because a block reads badly in a timeline.

    **It touches the file and nothing else.** It never re-derives `status`, it
    never counts the file out of a rollup, and it never reaches the run. A run
    is invalid when a person marks the RUN invalid, through
    `POST /test-runs/{run_id}/invalid-flag`. The two marks are separate
    judgments, so one file of ten cannot condemn a whole run by itself.
    """
    file_id = file_doc["_id"]
    now = datetime.now(UTC)
    invalid = {
        "flagged": flagged,
        "reason": reason if flagged else None,
        "actor": actor if flagged else None,
        "at": now if flagged else None,
    }

    update: dict = {}
    entry = set_field(
        update,
        "invalid",
        invalid,
        Source.MANUAL,
        actor,
        note=reason,
        current_doc=file_doc,
        entity_type="file",
        entity_id=file_id,
        field_label="file.invalid_flag",
    )
    update["updated_at"] = now
    db["files"].update_one({"_id": file_id}, {"$set": update})

    # Contract #5 shows the flag state in the timeline: false → true, and back.
    entry["old"] = "true" if not flagged else "false"
    entry["new"] = "true" if flagged else "false"
    db["journal_entries"].insert_one(entry)


@router.post("/files/{file_id}/invalid-flag")
def flag_file_invalid(
    file_id: str,
    body: FileInvalidFlagRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> FileDetail:
    """Mark one file invalid (24 Aug 2026). A repeat answers 409.

    The mark is a judgment about the data, so it needs a reason and an actor,
    and the registry records both. A blank reason answers 422
    `reason_required`.

    The file keeps every byte, it keeps its place in the table and it still
    downloads. `status` never changes, so a quarantined file stays quarantined
    and a registered file stays registered. **The run never changes either.**

    Errors:

    * ``404 file_not_found`` — the id names no file document.
    * ``409 already_flagged`` — the file already carries the mark, and the
      first reason is the one a reader must see.
    """
    file_doc = _load_file(db, file_id)
    if _invalid(file_doc).get("flagged"):
        raise ApiError(
            409, f"File {file_id} is already flagged invalid", "already_flagged"
        )
    _write_invalid_flag(
        db,
        file_doc,
        flagged=True,
        reason=body.reason.strip(),
        actor=journal_actor_or_id(identity, body.actor),
    )
    return queries_signals.get_file_detail(db, file_id, _DETAIL_SIGNALS_LIMIT)


@router.delete("/files/{file_id}/invalid-flag")
def clear_file_invalid(
    file_id: str,
    body: FileInvalidFlagRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> FileDetail:
    """Undo the invalid mark on one file. The reason stays required.

    A rehearsal needs the way back, and the clear is a judgment as well, so the
    journal keeps both halves and both reasons.

    Errors:

    * ``404 file_not_found`` — the id names no file document.
    * ``409 not_flagged`` — the file carries no mark.
    """
    file_doc = _load_file(db, file_id)
    if not _invalid(file_doc).get("flagged"):
        raise ApiError(409, f"File {file_id} is not flagged invalid", "not_flagged")
    _write_invalid_flag(
        db,
        file_doc,
        flagged=False,
        reason=body.reason.strip(),
        actor=journal_actor_or_id(identity, body.actor),
    )
    return queries_signals.get_file_detail(db, file_id, _DETAIL_SIGNALS_LIMIT)


# How many times a version upload re-reads the newest version after a lost
# race. The result version chain keeps the same budget
# (`api/api/routers/results.py`).
VERSION_RETRIES = 5


def _version_group(file_doc: dict) -> str:
    """Name the chain one file belongs to.

    A document without `version_group` is the root of its own chain. Every
    file registered before 20 Aug 2026 carries no value, and each one is a
    root.
    """
    return file_doc.get("version_group") or file_doc["_id"]


def _group_query(group_id: str) -> dict:
    """Match every version of one chain. The root carries no group field."""
    return {"$or": [{"_id": group_id}, {"version_group": group_id}]}


def _version_of(file_doc: dict) -> int:
    """Read the version number. A document without the field is version 1."""
    return file_doc.get("version") or 1


def _latest_version(db: Database, group_id: str) -> dict:
    """Read the newest version of one chain.

    Mongo sorts a missing field below every number, so a root document with no
    `version` never outranks a real version. The root always answers, so the
    caller never handles a None.
    """
    return db["files"].find_one(_group_query(group_id), sort=[("version", DESCENDING)])


def _is_version_race(error: DuplicateKeyError) -> bool:
    """Report whether a duplicate key names the version chain index.

    Two writers computed the same next number, so the loser reads the chain
    again. Every other duplicate key on this collection names the checksum
    index, and that one is a real refusal.
    """
    return "version_group" in ((error.details or {}).get("keyPattern") or {})


@router.post("/files/{file_id}/versions", status_code=201)
def register_file_version(
    file_id: str,
    body: FileVersionRegisterRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    response: Response,
) -> FileBody:
    """Upload a new version of a registered file (FR-DM-103, 20 Aug 2026).

    Every version is a whole file document: its own id, its own checksum, its
    own storage reference, its own journal and its own download. So a version
    overwrites no byte and no record, and every earlier version stays.
    ``GET /files/{file_id}/versions`` serves the history.

    The caller may name any version of the chain. The route resolves the chain
    and appends to the end of it.

    A body with the checksum of the newest version replays: the route answers
    **200** with that version and writes nothing, so a retry after a dropped
    answer mints no phantom version. A **blank** checksum claims nothing about
    the bytes, so it never replays. It mints a new version.

    A body that names no run inherits the run of the newest version. A version
    of a run's file belongs to that run.

    The quarantine rules apply unchanged. A version with a checksum mismatch
    quarantines and still joins the chain. The route never drops a file.

    Errors:

    * ``404 file_not_found`` — the id names no file document.
    * ``409 file_deleted`` / ``409 file_archived`` — the named file left the
      active table. A person restores it before they upload a version.
    * ``409 checksum_already_registered`` — a registered file already holds
      this checksum, so it belongs to another file or to an older version of
      this chain. The route writes nothing.
    * ``409 version_conflict`` — parallel writes held the next version number
      for every retry.
    """
    anchor = _load_file(db, file_id)
    # A version joins the active table. A file a person deleted or archived is
    # out of that table, so the route refuses before it writes anything.
    lifecycle = _lifecycle(anchor)
    if lifecycle != "active":
        code = "file_deleted" if lifecycle == "deleted" else "file_archived"
        raise ApiError(
            409,
            f"File {file_id} is {lifecycle}. Restore it before you add a version.",
            code,
        )

    group_id = _version_group(anchor)
    head = _latest_version(db, group_id)
    head_lifecycle = _lifecycle(head)
    if head_lifecycle != "active":
        # The chain grows on its HEAD. Naming an active OLDER version while
        # the newest sits in the recycle bin used to mint a version behind
        # that head's back (25 Aug 2026 deep review).
        code = "file_deleted" if head_lifecycle == "deleted" else "file_archived"
        raise ApiError(
            409,
            f"The newest version of this chain ({head['_id']}) is "
            f"{head_lifecycle}. Restore it before you add a version.",
            code,
        )
    actor = journal_actor_or_id(identity, body.actor)
    for _ in range(VERSION_RETRIES):
        latest = _latest_version(db, group_id)
        if body.checksum_sha256 and latest.get("checksum_sha256") == body.checksum_sha256:
            # The newest version already carries these bytes. Answer it and
            # write nothing: no document, no journal entry, no rollup.
            response.status_code = 200
            return latest
        version = _version_of(latest) + 1
        # A null run counts as absent, as it does on PATCH /files/{file_id}.
        request = (
            body
            if body.run_id is not None
            else body.model_copy(update={"run_id": latest.get("run_id")})
        )
        try:
            doc, _created = register_file_document(
                db,
                request,
                actor=actor,
                extra={
                    "version": version,
                    "supersedes": latest["_id"],
                    "version_group": group_id,
                },
                check_replay=False,
                raise_on_duplicate=True,
            )
            break
        except DuplicateKeyError as error:
            if _is_version_race(error):
                # A parallel upload took this number. Read the chain again.
                continue
            raise ApiError(
                409,
                f"A registered file already holds the checksum of this version of {file_id}",
                "checksum_already_registered",
            ) from error
    else:
        raise ApiError(
            409, "another write holds this file version", "version_conflict"
        )

    # The registration wrote `file.registered` for the new file. This second
    # entry names the chain, so the file timeline says where the version came
    # from. A person uploaded it, so the source is `manual`.
    note = f"Version {version} supersedes file {latest['_id']}."
    if body.note:
        note = f"{note} {body.note}"
    db["journal_entries"].insert_one(
        add_event(
            "file",
            doc["_id"],
            "file.version_registered",
            Source.MANUAL,
            actor,
            note=note,
        )
    )
    return doc


@router.get("/files/{file_id}/versions")
def list_file_versions(
    file_id: str,
    db: Annotated[Database, Depends(get_db)],
) -> FileListEnvelope:
    """List every version of one file, oldest first (20 Aug 2026).

    The caller may name any version of the chain, and each one serves the same
    history. The rows use the list body of §12, so each one carries its own
    checksum, status, lifecycle and version number.

    **Every lifecycle shows.** A deleted version stays in the list, because the
    history is the audit trail of the file and a gap in it would hide a step.
    The plain ``GET /files`` table still hides a deleted file.

    Errors: ``404 file_not_found`` — the id names no file document.
    """
    group_id = _version_group(_load_file(db, file_id))
    items = list(
        db["files"]
        .find(_group_query(group_id))
        # Mongo sorts a missing `version` below every number, so a root
        # registered before 20 Aug 2026 leads its own chain.
        .sort([("version", ASCENDING), ("registered_at", ASCENDING)])
    )
    return {"items": items, "total": len(items)}


@router.get("/files/{file_id}/download")
def download_file(
    file_id: str,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    bytes_provider: Annotated[FileBytesProvider, Depends(get_file_bytes_provider)],
) -> Response:
    """Stream one file's bytes to the caller (contract v1.1 §D — file download).

    The audit rule the design note calls **audit-before-bytes**: the server
    writes a ``file.downloaded`` journal event **before** the first byte
    leaves. If the audit write fails, the route refuses with 503 and no byte
    moves. Bytes never move without a trace (see
    ``plans/design/FILE-DOWNLOAD.md`` §6 and ``plans/AGENT-RULES.md:118``).

    Errors:

    * ``404 file_not_found`` — the id does not match a registered file doc.
    * ``410 file_deleted`` — a person deleted the file. The bytes are still in
      the store, and a restore opens the download again (20 Aug 2026). An
      archived file downloads as normal.
    * ``403 not_allowed`` — the file is quarantined. Demo grants no exception
      to a viewer or an engineer (design note §7 open item; the provisional
      contract shape in ``API-CONTRACT-v1.1-proposed.md`` §D closes it as
      "quarantined files do not download in the demo, for anyone").
    * ``503 storage_unreachable`` — the local stack has no SAG blob storage
      bound, so the bytes cannot be reached. The audit journal entry is
      **not** written in this case: the design note forbids fabricating a
      trace for a byte stream that never started.
    * ``503 not_ready`` — the audit journal write failed. No bytes move.
    """
    file_doc = _load_file(db, file_id)

    # A deleted file serves no byte. The check stands before the provider call
    # and before the journal write, so a refusal moves nothing and records
    # nothing. An archived file downloads as normal.
    if _lifecycle(file_doc) == "deleted":
        raise ApiError(
            410,
            f"File {file_id} is deleted. Restore it before you download it.",
            "file_deleted",
        )

    if file_doc.get("status") == "quarantined":
        # The demo rule: quarantined files never download, for anyone. The
        # engineer-with-Update exception is post-demo (design note §7,
        # contract §D box).
        raise ApiError(
            403,
            f"File {file_id} is quarantined and cannot be downloaded",
            "not_allowed",
        )

    if not file_doc.get("storage_ref"):
        # This registry holds no bytes for the file — a logical file minted by
        # the signals facade, or a registration without a ref. That is a
        # healthy stack, not an outage: it answered 503 storage_unreachable
        # until 25 Aug 2026, while the results route modelled the same state
        # as its 409. No journal entry either — nothing was downloaded.
        raise ApiError(
            409, f"File {file_id} has no stored bytes", "file_has_no_bytes"
        )

    # Reach for the bytes FIRST — before the journal write — so a
    # storage-unreachable failure never leaves a fake trace behind. The stream
    # itself must not have started yet: `provider.open` returns an iterator, not
    # bytes, so the file handle stays open at Content-Length time only.
    try:
        stream, size = bytes_provider.open(file_doc.get("storage_ref"))
    except FileBytesUnavailable as error:
        # Never invent bytes. The design note (§13 open item, §6 audit rule) is
        # explicit that a missing backend must answer 503, not 200.
        raise ApiError(503, error.detail, "storage_unreachable") from error

    # Audit-before-bytes. The `journal_actor` helper resolves a verified caller
    # over any body-supplied name. The static-token demo path names the token
    # holder, which is the demo actor convention (§D box).
    #
    # A person pressed Download, so the source is `manual`. The file carried
    # no such event, so `embedded` would name the wrong origin.
    actor = journal_actor_or_id(identity, identity.display_name)
    event = add_event(
        entity_type="file",
        entity_id=file_id,
        field="file.downloaded",
        source=Source.MANUAL,
        actor=actor,
        note=f"Downloaded {file_doc.get('filename')} ({size} bytes)",
    )
    try:
        db["journal_entries"].insert_one(event)
    except PyMongoError as error:
        # Audit-before-bytes forbids the download without a recorded trace.
        # Close the stream on the way out so no file handle leaks. `stream` is
        # a plain generator with no explicit `close` on the file, but calling
        # `.close()` on a generator triggers a GeneratorExit that runs the
        # `with path.open` cleanup.
        stream.close()
        raise ApiError(
            503,
            "the download event could not be recorded — refusing to serve bytes",
            "not_ready",
        ) from error

    filename = file_doc.get("filename") or file_id
    checksum = file_doc.get("checksum_sha256") or ""
    headers = {
        "Content-Disposition": content_disposition(filename),
        "Content-Length": str(size),
        # A non-standard header lets the FE surface "checksum verified" without
        # a second call. The value is the canonical checksum on the file doc.
        "X-Checksum-SHA256": checksum,
        # The registry's verdict on those bytes: `verified`, `unverified` or
        # `mismatch`. The digest alone proves nothing — the ingestion pipeline
        # registers real `unverified` files, and their digest is the producer's
        # claim, not a check anybody ran. So the front end reads this word, and
        # it says "checksum verified" for `verified` alone (21 Aug 2026).
        "X-Checksum-State": file_doc.get("checksum_state") or "unverified",
        # The audit id is a stable correlation handle. An operator who reads
        # the journal after a support ticket walks from the id to the entry.
        "X-Journal-Id": event["_id"],
        # Do not let a proxy cache a per-user download.
        "Cache-Control": "no-store",
    }
    return StreamingResponse(
        stream, media_type="application/octet-stream", headers=headers
    )


def _existing_registered(db: Database, checksum: str, run_id: str | None) -> dict | None:
    """Find the registered file that already carries this checksum ON THIS RUN.

    Identity is (run, checksum) since 24 Aug 2026: a redelivery of the same
    bytes to the same run replays, and the same bytes declared for a NEW run
    register fresh — re-running a known recording is normal test-platform
    work. A blank checksum makes no claim about the bytes, so it identifies
    nothing. It must never fold a second file into the first. The quarantined
    path learned this already; the registered path lost the second file until
    21 Aug 2026.
    """
    if not checksum:
        return None
    return db["files"].find_one(
        {"checksum_sha256": checksum, "status": "registered", "run_id": run_id}
    )


def _existing_quarantined(db: Database, storage_ref: str | None, checksum: str) -> dict | None:
    """Find the quarantined file that already holds this stored object.

    The checksum identifies a registered file. It cannot identify a
    quarantined one: an object the watcher could not read registers with an
    empty checksum, so a checksum key folds every unreadable object into one
    document. That is the silent loss the never-drop rule forbids.

    The storage reference names exactly one object in the store, so it is the
    identity of a replay. The stored checksum must agree with the posted one,
    or be empty. An empty stored checksum makes no claim about the bytes, so
    the recovery read of the same object resolves here. A different stored
    checksum means the key carries new bytes, and those bytes get their own
    document.

    A body with no storage reference names no object, so it always mints.
    """
    if not storage_ref:
        return None
    return db["files"].find_one(
        {
            "storage_ref": storage_ref,
            "status": "quarantined",
            "$or": [{"checksum_sha256": ""}, {"checksum_sha256": checksum}],
        }
    )


@router.post("/files", status_code=201)
def register_file(
    body: FileRegisterRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    response: Response,
) -> FileBody:
    """Register one file in Mongo (appendix ★).

    The quarantine rules apply in contract order. The route never drops a
    file, and it writes the file.registered journal event for every file.
    A replay returns 200 with the existing body and writes nothing, except
    when the stored file holds no signal inventory and the replay carries one
    — see `_fill_empty_inventory`. A
    registered file replays on its (run, checksum) — the same bytes declared
    for a different run register fresh (24 Aug 2026). A quarantined file replays on its
    storage reference, because an unreadable object carries no checksum. Each
    registration updates the run rollups. Every registered file also feeds its
    signal inventory into file_signals and the signal catalogue. A quarantined
    file feeds neither.

    **The journal names who registered the file** (21 Aug 2026). The route
    wrote the actor "ingestion" for every caller, so a person who registered a
    file by hand disappeared behind the pipeline's name. The route reads the
    caller now, and `auth.journal_actor` decides: the platform path names the
    person the Portal proved, and the shared-token path keeps "ingestion". The
    ingestion pipeline holds that shared token on purpose, so its own calls
    record exactly what they recorded before.

    **The registration derives the stage values it can prove** (21 Aug 2026,
    FR-DM-006b). A stated value wins, and a stage the body does not support
    stays null. See `_derived_stages` for the rule of each one.
    """
    doc, created = register_file_document(db, body, actor=journal_actor_or_id(identity, "ingestion"))
    if not created:
        response.status_code = 200
    return doc


# What a derived sync failure says. The registry never saw the bytes, so it
# reports the producer's verdict and claims nothing of its own.
_CHECKSUM_STAGE_ERROR = "the producer reported a checksum mismatch"


def _derived_stages(body: FileRegisterRequest) -> dict:
    """Say what the registration itself proves about the three stages.

    **Added 21 Aug 2026 (FR-DM-006b).** The four stage fields exist on the
    model and on the screen, and no producer sets them. The pipeline states
    none of them and nothing calls `PATCH /files/{file_id}`, so a stage that
    never reported looked exactly like a stage still running. Every value
    below comes from a fact the body already carries.

    **Each rule states what the data supports, and no rule guesses.** A stage
    this cannot decide stays absent, so the screen reads it as unknown.

    * **`sync_status` reads `checksum_state`.** The sync stage moves the bytes
      and proves them. `verified` means two digests agreed, so the stage
      succeeded. `mismatch` means they disagreed, so it failed, and
      `stage_error` then names that verdict. `unverified` means nobody
      compared anything, which is no report at all, so it stays absent.
    * **`upload_status` reads `storage_ref`.** A reference names a stored
      object, so the upload placed the bytes. **An absent reference stays
      absent**: it cannot tell a failed upload from an upload nobody ran, and
      a registration may legitimately carry no object.
    * **`conversion_status` reads the signal inventory.** Nobody lists the
      channels of a file they did not decode, so a body that carries signals
      proves the conversion ran. **An empty list stays absent**: a file may
      hold no channel, the producer may send the inventory later, or the
      decode may have failed, and these three are not the same fact.
    * **A failed conversion is the producer's to report.** The registry holds
      no decode error of its own, so it derives no conversion failure.

    A stated value always wins, and a stated `sync_status` also drops the
    derived `stage_error`: a derived detail must never describe a failure the
    producer denies.

    The quarantine order does not change. These values reach no quarantine
    rule and no promotion, exactly as a stated stage value does not.
    """
    derived: dict = {}
    if body.checksum_state == "verified":
        derived["sync_status"] = "success"
    elif body.checksum_state == "mismatch":
        derived["sync_status"] = "failed"
        derived["stage_error"] = _CHECKSUM_STAGE_ERROR
    if body.storage_ref:
        derived["upload_status"] = "success"
    if body.signals:
        derived["conversion_status"] = "success"
    if body.sync_status is not None:
        derived.pop("stage_error", None)
    return derived


def _stage_values(body: FileRegisterRequest, derive: bool) -> dict:
    """The four stage fields the new document carries. A stated value wins."""
    derived = _derived_stages(body) if derive else {}
    return {
        field: stated if (stated := getattr(body, field)) is not None else derived.get(field)
        for field in _STAGE_FIELDS
    }


def _fill_empty_inventory(db: Database, file_doc: dict, signals: list) -> dict:
    """Give a registered file the inventory its first registration lacked.

    A replay writes nothing, which is what makes a redelivery idempotent, and
    this is the one exception. A file first registered from a decode that
    produced no channel holds no inventory; the decode that later finds the
    channels replays on (run, checksum), and its inventory used to be dropped
    (25 Sep 2026: the DBC was absent from DCM at 09:05 and restored at 09:18,
    and all four traces stayed at zero signals).

    The fill runs into an EMPTY inventory only. A replay carrying a different,
    non-empty inventory for a file that already holds one is a conflict and
    not a hole: two decodes of the same bytes disagree, and the stored
    inventory stays so that the disagreement remains visible.
    """
    if not signals or file_doc.get("status") != "registered":
        return file_doc
    if db["file_signals"].find_one({"file_id": file_doc["_id"]}, {"_id": 1}) is not None:
        return file_doc

    queries_signals.upsert_file_signals(db, file_doc, signals)
    # The same count the registration writes: the inventory keys on
    # (file_id, name), so a repeated name stores one row.
    count = len({signal.name for signal in signals})
    now = datetime.now(UTC)
    db["files"].update_one(
        {"_id": file_doc["_id"]}, {"$set": {"signal_count": count, "updated_at": now}}
    )
    filled = {**file_doc, "signal_count": count, "updated_at": now}
    # The rows are stored, so the rollup re-derives the run's signal_count
    # from them exactly as it does on a first registration.
    queries_runs.apply_file_rollup(db, file_doc["run_id"], filled)
    return filled


def register_file_document(
    db: Database,
    body: FileRegisterRequest,
    actor: str = "ingestion",
    extra: dict | None = None,
    check_replay: bool = True,
    raise_on_duplicate: bool = False,
    derive_stages: bool = True,
) -> tuple[dict, bool]:
    """The one registration path. Return the file document and whether this
    call created it.

    POST /files rides it, and so does the POST /test-runs/{run_id}/signals
    facade and POST /files/{file_id}/versions — a second path would let them
    disagree about quarantine, the journal or the rollups. ``actor`` names who
    registered the file in the journal event and the field sources; the
    ingestion path keeps "ingestion".

    Three keyword arguments serve the version route (20 Aug 2026):

    * ``extra`` writes more fields on the new document. The version route
      states ``version``, ``supersedes`` and ``version_group`` this way.
    * ``check_replay`` off skips the replay lookup. A version chain replays on
      the checksum of its newest version, which its own route decides, so the
      registered-and-quarantined lookup here would answer the wrong question.
    * ``raise_on_duplicate`` on re-raises the ``DuplicateKeyError`` instead of
      reading the winning row. The version route reads the index name from it:
      a lost version race retries, a duplicate checksum answers 409.

    ``derive_stages`` off stores the four stage fields exactly as the body
    states them (21 Aug 2026). ``POST /test-runs/{run_id}/signals`` passes it:
    that route mints a LOGICAL file from an API submission, no pipeline stage
    ran over it, and its file serves null for all four. Every physical
    registration derives what it can — see ``_derived_stages``.
    """
    replay = None
    if check_replay:
        replay = _existing_registered(
            db, body.checksum_sha256, body.run_id
        ) or _existing_quarantined(db, body.storage_ref, body.checksum_sha256)
    if replay is not None:
        return _fill_empty_inventory(db, replay, body.signals), False

    known_run = body.run_id is not None and (
        db["test_runs"].find_one({"_id": body.run_id}, {"_id": 1}) is not None
    )
    if body.checksum_state == "mismatch":
        status, reason = "quarantined", "checksum mismatch"
    elif not known_run:
        status, reason = "quarantined", "no run key"
    elif body.quarantine_reason is not None:
        status, reason = "quarantined", body.quarantine_reason
    else:
        status, reason = "registered", None

    # Mongo keeps milliseconds and Python keeps microseconds. Truncate here,
    # or the 201 body carries a timestamp the collection never stored and the
    # replay returns a different one.
    stamp = datetime.now(UTC)
    now = stamp.replace(microsecond=stamp.microsecond // 1000 * 1000)
    doc = {
        "_id": f"f-{uuid.uuid4()}",
        "filename": body.filename,
        "run_id": body.run_id,
        "source_system": body.source_system,
        "format": body.format,
        "size_bytes": body.size_bytes,
        "checksum_sha256": body.checksum_sha256,
        "checksum_state": body.checksum_state,
        "status": status,
        "quarantine_reason": reason,
        # The stage outcomes (FR-DM-006b). The pipeline states what it knows
        # and the registration derives the rest from the facts of this body.
        # A field neither side supports stays None, which reads as "no stage
        # report arrived". See `_derived_stages`.
        **_stage_values(body, derive_stages),
        "storage_ref": body.storage_ref,
        "vehicle": body.vehicle,
        "ingestion_job_id": body.ingestion_job_id,
        # The inventory keys on (file_id, name), so a repeated name stores one
        # row. Count the names, or the file contradicts its own signals list.
        "signal_count": len({signal.name for signal in body.signals}),
        "time_start": body.time_start,
        "time_end": body.time_end,
        "registered_at": now,
        "updated_at": now,
    }

    # The helper owns the tag shape. Its entries are run-typed, so the route
    # drops them and keeps only the field_sources keys.
    update: dict = {}
    for field in _EMBEDDED_FIELDS:
        set_field(update, field, doc[field], Source.EMBEDDED, actor=actor)
    doc["field_sources"] = {
        key.removeprefix("field_sources."): value
        for key, value in update.items()
        if key.startswith("field_sources.")
    }
    doc.update(extra or {})

    try:
        db["files"].insert_one(doc)
    except DuplicateKeyError:
        if raise_on_duplicate:
            raise
        # A parallel POST won the race. The recovery read goes straight to the
        # collection, so a stubbed pre-check cannot hide the winning row.
        winner = db["files"].find_one(
            {
                "checksum_sha256": body.checksum_sha256,
                "status": "registered",
                "run_id": body.run_id,
            }
        )
        if winner is None:
            # No row carries this checksum, so the duplicate came from another
            # index. Never answer with `None`: that drops the file silently.
            raise
        return winner, False

    note = (
        f"Linked to run {body.run_id}."
        if status == "registered"
        else f"Quarantined: {reason}."
    )
    db["journal_entries"].insert_one(
        add_event(
            "file", doc["_id"], "file.registered", Source.EMBEDDED, actor, note=note
        )
    )
    if status == "quarantined":
        # FR-DM-004: the file is quarantined, an alert is raised, and the error
        # details are logged. The alert runs AFTER the document and the journal
        # entry land, and it swallows its own failure, so it can never drop a
        # file. See `api/api/services/alerts.py`.
        alerts.raise_quarantine_alert(doc)
    if status == "registered":
        queries_signals.upsert_file_signals(db, doc, body.signals)
    # The rollup runs for a quarantined file as well. A quarantined file that
    # names a known run still lists on that run's Files tab, so it must count
    # in `file_count` too. It carries no signal into the run, because the
    # inventory write above runs for a registered file only.
    #
    # The rollup takes no signal names. It derives both counts from the rows
    # this route has already written, so the run's stored numbers and its
    # served numbers come from one source.
    queries_runs.apply_file_rollup(db, body.run_id, doc)
    return doc, True
