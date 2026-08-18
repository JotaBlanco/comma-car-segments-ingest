"""Round-2 regression: a committed version must not leave its staged copy behind.

``commit_version`` stages every file under ``test-manager/.staging/<token>/`` and
then copies it into the version folder, manifest last. Round 2 found that the
staged copy was never removed, so every artifact upload permanently cost twice its
bytes on a store with no sweeper and no TTL.

The commit protocol itself is verified working and must stay that way, so these
tests pin the cleanup *and* the manifest-last marker together: payload first,
manifest last, staging gone, version visible.
"""

import posixpath

import pytest

import artifact_store
import blob_storage
import paths
import settings
from artifact_store import ArtifactFile

SET_NAME = settings.SET_REQUIREMENTS


@pytest.fixture
def local_blob(tmp_path, monkeypatch):
    """The local backend, rooted in a tmp dir. A first-class backend, not a stub."""
    monkeypatch.setenv("TM_BLOB_BACKEND", "local")
    monkeypatch.setenv("TM_BLOB_LOCAL_ROOT", str(tmp_path))
    blob_storage.reset_backend()
    yield tmp_path
    blob_storage.reset_backend()


def _commit(version="v0001"):
    files = [
        ArtifactFile("canonical/requirements.json", b"[]"),
        ArtifactFile("source/acc.reqif", b"<REQ-IF/>"),
    ]
    manifest = {"version": version, "set": "requirements", "item_ids": []}
    return artifact_store.commit_version(SET_NAME, files, manifest)


def _staging_root(root):
    """``<root>/test-manager/.staging`` - where token directories used to pile up."""
    return root / posixpath.dirname(paths.staging_dir("token"))


def test_a_successful_commit_leaves_no_staged_copy(local_blob):
    version = _commit()

    version_dir = local_blob / paths.version_root(SET_NAME, version)
    assert (version_dir / "manifest.json").exists()
    assert (version_dir / "canonical" / "requirements.json").read_bytes() == b"[]"

    staging_root = _staging_root(local_blob)
    leftovers = []
    if staging_root.exists():
        leftovers = sorted(entry.name for entry in staging_root.iterdir())
    assert leftovers == [], f"staged token directories were left behind: {leftovers}"


def test_the_commit_marker_still_works_after_cleanup(local_blob):
    """Cleanup must not touch the thing that makes a version visible."""
    _commit("v0001")
    _commit("v0002")

    assert artifact_store.list_versions(SET_NAME) == ["v0001", "v0002"]
    assert artifact_store.latest_version(SET_NAME) == "v0002"
    assert artifact_store.read_manifest(SET_NAME, "v0002")["version"] == "v0002"


def test_a_failed_commit_leaves_a_recoverable_staging_directory(local_blob):
    """The chosen failure behaviour, pinned: staged bytes survive, the version does not.

    Cleanup happens only after the manifest copy succeeds. A commit that dies
    part-way therefore leaves the complete staged set on disk - the only record of
    what was being written - while the destination stays invisible to every reader
    because its ``manifest.json`` never appeared.
    """
    backend = blob_storage.require()
    real_copy = backend.copy

    def copy_but_never_the_manifest(src, dst):
        if dst.endswith("manifest.json"):
            raise OSError("blob store went away mid-commit")
        real_copy(src, dst)

    backend.copy = copy_but_never_the_manifest
    try:
        with pytest.raises(OSError):
            _commit("v0007")
    finally:
        backend.copy = real_copy

    staging_root = _staging_root(local_blob)
    tokens = sorted(entry.name for entry in staging_root.iterdir())
    assert len(tokens) == 1, "the staged copy of a failed commit must survive"
    staged = staging_root / tokens[0]
    assert (staged / "manifest.json").exists()
    assert (staged / "canonical" / "requirements.json").read_bytes() == b"[]"

    assert artifact_store.list_versions(SET_NAME) == []
    with pytest.raises(artifact_store.VersionNotFoundError):
        artifact_store.read_manifest(SET_NAME, "v0007")
