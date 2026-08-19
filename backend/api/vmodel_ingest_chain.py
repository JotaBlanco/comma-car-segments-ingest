"""Ingest for the verification half of the chain: specs, impls, signals, traces, verdicts.

Requirements ingest lives in ``vmodel_ingest.py``; this module handles everything that
verifies a requirement. All of it follows the same two-step shape: write one immutable
``vm_artifact_sets`` document describing the version, then write the queryable projection of
its items into the matching ``vm_*`` collection.

Nothing here evaluates anything. The verdicts are produced offline by acc_project's own CLI
and committed as a fixture (see ``vmodel_fixtures/tools/build_vmodel_fixtures.py``); this
module only maps them onto the run/test-case/trace keys the API exposes.
"""

import logging
from typing import Any

from pymongo.database import Database

from .models_vmodel import ArtifactKind
from .utils import now
from .vmodel_ingest import artifact_set_key, canonical_sha256, replace_items

logger = logging.getLogger(__name__)


def _document_items(payload: Any, expected_set: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Split an artifact-set document into (items, metadata), validating the declared set."""
    if isinstance(payload, list):
        return list(payload), {}
    if not isinstance(payload, dict):
        raise ValueError(f"{expected_set} document must be a JSON object or array")

    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError(f"{expected_set} document has no non-empty 'items' array")

    declared = payload.get("set")
    if declared not in (None, expected_set):
        raise ValueError(f"Document declares set '{declared}', expected '{expected_set}'")

    meta = {
        "declared_canonical_sha256": payload.get("set_canonical_sha256"),
        "source_version": payload.get("version"),
        "created_by": payload.get("created_by"),
    }
    return items, meta


def store_artifact_set(
    mongo: Database[dict[str, Any]],
    kind: ArtifactKind,
    artifact_version: str,
    item_ids: list[str],
    canonical: str,
    meta: dict[str, Any],
    source_label: str,
) -> dict[str, Any]:
    """Write the ``vm_artifact_sets`` document that a version *is*.

    Keyed on ``{kind}:{version}``. Versions are numbered per kind, so all four kinds publish
    a ``v0001``; keying on the bare version made each ingest overwrite the previous kind's
    registry document and left only the last one standing.
    """
    key = artifact_set_key(kind, artifact_version)
    document = {
        "_id": key,
        "artifact_version": artifact_version,
        "kind": kind.value,
        "item_count": len(item_ids),
        "item_ids": sorted(item_ids),
        "canonical_sha256": canonical,
        "declared_canonical_sha256": meta.get("declared_canonical_sha256"),
        "created_utc": now(),
        "created_by": meta.get("created_by") or "vmodel-seed",
        "source_label": source_label,
        "source_version": meta.get("source_version"),
        "document_revision": None,
        "blob_path": None,
    }
    mongo.vm_artifact_sets.replace_one({"_id": key}, document, upsert=True)
    return document


def ingest_test_specs(
    mongo: Database[dict[str, Any]],
    payload: Any,
    artifact_version: str,
    source_label: str,
) -> dict[str, Any]:
    """Ingest the test specification set. Items are stored verbatim plus key/version fields."""
    items, meta = _document_items(payload, "test_specs")
    docs = []
    for item in items:
        tc_id = str(item["tc_id"])
        doc = dict(item)
        doc.pop("tc_id", None)
        doc = {
            "_id": f"{tc_id}@{artifact_version}",
            "tc_id": tc_id,
            "artifact_version": artifact_version,
            "canonical_sha256": canonical_sha256(item),
            **doc,
        }
        docs.append(doc)

    replace_items(mongo.vm_test_specs, docs, {"artifact_version": artifact_version})
    return store_artifact_set(
        mongo,
        ArtifactKind.TEST_SPECS,
        artifact_version,
        [str(doc["tc_id"]) for doc in docs],
        canonical_sha256(items),
        meta,
        source_label,
    )


def ingest_test_impls(
    mongo: Database[dict[str, Any]],
    payload: Any,
    artifact_version: str,
    source_label: str,
    tc_id_by_req: dict[str, str],
) -> dict[str, Any]:
    """Ingest the implementation set, resolving each impl to the test case that covers it.

    acc_project's registry names an implementation ``TC-ACC-SYS-PRF-020`` while the test
    specification for the same requirement is ``ACC-SYS-TC-014``. Both ids are stored: the
    registry id as ``impl_id`` (it is what the verdicts carry) and the specification id as
    ``tc_id`` (it is what traceability walks). Neither is derived from the other by string
    surgery - the link goes through the shared ``requirement_id``.
    """
    items, meta = _document_items(payload, "test_impl")
    docs = []
    for item in items:
        impl_id = str(item["impl_id"])
        requirement_id = item.get("requirement_id")
        doc = dict(item)
        doc.pop("impl_id", None)
        doc = {
            "_id": f"{impl_id}@{artifact_version}",
            "impl_id": impl_id,
            "tc_id": tc_id_by_req.get(str(requirement_id)),
            "artifact_version": artifact_version,
            "uploaded_utc": now(),
            "uploaded_by": "vmodel-seed",
            **doc,
        }
        docs.append(doc)

    replace_items(mongo.vm_test_impls, docs, {"artifact_version": artifact_version})
    return store_artifact_set(
        mongo,
        ArtifactKind.TEST_IMPL,
        artifact_version,
        [str(doc["impl_id"]) for doc in docs],
        canonical_sha256(items),
        meta,
        source_label,
    )


def ingest_signals(
    mongo: Database[dict[str, Any]],
    payload: Any,
    artifact_version: str,
    source_label: str,
) -> dict[str, Any]:
    """Ingest the signal catalogue - the lookup that gives every criterion its unit."""
    items, meta = _document_items(payload, "signal_catalog")
    docs = []
    for item in items:
        signal = str(item["signal"])
        doc = dict(item)
        doc.pop("signal", None)
        doc = {
            "_id": f"{signal}@{artifact_version}",
            "signal": signal,
            "artifact_version": artifact_version,
            **doc,
        }
        docs.append(doc)

    replace_items(mongo.vm_signals, docs, {"artifact_version": artifact_version})
    return store_artifact_set(
        mongo,
        ArtifactKind.SIGNAL_CATALOG,
        artifact_version,
        [str(doc["signal"]) for doc in docs],
        canonical_sha256(items),
        meta,
        source_label,
    )


def ingest_traces(mongo: Database[dict[str, Any]], payload: Any) -> list[dict[str, Any]]:
    """Ingest trace metadata and the run/trace join rows.

    No MF4 is parsed and no blob is written: the digests and sizes come from the catalogue
    files themselves, so ``ingest_status`` is honestly ``stored`` and ``groups``/``signals``
    stay empty rather than being filled with guesses.
    """
    items, _ = _document_items(payload, "traces")
    trace_docs = []
    link_docs = []
    for item in items:
        trace_key = str(item["trace_key"])
        run_id = str(item["run_id"])
        trace_docs.append(
            {
                "_id": trace_key,
                "scenario": item.get("scenario"),
                "source_path": item.get("source_path"),
                "blob_path": None,
                "content_sha256": item["content_sha256"],
                "size_bytes": int(item["size_bytes"]),
                "uploaded_utc": now(),
                "uploaded_by": "vmodel-seed",
                "ingest_status": "stored",
                "mf4": {},
                "groups": [],
                "signals": [],
            }
        )
        link_docs.append(
            {
                "_id": f"{run_id}::{trace_key}",
                "run_id": run_id,
                "trace_key": trace_key,
                "attached_utc": now(),
                "attached_by": "vmodel-seed",
            }
        )

    if trace_docs:
        replace_items(mongo.vm_traces, trace_docs, {})
        replace_items(mongo.vm_run_traces, link_docs, {})
    return items


def ingest_results(
    mongo: Database[dict[str, Any]],
    verdicts: list[dict[str, Any]],
    trace_index: dict[str, dict[str, Any]],
    tc_id_by_req: dict[str, str],
    baseline_id: str,
) -> int:
    """Map acc_project verdicts onto (run, test case, trace) keys and store them.

    A verdict names its trace by catalogue path; the trace fixture is what turns that path
    into a ``trace_key`` and a ``run_id``. A verdict whose trace is not in the catalogue is
    skipped and logged rather than being attached to a made-up run.
    """
    docs = []
    skipped = 0
    for verdict in verdicts:
        source_path = str(verdict.get("trace", "")).replace("\\", "/")
        trace = trace_index.get(source_path)
        if trace is None:
            skipped += 1
            continue

        requirement_id = str(verdict["requirement_id"])
        tc_id = tc_id_by_req.get(requirement_id, str(verdict["test_case_id"]))
        run_id = str(trace["run_id"])
        trace_key = str(trace["trace_key"])
        docs.append(
            {
                "_id": f"{run_id}::{tc_id}::{trace_key}",
                "run_id": run_id,
                "run_version": 1,
                "tc_id": tc_id,
                "impl_id": verdict["test_case_id"],
                "trace_key": trace_key,
                "req_ids": [requirement_id],
                "verification_tag": verdict["verification_tag"],
                "title": verdict["title"],
                "status": verdict["status"],
                "measured": verdict.get("measured"),
                "bound": verdict.get("bound"),
                "comparison": verdict.get("comparison"),
                "margin": verdict.get("margin"),
                "tolerance": verdict.get("tolerance", 0.0),
                "unit": verdict.get("unit", ""),
                "window": verdict.get("window", ""),
                "scope": verdict.get("scope", ""),
                "samples_in_scope": verdict.get("samples_in_scope", 0),
                "signals": list(verdict.get("signals") or []),
                "reason": verdict.get("reason", ""),
                "notes": list(verdict.get("notes") or []),
                "criteria": [],
                "baseline_id": baseline_id,
                "evaluated_utc": None,
                "result_sha256": canonical_sha256(verdict),
            }
        )

    if skipped:
        logger.warning("Skipped %d verdicts whose trace is not in the trace catalogue", skipped)
    if docs:
        replace_items(mongo.vm_results, docs, {})
    return len(docs)


def compute_req_links(test_specs: list[dict[str, Any]]) -> dict[str, list[str]]:
    """Build the reverse traceability index: requirement id -> covering test case ids.

    Computed once, at baseline creation, and frozen with the baseline. Nothing recomputes it
    at request time - that is what makes a report reproducible from its baseline alone.
    Mongo keys cannot contain a dot; requirement ids never do.
    """
    links: dict[str, list[str]] = {}
    for spec in test_specs:
        tc_id = str(spec["tc_id"])
        for req_id in spec.get("covers_req_ids") or []:
            links.setdefault(str(req_id), []).append(tc_id)
    return {req_id: sorted(set(tc_ids)) for req_id, tc_ids in sorted(links.items())}


def tc_id_index(test_specs: list[dict[str, Any]]) -> dict[str, str]:
    """requirement id -> the single test case that covers it, for impl and verdict mapping."""
    index: dict[str, str] = {}
    for spec in test_specs:
        for req_id in spec.get("covers_req_ids") or []:
            index.setdefault(str(req_id), str(spec["tc_id"]))
    return index
