"""Blob access for the Test Manager (BE-PLAN §5.2, reworked 2026-08-17).

Measurement files live in SAG blob storage, not in a local directory. The
Test Manager reaches them through an fsspec filesystem that `quixportal` builds.

**The scope, since 19 Aug 2026.** The file watcher owned this module and it
polled the landing prefix. The watcher moved to the ingestion pipeline
(`plans/design/INGEST-SPLIT.md`), and the listing machinery left with it. The
Test Manager keeps four blob legs:

* `GET /files/{id}/download` opens one key and streams it
  (`api/api/services/file_bytes.py`).
* `POST /results/upload` writes one key (`api/api/services/file_writes.py`).
* The ingestion sweep lists one prefix and reads each new key
  (`api/api/ingest_sweep.py`, FR-DM-003). It watches its own prefix and it
  writes nothing, so the watcher stays where the boss put it.
* `DELETE /test-runs/{id}` removes one key per file the run registered
  (`api/api/services/run_deletion.py`). It is the ONLY leg that deletes a
  byte: a file delete is a soft delete, and the retention purge drops the
  record and leaves the object to the storage layer.

`ingest.blob_seed` also reads and writes single keys on a developer machine.

Two stores implement the same small interface.

* `BlobStore` wraps an fsspec filesystem. It is the production store.
* `LocalStore` reaches a local directory, for a developer without cluster
  access.

The interface is deliberately small: open, read, and — for the run delete
alone — remove. Nothing in the Test Manager needs more, and a test replaces the
whole store with a fake.
"""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Protocol, runtime_checkable

# The blob prefix the rigs write to, under the workspace root.
# The previous Test Manager backend used `{workspace_id}/test-manager/...`.
DEFAULT_PREFIX = "test-manager/landing"

# The platform names the workspace on every deployment. SAG reads the first
# folder under the bucket as the workspace, and it grants a deployment write
# only under that folder. See `plans/reference/LAKE-STORES.md` section 9.9.
WORKSPACE_VARIABLE = "Quix__Workspace__Id"


@runtime_checkable
class FileSource(Protocol):
    """What the Test Manager needs from a blob store."""

    def open(self, key: str) -> BinaryIO:
        """Open the object for reading bytes."""
        ...

    def read_bytes(self, key: str) -> bytes | None:
        """Read the whole object. Return None when the key does not exist.

        A store that refuses the read raises. None means "the key is not
        there" and nothing else, so a caller may act on it.
        """
        ...

    def remove(self, key: str) -> None:
        """Delete the object. A key that is already gone is not a failure.

        Deleting a run deletes the bytes of every file it registered
        (`api/api/services/run_deletion.py`). Nothing else in the Test Manager
        removes a byte: `DELETE /files/{id}` is a soft delete and the retention
        purge drops the record only.
        """
        ...


# --- the production source ----------------------------------------------------------


class BlobStore:
    """Read objects from SAG blob storage through an fsspec filesystem.

    `quixportal.storage.get_filesystem()` returns a filesystem already scoped
    to the workspace bucket, so a key here is a path inside that bucket.
    """

    def __init__(self, filesystem: Any) -> None:
        self._fs = filesystem

    def open(self, key: str) -> BinaryIO:
        return self._fs.open(key, "rb")

    def list_keys(self, prefix: str) -> list[str]:
        """List every object key under one prefix, deepest folders included.

        An absent prefix answers an empty list. A prefix nobody wrote to yet is
        the normal state of a watch folder, so it must not raise.
        """
        try:
            found = self._fs.find(prefix)
        except FileNotFoundError:
            return []
        return sorted(str(key).lstrip("/") for key in found)

    def read_bytes(self, key: str) -> bytes | None:
        """Read the whole object. Return None when the key does not exist.

        **A refused read raises** (21 Aug 2026). It answered None as well, and
        `ingest.blob_seed` reads None as "the bucket holds nothing here", so a
        403 made the byte seed overwrite a real captured file with a fixture.
        s3fs raises `PermissionError` on a 403, and `PermissionError` is an
        `OSError`, so the wide catch swallowed the difference. Only "the key is
        not there" answers None now, and every other fault reaches the caller.
        """
        try:
            with self._fs.open(key, "rb") as handle:
                return handle.read()
        except FileNotFoundError:
            return None

    def remove(self, key: str) -> None:
        """Delete the object. A key that is already gone stays a success.

        An object the bucket does not hold is the state the caller asked for,
        and a delete that repeats after a half-finished run delete must not
        fail on the keys the first pass took. Every other fault — a refused
        delete above all — reaches the caller, which records it and says so.
        """
        try:
            self._fs.rm_file(key)
        except FileNotFoundError:
            return


def build_blob_store() -> BlobStore:
    """Build the production store from `quixportal`.

    `quixportal` reads `Quix__BlobStorage__Connection__Json` from the
    environment. The import stays inside the function, so a developer without
    the library still imports this module.

    fsspec caches directory listings, so `_without_listing_cache` turns that
    cache off.
    """
    from quixportal.storage import get_filesystem  # type: ignore[import-not-found]

    return BlobStore(_without_listing_cache(get_filesystem()))


def _without_listing_cache(filesystem: Any) -> Any:
    """Turn the fsspec directory listing cache off, on every layer.

    fsspec caches a directory listing and answers a later question from that
    cache. A blob that lands after the first listing then stays invisible for
    ever. `blob_seed` would then overwrite a key the bucket already holds, and
    the download route would miss a file the pipeline just wrote.

    `quixportal` returns `DirFileSystem(inner, path=bucket)`. Each layer holds
    its own cache, so both need the change. QuixLab does the same in
    `quixlab/sources/storage.py`.
    """
    from fsspec.dircache import DirCache

    filesystem.dircache = DirCache(use_listings_cache=False)
    inner = getattr(filesystem, "fs", None)
    if inner is not None and inner is not filesystem:
        inner.dircache = DirCache(use_listings_cache=False)
    return filesystem


# --- the local source ---------------------------------------------------------------


class LocalStore:
    """Read objects from a local directory.

    A key is a POSIX path relative to the root. The caller therefore does not
    know which store it holds.
    """

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        return self.root / PurePosixPath(key)

    def open(self, key: str) -> BinaryIO:
        return self._path(key).open("rb")

    def list_keys(self, prefix: str) -> list[str]:
        """List every file under one prefix, as POSIX keys under the root."""
        start = self._path(prefix) if prefix else self.root
        if not start.is_dir():
            return []
        return sorted(
            path.relative_to(self.root).as_posix()
            for path in start.rglob("*")
            if path.is_file()
        )

    def read_bytes(self, key: str) -> bytes | None:
        """Read the whole object. Return None when the key does not exist.

        A refused read raises, as :class:`BlobStore` raises. "Absent" and
        "refused" are two answers, and a caller that writes on "absent" must
        never write on "refused".
        """
        try:
            return self._path(key).read_bytes()
        except FileNotFoundError:
            return None

    def remove(self, key: str) -> None:
        """Delete the file. An absent file stays a success, as in :class:`BlobStore`."""
        self._path(key).unlink(missing_ok=True)


def default_blob_prefix() -> str:
    """Build the landing prefix, under the workspace folder.

    **SAG denies a write outside the workspace folder.** It reads the first
    folder under the bucket as the workspace
    (`DataPlaneAccessDecision.cs:344-361`), and the Portal grants a deployment
    `/{bucket}/{workspace_id}/` ReadWrite plus `/` **Read only**
    (`DeploymentService.cs:2443-2446`). So a key that starts with
    `test-manager/` matches the read grant alone, and the `PUT` fails.

    `Quix__Workspace__Id` carries the same value the grant carries
    (`DeploymentService.cs:2170,2444`). Outside a deployment it is unset, and
    the prefix then stays bare, which is what a local store and a test want.

    The ingestion pipeline writes this prefix now. The Test Manager reads the
    keys the pipeline registered, and the demo seed writes its cast under the
    same prefix (`api/seed/fixtures_inventory.py`).
    """
    workspace = os.environ.get(WORKSPACE_VARIABLE, "").strip().strip("/")
    return f"{workspace}/{DEFAULT_PREFIX}" if workspace else DEFAULT_PREFIX


def stamp_workspace(storage_ref: str) -> str:
    """Put the workspace folder in front of a seeded landing reference.

    The demo seed states where a measurement file lies, and `ingest.blob_seed`
    writes the bytes at exactly that key. The ingestion pipeline writes under
    `default_blob_prefix()`, so a seeded reference must carry the same
    workspace folder. A reference that misses it names a key SAG would never
    let a deployment write, and the download route would then have to guess.
    The download route never guesses: it opens the reference it holds.

    A reference that names another prefix survives untouched. Outside a
    deployment the variable is unset and the reference stays bare.
    """
    head = f"blob://{DEFAULT_PREFIX}/"
    if not storage_ref.startswith(head):
        return storage_ref
    return f"blob://{default_blob_prefix()}/{storage_ref[len(head):]}"


def build_store() -> tuple[FileSource, str]:
    """Build the store the environment asks for, and the landing prefix.

    `TM_INGEST_SOURCE` picks the store. `blob` is the default and reads SAG.
    `local` reads `TM_LANDING_ZONE`, for a developer without cluster access.
    The API reads the same variable (`api/api/services/file_bytes.py`), so one
    name moves the whole stack. `ingest.blob_seed` is the caller today.
    """
    source = os.environ.get("TM_INGEST_SOURCE", "blob").strip().lower()
    if source == "local":
        root = Path(os.environ.get("TM_LANDING_ZONE", "landing_zone"))
        return LocalStore(root), ""
    return build_blob_store(), os.environ.get("TM_BLOB_PREFIX", default_blob_prefix())


__all__ = [
    "DEFAULT_PREFIX",
    "WORKSPACE_VARIABLE",
    "BlobStore",
    "FileSource",
    "LocalStore",
    "build_blob_store",
    "build_store",
    "default_blob_prefix",
    "stamp_workspace",
]
