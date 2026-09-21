"""Pydantic models for the verification half of the V-model chain.

Split from ``models_vmodel.py`` (requirements, artifact sets, baselines) at the natural seam
of the V: this module holds what verifies a requirement - test specifications, their
implementations, the signal catalogue they are written against, the traces they are
evaluated over, and the verdicts that come out.

Reused from ``models.py``: ``PaginationParams``. Nothing here redefines it.
"""

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, model_validator

from .models import PaginationParams, TcUpload, VModelRunStatus
from .utils import now


class VerdictStatus(str, Enum):
    """Verdict of one check against one trace.

    ``INCONCLUSIVE`` is not a soft pass: it means the trace never exercised the
    requirement's premise, so nothing was measured. Values are the exact strings
    acc_project's ``TestImpl/verdict.py`` emits.
    """

    PASS = "PASS"
    FAIL = "FAIL"
    INCONCLUSIVE = "INCONCLUSIVE"
    NOT_RUN = "NOT_RUN"


class IngestStatus(str, Enum):
    """How far a trace got through ingest. Only ``stored`` is reachable in this phase."""

    STORED = "stored"
    VECTORISED = "vectorised"
    FAILED = "failed"
    UNSUPPORTED_RAW_CAN = "unsupported_raw_can"


class PassCriterion(BaseModel):
    """One machine-evaluable acceptance criterion of a test case.

    Never prose: every criterion names an exact signal, channel group, unit, reduction,
    window and numeric rule, so an evaluator and a reviewer read the same thing.
    """

    criterion_id: str
    description: str | None = None
    requirement_ref: str | None = Field(
        None, description="Per-criterion traceability, finer than covers_req_ids"
    )
    signal: str | None = None
    channel_group: str | None = None
    unit: str | None = None
    rule: dict[str, Any] = Field(default_factory=dict)
    reduce: dict[str, Any] = Field(default_factory=dict)
    window: dict[str, Any] = Field(default_factory=dict)
    tolerance: dict[str, Any] | None = Field(default_factory=dict)
    min_samples: int | None = None
    on_missing_signal: str | None = None
    resolved_signal: dict[str, Any] | None = Field(
        None,
        description="Signal catalogue entry resolved at read time: unit, raster_hz, role, enum_map",
    )


class TestSpec(BaseModel):
    """One test case at one artifact version. Ingested verbatim from acc_project."""

    key: str = Field(..., alias="_id", description="'{tc_id}@{artifact_version}'")
    tc_id: str
    artifact_version: str
    mnemonic: str | None = None
    title: str | None = None
    objective: str | None = None
    covers_req_ids: list[str] = Field(
        default_factory=list, description="The forward traceability link. At least one."
    )
    entry_criteria: str | None = None
    exit_criteria: str | None = None
    preconditions: dict[str, Any] | None = Field(
        None, description="Gates the run must satisfy before the criteria are evaluated"
    )
    steps: list[Any] = Field(default_factory=list)
    stimulus: dict[str, Any] | None = None
    pass_criteria: list[PassCriterion] = Field(default_factory=list)
    pass_criteria_logic: str | None = None
    data_requirements: dict[str, Any] = Field(default_factory=dict)
    technique: str | None = None
    priority: str | None = None
    status: str | None = None
    revision: str | None = None
    regression_flag: bool | None = None
    verification_method: str | None = None
    test_environment: str | None = Field(None, description="Free text in the source schema")
    impl_ref: str | None = Field(None, description="-> TestImpl.impl_id, null in the source data")
    notes: str | None = Field(None, description="Carries provenance and EXPECTED VERDICT text")
    last_change: datetime | None = None
    schema_version: str = "1.0.0"
    canonical_sha256: str


class TestSpecQuery(PaginationParams):
    """Query parameters for the test-spec list endpoint."""

    tc_id: str | None = None
    covers_req_id: str | None = None
    artifact_version: str | None = None
    baseline: str | None = None
    q: str | None = Field(None, description="Free-text match on tc_id, title, objective")
    page_size: int = Field(default=100)


class ImplFile(BaseModel):
    """One file of an implementation, with the digest that identifies its exact content."""

    path: str
    size_bytes: int
    sha256: str
    lines: int


class CheckSpec(BaseModel):
    """The declared bound of a check, mirroring ``acc_project/TestImpl/verdict.py``.

    Every quantitative fact about a check lives here rather than inline in evaluation logic,
    which is what lets the Test Implementation page show the bound, its unit, its window and
    its ``verification_tag`` without reading the code.
    """

    test_case_id: str
    requirement_id: str
    verification_tag: str
    title: str
    bound: float
    comparison: str
    unit: str
    window: str
    scope: str
    signals: list[str] = Field(default_factory=list)
    min_samples: int = 1
    tolerance: float = 0.0


class TestImpl(BaseModel):
    """Implementation metadata plus the source text, so the detail pane can show the code."""

    key: str = Field(..., alias="_id", description="'{impl_id}@{artifact_version}'")
    impl_id: str = Field(
        ..., description="acc_project registry id, e.g. TC-ACC-SYS-PRF-020 (not the tc_id)"
    )
    tc_id: str | None = Field(None, description="Covering test spec id, e.g. ACC-SYS-TC-014")
    requirement_id: str | None = None
    artifact_version: str
    language: str = "python"
    entrypoint: str
    runtime: str = "python:3.12"
    timeout_s: int = 120
    trace_required: bool = True
    recommended_scenario: str | None = None
    description: str | None = None
    files: list[ImplFile] = Field(default_factory=list)
    check_spec: CheckSpec | None = None
    uploaded_utc: datetime = Field(default_factory=now)
    uploaded_by: str | None = None
    canonical_sha256: str


class TestImplQuery(PaginationParams):
    """Query parameters for the test-impl list endpoint."""

    impl_id: str | None = None
    tc_id: str | None = None
    artifact_version: str | None = None
    baseline: str | None = None
    language: str | None = None
    page_size: int = Field(default=100)


class SignalCatalogEntry(BaseModel):
    """One signal of the catalogue: where it lives, what it means, how fast it moves."""

    key: str = Field(..., alias="_id", description="'{signal}@{artifact_version}'")
    signal: str
    artifact_version: str
    channel_group: str | None = None
    table: str | None = None
    unit: str | None = None
    dtype: str | None = None
    column_type: str | None = None
    raster_hz: float | None = None
    role: str | None = Field(None, description="stimulus | response | reference | diagnostic")
    enum_map: dict[str, Any] | None = None
    quantisation: Any | None = None
    source_spec: str | None = None
    notes: str | None = None
    schema_version: str = "1.0.0"


class SignalQuery(PaginationParams):
    """Query parameters for the signal catalogue list endpoint."""

    signal: str | None = None
    channel_group: str | None = None
    role: str | None = None
    artifact_version: str | None = None
    page_size: int = Field(default=200)


class Trace(BaseModel):
    """An MF4 measurement file. Stored and catalogued; not parsed in this phase."""

    trace_key: str = Field(..., alias="_id")
    scenario: str | None = None
    source_path: str | None = Field(None, description="Path inside the acc_project catalogue")
    blob_path: str | None = None
    content_sha256: str
    size_bytes: int
    uploaded_utc: datetime = Field(default_factory=now)
    uploaded_by: str | None = None
    device_id: str | None = None
    sw_version: str | None = None
    hw_version: str | None = None
    mdf_version: str | None = None
    ingest_status: IngestStatus = IngestStatus.STORED
    mf4: dict[str, Any] = Field(default_factory=dict)
    groups: list[Any] = Field(default_factory=list)
    signals: list[Any] = Field(default_factory=list)


class RunTraceLink(BaseModel):
    """Many-to-many join between a run and a trace. Append-only."""

    link_id: str = Field(..., alias="_id", description="'{run_id}::{trace_key}'")
    run_id: str
    trace_key: str
    attached_utc: datetime = Field(default_factory=now)
    attached_by: str | None = None


class ResultCriterion(BaseModel):
    """Per-criterion breakdown of a verdict, when the check reports one."""

    criterion_id: str
    actual: float | None = None
    bound: float | None = None
    unit: str | None = None
    tolerance: float | None = None
    verdict: str | None = None


class TestResult(BaseModel):
    """One verdict for one (run, test case, trace). Shape is acc_project's ``Verdict``."""

    result_id: str = Field(..., alias="_id", description="'{run_id}::{tc_id}::{trace_key}'")
    run_id: str
    run_version: int = 1
    tc_id: str
    impl_id: str | None = None
    trace_key: str | None = Field(None, description="None when the case was NOT_RUN")
    req_ids: list[str] = Field(default_factory=list)
    verification_tag: str
    title: str
    status: VerdictStatus
    measured: float | None = None
    bound: float | None = None
    comparison: str | None = None
    margin: float | None = None
    tolerance: float = 0.0
    unit: str = ""
    window: str = ""
    scope: str = ""
    samples_in_scope: int = 0
    signals: list[str] = Field(default_factory=list)
    reason: str = Field("", description="Required even on PASS")
    notes: list[str] = Field(default_factory=list)
    criteria: list[ResultCriterion] = Field(default_factory=list)
    baseline_id: str | None = None
    evaluated_utc: datetime | None = None
    result_sha256: str

    @model_validator(mode="after")
    def inconclusive_has_no_measurement(self) -> "TestResult":
        """INCONCLUSIVE means nothing was measured. Nothing downstream may read a zero."""
        if self.status is VerdictStatus.INCONCLUSIVE and self.measured is not None:
            raise ValueError("INCONCLUSIVE results must not carry a measured value")
        return self


class ResultQuery(PaginationParams):
    """Query parameters for the results list endpoint."""

    run_id: str | None = None
    tc_id: str | None = None
    req_id: str | None = None
    status: VerdictStatus | None = None
    trace_key: str | None = None
    baseline: str | None = None
    page_size: int = Field(default=200)


class RunOrigin(str, Enum):
    """Where a run in the list came from.

    ``seeded`` runs are *derived*: they exist only as the ``run_id`` side of the
    ``vm_run_traces`` join written by the fixture ingest. ``planned`` runs are *stored*: a
    ``tests`` document with a ``vmodel`` sub-document, created from the Add Test Run dialog.
    Both are listed together, and the origin says which is which without guesswork.
    """

    SEEDED = "seeded"
    PLANNED = "planned"


class RunSummary(BaseModel):
    """A V-model run as the Test Run and Test Results stages list it.

    Sourced from a ``tests`` document that carries a ``vmodel`` sub-document, or derived from
    the ``vm_run_traces`` join for the seeded fixtures; the counts are aggregated from
    ``vm_results`` at read time because results are appended per trace.
    """

    run_id: str
    baseline_id: str | None = None
    label: str | None = None
    scenario: str | None = None
    origin: RunOrigin = RunOrigin.SEEDED
    status: VModelRunStatus = Field(
        VModelRunStatus.PLANNED,
        description=(
            "Effective execution state. The stored value wins; a run with verdicts but no "
            "stored state reads 'completed', which is how seeded runs report."
        ),
    )
    trace_keys: list[str] = Field(default_factory=list)
    planned_tc_ids: list[str] = Field(default_factory=list)
    tc_uploads: list[TcUpload] = Field(
        default_factory=list, description="Empty on a seeded run; one entry per uploaded MF4"
    )
    created_utc: datetime | None = None
    started_utc: datetime | None = None
    evaluated_utc: datetime | None = None
    counts: dict[str, int] = Field(
        default_factory=dict,
        description="Verdict counts per result document, i.e. per (test case, trace)",
    )
    tc_counts: dict[str, int] = Field(
        default_factory=dict,
        description=(
            "Verdict counts per *planned test case*, worst verdict wins across its traces. "
            "Sums to len(planned_tc_ids); a case with no verdict counts as NOT_RUN."
        ),
    )
    success_rate: float | None = Field(
        None,
        description=(
            "PASS / (PASS + FAIL + INCONCLUSIVE) over planned test cases, 0-100, one decimal. "
            "None - never 0.0 - when nothing has been evaluated, so 'not run yet' cannot be "
            "misread as 'everything failed'."
        ),
    )


class RunCreate(BaseModel):
    """Create a V-model Test Run from test cases and one measurement file each.

    This is the whole payload of the Add Test Run dialog: nothing about campaigns, devices,
    environments, operators, dates or sensors. ``planned_tc_ids`` is derived from
    ``tc_uploads`` rather than sent twice, so the two can never disagree.
    """

    tc_uploads: list[TcUpload] = Field(
        ..., min_length=1, description="One entry per selected test case, with its upload id"
    )
    label: str | None = Field(None, description="Optional label; derived from the run id if absent")
    baseline_id: str | None = Field(
        None, description="Baseline to pin; defaults to the newest baseline in the register"
    )
