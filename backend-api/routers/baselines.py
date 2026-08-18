"""Baseline creation and reads - the never-mix rule made operational (spec 5.3)."""

from fastapi import APIRouter, Depends

import artifact_store
import baseline_service
import deps
from api_models import BaselineCreate

router = APIRouter(prefix="/baselines", tags=["baselines"])


@router.get("")
def list_baselines(db=Depends(deps.get_db)) -> dict:
    """Newest last. The sidebar's default selection is the newest baseline."""
    deps.require_blob()
    baseline_ids = artifact_store.list_baseline_ids()
    summaries = {
        doc["baseline_id"]: {
            "label": doc.get("label"),
            "created_utc": doc.get("created_utc"),
            "counts": doc.get("counts"),
            "baseline_coverage_static": doc.get("baseline_coverage_static"),
        }
        for doc in db["baselines"].find({}, {"_id": 0})
    }
    return {
        "count": len(baseline_ids),
        "latest": baseline_ids[-1] if baseline_ids else None,
        "items": [
            {"baseline_id": baseline_id, **summaries.get(baseline_id, {})}
            for baseline_id in baseline_ids
        ],
    }


@router.post("", status_code=201)
def create_baseline(body: BaselineCreate, db=Depends(deps.get_db)) -> dict:
    """Validate the pin, then mint it. An error finding rejects the whole baseline."""
    deps.require_blob()
    return baseline_service.create_baseline(
        db=db,
        requirements_version=body.requirements_version,
        test_specs_version=body.test_specs_version,
        test_impl_version=body.test_impl_version,
        signal_catalog_version=body.signal_catalog_version,
        label=body.label,
        created_by=body.created_by,
    )


@router.post("/dry-run")
def dry_run(body: BaselineCreate) -> dict:
    """Run the integrity checks without minting anything.

    Useful before an upload cycle: it answers "would this pin be accepted?"
    without consuming a baseline id.
    """
    deps.require_blob()
    requirements = artifact_store.read_items("requirements", body.requirements_version)
    test_cases = artifact_store.read_items("test_specs", body.test_specs_version)
    impls = artifact_store.read_items("test_impl", body.test_impl_version)
    catalog = artifact_store.read_items("signal_catalog", body.signal_catalog_version)
    findings, req_links = baseline_service.check_integrity(
        requirements, test_cases, impls, catalog
    )
    errors = [finding for finding in findings if finding["severity"] == "error"]
    return {
        "would_be_accepted": not errors,
        "error_count": len(errors),
        "warning_count": len(findings) - len(errors),
        "findings": findings,
        "covered_requirements": sum(1 for tcs in req_links.values() if tcs),
        "requirements": len(requirements),
    }


@router.get("/{baseline_id}")
def get_baseline(baseline_id: str) -> dict:
    deps.require_blob()
    return artifact_store.read_baseline(baseline_id)


@router.get("/{baseline_id}/bundle")
def get_bundle(baseline_id: str) -> dict:
    """Everything resolved through one baseline, in one call.

    Consumed by the evaluator so it cannot mix versions by fetching the pieces
    separately, and by the frontend when a page needs several artifact kinds.
    """
    deps.require_blob()
    return baseline_service.load_bundle(baseline_id)
