"""Signal models: catalogue rows, detail, per-run stats (Lane B surface)."""

from datetime import date
from typing import Literal

from pydantic import Field

from api.models.common import ApiModel, FieldSources, Page, RequestModel, Source, UtcDatetime
from api.models.journal import Actor

# unit_source reuses the shared Source enum, so the api:catalogue string
# lives in exactly one place.
UnitSource = Source


class SignalStats(ApiModel):
    """The numbers a row of §7 or a file detail carries.

    The first four are always present. `rms` and the three percentiles are
    optional, because nobody has to measure them and a percentile does not
    merge over two files. A null reads as "nobody measured this", and the
    screen prints a dash. It never reads as a zero.
    """

    min: float
    max: float
    mean: float
    std: float
    rms: float | None = None
    p50: float | None = None
    p95: float | None = None
    p99: float | None = None


class SignalStatsInput(RequestModel):
    """The stats block a POST /files body carries.

    It repeats the SignalStats fields on purpose. The unknown-key gate belongs
    where the caller's bytes arrive. A response builds SignalStats from a
    stored document, and a stored document must never turn a read into a 500.

    `sample_count` states how many samples the producer folded into the four
    numbers. It is optional, and the response shape does not carry it: it
    weighs the merge, it is not a statistic a screen shows.

    A run of two files can only merge exactly when every file states its own
    count, so a producer that measures one must say so. The merge reads it in
    `api/services/queries_stats.py`, and a signal whose files state no count
    still falls through to the lake.

    The field takes any integer. A zero or a negative number is not a count,
    and `_sample_count` drops such a value, so the signal falls to the lake
    instead. A bound here would answer 422 and cost every other signal of the
    body its row, which is a far worse trade than one lake query.

    `rms`, `p50`, `p95` and `p99` are the other quantities FR-DM-014 names,
    and each one is optional in the same way. A producer that measures none of
    them registers exactly as before.

    The four do not behave alike over a run of two files:

    * **`rms` merges exactly.** It is a mean of squares, so the run's value
      comes from the per-file values and the sample counts.
    * **A percentile does not merge.** Two medians do not give the median of
      the union, and no arithmetic on the six numbers recovers it. A run of
      two or more measured files therefore lists a blank `p50`, a blank `p95`
      and a blank `p99`. `queries_stats.py` states the rule and never
      approximates one.
    """

    min: float
    max: float
    mean: float
    std: float
    sample_count: int | None = None
    rms: float | None = None
    p50: float | None = None
    p95: float | None = None
    p99: float | None = None


class FileSignal(ApiModel):
    """A signal as one file (or one run) carries it."""

    name: str
    unit: str | None
    unit_source: UnitSource
    rate_hz: float
    dtype: str
    stats: SignalStats | None


class StatsUnavailable(ApiModel):
    """Why a run-signals page carries blank numbers (contract #7).

    The field is present when at least one signal of the run carries no
    measured numbers. It states how much of the run the ingestion pipeline
    measured, so a blank cell always has a reason and never reads as a zero.

    Two reasons, and neither ever stands for the other:

    * `not_measured` — no signal of the run carries numbers.
    * `partly_measured` — some signals carry numbers and some do not.

    A page without the field carries a number on every row.

    The field names no lake and no variable, because this route reads the
    registry only. A lake this process cannot reach, and a lake that fails,
    both leave this page exactly as it is. The lake still serves Explore and
    `GET /signals/{name}/stats`, and those still fail loudly.
    """

    reason: Literal["not_measured", "partly_measured"]
    detail: str


class RunSignalPage(Page[FileSignal]):
    """The #7 envelope. `stats_unavailable` is absent on a fully measured page."""

    stats_unavailable: StatsUnavailable | None = None


class SignalRow(ApiModel):
    """The catalogue list row from contract #14."""

    # The catalogue stores the signal name in _id. The wire keeps "name".
    name: str = Field(validation_alias="_id")
    description: str | None
    unit: str | None
    unit_source: UnitSource
    dtype: str
    typical_rate_hz: float
    run_count: int
    first_seen: UtcDatetime
    last_seen: UtcDatetime


class SignalViewCounts(ApiModel):
    """Whole-table, filter-independent quick-view counts for /signals."""

    all: int
    missing_unit: int


class SignalPage(Page[SignalRow]):
    """/signals response envelope. ``view_counts`` optional per §3.6."""

    view_counts: SignalViewCounts | None = None


class SignalFacets(ApiModel):
    """The distinct filter values of the whole catalogue (contract #14b).

    The list route serves one page. The largest page is 500 rows and the
    catalogue holds 6,412 signals, so a filter list built from a page misses
    most of the values. This model answers over every document instead.
    """

    units: list[str]
    rates: list[float]
    rigs: list[str]
    # The data type of the stored signal (FR-DM-111). The catalogue row always
    # carries one, so this list never drops a row the way ``units`` does.
    dtypes: list[str]
    # The producing systems the catalogue learned from the files (FR-DM-111).
    # A row written before the field existed carries an empty list, so the
    # facet stays short until the backfill runs.
    source_systems: list[str]


class SignalDetail(SignalRow):
    """The catalogue detail from contract #15."""

    sensor_ref: str | None
    catalogue_ref: str | None
    rig_ids: list[str]
    # Every source system that produced a file carrying this signal
    # (FR-DM-111). The ingest grows it with ``$addToSet``, exactly as it grows
    # ``rig_ids``. The default keeps a row written before the field existed
    # readable, so no read fails while the backfill waits.
    source_systems: list[str] = Field(default_factory=list)
    field_sources: FieldSources


class SignalPatchRequest(RequestModel):
    """Body of PATCH /signals/{name}. catalogue_ref is not patchable."""

    unit: str | None = None
    description: str | None = None
    sensor_ref: str | None = None
    actor: Actor
    note: str | None = None
    context_run_id: str | None = None


class SignalStatsRow(ApiModel):
    """One run of one signal (contract #16).

    QuixLake computes all eight numbers, so a lake-served row carries them
    all. A row the registry serves carries what the pipeline measured, and a
    run of two or more measured files carries no percentile at all.
    """

    run_id: str
    definition_id: str | None
    rig_id: str
    run_date: date
    status: Literal["complete", "awaiting_work_order", "invalid"]
    min: float
    max: float
    mean: float
    std: float
    rms: float | None = None
    p50: float | None = None
    p95: float | None = None
    p99: float | None = None


class SignalStatsResponse(ApiModel):
    """The stats envelope from contract #16."""

    name: str
    unit: str | None
    window: Literal["run"]
    items: list[SignalStatsRow]
    total: int
    page: int
    page_size: int
    total_pages: int
