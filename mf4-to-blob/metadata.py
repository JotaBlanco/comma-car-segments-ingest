"""Build the Kafka metadata payload (spec §7.2)."""

from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

# Characters kept verbatim in the filename part of an upload id. Everything
# else collapses to "_" so the id stays safe as a blob path segment, a Kafka
# message key and an Iceberg column value.
_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]+")

# Keep the filename part bounded so the whole id stays comfortably short.
_MAX_STEM_LEN = 64

# Length of the hex digest suffix taken from the sha256.
_HASH_LEN = 12


def make_upload_id(filename: str, minted_at: Optional[datetime] = None) -> str:
    """Mint the pipeline-wide unique key for one uploaded file.

    Format::

        <safe_stem>-<hash12>

    where

    * ``safe_stem``  the upload's filename with any directory component and
      the extension stripped, every character outside ``[A-Za-z0-9._-]``
      replaced by ``_``, truncated to 64 characters (``"upload"`` if nothing
      survives). This keeps the human-readable filename in the key so a lake
      row can be eyeballed back to its source file.
    * ``hash12``  the first 12 hex characters of
      ``sha256(f"{filename}\x00{minted_at_iso}")`` where ``minted_at_iso`` is
      the UTC mint time to microsecond resolution. This is the "hash generated
      from filename and time" that makes the key unique across re-uploads of
      an identically named file.

    Example: ``"Recording 001.mf4"`` uploaded at
    ``2026-08-19T10:22:33.123456+00:00`` yields
    ``Recording_001-7a9622106da0``.

    The value is minted once per upload (at SAS-mint time) and then stays
    fixed for that upload: it is the ``uploadId`` handed to the browser, the
    Kafka message key, the ``id`` field on the ``mf4_metadata`` message and,
    downstream, the ``upload_id`` Iceberg column.
    """
    minted_at = minted_at or datetime.now(timezone.utc)
    stem = _safe_stem(filename)
    digest = hashlib.sha256(
        f"{filename}\x00{minted_at.isoformat()}".encode("utf-8")
    ).hexdigest()[:_HASH_LEN]
    return f"{stem}-{digest}"


def _safe_stem(filename: str) -> str:
    """Filename without directories/extension, reduced to safe characters."""
    base = os.path.basename(filename or "").strip()
    stem = os.path.splitext(base)[0]
    stem = _UNSAFE_CHARS.sub("_", stem).strip("._-")
    return stem[:_MAX_STEM_LEN] or "upload"


def build_payload(
    *,
    upload_id: str,
    filename: str,
    blob_path: str,
    size_bytes: int,
    sha256_hex: Optional[str],
    content_type: Optional[str],
    blob_url: Optional[str],
    uploader_ip: Optional[str],
) -> dict[str, Any]:
    """Assemble the ``mf4_metadata`` message.

    ``upload_id`` is the unique key minted by :func:`make_upload_id` and is
    published as the ``id`` field — that field is what mf4-decoder reads and
    forwards to the lake.
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
    return {
        "id": upload_id,
        "filename": filename,
        "blob_path": blob_path,
        "blob_url": blob_url,
        "size_bytes": int(size_bytes),
        "content_type": content_type or "application/x-mdf",
        "sha256": sha256_hex,
        "uploaded_at": now,
        "uploader_ip": uploader_ip,
        "source": "mf4-to-blob",
    }
