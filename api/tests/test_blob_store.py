"""Blob access for the Test Manager (B-13, reworked 2026-08-19).

These tests need no Docker, no Mongo and no cluster. A fake fsspec filesystem
stands in for SAG blob storage.

The Test Manager holds three blob callers, and none of them lists:

* the download leg opens one key and streams it
  (`api/api/services/file_bytes.py`);
* the result upload leg writes one key (`api/api/services/file_writes.py`);
* `api/ingest/blob_seed.py` reads and writes single keys on a developer
  machine, and it calls `build_store()`.

Measurement files live in SAG blob storage, not in a local directory.
`LocalStore` stays for a developer without cluster access.
"""

from __future__ import annotations
import pytest

pytest.importorskip(
    "quixportal",
    reason="the blob store binds through the quixportal wheel, which only the "
    "cloud/CI environment installs; without it every test here dies at setup",
)


import io
from pathlib import Path
from typing import Any

import pytest

from ingest.store import (
    DEFAULT_PREFIX,
    WORKSPACE_VARIABLE,
    BlobStore,
    LocalStore,
    _without_listing_cache,
    build_blob_store,
    build_store,
    default_blob_prefix,
)


class FakeFilesystem:
    """A small stand-in for the fsspec filesystem `quixportal` returns."""

    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects
        self.dircache: dict[str, Any] = {"ws/test-manager": ["stale"]}
        self.use_listings_cache = True

    def open(self, key: str, mode: str = "rb") -> io.BytesIO:
        if key not in self.objects:
            raise FileNotFoundError(key)
        return io.BytesIO(self.objects[key])


# --- the blob store ------------------------------------------------------------------


@pytest.fixture
def objects() -> dict[str, bytes]:
    return {
        "ws/test-manager/landing/rig-04/a.mf4": b"aaaa",
        "ws/test-manager/landing/rig-04/a.mf4.manifest.json": b"{}",
        "ws/test-manager/landing/rig-07/b.csv": b"t\n",
        "ws/other/c.mf4": b"c",
    }


def test_the_blob_store_opens_an_object_as_a_file_object(objects):
    store = BlobStore(FakeFilesystem(objects))

    with store.open("ws/test-manager/landing/rig-04/a.mf4") as handle:
        assert handle.read() == b"aaaa"


def test_the_blob_store_reads_bytes(objects):
    store = BlobStore(FakeFilesystem(objects))

    assert store.read_bytes("ws/test-manager/landing/rig-04/a.mf4.manifest.json") == b"{}"


def test_the_blob_store_reads_none_for_a_missing_key(objects):
    store = BlobStore(FakeFilesystem(objects))

    assert store.read_bytes("ws/test-manager/landing/rig-04/absent.json") is None


# --- the listing cache, which must stay off ------------------------------------------


def test_the_store_turns_the_listing_cache_off(objects):
    """fsspec caches a directory listing. A new blob then never appears.

    The download leg then misses a file the ingestion pipeline just wrote. See
    BE-PLAN section 5.2.
    """
    filesystem = _without_listing_cache(FakeFilesystem(objects))

    filesystem.dircache["ws/test-manager"] = ["stale"]

    assert filesystem.dircache.use_listings_cache is False
    assert "ws/test-manager" not in filesystem.dircache


def test_the_store_turns_the_cache_off_on_the_inner_layer_too(objects):
    """quixportal returns DirFileSystem(inner, bucket). Each layer holds a cache."""
    inner = FakeFilesystem(objects)
    outer = FakeFilesystem(objects)
    outer.fs = inner  # type: ignore[attr-defined]

    _without_listing_cache(outer)

    inner.dircache["x"] = ["stale"]
    assert inner.dircache.use_listings_cache is False
    assert "x" not in inner.dircache


def test_a_real_fsspec_filesystem_keeps_no_listing(tmp_path: Path):
    """The check runs against real fsspec, not against the fake."""
    import fsspec

    (tmp_path / "a.mf4").write_bytes(b"a")
    filesystem = _without_listing_cache(fsspec.filesystem("file"))

    first = filesystem.ls(str(tmp_path), detail=False)
    (tmp_path / "b.mf4").write_bytes(b"b")
    second = filesystem.ls(str(tmp_path), detail=False)

    assert len(first) == 1
    assert len(second) == 2


# --- the local store, for a developer without cluster access -------------------------


def test_the_local_store_opens_and_reads(tmp_path: Path):
    (tmp_path / "a.mf4").write_bytes(b"aaaa")
    store = LocalStore(tmp_path)

    with store.open("a.mf4") as handle:
        assert handle.read() == b"aaaa"
    assert store.read_bytes("a.mf4") == b"aaaa"


def test_the_local_store_reads_none_for_a_missing_key(tmp_path: Path):
    assert LocalStore(tmp_path).read_bytes("absent.json") is None


# --- the store the environment picks -------------------------------------------------


def test_the_environment_picks_the_local_store(monkeypatch, tmp_path: Path):
    """`blob_seed.py` calls `build_store()`, so the local branch must still work."""
    monkeypatch.setenv("TM_INGEST_SOURCE", "local")
    monkeypatch.setenv("TM_LANDING_ZONE", str(tmp_path))

    store, prefix = build_store()

    assert isinstance(store, LocalStore)
    assert store.root == tmp_path
    assert prefix == ""


def test_the_blob_store_is_the_default(monkeypatch):
    """Without the SAG connection the build fails loudly. It never falls back."""
    monkeypatch.delenv("TM_INGEST_SOURCE", raising=False)
    monkeypatch.delenv("Quix__BlobStorage__Connection__Json", raising=False)

    with pytest.raises(Exception, match="Quix__BlobStorage__Connection__Json"):
        build_store()


# --- the prefix SAG will accept -------------------------------------------------------


def test_the_prefix_sits_under_the_workspace_folder(monkeypatch):
    """SAG grants a deployment write only under `/{bucket}/{workspace_id}/`.

    A key that starts with `test-manager/` matches the bucket-root Read grant
    alone, so the `PUT` fails. The seed writer would then write nothing and no
    error would name the cause. See `plans/reference/LAKE-STORES.md` section
    9.9.
    """
    monkeypatch.setenv(WORKSPACE_VARIABLE, "myorg-myproject-main")

    assert default_blob_prefix() == f"myorg-myproject-main/{DEFAULT_PREFIX}"


def test_the_prefix_stays_bare_without_a_workspace(monkeypatch):
    """Outside a deployment the variable is unset, and a test needs no folder."""
    monkeypatch.delenv(WORKSPACE_VARIABLE, raising=False)

    assert default_blob_prefix() == DEFAULT_PREFIX


def test_the_prefix_takes_no_double_slash_from_a_padded_workspace(monkeypatch):
    """A stray slash would build `ws//test-manager`, and SAG collapses it late."""
    monkeypatch.setenv(WORKSPACE_VARIABLE, " /myorg-myproject-main/ ")

    assert default_blob_prefix() == f"myorg-myproject-main/{DEFAULT_PREFIX}"


@pytest.fixture
def fake_quixportal(monkeypatch, objects):
    """Let `build_blob_store()` run for real against a fake filesystem.

    `quixportal` returns `DirFileSystem(inner, path=bucket)`, so the fake holds
    two layers. Each layer owns its own `dircache`. The fixture returns the
    outer layer, and `outer.fs` is the inner layer.
    """
    import quixportal.storage

    inner = FakeFilesystem(objects)
    outer = FakeFilesystem(objects)
    outer.fs = inner  # type: ignore[attr-defined]
    monkeypatch.setattr(quixportal.storage, "get_filesystem", lambda: outer)
    monkeypatch.delenv("TM_INGEST_SOURCE", raising=False)
    monkeypatch.delenv("TM_BLOB_PREFIX", raising=False)
    monkeypatch.delenv(WORKSPACE_VARIABLE, raising=False)
    return outer


def test_the_blob_branch_builds_a_blob_store_with_the_default_prefix(fake_quixportal):
    """The default branch builds the production store and names the demo prefix."""
    store, prefix = build_store()

    assert isinstance(store, BlobStore)
    assert prefix == "test-manager/landing"


def test_the_built_prefix_carries_the_workspace_folder(monkeypatch, fake_quixportal):
    """The built prefix must name the folder SAG lets the writer write."""
    monkeypatch.setenv(WORKSPACE_VARIABLE, "myorg-myproject-main")

    _, prefix = build_store()

    assert prefix == f"myorg-myproject-main/{DEFAULT_PREFIX}"


def test_the_blob_prefix_variable_overrides_the_default(monkeypatch, fake_quixportal):
    """An operator moves the store to another prefix with one variable."""
    monkeypatch.setenv("TM_BLOB_PREFIX", "test-manager/other")

    _, prefix = build_store()

    assert prefix == "test-manager/other"


def test_the_built_blob_store_holds_no_listing_cache_on_either_layer(fake_quixportal):
    """The build path itself must turn the listing cache off, on both layers.

    fsspec caches a directory listing. A blob that lands after the first
    listing then stays invisible for ever. A `build_blob_store` that forgot the
    helper would make the seed write over a live key, and the download leg
    would miss a fresh file. Every test would still be green.
    """
    outer = fake_quixportal
    inner = outer.fs

    build_blob_store()

    outer.dircache["ws/test-manager"] = ["stale"]
    inner.dircache["ws/test-manager"] = ["stale"]
    assert outer.dircache.use_listings_cache is False
    assert inner.dircache.use_listings_cache is False
    assert "ws/test-manager" not in outer.dircache
    assert "ws/test-manager" not in inner.dircache
