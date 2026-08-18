"""Composite reads for pages 1-3: requirements, test cases, implementations.

The backend exposes pre-resolved neighbourhoods so the frontend performs one call
per view and never joins entities client-side (spec 2.6). Every read requires a
baseline (or resolves it from a run) and refuses to serve a mixed pair: asking for
a ``tc_id`` that does not exist in that baseline is a 404, never a silent fallback
to another version.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

import artifact_store
import baseline_service
import deps
import impl_service
import mongo_schema
import paths

router = APIRouter(tags=["catalog"])


def _resolve_baseline(db, baseline: str | None, test_run_id: str | None) -> tuple[str, int | None]:
    """A view is defined by a baseline; a run implies exactly one (spec 5.2)."""
    if test_run_id:
        run = db[mongo_schema.TEST_RUNS].find_one({"test_run_id": test_run_id})
        if run is None:
            raise HTTPException(status_code=404, detail=f"test run {test_run_id} does not exist")
        if baseline and baseline != run["baseline_id"]:
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "version_mix_rejected",
                    "message": (
                        f"run {test_run_id} is pinned to {run['baseline_id']}, "
                        f"not {baseline}; a run's baseline is immutable"
                    ),
                },
            )
        return run["baseline_id"], int(run["latest_run_version"])
    if baseline:
        return baseline, None
    ids_available = artifact_store.list_baseline_ids()
    if not ids_available:
        raise HTTPException(
            status_code=404,
            detail="no baseline exists yet; create one before reading artifacts",
        )
    return ids_available[-1], None


def _verdict_index(db, test_run_id: str | None, run_version: int | None) -> dict[str, dict]:
    if not test_run_id:
        return {}
    query = {"test_run_id": test_run_id}
    if run_version is not None:
        query["run_version"] = run_version
    return {
        doc["tc_id"]: mongo_schema.serialize(doc)
        for doc in db[mongo_schema.RESULTS].find(query)
    }


@router.get("/requirements")
def list_requirements(
    baseline: str | None = Query(None),
    test_run_id: str | None = Query(None),
    run_version: int | None = Query(None),
    chapter: str | None = Query(None),
    coverage: str | None = Query(None, pattern="^(covered|not_covered)$"),
    verification_method: str | None = Query(None),
    verification_tag: str | None = Query(None),
    q: str | None = Query(None),
    db=Depends(deps.get_db),
) -> dict:
    """The page-1 register: one row per requirement, coverage and verdict resolved."""
    deps.require_blob()
    baseline_id, implied_version = _resolve_baseline(db, baseline, test_run_id)
    bundle = baseline_service.load_bundle(baseline_id)
    req_links = bundle["baseline"].get("req_links") or {}
    verdicts = _verdict_index(db, test_run_id, run_version or implied_version)

    rows = []
    for req_id, requirement in sorted(bundle["requirements"].items()):
        covering = req_links.get(req_id) or []
        trace_coverable = requirement.get("verification_method") == "Test"
        if chapter and requirement.get("chapter") != chapter:
            continue
        if verification_method and requirement.get("verification_method") != verification_method:
            continue
        if verification_tag and requirement.get("verification_tag") != verification_tag:
            continue
        if coverage == "covered" and not covering:
            continue
        if coverage == "not_covered" and covering:
            continue
        if q and q.lower() not in (
            f"{req_id} {requirement.get('title', '')} {requirement.get('text', '')}".lower()
        ):
            continue
        rows.append(
            {
                "id": req_id,
                "title": requirement.get("title"),
                "chapter": requirement.get("chapter"),
                "ears_pattern": requirement.get("ears_pattern"),
                "verification_method": requirement.get("verification_method"),
                "verification_tag": requirement.get("verification_tag"),
                "measurand": requirement.get("measurand"),
                "status": requirement.get("status"),
                "revision": requirement.get("revision"),
                "coverage": {
                    "covered": bool(covering),
                    "trace_coverable": trace_coverable,
                    "state": (
                        "covered" if covering
                        else ("not covered" if trace_coverable else "not trace-coverable")
                    ),
                },
                "verified_by": covering,
                "latest_verdict": _requirement_verdict(covering, verdicts),
            }
        )
    return {
        "baseline_id": baseline_id,
        "test_run_id": test_run_id,
        "run_version": run_version or implied_version,
        "count": len(rows),
        "items": rows,
    }


def _requirement_verdict(covering: list[str], verdicts: dict[str, dict]) -> str | None:
    """Page-1 chip, using the 6.3 precedence over the covering cases only."""
    if not verdicts:
        return None
    present = [verdicts[tc_id]["verdict"] for tc_id in covering if tc_id in verdicts]
    if not present:
        return "not_run"
    for verdict in ("error", "fail", "inconclusive"):
        if verdict in present:
            return verdict
    if all(verdict == "pass" for verdict in present) and len(present) == len(covering):
        return "pass"
    if "pass" in present:
        return "partial"
    return "not_run"


@router.get("/requirements/{req_id}")
def get_requirement(
    req_id: str,
    baseline: str | None = Query(None),
    test_run_id: str | None = Query(None),
    run_version: int | None = Query(None),
    db=Depends(deps.get_db),
) -> dict:
    deps.require_blob()
    baseline_id, implied_version = _resolve_baseline(db, baseline, test_run_id)
    bundle = baseline_service.load_bundle(baseline_id)
    requirement = bundle["requirements"].get(req_id)
    if requirement is None:
        raise HTTPException(
            status_code=404, detail=f"{req_id} is not in baseline {baseline_id}"
        )
    covering = (bundle["baseline"].get("req_links") or {}).get(req_id) or []
    verdicts = _verdict_index(db, test_run_id, run_version or implied_version)
    figures = [
        {
            "ref": ref,
            "url": (
                f"/artifact-sets/requirements/versions/"
                f"{bundle['baseline']['requirements_version']}/figures/{ref}.svg"
            ),
            "resolved": False,
        }
        for ref in requirement.get("figure_refs") or []
    ]
    source_files = set(
        artifact_store.list_figures(
            "requirements", bundle["baseline"]["requirements_version"]
        )
    )
    for figure in figures:
        match = next(
            (name for name in sorted(source_files) if name.startswith(f"{figure['ref']}-")), None
        )
        figure["resolved"] = match is not None
        if match:
            figure["url"] = (
                f"/artifact-sets/requirements/versions/"
                f"{bundle['baseline']['requirements_version']}/figures/{match}"
            )
    return {
        "baseline_id": baseline_id,
        "requirement": requirement,
        "verified_by": covering,
        "coverage": {
            "covered": bool(covering),
            "covering_tc_ids": covering,
            "trace_coverable": requirement.get("verification_method") == "Test",
        },
        "verdict": {
            "value": _requirement_verdict(covering, verdicts),
            "per_case": {tc_id: verdicts[tc_id] for tc_id in covering if tc_id in verdicts},
        },
        "figures": figures,
        "related_reqs": requirement.get("related_reqs") or [],
    }


@router.get("/test-cases")
def list_test_cases(
    baseline: str | None = Query(None),
    test_run_id: str | None = Query(None),
    run_version: int | None = Query(None),
    req_id: str | None = Query(None),
    db=Depends(deps.get_db),
) -> dict:
    deps.require_blob()
    baseline_id, implied_version = _resolve_baseline(db, baseline, test_run_id)
    bundle = baseline_service.load_bundle(baseline_id)
    verdicts = _verdict_index(db, test_run_id, run_version or implied_version)
    links = {}
    if test_run_id:
        for link in db[mongo_schema.RUN_TRACE_LINKS].find(
            {"test_run_id": test_run_id, "run_version": run_version or implied_version}
        ):
            links.setdefault(link["tc_id"], []).append(link["trace_key"])

    rows = []
    for tc_id, test_case in sorted(bundle["test_cases"].items()):
        if req_id and req_id not in (test_case.get("covers_req_ids") or []):
            continue
        rows.append(
            {
                "tc_id": tc_id,
                "mnemonic": test_case.get("mnemonic"),
                "title": test_case.get("title"),
                "technique": test_case.get("technique"),
                "priority": test_case.get("priority", "medium"),
                "covers_req_ids": test_case.get("covers_req_ids") or [],
                "has_implementation": tc_id in bundle["impls"],
                "attached_traces": sorted(links.get(tc_id) or []),
                "latest_verdict": (verdicts.get(tc_id) or {}).get("verdict"),
                "criteria_count": len(test_case.get("pass_criteria") or []),
            }
        )
    return {"baseline_id": baseline_id, "count": len(rows), "items": rows}


@router.get("/test-cases/{tc_id}")
def get_test_case(
    tc_id: str,
    baseline: str | None = Query(None),
    test_run_id: str | None = Query(None),
    run_version: int | None = Query(None),
    db=Depends(deps.get_db),
) -> dict:
    deps.require_blob()
    baseline_id, implied_version = _resolve_baseline(db, baseline, test_run_id)
    bundle = baseline_service.load_bundle(baseline_id)
    test_case = bundle["test_cases"].get(tc_id)
    if test_case is None:
        raise HTTPException(status_code=404, detail=f"{tc_id} is not in baseline {baseline_id}")
    version = run_version or implied_version
    attachments = []
    results = []
    if test_run_id:
        attachments = [
            mongo_schema.serialize(link)
            for link in db[mongo_schema.RUN_TRACE_LINKS].find(
                {"test_run_id": test_run_id, "run_version": version, "tc_id": tc_id}
            )
        ]
        results = [
            mongo_schema.serialize(doc)
            for doc in db[mongo_schema.RESULTS].find(
                {"test_run_id": test_run_id, "run_version": version, "tc_id": tc_id}
            )
        ]
    return {
        "baseline_id": baseline_id,
        "test_case": test_case,
        "covers": [
            {
                "req_id": req_id,
                "title": (bundle["requirements"].get(req_id) or {}).get("title"),
                "verification_method": (
                    bundle["requirements"].get(req_id) or {}
                ).get("verification_method"),
            }
            for req_id in test_case.get("covers_req_ids") or []
        ],
        "impl": bundle["impls"].get(tc_id),
        "signal_catalog_entries": {
            criterion["signal"]: bundle["signal_catalog"].get(criterion["signal"])
            for criterion in test_case.get("pass_criteria") or []
        },
        "attachments": attachments,
        "results": results,
    }


@router.get("/test-impl/{tc_id}")
def get_test_impl(
    tc_id: str,
    baseline: str | None = Query(None),
    db=Depends(deps.get_db),
) -> dict:
    deps.require_blob()
    baseline_id, _ = _resolve_baseline(db, baseline, None)
    bundle = baseline_service.load_bundle(baseline_id)
    impl = bundle["impls"].get(tc_id)
    if impl is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"no implementation for {tc_id} in test-impl "
                f"{bundle['baseline']['test_impl_version']}"
            ),
        )
    return {
        "baseline_id": baseline_id,
        "test_impl_version": bundle["baseline"]["test_impl_version"],
        "impl": impl,
        "code_dir": paths.impl_code_dir(bundle["baseline"]["test_impl_version"], tc_id),
    }


@router.get("/test-impl/{tc_id}/preview")
def preview_test_impl(
    tc_id: str,
    baseline: str | None = Query(None),
    max_lines: int = Query(200, ge=1, le=2000),
    db=Depends(deps.get_db),
) -> dict:
    deps.require_blob()
    baseline_id, _ = _resolve_baseline(db, baseline, None)
    bundle = baseline_service.load_bundle(baseline_id)
    impl = bundle["impls"].get(tc_id)
    if impl is None:
        raise HTTPException(status_code=404, detail=f"no implementation for {tc_id}")
    return impl_service.preview_code(
        bundle["baseline"]["test_impl_version"], tc_id, impl["entrypoint"], max_lines
    )


@router.get("/test-impl/{tc_id}/code")
def download_test_impl(
    tc_id: str,
    baseline: str | None = Query(None),
    path: str | None = Query(None),
    db=Depends(deps.get_db),
) -> Response:
    """Stream the object from blob. The frontend never gets a blob URL."""
    deps.require_blob()
    baseline_id, _ = _resolve_baseline(db, baseline, None)
    bundle = baseline_service.load_bundle(baseline_id)
    impl = bundle["impls"].get(tc_id)
    if impl is None:
        raise HTTPException(status_code=404, detail=f"no implementation for {tc_id}")
    version = bundle["baseline"]["test_impl_version"]
    wanted = path or impl["entrypoint"]
    known = {record["path"] for record in impl.get("files") or []}
    if wanted not in known:
        raise HTTPException(
            status_code=404,
            detail=f"{wanted!r} is not a file of {tc_id}; known files are {sorted(known)}",
        )
    blob = artifact_store.read_impl_code(version, tc_id, wanted)
    basename = wanted.rsplit("/", 1)[-1]
    return Response(
        content=blob,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{basename}"'},
    )


@router.get("/signal-catalog")
def get_signal_catalog(
    baseline: str | None = Query(None),
    db=Depends(deps.get_db),
) -> dict:
    deps.require_blob()
    baseline_id, _ = _resolve_baseline(db, baseline, None)
    bundle = baseline_service.load_bundle(baseline_id)
    return {
        "baseline_id": baseline_id,
        "signal_catalog_version": bundle["baseline"]["signal_catalog_version"],
        "set": "signal_catalog",
        "items": bundle["signal_catalog"],
    }
