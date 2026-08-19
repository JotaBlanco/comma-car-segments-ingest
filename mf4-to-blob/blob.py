"""Thin wrapper around quixportal.storage.get_filesystem().

Quix Cloud auto-injects Quix__BlobStorage__Connection__Json into every
workspace deployment; quixportal reads it and returns the right fsspec
backend (Azure / GCP / S3 / local). No operator-supplied credentials.
"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

_fs = None


def get_fs():
    """Return a process-wide fsspec filesystem; lazy so import never fails."""
    global _fs
    if _fs is None:
        from quixportal.storage import get_filesystem
        _fs = get_filesystem()
        logger.info("Blob storage connected via quixportal.storage.get_filesystem()")
    return _fs


def open_writer(blob_path: str):
    """Open a binary writer on the underlying filesystem.

    fsspec backends (adlfs, s3fs, LocalFileSystem) buffer chunks and flush
    in provider-native blocks, so memory stays bounded as we stream.
    Deliberately NOT using fs.pipe() — that would buffer the whole file.
    """
    return get_fs().open(blob_path, "wb")


def safe_remove(blob_path: str) -> None:
    """Best-effort partial-blob cleanup. Tolerate missing-object errors."""
    try:
        get_fs().rm(blob_path)
        logger.info("Removed partial blob: %s", blob_path)
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not remove partial blob %s: %s", blob_path, e)


def resolve_blob_path(filename: str, prefix: str, policy: str) -> tuple[str, Optional[str]]:
    """Resolve the target blob path per collision policy.

    Returns (blob_path, error). On `reject` collision, error is set and
    blob_path is still the proposed target (caller returns 409 to client).
    Date partitioning (YYYY/MM/DD) is added under the prefix so listings
    stay reasonable.
    """
    safe_name = _sanitize(filename)
    stem, ext = _splitext(safe_name)
    today = datetime.now(timezone.utc)
    dated_prefix = f"{prefix.rstrip('/')}/{today.strftime('%Y/%m/%d')}"

    if policy == "overwrite":
        return f"{dated_prefix}/{safe_name}", None

    if policy == "reject":
        candidate = f"{dated_prefix}/{safe_name}"
        try:
            if get_fs().exists(candidate):
                return candidate, "blob already exists"
        except Exception as e:  # noqa: BLE001
            logger.warning("exists() probe failed (%s); proceeding anyway", e)
        return candidate, None

    suffix = uuid.uuid4().hex[:8]
    return f"{dated_prefix}/{stem}-{suffix}{ext}", None


def _sanitize(name: str) -> str:
    """Strip path separators and control chars; keep it simple."""
    name = os.path.basename(name).strip()
    return "".join(c for c in name if c.isprintable() and c not in ("\\", "/")) or "upload.mf4"


def _splitext(name: str) -> tuple[str, str]:
    stem, ext = os.path.splitext(name)
    return stem or "upload", ext or ".mf4"
