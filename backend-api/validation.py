"""Door validation: reject on upload, never later during evaluation.

The order is normative (schemas.md 10):

1. media type / size limits (deployment level, enforced in the upload router)
2. parse (JSON) or ReqIF parse -> mapping -> normalisation N1-N6
3. JSON Schema validation of every item, then of the set manifest.
   **Atomic** - one invalid item rejects the whole upload; no partial version
   is minted
4. cross-field rules JSON Schema cannot express
5. canonicalisation -> per-item and per-set ``canonical_sha256``
6. staged write, manifest last as the commit marker
7. static pass-criteria and link checks run at *baseline creation*, not here -
   an upload may legitimately reference a requirement version not yet pinned

Steps 3 and 4 live here. Step 5 lives in ``canonical``; step 6 in
``artifact_store``; step 7 in ``baseline_service``.
"""

from dataclasses import dataclass

import error_envelope
import ids
import schema_registry
from settings import (
    GROUP_TABLES,
    SET_ITEM_SCHEMAS,
    SET_MANIFEST_SCHEMAS,
    SET_REQUIREMENTS,
    SET_SIGNAL_CATALOG,
    SET_TEST_SPECS,
)


@dataclass(frozen=True)
class Problem:
    """One validation failure, addressed to a specific item and location."""

    code: str
    message: str
    entity_id: str | None = None
    pointer: str | None = None

    def as_dict(self) -> dict:
        return {
            "code": self.code,
            "message": self.message,
            "entity_id": self.entity_id,
            "pointer": self.pointer,
        }


class UploadRejected(Exception):
    """Atomic rejection: carries every problem found, not just the first."""

    def __init__(self, stage: str, problems: list[Problem] | None = None) -> None:
        self.stage = stage
        self.problems: list[Problem] = list(problems or [])
        super().__init__(
            f"{len(self.problems)} validation problem(s) at stage {stage!r}"
        )

    def as_dict(self) -> dict:
        """The single error envelope (``error_envelope``), not a third shape.

        ``problems`` keeps its key name and its element shape - the frontend and
        the round-1 verification both read it - but the body now leads with the
        same ``error``/``message`` pair as every other error this API returns.
        """
        return error_envelope.envelope(
            422,
            f"upload rejected at stage {self.stage!r}: {len(self.problems)} problem(s)",
            error="upload_rejected",
            problems=[problem.as_dict() for problem in self.problems],
            stage=self.stage,
            problem_count=len(self.problems),
        )


def validate_items(set_name: str, items: list[dict]) -> list[Problem]:
    """Step 3 for the item schema of one artifact set."""
    schema_name, id_field = SET_ITEM_SCHEMAS[set_name]
    problems: list[Problem] = []
    for index, item in enumerate(items):
        entity_id = item.get(id_field) if isinstance(item, dict) else None
        label = str(entity_id) if entity_id else f"items[{index}]"
        for error in schema_registry.iter_errors(schema_name, item):
            problems.append(
                Problem(
                    code="schema_violation",
                    message=error.message,
                    entity_id=label,
                    pointer=schema_registry.pointer(error),
                )
            )
    return problems


def validate_manifest(set_name: str, manifest: dict) -> list[Problem]:
    """Step 3 for the set manifest, which embeds and re-validates the items."""
    return [
        Problem(
            code="schema_violation",
            message=error.message,
            entity_id=manifest.get("version"),
            pointer=schema_registry.pointer(error),
        )
        for error in schema_registry.iter_errors(SET_MANIFEST_SCHEMAS[set_name], manifest)
    ]


def cross_field_rules(
    set_name: str,
    items: list[dict],
    upload_files: set[str] | None = None,
) -> list[Problem]:
    """Step 4: the rules JSON Schema cannot express (schemas.md 10.4)."""
    _, id_field = SET_ITEM_SCHEMAS[set_name]
    problems: list[Problem] = []

    seen: dict[str, int] = {}
    for item in items:
        item_id = item.get(id_field)
        if not isinstance(item_id, str):
            continue
        seen[item_id] = seen.get(item_id, 0) + 1
    for item_id, count in sorted(seen.items()):
        if count > 1:
            problems.append(
                Problem(
                    code="duplicate_id",
                    message=f"{id_field} {item_id!r} appears {count} times in the upload",
                    entity_id=item_id,
                )
            )

    if set_name == SET_REQUIREMENTS:
        problems.extend(_requirement_rules(items, upload_files or set()))
    elif set_name == SET_TEST_SPECS:
        problems.extend(_test_case_rules(items))
    elif set_name == SET_SIGNAL_CATALOG:
        problems.extend(_signal_catalog_rules(items))
    return problems


def _requirement_rules(items: list[dict], upload_files: set[str]) -> list[Problem]:
    problems: list[Problem] = []
    for item in items:
        req_id = item.get("id", "")
        if req_id in (item.get("related_reqs") or []):
            problems.append(
                Problem(
                    code="self_reference",
                    message="related_reqs must not contain the requirement's own id",
                    entity_id=req_id,
                    pointer="/related_reqs",
                )
            )
        prefix = ids.req_prefix(req_id)
        expected_chapter = ids.CHAPTER_BY_PREFIX.get(prefix) if prefix else None
        if expected_chapter and item.get("chapter") != expected_chapter:
            problems.append(
                Problem(
                    code="chapter_mismatch",
                    message=(
                        f"id prefix {prefix} implies chapter {expected_chapter!r} "
                        f"but chapter is {item.get('chapter')!r}"
                    ),
                    entity_id=req_id,
                    pointer="/chapter",
                )
            )
        # figure_refs only resolve for a .reqifz upload, which carries figures.
        if upload_files:
            for ref in item.get("figure_refs") or []:
                if not any(name.startswith(f"{ref}-") for name in upload_files):
                    problems.append(
                        Problem(
                            code="unresolved_figure_ref",
                            message=(
                                f"figure_refs entry {ref!r} has no matching file in the upload "
                                f"(expected source/figures/{ref}-*.svg)"
                            ),
                            entity_id=req_id,
                            pointer="/figure_refs",
                        )
                    )
    return problems


def _test_case_rules(items: list[dict]) -> list[Problem]:
    problems: list[Problem] = []
    for item in items:
        tc_id = item.get("tc_id", "")
        steps = item.get("steps") or []
        numbers = [step.get("step_no") for step in steps]
        if numbers != list(range(1, len(numbers) + 1)):
            problems.append(
                Problem(
                    code="step_numbering",
                    message=f"steps[].step_no must be contiguous from 1, got {numbers}",
                    entity_id=tc_id,
                    pointer="/steps",
                )
            )
        criterion_ids = [c.get("criterion_id") for c in item.get("pass_criteria") or []]
        if len(criterion_ids) != len(set(criterion_ids)):
            problems.append(
                Problem(
                    code="duplicate_criterion_id",
                    message=f"criterion_id values must be unique within a case, got {criterion_ids}",
                    entity_id=tc_id,
                    pointer="/pass_criteria",
                )
            )
        gate_ids = [c.get("criterion_id") for c in (item.get("preconditions") or {}).get("gates")
                    or []]
        if len(gate_ids) != len(set(gate_ids)):
            problems.append(
                Problem(
                    code="duplicate_criterion_id",
                    message=f"precondition gate ids must be unique, got {gate_ids}",
                    entity_id=tc_id,
                    pointer="/preconditions/gates",
                )
            )
        impl_ref = item.get("impl_ref")
        if isinstance(impl_ref, dict) and impl_ref.get("impl_id") != tc_id:
            problems.append(
                Problem(
                    code="impl_id_mismatch",
                    message=(
                        "impl_ref.impl_id must equal tc_id (implementation is 1:1 with its case), "
                        f"got {impl_ref.get('impl_id')!r}"
                    ),
                    entity_id=tc_id,
                    pointer="/impl_ref/impl_id",
                )
            )
        mnemonic = item.get("mnemonic")
        if mnemonic and not ids.MNEMONIC_RE.match(mnemonic):
            problems.append(
                Problem(
                    code="schema_violation",
                    message=f"mnemonic {mnemonic!r} must match {ids.MNEMONIC_RE.pattern}",
                    entity_id=tc_id,
                    pointer="/mnemonic",
                )
            )
        for dependency in item.get("depends_on") or []:
            if dependency == tc_id:
                problems.append(
                    Problem(
                        code="self_reference",
                        message="depends_on must not contain the case's own id",
                        entity_id=tc_id,
                        pointer="/depends_on",
                    )
                )
    return problems


def _signal_catalog_rules(items: list[dict]) -> list[Problem]:
    """A catalogue entry's ``table`` must be the table of its channel group."""
    problems: list[Problem] = []
    for item in items:
        group = item.get("channel_group")
        expected = GROUP_TABLES.get(group)
        if expected and item.get("table") != expected:
            problems.append(
                Problem(
                    code="signal_group_mismatch",
                    message=(
                        f"channel_group {group!r} maps to table {expected!r}, "
                        f"not {item.get('table')!r}"
                    ),
                    entity_id=item.get("signal"),
                    pointer="/table",
                )
            )
    return problems


def run_door_validation(
    set_name: str,
    items: list[dict],
    upload_files: set[str] | None = None,
) -> None:
    """Steps 3 and 4 together. Raises ``UploadRejected`` with every problem."""
    problems = validate_items(set_name, items)
    if problems:
        raise UploadRejected(stage="item_schema", problems=problems)
    problems = cross_field_rules(set_name, items, upload_files)
    if problems:
        raise UploadRejected(stage="cross_field", problems=problems)


def check_manifest_counts(manifest: dict) -> None:
    """``item_count == len(item_ids) == len(items)``, checked after the schema."""
    item_count = manifest.get("item_count")
    item_ids = manifest.get("item_ids") or []
    items = manifest.get("items") or []
    if not (item_count == len(item_ids) == len(items)):
        raise UploadRejected(
            stage="manifest_counts",
            problems=[
                Problem(
                    code="count_mismatch",
                    message=(
                        f"item_count={item_count}, len(item_ids)={len(item_ids)}, "
                        f"len(items)={len(items)} must all be equal"
                    ),
                    entity_id=manifest.get("version"),
                )
            ],
        )
