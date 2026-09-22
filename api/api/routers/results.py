"""Contract #18 and the ★ result write-back. Owner: Lane B."""

import hashlib
import json
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import StreamingResponse
from fastapi.routing import APIRoute
from pydantic import ValidationError
from pymongo import ASCENDING, DESCENDING
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError, PyMongoError

from api.auth import journal_actor, journal_actor_or_id, require_token
from api.db import get_db
from api.errors import ApiError
from api.models.common import Page, Pagination, Source, pagination_params
from api.models.results import (
    PROVENANCE_KEYS,
    ResultBody,
    ResultCreateRequest,
    ResultPatchRequest,
)
from api.provenance import add_event, set_field
from api.quix_identity import Identity
from api.services.file_bytes import (
    CHUNK_BYTES,
    FileBytesProvider,
    FileBytesUnavailable,
    content_disposition,
    get_file_bytes_provider,
)
from api.services.file_writes import (
    FileBytesWriter,
    get_file_writer,
    result_blob_key,
    result_filename_from_ref,
)


class _CappedUploadRoute(APIRoute):
    """Refuse an oversized upload before Starlette spools the body to disk.

    FastAPI reads the multipart body **before** it solves a dependency, so no
    dependency and no line of the route function can guard the spool. The
    route handler runs earlier than both, so the cheap check lives here: a
    stated Content-Length above the cap answers 413 and nothing is read.

    A request that states no length (a chunked body) still meets the exact cap
    in `_checksum_and_size`, so the guard never depends on the header alone.
    """

    def get_route_handler(self):
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            if request.url.path.endswith("/results/upload"):
                _refuse_an_oversized_body(request)
            return await original(request)

        return handler


router = APIRouter(tags=["results"], route_class=_CappedUploadRoute)

COLLECTION = "processed_results"

# How many times the route re-reads the newest version after a lost race.
VERSION_RETRIES = 5

# The size cap on one uploaded result (contract v1.2, the result-upload box).
# A processed result is a summary artefact — a parquet, a CSV or a workbook —
# and never a raw measurement file. A measurement file reaches the system
# through the ingestion watcher instead.
MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# The multipart envelope around the file: the boundaries, the headers and the
# metadata part. The early Content-Length check allows this much on top of the
# file cap, so it never refuses a file that the exact check would pass.
MULTIPART_OVERHEAD_BYTES = 64 * 1024


def _refuse_an_oversized_body(request: Request) -> None:
    """Answer 413 for a stated body length above the cap.

    The check reads `MAX_UPLOAD_BYTES` from the module on every call, so a test
    that shrinks the cap shrinks this guard too.
    """
    stated = request.headers.get("content-length", "")
    if not stated.isdigit():
        return
    limit = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES
    if int(stated) > limit:
        raise ApiError(
            413,
            f"the file is larger than the {MAX_UPLOAD_BYTES} byte cap",
            "file_too_large",
        )


@router.get("/results")
def list_results(
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params())],
    run: str | None = None,
    result_key: str | None = None,
    latest_only: bool = False,
) -> Page[ResultBody]:
    """Page the stored results, newest first. Every filter is real.

    latest_only keeps the highest version of each (run_id, result_key).
    """
    query: dict = {}
    if run:
        query["run_id"] = run
    if result_key:
        query["result_key"] = result_key

    pipeline: list[dict] = [{"$match": query}]
    if latest_only:
        pipeline += [
            {"$sort": {"version": DESCENDING}},
            {
                "$group": {
                    "_id": {"run_id": "$run_id", "result_key": "$result_key"},
                    "doc": {"$first": "$$ROOT"},
                }
            },
            {"$replaceRoot": {"newRoot": "$doc"}},
        ]
    skip = (pagination.page - 1) * pagination.page_size
    pipeline += [
        {"$sort": {"created_at": DESCENDING, "version": DESCENDING, "_id": ASCENDING}},
        {
            "$facet": {
                "items": [{"$skip": skip}, {"$limit": pagination.page_size}],
                "count": [{"$count": "total"}],
            }
        },
    ]
    page = next(iter(db[COLLECTION].aggregate(pipeline)))
    total = page["count"][0]["total"] if page["count"] else 0
    # One extra query per page, over the page's own ids only. The cost never
    # grows with the collection.
    return pagination.envelope(_attach_marks(db, page["items"]), total)


def _load_result(db: Database, result_id: str) -> dict:
    """Read one result document, or refuse with 404.

    `GET /files/{file_id}` refuses the same way and with the same shape, so a
    caller reads one rule on both entities.
    """
    doc = db[COLLECTION].find_one({"_id": result_id})
    if doc is None:
        raise ApiError(404, f"Result {result_id} not found", "result_not_found")
    return doc


def _edit_marks(db: Database, result_ids: list[str]) -> dict[str, dict]:
    """Read the "a person edited this" mark of each result from the journal.

    A manual change of a result writes one journal entry, so the journal holds
    the whole truth already. The mark reads it back. The registry never stores
    the mark, so the mark can never drift from the timeline.

    The rule is `kind == "change"` plus `source == "manual"`, and nothing else.
    `POST /results` writes an **event** row, and the download writes an event
    row, so neither ever raises the mark.

    One aggregation answers a whole page. A result with no manual change entry
    is absent from the map, so `edited` reads null.
    """
    if not result_ids:
        return {}
    pipeline = [
        {
            "$match": {
                "entity_type": "result",
                "entity_id": {"$in": result_ids},
                "kind": "change",
                "source": Source.MANUAL.value,
            }
        },
        # The sort makes `$last` the newest entry, so the mark names the person
        # who edited last and never the person who edited first.
        {"$sort": {"at": ASCENDING}},
        {
            "$group": {
                "_id": "$entity_id",
                "at": {"$max": "$at"},
                "actor": {"$last": "$actor"},
                "fields": {"$addToSet": "$field"},
            }
        },
    ]
    return {
        row["_id"]: {
            "at": row["at"],
            "actor": row["actor"],
            "fields": sorted(row["fields"]),
        }
        for row in db["journal_entries"].aggregate(pipeline)
    }


def _attach_marks(db: Database, docs: list[dict]) -> list[dict]:
    """Put the edit mark on each document. One query serves the whole list."""
    marks = _edit_marks(db, [doc["_id"] for doc in docs])
    for doc in docs:
        doc["edited"] = marks.get(doc["_id"])
    return docs


@router.get("/results/{result_id}")
def get_result(
    result_id: str,
    db: Annotated[Database, Depends(get_db)],
) -> ResultBody:
    """Read one result version by its own id (contract §B #18b).

    A result version is addressable. `GET /results` pages the versions of a
    run, and this route resolves one of them, so a screen, a report or a
    journal entry can point at the exact version it means. The body is the
    `ResultBody` shape `POST /results` and `GET /results` both serve.

    The route reads. It never mints a version, it never touches the chain and
    it writes no journal entry. An unknown id answers 404 `result_not_found`.

    The bearer guard sits on the whole `/api/v1` router, so this route needs
    no identity of its own: it writes nothing that names a caller.

    `edited` names the last person who changed the row through
    `PATCH /results/{result_id}`. It reads the journal, and it costs one extra
    query. A result nobody edited reads null.
    """
    return _attach_marks(db, [_load_result(db, result_id)])[0]


@router.get("/results/{result_id}/download")
def download_result(
    result_id: str,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    bytes_provider: Annotated[FileBytesProvider, Depends(get_file_bytes_provider)],
) -> Response:
    """Stream the stored bytes of one result (contract §B #18c).

    The route mirrors `GET /files/{file_id}/download` exactly, and it reuses
    that route's error vocabulary. **Audit-before-bytes** holds here too: the
    server writes the `result.downloaded` journal entry **before** the first
    byte leaves, and a refused entry answers 503 and moves nothing. Bytes never
    move without a trace.

    Errors:

    * ``404 result_not_found`` — the id matches no stored result.
    * ``409 result_has_no_bytes`` — the result carries no `storage_ref`, so
      this system holds no bytes for it. `POST /results` accepts a result whose
      bytes live somewhere else, and such a row is complete and correct. The
      answer says the result holds no bytes here, and it never reads as
      "no such result".
    * ``503 storage_unreachable`` — the store did not answer, or it holds no
      object under the reference. No journal entry is written: the server never
      fabricates a trace for a byte stream that never started.
    * ``503 not_ready`` — the audit journal write failed. No bytes move.

    The entry names the **result**, so "what happened to result X" reads one
    query, and `context_run_id` keeps it on the run timeline too. That is the
    rule `run.result_written` already follows.

    **`Content-Disposition` names the file from the stored key, not from the
    result's `name`.** The key ends in the filename the uploader gave, so it
    carries the real extension; `name` is a label and names no file type, and a
    person who saved it got a file the operating system could not open. The
    route reads the key and never guesses a type, so a CSV, a JSON and a plot
    each keep the name their uploader chose. The stored key never changes.
    """
    doc = _load_result(db, result_id)

    storage_ref = (doc.get("storage_ref") or "").strip()
    if not storage_ref:
        # A result row with no reference is complete and correct — the bytes
        # simply live outside this system. Say that. A 404 here would read as
        # "no such result", and the caller just read the result.
        raise ApiError(
            409,
            f"Result {result_id} carries no stored bytes: it names no storage "
            "reference, so this registry holds nothing to download.",
            "result_has_no_bytes",
        )

    # Reach for the bytes FIRST — before the journal write — so an unreachable
    # store never leaves a fake trace behind. `open` returns an iterator that
    # has not started, so no data byte moves before the entry lands.
    try:
        stream, size = bytes_provider.open(storage_ref)
    except FileBytesUnavailable as error:
        raise ApiError(503, error.detail, "storage_unreachable") from error

    # A person pressed Download, so the source is `manual`. The helper resolves
    # a verified caller over the claimed name, and it stands the Portal user id
    # in for a display name that names nobody.
    actor = journal_actor_or_id(identity, identity.display_name)
    name = doc.get("name") or result_id
    # The served filename comes from the STORED KEY, never from `name`. The key
    # ends in the filename the uploader gave, so it carries the true extension;
    # `name` is the result's label and names no file type. The audit note below
    # keeps the label, because the entry is about the result, not about a file.
    filename = result_filename_from_ref(storage_ref, name)
    event = add_event(
        "result",
        result_id,
        "result.downloaded",
        Source.MANUAL,
        actor,
        note=f"Downloaded {name} ({size} bytes)",
    )
    event["context_run_id"] = doc["run_id"]
    try:
        db["journal_entries"].insert_one(event)
    except PyMongoError as error:
        # Audit-before-bytes forbids the download without a recorded trace.
        # Close the stream on the way out so no handle leaks.
        stream.close()
        raise ApiError(
            503,
            "the download event could not be recorded — refusing to serve bytes",
            "not_ready",
        ) from error

    headers = {
        "Content-Disposition": content_disposition(filename),
        "Content-Length": str(size),
        # The digest of the stored bytes, when the upload route hashed them. A
        # result written through `POST /results` carries none, and the header is
        # then empty. There is no `X-Checksum-State` here: no check ever ran on
        # a result, so no header may put the word "verified" on a screen.
        "X-Checksum-SHA256": doc.get("checksum_sha256") or "",
        # A stable correlation handle from the bytes to the audit entry.
        "X-Journal-Id": event["_id"],
        # Do not let a proxy cache a per-user download.
        "Cache-Control": "no-store",
    }
    return StreamingResponse(
        stream, media_type="application/octet-stream", headers=headers
    )


def _to_millis(value: datetime) -> datetime:
    """Drop the sub-millisecond digits. Mongo keeps milliseconds only."""
    return value.replace(microsecond=value.microsecond // 1000 * 1000)


def _fingerprint(body: ResultCreateRequest) -> str:
    """Hash the request body so a replay compares byte for byte.

    The hash covers the request only, never a value the server mints.
    Mongo rounds a datetime to milliseconds, so the stored document is not
    a safe thing to compare against. The stored hash is.
    The hash drops the same digits Mongo drops. A caller that reads the
    answer and posts it back therefore replays, and mints no phantom
    version.
    """
    rounded = body.model_copy(deep=True)
    rounded.provenance.produced_at = _to_millis(body.provenance.produced_at)
    payload = json.dumps(rounded.model_dump(mode="json"), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _unresolved(db: Database, run_id: str, input_file_ids: list[str]) -> list[str]:
    """Return the input ids that name no registered file of this run.

    An entry names a file by its id or by its filename. An entry that
    resolves to nothing is unverifiable, never malformed.
    """
    if not input_file_ids:
        return []
    known: set[str] = set()
    registered = db["files"].find(
        {
            "run_id": run_id,
            "status": "registered",
            "$or": [
                {"_id": {"$in": input_file_ids}},
                {"filename": {"$in": input_file_ids}},
            ],
        },
        {"_id": 1, "filename": 1},
    )
    for file_doc in registered:
        known.add(file_doc["_id"])
        known.add(file_doc["filename"])
    return [entry for entry in input_file_ids if entry not in known]


def _require_run(db: Database, run_id: str) -> None:
    """Refuse a result that names a run this system never registered.

    A result describes a run, so a result whose run is absent describes
    nothing. `PATCH /files/{file_id}` refuses the same way and with the same
    code, because there the run id also arrives inside a body.

    Both write routes call this. The upload route calls it **before** it
    stores a byte, so a bad run id never leaves a blob behind.
    """
    if db["test_runs"].find_one({"_id": run_id}, {"_id": 1}) is None:
        raise ApiError(422, f"No run {run_id} is registered here", "unknown_run")


def _latest(db: Database, run_id: str, result_key: str) -> dict | None:
    """Find the newest stored version of one (run_id, result_key) pair."""
    return db[COLLECTION].find_one(
        {"run_id": run_id, "result_key": result_key}, sort=[("version", DESCENDING)]
    )


@router.post("/results", status_code=201)
def create_result(
    body: ResultCreateRequest,
    db: Annotated[Database, Depends(get_db)],
    response: Response,
    identity: Annotated[Identity, Depends(require_token)],
) -> ResultBody:
    """Store one processed result (appendix ★).

    The provenance gate runs in the request model: no provenance, no
    result. Never weaken it. A result never overwrites an earlier one.
    The same (run_id, result_key) mints version max+1 and sets supersedes.
    A byte-identical replay of the newest version returns 200 and mints
    no version, so a network retry never creates a phantom one.
    The server rejects malformed provenance and flags unverifiable
    provenance. An input id that names no registered file of the run gives
    201 with provenance_status "flagged". It is never a rejection.
    A result that names no input file at all is flagged too: it carries no
    traceability link, so it never claims verified provenance.
    A result whose `run_id` names no registered run answers 422 `unknown_run`
    and stores nothing: a result describes a run, so a result whose run is
    absent describes nothing.
    """
    doc, replayed = _store_result(db, body, identity)
    if replayed:
        response.status_code = 200
    # The mark rides EVERY serve path: a replayed 200 of a hand-edited result
    # once answered `edited: null` while the next GET said otherwise
    # (25 Aug 2026 deep review).
    return _attach_marks(db, [doc])[0]


def _store_result(
    db: Database,
    body: ResultCreateRequest,
    identity: Identity,
    checksum: str | None = None,
) -> tuple[dict, bool]:
    """Store one result and write its journal entry.

    Return the stored document and whether the body replayed the newest
    version. A replay writes nothing and mints no version.

    `POST /results` and `POST /results/upload` both call this, so one body
    follows one set of rules on both routes.

    `checksum` is the SHA-256 of the uploaded bytes. The upload route passes
    it and the row keeps it, so the next upload of the same bytes compares
    against it. The JSON route carries no bytes and passes none.
    """
    _require_run(db, body.run_id)
    # The journal entry names the verified caller when the platform check is on.
    # `provenance.produced_by` stays as the body sent it, because it names the
    # tool that made the data and not the person who called this route.
    body_hash = _fingerprint(body)
    inputs = body.provenance.input_file_ids
    unresolved = _unresolved(db, body.run_id, inputs)
    # A result that names no input file has no traceability link, so it never
    # claims verified provenance. The flag never drops the result.
    verified = bool(inputs) and not unresolved
    for _ in range(VERSION_RETRIES):
        previous = _latest(db, body.run_id, body.result_key)
        if previous is not None and previous.get("body_hash") == body_hash:
            return previous, True
        doc = {
            "_id": f"res-{uuid.uuid4()}",
            "run_id": body.run_id,
            "name": body.name,
            "result_key": body.result_key,
            "version": 1 if previous is None else previous["version"] + 1,
            "supersedes": None if previous is None else previous["_id"],
            "description": body.description,
            "storage_ref": body.storage_ref,
            "provenance": body.provenance.model_dump(),
            "provenance_status": "verified" if verified else "flagged",
            "body_hash": body_hash,
            "checksum_sha256": checksum,
            "created_at": datetime.now(UTC),
        }
        try:
            db[COLLECTION].insert_one(doc)
            break
        except DuplicateKeyError:
            # A parallel write took this version. Read the newest one again.
            continue
    else:
        raise ApiError(
            409, "another write holds this result version", "version_conflict"
        )

    tool = body.provenance.tool
    # The result lands before the journal entry, and the two writes are not
    # atomic. A crash between them loses the journal line, never the result,
    # and no entry ever points at a result that is not there. A transaction
    # needs a replica set, and this build runs a single mongod.
    #
    # The entry names the RESULT, so "what happened to result X" reads one
    # query. `context_run_id` keeps it on the run timeline as well, the way a
    # signal edit made in a run's context stays on both timelines.
    entry = add_event(
        "result",
        doc["_id"],
        "run.result_written",
        Source.API_POST_PROCESSING,
        journal_actor(identity, body.provenance.produced_by),
        note=f"{body.name} written by {tool} {body.provenance.tool_version}.",
    )
    entry["context_run_id"] = body.run_id
    db["journal_entries"].insert_one(entry)
    # Read the stored document back. Mongo rounds a datetime to milliseconds,
    # so the write answer then matches the replay answer byte for byte.
    return db[COLLECTION].find_one({"_id": doc["_id"]}), False


def _parse_metadata(metadata: str) -> ResultCreateRequest:
    """Read the metadata part of an upload into the POST /results body model.

    One model gates both routes, so an upload follows every rule the JSON
    route follows: the provenance gate, the actor rules and the unknown-field
    refusal.
    """
    try:
        payload = json.loads(metadata)
    except json.JSONDecodeError as error:
        raise ApiError(422, "metadata is not valid JSON", "invalid_metadata") from error
    if not isinstance(payload, dict):
        raise ApiError(422, "metadata must be a JSON object", "invalid_metadata")
    if payload.get("storage_ref") is not None:
        # The bytes back the reference. A caller never claims a reference that
        # no bytes back, so a supplied one is a refusal and not an override.
        raise ApiError(
            422,
            "the server mints storage_ref on an upload, so the metadata must carry none",
            "storage_ref_not_allowed",
        )
    try:
        return ResultCreateRequest.model_validate(payload)
    except ValidationError as error:
        # The app's own handler then builds the §A body, with the field list.
        # The caller reads the same 422 the JSON route answers.
        raise RequestValidationError(error.errors()) from error


def _checksum_and_size(upload: UploadFile) -> tuple[str, int]:
    """Read the upload in chunks. Return the SHA-256 and the byte count.

    The route holds one 1 MiB chunk at a time and never the whole file. The
    cap refuses a file that passes it, and that refusal comes **before** any
    byte reaches the store, so a refused upload stores nothing.
    """
    digest = hashlib.sha256()
    size = 0
    upload.file.seek(0)
    while True:
        chunk = upload.file.read(CHUNK_BYTES)
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_UPLOAD_BYTES:
            raise ApiError(
                413,
                f"the file is larger than the {MAX_UPLOAD_BYTES} byte cap",
                "file_too_large",
            )
        digest.update(chunk)
    upload.file.seek(0)
    return digest.hexdigest(), size


def _chunks(upload: UploadFile) -> Iterator[bytes]:
    """Yield the upload one chunk at a time, for the writer."""
    while True:
        chunk = upload.file.read(CHUNK_BYTES)
        if not chunk:
            return
        yield chunk


@router.post("/results/upload", status_code=201)
def upload_result(
    db: Annotated[Database, Depends(get_db)],
    response: Response,
    identity: Annotated[Identity, Depends(require_token)],
    writer: Annotated[FileBytesWriter, Depends(get_file_writer)],
    file: Annotated[UploadFile, File()],
    metadata: Annotated[str, Form()],
) -> ResultBody:
    """Upload one manually processed result: the bytes, then the row.

    The request is `multipart/form-data` with two parts. `file` carries the
    bytes. `metadata` carries the `POST /results` body as a JSON string, minus
    `storage_ref`, which the server mints from the key it writes.

    The order of the checks:

    1. the stated body length, before Starlette spools it — 413 `file_too_large`;
    2. the metadata, through the `POST /results` model and its provenance gate;
    3. the checksum and the exact size cap — 413 `file_too_large` stores nothing;
    4. the run — 422 `unknown_run`, and no byte is stored;
    5. the replay check — byte-identical bytes answer 200 and write nothing;
    6. the store answers — 503 `storage_unreachable`, and **no** journal entry,
       because the server never fabricates a trace for bytes that never moved;
    7. the bytes;
    8. the audit entry — 503 `not_ready`;
    9. the result row.

    **The audit entry lands after the bytes, and this route only.** The
    download route keeps audit-before-bytes, because a read must leave a trace
    even when the read then fails. A write is the other way round: an entry
    that says "Uploaded 4,096 bytes" before the store has taken them describes
    bytes that may never land, and that is the fabricated trace the download
    rule forbids. So the entry lands once the store holds the bytes, and it
    then states the truth. A refused entry answers 503 `not_ready`; the stored
    object stays, and no result row points at it.

    A person pressed Upload, so the source is `manual`, and `journal_actor`
    resolves a verified caller over the claimed name.

    The answer is the `ResultBody` of #18, with `storage_ref` set. The
    `X-Checksum-SHA256` and `X-Journal-Id` headers name the stored bytes and
    the audit entry.
    """
    body = _parse_metadata(metadata)
    checksum, size = _checksum_and_size(file)
    filename = file.filename or body.name

    # The run gate runs before any byte moves, so a result that names no run
    # never leaves a blob nobody can reach. `_store_result` checks it again for
    # the JSON route.
    _require_run(db, body.run_id)

    # The same bytes under the same (run_id, result_key) are a retry, never a
    # change. The answer is 200 with the stored row, and nothing is written:
    # no blob, no journal entry, no row. The rule reads the bytes only, so a
    # fresh `produced_at` never mints a phantom version. A row stored before
    # this rule holds no checksum and can never match, so it still mints the
    # next version.
    latest = _latest(db, body.run_id, body.result_key)
    if latest is not None and latest.get("checksum_sha256") == checksum:
        response.status_code = 200
        # No `X-Journal-Id`: a replay writes no entry, so none names it.
        response.headers["X-Checksum-SHA256"] = checksum
        return _attach_marks(db, [latest])[0]

    # Reach the store before the bytes, the way the download route reaches the
    # bytes before it answers.
    try:
        writer.check_ready()
    except FileBytesUnavailable as error:
        raise ApiError(503, error.detail, "storage_unreachable") from error

    key = result_blob_key(body.run_id, filename)
    try:
        writer.write(key, _chunks(file))
    except FileBytesUnavailable as error:
        raise ApiError(503, error.detail, "storage_unreachable") from error

    actor = journal_actor(identity, body.provenance.produced_by)
    # The entry names the run, not the result: no result exists yet, and the
    # row must stay the last write. Moving this entry past the row would let a
    # refused entry leave a stored result behind, and the retry would then mint
    # a second version of a result the caller only uploaded once.
    event = add_event(
        "run",
        body.run_id,
        "run.result_uploaded",
        Source.MANUAL,
        actor,
        note=f"Uploaded {filename} ({size} bytes, sha256 {checksum}).",
    )
    try:
        db["journal_entries"].insert_one(event)
    except PyMongoError as error:
        raise ApiError(
            503,
            "the upload event could not be recorded — refusing to write the result",
            "not_ready",
        ) from error

    body.storage_ref = f"blob://{key}"
    # The bytes differ, so this is a new version. The minted key holds a fresh
    # uuid, so the fingerprint never matches a stored one and the replay answer
    # inside `_store_result` never fires here. The check above owns the replay
    # rule for this route, and it reads the checksum of the bytes.
    doc, _replayed = _store_result(db, body, identity, checksum)
    response.headers["X-Checksum-SHA256"] = checksum
    response.headers["X-Journal-Id"] = event["_id"]
    return _attach_marks(db, [doc])[0]


# The keys of a result row a person may correct. Every other key is minted or
# derived, and the version chain rests on it.
_PATCHABLE_FIELDS = ("name", "description")


def _stated_changes(body: ResultPatchRequest) -> dict:
    """Flatten the patch body into the Mongo paths it changes.

    A field sent as null counts as absent, as `PATCH /files` treats a null, so
    this route never clears a value. The provenance keys flatten to the dotted
    paths `provenance.tool`, `provenance.tool_version` and the rest.
    """
    stated = body.model_dump(exclude_unset=True, exclude_none=True)
    changes = {key: stated[key] for key in _PATCHABLE_FIELDS if key in stated}
    block = stated.get("provenance") or {}
    for key in PROVENANCE_KEYS:
        if key in block:
            changes[f"provenance.{key}"] = block[key]
    return changes


def _flatten(doc: dict) -> dict:
    """A copy of the stored result whose provenance keys read by dotted path.

    `set_field` reads the old value with `current_doc.get(field)`, and the
    field name of a provenance change is a dotted path. A plain stored
    document answers None for such a key, so every provenance change would
    journal an empty old value. This copy answers the true old value.
    """
    flat = dict(doc)
    for key, value in (doc.get("provenance") or {}).items():
        flat[f"provenance.{key}"] = value
    return flat


@router.patch("/results/{result_id}")
def patch_result(
    result_id: str,
    body: ResultPatchRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> ResultBody:
    """Correct the label or the provenance of one stored result (§B #18d).

    A person fixes a wrong tool version or a wrong input list here. Each
    change carries the `manual` source and writes one journal entry, so the
    result timeline states who changed what, and `edited` on the body marks
    the row.

    The identity of the version stays out of the body. `run_id`, `result_key`,
    `version`, `supersedes`, `storage_ref`, `provenance_status`, `created_at`
    and `result_id` are minted or derived, and the version chain rests on
    them. The request model forbids each one and answers 422 with its name.

    A changed `input_file_ids` re-derives `provenance_status` with the create
    route's own rule. An input id that resolves to nothing is never a refusal:
    it flags the result, exactly as on create.

    Errors:

    * ``400 no_fields_to_update`` — the body states no field to change.
    * ``404 result_not_found`` — the id matches no stored result.
    * ``422 provenance_required`` — a stated provenance value is blank. The
      gate is the one `POST /results` keeps, and it answers the same code.
    * ``422 validation_error`` — an unknown or non-patchable key, or an actor
      that names nobody.
    """
    changes = _stated_changes(body)
    if not changes:
        raise ApiError(400, "no fields to update", "no_fields_to_update")

    doc = _load_result(db, result_id)
    actor = journal_actor_or_id(identity, body.actor)
    flat = _flatten(doc)

    update: dict = {}
    entries: list[dict] = []
    for field, value in changes.items():
        if isinstance(value, datetime):
            # Mongo stores milliseconds. Comparing (and writing) microsecond
            # precision made a µs restatement of the stored instant journal a
            # phantom "change" whose old and new differ only in invisible
            # digits — and every identical retry stacked another entry
            # (25 Aug 2026). `_fingerprint` truncates the same way.
            value = _to_millis(value)
        if flat.get(field) == value:
            # The stored value already says this. Nothing changed, so nothing
            # is written and the timeline states no change. `PATCH /files`
            # skips an unchanged stage field the same way.
            continue
        entry = set_field(
            update,
            field,
            value,
            Source.MANUAL,
            actor,
            note=body.note,
            current_doc=flat,
            entity_type="result",
            entity_id=result_id,
            field_label=f"result.{field}",
            # The run timeline unions the entries that name it as the context,
            # so a result edit shows on the run timeline as well.
            context_run_id=doc["run_id"],
        )
        if entry is not None:
            entries.append(entry)

    if "provenance.input_file_ids" in update:
        # Derived, never stated: the status follows the inputs the way
        # `_store_result` derives it on create. So it carries no source tag,
        # and it writes no journal entry of its own.
        inputs = update["provenance.input_file_ids"]
        verified = bool(inputs) and not _unresolved(db, doc["run_id"], inputs)
        update["provenance_status"] = "verified" if verified else "flagged"

    # `body_hash` stays exactly as it is. It fingerprints the request that
    # created this version, never the document. So a re-post of the original
    # body still replays and still mints no version.
    if not update:
        # Every stated value already matches the stored one. Write nothing.
        return _attach_marks(db, [doc])[0]

    db[COLLECTION].update_one({"_id": result_id}, {"$set": update})
    if entries:
        db["journal_entries"].insert_many(entries)
    return _attach_marks(db, [_load_result(db, result_id)])[0]
