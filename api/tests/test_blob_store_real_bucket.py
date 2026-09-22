"""Blob access against a real bucket (B-13, B-15, B-19).

Every other store test in `test_blob_store.py` uses a fake filesystem, so no
byte ever left the process. This file closes that gap. It runs the real
`build_blob_store()` path, the real `quixportal` provider, real `s3fs`, real
HTTP and a real bucket.

**The test holds no credential.** It reads
`Quix__BlobStorage__Connection__Json` from the environment, and it skips when
that variable is absent. `plans/reference/LAKE-STORES.md` section 9 gives the
two recipes: a local MinIO bucket, and a real SAG bucket.

Run it against the local MinIO the QuixLake compose stack already starts:

    $env:Quix__BlobStorage__Connection__Json = '{"provider": "Minio", "S3Compatible": {"BucketName": "test-bucket", "AccessKeyId": "minioadmin", "SecretAccessKey": "minioadmin", "ServiceUrl": "http://localhost:9000"}}'
    uv run pytest tests/test_blob_store_real_bucket.py

Point the same variable at SAG and the same tests run against SAG. Nothing in
this file knows which backend answers.
"""

from __future__ import annotations

import hashlib
import json
import os
import uuid
from collections.abc import Iterator
from typing import Any

import pytest

from ingest.fixtures import FIXTURES, mf4_bytes, put_object
from ingest.store import DEFAULT_PREFIX, BlobStore, build_blob_store, default_blob_prefix

CONNECTION = "Quix__BlobStorage__Connection__Json"

pytestmark = pytest.mark.skipif(
    not os.environ.get(CONNECTION),
    reason=f"{CONNECTION} is not set. See plans/reference/LAKE-STORES.md section 9.",
)


def _connection() -> dict[str, Any]:
    """Read the S3 block of the connection JSON.

    `quixportal` names the keys in PascalCase, because its models generate the
    alias with `to_pascal`. See `quixportal/storage/config.py:83`.
    """
    config = json.loads(os.environ[CONNECTION])
    return config.get("S3Compatible") or config.get("s3Compatible") or {}


@pytest.fixture(scope="module")
def store() -> BlobStore:
    """The production store, built the way the Test Manager builds it."""
    return build_blob_store()


@pytest.fixture
def prefix(store: BlobStore) -> Iterator[str]:
    """A prefix nobody else uses, removed after the test.

    Two runs must not read each other's objects, and the bucket must not grow
    a new folder on every run.

    The prefix sits under the workspace folder, because SAG grants write there
    only. It reads the first folder under the bucket as the workspace, and it
    denies a write anywhere else. See `plans/reference/LAKE-STORES.md` section
    9.9. `default_blob_prefix` reads `Quix__Workspace__Id` and returns a bare
    prefix when that variable is absent, so MinIO is unaffected.
    """
    workspace = default_blob_prefix().rsplit(DEFAULT_PREFIX, 1)[0]
    path = f"{workspace}test-manager/pytest/{uuid.uuid4().hex[:12]}"
    yield path
    try:
        store._fs.rm(path, recursive=True)
    except (FileNotFoundError, OSError):  # the test wrote nothing, or the bucket refused
        pass


# --- the wire ------------------------------------------------------------------------


def test_the_store_wraps_the_bucket_and_uses_path_style_addressing(store: BlobStore):
    """A key is a path inside the bucket, and the request carries the bucket in the path.

    `quixportal` returns `fsspec.filesystem("dir", fs=s3, path=bucket)`
    (`quixportal/storage/providers/s3_provider.py:171`), so the Test Manager
    never writes the bucket name into a key. The same provider forces
    path-style addressing for any custom endpoint (`s3_provider.py:149-153`),
    because SAG and MinIO both parse the bucket out of the URL path.
    """
    from fsspec.implementations.dirfs import DirFileSystem

    assert isinstance(store._fs, DirFileSystem)
    assert store._fs.path == _connection()["BucketName"]
    if _connection().get("ServiceUrl"):
        assert store._fs.fs.s3.meta.config.s3 == {"addressing_style": "path"}


def test_the_built_store_holds_no_listing_cache_on_either_layer(store: BlobStore):
    """Both layers keep their own cache, and both must stay off.

    A cached answer hides a blob that landed after the first question. The
    download leg would then miss a file the ingestion pipeline just wrote.
    """
    assert store._fs.dircache.use_listings_cache is False
    assert store._fs.fs.dircache.use_listings_cache is False


# --- one real MF4, written and read back ---------------------------------------------


def test_a_real_mf4_round_trips_through_a_real_bucket(store: BlobStore, prefix: str):
    """Write one real MF4, read it back, and compare the bytes.

    This proves the whole leg at once: `put_object` reaches a real bucket, and
    `read_bytes` returns the same bytes. A refused write or a wrong prefix
    raises here instead of surfacing later at download time.

    The test writes no manifest sidecar. The ingestion pipeline owns the
    sidecar now.
    """
    data = mf4_bytes(FIXTURES[0])
    key = f"{prefix}/{FIXTURES[0].key}"

    put_object(store, key, data)

    written = store.read_bytes(key)
    assert written is not None
    assert written == data
    assert hashlib.sha256(written).hexdigest() == hashlib.sha256(data).hexdigest()


def test_the_store_reads_none_for_a_missing_key(store: BlobStore, prefix: str):
    """A missing object reads as None, not as an exception the caller must catch."""
    assert store.read_bytes(f"{prefix}/absent.mf4") is None
