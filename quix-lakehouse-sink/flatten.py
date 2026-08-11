"""Flatten decoded CAN envelopes into lakehouse rows.

The row grain follows the CAN hierarchy:

    channel  ->  sender_node  ->  frame  ->  signal

One row per signal sample, which absorbs the fact that frames run at different
cycle times (a 50 Hz frame and a 100 Hz frame share no common row), where a wide
row-per-timestamp would force resampling and bake an interpolation choice into
stored data.

There is no `pdu` level: nothing in the opendbc Ford database is multiplexed
(0 of 331 frames), so a PDU column would duplicate frame_name on every row. If a
multiplexed database ever arrives, add it then - the multiplexor is already
carried through dbc_json (is_multiplexer / multiplexer_ids).
"""

from __future__ import annotations

CHANNEL_NAMES = {
    0: "powertrain_hs_can1",
    1: "radar_object_hs_can2",
    2: "camera_ipma_hs_can3",
}

# Static per-signal metadata (unit, scale, min/max) is deliberately NOT repeated
# on every row - it belongs in a dimension table built from the DCM config and
# joined on (frame_id, signal). At ~1.2M signal rows per 60s segment, carrying it
# inline would be almost pure duplication.
#
# Three clocks, all in milliseconds, and only one of them is measured:
#
#   t_rel_ms       ms since the start of THIS segment, from the rlog's 100 Hz
#                  logMonoTime envelope clock. The real measured time.
#                  0 .. ~60000, sub-ms precision retained.
#   seg_anchor_ms  the broker timestamp of the segment's mf4-metadata message,
#                  captured once by mf4-replay and repeated on every envelope.
#   t_abs_ms       seg_anchor_ms + t_rel_ms. An ANCHORED absolute time, suitable
#                  as timestamp_column / sort_column: it is computed from
#                  payload fields only, so it survives broker timestamp
#                  semantics and re-produces. This is the one to partition and
#                  order on - NOT t_rel_ms, which is 0..60000 and would put
#                  every row in January 1970.
#   ts_ms          legacy absolute time. Same arithmetic today, but sourced
#                  from message metadata, so it is the weaker of the two.
#
# t_abs_ms says "plotted on a plausible axis", NOT "happened at this time" -
# these rlogs carry no wall clock at all, so the origin is arbitrary. It is
# stable across replays and moves only if the converter re-announces a segment.
SIGNAL_COLUMNS = [
    "ts_ms",
    "t_abs_ms",
    "seg_anchor_ms",
    "platform",
    "device",
    "route",
    "segment",
    "channel",
    "channel_name",
    "sender_node",
    "frame_id",
    "frame_hex",
    "frame_name",
    "signal",
    "value",
    "seq",
    "frame_index",
    "t_rel_ms",
    "dbc_sha256",
]

UNKNOWN_COLUMNS = [
    "ts_ms",
    "t_abs_ms",
    "seg_anchor_ms",
    "platform",
    "device",
    "route",
    "segment",
    "channel",
    "channel_name",
    "frame_id",
    "frame_hex",
    "dlc",
    "raw",
    "seq",
    "frame_index",
    "t_rel_ms",
    "reason",
]


def to_signal_rows(value: dict, ts_ms) -> list[dict]:
    """Signal rows only - for apply(expand=True) feeding the signals sink."""
    return flatten(value, ts_ms)[0]


def to_unknown_rows(value: dict, ts_ms) -> list[dict]:
    """Unknown-frame rows only - for apply(expand=True) feeding the second sink."""
    return flatten(value, ts_ms)[1]


def _resolve_ts(value: dict, ts_ms):
    """Prefer the producer's explicit ts_ms over the Kafka message timestamp.

    Expanded messages inherit their source message's timestamp, so relying on
    Kafka metadata alone once produced every row of a file with one identical
    value. mf4-replay now sets the timestamp explicitly and also carries it in
    the payload; trusting the payload first means a regression upstream cannot
    silently flatten the time axis again.
    """
    explicit = value.get("ts_ms")
    return int(explicit) if explicit is not None else ts_ms


def flatten(value: dict, ts_ms) -> tuple[list[dict], list[dict]]:
    """Turn one envelope message into (signal rows, unknown-frame rows).

    `ts_ms` here is the Kafka message timestamp in milliseconds, used only as a
    fallback when the payload carries no explicit ts_ms. The source has no wall
    clock of its own - rlog logMonoTime is monotonic-since-boot - so every
    absolute column is anchored rather than measured. The sink partitions and
    sorts on t_abs_ms; see the note above SIGNAL_COLUMNS.
    """
    base = {
        "ts_ms": _resolve_ts(value, ts_ms),
        "platform": value.get("platform"),
        "device": value.get("device"),
        "route": value.get("route"),
        "segment": value.get("segment"),
        "seq": value.get("seq"),
        "t_rel_ms": value.get("t_rel_ms"),
        "t_abs_ms": value.get("t_abs_ms"),
        "seg_anchor_ms": value.get("seg_anchor_ms"),
    }
    dbc_sha = (value.get("dbc") or {}).get("sha256")

    signals: list[dict] = []
    unknown: list[dict] = []

    for idx, fr in enumerate(value.get("frames") or []):
        channel = fr.get("bus")
        common = dict(
            base,
            channel=channel,
            channel_name=CHANNEL_NAMES.get(channel, f"bus{channel}"),
            frame_id=fr.get("id"),
            frame_hex=fr.get("id_hex"),
            # frame_index preserves order within the envelope. Every frame in an
            # envelope shares one timestamp, so ordering cannot be recovered from
            # ts alone once rows are shuffled by partitioning or compaction.
            frame_index=idx,
        )

        name = fr.get("name")
        if not name:
            unknown.append(
                dict(
                    common,
                    dlc=fr.get("dlc"),
                    raw=fr.get("raw"),
                    reason="no-dbc-entry",
                )
            )
            continue

        sigs = fr.get("signals")
        if not sigs:
            # decoded to a known frame but produced no values (e.g. a decode
            # error recorded upstream) - keep it rather than dropping it
            unknown.append(
                dict(
                    common,
                    dlc=fr.get("dlc"),
                    raw=fr.get("raw"),
                    reason=fr.get("decode_error") or "no-signals",
                )
            )
            continue

        for sig_name, sig_value in sigs.items():
            signals.append(
                dict(
                    common,
                    sender_node=fr.get("sender"),
                    frame_name=name,
                    signal=sig_name,
                    value=(
                        float(sig_value)
                        if isinstance(sig_value, (int, float))
                        else None
                    ),
                    dbc_sha256=dbc_sha,
                )
            )

    return signals, unknown
