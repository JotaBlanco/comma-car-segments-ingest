"""Pydantic models for the V-model (systems-engineering) domain.

Kept in a separate module from ``models.py`` (426 lines) so neither file breaches the
~500-line ceiling. Nothing here touches the Phase 2 Test/Device/Environment models; the
collections are prefixed ``vm_`` for the same reason.

Reused from ``models.py``: ``PaginationParams``, ``PaginatedResponse``.
"""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field

from .models import PaginationParams
from .utils import now

# Project/feature are project-level constants: the requirement schema has no per-item
# project or feature field. Defined once here and once in the frontend constants module.
VMODEL_PROJECT = "QuixPlatformVehicle"
VMODEL_FEATURE = "ACC"

CHAPTERS = ("Performance", "Safety-Fault-Handling", "Functional-HMI")

# req_id prefix -> chapter. Mirrors tools/accreqs/validate.py in acc_project.
CHAPTER_BY_PREFIX = {
    "FUN": "Functional-HMI",
    "PRF": "Performance",
    "SAF": "Safety-Fault-Handling",
}

FIGURE_IDS = ("F1", "F2", "F3", "F4", "F5", "F6")


class RequirementStatus(str, Enum):
    """Requirement lifecycle status.

    All five values are in use in the published register. The ordinals are frozen in
    ``Reqs/export/reqif-enum-ordinals.json`` in acc_project - do not reorder or rename.
    """

    DRAFT = "Draft"
    REVIEWED = "Reviewed"
    APPROVED = "Approved"
    REJECTED = "Rejected"
    OBSOLETE = "Obsolete"


class ArtifactKind(str, Enum):
    """Kind of artifact set a version belongs to."""

    REQUIREMENTS = "requirements"
    TEST_SPECS = "test_specs"
    TEST_IMPL = "test_impl"
    SIGNAL_CATALOG = "signal_catalog"


class Measurand(BaseModel):
    """A quantity a requirement is verified against."""

    name: str
    unit: str


class Requirement(BaseModel):
    """One requirement at one artifact version.
    Immutable after insert. The same ``req_id`` appears once per artifact version and the
    documents genuinely differ between versions, which is why ``key`` carries the version.
    """

    key: str = Field(..., alias="_id", description="'{req_id}@{artifact_version}'")
    req_id: str
    artifact_version: str
    chapter: str
    title: str
    text: str
    ears_pattern: str
    system_states: list[str] = Field(default_factory=list)
    rationale: str
    source: list[str] = Field(default_factory=list)
    verification_tag: str
    verification_method: str
    measurand: list[Measurand] = Field(default_factory=list)
    status: RequirementStatus
    revision: str
    figure_refs: list[str] = Field(default_factory=list)
    related_reqs: list[str] = Field(default_factory=list)
    covering_tc_ids: list[str] = Field(
        default_factory=list,
        description=(
            "Test cases covering this requirement, derived from covers_req_ids on the test "
            "specs. Present on the list response so the client-side filter can offer "
            "coverage via its is_empty / is_not_empty operators."
        ),
    )
    verified_by: list[str] = Field(
        default_factory=list,
        description=(
            "Covering test cases that actually PASSED. A requirement with no covering test "
            "can never be verified; verification_tag is provenance, not test evidence."
        ),
    )
    last_change: datetime | None = Field(
        None,
        description="Absent from the canonical JSON export; stays null for seeded items.",
    )
    schema_version: str = "1.0.0"
    canonical_sha256: str = Field(..., description="Per-item canonical (sorted-key) sha256")


class FigureReference(BaseModel):
    """A figure referenced by a requirement, with the URL that serves it."""

    figure_id: str
    title: str
    url: str


class RelatedRequirement(BaseModel):
    """A related requirement resolved to a stub so the detail pane needs one call, not N."""

    req_id: str
    title: str
    status: str | None = None
    key: str | None = Field(None, description="'{req_id}@{artifact_version}', None if unresolved")


class RequirementDetail(Requirement):
    """A requirement plus everything the detail pane needs that is not stored on it."""

    figures: list[FigureReference] = Field(default_factory=list)
    related: list[RelatedRequirement] = Field(
        default_factory=list, description="related_reqs resolved at the same artifact version"
    )
    available_versions: list[str] = Field(
        default_factory=list,
        description="Every artifact version this req_id exists in, ascending.",
    )
    baseline_ids: list[str] = Field(
        default_factory=list,
        description="Baselines that pin this requirement's artifact version.",
    )
    covering_tc_ids: list[str] = Field(
        default_factory=list,
        description="Test cases covering this requirement, read from the pinning baselines' req_links.",
    )


class RequirementQuery(PaginationParams):
    """Query parameters for the requirement list endpoint.

    Deliberately narrow: the UI has no version selector, so the default response is every
    requirement across every version and the rich filtering (does not contain / is empty /
    OR) happens client-side. These parameters exist for direct API consumers only.
    """

    req_id: str | None = None
    chapter: str | None = None
    status: RequirementStatus | None = None
    revision: str | None = None
    verification_tag: str | None = None
    verification_method: str | None = None
    artifact_version: str | None = None
    baseline: str | None = Field(None, description="Narrow to the version this baseline pins")
    q: str | None = Field(None, description="Free-text match on req_id, title, text")
    page_size: int = Field(default=200, description="Defaults to 200 so one call returns the set")


class BaselineCounts(BaseModel):
    """Artifact counts frozen with a baseline."""

    requirements: int = 0
    test_cases: int = 0
    impls: int = 0
    covered_requirements: int = 0


class Baseline(BaseModel):
    """An immutable pin of one version of each artifact kind.

    ``req_links`` is the materialised reverse traceability index (requirement id -> test
    case ids), computed once at baseline creation. Coverage is read from here, never
    recomputed by scanning test specs at request time.
    """

    baseline_id: str = Field(..., alias="_id")
    label: str
    created_utc: datetime = Field(default_factory=now)
    created_by: str | None = None
    requirements_version: str
    test_specs_version: str | None = None
    test_impl_version: str | None = None
    signal_catalog_version: str | None = None
    set_hashes: dict[str, str] = Field(
        default_factory=dict, description="canonical sha256 of each pinned artifact set"
    )
    counts: BaselineCounts = Field(default_factory=BaselineCounts)
    baseline_coverage_static: float = Field(
        0.0, description="covered_requirements / requirements, 0..1"
    )
    req_links: dict[str, list[str]] = Field(default_factory=dict)
    notes: str | None = None


class ArtifactSet(BaseModel):
    """One immutable uploaded version of one artifact kind.

    Version numbers are allocated per kind, so the key is ``{kind}:{version}``: every kind
    has a ``v0001`` and a bare-version key let them overwrite one another.
    """

    key: str = Field(..., alias="_id", description="'{kind}:{artifact_version}'")
    artifact_version: str = Field(..., description="^v[0-9]{4}$")
    kind: ArtifactKind
    item_count: int
    item_ids: list[str] = Field(default_factory=list)
    canonical_sha256: str = Field(
        ..., description="sha256 over the canonical (sorted-key, minified) item set"
    )
    declared_canonical_sha256: str | None = Field(
        None, description="set_canonical_sha256 as declared by the uploaded document"
    )
    created_utc: datetime = Field(default_factory=now)
    created_by: str | None = None
    source_label: str | None = Field(None, description="Uploaded filename, or the fixture path")
    source_version: str | None = Field(None, description="'version' field of the source document")
    document_revision: str | None = None
    blob_path: str | None = Field(
        None, description="Blob storage path of the raw uploaded bytes, if any"
    )


class SeedResult(BaseModel):
    """Response of ``POST /vmodel/seed``: what was loaded, per collection."""

    reset: bool = Field(..., description="True when the vm_* collections were dropped first")
    counts: dict[str, int] = Field(
        default_factory=dict, description="Document count per vm_* collection after ingest"
    )
