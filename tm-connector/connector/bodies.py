"""The three request bodies, built in one place.

`RequestModel` is `extra="forbid"` (api/api/models/common.py:33-40), so an
unknown field is a 422, not an ignored key. Every builder here emits exactly the
declared fields of its model and nothing else.
"""

from datetime import UTC, datetime, timedelta

from connector import dressing
from connector.identity import Identity, iso_z
from connector.inventory import FileInventory

# The journal vocabulary is FROZEN at five names (contract §A). Invent nothing.
FILE_DETECTED = "file.detected"
CHECKSUM_VERIFIED = "file.checksum_verified"
CHECKSUM_FAILED = "file.checksum_failed"
HEADER_PARSED = "file.header_parsed"
SAMPLES_WRITTEN = "file.samples_written"

JOURNAL_FIELDS = (
    FILE_DETECTED,
    CHECKSUM_VERIFIED,
    CHECKSUM_FAILED,
    HEADER_PARSED,
    SAMPLES_WRITTEN,
)

CHECKSUM_STATES = ("verified", "mismatch", "unverified")

# The never-null discipline that keeps a lake partition readable produces the
# literal "unknown". It must never reach an ID, a KEY or a CHECKSUM: an operator
# following one finds nothing, and `checksum_sha256` is a unique index key
# (api/api/db.py:71-76) where a shared sentinel folds every hash-less file into
# ONE document and counts the rest as replays. The registry's own sentinel for a
# missing hash is the EMPTY string, matched explicitly by `_existing_quarantined`
# (routers/files.py:368-393); the fallback returns it (ingestion/watcher.py:348).
SENTINELS = frozenset({"unknown", "none", "null"})

# What the fallback answers for an object it could not read: no digest, no
# verdict on the bytes and an honest reason, all three together
# (ingestion/watcher.py:343-349).
UNREADABLE_REASON = "unreadable object"


def no_sentinel(value: object) -> str | None:
    """A usable identifier, or None. A sentinel is not a value."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped or stripped.lower() in SENTINELS:
        return None
    return stripped


def checksum_facts(file_block: dict) -> tuple[str, str, str | None]:
    """The digest, the state it justifies, and what its absence costs the file.

    The three travel together, exactly as `_read_checksum` returns them. Without
    a digest there is nothing to have verified, so a "verified" claim is dropped
    — it would assert that two hashes agree when one of them was never taken. A
    stated mismatch survives: that verdict is the decoder's to make, and the
    registry quarantines on it either way.
    """
    digest = no_sentinel(file_block.get("sha256"))
    state = file_block.get("checksum_state")
    if state not in CHECKSUM_STATES:
        state = "unverified"
    if digest is None:
        return "", "unverified" if state == "verified" else state, UNREADABLE_REASON
    return digest, state, None


def run_body(identity: Identity, actor: str, lake_table: str | None = None) -> dict:
    """The `POST /test-runs` body (api/api/models/runs.py:131-156).

    Only `run_id` and `rig_id` are required. `work_order_id` and `definition_ids`
    ride through as CLAIMS: the connector never pre-validates one against
    planning, never drops an unresolvable one and never retries on it. A claim
    the mirror cannot answer links nothing, is remembered on the run, and the run
    stays `awaiting_work_order` — the amber the demo's payoff needs
    (api/api/services/queries_runs.py:84-107, :143-155).

    `lake_table` states which lakehouse table holds the run's samples. It comes
    from the LAKE_TABLE project variable — the same value mf4-sink's TABLE_NAME
    references, so the claim cannot drift from the writer. None means unset, and
    the key is then OMITTED rather than sent null: an absent fact stays absent,
    and the registry's merge never overwrites a previously stated table with a
    later deployment's silence.
    """
    body: dict = {
        "run_id": identity.run_id,
        "rig_id": identity.rig_id,
        # The registry overrides this to `embedded` whatever we send
        # (queries_runs.py:114-140). Sending it keeps the body honest about what
        # the pipeline is; it never claims authority.
        "source": "embedded",
        "actor": actor,
    }
    if lake_table:
        body["lake_table"] = lake_table
    body.update(identity.fields)
    # Demo dressing, HERE so both lanes agree: an UNKNOWN-rig run sometimes
    # gets a rig from the bench's world, deterministically per run id
    # (connector/dressing.py). The Identity itself stays honest.
    return dressing.dress_run_body(body)


def file_body(
    identity: Identity,
    inventory: FileInventory,
    file_block: dict,
    batch_block: dict,
    filename: str,
) -> dict:
    """The `POST /files` body (api/api/models/files.py:81-96).

    There is deliberately NO `lake_ref`: the file model has no such field, and
    the mirrored API is read-only. `storage_ref` holds the MF4's blob path; the
    Iceberg location is derivable from the fixed table name plus `run_id`, but it
    is convention, not data. See the report's open issue.

    The terminal marker's channel list is folded into the inventory HERE, so the
    body is right for any caller that hands over the marker's two blocks — the
    catalogue must never depend on the caller having remembered a second step.
    """
    if "inventory" in batch_block:
        inventory.declare_signals(batch_block["inventory"])
    checksum, checksum_state, unreadable = checksum_facts(file_block)
    decode_error = batch_block.get("decode_error")
    # A decode error names the file's own failure and is the more useful of the
    # two; a missing digest still gets its reason when nothing else claims one.
    failure = decode_error if isinstance(decode_error, str) and decode_error else None
    reason = failure or unreadable
    body: dict = {
        "filename": filename,
        "run_id": identity.run_id,
        "source_system": identity.source_system,
        # The car these bytes came off. None when neither channel named one.
        "vehicle": identity.vehicle,
        "format": file_block.get("format") or "MF4",
        "size_bytes": int(file_block.get("size_bytes") or 0),
        "checksum_sha256": checksum,
        "checksum_state": checksum_state,
        "quarantine_reason": reason,
        "storage_ref": file_block.get("blob_path"),
        # A stable correlation handle back to the upload that produced the file.
        # An operator follows it, so a sentinel that leads nowhere is worse than
        # a null that admits there is nothing to follow.
        "ingestion_job_id": no_sentinel(inventory.upload_id),
        "time_start": _epoch_iso(batch_block.get("time_start_ms")),
        "time_end": _epoch_iso(batch_block.get("time_end_ms")),
        "signals": inventory.signal_rows(),
    }
    # A failed decode is the PRODUCER's to state. The registry derives a
    # conversion success from a non-empty inventory and derives no failure,
    # because an empty inventory cannot tell a failed decode from a file that
    # holds no channel (api/api/routers/files.py:1123-1128). A decode that
    # succeeded adds nothing here and keeps that derivation.
    if failure:
        body["conversion_status"] = "failed"
        body["stage_error"] = failure
    return body


def _epoch_iso(value: object) -> str | None:
    """Epoch milliseconds -> ISO-8601 UTC with Z. A null window stays null."""
    if not isinstance(value, int) or isinstance(value, bool):
        return None
    return iso_z(datetime.fromtimestamp(value / 1000.0, tz=UTC))


def journal_event(
    field_name: str,
    entity_id: str,
    note: str,
    at: datetime,
    actor: str,
    entity_type: str = "file",
) -> dict:
    """One `POST /journal` body — exactly eight keys.

    The server fills `id`, `old` and `new`, and refuses every other key with 422
    (api/api/models/journal.py:68-84). `at` is the moment the STEP happened, not
    the moment of the call; the server stamps its own `received_at` beside it.
    """
    return {
        "entity_type": entity_type,
        "entity_id": entity_id,
        "field": field_name,
        "kind": "event",
        "source": "embedded",
        "actor": actor,
        "note": note,
        "at": iso_z(at),
    }


class Stamper:
    """Hand out strictly increasing millisecond stamps.

    A BSON date keeps milliseconds, and four events of one file land inside the
    same millisecond easily. `at` is the timeline's sort key, so a repeat leaves
    the reader no order at all. This costs at most one millisecond per event and
    keeps the true step order (the same device as
    `IngestResult.next_stamp`, ingestion/watcher.py:243-256).
    """

    def __init__(self) -> None:
        self._last: datetime | None = None

    def at(self, moment: datetime) -> datetime:
        moment = moment.astimezone(UTC)
        moment = moment.replace(microsecond=moment.microsecond // 1000 * 1000)
        if self._last is not None and moment <= self._last:
            moment = self._last + timedelta(milliseconds=1)
        self._last = moment
        return moment
