"""Replay decoded CAN from MF4 files, as fast as possible.

Consumes the mf4-metadata topic the converter publishes, downloads each MF4 from
blob, decodes its frames, and produces one message per envelope.

The CAN database is supplied by QuixStreams' own enrichment join:
`join_lookup` + `QuixConfigurationService` against the DCM config topic. That
gives version resolution at the message's timestamp and picks up a new DBC
version live, without a restart. Only the compiled cantools Database is cached
locally, since that is the one thing the lookup cannot cache for us.

No pacing: this is a backfill/debug replay, not a live simulation. Defaults are
deliberately small so the output topic stays inspectable.
"""

from __future__ import annotations

import logging
import os
import sys
import time

from quixportal import get_filesystem
from quixstreams import Application
from quixstreams.dataframe.joins.lookups import QuixConfigurationService

from db_cache import DatabaseCache
from decode import decode_envelope, envelopes, load_frames

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("mf4-replay")

INPUT_TOPIC = os.environ.get("input", "mf4-metadata")
OUTPUT_TOPIC = os.environ.get("output", "can-decoded")
CONFIG_TOPIC = os.environ.get("config", "config-updates")
CONSUMER_GROUP = os.environ.get("CONSUMER_GROUP", "mf4-replay")

# Debug-sized by default: one file, five seconds of envelopes.
MAX_FILES = int(os.environ.get("MAX_FILES", "1"))
MAX_ENVELOPES_PER_FILE = int(os.environ.get("MAX_ENVELOPES_PER_FILE", "500"))
DCM_TYPE = os.environ.get("DCM_TYPE", "dbc")

# Field names the lookup writes into each message. Both are stripped before the
# message is produced - the DBC document is ~850 KB and must not reach the topic.
F_DOC = "_dbc_doc"
F_KEY = "_dbc_key"

_state = {"files": 0}


def lookup_key(value: dict, _key) -> str:
    """The DCM target_key for a message.

    The converter writes dcm.target_key into every mf4-metadata message, taken
    from the MF4's own header, so each file resolves against the database it was
    converted with rather than whatever this service is configured for.

    Deliberately NOT falling back to a service-wide default. This runs over a
    230-platform dataset; a default would quietly apply one car's database to
    another car's frames, which decodes to plausible-looking nonsense rather
    than failing. No key -> no config -> the message is dropped, which is the
    intended behaviour for a platform we cannot decode.

    An unknown/empty key is safe as-is: an ABSENT config reaches field.missing()
    and yields our default of None, which the handler drops. A config that
    exists but whose content cannot be FETCHED is the separate case that still
    re-raises and kills the service, because the lookup defaults to
    fallback="error" - see the backlog.
    """
    dcm = value.get("dcm") or {}
    return dcm.get("target_key") or ""


def build_handler(fs, dbs: DatabaseCache):
    """One mf4-metadata message -> many envelope messages (apply(expand=True))."""

    def handle(value: dict, _key, source_ts_ms: int, _headers) -> list:
        # Strip the enrichment fields first, so they cannot leak downstream even
        # if this function returns early.
        doc = value.pop(F_DOC, None)
        db_key = value.pop(F_KEY, None)

        if MAX_FILES and _state["files"] >= MAX_FILES:
            return []

        blob_path = value.get("blob_path")
        if not blob_path:
            logger.warning("message has no blob_path, skipping: %s", value)
            return []

        if not doc:
            logger.error(
                "no CAN database from DCM for target_key=%r (type=%r) - is the "
                "config published to %s?",
                lookup_key(value, None),
                DCM_TYPE,
                CONFIG_TOPIC,
            )
            return []

        db = dbs.get(db_key, doc)

        t0 = time.time()
        logger.info("replaying %s (dbc %s)", blob_path, str(db_key)[:16])
        with fs.open(blob_path, "rb") as fh:
            mf4_bytes = fh.read()

        mdf, props, frames = load_frames(mf4_bytes)

        device = props.get("source.device") or value.get("device")
        route = props.get("source.route") or value.get("route")
        segment = props.get("source.segment") or value.get("segment")
        platform = props.get("platform") or value.get("platform")

        # Presentation anchor for the whole segment, captured ONCE. This is the
        # broker timestamp of the single mf4-metadata message announcing this
        # file, so it is per segment by construction. It must not be taken per
        # envelope: every can-decoded message carries its own advancing Kafka
        # timestamp, and anchoring per message before adding t_rel_ms would
        # double-count the elapsed time and stretch the axis to ~2x the real
        # duration.
        seg_anchor_ms = int(source_ts_ms)

        out = []
        dec_total = unk_total = 0
        for seq, t_rel, sl in envelopes(frames, MAX_ENVELOPES_PER_FILE):
            recs, dec, unk = decode_envelope(db, frames, sl)
            dec_total += dec
            unk_total += unk
            out.append(
                {
                    "platform": platform,
                    "device": device,
                    "route": route,
                    "segment": segment,
                    # seq is the only surviving record of intra-envelope order:
                    # every frame in an envelope shares one timestamp, and Kafka
                    # does not preserve row order.
                    "seq": seq,
                    # Milliseconds since the start of this segment, from the
                    # rlog's 100 Hz logMonoTime envelope clock. The only real
                    # time this data has. decode.py yields seconds; the *1000
                    # here is what makes the _ms suffix true.
                    "t_rel_ms": round(t_rel * 1000, 3),
                    # The segment's anchor, repeated on every envelope so
                    # t_abs_ms is reproducible from payload fields alone - no
                    # message metadata, no downstream "first timestamp I saw",
                    # which would need state and break on out-of-order delivery.
                    "seg_anchor_ms": seg_anchor_ms,
                    # ANCHORED absolute time, for plotting. The recording has no
                    # wall clock at all (logMonoTime is monotonic-since-boot and
                    # these segments carry no `clocks` / `gpsLocation` service),
                    # so t_rel_ms alone would render at 1970-01-01. Translating
                    # it by the segment's broker anchor puts the data on a
                    # readable axis while the SPACING still comes entirely from
                    # t_rel_ms, which is the real measured time.
                    #
                    # It says "plotted on a plausible axis", NOT "happened at
                    # this time" - the origin is arbitrary and shifts if the
                    # segment is re-announced. Within a segment only t_rel_ms
                    # and seq are stable identities. Integer ms suits Grafana;
                    # sub-ms precision stays available in t_rel_ms.
                    "t_abs_ms": int(seg_anchor_ms + round(t_rel * 1000)),
                    # Absolute time, but SYNTHETIC - not a recording date.
                    # Expanded messages inherit the SOURCE message's Kafka
                    # timestamp, so without this every row of a file would carry
                    # one identical value and the time axis would be dead. The
                    # recording has no wall clock (logMonoTime is monotonic-
                    # since-boot, and these segments carry no `clocks` or
                    # `gpsLocation` service), so anchor on when the file was
                    # announced and lay the relative offset on top: correct
                    # spacing, invented origin. Do not read it as when the
                    # vehicle was driven - that is unknown and unrecoverable.
                    "ts_ms": int(source_ts_ms + round(t_rel * 1000)),
                    "frame_count": len(recs),
                    "decoded": dec,
                    "undecoded": unk,
                    "dbc": {
                        "config_id": (value.get("dcm") or {}).get("config_id"),
                        "dbc_sha256_from_config": db_key,
                        "name": props.get("dbc.name"),
                        "sha256": props.get("dbc.sha256"),
                    },
                    "frames": recs,
                }
            )

        mdf.close()
        _state["files"] += 1
        elapsed = time.time() - t0
        logger.info(
            "done %s: %d envelopes (%d frames decoded, %d undecoded) in %.1fs "
            "(%.0f env/s)",
            blob_path,
            len(out),
            dec_total,
            unk_total,
            elapsed,
            len(out) / elapsed if elapsed else 0,
        )
        if MAX_FILES and _state["files"] >= MAX_FILES:
            logger.info(
                "reached MAX_FILES=%d; stopping. Raise MAX_FILES / "
                "MAX_ENVELOPES_PER_FILE to replay more.",
                MAX_FILES,
            )
        return out

    return handle


def main() -> int:
    logger.info(
        "input=%s output=%s config=%s max_files=%s max_envelopes=%s dcm_type=%s",
        INPUT_TOPIC,
        OUTPUT_TOPIC,
        CONFIG_TOPIC,
        MAX_FILES,
        MAX_ENVELOPES_PER_FILE,
        DCM_TYPE,
    )

    fs = get_filesystem()
    dbs = DatabaseCache()

    app = Application(consumer_group=CONSUMER_GROUP, auto_offset_reset="earliest")
    in_topic = app.topic(INPUT_TOPIC, value_deserializer="json")
    out_topic = app.topic(OUTPUT_TOPIC, value_serializer="json", key_serializer="str")
    config_topic = app.topic(CONFIG_TOPIC)

    lookup = QuixConfigurationService(config_topic, app_config=app.config)
    fields = {
        # "$" pulls the whole config document; the lookup fetches it from the
        # contentUrl in the config event and caches it per version.
        F_DOC: lookup.json_field(jsonpath="$", type=DCM_TYPE, default=None),
        # Cache key for the compiled database. Deliberately a field of the
        # document rather than the configuration's version: get_config_version()
        # / MetadataField only exist in unreleased quixstreams builds, so relying
        # on them breaks any deployment installing from PyPI. The source DBC hash
        # is also the more honest identity - it changes exactly when the database
        # content changes.
        F_KEY: lookup.json_field(
            jsonpath="$.source.dbc_sha256", type=DCM_TYPE, default=None
        ),
    }

    sdf = app.dataframe(in_topic)
    sdf = sdf.join_lookup(lookup, fields, on=lookup_key)
    sdf = sdf.apply(build_handler(fs, dbs), expand=True, metadata=True)
    # Carry the per-envelope time onto the Kafka message itself, so every
    # downstream consumer (the lake sink included) sees a real time axis rather
    # than the source message's single inherited timestamp.
    sdf = sdf.set_timestamp(lambda value, _key, _ts, _headers: int(value["ts_ms"]))
    sdf = sdf.to_topic(
        out_topic, key=lambda v: f"{v['device']}/{v['route']}/{v['segment']}"
    )
    app.run(sdf)

    return 0


if __name__ == "__main__":
    sys.exit(main())
