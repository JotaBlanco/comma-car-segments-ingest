"""Contract #7, #14, #15, #16, #17. Owner: Lane B."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from pymongo.database import Database

from api import provenance
from api.auth import journal_actor, journal_actor_or_id, require_token
from api.db import get_db
from api.errors import ApiError
from api.models.common import Pagination, Source, pagination_params
from api.models.signals import (
    RunSignalPage,
    SignalDetail,
    SignalFacets,
    SignalPage,
    SignalPatchRequest,
    SignalStatsResponse,
)
from api.models.sorting import ResolvedSort, sort_params
from api.quix_identity import Identity
from api.services import exports, queries_stats
from api.services.query_text import every_word_matches

router = APIRouter(tags=["signals"])

# Contract §2.3 + decision box 1 (closed): default sort is ``last_seen desc``.
# This CHANGES the pre-change default of ``name asc`` — the FE plan aligns.
# ``name`` maps to ``_id`` because the catalogue keys the signal name in _id.
_signals_sort = sort_params(
    whitelist=("name", "typical_rate_hz", "run_count", "last_seen"),
    default_key="last_seen",
    default_directions={
        "name": "asc",
        "typical_rate_hz": "desc",
        "run_count": "desc",
        "last_seen": "desc",
    },
    field_map={"name": "_id"},
)


def _signals_view_counts(db: Database) -> dict:
    """Whole-table counts for /signals (contract §2.4)."""
    signals = db["signals"]
    return {
        "all": signals.count_documents({}),
        "missing_unit": signals.count_documents({"unit": None}),
    }

_PATCHABLE_FIELDS = ("unit", "description", "sensor_ref")


@router.get("/test-runs/{run_id}/signals")
def list_run_signals(
    run_id: str,
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params())],
) -> RunSignalPage:
    """One row per signal of the run, served from the registry alone.

    file_signals supplies the name, the unit, the rate, the dtype AND the
    numbers: the ingestion pipeline measures the four statistics and this
    service stores them on the row.

    This route never asks QuixLake, so it never answers 503 for a lake. A
    signal the pipeline did not measure lists with null numbers, and the
    envelope carries `stats_unavailable` to state why the numbers are blank.
    """
    if not queries_stats.run_exists(db, run_id):
        raise ApiError(404, f"Run {run_id} not found", "run_not_found")
    return queries_stats.merge_run_signals(db, run_id, pagination)


def _without_blanks(values: list | None) -> list:
    """Drop the blank values a cleared filter chip sends.

    The chip still sends its key, so the list arrives as ``[""]``. A blank
    value is nothing, so it must filter nothing.
    """
    return [value for value in (values or []) if str(value).strip()]


def signals_query(
    unit: list[str] | None = None,
    missing_unit: bool | None = None,
    rig: list[str] | None = None,
    rate: list[float] | None = None,
    dtype: list[str] | None = None,
    source_system: list[str] | None = None,
    source: list[Source] | None = None,
    q: str | None = None,
) -> dict:
    """Build the Mongo query of every contract filter on the catalogue.

    ``list_signals`` and the CSV export (`api/api/services/exports.py`) both
    read it, so the table and the exported file always select the same rows. A
    second copy of these clauses would let the two drift, and a person would
    then export rows the screen never showed.

    The docstring of ``list_signals`` states what each filter means.
    """
    clauses: list[dict] = []
    units = _without_blanks(unit)
    rigs = _without_blanks(rig)
    dtypes = _without_blanks(dtype)
    source_systems = _without_blanks(source_system)
    if units:
        clauses.append({"unit": {"$in": units}})
    if missing_unit is not None:
        clauses.append({"unit": None} if missing_unit else {"unit": {"$ne": None}})
    if rigs:
        clauses.append({"rig_ids": {"$in": rigs}})
    if dtypes:
        clauses.append({"dtype": {"$in": dtypes}})
    if source_systems:
        clauses.append({"source_systems": {"$in": source_systems}})
    if rate is not None and rate:
        clauses.append({"typical_rate_hz": {"$in": rate}})
    tagged = provenance.source_clause([value.value for value in source or []])
    if tagged is not None:
        clauses.append(tagged)
    # A blank q filters nothing. It must not become a match-all clause.
    if q and q.strip():
        clauses.append(every_word_matches(q, ("_id", "description")))
    return {"$and": clauses} if clauses else {}


@router.get("/signals")
def list_signals(
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params())],
    sort: Annotated[ResolvedSort, Depends(_signals_sort)],
    unit: Annotated[list[str] | None, Query()] = None,
    missing_unit: bool | None = None,
    rig: Annotated[list[str] | None, Query()] = None,
    rate: Annotated[list[float] | None, Query()] = None,
    dtype: Annotated[list[str] | None, Query()] = None,
    source_system: Annotated[list[str] | None, Query()] = None,
    source: Annotated[list[Source] | None, Query()] = None,
    q: str | None = None,
) -> SignalPage:
    """Real Mongo-backed catalogue list (contract #14).

    Multi-value ``unit``/``rate``/``rig``/``dtype``/``source_system`` via
    repeated params (§2.2). The default sort is ``last_seen desc`` (decision
    box 1, closed) — this replaces the pre-change ``name asc``. ``q`` is
    word-AND over the name and the description: every word must match, in any
    order.

    ``dtype`` and ``source_system`` answer FR-DM-111. ``dtype`` matches the
    stored data type exactly. ``source_system`` matches the ``source_systems``
    array, which the ingest grows from the file that carried the signal, so it
    reads like the ``rig`` filter and not like a scalar.

    ``source`` answers TR-011. It reads the ``field_sources`` map of the row,
    so a document matches when at least one of its fields carries one of the
    named tags. A document the server never tagged matches no source.
    """
    query = signals_query(
        unit=unit,
        missing_unit=missing_unit,
        rig=rig,
        rate=rate,
        dtype=dtype,
        source_system=source_system,
        source=source,
        q=q,
    )
    collection = db["signals"]
    total = collection.count_documents(query)
    cursor = (
        collection.find(query)
        .sort(sort.as_mongo())
        .skip((pagination.page - 1) * pagination.page_size)
        .limit(pagination.page_size)
    )
    envelope = pagination.envelope(list(cursor), total)
    envelope["view_counts"] = _signals_view_counts(db)
    return envelope


# This route must stay ABOVE ``GET /signals/{name}``, for the reason the
# facets route states below.
@router.get("/signals/export")
def export_signals(
    request: Request,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    sort: Annotated[ResolvedSort, Depends(_signals_sort)],
    columns: Annotated[list[str] | None, Query()] = None,
    unit: Annotated[list[str] | None, Query()] = None,
    missing_unit: bool | None = None,
    rig: Annotated[list[str] | None, Query()] = None,
    rate: Annotated[list[float] | None, Query()] = None,
    dtype: Annotated[list[str] | None, Query()] = None,
    source_system: Annotated[list[str] | None, Query()] = None,
    source: Annotated[list[Source] | None, Query()] = None,
    q: str | None = None,
) -> Response:
    """Stream the WHOLE filtered catalogue as CSV (FR-DM-043, export half).

    Every filter and both sort params are the ones ``GET /signals`` takes, and
    they reach Mongo through the same ``signals_query`` builder, so the file
    and the table hold the same rows in the same order.

    ``columns`` repeats the header of each column the caller wants. None means
    every column. ``api/api/services/exports.py`` holds the list, the row cap
    and the audit rule.
    """
    return exports.csv_export(
        db,
        list_name="signals",
        collection="signals",
        query=signals_query(
            unit=unit,
            missing_unit=missing_unit,
            rig=rig,
            rate=rate,
            dtype=dtype,
            source_system=source_system,
            source=source,
            q=q,
        ),
        sort=sort.as_mongo(),
        columns=columns,
        actor=journal_actor_or_id(identity, identity.display_name),
        filters=request.url.query,
    )


def _sorted_strings(values: list) -> list[str]:
    """Sort the string values and drop the blank ones.

    A null unit is the ``missing_unit`` quick view, not a unit a person can
    select. A blank value filters nothing, because ``_without_blanks`` drops
    it on the way in.
    """
    return sorted(value for value in values if isinstance(value, str) and value.strip())


# This route must stay ABOVE ``GET /signals/{name}``. FastAPI matches the
# routes in declaration order, so a later position would read "facets" as a
# signal name and answer 404.
@router.get("/signals/facets")
def get_signal_facets(db: Annotated[Database, Depends(get_db)]) -> SignalFacets:
    """The distinct filter values of the whole catalogue (contract #14b).

    The screen used to build its filter lists from one page of ``/signals``.
    One page covers 8 per cent of the catalogue, and ``PATCH /signals/{name}``
    does not move ``last_seen``, so a corrected unit on an old signal never
    reached the filter. This route reads every document instead.

    Each field carries an index (``api/api/db.py``), so each ``distinct`` call
    reads that index. ``rig_ids`` is an array, and ``distinct`` flattens it,
    so the rig values match what the ``rig`` filter of #14 accepts.

    ``dtypes`` and ``source_systems`` answer FR-DM-111 and follow the same two
    rules: read the whole catalogue, and serve only a value the filter of #14
    accepts.
    """
    signals = db["signals"]
    rates = sorted(
        float(value)
        for value in signals.distinct("typical_rate_hz")
        if isinstance(value, int | float)
    )
    return {
        "units": _sorted_strings(signals.distinct("unit")),
        "rates": rates,
        "rigs": _sorted_strings(signals.distinct("rig_ids")),
        "dtypes": _sorted_strings(signals.distinct("dtype")),
        # ``source_systems`` is an array, like ``rig_ids``. ``distinct``
        # flattens it, so every value matches what the ``source_system``
        # filter accepts.
        "source_systems": _sorted_strings(signals.distinct("source_systems")),
    }


@router.get("/signals/{name}")
def get_signal(name: str, db: Annotated[Database, Depends(get_db)]) -> SignalDetail:
    """Real Mongo-backed catalogue detail (contract #15)."""
    signal = db["signals"].find_one({"_id": name})
    if signal is None:
        raise ApiError(404, f"Signal {name} not found", "signal_not_found")
    return signal


@router.get("/signals/{name}/stats")
def get_signal_stats(
    name: str,
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params(50))],
    window: str = "run",
    definition: str | None = None,
    rig: str | None = None,
    include_invalid: bool = False,
) -> SignalStatsResponse:
    """One row per run of the signal.

    QuixLake computes the statistics; the run document supplies the status,
    the definition, the rig and the date.
    """
    if window != "run":
        raise ApiError(400, f"window '{window}' is not supported", "unsupported_window")
    signal = db["signals"].find_one({"_id": name}, {"unit": 1})
    if signal is None:
        raise ApiError(404, f"Signal {name} not found", "signal_not_found")
    envelope = queries_stats.signal_run_stats(
        db,
        name,
        pagination,
        definition=definition,
        rig=rig,
        include_invalid=include_invalid,
    )
    return {"name": name, "unit": signal.get("unit"), "window": "run", **envelope}


@router.patch("/signals/{name}")
def patch_signal(
    name: str,
    body: SignalPatchRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> SignalDetail:
    """Real Mongo-backed catalogue edit (contract #17).

    catalogue_ref is api:catalogue-owned and not patchable — the request model
    does not accept it.
    """
    signal = db["signals"].find_one({"_id": name})
    if signal is None:
        raise ApiError(404, f"Signal {name} not found", "signal_not_found")
    # A field sent as null counts as absent (BE-PLAN §4.5 pin).
    changes = {
        key: value
        for key, value in body.model_dump(exclude_unset=True, exclude_none=True).items()
        if key in _PATCHABLE_FIELDS
    }
    if not changes:
        raise ApiError(400, "no fields to update", "no_fields_to_update")

    # The verified caller wins over the body actor. See auth.journal_actor.
    actor = journal_actor(identity, body.actor)
    update: dict = {}
    entries: list[dict] = []
    for field, value in changes.items():
        if signal.get(field) == value:
            continue
        entry = provenance.set_field(
            update,
            field,
            value,
            Source.MANUAL,
            actor,
            note=body.note,
            context_run_id=body.context_run_id,
            current_doc=signal,
            entity_type="signal",
            entity_id=name,
            field_label=f"signal.{name}.{field}",
        )
        if entry is None:
            continue
        entries.append(entry)
        if field == "unit":
            update["unit_source"] = Source.MANUAL.value

    if update:
        db["signals"].update_one({"_id": name}, {"$set": update})
        db["journal_entries"].insert_many(entries)
        signal = db["signals"].find_one({"_id": name})
    return signal
