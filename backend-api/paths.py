"""Blob path layout (spec 3.1). Pure functions, no I/O.

Every path returned here is bucket-relative and begins with the ``test-manager``
prefix, which is disjoint from the lakehouse sink's
``{workspaceId}/data-lake/time-series/`` prefix so that catalog discovery never
scans a raw object (decision D7).
"""

import posixpath

from settings import SET_FOLDERS, TM_PREFIX


def _join(*parts: str) -> str:
    return posixpath.join(TM_PREFIX, *parts)


def set_root(set_name: str) -> str:
    return _join(SET_FOLDERS[set_name])


def version_root(set_name: str, version: str) -> str:
    return posixpath.join(set_root(set_name), version)


def manifest(set_name: str, version: str) -> str:
    return posixpath.join(version_root(set_name, version), "manifest.json")


def canonical_set_file(set_name: str, version: str) -> str:
    """The whole-set canonical document. One file name per set."""
    names = {
        "requirements": "requirements.json",
        "test_specs": "test-cases.json",
        "test_impl": "test-impl.json",
        "signal_catalog": "signal-catalog.json",
    }
    return posixpath.join(version_root(set_name, version), "canonical", names[set_name])


def canonical_item(set_name: str, version: str, item_id: str) -> str:
    return posixpath.join(version_root(set_name, version), "canonical", "items", f"{item_id}.json")


def canonical_items_dir(set_name: str, version: str) -> str:
    return posixpath.join(version_root(set_name, version), "canonical", "items")


def source_file(set_name: str, version: str, filename: str) -> str:
    return posixpath.join(version_root(set_name, version), "source", filename)


def source_dir(set_name: str, version: str) -> str:
    return posixpath.join(version_root(set_name, version), "source")


def figure(set_name: str, version: str, filename: str) -> str:
    return posixpath.join(version_root(set_name, version), "source", "figures", filename)


def upload_receipt(set_name: str, version: str) -> str:
    return posixpath.join(version_root(set_name, version), "source", "upload-receipt.json")


def impl_code_dir(version: str, tc_id: str) -> str:
    return posixpath.join(version_root("test_impl", version), "code", tc_id)


def impl_code_file(version: str, tc_id: str, relative_path: str) -> str:
    return posixpath.join(impl_code_dir(version, tc_id), relative_path)


def baselines_dir() -> str:
    return _join("baselines")


def baseline(baseline_id: str) -> str:
    return posixpath.join(baselines_dir(), f"{baseline_id}.json")


def traces_dir(device_id: str) -> str:
    return _join("traces", device_id)


def trace_dir(device_id: str, trace_key: str) -> str:
    return posixpath.join(traces_dir(device_id), trace_key)


def trace_object(device_id: str, trace_key: str) -> str:
    return posixpath.join(trace_dir(device_id, trace_key), "trace.mf4")


def trace_meta(device_id: str, trace_key: str) -> str:
    return posixpath.join(trace_dir(device_id, trace_key), "trace.meta.json")


def report_dir(test_run_id: str, run_version: int, revision: str) -> str:
    return _join("reports", test_run_id, f"v{run_version}", revision)


def report_run_dir(test_run_id: str, run_version: int) -> str:
    return _join("reports", test_run_id, f"v{run_version}")


def report_file(test_run_id: str, run_version: int, revision: str, filename: str) -> str:
    return posixpath.join(report_dir(test_run_id, run_version, revision), filename)


def evaluation_archive(test_run_id: str, run_version: int) -> str:
    return _join("evaluations", test_run_id, f"v{run_version}", "results.json")


def published_schema(name: str) -> str:
    return _join("schemas", f"{name}.schema.json")


def staging_dir(token: str) -> str:
    return _join(".staging", token)


def staging_path(token: str, relative: str) -> str:
    return posixpath.join(staging_dir(token), relative)
