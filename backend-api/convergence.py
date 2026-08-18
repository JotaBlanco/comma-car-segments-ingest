"""Proof that the ReqIF and JSON upload paths converge (spec 1.1.2).

The requirement is not "both paths work" but "both paths produce byte-identical
canonical JSON for equivalent input". That is a claim about two code paths that
share no parser, so it needs a check that can actually fail; a convergence
failure is a release blocker, not a warning.

Three assertions, in increasing strength:

1. per-item ``canonical_sha256`` equality;
2. set-level ``canonical_sha256`` equality over the concatenated sorted item
   hashes;
3. byte equality of the two *stored* ``canonical/requirements.json`` documents.

Exposed as ``POST /uploads/requirements/convergence-check`` so it can be run
against the real export without minting a version. Tester owns the acceptance
run; this module owns the comparison.
"""

import canonical
import upload_service


def compare(reqif_filename: str, reqif_bytes: bytes,
            json_filename: str, json_bytes: bytes) -> dict:
    """Run both upload paths and report whether they converged."""
    left_items, _, left_warnings, _ = upload_service.canonical_requirements(
        reqif_filename, reqif_bytes
    )
    right_items, _, right_warnings, _ = upload_service.canonical_requirements(
        json_filename, json_bytes
    )

    left_by_id = {item["id"]: item for item in left_items}
    right_by_id = {item["id"]: item for item in right_items}

    only_left = sorted(set(left_by_id) - set(right_by_id))
    only_right = sorted(set(right_by_id) - set(left_by_id))
    shared = sorted(set(left_by_id) & set(right_by_id))

    per_item = []
    mismatched = []
    for item_id in shared:
        left_hash = canonical.canonical_sha256(left_by_id[item_id])
        right_hash = canonical.canonical_sha256(right_by_id[item_id])
        equal = left_hash == right_hash
        if not equal:
            mismatched.append(item_id)
            per_item.append(
                {
                    "id": item_id,
                    "reqif_sha256": left_hash,
                    "json_sha256": right_hash,
                    "differing_fields": _differing_fields(
                        left_by_id[item_id], right_by_id[item_id]
                    ),
                }
            )

    left_set_hash = canonical.set_canonical_sha256(
        [canonical.canonical_sha256(item) for item in left_items]
    )
    right_set_hash = canonical.set_canonical_sha256(
        [canonical.canonical_sha256(item) for item in right_items]
    )

    left_stored = canonical.stored_bytes({"items": left_items})
    right_stored = canonical.stored_bytes({"items": right_items})

    converged = (
        not only_left
        and not only_right
        and not mismatched
        and left_set_hash == right_set_hash
        and left_stored == right_stored
    )

    return {
        "converged": converged,
        "reqif": {
            "filename": reqif_filename,
            "item_count": len(left_items),
            "set_canonical_sha256": left_set_hash,
            "stored_bytes": len(left_stored),
            "warnings": left_warnings,
        },
        "json": {
            "filename": json_filename,
            "item_count": len(right_items),
            "set_canonical_sha256": right_set_hash,
            "stored_bytes": len(right_stored),
            "warnings": right_warnings,
        },
        "assertions": {
            "per_item_hashes_equal": not mismatched,
            "set_hash_equal": left_set_hash == right_set_hash,
            "stored_bytes_equal": left_stored == right_stored,
        },
        "only_in_reqif": only_left,
        "only_in_json": only_right,
        "mismatched_ids": mismatched,
        "mismatch_detail": per_item,
    }


def _differing_fields(left: dict, right: dict) -> list[dict]:
    """Field-level diff, so a convergence failure names the mapping rule at fault."""
    differences = []
    for field in sorted(set(left) | set(right)):
        left_value = left.get(field)
        right_value = right.get(field)
        if left_value != right_value:
            differences.append({"field": field, "reqif": left_value, "json": right_value})
    return differences
