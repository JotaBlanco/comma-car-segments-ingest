"""Requirement models: the mirror row, its derived projection, its writes.

A requirement is a light mirrored entity (`dev-planning/requirement-status-
from-runs/spec.md` §4.1): planning owns the authored fields through
`POST /planning/sync`, a manual row is born through `POST /requirements`
(`dev-planning/authoring-controls/spec.md`), and `verification_state`,
`verified_by`, `covering_run_ids` and `latest_run_id` are never stored — they
are computed by `queries_requirements._project` on every read.
"""

from typing import Literal

from pydantic import Field

from api.models.common import ApiModel, FieldSources, Page, RequestModel, UtcDatetime
from api.models.journal import Actor

VerificationState = Literal["not_covered", "covered", "exercised", "failed", "tested"]

EarsPattern = Literal[
    "Ubiquitous",
    "StateDriven",
    "EventDriven",
    "OptionalFeature",
    "UnwantedBehaviour",
    "Complex",
]

VerdictOutcome = Literal["pass", "fail", "error"]


class Measurand(ApiModel):
    name: str
    unit: str


class RequirementRow(ApiModel):
    """One row of the requirements grid.

    `status` is authored — planning states it, or a person states it at
    creation, and no machine ever writes it. Every other derived field below
    is computed at read time and never stored (`verified_by` is BP5 / D1).
    """

    req_id: str = Field(validation_alias="_id")
    title: str
    status: str
    chapter: str | None
    ears_pattern: EarsPattern | None
    revision: str | None
    verification_method: str | None

    verification_state: VerificationState
    evidence_stale: bool
    verified_by: list[str] = Field(default_factory=list)
    covering_run_ids: list[str] = Field(default_factory=list)
    covering_run_count: int
    latest_run_id: str | None
    tested_at: UtcDatetime | None

    synced_at: UtcDatetime | None


class RequirementViewCounts(ApiModel):
    """Whole-table, filter-independent counts for /requirements."""

    all: int
    not_covered: int
    covered: int
    exercised: int
    failed: int
    tested: int


class RequirementPage(Page[RequirementRow]):
    view_counts: RequirementViewCounts


class RequirementEvidence(ApiModel):
    """One `(run, definition)` pair covering a requirement, and its verdict.

    A covering run with no verdict still produces a row, with `outcome` and
    `current` both null — that is the state every requirement sits in until
    `BL-11` writes verdicts.
    """

    run_id: str
    definition_id: str
    definition_title: str
    outcome: VerdictOutcome | None
    produced_at: UtcDatetime | None
    implementation_sha256: str | None
    current: bool | None
    evidence_values: dict = Field(default_factory=dict)


class RequirementDetail(RequirementRow):
    text: str
    text_rendered: str | None
    measurand: list[Measurand] = Field(default_factory=list)
    system_states: list[str] = Field(default_factory=list)
    rationale: str | None
    source: list[str] = Field(default_factory=list)
    related_reqs: list[str] = Field(default_factory=list)
    figure_refs: list[str] = Field(default_factory=list)
    verification_criteria: str | None

    normative_sha256: str
    normative_changed_at: UtcDatetime | None

    # Concurrency (`dev-planning/authoring-controls/spec.md` §6): mints on a
    # `content_sha256` change, `status` excluded (§12 OQ5).
    item_version: int
    content_sha256: str

    field_sources: FieldSources = Field(default_factory=dict)
    evidence: list[RequirementEvidence] = Field(default_factory=list)


# --- authored writes (dev-planning/authoring-controls/spec.md §8, §10) -----


class RequirementCreateRequest(RequestModel):
    """Body of POST /requirements. A manual row only — planning never posts here."""

    id: str
    title: str
    text: str
    ears_pattern: EarsPattern
    chapter: str | None = None
    system_states: list[str] = Field(default_factory=list)
    rationale: str | None = None
    source: list[str] = Field(default_factory=list)
    verification_method: str | None = None
    measurand: list[Measurand] = Field(default_factory=list)
    revision: str = "0.1"
    related_reqs: list[str] = Field(default_factory=list)
    figure_refs: list[str] = Field(default_factory=list)
    verification_criteria: str | None = None
    # Creation starts a requirement before review moves it further (§8).
    status: Literal["NEW", "Draft"] = "Draft"
    actor: Actor
    note: str | None = None


class RequirementPatchRequest(RequestModel):
    """Body of PATCH /requirements/{req_id}. Every authored field, all optional.

    `parent_version` guards the edit: it must equal the stored `item_version`
    or the write is refused `stale_parent`. An edit that changes no field's
    bytes is refused `no_op_mint`.
    """

    title: str | None = None
    text: str | None = None
    ears_pattern: EarsPattern | None = None
    chapter: str | None = None
    system_states: list[str] | None = None
    rationale: str | None = None
    source: list[str] | None = None
    verification_method: str | None = None
    measurand: list[Measurand] | None = None
    revision: str | None = None
    related_reqs: list[str] | None = None
    figure_refs: list[str] | None = None
    verification_criteria: str | None = None
    parent_version: int
    actor: Actor
    second_actor: str | None = None
    note: str | None = None


class RequirementRetireRequest(RequestModel):
    """Body of POST /requirements/{req_id}/retire.

    Retirement sets `status: "Obsolete"`. The row and its id are kept forever
    (`dev-planning/authoring-controls/spec.md` §5); `successor_id`, when
    given, is prepended to `related_reqs`.
    """

    parent_version: int
    actor: Actor
    successor_id: str | None = None
    note: str | None = None
