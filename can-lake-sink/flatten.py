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
# Two clocks, both in milliseconds, and only one of them is real:
#
#   t_rel_ms  milliseconds since the start of THIS segment, from the rlog's
#             100 Hz logMonoTime envelope clock. Genuine measured time,
#             0 .. ~60000, sub-ms precision retained.
#   ts_ms     epoch milliseconds, but SYNTHETIC: the Kafka timestamp of the
#             mf4-metadata message (i.e. when we replayed) plus t_rel_ms. It is
#             NOT when the vehicle was driven - these rlogs carry no wall clock
#             at all (no `clocks` / `gpsLocation` service, and logMonoTime is
#             monotonic-since-boot), so no offset exists to recover one.
#             The anchor is the mf4-metadata message's own broker timestamp,
#             fixed when the converter announced the file - so re-running the
#             REPLAY reproduces identical values. Only re-running the CONVERTER
#             moves them, because that produces new metadata messages. Segments
#             still overlap each other, since they share one announcement
#             window.
#
# Absolute ordering is therefore only meaningful within one
# (device, route, segment); use t_rel_ms / seq for that.
SIGNAL_COLUMNS = [
    "ts_ms",
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


def to_signal_rows(value: dict, kafka_ts_ms) -> list[dict]:
    """Signal rows only - for apply(expand=True) feeding the signals sink."""
    return flatten(value, kafka_ts_ms)[0]


def to_unknown_rows(value: dict, kafka_ts_ms) -> list[dict]:
    """Unknown-frame rows only - for apply(expand=True) feeding the second sink."""
    return flatten(value, kafka_ts_ms)[1]


def _resolve_ts(value: dict, kafka_ts_ms):
    """Prefer the producer's explicit ts_ms over the Kafka timestamp.

    Expanded messages inherit their source message's timestamp, so relying on
    Kafka metadata alone once produced every row of a file with one identical
    value. mf4-replay now sets the timestamp explicitly and also carries it in
    the payload; trusting the payload first means a regression upstream cannot
    silently flatten the time axis again.
    """
    explicit = value.get("ts_ms")
    return int(explicit) if explicit is not None else kafka_ts_ms


def flatten(value: dict, kafka_ts_ms) -> tuple[list[dict], list[dict]]:
    """Turn one envelope message into (signal rows, unknown-frame rows).

    `kafka_ts_ms` is the Kafka message timestamp in milliseconds, used only as a
    fallback. The source has no wall clock of its own - rlog logMonoTime is
    monotonic-since-boot - so the replay timestamp is the only absolute time
    available, and it is what the sink partitions on. See the note above
    SIGNAL_COLUMNS for why it must not be read as a recording date.
    """
    base = {
        "ts_ms": _resolve_ts(value, kafka_ts_ms),
        "platform": value.get("platform"),
        "device": value.get("device"),
        "route": value.get("route"),
        "segment": value.get("segment"),
        "seq": value.get("seq"),
        "t_rel_ms": value.get("t_rel_ms"),
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
