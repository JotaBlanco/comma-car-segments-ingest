"""Contract #2, #3, #4, #5, #6 and the ★ upsert. Owner: Lane A."""

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, Query, Request, Response
from pydantic import AfterValidator
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError

from api.auth import journal_actor, journal_actor_or_id, require_token
from api.db import get_db
from api.errors import ApiError
from api.models.common import PageSize, Pagination, Source, pagination_params
from api.models.files import (
    FileListEnvelope,
    FileRegisterRequest,
    FileSignalInput,
    RunSignalsSubmitRequest,
    RunSignalsSubmitResponse,
    RunSignalSubmission,
)
from api.models.runs import (
    CUSTOM_GROUP_PREFIX,
    InvalidFlagRequest,
    LineageResponse,
    RunDeleteRequest,
    RunDeletionReport,
    RunDetail,
    RunFacets,
    RunGroupPage,
    RunPage,
    RunPatchRequest,
    RunStatus,
    RunUpsertRequest,
    custom_group_key,
)
from api.models.sorting import ResolvedSort, sort_params
from api.quix_identity import Identity
from api.routers.files import _existing_registered, register_file_document
from api.services import exports, queries_runs, run_deletion

router = APIRouter(tags=["test-runs"])

# Contract §2.3: /test-runs sort whitelist. Single-key on purpose — a second
# key is later an additive value, not a new convention.
_runs_sort = sort_params(
    whitelist=("first_data_at",),
    default_key="first_data_at",
    default_directions={"first_data_at": "desc"},
)

# Contract §2c: the fixed group_by names. FastAPI answers 422 for any value
# that is neither one of these nor a valid custom property name, so a typo
# never silently groups by something else.
RunGroupBy = Literal["project", "test_cell", "rig"]


def _parse_group_by(value: str) -> str:
    """Refuse a group_by that names neither a fixed field nor a property key.

    A `ValueError` here answers 422 `validation_error` with the loc
    `["query", "group_by"]`, exactly as the plain whitelist did. A bad property
    key raises `ApiError` inside `custom_group_key`, so it keeps its own
    machine code instead — Pydantic wraps `ValueError` only.
    """
    if value in RunGroupBy.__args__:
        return value
    if not value.startswith(CUSTOM_GROUP_PREFIX):
        names = ", ".join(RunGroupBy.__args__)
        raise ValueError(f"group_by must be one of {names}, or {CUSTOM_GROUP_PREFIX}<property key>")
    custom_group_key(value)
    return value


# The wire type of the parameter. `RunGroupBy` above stays the fixed three.
#
# The pattern states the accepted shape in the OpenAPI snapshot, which the plain
# `str` alone would not. It ends in `.*` on purpose: `custom:` with a blank key
# reaches `_parse_group_by`, so that refusal keeps its own machine code instead
# of the generic one the pattern gives.
_GROUP_BY_PATTERN = f"^(project|test_cell|rig|{CUSTOM_GROUP_PREFIX}.*)$"
RunGroupByParam = Annotated[str, AfterValidator(_parse_group_by)]

# The two link fields joined on 19 Aug 2026. A person repairs a link that
# planning cannot. `project` stays out: it follows the work order.
_PATCHABLE_FIELDS = (
    "description",
    "operator",
    "bench_sw",
    "work_order_id",
    "definition_id",
    # The free property map. It replaces the stored map whole, so an empty
    # object clears it. `exclude_none` still reads a null as absent.
    "custom_properties",
)


@router.get("/test-runs")
def list_test_runs(
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params())],
    sort: Annotated[ResolvedSort, Depends(_runs_sort)],
    status: Annotated[list[RunStatus] | None, Query()] = None,
    rig: Annotated[list[str] | None, Query()] = None,
    project: Annotated[list[str] | None, Query()] = None,
    test_cell: Annotated[list[str] | None, Query()] = None,
    definition: str | None = None,
    work_order: str | None = None,
    signal: str | None = None,
    source: Annotated[list[Source] | None, Query()] = None,
    q: str | None = None,
) -> RunPage:
    """List the runs, newest arrival first. Every filter is real.

    Multi-value ``status``/``rig``/``project``/``test_cell`` via repeated
    params (§2.2). ``test_cell`` joined them on 24 Aug 2026 (FR-DM-108): the
    field was stored on every run and no route read it.
    The `signal` filter answers the signal screen's "view as run filter" link.

    ``source`` answers TR-011. It reads the ``field_sources`` map of the row,
    so a document matches when at least one of its fields carries one of the
    named tags. A document the server never tagged matches no source.
    """
    return queries_runs.list_runs(
        db,
        pagination,
        sort_spec=sort.as_mongo(),
        status=status,
        rig=rig,
        project=project,
        test_cell=test_cell,
        definition=definition,
        work_order=work_order,
        signal=signal,
        source=[value.value for value in source or []],
        q=q,
    )


# This route must stay ABOVE ``GET /test-runs/{run_id}``, for the reason the
# facets route states below.
@router.get("/test-runs/export")
def export_test_runs(
    request: Request,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    sort: Annotated[ResolvedSort, Depends(_runs_sort)],
    columns: Annotated[list[str] | None, Query()] = None,
    status: Annotated[list[RunStatus] | None, Query()] = None,
    rig: Annotated[list[str] | None, Query()] = None,
    project: Annotated[list[str] | None, Query()] = None,
    test_cell: Annotated[list[str] | None, Query()] = None,
    definition: str | None = None,
    work_order: str | None = None,
    signal: str | None = None,
    source: Annotated[list[Source] | None, Query()] = None,
    q: str | None = None,
) -> Response:
    """Stream the WHOLE filtered runs list as CSV (FR-DM-043, export half).

    Every filter and both sort params are the ones ``GET /test-runs`` takes,
    and they reach Mongo through the same ``runs_query`` builder, so the file
    and the table hold the same rows in the same order.

    ``columns`` repeats the header of each column the caller wants. None means
    every column. ``api/api/services/exports.py`` holds the list, the row cap
    and the audit rule.

    The two count columns come from ``with_facts``: a run stores no file count
    and no signal count, so the export overlays the same read model the list
    route overlays, one batch at a time.
    """
    return exports.csv_export(
        db,
        list_name="test-runs",
        collection="test_runs",
        query=queries_runs.runs_query(
            db,
            status=status,
            rig=rig,
            project=project,
            test_cell=test_cell,
            definition=definition,
            work_order=work_order,
            signal=signal,
            q=q,
            source=[value.value for value in source or []],
        ),
        sort=sort.as_mongo(),
        columns=columns,
        actor=journal_actor_or_id(identity, identity.display_name),
        filters=request.url.query,
        decorate=queries_runs.with_facts,
    )


# This route must stay ABOVE ``GET /test-runs/{run_id}``. FastAPI matches the
# routes in declaration order, so a later position would read "facets" as a
# run id and answer 404.
@router.get("/test-runs/facets")
def get_run_facets(db: Annotated[Database, Depends(get_db)]) -> RunFacets:
    """The distinct filter values of the whole runs table (contract #2b).

    The screen used to build its rig list from the newest 200 runs, so a rig
    idle for a while dropped out of the filter. This route reads every
    document instead — same reasoning as ``GET /signals/facets`` (#14b).
    """
    return queries_runs.run_facets(db)


@router.get("/test-runs/groups")
def group_test_runs(
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params())],
    group_by: Annotated[RunGroupByParam, Query(pattern=_GROUP_BY_PATTERN)],
    status: Annotated[list[RunStatus] | None, Query()] = None,
    rig: Annotated[list[str] | None, Query()] = None,
    project: Annotated[list[str] | None, Query()] = None,
    test_cell: Annotated[list[str] | None, Query()] = None,
    definition: str | None = None,
    work_order: str | None = None,
    signal: str | None = None,
    source: Annotated[list[Source] | None, Query()] = None,
    q: str | None = None,
) -> RunGroupPage:
    """Count the runs by one field, biggest group first (contract §2c).

    This route must stay ABOVE ``GET /test-runs/{run_id}`` — same reason as
    ``/test-runs/facets`` above.

    It takes every filter of §2 and reads the same query builder, so a group
    count and a filtered list can never disagree. ``group_by`` is required,
    and a value that names neither a fixed field nor a property key answers
    422.

    ``group_by=custom:<key>`` groups by a custom property of the run, which is
    how a person defines a grouping criterion of their own (FR-DM-108). The key
    obeys the rules of a stored property key, and a key no run carries answers
    an empty group list.

    The list route keeps its shape. Grouping is a separate answer, so a
    caller that never asks for it sees no change at all.
    """
    return queries_runs.group_runs(
        db,
        pagination,
        group_by=group_by,
        status=status,
        rig=rig,
        project=project,
        test_cell=test_cell,
        definition=definition,
        work_order=work_order,
        signal=signal,
        source=[value.value for value in source or []],
        q=q,
    )


@router.get("/test-runs/{run_id}")
def get_test_run(
    run_id: str,
    db: Annotated[Database, Depends(get_db)],
) -> RunDetail:
    """Read one run, with its result and journal counts. 404 when unknown."""
    return queries_runs.get_run(db, run_id)


@router.patch("/test-runs/{run_id}")
def patch_test_run(
    run_id: str,
    body: RunPatchRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> RunDetail:
    """Edit a run by hand. The change carries the manual source tag.

    Planning-owned and embedded fields are not patchable, and the invalid flag
    has its own route.
    """
    # The journal actor comes from the verified caller when the platform check
    # is on. The body then holds a claim, and a claim is not an audit record.
    # A field sent as null counts as absent (BE-PLAN §4.5 pin).
    changes = {
        key: value
        for key, value in body.model_dump(exclude_unset=True, exclude_none=True).items()
        if key in _PATCHABLE_FIELDS
    }
    if not changes:
        raise ApiError(400, "no fields to update", "no_fields_to_update")
    return queries_runs.patch_run(
        db,
        run_id,
        changes,
        actor=journal_actor(identity, body.actor),
        note=body.note,
    )


@router.delete("/test-runs/{run_id}")
def delete_test_run(
    run_id: str,
    body: RunDeleteRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> RunDeletionReport:
    """Delete a run and everything under it. There is no undo.

    The samples go from QuixLake first (whole partitions), then the registered
    bytes, then the registry rows. The journal keeps every entry the run ever
    had and gains a `run.deleted` one. `api/api/services/run_deletion.py` owns
    the order and says why it is that order.

    A lakehouse that will not answer stops the whole delete with 502 and leaves
    the run exactly as it was, so the caller may simply try again.
    """
    # The verified caller wins over the body actor. See auth.journal_actor.
    return run_deletion.delete_run(
        db, run_id, actor=journal_actor(identity, body.actor)
    )


@router.post("/test-runs/{run_id}/invalid-flag")
def flag_run_invalid(
    run_id: str,
    body: InvalidFlagRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> RunDetail:
    """Mark a run invalid. A repeat flag answers 409 and keeps the first reason."""
    # The verified caller wins over the body actor. See auth.journal_actor.
    return queries_runs.set_invalid_flag(
        db,
        run_id,
        reason=body.reason.strip(),
        actor=journal_actor(identity, body.actor),
    )


@router.delete("/test-runs/{run_id}/invalid-flag")
def clear_run_invalid(
    run_id: str,
    body: InvalidFlagRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> RunDetail:
    """Undo an invalid flag (★). Rehearsals need it, so the reason stays required."""
    # The verified caller wins over the body actor. See auth.journal_actor.
    return queries_runs.clear_invalid_flag(
        db,
        run_id,
        reason=body.reason.strip(),
        actor=journal_actor(identity, body.actor),
    )


@router.get("/test-runs/{run_id}/files")
def list_run_files(
    run_id: str,
    db: Annotated[Database, Depends(get_db)],
    page: Annotated[int | None, Query(ge=1)] = None,
    page_size: Annotated[PageSize | None, Query()] = None,
) -> FileListEnvelope:
    """The run's files. Unpaginated envelope per contract #6.

    `page` and `page_size` are optional and additive: a caller that names
    neither still receives every file, and one that names either receives that
    slice with `total` still naming them all. The run detail's Files tab names
    them, because a run of 720 chunk files is not a screenful.
    """
    return queries_runs.list_run_files(db, run_id, page=page, page_size=page_size)


@router.get("/test-runs/{run_id}/lineage")
def get_run_lineage(
    run_id: str,
    db: Annotated[Database, Depends(get_db)],
) -> LineageResponse:
    """The chain a run sits in. The blocks above it stay null while unsynced."""
    return queries_runs.run_lineage(db, run_id)


@router.post("/test-runs", status_code=201)
def upsert_test_run(
    body: RunUpsertRequest,
    db: Annotated[Database, Depends(get_db)],
    response: Response,
) -> RunDetail:
    """Register a run, or merge new facts into the one already stored (★).

    201 on the first registration, 200 on every later call. The run appears the
    moment its first file lands, so this route is the ingestion path's entry.
    """
    doc, created = queries_runs.upsert_run(db, body)
    if not created:
        response.status_code = 200
    return queries_runs.with_counts(db, doc)


# One submission writes its samples to the lake once. The claim collection is
# the gate: its `_id` is the submission checksum, so the insert is atomic and
# exactly one caller of a set of identical callers wins it.
SUBMISSION_CLAIMS = "signal_submission_claims"

# A claim this old belonged to a caller that died mid-write. A later caller
# takes it over, or an identical submission could never be sent again.
CLAIM_TIMEOUT = timedelta(minutes=15)


def _claim_submission(db: Database, checksum: str) -> bool:
    """Take the exclusive right to write this submission's samples.

    Return True when this caller holds the claim. The insert is one atomic
    Mongo operation on the `_id` index, so no lock and no read-then-write
    window exists: two identical submissions that both pass the replay check
    still produce exactly one winner.
    """
    now = datetime.now(UTC)
    try:
        db[SUBMISSION_CLAIMS].insert_one({"_id": checksum, "at": now})
        return True
    except DuplicateKeyError:
        # The holder may have died. The conditional update is atomic too, so
        # only one of several waiting callers takes an abandoned claim.
        taken = db[SUBMISSION_CLAIMS].update_one(
            {"_id": checksum, "at": {"$lt": now - CLAIM_TIMEOUT}},
            {"$set": {"at": now}},
        )
        return taken.matched_count == 1


def _release_submission(db: Database, checksum: str) -> None:
    """Drop the claim. A later identical submission then replays on the file."""
    db[SUBMISSION_CLAIMS].delete_one({"_id": checksum})


@router.post("/test-runs/{run_id}/signals", status_code=201)
def submit_run_signals(
    run_id: str,
    body: RunSignalsSubmitRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    response: Response,
) -> RunSignalsSubmitResponse:
    """Accept signals for an existing run straight over the API.

    PROPOSED addition, not yet in plans/API-CONTRACT.md — see
    plans/SECOND-WAVE-PROPOSAL.md.

    The submission becomes a LOGICAL file on the one registration path POST
    /files rides: the canonical payload JSON is the file's bytes, its sha256
    is the checksum and the idempotency key, and the registered document
    carries the run link, so file_signals keeps its file_id identity, the
    catalogue upserts run and the run rollups move. The run must already
    exist — a file births a run, an API submission never does (404 when
    unknown).

    Sample values go to QuixLake, before Mongo sees the file — the watcher's
    order. Mongo never stores a sample value. With no lake configured the
    inventory still lands and ``samples`` answers "deferred". A byte-identical
    replay answers 200 with the stored file id and writes nothing anywhere.

    The replay check alone never held that promise: two identical submissions
    both read "no file yet" and both wrote their samples to the lake, which
    doubled every row. A claim on the checksum closes it. The claim is one
    atomic insert, so one caller writes the lake and the others answer 200 on
    the stored file, or 409 `submission_in_flight` while the winner is still
    working. The lake never sees one submission twice.
    """
    if db["test_runs"].find_one({"_id": run_id}, {"_id": 1}) is None:
        raise ApiError(404, f"Run {run_id} not found", "run_not_found")

    canonical = _canonical_submission(run_id, body)
    checksum = hashlib.sha256(canonical).hexdigest()
    accepted = [
        {"name": signal.name, "sample_count": len(signal.samples or [])}
        for signal in body.signals
    ]

    # The replay check runs BEFORE the lake write, or every replay would
    # duplicate the sample rows in the lake. Scoped on (run, checksum) since
    # 24 Aug 2026: the same values submitted to a different run mint fresh.
    replay = _existing_registered(db, checksum, run_id)
    if replay is not None:
        response.status_code = 200
        return _submission_response(replay["_id"], run_id, accepted, "skipped", 0)

    if not _claim_submission(db, checksum):
        # An identical submission holds the lake write. It may have finished
        # between the read above and this line, so look once more.
        replay = _existing_registered(db, checksum, run_id)
        if replay is not None:
            response.status_code = 200
            return _submission_response(replay["_id"], run_id, accepted, "skipped", 0)
        raise ApiError(
            409,
            "an identical submission is being written — retry it",
            "submission_in_flight",
        )

    try:
        timestamps = [
            stamp for signal in body.signals for stamp, _ in (signal.samples or [])
        ]
        time_start = _from_ms(min(timestamps)) if timestamps else None
        time_end = _from_ms(max(timestamps)) if timestamps else None

        filename = f"api-submission-{datetime.now(UTC):%Y%m%dT%H%M%S}Z.json"
        samples_status, sample_rows = _forward_samples(
            filename, run_id, time_start, body.signals
        )

        register_body = FileRegisterRequest(
            filename=filename,
            run_id=run_id,
            source_system=body.source_system,
            format="JSON",
            # The canonical bytes ARE the logical file, so their length is its
            # size.
            size_bytes=len(canonical),
            checksum_sha256=checksum,
            # The server computed the checksum over the bytes it defined itself.
            checksum_state="verified",
            time_start=time_start,
            time_end=time_end,
            signals=[_as_file_signal(signal) for signal in body.signals],
        )
        doc, created = register_file_document(
            db,
            register_body,
            actor=journal_actor(identity, body.actor),
            # No pipeline stage ran over an API submission, so this file
            # serves null for the four stage fields (contract §D, rule 5).
            derive_stages=False,
        )
    finally:
        # The claim ends with the work, whether the work landed or failed. A
        # later identical submission then replays on the registered file, and a
        # failed one is free to try again.
        _release_submission(db, checksum)
    if not created:
        # The claim makes this rare: another caller registered the same
        # checksum through a different route. Answer the winner.
        response.status_code = 200
    return _submission_response(doc["_id"], run_id, accepted, samples_status, sample_rows)


def _submission_response(
    file_id: str, run_id: str, accepted: list[dict], samples: str, sample_rows: int
) -> dict:
    return {
        "file_id": file_id,
        "run_id": run_id,
        "accepted": accepted,
        "samples": samples,
        "sample_rows": sample_rows,
    }


def _canonical_submission(run_id: str, body: RunSignalsSubmitRequest) -> bytes:
    """The bytes this logical file is made of.

    Deterministic on purpose: their sha256 is the idempotency key, exactly as
    a physical file's bytes are on POST /files. The actor stays out — who
    submits does not change what was submitted.
    """
    payload = {
        "run_id": run_id,
        "source_system": body.source_system,
        "signals": [signal.model_dump() for signal in body.signals],
    }
    return json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def _from_ms(stamp_ms: int) -> datetime:
    return datetime.fromtimestamp(stamp_ms / 1000.0, tz=UTC)


def _as_file_signal(signal: RunSignalSubmission) -> FileSignalInput:
    """Fill the inventory row shape the registration path stores."""
    rate_hz = signal.rate_hz
    if rate_hz is None:
        rate_hz = _derived_rate_hz(signal.samples)
    return FileSignalInput(
        name=signal.name,
        unit=signal.unit,
        rate_hz=rate_hz,
        dtype=signal.dtype or "float64",
    )


def _derived_rate_hz(samples: list[tuple[int, float]] | None) -> float:
    """The rate from the sample timestamps — (n-1)/span, the parsers' rule.

    0.0 means unknown, the same sentinel the ingestion pipeline's parser
    answers when a file states no usable time axis.
    """
    if not samples or len(samples) < 2:
        return 0.0
    stamps = [stamp for stamp, _ in samples]
    span_s = (max(stamps) - min(stamps)) / 1000.0
    if span_s <= 0.0:
        return 0.0
    return (len(samples) - 1) / span_s


def _forward_samples(
    filename: str,
    run_id: str,
    time_start: datetime | None,
    signals: list[RunSignalSubmission],
) -> tuple[str, int]:
    """Move the sample rows to QuixLake, before Mongo sees the file.

    A lake failure then leaves no registered file whose replay would swallow
    the samples for good. The caller is synchronous and still holds the
    payload, so it answers 503 and the caller retries the whole submission.

    **This is not "the watcher's order".** An earlier version of this docstring
    said so and it was wrong. The watcher registered FIRST and wrote the lake
    second, on the minted 201, because the other order doubled every sample on
    a restart. The two orders share the guard placement only: a Mongo-side
    replay check runs before the lake write. The watcher moved to the
    ingestion pipeline on 19 Aug 2026, and it keeps its own order there.
    See `plans/design/INGEST-SPLIT.md` section 4.5.
    """
    with_samples = [signal for signal in signals if signal.samples]
    if not with_samples or time_start is None:
        return "skipped", 0

    # Deferred import, the way `file_bytes` reaches `ingest.store`: the API
    # serves every registry route without the ingestion modules on the path.
    from ingest.lake import ChannelSamples, build_lake_client

    client = build_lake_client()
    if client is None:
        return "deferred", 0

    start_s = time_start.timestamp()
    blocks = [
        ChannelSamples(
            name=signal.name,
            offsets_s=[stamp / 1000.0 - start_s for stamp, _ in signal.samples],
            values=[value for _, value in signal.samples],
        )
        for signal in with_samples
    ]
    try:
        rows = client.write_samples(
            filename=filename, run_id=run_id, time_start=time_start, samples=blocks
        )
    except httpx.HTTPError as error:
        # Nothing reached Mongo yet, so the caller retries the whole payload.
        raise ApiError(
            503, "QuixLake did not accept the samples", "lake_unavailable"
        ) from error
    finally:
        client.close()
    return "written", rows
