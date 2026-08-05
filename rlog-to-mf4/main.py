"""Convert mirrored commaCarSegments rlogs into raw CAN-FD bus-logging MF4 files.

Reads rlog.zst from blob (written by the HF mirror job), converts each segment
in memory, writes the MF4 back to blob, and publishes one metadata message per
file so downstream services can discover what was produced.

Runs as a Job: it walks the input prefix once and exits.
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys
import time

from quixportal import get_filesystem
from quixstreams import Application

from converter import build_mf4, decompress_rlog, read_can_frames

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("rlog-to-mf4")

HERE = os.path.dirname(os.path.abspath(__file__))

INPUT_PREFIX = os.environ.get(
    "INPUT_PREFIX", "commacarsegments/segments/FORD_F_150_LIGHTNING_MK1/"
)
OUTPUT_PREFIX = os.environ.get("OUTPUT_PREFIX", "mf4/")
PLATFORM = os.environ.get("PLATFORM", "FORD_F_150_LIGHTNING_MK1")
DCM_TYPE = os.environ.get("DCM_TYPE", "dbc")
DCM_TARGET_KEY = os.environ.get("DCM_TARGET_KEY", PLATFORM)
DBC_FILE = os.environ.get("DBC_FILE", "ford_lincoln_base_pt.dbc")
DBC_VERSION = os.environ.get("DBC_VERSION", "opendbc-master")
MAX_SEGMENTS = int(os.environ.get("MAX_SEGMENTS", "20"))
SKIP_EXISTING = os.environ.get("SKIP_EXISTING", "true").strip().lower() in (
    "1",
    "true",
    "yes",
    "y",
    "on",
)
OUTPUT_TOPIC = os.environ.get("output", "mf4-metadata")


def parse_segment_path(path: str):
    """segments/<platform>/<device>/<route>/<idx>/rlog.zst -> (device, route, idx).

    Returns None when the path does not have that shape.
    """
    parts = [p for p in path.split("/") if p]
    if len(parts) < 5 or parts[-1] != "rlog.zst":
        return None
    return parts[-4], parts[-3], parts[-2]


def main() -> int:
    dbc_path = os.path.join(HERE, DBC_FILE)
    dbc_bytes = open(dbc_path, "rb").read()
    dbc_sha = hashlib.sha256(dbc_bytes).hexdigest()
    logger.info(
        "DBC %s  %d bytes  sha256=%s", DBC_FILE, len(dbc_bytes), dbc_sha[:16]
    )
    logger.info("input=%s  output=%s  max=%d", INPUT_PREFIX, OUTPUT_PREFIX, MAX_SEGMENTS)

    fs = get_filesystem()

    app = Application(consumer_group="rlog-to-mf4")
    out_topic = app.topic(OUTPUT_TOPIC, value_serializer="json", key_serializer="str")

    pattern = INPUT_PREFIX.rstrip("/") + "/**/rlog.zst"
    logger.info("listing %s", pattern)
    candidates = sorted(fs.glob(pattern))
    logger.info("found %d rlog segments under the input prefix", len(candidates))
    if not candidates:
        logger.warning(
            "nothing to convert - has the HF mirror job finished writing %s ?",
            INPUT_PREFIX,
        )
        return 0

    converted = skipped = failed = 0
    with app.get_producer() as producer:
        for src in candidates:
            if converted >= MAX_SEGMENTS:
                logger.info(
                    "reached MAX_SEGMENTS=%d; %d candidates left unconverted",
                    MAX_SEGMENTS,
                    len(candidates) - converted - skipped - failed,
                )
                break

            parsed = parse_segment_path(src)
            if parsed is None:
                logger.warning("unexpected path shape, skipping: %s", src)
                continue
            device, route, segment = parsed

            dest = (
                f"{OUTPUT_PREFIX.rstrip('/')}/{PLATFORM}/{device}/{route}/"
                f"{segment}.mf4"
            )
            if SKIP_EXISTING and fs.exists(dest):
                logger.info("skip (exists): %s", dest)
                skipped += 1
                continue

            t0 = time.time()
            try:
                with fs.open(src, "rb") as fh:
                    raw = fh.read()
                frames = read_can_frames(decompress_rlog(raw))
                data, stats = build_mf4(
                    frames,
                    dbc_bytes=dbc_bytes,
                    dbc_name=DBC_FILE,
                    dbc_version=DBC_VERSION,
                    dcm_type=DCM_TYPE,
                    dcm_target_key=DCM_TARGET_KEY,
                    platform=PLATFORM,
                    device=device,
                    route=route,
                    segment=segment,
                )
                with fs.open(dest, "wb") as fh:
                    fh.write(data)
            except Exception as exc:  # noqa: BLE001 - keep going through the set
                logger.error("failed %s: %s", src, exc)
                failed += 1
                continue

            payload = {
                "platform": PLATFORM,
                "device": device,
                "route": route,
                "segment": segment,
                "blob_path": dest,
                "source_path": src,
                "sha256_dbc": stats["dbc_sha256"],
                "dcm": {
                    "type": DCM_TYPE,
                    "target_key": DCM_TARGET_KEY,
                    "config_id": stats["dcm_config_id"],
                },
                "frames": stats["frames"],
                "canfd_frames": stats["canfd_frames"],
                "duration_s": stats["duration_s"],
                "buses": stats["buses"],
                "size_bytes": stats["size_bytes"],
                "format": "ASAM MDF 4.10 CAN bus logging (raw, undecoded)",
                "source": "rlog-to-mf4",
            }
            msg = out_topic.serialize(key=f"{device}/{route}/{segment}", value=payload)
            producer.produce(topic=out_topic.name, key=msg.key, value=msg.value)

            converted += 1
            logger.info(
                "[%d] %s  %d frames (%d FD)  %.1fs  %d bytes  in %.1fs",
                converted,
                dest,
                stats["frames"],
                stats["canfd_frames"],
                stats["duration_s"],
                stats["size_bytes"],
                time.time() - t0,
            )

    logger.info(
        "done. converted=%d skipped=%d failed=%d", converted, skipped, failed
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
