"""Serve file bytes for the download route (contract v1.1 §D — file download).

The registered files live in **SAG blob storage**. The local stack runs MinIO
instead, and both speak S3, so one client serves both. The design note
`plans/design/FILE-DOWNLOAD.md` §2 C1 forbids buffering the whole file in the
API process, so this module exposes a **streaming** byte provider.

Three providers implement the same protocol:

* `BlobFileBytes` reads from SAG blob storage. It wraps the store
  `ingest.store.build_blob_store` builds, so the download leg and the result
  upload leg hold one blob client and one credential path. This is the
  provider a deployment uses.
* `LocalFileBytes` reads from a local landing zone (opt-in for a developer who
  seeded copies to a directory named by ``TM_LANDING_ZONE``). It streams the
  file in 1 MiB chunks and never buffers the whole thing.
* `UnavailableFileBytes` refuses every read with :class:`FileBytesUnavailable`.
  This is the safe default when no blob storage is reachable. The download
  route turns the refusal into a 503 with a clear detail
  (contract v1.1 §D "storage unreachable"), and it **never** fabricates bytes.

The choice is made at import time by reading the environment. A test overrides
the provider via `app.dependency_overrides[get_file_bytes_provider] = ...`.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol, runtime_checkable
from urllib.parse import quote

CHUNK_BYTES = 1 << 20  # 1 MiB streams over 1.24 GB in ~1,270 chunks.


class FileBytesUnavailable(Exception):
    """The bytes could not be reached. The route answers 503 with the detail.

    ``reason`` is a short machine string (``"storage_unreachable"``,
    ``"blob_missing"``) that the caller may inspect for logging or a code.
    """

    def __init__(self, detail: str, reason: str = "storage_unreachable") -> None:
        super().__init__(detail)
        self.detail = detail
        self.reason = reason


@runtime_checkable
class FileBytesProvider(Protocol):
    """Stream the bytes of one registered file."""

    def open(self, storage_ref: str | None) -> tuple[Iterator[bytes], int]:
        """Return ``(byte_iterator, content_length)``.

        The iterator yields byte chunks so a Starlette ``StreamingResponse`` can
        forward them without buffering. ``content_length`` is the exact number
        of bytes the iterator will yield — the route sends it as
        ``Content-Length``.

        A missing storage reference, a missing blob or an unreachable storage
        backend must raise :class:`FileBytesUnavailable`. The route then
        answers 503 and no journal write becomes a fake trace.
        """
        ...


class UnavailableFileBytes:
    """The default provider. It always refuses.

    An environment that names no source, or that binds no blob storage, gets
    this provider. Serving fabricated bytes would break the audit rule: the
    journal write would still happen, but no real file left the server. So the
    safe default is to refuse.

    Since 18 Aug 2026 ``docker-compose.local.yml`` binds the lake MinIO to the
    api service, so the local stack reaches :class:`BlobFileBytes` instead.
    """

    def __init__(self, detail: str) -> None:
        self._detail = detail

    def open(self, storage_ref: str | None) -> tuple[Iterator[bytes], int]:
        raise FileBytesUnavailable(self._detail)


class LocalFileBytes:
    """Stream bytes from a local directory named by ``TM_LANDING_ZONE``.

    A developer who has copies of the seed MF4 files under a landing zone can
    set ``TM_INGEST_SOURCE=local`` and ``TM_LANDING_ZONE=/some/path`` and the
    download route then serves the real bytes. The ``storage_ref`` on a file
    doc is a ``blob://<bucket>/<key>`` URI; this provider maps it onto
    ``<TM_LANDING_ZONE>/<key>``. Missing keys raise ``FileBytesUnavailable``
    with reason ``blob_missing``.

    The chunks are 1 MiB (``CHUNK_BYTES``). Reading a 2.1 GB file peaks at one
    chunk in memory (§2 C1 of the design note).
    """

    def __init__(self, root: Path) -> None:
        self._root = Path(root)

    def _resolve(self, storage_ref: str | None) -> Path:
        if not storage_ref:
            raise FileBytesUnavailable(
                "file has no storage reference — download is not available",
                reason="blob_missing",
            )
        # A storage_ref is stored as `blob://<bucket>/<key>` (see seed fixtures).
        # Strip the scheme and the bucket, keeping the key.
        without_scheme = storage_ref.split("://", 1)[-1]
        parts = without_scheme.split("/", 1)
        key = parts[1] if len(parts) == 2 else parts[0]
        candidate = self._root / key
        try:
            resolved = candidate.resolve(strict=True)
        except (FileNotFoundError, OSError) as error:
            raise FileBytesUnavailable(
                f"blob is not present in the local landing zone: {key}",
                reason="blob_missing",
            ) from error
        # Prevent a `..` in the key from escaping the root. `resolve` normalizes,
        # so a suffix check on the resolved root is enough.
        try:
            resolved.relative_to(self._root.resolve())
        except ValueError as error:
            raise FileBytesUnavailable(
                "storage reference escapes the landing zone root",
                reason="storage_unreachable",
            ) from error
        return resolved

    def open(self, storage_ref: str | None) -> tuple[Iterator[bytes], int]:
        path = self._resolve(storage_ref)
        size = path.stat().st_size

        def iterator() -> Iterator[bytes]:
            with path.open("rb") as handle:
                while True:
                    chunk = handle.read(CHUNK_BYTES)
                    if not chunk:
                        return
                    yield chunk

        return iterator(), size


# Every ASCII control character, mapped onto an underscore. A header value
# carries none of them, and a bare CR or LF would split the response.
_CONTROL_CHARACTERS = {code: "_" for code in (*range(32), 127)}


def content_disposition(filename: str) -> str:
    """Build a Content-Disposition value that survives UTF-8 filenames.

    RFC 5987 ``filename*`` carries the UTF-8 encoded name for modern browsers,
    and the ASCII fallback stays for old clients. The plain filename is
    percent-encoded via :func:`urllib.parse.quote` (so a comma or a semicolon
    cannot break the header).

    **The ASCII fallback drops every control character** (21 Aug 2026). A
    filename that carries a CR or an LF built a header value that splits the
    response, and the server raised **after** the journal already recorded the
    download — the audit row then stated a download that never reached the
    caller. ``quote`` percent-encodes those characters in the ``filename*``
    half already, so only the fallback needed the guard. ``POST /files``
    refuses such a name at the door now, and a document registered before this
    date may still hold one.

    The file download and the result download both call this, so one filename
    rule guards both routes.
    """
    ascii_fallback = (
        filename.encode("ascii", "replace")
        .decode("ascii")
        .replace('"', "")
        .translate(_CONTROL_CHARACTERS)
    )
    quoted = quote(filename, safe="")
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quoted}"


def blob_key(storage_ref: str | None) -> str:
    """Map a stored ``storage_ref`` onto a key inside the blob bucket.

    The ingestion pipeline stores the bare object key. The seed stores the
    same key behind a ``blob://`` scheme
    (`api/seed/fixtures_inventory.py:112`). The filesystem `quixportal` builds
    is already scoped to the bucket, so the whole remainder is the key. This
    differs from :class:`LocalFileBytes`, which also drops the first segment.
    """
    if not storage_ref or not storage_ref.strip():
        raise FileBytesUnavailable(
            "file has no storage reference — download is not available",
            reason="blob_missing",
        )
    return storage_ref.strip().split("://", 1)[-1].lstrip("/")


class BlobFileBytes:
    """Stream bytes from SAG blob storage, through `ingest.store`.

    The store is `ingest.store.BlobStore`. It wraps the fsspec filesystem that
    `quixportal` builds from ``Quix__BlobStorage__Connection__Json``, which the
    platform injects when a deployment carries ``blobStorage: bind: true``.
    The API therefore holds no second blob client and no second credential.

    ``open`` reads the object size and returns an iterator that has **not**
    started. fsspec answers the size from object metadata, so no data byte
    moves before the route writes the audit entry. That keeps the
    audit-before-bytes rule (`plans/AGENT-RULES.md:130`) exactly as
    :class:`LocalFileBytes` keeps it.
    """

    def __init__(self, store: Any) -> None:
        self._store = store

    def open(self, storage_ref: str | None) -> tuple[Iterator[bytes], int]:
        key = blob_key(storage_ref)
        try:
            handle = self._store.open(key)
        except Exception as error:  # fsspec raises many types for one fault.
            raise FileBytesUnavailable(
                f"blob is not present in storage: {key}",
                reason="blob_missing",
            ) from error
        size = int(getattr(handle, "size", None) or 0)

        def iterator() -> Iterator[bytes]:
            # `with` closes the handle when the stream ends or the client goes.
            # An iterator that never starts leaves the handle to the garbage
            # collector, which closes it. fsspec holds no socket until a read.
            with handle:
                while True:
                    chunk = handle.read(CHUNK_BYTES)
                    if not chunk:
                        return
                    yield chunk

        return iterator(), size


def build_blob_provider() -> FileBytesProvider:
    """Build :class:`BlobFileBytes` over the blob store, or refuse.

    A missing credential, a missing `quixportal` install or a bad connection
    string returns :class:`UnavailableFileBytes`, so the route answers 503 and
    the API still starts.
    """
    try:
        from ingest.store import build_blob_store
    except ImportError:
        return UnavailableFileBytes(
            "Storage unreachable — the blob client is not installed in this image."
        )
    try:
        return BlobFileBytes(build_blob_store())
    except Exception:  # noqa: BLE001 — a bad credential must not stop the API.
        return UnavailableFileBytes(
            "Storage unreachable — no blob storage is bound to this deployment."
        )


def build_default_provider() -> FileBytesProvider:
    """Pick the provider from the environment. Called by the FastAPI dependency.

    ``TM_INGEST_SOURCE`` picks the source, and it carries the same two values
    `ingest.store.build_store` reads.

    * ``blob`` reads SAG blob storage. A deployment needs
      ``blobStorage: bind: true`` so the platform injects
      ``Quix__BlobStorage__Connection__Json``.
    * ``local`` reads the directory named by ``TM_LANDING_ZONE``.

    **An unset value reads as ``blob``** (21 Aug 2026). It read as "no source"
    here and as ``blob`` in `ingest.store.build_store`, so one name meant two
    things and the byte seed and the download route reached two different
    stores. The blob branch still fails closed: without a bound blob storage
    :func:`build_blob_provider` answers :class:`UnavailableFileBytes`.

    Any other value returns :class:`UnavailableFileBytes`. The route then
    answers 503 and never fabricates a byte.
    """
    source = os.environ.get("TM_INGEST_SOURCE", "blob").strip().lower()
    if source == "local":
        root = os.environ.get("TM_LANDING_ZONE", "").strip()
        if root:
            path = Path(root)
            if path.exists():
                return LocalFileBytes(path)
    elif source == "blob":
        return _cached_blob_provider()
    return UnavailableFileBytes(
        "Storage unreachable — file bytes are not available in this environment."
    )


@lru_cache(maxsize=1)
def _cached_blob_provider() -> FileBytesProvider:
    """Build the blob provider once. The dependency runs on every request."""
    return build_blob_provider()


def get_file_bytes_provider() -> FileBytesProvider:
    """FastAPI dependency. Tests override this via ``app.dependency_overrides``."""
    return build_default_provider()


__all__ = [
    "CHUNK_BYTES",
    "BlobFileBytes",
    "FileBytesProvider",
    "FileBytesUnavailable",
    "LocalFileBytes",
    "UnavailableFileBytes",
    "blob_key",
    "build_blob_provider",
    "build_default_provider",
    "content_disposition",
    "get_file_bytes_provider",
]
