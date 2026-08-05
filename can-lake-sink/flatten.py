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
SIGNAL_COLUMNS = [
    "ts",
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
    "t_rel",
    "dbc_sha256",
]

UNKNOWN_COLUMNS = [
    "ts",
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
    "t_rel",
    "reason",
]


def flatten(value: dict, ts) -> tuple[list[dict], list[dict]]:
    """Turn one envelope message into (signal rows, unknown-frame rows).

    `ts` is the event time. The source has no wall clock of its own - rlog
    logMonoTime is monotonic-since-boot - so this is the replay timestamp, which
    is what makes the rows partitionable by day.
    """
    base = {
        "ts": ts,
        "platform": value.get("platform"),
        "device": value.get("device"),
        "route": value.get("route"),
        "segment": value.get("segment"),
        "seq": value.get("seq"),
        "t_rel": value.get("t_rel"),
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
