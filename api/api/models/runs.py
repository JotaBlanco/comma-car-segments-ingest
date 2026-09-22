"""Run models, plus the home-summary and lineage shapes (Lane A surface)."""

from typing import Literal

from pydantic import Field, model_validator

from api.errors import ApiError
from api.models.common import (
    ApiModel,
    FieldSources,
    Page,
    RequestModel,
    Source,
    UtcDatetime,
)
from api.models.journal import Actor
from api.models.results import ProvenanceOut

RunStatus = Literal["complete", "awaiting_work_order", "invalid"]

# The limits of a custom property map. A key names one property, so it stays
# short. A value holds one short fact, never a document. The count stops a
# caller that turns the map into a store.
#
# A run and a test definition both carry such a map, and both read the caps and
# the checker below. One checker means the two maps can never drift apart.
CUSTOM_PROPERTY_KEY_MAX = 64
CUSTOM_PROPERTY_VALUE_MAX = 512
CUSTOM_PROPERTY_MAX_COUNT = 50


def check_custom_properties(properties: dict) -> dict:
    """Refuse a bad property map. Every refusal carries its own machine code.

    The route raises `ApiError`, the way `InvalidFlagRequest` does, so the
    caller reads a code it can act on instead of the generic
    `validation_error`. A value that is not a string falls through to Pydantic,
    which answers the generic code and names the key.

    The messages name no entity, because a run and a test definition both call
    this.
    """
    if len(properties) > CUSTOM_PROPERTY_MAX_COUNT:
        raise ApiError(
            422,
            f"A custom property map holds {CUSTOM_PROPERTY_MAX_COUNT} properties at most",
            "too_many_custom_properties",
        )
    for key, value in properties.items():
        if not isinstance(key, str) or not key.strip():
            raise ApiError(
                422,
                "A custom property key must not be empty",
                "custom_property_key_required",
            )
        if len(key) > CUSTOM_PROPERTY_KEY_MAX:
            raise ApiError(
                422,
                f"The custom property key is longer than {CUSTOM_PROPERTY_KEY_MAX} characters",
                "custom_property_key_too_long",
            )
        if isinstance(value, str) and len(value) > CUSTOM_PROPERTY_VALUE_MAX:
            raise ApiError(
                422,
                f"The value of {key!r} is longer than {CUSTOM_PROPERTY_VALUE_MAX} characters",
                "custom_property_value_too_long",
            )
    return properties


# Contract §2c: the wire prefix that names a custom property as the grouping
# criterion — `custom:rig-owner` groups the runs by the property `rig-owner`.
#
# The separator is a colon for three reasons. No fixed group name holds one, so
# `project` keeps its exact meaning. A colon is not a Mongo field-path
# separator and not an operator character, so the prefix itself can address
# nothing. And a property key may hold a colon, so the split takes the FIRST
# colon only and the rest is the key exactly as the person typed it.
CUSTOM_GROUP_PREFIX = "custom:"


def custom_group_key(group_by: str) -> str | None:
    """The property key a `group_by` value names, or None for a fixed name.

    The key goes through `check_custom_properties`, so a grouping key obeys the
    same rules as a stored key, and it carries the same refusal codes. No
    unvalidated key reaches a database query.
    """
    if not group_by.startswith(CUSTOM_GROUP_PREFIX):
        return None
    key = group_by[len(CUSTOM_GROUP_PREFIX) :]
    check_custom_properties({key: ""})
    return key


class InvalidFlag(ApiModel):
    flagged: bool
    reason: str | None
    actor: str | None
    at: UtcDatetime | None


class RunListItem(ApiModel):
    # The collection stores the run id in _id. The alias lets a lane
    # validate a Mongo document directly. The wire keeps "run_id".
    run_id: str = Field(validation_alias="_id")
    description: str | None
    definition_id: str | None
    work_order_id: str | None
    project: str | None
    rig_id: str
    test_cell: str | None
    file_count: int
    signal_count: int
    first_data_at: UtcDatetime
    status: RunStatus
    invalid: InvalidFlag
    # PROPOSED addition, not yet in plans/API-CONTRACT.md — see
    # plans/SECOND-WAVE-PROPOSAL.md.
    #
    # What the ingestion pipeline CLAIMED and the registry could not honour,
    # because the planning mirror held no such row. It is a memory, never a
    # link: `work_order_id` above keeps its meaning of "a link the registry can
    # vouch for", the run stays `awaiting_work_order`, and no filter, rollup or
    # lineage block reads these. They exist so the claim survives until a
    # planning sync can honour it — and so planning, which polls the waiting
    # runs, can see the id the bench generated. See
    # `queries_runs.CLAIM_RETAINED`.
    #
    # Defaulted, unlike every other nullable field here, because a run document
    # written before these existed simply made no claim.
    claimed_work_order_id: str | None = None
    claimed_definition_id: str | None = None


class RunViewCounts(ApiModel):
    """Whole-table, filter-independent quick-view counts for /test-runs.

    Contract §2.4: keys are fixed strings; ``attention`` = status != complete.
    """

    all: int
    attention: int
    invalid: int


class RunPage(Page[RunListItem]):
    """/test-runs response envelope. ``view_counts`` is optional per §3.6.

    The FE guard replays a golden request against this schema and its mock
    is allowed to emit or omit ``view_counts``, so the property stays
    optional until both sides declare a stricter contract.
    """

    view_counts: RunViewCounts | None = None


class RunGroup(ApiModel):
    """One group of runs (contract §2c).

    ``value`` is the stored value of the grouped field. It is ``null`` for the
    runs that hold no value — an unlinked run has no project, and that group
    is real data, not a gap.
    """

    value: str | None
    count: int


class RunGroupPage(Page[RunGroup]):
    """/test-runs/groups envelope. ``total`` counts the GROUPS, not the runs.

    The page envelope of §A, unchanged. ``/test-runs`` keeps its own shape:
    this is a second answer, never a field on the list.
    """


class RunFacets(ApiModel):
    """The distinct filter values of the whole runs table (contract #2b).

    Same reasoning as ``SignalFacets`` (#14b): a filter list built from one
    page of ``/test-runs`` misses every value outside that page. This model
    answers over every document instead.
    """

    rigs: list[str]
    projects: list[str]
    # The custom property keys the table holds (contract §2b, FR-DM-108). The
    # Group-by control lists them, so a person picks a key that exists instead
    # of typing one. Sorted ascending, the way the two lists above are.
    custom_property_keys: list[str]


class RunDetail(RunListItem):
    operator: str | None
    bench_sw: str | None
    started_at: UtcDatetime | None
    ended_at: UtcDatetime | None
    # The lakehouse table that holds this run's samples, as stated by ingestion
    # (None until it has). The FE reads it from here instead of assuming the
    # current TM_LAKE_TABLE, so a run outlives a table bump with its pointer
    # intact.
    lake_table: str | None = None
    result_count: int
    journal_count: int
    field_sources: FieldSources
    created_at: UtcDatetime
    updated_at: UtcDatetime
    # Free key and value pairs a person types. Defaulted, because a run
    # document written before this field existed simply carries none.
    custom_properties: dict[str, str] = Field(default_factory=dict)


class RunPatchRequest(RequestModel):
    """Body of PATCH /test-runs/{run_id}. Any subset of the five fields.

    `work_order_id` and `definition_id` let a person repair a link when
    planning is offline, or when planning named the wrong row. The id must name
    a mirrored row, and the write carries the `manual` tag, so the next sync
    pass reads that tag and leaves the value alone.
    """

    description: str | None = None
    operator: str | None = None
    bench_sw: str | None = None
    work_order_id: str | None = None
    definition_id: str | None = None
    # The whole property map, never a merge. An absent field changes nothing.
    # An empty object clears every property the run carries.
    custom_properties: dict[str, str] | None = None
    actor: Actor
    note: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _check_custom_properties(cls, data):
        # The checks run before Pydantic coerces the map, so each refusal keeps
        # its own machine code. See `check_custom_properties`.
        if isinstance(data, dict) and isinstance(data.get("custom_properties"), dict):
            check_custom_properties(data["custom_properties"])
        return data


class InvalidFlagRequest(RequestModel):
    reason: str
    actor: Actor

    @model_validator(mode="before")
    @classmethod
    def _reason_required(cls, data):
        # Contract #5: an absent OR blank reason answers 422 reason_required,
        # not the generic validation_error. Raised as ApiError so the error
        # handler emits the machine code; the OpenAPI schema keeps reason required.
        if isinstance(data, dict) and not str(data.get("reason") or "").strip():
            raise ApiError(
                422, "A reason is required to flag a run invalid", "reason_required"
            )
        return data


class RunDeleteRequest(RequestModel):
    """Body of DELETE /test-runs/{run_id}.

    The actor is required, as it is on every other destructive route: a delete
    that names nobody is an audit row that proves nothing. With the platform
    check on, the verified caller replaces this claim (`auth.journal_actor`).
    """

    actor: Actor


class LakeDeletion(ApiModel):
    """What the lakehouse did with the run's samples.

    `deleted` — the folders below were removed. `empty` — the lake answered and
    held no partition for this run. `skipped` — no lakehouse is configured here,
    so the samples (if any) stay. The three are not interchangeable: only the
    last one leaves data an operator has to think about.
    """

    table: str
    status: Literal["deleted", "empty", "skipped"]
    partitions: list[str]
    partitions_deleted: int


class RunDeletionReport(ApiModel):
    """What one run delete removed. Every number is what the database reported."""

    run_id: str
    files: int
    signals: int
    results: int
    blobs_removed: int
    # Objects the storage layer would not delete. The registry rows went anyway,
    # so this is the one thing a caller must read: it names bytes left behind.
    blobs_failed: int
    lake: LakeDeletion


class RunUpsertRequest(RequestModel):
    """Body of POST /test-runs (appendix ★, ingestion path).

    Only `run_id` and `rig_id` are required. Every other field is optional,
    because ingestion never waits for context. A field that arrives later is
    merged, and the provenance precedence decides which write wins.

    `work_order_id` and `definition_id` are CLAIMS, never planning writes.
    Planning owns both fields. The registry resolves a claim against the
    planning mirror and tags it `embedded`, so a later sync outranks it. A claim
    the mirror cannot answer links nothing and is REMEMBERED on the run, so the
    next sync can honour it. See `queries_runs._resolve_claims`.
    """

    run_id: str
    rig_id: str
    description: str | None = None
    test_cell: str | None = None
    operator: str | None = None
    bench_sw: str | None = None
    started_at: UtcDatetime | None = None
    ended_at: UtcDatetime | None = None
    work_order_id: str | None = None
    definition_id: str | None = None
    # Which lakehouse table holds this run's samples. Stated by the ingestion
    # path: tm-connector reads it from the LAKE_TABLE project variable - the
    # same value mf4-sink's TABLE_NAME references, which is what keeps the claim
    # from drifting from the writer. Optional because ingestion never waits for
    # context; None means no ingestion has stated it yet. The run RECORDS the
    # table; query-time resolution stays with TM_LAKE_TABLE - so a run ingested
    # before a table bump still names the table that actually holds its rows.
    lake_table: str | None = None
    source: Source = Source.EMBEDDED
    actor: Actor = "ingestion"


# --- Home summary ---


class HomeCounts(ApiModel):
    test_runs: int
    files: int
    signals: int
    work_orders: int
    test_definitions: int
    runs_today: int
    files_today: int
    rig_count: int


class NeedsAttention(ApiModel):
    awaiting_work_order: int
    quarantined_files: int
    invalid_runs: int
    # TR-001. A definition that names no mirrored work order waits for a
    # person. The line deep-links to /definitions?orphaned=true.
    orphaned_definitions: int


class AttentionRunRow(ApiModel):
    """One run the Needs-attention panel names.

    `reason` is the engineer's text on an invalid-flagged run. A run that
    waits for a work order carries no reason.
    """

    run_id: str
    rig_id: str | None
    reason: str | None


class AttentionFileRow(ApiModel):
    """One quarantined file the panel names. `quarantine_reason` says why."""

    file_id: str
    filename: str | None
    quarantine_reason: str | None


class AttentionDefinitionRow(ApiModel):
    """One orphaned test definition the panel names."""

    td_id: str
    title: str | None


class AttentionRows(ApiModel):
    """The first rows behind each `NeedsAttention` count.

    The service caps each list at `ATTENTION_ROW_LIMIT` rows and reads the
    same clause as the count beside it. The count stays the true total, so
    the panel can say how many rows it holds back.
    """

    awaiting_work_order: list[AttentionRunRow]
    quarantined_files: list[AttentionFileRow]
    invalid_runs: list[AttentionRunRow]
    orphaned_definitions: list[AttentionDefinitionRow]


class PlanningSyncBrief(ApiModel):
    online: bool
    last_sync_at: UtcDatetime | None


class RecentRun(ApiModel):
    run_id: str = Field(validation_alias="_id")
    description: str | None
    definition_id: str | None
    work_order_id: str | None
    rig_id: str
    first_data_at: UtcDatetime
    status: RunStatus


class SourceCount(ApiModel):
    """How many tagged metadata fields one source wrote (TR-011).

    One field of one document counts once, over the runs, the files, the
    signals and the work orders — every entity that carries a `field_sources`
    map. So the number states how much of the registry that system or that
    person wrote, and not how many rows it touched.
    """

    source: Source
    field_count: int


class HomeSummary(ApiModel):
    counts: HomeCounts
    needs_attention: NeedsAttention
    # The named entities behind the four counts above, capped per category.
    attention_rows: AttentionRows
    planning_sync: PlanningSyncBrief
    recent_runs: list[RecentRun]
    # TR-011 asks for aggregate source statistics. The list carries one row
    # per `Source` value, always in the enum order and always complete, so a
    # source that wrote nothing reads as a zero and the Home card never
    # reflows between two loads.
    source_breakdown: list[SourceCount] = Field(default_factory=list)


# --- Lineage ---


class LineageWorkOrder(ApiModel):
    wo_id: str
    title: str
    project: str
    source: Source


class LineageDefinition(ApiModel):
    td_id: str
    title: str
    source: Source


class LineageRun(ApiModel):
    run_id: str
    rig_id: str
    test_cell: str | None
    first_data_at: UtcDatetime
    file_count: int
    signal_count: int
    status: RunStatus


class LineageFile(ApiModel):
    file_id: str
    filename: str
    source_system: str
    size_bytes: int
    signal_count: int


class LineageResult(ApiModel):
    result_id: str
    name: str
    version: int
    provenance_status: Literal["verified", "flagged"]
    provenance: ProvenanceOut


class LineageResponse(ApiModel):
    work_order: LineageWorkOrder | None
    definition: LineageDefinition | None
    run: LineageRun
    files: list[LineageFile]
    results: list[LineageResult]
