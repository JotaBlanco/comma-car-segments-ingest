"""Replay decoded CAN from MF4 files, as fast as possible.

Consumes the mf4-metadata topic the converter publishes, downloads each MF4 from
blob, resolves its DBC from the Dynamic Configuration Manager using the
dcm.config_id stored in the MF4's own header, decodes the frames, and produces
one message per envelope to the output topic.

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

from dcm import DcmClient
from decode import decode_envelope, envelopes, load_frames

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("mf4-replay")

INPUT_TOPIC = os.environ.get("input", "mf4-metadata")
OUTPUT_TOPIC = os.environ.get("output", "can-decoded")
CONSUMER_GROUP = os.environ.get("CONSUMER_GROUP", "mf4-replay")

# Debug-sized by default: one file, five seconds of envelopes.
MAX_FILES = int(os.environ.get("MAX_FILES", "1"))
MAX_ENVELOPES_PER_FILE = int(os.environ.get("MAX_ENVELOPES_PER_FILE", "500"))
# Fallback when a file's header carries no DCM key.
FALLBACK_DCM_TYPE = os.environ.get("DCM_TYPE", "dbc")
FALLBACK_DCM_TARGET_KEY = os.environ.get("DCM_TARGET_KEY", "")

_state = {"files": 0}


def build_handler(fs, dcmc):
    """Return a function turning one mf4-metadata message into many envelope
    messages. Used with apply(expand=True) so QuixStreams owns the producing -
    driving a manual producer inside app.run() fights its own lifecycle.
    """

    def handle(value: dict) -> list:
        if MAX_FILES and _state["files"] >= MAX_FILES:
            return []

        blob_path = value.get("blob_path")
        if not blob_path:
            logger.warning("message has no blob_path, skipping: %s", value)
            return []

        t0 = time.time()
        logger.info("replaying %s", blob_path)
        with fs.open(blob_path, "rb") as fh:
            mf4_bytes = fh.read()

        mdf, props, frames = load_frames(mf4_bytes)

        # The MF4 names its own database. Prefer that over anything configured
        # here, so a file converted against a different DBC still decodes right.
        config_id = props.get("dcm.config_id")
        if not config_id:
            target = (
                props.get("dcm.target_key")
                or FALLBACK_DCM_TARGET_KEY
                or value.get("platform", "")
            )
            config_id = dcmc.config_id(props.get("dcm.type", FALLBACK_DCM_TYPE), target)
            logger.info("header had no dcm.config_id; derived %s", config_id)

        db = dcmc.load_database(config_id)

        device = props.get("source.device") or value.get("device")
        route = props.get("source.route") or value.get("route")
        segment = props.get("source.segment") or value.get("segment")
        platform = props.get("platform") or value.get("platform")

        out = []
        dec_total = unk_total = 0
        for seq, t_rel, sl in envelopes(frames, MAX_ENVELOPES_PER_FILE):
            recs, dec, unk = decode_envelope(db, frames, sl)
            dec_total += dec
            unk_total += unk
            payload = {
                "platform": platform,
                "device": device,
                "route": route,
                "segment": segment,
                # seq is the only surviving record of intra-envelope ordering:
                # all frames in an envelope share one timestamp, and Kafka does
                # not preserve row order.
                "seq": seq,
                "t_rel": round(t_rel, 6),
                "frame_count": len(recs),
                "decoded": dec,
                "undecoded": unk,
                "dbc": {
                    "config_id": config_id,
                    "name": props.get("dbc.name"),
                    "sha256": props.get("dbc.sha256"),
                },
                "frames": recs,
            }
            out.append(payload)

        mdf.close()
        _state["files"] += 1
        elapsed = time.time() - t0
        logger.info(
            "done %s: %d envelopes (%d frames decoded, %d undecoded) "
            "in %.1fs (%.0f env/s)",
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
        "input=%s output=%s max_files=%s max_envelopes=%s",
        INPUT_TOPIC,
        OUTPUT_TOPIC,
        MAX_FILES,
        MAX_ENVELOPES_PER_FILE,
    )

    fs = get_filesystem()
    dcmc = DcmClient()
    logger.info("DCM base: %s", dcmc.base)

    app = Application(consumer_group=CONSUMER_GROUP, auto_offset_reset="earliest")
    in_topic = app.topic(INPUT_TOPIC, value_deserializer="json")
    out_topic = app.topic(OUTPUT_TOPIC, value_serializer="json", key_serializer="str")

    sdf = app.dataframe(in_topic)
    # one metadata message -> many envelope messages
    sdf = sdf.apply(build_handler(fs, dcmc), expand=True)
    sdf = sdf.to_topic(out_topic, key=lambda v: f"{v['device']}/{v['route']}/{v['segment']}")
    app.run(sdf)

    return 0


if __name__ == "__main__":
    sys.exit(main())
