"""The blob seam, in the shape this service needs (read an object, write a JSON sidecar).

This is a deliberate second copy of the seam in ``backend-api/blob_storage.py``,
following the convention already in this repo (``backend-api/blob_storage.py`` and
``mongo-backup-manager/blob_storage.py`` are near-identical). Quix builds every
application from its own folder, so a module cannot be imported across deployment
boundaries; the alternative to a copy is a published package, which is not worth
it for a 120-line adapter.

Selection is identical to the backend's: ``TM_BLOB_BACKEND`` of
``auto|quix|local|off``, with ``TM_BLOB_LOCAL_ROOT`` for the local backend.

Operational caveat, stated plainly: the local backend is for development and
testing. Two Quix deployments do not share a filesystem, so a local root cannot
carry an object from the API to this extractor in the cloud. With blob storage
genuinely unavailable, the ingest pipeline cannot run - and this service says so
in its log and marks the trace ``failed`` rather than pretending to extract.
"""

import logging
import os
import posixpath
from pathlib import Path
from typing import IO

logger = logging.getLogger(__name__)

BLOB_ENV_VAR = "Quix__BlobStorage__Connection__Json"


class BlobUnavailableError(RuntimeError):
    """Raised when an operation needs blob storage and none is configured."""


class QuixBlobBackend:
    name = "quix"

    def __init__(self) -> None:
        from quixportal import get_filesystem

        self._fs = get_filesystem()

    def open(self, path: str, mode: str = "rb") -> IO:
        return self._fs.open(path, mode)

    def exists(self, path: str) -> bool:
        return bool(self._fs.exists(path))


class LocalBlobBackend:
    name = "local"

    def __init__(self, root: str) -> None:
        self._root = Path(root).resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    def _resolve(self, path: str) -> Path:
        clean = posixpath.normpath(path.strip("/"))
        if clean.startswith("..") or clean == ".":
            raise ValueError(f"Illegal blob path: {path!r}")
        return self._root / Path(*clean.split("/"))

    def open(self, path: str, mode: str = "rb") -> IO:
        target = self._resolve(path)
        if any(flag in mode for flag in ("w", "a", "x")):
            target.parent.mkdir(parents=True, exist_ok=True)
        if "b" in mode:
            return open(target, mode)
        return open(target, mode, encoding="utf-8", newline="")

    def exists(self, path: str) -> bool:
        return self._resolve(path).exists()


class NullBlobBackend:
    name = "unavailable"

    def __init__(self, reason: str) -> None:
        self.reason = reason

    def open(self, path: str, mode: str = "rb") -> IO:
        raise BlobUnavailableError(self.reason)

    def exists(self, path: str) -> bool:
        raise BlobUnavailableError(self.reason)


def build_backend():
    choice = (os.environ.get("TM_BLOB_BACKEND") or "auto").strip().lower()
    local_root = os.environ.get("TM_BLOB_LOCAL_ROOT") or ""

    if choice == "off":
        return NullBlobBackend("blob storage disabled by TM_BLOB_BACKEND=off")

    if choice in ("quix", "auto"):
        have_creds = bool(os.environ.get(BLOB_ENV_VAR))
        if choice == "quix" or have_creds:
            if not have_creds:
                return NullBlobBackend(
                    f"TM_BLOB_BACKEND=quix but {BLOB_ENV_VAR} is not set - this deployment is "
                    "not bound to blob storage"
                )
            try:
                return QuixBlobBackend()
            except ImportError:
                return NullBlobBackend("quixportal is not installed")
            except Exception as exc:  # noqa: BLE001 - report, never crash the worker
                logger.warning("Quix blob filesystem unavailable: %s", exc)
                return NullBlobBackend(f"Quix blob filesystem unavailable: {exc}")

    if choice in ("local", "auto"):
        if not local_root:
            return NullBlobBackend(
                f"no blob storage available: {BLOB_ENV_VAR} unset and TM_BLOB_LOCAL_ROOT empty"
            )
        try:
            return LocalBlobBackend(local_root)
        except OSError as exc:
            return NullBlobBackend(f"local blob root {local_root!r} is unusable: {exc}")

    return NullBlobBackend(f"unknown TM_BLOB_BACKEND value {choice!r}")


_backend = None


def get_backend():
    global _backend
    if _backend is None:
        _backend = build_backend()
        logger.info("Blob backend resolved to %r", _backend.name)
    return _backend


def require():
    backend = get_backend()
    if isinstance(backend, NullBlobBackend):
        raise BlobUnavailableError(backend.reason)
    return backend


def read_bytes(path: str) -> bytes:
    with require().open(path, "rb") as handle:
        return handle.read()


def write_bytes(path: str, data: bytes) -> None:
    with require().open(path, "wb") as handle:
        handle.write(data)
