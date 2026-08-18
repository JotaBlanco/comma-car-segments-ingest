"""The blob seam: one interface, two interchangeable implementations.

Why a seam rather than a direct ``quixportal.get_filesystem()`` call: the
testrig Storage Gateway is currently unreachable, so no deployment may carry
``blobStorage: {bind: true}`` and ``Quix__BlobStorage__Connection__Json`` is
absent. Every blob-touching code path therefore has to work against a local
filesystem for development and testing, and has to fail with a *named cause*
rather than a silent success when neither backend is available.

Path semantics are identical through both backends: every path is
bucket-relative POSIX, e.g. ``test-manager/requirements/v0003/manifest.json``.
The local backend maps that onto ``<root>/test-manager/requirements/...``.

Selection (``TM_BLOB_BACKEND``):

* ``quix``  - always the Quix filesystem; unavailable if credentials are missing.
* ``local`` - always the local filesystem rooted at ``TM_BLOB_LOCAL_ROOT``.
* ``off``   - no backend; every blob operation raises ``BlobUnavailableError``.
* ``auto``  - (default) Quix if credentials are injected, else local if
  ``TM_BLOB_LOCAL_ROOT`` is set, else unavailable.

Nothing in this module raises at import time.
"""

import logging
import os
import posixpath
import shutil
from pathlib import Path
from typing import IO, Protocol

import settings

logger = logging.getLogger(__name__)

BLOB_ENV_VAR = "Quix__BlobStorage__Connection__Json"


class BlobUnavailableError(RuntimeError):
    """Raised when an operation needs blob storage and none is configured."""


class BlobBackend(Protocol):
    """The whole surface the Test Manager needs from an object store."""

    name: str

    def open(self, path: str, mode: str = "rb") -> IO: ...

    def exists(self, path: str) -> bool: ...

    def ls(self, path: str) -> list[str]: ...

    def glob(self, pattern: str) -> list[str]: ...

    def copy(self, src: str, dst: str) -> None: ...

    def size(self, path: str) -> int: ...

    def rm_tree(self, path: str) -> None: ...


class QuixBlobBackend:
    """``quixportal.get_filesystem()`` - the real thing."""

    name = "quix"

    def __init__(self) -> None:
        from quixportal import get_filesystem

        self._fs = get_filesystem()

    def open(self, path: str, mode: str = "rb") -> IO:
        return self._fs.open(path, mode)

    def exists(self, path: str) -> bool:
        return bool(self._fs.exists(path))

    def ls(self, path: str) -> list[str]:
        try:
            entries = self._fs.ls(path, detail=False)
        except FileNotFoundError:
            return []
        return sorted(str(entry).lstrip("/") for entry in entries)

    def glob(self, pattern: str) -> list[str]:
        return sorted(str(match).lstrip("/") for match in self._fs.glob(pattern))

    def copy(self, src: str, dst: str) -> None:
        with self._fs.open(src, "rb") as fh_in, self._fs.open(dst, "wb") as fh_out:
            shutil.copyfileobj(fh_in, fh_out)

    def size(self, path: str) -> int:
        return int(self._fs.size(path))

    def rm_tree(self, path: str) -> None:
        try:
            self._fs.rm(path, recursive=True)
        except FileNotFoundError:
            pass


class LocalBlobBackend:
    """A plain directory tree with the same bucket-relative path semantics.

    Used for local development and for Tester's runs. It is a first-class
    implementation, not a stub: the artifact store, version minting and the
    staged-commit protocol are all exercised through it unchanged.
    """

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

    def ls(self, path: str) -> list[str]:
        target = self._resolve(path)
        if not target.is_dir():
            return []
        return sorted(
            posixpath.join(path.strip("/"), child.name) for child in target.iterdir()
        )

    def glob(self, pattern: str) -> list[str]:
        matches = self._root.glob(pattern.strip("/"))
        return sorted(match.relative_to(self._root).as_posix() for match in matches)

    def copy(self, src: str, dst: str) -> None:
        target = self._resolve(dst)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self._resolve(src), target)

    def size(self, path: str) -> int:
        return self._resolve(path).stat().st_size

    def rm_tree(self, path: str) -> None:
        target = self._resolve(path)
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        elif target.exists():
            target.unlink()


class NullBlobBackend:
    """No blob storage configured. Every call fails loudly, naming the cause."""

    name = "unavailable"

    def __init__(self, reason: str) -> None:
        self.reason = reason

    def _fail(self) -> None:
        raise BlobUnavailableError(self.reason)

    def open(self, path: str, mode: str = "rb") -> IO:
        self._fail()

    def exists(self, path: str) -> bool:
        self._fail()

    def ls(self, path: str) -> list[str]:
        self._fail()

    def glob(self, pattern: str) -> list[str]:
        self._fail()

    def copy(self, src: str, dst: str) -> None:
        self._fail()

    def size(self, path: str) -> int:
        self._fail()

    def rm_tree(self, path: str) -> None:
        self._fail()


def build_backend() -> BlobBackend:
    """Resolve the configured backend. Never raises; returns Null on failure."""
    choice = settings.blob_backend_name()
    local_root = settings.blob_local_root()

    if choice == "off":
        return NullBlobBackend("blob storage disabled by TM_BLOB_BACKEND=off")

    if choice in ("quix", "auto"):
        have_creds = bool(os.environ.get(BLOB_ENV_VAR))
        if choice == "quix" or have_creds:
            if not have_creds:
                return NullBlobBackend(
                    f"TM_BLOB_BACKEND=quix but {BLOB_ENV_VAR} is not set - this deployment "
                    "is not bound to blob storage (blobStorage.bind is disabled while the "
                    "testrig Storage Gateway is unreachable)"
                )
            try:
                return QuixBlobBackend()
            except ImportError:
                return NullBlobBackend(
                    "quixportal is not installed; cannot use the Quix blob filesystem"
                )
            except Exception as exc:  # noqa: BLE001 - report, never crash the service
                logger.warning("Quix blob filesystem unavailable: %s", exc)
                return NullBlobBackend(f"Quix blob filesystem unavailable: {exc}")

    if choice in ("local", "auto"):
        if not local_root:
            return NullBlobBackend(
                "no blob storage available: "
                f"{BLOB_ENV_VAR} is not set and TM_BLOB_LOCAL_ROOT is empty"
            )
        try:
            return LocalBlobBackend(local_root)
        except OSError as exc:
            return NullBlobBackend(f"local blob root {local_root!r} is unusable: {exc}")

    return NullBlobBackend(f"unknown TM_BLOB_BACKEND value {choice!r}")


_backend: BlobBackend | None = None


def get_backend() -> BlobBackend:
    """Process-wide backend, built on first use."""
    global _backend
    if _backend is None:
        _backend = build_backend()
        logger.info("Blob backend resolved to %r", _backend.name)
    return _backend


def reset_backend() -> None:
    """Drop the cached backend (used when configuration changes under test)."""
    global _backend
    _backend = None


def is_available() -> bool:
    return not isinstance(get_backend(), NullBlobBackend)


def backend_name() -> str:
    return get_backend().name


def unavailable_reason() -> str | None:
    backend = get_backend()
    return backend.reason if isinstance(backend, NullBlobBackend) else None


def require() -> BlobBackend:
    """Return the backend or raise ``BlobUnavailableError`` naming the cause."""
    backend = get_backend()
    if isinstance(backend, NullBlobBackend):
        raise BlobUnavailableError(backend.reason)
    return backend


def write_bytes(path: str, data: bytes) -> None:
    with require().open(path, "wb") as fh:
        fh.write(data)


def read_bytes(path: str) -> bytes:
    with require().open(path, "rb") as fh:
        return fh.read()


def write_text(path: str, text: str) -> None:
    write_bytes(path, text.encode("utf-8"))


def read_text(path: str) -> str:
    return read_bytes(path).decode("utf-8")
