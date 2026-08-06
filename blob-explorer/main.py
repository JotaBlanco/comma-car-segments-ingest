"""One-shot job that prints what is actually in blob storage.

Blob is only reachable from inside the cluster: the Storage Access Gateway is
publicly routable but requires SigV4 signing with credentials that exist solely
as Quix__BlobStorage__Connection__Json inside a deployment. So answering "what is
in this prefix" needs a job, not a local script.

Read-only. Lists prefixes, counts files and sums sizes.
"""

from __future__ import annotations

import logging
import os
import sys

from quixportal import get_filesystem

logging.basicConfig(
    level=os.environ.get("LOGLEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("blob-explorer")

# comma-separated prefixes to inspect; empty entry means the root
PREFIXES = [
    p.strip()
    for p in os.environ.get("PREFIXES", ",car-data-raw,commacarsegments,mf4,can-lake").split(",")
]
MAX_DEPTH = int(os.environ.get("MAX_DEPTH", "3"))
MAX_ENTRIES = int(os.environ.get("MAX_ENTRIES", "40"))
COUNT_PREFIX = os.environ.get("COUNT_PREFIX", "commacarsegments/segments")
DEVICES = [d.strip() for d in os.environ.get("DEVICES", "").split(",") if d.strip()]


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:,.1f} {unit}"
        n /= 1024
    return f"{n:,.1f} PB"


def listing(fs, path: str):
    try:
        return fs.ls(path, detail=True)
    except Exception as exc:  # noqa: BLE001 - a missing prefix is a valid answer
        logger.info("    (cannot list %r: %s)", path, exc)
        return []


def walk(fs, path: str, depth: int = 0) -> None:
    if depth > MAX_DEPTH:
        return
    entries = listing(fs, path)
    if not entries:
        return
    dirs = [e for e in entries if e.get("type") == "directory"]
    files = [e for e in entries if e.get("type") != "directory"]
    total = sum(e.get("size") or 0 for e in files)
    pad = "  " * (depth + 1)
    if files:
        logger.info("%s%d file(s), %s", pad, len(files), human(total))
        for f in files[:3]:
            logger.info("%s  %s  (%s)", pad, f["name"].split("/")[-1],
                        human(f.get("size") or 0))
    for d in dirs[:MAX_ENTRIES]:
        logger.info("%s%s/", pad, d["name"].rstrip("/").split("/")[-1])
        walk(fs, d["name"], depth + 1)
    if len(dirs) > MAX_ENTRIES:
        logger.info("%s... and %d more directories", pad, len(dirs) - MAX_ENTRIES)


def main() -> int:
    fs = get_filesystem()

    for prefix in PREFIXES:
        label = prefix or "<root>"
        logger.info("=" * 70)
        logger.info("PREFIX: %s", label)
        logger.info("=" * 70)
        walk(fs, prefix)

    # How much of the mirror actually landed, per device
    if DEVICES:
        logger.info("=" * 70)
        logger.info("SEGMENT COUNTS UNDER %s", COUNT_PREFIX)
        logger.info("=" * 70)
        grand = 0
        for dev in DEVICES:
            try:
                found = fs.glob(f"{COUNT_PREFIX}/{dev}/**/rlog.zst")
            except Exception as exc:  # noqa: BLE001
                logger.info("  %s -> error: %s", dev, exc)
                continue
            grand += len(found)
            logger.info("  %s -> %d rlog.zst", dev, len(found))
        logger.info("  TOTAL %d", grand)

    return 0


if __name__ == "__main__":
    sys.exit(main())
