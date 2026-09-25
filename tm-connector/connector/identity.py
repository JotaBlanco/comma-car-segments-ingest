"""Resolve one file's identity from the two channels, deterministically.

Two channels carry identity and they are NOT ranked as a whole:

* **declared** — the query-parameter bag the Test Bench sent to mf4-import,
  forwarded verbatim through `mf4_metadata.declared` and repeated on every
  batch. It exists at trigger time, in a browser form, before any byte is
  written.
* **header** — the MF4's own `<common_properties>` block, read by mf4-decoder
  and forwarded verbatim as `header_properties`. It is the only channel for a
  file our bench did not produce.

The registry cannot break the tie for us: a resolved claim is tagged
`Source.EMBEDDED` whatever the body says
(api/api/services/queries_runs.py:114-140 — "the pipeline states the id; it
never states the authority"), so both channels are equal-ranked there. The tie
MUST therefore be broken here, and the rule splits by KIND of field:

* identity & linkage (`run_id`, `rig_id`, `work_order_id`, `definition_ids`)
  — **declared wins**. These are assignments an operator makes, not properties
  of the bytes. Header-wins would make a re-upload with a corrected id
  impossible without editing the file. The definition SET wins or loses
  wholesale: a partial merge of two disagreeing assignments is what
  `_refuse_foreign_record` exists to prevent.
* measured facts (`started_at`, `ended_at`) — **header wins**. The file
  measured them; the form typed them.
* free-text context (`description`, `test_cell`, `operator`, `bench_sw`)
  — **declared wins**, typed by the person who knows.

* the car (`vehicle`) — **declared wins**, and it never reaches the run body.
  It states which physical vehicle THESE BYTES came off, so it belongs to the
  file the way `source_system` does; a file re-linked to another run keeps it.
* the platform (`platform`) — **declared wins**, read off the raw bags like the
  car. It does reach the run body, and the registry stores it on no run: it
  states the `project` of a campaign the upload opens
  (api/api/services/queries_runs.py::_open_claimed_work_order).

Nothing is destroyed by losing: `header_properties` rides verbatim on every
batch, and a disagreement is reported in the `file.header_parsed` note.

Two rules sit on top of the per-field precedence:

* the RUN KEY has one ladder — declared, header, filename, unresolved — and
  mf4-decoder climbs the identical four rungs from the same message
  (`resolve_run_key`). Two different answers put the run's catalogue in the
  registry and its rows in another lake partition, with nothing reporting it.
* a record that names a DIFFERENT run lends this run nothing but the window it
  measured (`_refuse_foreign_record`). A run wearing another run's work order
  reads as perfectly normal on screen.
"""

import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import PurePosixPath

from connector.config import DEFAULT_RUN_KEY_PATTERN

log = logging.getLogger("tm-connector.identity")

# The declared bag is forwarded untouched by mf4-import, which cannot know this
# vocabulary. The connector drops every key outside this set, because
# `RequestModel` is `extra="forbid"` (api/api/models/common.py:33-40) and an
# unknown field is a 422, not an ignored key. `source` and `actor` are
# deliberately absent: the registry overrides `source` anyway, and `actor` gates
# the journal, so an HTTP caller must never be able to forge one.
DECLARED_FIELDS = frozenset(
    {
        "run_id",
        "rig_id",
        "work_order_id",
        "definition_id",
        "definition_ids",
        "description",
        "test_cell",
        "operator",
        "bench_sw",
        "started_at",
        "ended_at",
    }
)

# The `test.*` block of `<common_properties>` -> the RunUpsertRequest field it
# feeds. The indirection is the point: a short registry field name, a namespaced
# MF4 key. `test.source_system` is not here — it feeds the FILE body, not the
# run body, and it is a closed enum (see `resolve_source_system`).
HEADER_RUN_FIELDS = {
    "test.run_key": "run_id",
    "test.rig": "rig_id",
    "test.work_order": "work_order_id",
    "test.cell": "test_cell",
    "test.operator": "operator",
    "test.bench_sw": "bench_sw",
    "test.description": "description",
    "test.started_at": "started_at",
    "test.ended_at": "ended_at",
}

# One trace answers several test cases, so the run's definitions are a SET.
# `<common_properties>` is a name->value map and `clean_header` builds a dict, so
# a repeated `<e name="test.definition">` cannot express one — only the last
# would survive. The set therefore rides in ONE comma-separated value.
#
# `test.definition` (singular) stays accepted and reads as a one-element list,
# and `test.definitions` wins when a file states both.
HEADER_LIST_FIELDS = {
    "test.definition": "definition_ids",
    "test.definitions": "definition_ids",
}

# Fields the operator assigns. Declared beats header.
LINKAGE_FIELDS = ("run_id", "rig_id", "work_order_id", "definition_ids")
# Fields the person typed. Declared beats header.
CONTEXT_FIELDS = ("description", "test_cell", "operator", "bench_sw")
# Fields the recording measured. Header beats declared.
MEASURED_FIELDS = ("started_at", "ended_at")

# Everything a record ASSERTS about a run, as opposed to what the bytes
# measured. The fallback refuses exactly this kind of field when a claims record
# names a different run (`CLAIM_FIELDS`, ingestion/watcher.py:82); `rig_id`,
# `operator` and `bench_sw` have no counterpart there but are assertions all the
# same, so the one reason covers them.
ASSERTED_FIELDS = frozenset(LINKAGE_FIELDS + CONTEXT_FIELDS)

# The bench's own rule: a timestamp at or before 1970-01-02 means "the source
# states none", not a real measurement (test-bench/generation.py:76, :806). A
# false 1970 window is worse than no window.
EPOCH_SENTINEL = datetime(1970, 1, 2, tzinfo=UTC)

# The car the recording came off. It is a property of the BYTES, like the
# source system beside it, so it is read off the raw bags and never joins the
# run body — `api/api/models/files.py::FileRegisterRequest` carries it, and one
# file names one car whatever run it later hangs from. The decoder climbs the
# same two rungs for the lake column (`mf4-decoder/identity.py::CLAIMED_COLUMNS`).
DECLARED_VEHICLE = "vehicle"
HEADER_VEHICLE = "test.vehicle"

# The platform the recording came off. `mf4-to-blob` sends it on every upload
# (static/claim-editor.js, the one claim with `alwaysSend`), and the header
# spells it WITHOUT the `test.` prefix: it sits in the recording's own
# provenance block, not in the bench's claim block
# (mf4-decoder/provenance.py::_PROVENANCE_KEYS).
DECLARED_PLATFORM = "platform"
HEADER_PLATFORM = "platform"

# `SourceSystem` is Literal["TAS", "INCA", "ifile", "api"]
# (api/api/models/files.py:13). "api" names a logical file minted by
# POST /test-runs/{run_id}/signals, never a physical producer, so it is never
# emitted here. An out-of-enum value is a 422, not an ignored key.
PHYSICAL_SOURCE_SYSTEMS = ("TAS", "INCA", "ifile")
SUFFIX_SOURCE_SYSTEM = {".mf4": "TAS", ".mdf": "TAS", ".csv": "ifile"}
DEFAULT_SOURCE_SYSTEM = "TAS"

# The literal the fallback watcher uses for a rig it cannot resolve
# (ingestion/watcher.py:119,121). `rig_id` is required on RunUpsertRequest and a
# sentinel is a valid non-empty value; inventing a plausible rig is not.
UNKNOWN_RIG = "UNKNOWN"


def _clean(value: object) -> str | None:
    """A usable declared/header value is a non-empty string. Anything else is absent."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def split_ids(value: object) -> list[str]:
    """Read a comma-separated id list. Blanks and surrounding space drop out."""
    cleaned = _clean(value)
    if cleaned is None:
        return []
    return [part.strip() for part in cleaned.split(",") if part.strip()]


def clean_declared(declared: object) -> dict[str, object]:
    """Keep the declared keys the registry knows, drop the rest.

    mf4-import forwards an unrecognised `declared.*` key rather than rejecting
    it, because it cannot know this vocabulary. Dropping happens here.

    An operator's form states the definitions the way the header does: one
    comma-separated value. `definition_id` reads as a one-element set, and the
    scalar never reaches the run body.
    """
    if not isinstance(declared, dict):
        return {}
    cleaned: dict[str, object] = {
        name: value
        for name, raw in declared.items()
        if name in DECLARED_FIELDS and (value := _clean(raw)) is not None
    }
    stated = split_ids(cleaned.pop("definition_ids", None))
    scalar = split_ids(cleaned.pop("definition_id", None))
    if stated or scalar:
        cleaned["definition_ids"] = stated or scalar
    return cleaned


def clean_header(header_properties: object) -> dict[str, object]:
    """Map the `test.*` header block onto run field names."""
    if not isinstance(header_properties, dict):
        return {}
    mapped: dict[str, object] = {}
    for key, target in HEADER_RUN_FIELDS.items():
        cleaned = _clean(header_properties.get(key))
        if cleaned is not None:
            mapped[target] = cleaned
    # `test.definitions` is stated after `test.definition` in HEADER_LIST_FIELDS,
    # so a file carrying both keeps the set.
    for key, target in HEADER_LIST_FIELDS.items():
        ids = split_ids(header_properties.get(key))
        if ids:
            mapped[target] = ids
    return mapped


def parse_instant(value: str | None) -> datetime | None:
    """Parse an ISO-8601 timestamp, applying the epoch sentinel.

    A value the registry's `UtcDatetime` would refuse is dropped here rather
    than sent, because `POST /test-runs` answers 422 for it and a 422 is a
    caller fault that costs the whole run upsert.
    """
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        log.warning("not an ISO-8601 timestamp, so it stays out: %r", value)
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    parsed = parsed.astimezone(UTC)
    if parsed <= EPOCH_SENTINEL:
        # The source states no window. Sending one would invent a 1970 run.
        return None
    return parsed


def iso_z(value: datetime | None) -> str | None:
    """ISO-8601 UTC with a Z suffix — the one timestamp format on the wire."""
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _run_key_pattern(pattern: str) -> re.Pattern[str]:
    """Compile the configured pattern, or the default when it cannot be used.

    A `TM_RUN_KEY_PATTERN` that does not compile falls back to the default
    rather than DISABLING the filename rung. Returning "no key" for a bad
    configuration value would make every filename-named file unlinkable, and it
    would look exactly like a file that genuinely names no run. The fallback
    takes the same decision, for the same reason: "a bad configuration value
    must never stop the watcher, because the watcher never drops a file"
    (ingestion/mf4.py:127-145).
    """
    if pattern and pattern.strip():
        try:
            return re.compile(pattern)
        except re.error as error:
            log.warning("the run key pattern %r does not compile: %s", pattern, error)
    return re.compile(DEFAULT_RUN_KEY_PATTERN)


def find_run_key(filename: str, pattern: str) -> str | None:
    """Last resort: read the run key out of the filename."""
    match = _run_key_pattern(pattern).search(filename or "")
    if match is None:
        return None
    # A pattern that can match nothing matches at position 0 and yields "" — an
    # id the registry stores happily and no query ever finds.
    return match.group(0) or None


def resolve_vehicle(declared: object, header: object) -> str | None:
    """The car: what the operator declared, then what the file states.

    Declared outranks the header for the reason every linkage field does — a
    correction must not need the file edited. None means neither channel named
    a car, and the registry stores that as no claim rather than a sentinel.
    """
    if isinstance(declared, dict):
        stated = _clean(declared.get(DECLARED_VEHICLE))
        if stated is not None:
            return stated
    if isinstance(header, dict):
        return _clean(header.get(HEADER_VEHICLE))
    return None


def resolve_platform(declared: object, header: object) -> str | None:
    """The platform: what the operator declared, then what the file states.

    Declared outranks the header for the reason every linkage field does — a
    correction must not need the file edited. None means neither channel named
    one, and a campaign this upload opens then states an empty project rather
    than an invented one.
    """
    if isinstance(declared, dict):
        stated = _clean(declared.get(DECLARED_PLATFORM))
        if stated is not None:
            return stated
    if isinstance(header, dict):
        return _clean(header.get(HEADER_PLATFORM))
    return None


def resolve_source_system(header: dict[str, str] | object, filename: str) -> str:
    """State the producing system, never forwarding an unvalidated string."""
    declared = None
    if isinstance(header, dict):
        declared = _clean(header.get("test.source_system"))
    if declared in PHYSICAL_SOURCE_SYSTEMS:
        return declared
    if declared is not None:
        log.warning("test.source_system=%r is outside the enum, so it is derived", declared)
    suffix = PurePosixPath(filename or "").suffix.lower()
    return SUFFIX_SOURCE_SYSTEM.get(suffix, DEFAULT_SOURCE_SYSTEM)


@dataclass
class Identity:
    """One file's resolved identity, ready to become a run body."""

    run_id: str | None
    rig_id: str
    source_system: str
    # File-level, like `source_system`: it describes these bytes, not the run.
    vehicle: str | None = None
    # Read off the raw bags like the car, but it does ride to the registry:
    # a campaign opened by this upload states it as its project.
    platform: str | None = None
    # Every other RunUpsertRequest field that resolved, already coerced.
    fields: dict[str, object] = field(default_factory=dict)
    # Human-readable "header said X; declared Y won" lines, for the
    # file.header_parsed note. The losing value is reported, never destroyed.
    conflicts: list[str] = field(default_factory=list)
    # True when the run key came from neither channel and no filename matched.
    run_id_derived: bool = False


def resolve_run_key(
    declared: dict[str, object],
    header: dict[str, object],
    filename: str,
    run_key_pattern: str,
) -> tuple[str | None, bool]:
    """Climb the one ladder: declared, header, filename, unresolved.

    mf4-decoder climbs the same four rungs from the same message, and the two
    apps MUST land on the same answer. When they do not, the registry holds a
    run whose signals are catalogued while the lake holds that run's rows under
    a different partition, a query for the run answers nothing, and no step of
    the pipeline reports an error.

    Returns the key and whether the filename supplied it.
    """
    stated = declared.get("run_id") or header.get("run_id")
    if stated is not None:
        return stated, False
    from_name = find_run_key(filename, run_key_pattern)
    return from_name, from_name is not None


def _refuse_foreign_record(
    record: dict[str, object], run_id: str | None, label: str, conflicts: list[str]
) -> dict[str, object]:
    """Drop what a record asserts when the record names a different run.

    "The folder names one run and the body names another. Never guess a field."
    (ingestion/watcher.py:386-394). A run that inherits another run's work order
    links to the wrong plan and looks completely normal on screen, so the whole
    record is refused rather than merged field by field.

    Only the MEASURED fields survive. The header sits inside these bytes, so its
    window describes THIS file whatever run it names; a work order is an
    assignment about a run we are not looking at.
    """
    stated = record.get("run_id")
    if stated is None or run_id is None or stated == run_id:
        return record
    conflicts.append(f"{label} names run {stated}, not {run_id}, so its claims stayed out")
    return {name: value for name, value in record.items() if name not in ASSERTED_FIELDS}


def resolve_identity(
    declared_raw: object,
    header_raw: object,
    filename: str,
    run_key_pattern: str,
) -> Identity:
    """Apply the per-field precedence and return the resolved identity."""
    declared = clean_declared(declared_raw)
    header = clean_header(header_raw)
    conflicts: list[str] = []

    def pick(
        name: str, winner: dict[str, object], loser: dict[str, object], label: str
    ) -> object | None:
        won, lost = winner.get(name), loser.get(name)
        if won is not None and lost is not None and won != lost:
            conflicts.append(f"{label} stated {name}={lost}; {won} won")
        return won if won is not None else lost

    run_id, derived = resolve_run_key(declared, header, filename, run_key_pattern)
    pick("run_id", declared, header, "header")
    # Judging a record foreign needs the resolved key, so the guard runs here and
    # not inside `pick`. Only the loser of the tie can name a different run.
    declared = _refuse_foreign_record(declared, run_id, "the declared bag", conflicts)
    header = _refuse_foreign_record(header, run_id, "the header", conflicts)

    resolved: dict[str, object] = {}
    for name in LINKAGE_FIELDS + CONTEXT_FIELDS:
        if name == "run_id":
            continue  # resolved by the ladder above, which the filename rung joins
        value = pick(name, declared, header, "header")
        if value is not None:
            resolved[name] = value
    for name in MEASURED_FIELDS:
        # The header measured it, so the header wins — but only a timestamp
        # past the epoch sentinel counts as measured at all.
        header_instant = parse_instant(header.get(name))
        declared_instant = parse_instant(declared.get(name))
        winner = header_instant or declared_instant
        if header_instant and declared_instant and header_instant != declared_instant:
            conflicts.append(
                f"declared stated {name}={iso_z(declared_instant)}; "
                f"{iso_z(header_instant)} won"
            )
        if winner is not None:
            resolved[name] = iso_z(winner)

    rig_id = resolved.pop("rig_id", None) or UNKNOWN_RIG

    return Identity(
        run_id=run_id,
        rig_id=str(rig_id),
        source_system=resolve_source_system(header_raw, filename),
        # Off the RAW bags, like the source system: the per-field precedence
        # above settles what a run asserts, and neither the car nor the
        # platform is one of those.
        vehicle=resolve_vehicle(declared_raw, header_raw),
        platform=resolve_platform(declared_raw, header_raw),
        fields=resolved,
        conflicts=conflicts,
        run_id_derived=derived,
    )
