"""Versioned, write-once artifact storage on blob (spec 3.1, 3.2, D4).

Invariants this module enforces, and nothing else in the system re-implements:

* a version is a **path segment**, so resolving an artifact is a blob read, not
  a query, and a stale cache cannot mix versions;
* a version folder is written **once**: everything is staged under
  ``test-manager/.staging/<uuid>/`` and then copied into place with
  ``manifest.json`` **last** - the manifest's presence is the commit marker, so
  a crash mid-write leaves an invisible folder rather than a half-version;
* the staged copy is **deleted once the manifest is in place**, and only then: a
  successful commit leaves no duplicate bytes behind, and a failed one leaves a
  recoverable staging directory (``_discard_staging``);
* nothing is edited in place and deletion is not exposed.

Every method goes through the blob seam, so the same code runs against the Quix
filesystem and against a local directory.
"""

import logging
import posixpath
import shutil
import uuid
from dataclasses import dataclass

import blob_storage
import canonical
import ids
import paths
import schema_registry
from settings import SET_FOLDERS, SET_ITEM_SCHEMAS

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ArtifactFile:
    """One file inside a version folder, addressed relative to its root."""

    path: str
    data: bytes


class VersionNotFoundError(KeyError):
    """Raised when a pinned artifact-set version has no committed manifest."""


class ItemNotFoundError(KeyError):
    """Raised when an item id is absent from a pinned version."""


def list_versions(set_name: str) -> list[str]:
    """Committed versions of one set, ascending. Uncommitted folders are invisible."""
    backend = blob_storage.require()
    pattern = posixpath.join(paths.set_root(set_name), "v*", "manifest.json")
    versions = []
    for match in backend.glob(pattern):
        version = posixpath.basename(posixpath.dirname(match))
        if ids.VERSION_RE.match(version):
            versions.append(version)
    return sorted(set(versions))


def latest_version(set_name: str) -> str | None:
    versions = list_versions(set_name)
    return versions[-1] if versions else None


def commit_version(set_name: str, files: list[ArtifactFile], manifest_doc: dict) -> str:
    """Stage, copy, then write the manifest last. Returns the minted version."""
    version = manifest_doc["version"]
    token = f"{set_name}-{version}-{uuid.uuid4().hex}"
    backend = blob_storage.require()

    manifest_file = ArtifactFile("manifest.json", canonical.stored_bytes(manifest_doc))
    staged: list[tuple[str, str]] = []

    for artifact in [*files, manifest_file]:
        staged_path = paths.staging_path(token, artifact.path)
        with backend.open(staged_path, "wb") as handle:
            handle.write(artifact.data)
        staged.append((staged_path, posixpath.join(paths.version_root(set_name, version),
                                                   artifact.path)))

    # Copy payload first, manifest last: the commit marker must not appear
    # before the content it describes.
    for staged_path, final_path in staged[:-1]:
        backend.copy(staged_path, final_path)
    backend.copy(staged[-1][0], staged[-1][1])
    logger.info("Committed %s %s (%d files)", set_name, version, len(staged))
    _discard_staging(token)
    return version


def _discard_staging(token: str) -> None:
    """Remove a staged token directory. Only ever called after a successful commit.

    Staging used to be write-only: every upload left a full second copy of every
    file it had just committed under ``test-manager/.staging/<token>/`` with no
    expiry and no reclaim path, so each artifact set permanently cost twice its
    bytes on a store nobody sweeps.

    A *failed* commit deliberately leaves its staging directory in place. The
    staged bytes are then the only complete record of what was being written when
    the copy died, the destination version stays invisible to every reader because
    its ``manifest.json`` never appeared, and a token directory is addressed by a
    uuid, so nothing can collide with it later. Cleaning up on failure as well
    would be tidier and would destroy the evidence; recovery is manual and rare,
    the leak on the success path was neither.

    A cleanup failure is logged, never raised: the version is committed by the time
    this runs, and turning a successful commit into a 500 over a leftover
    directory would be a lie about what happened.
    """
    staging = paths.staging_dir(token)
    try:
        blob_storage.require().rm_tree(staging)
    except Exception as exc:  # noqa: BLE001 - a stale staged copy must not fail a commit
        logger.warning("Committed, but could not remove staging directory %s: %s", staging, exc)


def read_manifest(set_name: str, version: str) -> dict:
    path = paths.manifest(set_name, version)
    if not blob_storage.require().exists(path):
        raise VersionNotFoundError(
            f"{SET_FOLDERS[set_name]}/{version} has no committed manifest at {path}"
        )
    return canonical.loads(blob_storage.read_bytes(path))


def read_items(set_name: str, version: str) -> dict[str, dict]:
    """Items of a committed version, keyed by their human id."""
    manifest = read_manifest(set_name, version)
    _, id_field = _item_schema(set_name)
    items = manifest.get("items")
    if items is None:
        items = [
            canonical.loads(
                blob_storage.read_bytes(paths.canonical_item(set_name, version, item_id))
            )
            for item_id in manifest.get("item_ids", [])
        ]
    return {item[id_field]: item for item in items}


def read_item(set_name: str, version: str, item_id: str) -> dict:
    path = paths.canonical_item(set_name, version, item_id)
    backend = blob_storage.require()
    if backend.exists(path):
        return canonical.loads(blob_storage.read_bytes(path))
    items = read_items(set_name, version)
    if item_id not in items:
        raise ItemNotFoundError(f"{item_id!r} is not in {SET_FOLDERS[set_name]}/{version}")
    return items[item_id]


def _item_schema(set_name: str) -> tuple[str, str]:
    return SET_ITEM_SCHEMAS[set_name]


def read_source_file(set_name: str, version: str, filename: str) -> bytes:
    return blob_storage.read_bytes(paths.source_file(set_name, version, filename))


def list_source_files(set_name: str, version: str) -> list[str]:
    backend = blob_storage.require()
    return [posixpath.basename(entry) for entry in backend.ls(paths.source_dir(set_name, version))]


def list_figures(set_name: str, version: str) -> list[str]:
    """Figure file names of a version, i.e. the ``source/figures/`` entries."""
    backend = blob_storage.require()
    figures_dir = posixpath.join(paths.source_dir(set_name, version), "figures")
    return [posixpath.basename(entry) for entry in backend.ls(figures_dir)]


def read_impl_code(version: str, tc_id: str, relative_path: str) -> bytes:
    return blob_storage.read_bytes(paths.impl_code_file(version, tc_id, relative_path))


def list_impl_code(version: str, tc_id: str) -> list[str]:
    backend = blob_storage.require()
    return [posixpath.basename(entry) for entry in backend.ls(paths.impl_code_dir(version, tc_id))]


def list_baseline_ids() -> list[str]:
    backend = blob_storage.require()
    found = []
    for entry in backend.glob(posixpath.join(paths.baselines_dir(), "BL-*.json")):
        baseline_id = posixpath.basename(entry).removesuffix(".json")
        if ids.BASELINE_ID_RE.match(baseline_id):
            found.append(baseline_id)
    return sorted(found)


def read_baseline(baseline_id: str) -> dict:
    path = paths.baseline(baseline_id)
    if not blob_storage.require().exists(path):
        raise VersionNotFoundError(f"baseline {baseline_id} does not exist at {path}")
    return canonical.loads(blob_storage.read_bytes(path))


def write_baseline(doc: dict) -> str:
    """Baselines are single immutable documents; re-writing one is refused."""
    baseline_id = doc["baseline_id"]
    path = paths.baseline(baseline_id)
    backend = blob_storage.require()
    if backend.exists(path):
        raise FileExistsError(f"baseline {baseline_id} already exists and is immutable")
    blob_storage.write_bytes(path, canonical.stored_bytes(doc))
    return baseline_id


def write_trace_object(device_id: str, trace_key: str, source_path: str) -> str:
    """Stream a locally staged MF4 into blob. Returns the blob path."""
    target = paths.trace_object(device_id, trace_key)
    backend = blob_storage.require()
    with open(source_path, "rb") as source, backend.open(target, "wb") as sink:
        shutil.copyfileobj(source, sink, length=1024 * 1024)
    return target


def write_trace_meta(device_id: str, trace_key: str, meta: dict) -> str:
    target = paths.trace_meta(device_id, trace_key)
    blob_storage.write_bytes(target, canonical.stored_bytes(meta))
    return target


def read_trace_meta(device_id: str, trace_key: str) -> dict:
    return canonical.loads(blob_storage.read_bytes(paths.trace_meta(device_id, trace_key)))


def trace_object_exists(device_id: str, trace_key: str) -> bool:
    return blob_storage.require().exists(paths.trace_object(device_id, trace_key))


def list_report_revisions(test_run_id: str, run_version: int) -> list[str]:
    backend = blob_storage.require()
    pattern = posixpath.join(paths.report_run_dir(test_run_id, run_version), "rev*", "report.json")
    revisions = [posixpath.basename(posixpath.dirname(match)) for match in backend.glob(pattern)]
    return sorted(rev for rev in revisions if ids.REPORT_REVISION_RE.match(rev))


def write_report(test_run_id: str, run_version: int, revision: str,
                 files: list[ArtifactFile]) -> str:
    """Write a report revision, ``report.json`` last as its commit marker."""
    backend = blob_storage.require()
    ordered = [f for f in files if f.path != "report.json"]
    marker = [f for f in files if f.path == "report.json"]
    for artifact in [*ordered, *marker]:
        target = paths.report_file(test_run_id, run_version, revision, artifact.path)
        with backend.open(target, "wb") as handle:
            handle.write(artifact.data)
    return paths.report_dir(test_run_id, run_version, revision)


def read_report_file(test_run_id: str, run_version: int, revision: str, filename: str) -> bytes:
    return blob_storage.read_bytes(
        paths.report_file(test_run_id, run_version, revision, filename)
    )


def write_evaluation_archive(test_run_id: str, run_version: int, results: list[dict]) -> str:
    target = paths.evaluation_archive(test_run_id, run_version)
    blob_storage.write_bytes(
        target,
        canonical.stored_bytes({"test_run_id": test_run_id, "run_version": run_version,
                                "results": results}),
    )
    return target


def publish_schemas() -> list[str]:
    """Copy the published validators to blob (spec 3.1 ``schemas/``).

    Idempotent and content-addressed by name; an existing file is left alone so
    the copy a historic manifest points at can never change under it.
    """
    backend = blob_storage.require()
    written = []
    for name in schema_registry.schema_names():
        target = paths.published_schema(name)
        if backend.exists(target):
            continue
        blob_storage.write_bytes(target, schema_registry.raw_bytes(name))
        written.append(target)
    return written
