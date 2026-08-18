"""Baseline creation: the point where version mixing becomes unrepresentable.

A baseline pins exactly one version of each of the four artifact sets (D5). A run
references a baseline, never individual artifacts, so "a run with a test case
from v0007 and an implementation from v0004" is not a state the system can
reach - it is a *different baseline*, and creating it re-runs every integrity
check below.

Checks run here, not at run time (spec 2.3), because a failed pin should be
impossible to reference rather than something a run discovers halfway through.
"""

import logging

import artifact_store
import canonical
import criteria_static
import error_envelope
import ids
import mongo_schema
import schema_registry
from settings import (
    SET_REQUIREMENTS,
    SET_SIGNAL_CATALOG,
    SET_TEST_IMPL,
    SET_TEST_SPECS,
    VALIDATOR_VERSION,
)
from validation import Problem, UploadRejected

logger = logging.getLogger(__name__)

# Requirement verification_method -> permitted test-case verification_method
# (spec 2.4). Evidence kinds are enforced by the evaluator, not here.
METHOD_COMPATIBILITY = {
    "Test": {"Test"},
    "Demonstration": {"Demonstration", "Test"},
    "Inspection": {"Inspection"},
    "Analysis": {"Analysis", "Inspection"},
}


class BaselineRejected(Exception):
    """A pin whose integrity findings include at least one error."""

    def __init__(self, findings: list[dict]) -> None:
        self.findings = findings
        errors = sum(1 for f in findings if f["severity"] == "error")
        super().__init__(f"baseline rejected: {errors} error finding(s)")

    def as_dict(self) -> dict:
        """The single error envelope. ``findings`` keeps its own shape - it carries
        ``severity``, which ``problems`` does not, so it is not folded into it."""
        error_count = sum(1 for finding in self.findings if finding["severity"] == "error")
        return error_envelope.envelope(
            422,
            f"baseline rejected: {error_count} error finding(s)",
            error="baseline_rejected",
            error_count=error_count,
            findings=self.findings,
        )


def check_integrity(
    requirements: dict[str, dict],
    test_cases: dict[str, dict],
    impls: dict[str, dict],
    catalog: dict[str, dict],
) -> tuple[list[dict], dict[str, list[str]]]:
    """Spec 2.3 rules 1-5. Returns ``(findings, req_links)``."""
    findings: list[dict] = []
    req_links: dict[str, list[str]] = {req_id: [] for req_id in requirements}

    for tc_id, test_case in sorted(test_cases.items()):
        covered = test_case.get("covers_req_ids") or []
        if not covered:
            findings.append(
                criteria_static.finding(
                    "warning", "orphan_test_case",
                    f"{tc_id} covers no requirement", tc_id,
                )
            )
        for req_id in covered:
            requirement = requirements.get(req_id)
            if requirement is None:
                # Rule 1: unresolved reference rejects the baseline.
                findings.append(
                    criteria_static.finding(
                        "error", "unresolved_req_ref",
                        f"{tc_id} covers {req_id!r}, absent from the pinned requirements version",
                        tc_id,
                    )
                )
                continue
            req_links[req_id].append(tc_id)

            # Rule 4: method compatibility.
            permitted = METHOD_COMPATIBILITY.get(requirement.get("verification_method"), set())
            if test_case.get("verification_method") not in permitted:
                findings.append(
                    criteria_static.finding(
                        "error", "method_incompatible",
                        (
                            f"{tc_id} verification_method "
                            f"{test_case.get('verification_method')!r} cannot verify {req_id} "
                            f"whose method is {requirement.get('verification_method')!r} "
                            f"(permitted: {sorted(permitted)})"
                        ),
                        tc_id,
                    )
                )

        # Rule 2: impl_ref resolves, or is absent.
        impl_ref = test_case.get("impl_ref")
        if isinstance(impl_ref, dict):
            impl_id = impl_ref.get("impl_id")
            if impl_id not in impls:
                findings.append(
                    criteria_static.finding(
                        "error", "unresolved_impl_ref",
                        (
                            f"{tc_id} references implementation {impl_id!r}, absent from the "
                            "pinned test-impl version"
                        ),
                        tc_id,
                    )
                )

        # Rule 3: static pass-criteria checks against the pinned catalogue.
        findings.extend(criteria_static.check_test_case(test_case, catalog))

    # Rule 5: uncovered requirements are listed, not rejected.
    for req_id in sorted(requirements):
        if not req_links[req_id]:
            findings.append(
                criteria_static.finding(
                    "warning", "uncovered_requirement",
                    f"{req_id} is covered by no test case in this baseline", req_id,
                )
            )

    return findings, {req_id: sorted(set(tcs)) for req_id, tcs in req_links.items()}


def create_baseline(
    db,
    requirements_version: str,
    test_specs_version: str,
    test_impl_version: str,
    signal_catalog_version: str,
    label: str = "",
    created_by: str = "",
) -> dict:
    """Validate a pin, mint ``BL-nnnn``, write blob + Mongo. Raises on error findings."""
    requirements = artifact_store.read_items(SET_REQUIREMENTS, requirements_version)
    test_cases = artifact_store.read_items(SET_TEST_SPECS, test_specs_version)
    impls = artifact_store.read_items(SET_TEST_IMPL, test_impl_version)
    catalog = artifact_store.read_items(SET_SIGNAL_CATALOG, signal_catalog_version)

    findings, req_links = check_integrity(requirements, test_cases, impls, catalog)
    if any(f["severity"] == "error" for f in findings):
        raise BaselineRejected(findings)

    baseline_id = ids.next_baseline_id(artifact_store.list_baseline_ids())
    covered = [req_id for req_id, tcs in req_links.items() if tcs]
    testable = [
        req_id for req_id, req in requirements.items() if req.get("verification_method") == "Test"
    ]

    doc = {
        "schema_version": "1.0.0",
        "baseline_id": baseline_id,
        "label": label,
        "requirements_version": requirements_version,
        "test_specs_version": test_specs_version,
        "test_impl_version": test_impl_version,
        "signal_catalog_version": signal_catalog_version,
        "set_hashes": {
            "requirements": _set_hash(SET_REQUIREMENTS, requirements_version),
            "test_specs": _set_hash(SET_TEST_SPECS, test_specs_version),
            "test_impl": _set_hash(SET_TEST_IMPL, test_impl_version),
            "signal_catalog": _set_hash(SET_SIGNAL_CATALOG, signal_catalog_version),
        },
        "created_utc": ids.utc_now_iso(),
        "created_by": created_by,
        "integrity": {"ok": True, "findings": findings},
        "counts": {
            "requirements": len(requirements),
            "test_cases": len(test_cases),
            "impls": len(impls),
            "covered_requirements": len(covered),
        },
        "baseline_coverage_static": (
            round(len(covered) / len(requirements), 6) if requirements else None
        ),
        "req_links": {req_id: tcs for req_id, tcs in req_links.items() if tcs},
    }

    problems = [
        Problem(
            code="schema_violation",
            message=error.message,
            entity_id=baseline_id,
            pointer=schema_registry.pointer(error),
        )
        for error in schema_registry.iter_errors("baseline-1.0.0", doc)
    ]
    if problems:
        raise UploadRejected(stage="baseline_schema", problems=problems)

    artifact_store.write_baseline(doc)
    _mirror_to_mongo(db, doc, requirements, req_links, set(testable))
    logger.info(
        "Created %s (%d requirements, %d cases, %d covered)",
        baseline_id, len(requirements), len(test_cases), len(covered),
    )
    return doc


def _set_hash(set_name: str, version: str) -> str:
    manifest = artifact_store.read_manifest(set_name, version)
    return manifest["set_canonical_sha256"]


def _mirror_to_mongo(
    db,
    doc: dict,
    requirements: dict[str, dict],
    req_links: dict[str, list[str]],
    testable: set[str],
) -> None:
    """Mirror the pin and the ``verified_by`` link block into queryable form.

    The canonical requirements document keeps ``verified_by`` exactly as
    uploaded (empty in Phase 1): writing links into it would mutate an immutable
    version folder. The populated mirror lives in the baseline and is surfaced by
    the API under the same field name, so the name is unchanged end to end
    (spec 2.5).
    """
    summary = {key: value for key, value in doc.items() if key != "req_links"}
    summary["validator_version"] = VALIDATOR_VERSION
    summary["baseline_canonical_sha256"] = canonical.canonical_sha256(doc)
    db[mongo_schema.BASELINES].update_one(
        {"baseline_id": doc["baseline_id"]}, {"$set": summary}, upsert=True
    )

    operations = []
    for req_id, requirement in sorted(requirements.items()):
        covering = req_links.get(req_id) or []
        operations.append(
            {
                "baseline_id": doc["baseline_id"],
                "req_id": req_id,
                "covering_tc_ids": covering,
                "covered": bool(covering),
                "trace_coverable": req_id in testable,
                "chapter": requirement.get("chapter"),
                "verification_method": requirement.get("verification_method"),
            }
        )
    for record in operations:
        db[mongo_schema.REQ_COVERAGE].update_one(
            {"baseline_id": record["baseline_id"], "req_id": record["req_id"]},
            {"$set": record},
            upsert=True,
        )


def resolve_baseline(baseline_id: str) -> dict:
    """Read a baseline document from blob (the record of truth)."""
    return artifact_store.read_baseline(baseline_id)


def load_bundle(baseline_id: str) -> dict:
    """Everything a run or an evaluation needs, resolved through one baseline.

    Returned as one payload so the evaluator makes a single call and cannot
    accidentally mix versions by fetching the pieces separately.
    """
    baseline = resolve_baseline(baseline_id)
    return {
        "baseline": baseline,
        "requirements": artifact_store.read_items(
            SET_REQUIREMENTS, baseline["requirements_version"]
        ),
        "test_cases": artifact_store.read_items(
            SET_TEST_SPECS, baseline["test_specs_version"]
        ),
        "impls": artifact_store.read_items(SET_TEST_IMPL, baseline["test_impl_version"]),
        "signal_catalog": artifact_store.read_items(
            SET_SIGNAL_CATALOG, baseline["signal_catalog_version"]
        ),
    }
