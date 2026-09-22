"""Processed-result models."""

from typing import Literal

from pydantic import ConfigDict, Field, model_validator

from api.errors import ApiError
from api.models.common import ApiModel, RequestModel, UtcDatetime
from api.models.journal import Actor

ProvenanceStatus = Literal["verified", "flagged"]

# The six keys the contract makes mandatory on every result.
PROVENANCE_KEYS = (
    "tool",
    "tool_version",
    "parameters",
    "input_file_ids",
    "produced_by",
    "produced_at",
)


def _is_blank(value) -> bool:
    """Answer True for a value that carries no provenance.

    A blank value is None, an empty or whitespace-only string, or a list
    that holds a blank entry. An **empty** input_file_ids list is not blank:
    it is well-formed, so the route stores it and flags it.
    """
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, list):
        return any(_is_blank(entry) for entry in value)
    return False


class Provenance(RequestModel):
    """Mandatory on every result. All six keys are required.

    It is a RequestModel, so an unknown key inside the block answers 422
    (contract §A). An unknown key never reaches the fingerprint, so a body
    that carries one would otherwise hash like the body without it, and the
    replay rule would answer 200 and discard the caller's change.
    """

    tool: str
    tool_version: str
    parameters: str
    input_file_ids: list[str]
    # produced_by ends in a journal entry, so it takes the shared Actor type.
    # The provenance_required gate catches a blank value first. It never tests
    # for a placeholder, so only this type answers 422 for "current-user".
    produced_by: Actor
    produced_at: UtcDatetime


class ProvenanceOut(ApiModel):
    """The response view of the provenance block. It never refuses a document.

    Contract §A: "A block that a response also uses gets a separate input
    model, never a shared one... a stored document written by an older build
    must never turn a read into a 500. So the gate sits on the input model
    only." `Provenance` is that gate and it stays strict. This model reads.

    So every field carries a default and unknown keys pass. A document that an
    older build wrote, or that a later build extends, still reads as 200.
    `produced_by` is a plain string here: the `Actor` rules gate the write, and
    a stored name that breaks them must not break the read.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    tool: str = ""
    tool_version: str = ""
    parameters: str = ""
    input_file_ids: list[str] = Field(default_factory=list)
    produced_by: str = ""
    produced_at: UtcDatetime | None = None


class Verdict(RequestModel):
    """The verdict block a run's evaluator writes (dev-planning/requirement-
    status-from-runs/spec.md §6). Optional on every result; absent on every
    one that is not a verdict. `BL-11` writes this; this build only reads it.

    `result_key` should be `"verdict/<definition_id>"` by convention, but the
    projection reads `definition_id` here, never the key.
    """

    definition_id: str
    outcome: Literal["pass", "fail", "error"]
    evidence: dict = Field(default_factory=dict)
    # 64 hex, the full sha256 of the implementation `.py` that decided this
    # outcome — the artefact `test_definitions.implementation.sha256` names.
    implementation_sha256: str


class VerdictOut(ApiModel):
    """The response view of the verdict block. Never refuses a document."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    definition_id: str = ""
    outcome: Literal["pass", "fail", "error"] = "error"
    evidence: dict = Field(default_factory=dict)
    implementation_sha256: str = ""


class ResultEdit(ApiModel):
    """A person edited this result. Read from the journal, never stored twice.

    The registry keeps one record of a change: the journal entry. This block
    reads that record back, so the mark can never drift from the timeline.
    `fields` holds the journal field labels of every manual change, sorted.
    """

    at: UtcDatetime
    actor: str
    fields: list[str]


class ResultBody(ApiModel):
    # The collection stores the minted id in _id. The wire keeps "result_id".
    result_id: str = Field(validation_alias="_id")
    run_id: str
    name: str
    result_key: str
    version: int
    supersedes: str | None
    description: str | None
    storage_ref: str | None
    provenance: ProvenanceOut
    provenance_status: ProvenanceStatus
    created_at: UtcDatetime
    # Null until a person edits the result through PATCH /results/{result_id}.
    # The router reads the mark from the journal. No route stores it.
    edited: ResultEdit | None = None
    # Null on every result but a verdict. See `Verdict`.
    verdict: VerdictOut | None = None


class ResultCreateRequest(RequestModel):
    """Body of POST /results (appendix ★).

    provenance is Optional in the annotation only. The validator below runs
    first and rejects a body that omits it, so the route always sees it.
    """

    run_id: str
    name: str
    result_key: str
    description: str | None = None
    storage_ref: str | None = None
    provenance: Provenance | None = None
    verdict: Verdict | None = None

    @model_validator(mode="before")
    @classmethod
    def _require_full_provenance(cls, data):
        """Answer 422 provenance_required for a missing or blank key.

        This runs before the field validation, so the caller reads the
        contract's code and not a generic Pydantic error. The gate is
        mandatory. Never weaken it.
        """
        if not isinstance(data, dict):
            return data
        block = data.get("provenance")
        if not isinstance(block, dict):
            raise ApiError(422, "provenance is required", "provenance_required")
        for key in PROVENANCE_KEYS:
            if key not in block or _is_blank(block[key]):
                raise ApiError(
                    422, f"provenance.{key} is required", "provenance_required"
                )
        return data


class ProvenancePatch(RequestModel):
    """Every key optional. A stated key must not be blank.

    A key that is absent is not a change. A key stated as null counts as
    absent too, exactly as PATCH /files treats a null, so this block never
    clears a provenance value.
    """

    tool: str | None = None
    tool_version: str | None = None
    parameters: str | None = None
    input_file_ids: list[str] | None = None
    # produced_by ends in a journal entry, so it takes the shared Actor type.
    # The gate below catches a blank value first. It never tests for a
    # placeholder, so only this type answers 422 for "current-user".
    produced_by: Actor | None = None
    produced_at: UtcDatetime | None = None

    @model_validator(mode="before")
    @classmethod
    def _refuse_a_blank_value(cls, data):
        """Answer 422 provenance_required for a stated key that is blank.

        This runs before the field validation, so the caller reads the
        contract code and not a generic Pydantic error. It is the same code
        and the same rule ResultCreateRequest answers. Never weaken it.
        """
        if not isinstance(data, dict):
            return data
        for key in PROVENANCE_KEYS:
            if key not in data or data[key] is None:
                continue
            if _is_blank(data[key]):
                raise ApiError(
                    422, f"provenance.{key} must not be blank", "provenance_required"
                )
        return data


class ResultPatchRequest(RequestModel):
    """Body of PATCH /results/{result_id} (contract §B #18d).

    A person corrects the label or the provenance of a stored result version.

    The identity of the version stays out of this body. `run_id`, `result_key`,
    `version`, `supersedes`, `storage_ref`, `provenance_status`, `created_at`
    and `result_id` are minted or derived, and the version chain rests on them.
    `extra="forbid"` answers 422 for each one and names the key.
    """

    name: str | None = None
    description: str | None = None
    provenance: ProvenancePatch | None = None
    actor: Actor
    note: str | None = None
