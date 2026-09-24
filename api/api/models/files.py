"""File models (Lane B surface)."""

from typing import Annotated, Literal

from pydantic import AfterValidator, Field, model_validator

from api.errors import ApiError
from api.models.common import ApiModel, FieldSources, Page, RequestModel, UtcDatetime
from api.models.journal import Actor, JournalEntry
from api.models.runs import InvalidFlag
from api.models.signals import FileSignal, SignalStatsInput

# "api" marks a logical file minted by POST /test-runs/{run_id}/signals
# (PROPOSED, second wave). The other three name physical file producers.
SourceSystem = Literal["TAS", "INCA", "ifile", "api"]
ChecksumState = Literal["verified", "mismatch", "unverified"]
FileStatus = Literal["registered", "quarantined"]
# Added 20 Aug 2026. `lifecycle` is separate from `status`. `status` is the
# verdict of the registry. `lifecycle` states what a person did with the
# record afterwards. A stored document without the field counts as active.
FileLifecycle = Literal["active", "archived", "deleted"]

# The outcome of one ingestion stage (FR-DM-006b, 20 Aug 2026). The pipeline
# runs the sync, the upload and the conversion outside this repository, and it
# reports each outcome here. `None` means no stage report arrived, so a screen
# reads it as unknown, never as failed.
StageStatus = Literal["pending", "in_progress", "success", "failed"]

# The longest filename the registry takes. Every common filesystem stops at 255
# bytes for one path segment, so a longer name never came off a rig.
FILENAME_LIMIT = 255


def _check_filename(value: str) -> str:
    """Refuse a filename that cannot travel in a response header.

    A control character breaks `Content-Disposition`: a bare CR or LF splits
    the header block, and the download route builds that header **after** it
    journals the download. So a name with a newline in it wrote the audit row
    and then failed the request, and the journal claimed a download nobody
    received. The registry refuses the name at its own door instead
    (21 Aug 2026).

    The check reads the value the caller sent, so a trailing newline never
    passes as a clean name. The stored name is the stripped one, as `Actor` is.
    """
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("must name the stored object")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("must carry no control character")
    return cleaned


def _no_invalid_flag() -> InvalidFlag:
    """The unflagged block. A file nobody marked serves exactly this."""
    return InvalidFlag(flagged=False, reason=None, actor=None, at=None)


# Every registration body states the filename through this type.
Filename = Annotated[
    str, Field(min_length=1, max_length=FILENAME_LIMIT), AfterValidator(_check_filename)
]


class FileBody(ApiModel):
    """The list-row body from contract #12."""

    # The collection stores the minted id in _id. The wire keeps "file_id".
    file_id: str = Field(validation_alias="_id")
    filename: str
    run_id: str | None
    source_system: SourceSystem
    format: str
    size_bytes: int
    checksum_sha256: str
    checksum_state: ChecksumState
    status: FileStatus
    quarantine_reason: str | None
    # The physical car the recording came off, as the ingestion path resolved
    # it from the upload claim or the MF4 header. It sits on the FILE and
    # nowhere else: a run holds several files and a file states what its own
    # bytes came off, so a file that re-links to another run keeps its answer.
    # A file registered before this field existed carries no key, and that
    # reads as "nobody named a car".
    vehicle: str | None = None
    # The three stage outcomes and the error detail of a failed stage. A file
    # written before FR-DM-006b holds none of the four keys, so each defaults
    # to None and the old document still serves.
    sync_status: StageStatus | None = None
    upload_status: StageStatus | None = None
    conversion_status: StageStatus | None = None
    stage_error: str | None = None
    lifecycle: FileLifecycle = "active"
    # Added 24 Aug 2026. The invalid mark at file level, the same block the run
    # carries (`InvalidFlag` in api/api/models/runs.py). A file registered
    # before this day holds no key, so the default states the unflagged block
    # and the old document still serves.
    #
    # It is a field of its own, never a `status` value. `status` is the verdict
    # of the registry about the bytes, and a person's judgment must not
    # overwrite it: a quarantined file that a person marks invalid stays
    # quarantined, and a cleared mark restores nothing.
    invalid: InvalidFlag = Field(default_factory=_no_invalid_flag)
    # Added 20 Aug 2026 with raw-file versioning. The first upload is version
    # 1, and a stored document without the field is version 1 too.
    version: int = 1
    signal_count: int
    time_start: UtcDatetime | None
    time_end: UtcDatetime | None
    registered_at: UtcDatetime


class FileDetail(FileBody):
    """The single-call detail body from contract #13."""

    # A quarantined file may carry no storage reference. The never-drop rule
    # keeps the file the registry could not place (contract 13).
    storage_ref: str | None
    ingestion_job_id: str | None
    # Added 20 Aug 2026. The file id of the previous version, or null on the
    # first version. `GET /files/{file_id}/versions` serves the whole chain.
    supersedes: str | None = None
    field_sources: FieldSources
    ingestion_timeline: list[JournalEntry]
    signals: list[FileSignal]


class FileListEnvelope(ApiModel):
    """Contract #6: the unpaginated items envelope."""

    items: list[FileBody]
    total: int


class FileViewCounts(ApiModel):
    """Whole-table, filter-independent quick-view counts for /files."""

    all: int
    registered: int
    quarantined: int
    # The two counts below arrived on 20 Aug 2026 with the soft delete.
    # `all`, `registered` and `quarantined` count the files that are not
    # deleted. `deleted` counts the recycle bin.
    archived: int
    deleted: int


class FilePage(Page[FileBody]):
    """/files response envelope. ``view_counts`` optional per §3.6."""

    view_counts: FileViewCounts | None = None


class FileSignalInput(RequestModel):
    """One signal inventory row in a POST /files body."""

    name: str
    unit: str | None = None
    rate_hz: float
    dtype: str
    stats: SignalStatsInput | None = None


class FileRegisterRequest(RequestModel):
    """Body of POST /files (appendix ★, ingestion path)."""

    filename: Filename
    run_id: str | None = None
    source_system: SourceSystem
    format: str
    size_bytes: int
    checksum_sha256: str
    checksum_state: ChecksumState = "unverified"
    # The car the bytes came off, resolved by the ingestion path
    # (`tm-connector/connector/identity.py::resolve_vehicle`). Optional: a
    # producer that names none states none.
    vehicle: str | None = None
    # The stage outcomes the pipeline already knows at registration time
    # (FR-DM-006b). A later outcome arrives through PATCH /files/{file_id}.
    sync_status: StageStatus | None = None
    upload_status: StageStatus | None = None
    conversion_status: StageStatus | None = None
    stage_error: str | None = None
    quarantine_reason: str | None = None
    storage_ref: str | None = None
    ingestion_job_id: str | None = None
    time_start: UtcDatetime | None = None
    time_end: UtcDatetime | None = None
    signals: list[FileSignalInput] = Field(default_factory=list)


class FileVersionRegisterRequest(FileRegisterRequest):
    """Body of POST /files/{file_id}/versions (added 20 Aug 2026).

    It repeats the registration body, because a version is a whole file: it
    carries its own bytes, its own checksum and its own storage reference.

    A person uploads a version, so `actor` is required and the version journal
    entry carries the `manual` tag. `note` says why the file changed.

    `run_id` stays optional. A body that names no run inherits the run of the
    latest version, because a version of a run's file belongs to that run.
    """

    actor: Actor
    note: str | None = None


class FileLifecycleRequest(RequestModel):
    """Body of the three lifecycle routes: delete, archive and restore.

    A person states the change, so `actor` is required and the journal
    entry carries the `manual` tag. `note` says why.
    """

    actor: Actor
    note: str | None = None


class FileInvalidFlagRequest(RequestModel):
    """Body of the two file invalid-flag routes: the set and the clear.

    It repeats `InvalidFlagRequest` of the run lane rather than importing it,
    the way `_in_clause` is repeated across the two service files: the two
    lanes stay independent, and the refusal names a file instead of a run.
    """

    reason: str
    actor: Actor

    @model_validator(mode="before")
    @classmethod
    def _reason_required(cls, data):
        # Contract #5, read at file level: an absent OR blank reason answers
        # 422 reason_required, not the generic validation_error.
        if isinstance(data, dict) and not str(data.get("reason") or "").strip():
            raise ApiError(
                422, "A reason is required to flag a file invalid", "reason_required"
            )
        return data


class FilePatchRequest(RequestModel):
    """Body of PATCH /files/{file_id}. The run link and the stage outcomes.

    A file that names no run is orphaned, and the registry can no longer read
    the bytes, so it can no longer resolve a run key by itself. A person states
    the link instead.

    The three stage fields and `stage_error` carry a later pipeline outcome
    (FR-DM-006b). A re-run conversion reports here, and the ingestion timeline
    then shows the re-run. A stage outcome never ends a quarantine: only a
    `run_id` change reaches the promotion path.

    The facts about the bytes stay out of this body. The checksum, the size,
    the format and the checksum state carry the `embedded` tag, and the audit
    rests on them. The status, the quarantine reason and the signal count are
    derived at the registry's door. `extra="forbid"` answers 422 for each one.
    """

    run_id: str | None = None
    sync_status: StageStatus | None = None
    upload_status: StageStatus | None = None
    conversion_status: StageStatus | None = None
    stage_error: str | None = None
    actor: Actor
    note: str | None = None


# Epoch milliseconds. The upper bound keeps the value inside
# datetime.fromtimestamp's range, so a nonsense timestamp answers 422, not 500.
SampleTimestampMs = Annotated[int, Field(ge=0, le=253_402_300_799_999)]


class RunSignalSubmission(RequestModel):
    """One signal in a POST /test-runs/{run_id}/signals body (PROPOSED).

    ``samples`` rows are ``[timestamp_ms, value]`` pairs. ``rate_hz`` and
    ``dtype`` are optional: the route derives the rate from the samples the
    way the file parsers do (0.0 = unknown) and defaults the dtype to
    ``float64``, the numeric-sample convention.
    """

    name: str
    unit: str | None = None
    rate_hz: float | None = None
    dtype: str | None = None
    samples: list[tuple[SampleTimestampMs, float]] | None = None


class RunSignalsSubmitRequest(RequestModel):
    """Body of POST /test-runs/{run_id}/signals (PROPOSED, second wave)."""

    source_system: SourceSystem = "api"
    signals: list[RunSignalSubmission] = Field(min_length=1)
    actor: Actor


class RunSignalAccepted(ApiModel):
    """One accepted signal of a submission: the name and its sample rows."""

    name: str
    sample_count: int


class RunSignalsSubmitResponse(ApiModel):
    """Answer of POST /test-runs/{run_id}/signals (PROPOSED, second wave)."""

    file_id: str
    run_id: str
    accepted: list[RunSignalAccepted]
    # "written" — the rows reached QuixLake on this call. "deferred" — samples
    # arrived but no lake is configured; the registry keeps the inventory and
    # Mongo never stores sample values. "skipped" — nothing to move: the
    # payload carried no samples, or the call replayed a stored submission.
    samples: Literal["written", "deferred", "skipped"]
    sample_rows: int
