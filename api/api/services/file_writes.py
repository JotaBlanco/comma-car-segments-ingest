"""Store the bytes of an uploaded result (contract v1.2 — result upload).

`file_bytes.py` reads bytes for the download route. This module writes them for
`POST /results/upload`. The two are siblings on purpose: one store, one
credential path and one error type serve both directions.

Three writers implement the same protocol, and they mirror the three providers
in `file_bytes.py`:

* `BlobFileWrites` writes into SAG blob storage, through the store
  `ingest.store.build_blob_store` builds. The API holds no second blob client.
* `LocalFileWrites` writes into a local directory named by ``TM_LANDING_ZONE``.
* `UnavailableFileWrites` refuses every write. It is the safe default when no
  blob storage is reachable, and the route then answers 503
  `storage_unreachable`.

Every refusal raises :class:`FileBytesUnavailable`, so the upload route answers
the same code the download route answers.

**A writer never buffers the whole file.** ``write`` takes an iterator of byte
chunks and forwards them one at a time.
"""

from __future__ import annotations

import os
import re
import uuid
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Any, Protocol, runtime_checkable

from api.services.file_bytes import FileBytesUnavailable

try:  # The ingestion package is absent from a slim image.
    from ingest.store import WORKSPACE_VARIABLE
except ImportError:
    WORKSPACE_VARIABLE = "Quix__Workspace__Id"

# The folder every uploaded result lands in, under the workspace folder. The
# landing prefix sits beside it (`ingest.store.DEFAULT_PREFIX`).
RESULT_FOLDER = "test-manager/results"

# The folder every uploaded requirements document lands in. It sits beside the
# result folder, so one glance at the bucket separates a person's reference
# document from a processed result.
REQUIREMENTS_FOLDER = "test-manager/requirements"

# The root every artefact of ONE TEST RUN hangs from. MF4 Import reads the same
# variable name and writes each trace under `<root>/<run_id>/`; starting a
# definition run copies that definition's implementation into the same folder,
# so the bytes that were recorded and the bytes that judge them sit side by
# side. The root stays outside `data-lake/`, so the lakehouse catalog never
# scans these objects.
BLOB_ROOT_VARIABLE = "BLOB_ROOT"
DEFAULT_BLOB_ROOT = "jama_ui"

# The run folder an artefact lands in when no run names it: a trace MF4 Import
# could not attribute, and every implementation upload, which is
# definition-scoped. MF4 Import spells it the same way, and the two services
# must keep spelling it the same.
UNASSIGNED_RUN = "unassigned"

# A key segment keeps these characters. Anything else becomes an underscore, so
# a filename can never carry a path, a scheme or a traversal into the key.
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")

# One segment stays short enough for any object store.
_SEGMENT_LIMIT = 120


def _safe_segment(value: str, fallback: str) -> str:
    """Turn one caller string into one safe key segment."""
    cleaned = _UNSAFE.sub("_", (value or "").strip()).lstrip(".")
    return cleaned[:_SEGMENT_LIMIT] or fallback


def blob_root() -> str:
    """The root folder every per-run artefact of this estate hangs from."""
    return os.environ.get(BLOB_ROOT_VARIABLE, "").strip().strip("/") or DEFAULT_BLOB_ROOT


def result_blob_key(run_id: str, filename: str) -> str:
    """Build the key one uploaded result lands on.

    SAG reads the first folder under the bucket as the workspace, and it grants
    a deployment a write under that folder only. So the workspace folder leads
    the key, exactly as it leads the landing prefix
    (`ingest.store.default_blob_prefix`). Outside a deployment the variable is
    unset, and the key then stays bare, which is what a local store wants.

    The uuid keeps two uploads of one filename apart, so an upload never
    overwrites an earlier result blob.
    """
    workspace = os.environ.get(WORKSPACE_VARIABLE, "").strip().strip("/")
    prefix = f"{workspace}/{RESULT_FOLDER}" if workspace else RESULT_FOLDER
    run = _safe_segment(run_id, "unknown-run")
    name = _safe_segment(filename, "result.bin")
    return f"{prefix}/{run}/{uuid.uuid4().hex}-{name}"


# `result_blob_key` writes `<uuid>-<filename>`, and this matches that prefix
# only: 32 lowercase hex characters and one dash. A real filename that begins
# that way is possible and harmless — it loses a prefix nobody typed.
_KEY_UUID_PREFIX = re.compile(r"^[0-9a-f]{32}-")

# `blob://`, `s3://` and any other scheme in front of a stored reference.
_KEY_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")


def result_filename_from_ref(storage_ref: str, fallback: str) -> str:
    """Read the filename back out of a stored result reference.

    **It reverses `result_blob_key`, so it must stay beside it.** The key ends
    in `<uuid>-<filename>`, and that filename is the one the uploader gave, so
    it carries the true extension. The download route serves this name, and a
    person then receives `run_TRNEW.csv` instead of the result's label, which
    names no file type.

    This reads the reference. It never writes one, and it never renames a
    stored object. It also never guesses a type: a result stored with no
    extension is served with none, so a JSON or a plot keeps its own name.

    A reference that names no file segment falls back to `fallback`.
    """
    path = _KEY_SCHEME.sub("", (storage_ref or "").strip().replace("\\", "/"))
    segment = _KEY_UUID_PREFIX.sub("", path.rstrip("/").rsplit("/", 1)[-1])
    return segment or fallback


def requirements_blob_key(td_id: str, filename: str) -> str:
    """Build the key one uploaded requirements document lands on.

    It follows `result_blob_key` exactly: the workspace folder leads the key,
    because SAG grants a deployment a write under that folder only, and a uuid
    keeps two uploads of one filename apart. So a replaced document never
    overwrites the bytes of the document it replaced.
    """
    workspace = os.environ.get(WORKSPACE_VARIABLE, "").strip().strip("/")
    prefix = f"{workspace}/{REQUIREMENTS_FOLDER}" if workspace else REQUIREMENTS_FOLDER
    definition = _safe_segment(td_id, "unknown-definition")
    name = _safe_segment(filename, "requirements.bin")
    return f"{prefix}/{definition}/{uuid.uuid4().hex}-{name}"


def implementation_blob_key(run_id: str | None, filename: str, digest: str) -> str:
    """Build the key one test implementation lands on.

    The workspace folder leads the key, as it does on the two writers above.
    Under it the key is `<blob_root()>/<run_id>/<digest8>-<name>`, the folder MF4
    Import writes the run's trace into, so a reader of one run's folder finds
    the recording and the module that judges it together.

    It has two callers and one convention each. The upload route passes
    ``None`` and the module waits in ``UNASSIGNED_RUN``, because a definition is
    not a run. `definition_runs.place_implementation` passes the run id when
    that definition is run on it, which is the one moment the pair exists. The
    two keys are therefore never equal, and the run copy never reads and writes
    one object.

    The name carries the first 8 hex of the content DIGEST where the two
    writers above carry a uuid: the digest keeps two different uploads apart
    just as well, and it makes the key name the exact bytes — which is the
    point of this artefact, since a verdict cites `sha256:<digest>` as its
    `tool_version`. Re-running a definition whose module did not change
    therefore rewrites one object with itself, and an edited module lands
    beside the bytes the earlier verdict cites instead of over them.
    """
    workspace = os.environ.get(WORKSPACE_VARIABLE, "").strip().strip("/")
    root = blob_root()
    prefix = f"{workspace}/{root}" if workspace else root
    run = _safe_segment(run_id or "", UNASSIGNED_RUN)
    name = _safe_segment(filename, "implementation.py")
    return f"{prefix}/{run}/{digest[:8]}-{name}"


# The folder the per-definition QuixLab notebooks live under, beneath `blob_root()`.
DEFINITIONS_FOLDER = "definitions"
DEFINITION_NOTEBOOK_NAME = "notebook.py"


def definition_notebook_key(td_id: str) -> str:
    """Build the key of the QuixLab notebook a definition run executes.

    The workspace folder leads, as on `implementation_blob_key`. The notebook has a
    folder of its own, because QuixLab makes that folder the run's project root and
    writes its manifest, runs and node records beside the notebook.
    """
    workspace = os.environ.get(WORKSPACE_VARIABLE, "").strip().strip("/")
    root = blob_root()
    prefix = f"{workspace}/{root}" if workspace else root
    definition = _safe_segment(td_id, "unknown-definition")
    return f"{prefix}/{DEFINITIONS_FOLDER}/{definition}/{DEFINITION_NOTEBOOK_NAME}"


@runtime_checkable
class FileBytesWriter(Protocol):
    """Store the bytes of one uploaded file."""

    def check_ready(self) -> None:
        """Raise :class:`FileBytesUnavailable` when the store takes no write.

        The route calls this **before** it writes the audit entry, so an
        unreachable store leaves no trace of bytes that never moved.
        """
        ...

    def write(self, key: str, chunks: Iterable[bytes]) -> int:
        """Write the chunks at the key. Return the number of bytes written.

        The iterator yields byte chunks, so no caller and no writer holds the
        whole file. A refused write raises :class:`FileBytesUnavailable`.
        """
        ...


class UnavailableFileWrites:
    """The default writer. It always refuses.

    An environment that names no source, or that binds no blob storage, gets
    this writer. Storing nothing and answering 201 would be a lie, and a
    fabricated `storage_ref` would point at bytes nobody can read.
    """

    def __init__(self, detail: str) -> None:
        self._detail = detail

    def check_ready(self) -> None:
        raise FileBytesUnavailable(self._detail)

    def write(self, key: str, chunks: Iterable[bytes]) -> int:
        raise FileBytesUnavailable(self._detail)


class LocalFileWrites:
    """Write into a local directory named by ``TM_LANDING_ZONE``.

    It is the write half of :class:`api.services.file_bytes.LocalFileBytes`, and
    a developer with ``TM_INGEST_SOURCE=local`` gets both.
    """

    def __init__(self, root: Path) -> None:
        self._root = Path(root)

    def check_ready(self) -> None:
        if not self._root.is_dir():
            raise FileBytesUnavailable(
                "Storage unreachable — the landing zone directory is not there."
            )

    def write(self, key: str, chunks: Iterable[bytes]) -> int:
        path = self._root / PurePosixPath(key)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            written = 0
            with path.open("wb") as handle:
                for chunk in chunks:
                    handle.write(chunk)
                    written += len(chunk)
        except OSError as error:
            raise FileBytesUnavailable(
                f"the landing zone refused the write: {key}"
            ) from error
        return written


class BlobFileWrites:
    """Write into SAG blob storage, through `ingest.store`.

    The store is `ingest.store.BlobStore`. It states a read interface only, so
    this writer reaches for the fsspec filesystem behind it. The seed byte
    writer does the same (`api/ingest/fixtures.py`, `put_object`), and the two
    stay the only places that know it.
    """

    def __init__(self, store: Any) -> None:
        self._store = store

    def check_ready(self) -> None:
        """Answer nothing. The store exists, so a write may start.

        `build_blob_writer` answers with :class:`UnavailableFileWrites` when the
        credential or the client is missing, so a writer of this class always
        holds a built store. A store that stops answering raises at write time,
        and the route maps that to the same 503.
        """
        return

    def write(self, key: str, chunks: Iterable[bytes]) -> int:
        try:
            written = 0
            with self._store._fs.open(key, "wb") as handle:
                for chunk in chunks:
                    handle.write(chunk)
                    written += len(chunk)
        except Exception as error:  # fsspec raises many types for one fault.
            raise FileBytesUnavailable(f"the store refused the write: {key}") from error
        return written


def build_blob_writer() -> FileBytesWriter:
    """Build :class:`BlobFileWrites` over the blob store, or refuse."""
    try:
        from ingest.store import build_blob_store
    except ImportError:
        return UnavailableFileWrites(
            "Storage unreachable — the blob client is not installed in this image."
        )
    try:
        return BlobFileWrites(build_blob_store())
    except Exception:  # noqa: BLE001 — a bad credential must not stop the API.
        return UnavailableFileWrites(
            "Storage unreachable — no blob storage is bound to this deployment."
        )


def build_default_writer() -> FileBytesWriter:
    """Pick the writer from the environment, the way the reader picks a provider.

    ``TM_INGEST_SOURCE`` carries the same two values here as it carries on the
    download provider: ``blob`` and ``local``. **An unset value reads as
    ``blob``**, as it does on the download provider and in
    `ingest.store.build_store` (21 Aug 2026). Any other value returns
    :class:`UnavailableFileWrites`, and so does a blob branch with no bound
    storage, so this leg still fails closed.
    """
    source = os.environ.get("TM_INGEST_SOURCE", "blob").strip().lower()
    if source == "local":
        root = os.environ.get("TM_LANDING_ZONE", "").strip()
        if root:
            return LocalFileWrites(Path(root))
    elif source == "blob":
        return _cached_blob_writer()
    return UnavailableFileWrites(
        "Storage unreachable — this environment stores no uploaded file."
    )


@lru_cache(maxsize=1)
def _cached_blob_writer() -> FileBytesWriter:
    """Build the blob writer once. The dependency runs on every request."""
    return build_blob_writer()


def get_file_writer() -> FileBytesWriter:
    """FastAPI dependency. A test overrides it via ``app.dependency_overrides``."""
    return build_default_writer()


__all__ = [
    "BLOB_ROOT_VARIABLE",
    "DEFAULT_BLOB_ROOT",
    "DEFINITIONS_FOLDER",
    "DEFINITION_NOTEBOOK_NAME",
    "REQUIREMENTS_FOLDER",
    "RESULT_FOLDER",
    "UNASSIGNED_RUN",
    "BlobFileWrites",
    "FileBytesWriter",
    "LocalFileWrites",
    "UnavailableFileWrites",
    "blob_root",
    "build_blob_writer",
    "build_default_writer",
    "definition_notebook_key",
    "get_file_writer",
    "implementation_blob_key",
    "requirements_blob_key",
    "result_blob_key",
    "result_filename_from_ref",
]
