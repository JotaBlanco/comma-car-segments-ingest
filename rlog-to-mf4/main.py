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
from resolve import Resolver

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("rlog-to-mf4")

HERE = os.path.dirname(os.path.abspath(__file__))

# The mirror preserves HuggingFace's own layout, which is
#   segments/<device>/<route>/<idx>/rlog.zst
# There is NO platform directory - platform-to-device is a manifest lookup, not
# a path segment. Selecting a platform therefore means selecting its devices.
INPUT_PREFIX = os.environ.get("INPUT_PREFIX", "commacarsegments/segments/")
# Optional narrowing, both empty = convert every vehicle in blob. PLATFORMS is
# expanded to its devices through the same tables used to resolve each
# recording, so a filter can never disagree with the data the way a PLATFORM
# constant could.
PLATFORMS = [
    p.strip() for p in os.environ.get("PLATFORMS", "").split(",") if p.strip()
]
DEVICES = [
    d.strip() for d in os.environ.get("DEVICES", "").split(",") if d.strip()
]
OUTPUT_PREFIX = os.environ.get("OUTPUT_PREFIX", "mf4/")
DCM_TYPE = os.environ.get("DCM_TYPE", "dbc")
DBC_VERSION = os.environ.get("DBC_VERSION", "opendbc-0.3.1")
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
    resolver = Resolver()
    logger.info("input=%s  output=%s  max=%d", INPUT_PREFIX, OUTPUT_PREFIX, MAX_SEGMENTS)

    fs = get_filesystem()

    app = Application(consumer_group="rlog-to-mf4")
    out_topic = app.topic(OUTPUT_TOPIC, value_serializer="json", key_serializer="str")

    base = INPUT_PREFIX.rstrip("/")
    # PLATFORMS wins over DEVICES: it is derived from the same tables that
    # resolve each recording, so it cannot drift from the dataset the way a
    # hand-maintained device list can. Both empty = every vehicle in blob.
    if PLATFORMS:
        devices = resolver.devices_for_platforms(PLATFORMS)
        logger.info(
            "PLATFORMS=%s -> %d device(s)", ",".join(PLATFORMS), len(devices)
        )
        if DEVICES:
            logger.warning("DEVICES ignored because PLATFORMS is set")
    else:
        devices = DEVICES

    candidates = []
    if devices:
        logger.info("selecting %d device(s)", len(devices))
        for dev in devices:
            found = sorted(fs.glob(f"{base}/{dev}/**/rlog.zst"))
            logger.info("  %s -> %d segments", dev, len(found))
            candidates.extend(found)
    else:
        logger.info("listing every device under %s", base)
        candidates = sorted(fs.glob(f"{base}/**/rlog.zst"))
    logger.info("found %d rlog segments in total", len(candidates))

    if not candidates:
        # The mirror job walks the whole dataset (188k files); a device this
        # platform uses may simply not have been copied yet.
        logger.warning(
            "nothing to convert under %s for devices=%s - the HF mirror may not "
            "have reached these devices yet",
            base,
            devices or "<all>",
        )
        try:
            top = fs.ls(base, detail=False)[:10]
            logger.info("sample of what IS under %s: %s", base, top)
        except Exception as exc:  # noqa: BLE001 - diagnostic only
            logger.info("could not list %s: %s", base, exc)
        return 0

    converted = skipped = failed = 0
    unresolved: dict[str, int] = {}
    with app.get_producer() as producer:
        for src in candidates:
            # 0 = no limit, matching MAX_FILES in mf4-replay. Without the guard
            # 0 would break on the first candidate and convert nothing.
            if MAX_SEGMENTS and converted >= MAX_SEGMENTS:
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

            # Platform comes from the recording, never from configuration. A
            # device that was moved between cars resolves at route grain.
            platform, dbc_name, dbc_bytes, why = resolver.resolve(device, route)
            if why:
                unresolved[why] = unresolved.get(why, 0) + 1
                logger.debug("skip (%s): %s/%s", why, device, route)
                continue

            dest = (
                f"{OUTPUT_PREFIX.rstrip('/')}/{platform}/{device}/{route}/"
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
                    dbc_name=f"{dbc_name}.dbc",
                    dbc_version=DBC_VERSION,
                    dcm_type=DCM_TYPE,
                    # The DCM configs are keyed by DBC name, not by platform:
                    # one database serves many platforms, so platform-keying
                    # would duplicate 40 databases across 188 configs.
                    dcm_target_key=dbc_name,
                    platform=platform,
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
                "platform": platform,
                "device": device,
                "route": route,
                "segment": segment,
                "blob_path": dest,
                "source_path": src,
                "sha256_dbc": stats["dbc_sha256"],
                "dcm": {
                    "type": DCM_TYPE,
                    "target_key": dbc_name,
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
        "done. converted=%d skipped=%d failed=%d unresolved=%d",
        converted,
        skipped,
        failed,
        sum(unresolved.values()),
    )
    # Never let skipped work be silent - "converted 0" with no reason is the
    # failure mode that wastes an afternoon.
    for why, n in sorted(unresolved.items(), key=lambda kv: -kv[1]):
        logger.info("  unresolved %-22s %d segments", why, n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
