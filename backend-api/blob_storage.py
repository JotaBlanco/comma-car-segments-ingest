"""Wrapper around quixportal's blob storage filesystem access. Guarded so the
app keeps running (with this feature disabled) when blob storage is not
bound to the deployment."""
import logging
import os

logger = logging.getLogger(__name__)

try:
    from quixportal import get_filesystem
except ImportError:  # pragma: no cover - exercised only when dependency missing
    get_filesystem = None


def is_available() -> bool:
    return get_filesystem is not None and bool(os.environ.get("Quix__BlobStorage__Connection__Json"))


def _fs():
    if get_filesystem is None:
        logger.warning("quixportal is not installed; blob storage is disabled")
        return None
    if not os.environ.get("Quix__BlobStorage__Connection__Json"):
        logger.warning("Quix__BlobStorage__Connection__Json is not set; blob storage is disabled")
        return None
    try:
        return get_filesystem()
    except Exception as exc:
        logger.warning("Blob storage unavailable: %s", exc)
        return None


def write_artifact(path: str, data: bytes) -> bool:
    fs = _fs()
    if fs is None:
        return False
    with fs.open(path, "wb") as f:
        f.write(data)
    return True


def read_artifact(path: str) -> bytes | None:
    fs = _fs()
    if fs is None:
        return None
    with fs.open(path, "rb") as f:
        return f.read()
