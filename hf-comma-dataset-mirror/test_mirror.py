import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.dirname(__file__))

import main  # noqa: E402


class FakeFS:
    """Mock fsspec-like filesystem for blob storage."""

    def __init__(self, existing_keys=None):
        self.existing_keys = set(existing_keys or [])
        self.put_calls = []

    def exists(self, key):
        return key in self.existing_keys

    def put(self, local_path, dest_key):
        self.put_calls.append((local_path, dest_key))


def test_build_dest_key_mirrors_relative_path_verbatim():
    assert (
        main.build_dest_key("commacarsegments/", "segments/dev123/route1/0/qlog.bz2")
        == "commacarsegments/segments/dev123/route1/0/qlog.bz2"
    )
    # Works even without trailing slash on the prefix
    assert (
        main.build_dest_key("commacarsegments", "segments/dev123/route1/0/qlog.bz2")
        == "commacarsegments/segments/dev123/route1/0/qlog.bz2"
    )
    # Nested directory structure is preserved verbatim, no renaming/reformatting
    nested_path = "segments/deviceA/routeB/3/global_pose/frame_positions.npy"
    assert (
        main.build_dest_key("prefix/", nested_path) == "prefix/" + nested_path
    )


@patch("main.download_file_with_retry")
def test_skip_existing_true_skips_present_files(mock_download):
    fs = FakeFS(existing_keys={"prefix/segments/a/1/qlog.bz2"})

    status, dest_key, size = main.mirror_file(
        fs,
        repo_id="commaai/commaCarSegments",
        repo_type="dataset",
        relative_path="segments/a/1/qlog.bz2",
        dest_prefix="prefix/",
        skip_existing=True,
        token=None,
    )

    assert status == "skipped"
    assert dest_key == "prefix/segments/a/1/qlog.bz2"
    mock_download.assert_not_called()
    assert fs.put_calls == []


@patch("main.upload_file_with_retry")
@patch("main.download_file_with_retry")
def test_skip_existing_false_does_not_skip_present_files(mock_download, mock_upload, tmp_path):
    local_file = tmp_path / "qlog.bz2"
    local_file.write_bytes(b"hello world")
    mock_download.return_value = str(local_file)

    fs = FakeFS(existing_keys={"prefix/segments/a/1/qlog.bz2"})

    status, dest_key, size = main.mirror_file(
        fs,
        repo_id="commaai/commaCarSegments",
        repo_type="dataset",
        relative_path="segments/a/1/qlog.bz2",
        dest_prefix="prefix/",
        skip_existing=False,
        token=None,
    )

    assert status == "uploaded"
    assert dest_key == "prefix/segments/a/1/qlog.bz2"
    mock_download.assert_called_once()
    mock_upload.assert_called_once_with(fs, str(local_file), dest_key)


@patch("main.get_filesystem")
@patch("main.list_repo_files")
@patch("main.upload_file_with_retry")
@patch("main.download_file_with_retry")
def test_failure_on_one_file_does_not_abort_and_is_reported(
    mock_download, mock_upload, mock_list_repo_files, mock_get_filesystem, tmp_path
):
    counter = {"n": 0}

    def download_side_effect(repo_id, repo_type, relative_path, token, attempts=main.MAX_ATTEMPTS):
        if relative_path == "segments/bad/1/qlog.bz2":
            raise RuntimeError("simulated persistent network failure")
        counter["n"] += 1
        local_file = tmp_path / f"good-{counter['n']}.bz2"
        local_file.write_bytes(b"data")
        return str(local_file)

    mock_download.side_effect = download_side_effect

    fs = FakeFS()
    mock_get_filesystem.return_value = fs
    mock_list_repo_files.return_value = [
        "segments/good/1/qlog.bz2",
        "segments/bad/1/qlog.bz2",
        "segments/good/2/qlog.bz2",
    ]

    with patch.dict(
        os.environ,
        {
            "HF_DATASET_REPO_ID": "commaai/commaCarSegments",
            "HF_REPO_TYPE": "dataset",
            "BLOB_DEST_PREFIX": "prefix/",
            "SKIP_EXISTING": "true",
        },
        clear=False,
    ):
        summary = main.run()

    assert summary["total"] == 3
    assert summary["uploaded"] == ["segments/good/1/qlog.bz2", "segments/good/2/qlog.bz2"]
    assert summary["failed"] == ["segments/bad/1/qlog.bz2"]
    assert summary["skipped"] == []


def test_str_to_bool():
    assert main.str_to_bool("true") is True
    assert main.str_to_bool("True") is True
    assert main.str_to_bool("1") is True
    assert main.str_to_bool("false") is False
    assert main.str_to_bool("0") is False
    assert main.str_to_bool("") is False


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
