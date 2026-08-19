from datetime import datetime
from typing import Any, Generic, TypeVar
from enum import Enum
from math import ceil

from pydantic import BaseModel, Field

from .utils import now


# Generic type for paginated responses
T = TypeVar("T")

# Largest page a list endpoint will serve. Kept as a hard ceiling rather than a discrete
# allow-list: a range is expressible as a Pydantic constraint, so FastAPI rejects an
# out-of-range value itself with a 422 instead of the model raising mid-dependency and
# Starlette turning that into a 500 (which is what `?page_size=1` used to do).
MAX_PAGE_SIZE = 200


class PaginationParams(BaseModel):
    """Pagination parameters for list endpoints.

    ``page_size`` is any value in 1..MAX_PAGE_SIZE. The former allow-list
    ``[10, 20, 50, 100, 200]`` is a superset of nothing a UI needs and rejected legitimate
    requests such as ``page_size=1``; every previously-allowed value is still valid.
    """

    page: int = Field(default=1, ge=1, description="Page number (1-indexed)")
    page_size: int = Field(
        default=20,
        ge=1,
        le=MAX_PAGE_SIZE,
        description=f"Number of items per page (1-{MAX_PAGE_SIZE})",
    )


class PaginatedResponse(BaseModel, Generic[T]):
    """Generic paginated response wrapper."""

    items: list[T]
    total: int = Field(description="Total number of items across all pages")
    page: int = Field(description="Current page number")
    page_size: int = Field(description="Number of items per page")
    total_pages: int = Field(description="Total number of pages")

    @classmethod
    def create(cls, items: list[T], total: int, page: int, page_size: int) -> "PaginatedResponse[T]":
        """Helper method to create a paginated response."""
        total_pages = ceil(total / page_size) if page_size > 0 else 0
        return cls(
            items=items,
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
        )


class TestStatus(str, Enum):
    DRAFT = "draft"
    IN_PROGRESS = "in_progress"
    FINISHED = "finished"


class DeviceReference(BaseModel):
    """Reference to a Device with its version snapshot."""

    device_id: str
    device_version: str | None = None  # UUID of DeviceJournalEntry, set when test starts


class File(BaseModel):
    """Represents a file in blob storage."""

    id: str
    name: str
    url: str
    size: int
    uploaded_at: datetime = Field(default_factory=now)


class PresignedUploadResponse(BaseModel):
    url: str


class PresignedUploadRequest(BaseModel):
    filename: str


class Link(BaseModel):
    """Represents an external link."""

    id: str
    url: str
    label: str


class LinkCreate(BaseModel):
    """Represents the data to create a link."""

    url: str
    label: str


class TcUpload(BaseModel):
    """One measurement file attached to one planned test case of a V-model run.

    ``upload_id`` is the id the mf4-to-blob service returns from ``POST /upload/direct`` -
    the handle on the record it wrote to the lakehouse. It is captured synchronously from
    that response, so nothing here consumes a Kafka topic to learn it.
    """

    tc_id: str = Field(..., description="Test case the file was uploaded for, e.g. ACC-SYS-TC-011")
    upload_id: str | None = Field(
        None,
        description=(
            "mf4-to-blob upload id == lakehouse record id. Optional: a run may be planned "
            "from test cases alone and have its measurement attached later."
        ),
    )
    filename: str | None = None
    blob_path: str | None = None
    size_bytes: int | None = None
    sha256: str | None = None
    attached_utc: datetime = Field(default_factory=now)


class VModelRun(BaseModel):
    """V-model evaluation metadata on a Test. ``None`` on every Phase 2 bench test.

    A Test that carries this sub-document is a *Test Run* in V-model terms: an evaluation
    pinned to exactly one baseline. ``baseline_id`` is a write-once pin - versions never mix,
    and a report must be reproducible from its baseline alone. See
    ``docs/domain_model_requirements.md`` section "V-model run metadata".
    """

    baseline_id: str = Field(..., description="Write-once pin. A differing re-pin is a 409.")
    run_version: int = 1
    label: str | None = Field(None, description="Human label shown in the run lists")
    selector: str | None = Field(None, description="e.g. 'all' or 'chapter:Performance'")
    planned_tc_ids: list[str] = Field(
        default_factory=list, description="Server-side expansion of selector, frozen at pin time"
    )
    tc_uploads: list[TcUpload] = Field(
        default_factory=list,
        description="Per-test-case MF4 attachments; the lakehouse handle for each planned case",
    )
    trace_keys: list[str] = Field(default_factory=list, description="Mirrors vm_run_traces")
    created_utc: datetime = Field(default_factory=now)
    evaluated_utc: datetime | None = None
    sw_version: str | None = None
    hw_version: str | None = None
    config_hash12: str | None = None


class Test(BaseModel):
    """Represents a single test record in the database."""

    test_id: str = Field(..., alias="_id")
    campaign_id: str
    # Array of Device references with versions. A Phase 2 bench test must carry at least one -
    # that invariant is enforced where tests are *created* (TestCreate.devices is required and
    # POST /tests rejects an empty list). It is deliberately not enforced here, because a
    # V-model Test Run is created from test cases and measurement files alone: it has no
    # Device Under Test at plan time, only a `vmodel` sub-document. See VModelRun.
    devices: list[DeviceReference] = Field(default_factory=list)
    environment_id: str  # Test environment identifier
    environment_version: str | None = None  # UUID of environment journal entry, set when test starts
    operator: str
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)
    sensors: dict[str, dict[str, Any]]
    config_id: str
    config_type: str | None = None  # From Dynamic Configuration metadata.type
    target_key: str | None = None  # From Dynamic Configuration metadata.target_key
    config_version: int | None = None  # From Dynamic Configuration metadata.version
    links: list[Link] = Field(default_factory=list)
    files: dict[str, File] = Field(default_factory=dict)
    status: TestStatus = TestStatus.DRAFT
    start: datetime | None = None
    end: datetime | None = None
    vmodel: VModelRun | None = Field(
        None, description="V-model run metadata. Additive and nullable; no backfill needed."
    )


class TestCreate(BaseModel):
    """Represents the data required to create a test."""

    test_id: str
    campaign_id: str
    devices: list[DeviceReference]  # Required, at least one device
    environment_id: str
    operator: str
    sensors: dict[str, dict[str, Any]]
    status: TestStatus = TestStatus.DRAFT
    start: datetime | None = None
    end: datetime | None = None


class TestUpdate(BaseModel):
    """Represents the updatable fields of a test."""

    campaign_id: str | None = None
    devices: list[DeviceReference] | None = None
    environment_id: str | None = None
    operator: str | None = None
    sensors: dict[str, dict[str, Any]] | None = None
    status: TestStatus | None = None
    start: datetime | None = None
    end: datetime | None = None


class TestQuery(PaginationParams):
    """Defines the available query parameters for filtering tests with pagination."""

    test_id: str | None = None
    campaign_id: str | None = None
    device_id: str | None = None  # Filter tests containing this device
    environment_id: str | None = None
    operator: str | None = None
    status: TestStatus | None = None
    has_vmodel: bool | None = Field(
        None, description="True lists only V-model runs, False only Phase 2 bench tests"
    )
    q: str | None = None


class TestFullData(BaseModel):
    """Represents a test with all its related data (files, logbook, links)."""

    test: Test
    files: list[File]
    logbook: list["LogbookEntry"]
    links: list[Link]


class LogbookEntry(BaseModel):
    """Represents a single logbook entry for a test."""

    id: str = Field(..., alias="_id")
    test_id: str
    created_at: datetime = Field(default_factory=now)
    timestamp: datetime = Field(default_factory=now)
    operator: str
    content: str
    sensor_ids: list[str] = []


class LogbookEntryCreate(BaseModel):
    """Represents the data required to create a logbook entry."""

    operator: str
    content: str
    sensor_ids: list[str] = []
    timestamp: datetime = Field(default_factory=now)


class LogbookEntryUpdate(BaseModel):
    """Represents the updatable fields of a logbook entry."""

    operator: str | None = None
    content: str | None = None
    sensor_ids: list[str] | None = None
    timestamp: datetime | None = None


# ============================================================================
# Device Models
# ============================================================================


class DeviceStatus(str, Enum):
    """Device operational status."""

    CREATED = "created"
    SETUP = "setup"
    STORED = "stored"
    SCRAPPED = "scrapped"


class JournalCategory(str, Enum):
    """Device journal entry categories."""

    SAFETY_REQUIREMENTS = "Safety Requirements"
    SETUP = "Setup"
    TESTING = "Testing"
    CHANGE_LOCATION = "Change-Location"
    HW_MODIFICATION = "HW Modification"
    SW_MODIFICATION = "SW Modification"


class Device(BaseModel):
    """Represents a Device Under Test - the sample being tested."""

    device_id: str = Field(..., alias="_id")
    status: DeviceStatus = DeviceStatus.CREATED
    status_note: str | None = None
    created_at: datetime = Field(default_factory=now)
    updated_at: datetime = Field(default_factory=now)
    creator: str
    last_editor: str

    # Product fields (strings from lookups)
    manufacturer: str
    product_category: str
    product_name: str
    product_type: str | None = None
    product_variant: str | None = None
    product_key: str | None = None

    # Sample fields
    sample_type: str
    sample_nr: str | None = None
    sample_id: str  # Derived: {sample_type} or {sample_type}-{sample_nr}

    # Organization info
    sample_owner: str | None = None
    location: str
    project: str | None = None
    picture_link: str | None = None

    # Misc metadata
    software_bundle: str | None = None
    hardware_link: str | None = None
    comment: str | None = None
    attended_operation: bool = False  # Calculated from safety requirements
    unattended_operation: bool = False  # Calculated from safety requirements


class DeviceCreate(BaseModel):
    """Represents the data required to create a device."""

    device_id: str
    manufacturer: str
    product_category: str
    product_name: str
    product_type: str | None = None
    product_variant: str | None = None
    product_key: str | None = None
    sample_type: str
    sample_nr: str | None = None
    location: str
    status: DeviceStatus = DeviceStatus.CREATED
    status_note: str | None = None
    sample_owner: str | None = None
    project: str | None = None
    picture_link: str | None = None
    software_bundle: str | None = None
    hardware_link: str | None = None
    comment: str | None = None
    creator: str
    journal_text: str | None = None
    journal_category: JournalCategory | None = None


class DeviceUpdate(BaseModel):
    """Represents the updatable fields of a device.

    All device fields (except _id, created_at, updated_at, creator) can be updated.
    Field-level immutability restrictions can be enforced in the frontend if needed.
    """

    # Product fields
    manufacturer: str | None = None
    product_category: str | None = None
    product_name: str | None = None
    product_type: str | None = None
    product_variant: str | None = None
    product_key: str | None = None

    # Sample fields
    sample_type: str | None = None
    sample_nr: str | None = None

    # Status
    status: DeviceStatus | None = None
    status_note: str | None = None

    # Organization info
    location: str | None = None
    project: str | None = None
    sample_owner: str | None = None
    picture_link: str | None = None

    # Misc metadata
    software_bundle: str | None = None
    hardware_link: str | None = None
    comment: str | None = None

    # Audit
    last_editor: str | None = None

    # Journal metadata (not stored on device, used for journal entry creation)
    journal_text: str | None = None
    journal_category: JournalCategory | None = None


class DeviceQuery(PaginationParams):
    """Defines the available query parameters for filtering devices with pagination."""

    device_id: str | None = None
    status: DeviceStatus | None = None
    manufacturer: str | None = None
    product_category: str | None = None
    product_name: str | None = None
    sample_type: str | None = None
    sample_id: str | None = None
    location: str | None = None
    project: str | None = None
    creator: str | None = None
    q: str | None = None  # Text search across multiple fields
    id_search: str | None = None  # Quick search by Device ID or Sample ID only


class DeviceJournalEntry(BaseModel):
    """Represents an immutable journal entry for a device."""

    device_version: str = Field(..., alias="_id")  # UUID
    device_id: str
    timestamp: datetime = Field(default_factory=now)
    editor: str
    category: JournalCategory | None = None
    text: str
    data: dict[str, Any]  # Full JSON snapshot of device at this point in time


class DeviceJournalEntrySummary(BaseModel):
    """Represents a journal entry without the full device snapshot data.

    This lighter model is optimized for list views where full snapshots
    are not needed, significantly reducing response payload size.
    """

    device_version: str = Field(..., alias="_id")  # UUID
    device_id: str
    timestamp: datetime
    editor: str
    category: JournalCategory | None = None
    text: str


class DeviceJournalEntryCreate(BaseModel):
    """Represents the data required to create a device journal entry.

    Note: device_id and data are not included here as they are derived by the
    route handler from the URL path and current device state.
    """

    editor: str
    category: JournalCategory | None = None
    text: str


class DeviceUpdatePreview(BaseModel):
    """Preview of a device update showing suggested journal text."""

    suggested_text: str
    changed_fields: list[str]


# ============================================================================
# Lookup Table Models - Phase 2
# ============================================================================


class SampleType(BaseModel):
    """Represents a sample type lookup value."""

    id: str = Field(..., alias="_id")
    sample_type: str


class Location(BaseModel):
    """Represents a location lookup value."""

    id: str = Field(..., alias="_id")
    location: str


class ProductCategory(BaseModel):
    """Represents a product category lookup value."""

    product_category: str = Field(..., alias="_id")  # Business key
    name: str  # Human-readable name


class Product(BaseModel):
    """Represents a product in the catalog."""

    id: str = Field(..., alias="_id")
    manufacturer: str
    product_category: str  # References ProductCategory._id
    product_name: str
