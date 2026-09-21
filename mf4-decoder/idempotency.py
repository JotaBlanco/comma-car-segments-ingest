"""Decode-once guard: a replayed ``mf4_metadata`` message must be a no-op.

The sink is at-least-once and Iceberg only appends, so anything that makes the
decoder emit one file's batches twice puts a second full copy of that file in
the lake. ``mf4_metadata`` is consumed with ``auto_offset_reset="earliest"``, so
resetting offsets or rotating a consumer group replays every metadata message
ever produced; before this module each replay re-decoded every file and stacked
another copy. ``mf4_signals_v4`` ended up holding 126,560 rows for a
25,312-row route: 5 copies of every ``(signal, ts_ms)`` spread over 2
``upload_id`` values.

Identity: content, not upload
-----------------------------
The dedup key is the **sha256 of the file content** (``mf4_metadata.sha256``),
because that is the field that answers "have these bytes already been
decoded?". ``id`` - the minted ``upload_id`` - answers the narrower question
"have I seen this *upload* before?", and keying on it would have left 2 copies
of the route above standing: the same file was uploaded twice and each upload
minted its own id.

Fallback chain, most specific first:

* ``sha256:<hex>`` from ``sha256`` - direct uploads, which is every upload in
  this workspace (the backend is ``S3Compatible``, so ``/upload/direct``
  streams and hashes the bytes).
* ``upload:<id>`` from ``id`` - SAS uploads, where the bytes never pass through
  the app and ``sha256`` is null by design.
* ``blob:<path>`` from ``blob_path`` - producers that mint neither, e.g.
  metadata written for ``rlog-to-mf4`` output, which carries no ``id``.
* ``unidentified`` - none of the three.

Every rung still deduplicates a *replay*, because a replayed message repeats
whichever field it originally carried. What the lower rungs give up is
cross-upload content dedup: the same bytes uploaded once through SAS and once
directly land under two identities and both decode.

``unidentified`` is safe by construction, not by luck. A message with no
``blob_path`` is one ``process()`` drops as malformed before decoding anything,
so it is never marked decoded, so it is never skipped - it cannot poison the
scope it shares with other unidentified messages.

Why native State and not a lookup
---------------------------------
``State`` is prefixed by the **message key** - see ``as_state(prefix=key)`` in
``StreamingDataFrame._as_stateful`` - so a store keyed on content is only
reachable if content *is* the key. ``mf4-to-blob`` keys ``mf4_metadata`` by
``upload_id``, so ``main.py`` re-keys with ``group_by(decode_identity)`` before
the filter. That is the native way to get a per-identity store; it costs one
``repartition__`` topic carrying one small message per upload. A Mongo row or an
on-disk marker would be an external store for streaming state, which State plus
its changelog topic already provides durably.

Durability note: the store is backed by a changelog topic whose name embeds the
consumer group (``changelog__<group>--<topic>--<store>``). Rotating the decoder
consumer group therefore abandons the dedup state along with the offsets, and
the next run re-decodes everything. That is why the group is a hard-coded
constant in ``main.py`` and not a deployment variable.
"""

import logging
import os
from datetime import datetime, timezone

from quixstreams import State

logger = logging.getLogger("mf4-decoder.idempotency")

# The marker, plus enough context to explain a skip in the log without having
# to query the lake.
STATE_DECODED = "decoded"
STATE_DECODED_AT = "decoded_at"
STATE_UPLOAD_ID = "upload_id"
STATE_FILE_NAME = "file_name"
STATE_SAMPLES = "samples"

UNIDENTIFIED = "unidentified"

_TRUTHY = frozenset({"1", "true", "yes", "on"})

# Escape hatch, global and blunt: while true nothing is skipped, so a replay
# writes another full copy of every file to the lake. The per-message
# ``force_redecode`` flag below is the surgical alternative and needs no
# redeploy.
FORCE_REDECODE = os.getenv("FORCE_REDECODE", "false").strip().lower() in _TRUTHY

# Counters, so a replay storm shows up as a running total rather than as
# silence. Plain ints are safe: QuixStreams runs the topology on one thread.
_skipped_total = 0
_decoded_total = 0


def _text(raw: object) -> str:
    """Trimmed string, or "" for anything that is not a non-empty string."""
    return raw.strip() if isinstance(raw, str) else ""


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log_mode() -> None:
    """Announce the dedup mode once, at boot, so the logs name the behaviour."""
    if FORCE_REDECODE:
        logger.warning(
            "FORCE_REDECODE=true: the decode-once filter is bypassed. Every "
            "replayed mf4_metadata message will be decoded again and will add "
            "another full copy of that file to the lake. Set it back to false "
            "once the intended re-decode has run."
        )
    else:
        logger.info(
            "Decode-once filter active: an already-decoded file is skipped. To "
            "force one through, set force_redecode=true on its mf4_metadata "
            "message, or FORCE_REDECODE=true on the deployment for all of them."
        )


def decode_identity(value: dict) -> str:
    """Return the dedup identity of one ``mf4_metadata`` message.

    This is the ``group_by`` key, so it must always return a non-empty string -
    hence ``UNIDENTIFIED`` rather than ``None`` at the end of the chain. The
    prefixes keep the three sources in separate namespaces and make the
    repartition topic readable in the portal.
    """
    if not isinstance(value, dict):
        return UNIDENTIFIED

    sha256 = _text(value.get("sha256")).lower()
    if sha256:
        return f"sha256:{sha256}"

    upload_id = _text(value.get("id"))
    if upload_id:
        return f"upload:{upload_id}"

    blob_path = _text(value.get("blob_path"))
    if blob_path:
        return f"blob:{blob_path}"

    return UNIDENTIFIED


def _forced(value: dict) -> tuple[bool, str]:
    """Is a re-decode explicitly requested, and by which knob?"""
    if FORCE_REDECODE:
        return True, "FORCE_REDECODE=true on the deployment"

    flag = value.get("force_redecode") if isinstance(value, dict) else None
    if flag is True or (isinstance(flag, str) and flag.strip().lower() in _TRUTHY):
        return True, "force_redecode=true on the message"

    return False, ""


def needs_decode(value: dict, state: State) -> bool:
    """``sdf.filter(..., stateful=True)``: drop files that are already decoded.

    The state scope is the message key, which ``group_by(decode_identity)`` has
    already set to the identity, so the marker read here belongs to this file
    and to no other.
    """
    global _skipped_total

    if not state.get(STATE_DECODED):
        return True

    identity = decode_identity(value)
    filename = _text(value.get("filename")) or "unnamed"

    forced, reason = _forced(value)
    if forced:
        logger.warning(
            "Re-decoding %s (%s) even though it was decoded at %s: %s",
            identity,
            filename,
            state.get(STATE_DECODED_AT) or "an unknown time",
            reason,
        )
        return True

    _skipped_total += 1
    logger.warning(
        "Skipping %s (%s): already decoded at %s as upload_id=%s (%s samples). "
        "Skipped %d file(s) so far this run, decoded %d.",
        identity,
        filename,
        state.get(STATE_DECODED_AT) or "an unknown time",
        state.get(STATE_UPLOAD_ID) or "unknown",
        state.get(STATE_SAMPLES, "?"),
        _skipped_total,
        _decoded_total,
    )
    return False


def mark_decoded(state: State, value: dict, *, samples: int) -> None:
    """Record that this file is decoded, so a replay of it is skipped.

    Called from ``process()`` only after the decode finished and the producer
    was flushed: the marker must never be more durable than the rows it vouches
    for. A file whose decode raised is left unmarked and is retried on the next
    delivery.
    """
    global _decoded_total

    _decoded_total += 1
    state.set(STATE_DECODED, True)
    state.set(STATE_DECODED_AT, _utc_now())
    state.set(STATE_UPLOAD_ID, _text(value.get("id")) or None)
    state.set(STATE_FILE_NAME, _text(value.get("filename")) or None)
    state.set(STATE_SAMPLES, int(samples))

    logger.info(
        "Marked %s decoded (%d samples); %d file(s) decoded this run, %d skipped.",
        decode_identity(value),
        samples,
        _decoded_total,
        _skipped_total,
    )
