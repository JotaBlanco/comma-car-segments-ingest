"""Pydantic v2 models for API-only bodies (spec 3.3).

JSON Schema is the source of truth for *artifact* documents; these models cover
request bodies that never become an artifact - run creation, attachment,
evaluation triggers, manual verdicts, registry writes. Two validators, two jobs,
no duplicated artifact model, therefore no drift.

Every model sets ``extra="forbid"``: the previous implementation accepted
``item: dict`` and inserted it verbatim, so ``POST /requirements`` with ``{}``
succeeded. A typo in a field name must be a 422, not a silently ignored value.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

import ids

STRICT = ConfigDict(extra="forbid")


class DeviceCreate(BaseModel):
    model_config = STRICT

    device_id: str = Field(pattern=ids.DEVICE_ID_RE.pattern)
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["plant-sim", "hil", "vehicle", "bench"] = "plant-sim"
    description: str = ""


class DeviceVersionCreate(BaseModel):
    model_config = STRICT

    sw_version: str = Field(min_length=1, max_length=64)
    hw_version: str = Field(min_length=1, max_length=64)
    plant_spec_ref: str = ""
    tool_name: str = ""
    tool_version: str = ""
    asammdf_version: str = ""
    dbc_id: str | None = None
    config_id: str | None = None
    config_version: int | None = None
    make_current: bool = True


class ParameterSetCreate(BaseModel):
    """A parameter set registered directly, when no DCM event is available.

    The registry's normal feed is the ``config-events`` topic sunk by
    ``mongo-writer``; this endpoint exists because the current Dynamic Config
    Manager does not emit real Quix DCM events, so a run would otherwise have no
    ``(config_id, config_version)`` to pin.
    """

    model_config = STRICT

    config_id: str = Field(pattern=ids.CONFIG_ID_RE.pattern)
    config_version: int = Field(ge=1)
    target_key: str = ""
    category: str = "plant-config"
    params: dict = Field(default_factory=dict)
    content_url: str | None = None
    notes: str = ""


class BaselineCreate(BaseModel):
    model_config = STRICT

    requirements_version: str = Field(pattern=ids.VERSION_RE.pattern)
    test_specs_version: str = Field(pattern=ids.VERSION_RE.pattern)
    test_impl_version: str = Field(pattern=ids.VERSION_RE.pattern)
    signal_catalog_version: str = Field(pattern=ids.VERSION_RE.pattern)
    label: str = ""
    created_by: str = ""


class ScopeByRequirement(BaseModel):
    model_config = STRICT

    kind: Literal["by_requirement"] = "by_requirement"
    chapters: list[Literal["Functional-HMI", "Performance", "Safety-Fault-Handling"]] = Field(
        default_factory=list
    )
    req_ids: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _at_least_one(self):
        if not self.chapters and not self.req_ids:
            raise ValueError("by_requirement scope needs at least one chapter or req_id")
        return self

    @field_validator("req_ids")
    @classmethod
    def _check_req_ids(cls, value: list[str]) -> list[str]:
        for req_id in value:
            if not ids.REQ_ID_RE.match(req_id):
                raise ValueError(f"{req_id!r} is not a requirement id")
        return value


class ScopeByTestCase(BaseModel):
    model_config = STRICT

    kind: Literal["by_test_case"] = "by_test_case"
    tc_ids: list[str] = Field(min_length=1)

    @field_validator("tc_ids")
    @classmethod
    def _check_tc_ids(cls, value: list[str]) -> list[str]:
        for tc_id in value:
            if not ids.TC_ID_RE.match(tc_id):
                raise ValueError(f"{tc_id!r} is not a test-case id")
        return value


class TestRunCreate(BaseModel):
    model_config = STRICT

    baseline_id: str = Field(pattern=ids.BASELINE_ID_RE.pattern)
    device_id: str = Field(pattern=ids.DEVICE_ID_RE.pattern)
    device_sw_version: str = Field(min_length=1)
    device_hw_version: str = Field(min_length=1)
    config_id: str | None = None
    config_version: int | None = None
    scope: ScopeByRequirement | ScopeByTestCase
    auto_evaluate: bool = False
    allow_provenance_mismatch: bool = False
    label: str = ""
    created_by: str = ""

    @model_validator(mode="after")
    def _config_pair(self):
        if (self.config_id is None) != (self.config_version is None):
            raise ValueError("config_id and config_version must be given together")
        return self


class AttachRequest(BaseModel):
    """Many-to-many attachment: several traces to a case, a trace to several cases."""

    model_config = STRICT

    tc_ids: list[str] = Field(min_length=1)
    trace_keys: list[str] = Field(min_length=1)
    attached_by: str = ""

    @field_validator("tc_ids")
    @classmethod
    def _check_tc_ids(cls, value: list[str]) -> list[str]:
        for tc_id in value:
            if not ids.TC_ID_RE.match(tc_id):
                raise ValueError(f"{tc_id!r} is not a test-case id")
        return value

    @field_validator("trace_keys")
    @classmethod
    def _check_trace_keys(cls, value: list[str]) -> list[str]:
        for trace_key in value:
            if not ids.TRACE_KEY_RE.match(trace_key):
                raise ValueError(f"{trace_key!r} is not a trace key")
        return value


class EvaluateRequest(BaseModel):
    model_config = STRICT

    trigger: Literal["manual", "readiness"] = "manual"
    requested_by: str = ""
    run_version: int | None = Field(default=None, ge=1)
    new_run_version: bool = False


class ManualVerdict(BaseModel):
    """For cases whose method is Inspection or Demonstration (spec 1.5)."""

    model_config = STRICT

    tc_id: str = Field(pattern=ids.TC_ID_RE.pattern)
    verdict: Literal["pass", "fail"]
    note: str = ""
    author: str = Field(min_length=1)
    evidence_ref: str | None = None
    run_version: int | None = Field(default=None, ge=1)


class ReportRequest(BaseModel):
    model_config = STRICT

    run_version: int | None = Field(default=None, ge=1)
    requested_by: str = ""
    lessons_learned: str | None = None


class LessonsUpdate(BaseModel):
    model_config = STRICT

    lessons_learned: str


class EvaluationSubmission(BaseModel):
    """Internal: the evaluator hands its per-case results back to the API.

    The API owns the metric formulas, the requirement-verdict precedence, the
    blob archive and the outgoing topics, so those exist exactly once. The
    evaluator owns the criteria engine and the lake queries. Nothing is computed
    twice, so the 6.2 sum-check invariant cannot disagree between two copies.
    """

    model_config = STRICT

    test_run_id: str = Field(pattern=ids.TEST_RUN_ID_RE.pattern)
    run_version: int = Field(ge=1)
    evaluator_version: str
    results: list[dict] = Field(min_length=0)
    queries: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
