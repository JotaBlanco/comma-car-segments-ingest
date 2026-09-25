"""Requirement reads and authored writes.

`_project` is the one fold that turns the mirrored `requirements` collection
and the `test_definitions.covers_req_ids` link into every derived value a
requirement carries: `verified_by` (BP5), `covering_run_ids`, `latest_run_id`
and `verification_state` (dev-planning/requirement-status-from-runs/spec.md
§5.3). The list and the detail both call it, so the two can never disagree.

The authored writes (`create_requirement`, `patch_requirement`,
`retire_requirement`) carry dev-planning/authoring-controls/spec.md's four
named refusals — `id_reuse`, `stale_parent`, `no_op_mint`, `already_obsolete` —
and one more: `illegal_transition`, the status gate of
dev-planning/requirement-status-gates/spec.md §4.1, whose table lives in
`api.requirement_lifecycle`.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

from pymongo import ASCENDING, DESCENDING
from pymongo.database import Database

from api.errors import ApiError
from api.models.common import Pagination, Source
from api.models.requirements import (
    RequirementCreateRequest,
    RequirementPatchRequest,
    RequirementRetireRequest,
)
from api.provenance import add_event, plain_values, set_field, sources
from api.requirement_lifecycle import AUTHOR_TARGETS, check_transition

# Every authored field a requirement carries, `status` excluded — the same
# exclusion `normative_sha256` applies below, so a Draft -> Reviewed move
# alone mints neither hash (authoring-controls spec.md §12 OQ5).
CONTENT_FIELDS = (
    "title",
    "text",
    "system",
    "chapter",
    "ears_pattern",
    "revision",
    "measurand",
    "system_states",
    "verification_method",
    "verification_criteria",
    "rationale",
    "source",
    "related_reqs",
    "figure_refs",
)

# The board's field list (dev-planning/requirement-status-from-runs/spec.md
# §4.6): a link goes suspect only when one of these changes.
NORMATIVE_FIELDS = (
    "text",
    "measurand",
    "system_states",
    "verification_method",
    "verification_criteria",
)

# The lifecycle states a requirement is still being authored in (`CLAUDE.md`
# § Requirements workflow). A content edit in any other state returns it here.
AUTHORING_STATUSES = ("NEW", "Draft")

# The list read caps the run evidence at 20 and reports the true count
# alongside it (dev-planning/requirement-status-from-runs/spec.md §4.3). The
# detail read is uncapped.
LIST_RUN_CAP = 20


def _canonical_sha256(values: dict, fields: tuple[str, ...]) -> str:
    canonical = {field: values.get(field) for field in fields}
    payload = json.dumps(canonical, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def content_sha256(values: dict) -> str:
    """Hash every authored field but `status`, canonical order.

    Shared with `planning_sync._mirror_requirements`, so a planning write and
    an authored write mint `item_version` by the same rule.
    """
    return _canonical_sha256(values, CONTENT_FIELDS)


def normative_sha256(values: dict) -> str:
    """Hash the board's field list only (§4.6 evidence staleness).

    Shared with `planning_sync._mirror_requirements`, so a mirror pass and an
    authored edit compute the same digest off the same field set.
    """
    return _canonical_sha256(values, NORMATIVE_FIELDS)


# --- the projection (spec §5.3) --------------------------------------------


def _fold_inputs(db: Database, requirement_ids: list[str]) -> dict:
    """The three bounded queries §5.3 asks for, read once per page."""
    definitions = list(db["test_definitions"].find({"covers_req_ids": {"$in": requirement_ids}}))
    td_ids = [definition["_id"] for definition in definitions]
    definitions_by_id = {definition["_id"]: definition for definition in definitions}

    verified_by: dict[str, list[str]] = {}
    wanted = set(requirement_ids)
    for definition in definitions:
        for req_id in definition.get("covers_req_ids") or []:
            if req_id in wanted:
                verified_by.setdefault(req_id, []).append(definition["_id"])
    for req_id, tds in verified_by.items():
        verified_by[req_id] = sorted(tds)

    runs: list[dict] = []
    if td_ids:
        runs = list(
            db["test_runs"]
            .find({"definition_ids": {"$in": td_ids}, "invalid.flagged": {"$ne": True}})
            .sort([("first_data_at", DESCENDING), ("_id", DESCENDING)])
        )
    run_ids = [run["_id"] for run in runs]

    runs_of_td: dict[str, list[dict]] = {}
    td_set = set(td_ids)
    for run in runs:  # already newest-first
        for td_id in run.get("definition_ids") or []:
            if td_id in td_set:
                runs_of_td.setdefault(td_id, []).append(run)

    # Newest verdict per (run_id, definition_id): sorted by version DESC, so
    # the first row seen for a key is the newest one.
    newest_verdict: dict[tuple[str, str], dict] = {}
    if run_ids and td_ids:
        for result in (
            db["processed_results"]
            .find({"run_id": {"$in": run_ids}, "verdict.definition_id": {"$in": td_ids}})
            .sort("version", DESCENDING)
        ):
            block = result.get("verdict") or {}
            key = (result["run_id"], block.get("definition_id"))
            newest_verdict.setdefault(key, result)

    return {
        "verified_by": verified_by,
        "runs_of_td": runs_of_td,
        "newest_verdict": newest_verdict,
        "definitions_by_id": definitions_by_id,
    }


def _newest_verdict_of_td(fold: dict, td_id: str) -> tuple[dict | None, dict | None]:
    """The newest run of `td_id` that carries a verdict, and that verdict.

    A test case re-run after a fix is judged on its latest attempt, not on
    its first (§5.3).
    """
    for run in fold["runs_of_td"].get(td_id, []):  # newest-first
        result = fold["newest_verdict"].get((run["_id"], td_id))
        if result is not None:
            return run, result
    return None, None


def _covering_runs(fold: dict, td_ids: list[str]) -> list[dict]:
    """The union of every covering td's runs, newest bench session first."""
    seen: set[str] = set()
    merged: list[dict] = []
    for td_id in td_ids:
        for run in fold["runs_of_td"].get(td_id, []):
            if run["_id"] not in seen:
                seen.add(run["_id"])
                merged.append(run)
    merged.sort(key=lambda run: (run["first_data_at"], run["_id"]), reverse=True)
    return merged


def _state_fold(fold: dict, requirement: dict, td_ids: list[str]) -> dict:
    """The five-value fold of §5.3, in the order the table states it."""
    if not td_ids:
        return {"verification_state": "not_covered", "evidence_stale": False, "tested_at": None}
    if not any(fold["runs_of_td"].get(td_id) for td_id in td_ids):
        return {"verification_state": "covered", "evidence_stale": False, "tested_at": None}

    normative_changed_at = requirement.get("normative_changed_at")
    any_fail = False
    any_unresolved = False
    any_stale_pass = False
    passing_produced_ats: list[datetime] = []

    for td_id in td_ids:
        _run, result = _newest_verdict_of_td(fold, td_id)
        if result is None:
            any_unresolved = True
            continue
        block = result.get("verdict") or {}
        outcome = block.get("outcome")
        if outcome == "fail":
            any_fail = True
        elif outcome == "pass":
            definition = fold["definitions_by_id"].get(td_id) or {}
            implementation = definition.get("implementation") or {}
            impl_sha = implementation.get("sha256")
            pinned = impl_sha is None or impl_sha == block.get("implementation_sha256")
            produced_at = (result.get("provenance") or {}).get("produced_at")
            fresh = normative_changed_at is None or (
                produced_at is not None and produced_at >= normative_changed_at
            )
            if pinned and fresh:
                passing_produced_ats.append(produced_at)
            else:
                any_stale_pass = True
        else:  # "error", or a malformed block naming neither
            any_unresolved = True

    if any_fail:
        return {"verification_state": "failed", "evidence_stale": False, "tested_at": None}
    if any_unresolved:
        return {"verification_state": "exercised", "evidence_stale": False, "tested_at": None}
    if any_stale_pass:
        return {"verification_state": "exercised", "evidence_stale": True, "tested_at": None}
    return {
        "verification_state": "tested",
        "evidence_stale": False,
        "tested_at": max(passing_produced_ats) if passing_produced_ats else None,
    }


def _project(db: Database, requirement_docs: list[dict]) -> list[dict]:
    """Overlay every derived field onto a list of requirement documents.

    `covering_run_ids` is returned uncapped; the list read caps it and the
    detail read does not (§4.3).
    """
    ids = [doc["_id"] for doc in requirement_docs]
    fold = _fold_inputs(db, ids)

    projected = []
    for doc in requirement_docs:
        req_id = doc["_id"]
        td_ids = fold["verified_by"].get(req_id, [])
        covering_runs = _covering_runs(fold, td_ids)
        covering_run_ids = [run["_id"] for run in covering_runs]
        state = _state_fold(fold, doc, td_ids)
        projected.append(
            {
                **doc,
                "verified_by": td_ids,
                "covering_run_ids": covering_run_ids,
                "covering_run_count": len(covering_run_ids),
                "latest_run_id": covering_run_ids[0] if covering_run_ids else None,
                **state,
            }
        )
    return projected


def _view_counts(rows: list[dict]) -> dict:
    counts = {
        "all": len(rows),
        "not_covered": 0,
        "covered": 0,
        "exercised": 0,
        "failed": 0,
        "tested": 0,
    }
    for row in rows:
        counts[row["verification_state"]] += 1
    return counts


def _matches(
    row: dict,
    system: list[str] | None,
    chapter: list[str] | None,
    status: list[str] | None,
    state: list[str] | None,
    method: list[str] | None,
    ears_pattern: list[str] | None,
    system_state: list[str] | None,
    measurand: list[str] | None,
    source: list[str] | None,
    revision: str | None,
    related_req: str | None,
    has_verified_by: bool | None,
    has_latest_run: bool | None,
    q: str | None,
) -> bool:
    """Every filter `GET /requirements` accepts, applied to one projected row.

    All fourteen run here, over the already-`_project`ed table — including
    `has_verified_by`/`has_latest_run`, which test `verified_by`/
    `latest_run_id` and so cannot be pushed into the Mongo `find()`: those two
    fields exist only after `_project` computes them, never on the stored
    document.
    """
    if system and row.get("system") not in system:
        return False
    if chapter and row.get("chapter") not in chapter:
        return False
    if status and row.get("status") not in status:
        return False
    if state and row.get("verification_state") not in state:
        return False
    if method and row.get("verification_method") not in method:
        return False
    if ears_pattern and row.get("ears_pattern") not in ears_pattern:
        return False
    if system_state and not set(row.get("system_states") or []) & set(system_state):
        return False
    if measurand:
        names = {entry.get("name") for entry in row.get("measurand") or []}
        if not names & set(measurand):
            return False
    if source and not set(row.get("source") or []) & set(source):
        return False
    if revision and row.get("revision") != revision:
        return False
    if related_req and related_req not in (row.get("related_reqs") or []):
        return False
    if has_verified_by is not None and bool(row.get("verified_by")) != has_verified_by:
        return False
    if has_latest_run is not None and (row.get("latest_run_id") is not None) != has_latest_run:
        return False
    if q:
        needle = q.strip().lower()
        haystack = " ".join(
            str(row.get(field) or "") for field in ("_id", "title", "text")
        ).lower()
        if needle not in haystack:
            return False
    return True


def list_requirements(
    db: Database,
    pagination: Pagination,
    *,
    system: list[str] | None = None,
    chapter: list[str] | None = None,
    status: list[str] | None = None,
    state: list[str] | None = None,
    method: list[str] | None = None,
    ears_pattern: list[str] | None = None,
    system_state: list[str] | None = None,
    measurand: list[str] | None = None,
    source: list[str] | None = None,
    revision: str | None = None,
    related_req: str | None = None,
    has_verified_by: bool | None = None,
    has_latest_run: bool | None = None,
    q: str | None = None,
) -> dict:
    """Page the requirement mirror, `req_id` ascending — no sort param (§6).

    Every visible column filters server-side, all fourteen in `_matches`
    over the whole projected table (`requirements-page/spec.md`'s widened
    filter set, beyond the four §11.2 names). `view_counts` is whole-table:
    it is built from every row before the filters narrow the set, so a quick
    view's badge never disagrees with what clearing the filters would show.
    """
    docs = list(db["requirements"].find().sort("_id", ASCENDING))
    rows = _project(db, docs)
    view_counts = _view_counts(rows)

    filtered = [
        row
        for row in rows
        if _matches(
            row,
            system,
            chapter,
            status,
            state,
            method,
            ears_pattern,
            system_state,
            measurand,
            source,
            revision,
            related_req,
            has_verified_by,
            has_latest_run,
            q,
        )
    ]
    total = len(filtered)
    start = (pagination.page - 1) * pagination.page_size
    page_rows = filtered[start : start + pagination.page_size]
    for row in page_rows:
        row["covering_run_ids"] = row["covering_run_ids"][:LIST_RUN_CAP]

    envelope = pagination.envelope(page_rows, total)
    envelope["view_counts"] = view_counts
    return envelope


def _facet_strings(values: list) -> list[str]:
    """Sort the values ascending and drop the null and the blank ones.

    A null belongs to no filter option — a requirement with no chapter is not
    a chapter a person can pick — and a blank narrows nothing.
    """
    return sorted(value for value in values if isinstance(value, str) and value.strip())


def _flatten(field: str) -> dict:
    """Fold a set of ARRAYS, as `$addToSet` leaves an array field, into one set."""
    return {
        "$reduce": {
            "input": field,
            "initialValue": [],
            "in": {"$setUnion": ["$$value", "$$this"]},
        }
    }


def requirement_facets(db: Database) -> dict:
    """The distinct filter values of the whole requirements table.

    No status filter, because `list_requirements` pages every document with
    none either: a retired requirement stays in the grid, so its values stay
    in the dropdowns. An empty collection answers seven empty lists.
    """
    pipeline = [
        {
            "$group": {
                "_id": None,
                "systems": {"$addToSet": "$system"},
                "chapters": {"$addToSet": "$chapter"},
                "statuses": {"$addToSet": "$status"},
                "methods": {"$addToSet": "$verification_method"},
                "system_states": {"$addToSet": "$system_states"},
                "measurands": {"$addToSet": "$measurand.name"},
                "sources": {"$addToSet": "$source"},
            }
        },
        {
            "$project": {
                "systems": 1,
                "chapters": 1,
                "statuses": 1,
                "methods": 1,
                "system_states": _flatten("$system_states"),
                "measurands": _flatten("$measurands"),
                "sources": _flatten("$sources"),
            }
        },
    ]
    grouped = next(db["requirements"].aggregate(pipeline), {})
    return {
        "systems": _facet_strings(grouped.get("systems") or []),
        "chapters": _facet_strings(grouped.get("chapters") or []),
        "statuses": _facet_strings(grouped.get("statuses") or []),
        "methods": _facet_strings(grouped.get("methods") or []),
        "system_states": _facet_strings(grouped.get("system_states") or []),
        "measurands": _facet_strings(grouped.get("measurands") or []),
        "sources": _facet_strings(grouped.get("sources") or []),
    }


def _requirement_or_404(db: Database, req_id: str) -> dict:
    doc = db["requirements"].find_one({"_id": req_id})
    if doc is None:
        raise ApiError(404, f"Requirement {req_id} not found", "requirement_not_found")
    return doc


def get_requirement_detail(db: Database, req_id: str) -> dict:
    """One requirement, its authored fields and the evidence covering it."""
    doc = _requirement_or_404(db, req_id)
    row = _project(db, [doc])[0]

    fold = _fold_inputs(db, [req_id])
    td_ids = fold["verified_by"].get(req_id, [])
    normative_changed_at = doc.get("normative_changed_at")

    evidence = []
    for td_id in td_ids:
        definition = fold["definitions_by_id"].get(td_id) or {}
        implementation = definition.get("implementation") or {}
        impl_sha = implementation.get("sha256")
        for run in fold["runs_of_td"].get(td_id, []):
            result = fold["newest_verdict"].get((run["_id"], td_id))
            block = (result or {}).get("verdict") or {}
            provenance = (result or {}).get("provenance") or {}
            outcome = block.get("outcome")
            current = None
            if outcome is not None:
                produced_at = provenance.get("produced_at")
                pinned = impl_sha is None or impl_sha == block.get("implementation_sha256")
                fresh = normative_changed_at is None or (
                    produced_at is not None and produced_at >= normative_changed_at
                )
                current = pinned and fresh
            evidence.append(
                {
                    "run_id": run["_id"],
                    "definition_id": td_id,
                    "definition_title": definition.get("title") or "",
                    "outcome": outcome,
                    "produced_at": provenance.get("produced_at"),
                    "implementation_sha256": block.get("implementation_sha256"),
                    "current": current,
                    "evidence_values": block.get("evidence") or {},
                }
            )

    return {**row, "evidence": evidence}


# --- authored writes (dev-planning/authoring-controls/spec.md §5, §6, §8) --


def _authored_values(body_dict: dict) -> dict:
    """The authored fields of a create/patch body, `None` for what it omits.

    Every key CONTENT_FIELDS names, read off a create or patch request's
    `model_dump()`. A patch that omits a field passes `None` here and the
    caller merges it against the stored value before hashing.
    """
    return {field: body_dict.get(field) for field in CONTENT_FIELDS}


def create_requirement(db: Database, body: RequirementCreateRequest, actor: str) -> dict:
    """POST /requirements — a manual row only. Refuses `id_reuse`.

    Uniqueness is checked against the WHOLE collection, any status, so a
    retired id can never be reclaimed (authoring-controls spec.md §5).
    """
    req_id = body.id.strip()
    if db["requirements"].find_one({"_id": req_id}, {"_id": 1}) is not None:
        raise ApiError(
            409,
            f"the id {req_id} is already used; retired ids are never reused",
            "id_reuse",
        )

    values = _authored_values(body.model_dump())
    now = datetime.now(UTC)
    digest = content_sha256(values)
    fresh_normative = normative_sha256(values)

    update: dict = {}
    for field, value in {**values, "status": body.status}.items():
        set_field(
            update,
            field,
            value,
            Source.MANUAL,
            actor,
            note=body.note,
            entity_type="requirement",
            entity_id=req_id,
            field_label=f"requirement.{field}",
        )

    doc = {
        "_id": req_id,
        **plain_values(update),
        "text_rendered": None,
        "field_sources": sources(update),
        "item_version": 1,
        "content_sha256": digest,
        "normative_sha256": fresh_normative,
        "normative_changed_at": now,
        "raw": None,
        "synced_at": None,
        "mirrored_at": None,
    }
    db["requirements"].insert_one(doc)
    db["journal_entries"].insert_one(
        add_event(
            "requirement",
            req_id,
            "requirement.created",
            Source.MANUAL,
            actor,
            note=body.note or f"Created the requirement {req_id}.",
        )
    )
    return get_requirement_detail(db, req_id)


def _note_with_second_actor(note: str | None, second_actor: str | None) -> str | None:
    """Append the four-eyes claim to a journal note (authoring-controls §7)."""
    named = (second_actor or "").strip()
    if not named:
        return note
    claim = f"Second reviewer: {named}."
    return f"{note} {claim}" if note else claim


def patch_requirement(
    db: Database, req_id: str, body: RequirementPatchRequest, actor: str
) -> dict:
    """PATCH /requirements/{req_id}. Refuses `stale_parent`, `no_op_mint`,
    `illegal_transition`.

    `status` is authored but sits outside `CONTENT_FIELDS`/`content_sha256`
    (§4.6, `no_op_mint` above): a status-only edit changes no content byte, so
    `no_op_mint` is decided over content-changed-or-status-changed, not the
    hash alone. `item_version` mints for either kind of change.

    A stated `status` is a move through the author door, so it must be one
    `AUTHOR_TARGETS` allows from the stored status
    (`dev-planning/requirement-status-gates/spec.md` §4.1).

    A content change to a requirement outside `AUTHORING_STATUSES` also
    returns it to `Draft`, journalled separately from the fields that moved.
    A PATCH that states a different `status` decides the status itself.

    `second_actor` names the second person a content edit on a frozen row
    needs. It is not a field and is not stored as one — it rides on the note
    of every journal entry this edit produces.
    """
    stored = _requirement_or_404(db, req_id)
    if body.parent_version != stored.get("item_version"):
        raise ApiError(
            409,
            "this requirement changed since it was opened; reload and reapply the edit",
            "stale_parent",
        )

    stated = body.model_dump(
        exclude={"parent_version", "actor", "second_actor", "note", "status"}
    )
    merged = {
        field: (stated[field] if stated.get(field) is not None else stored.get(field))
        for field in CONTENT_FIELDS
    }
    digest = content_sha256(merged)
    content_changed = digest != stored.get("content_sha256")
    status_changed = body.status is not None and body.status != stored.get("status")
    if status_changed:
        check_transition(stored.get("status"), body.status, AUTHOR_TARGETS)
    if not content_changed and not status_changed:
        raise ApiError(
            409,
            "nothing changed, so the registry stored nothing",
            "no_op_mint",
        )

    note = _note_with_second_actor(body.note, body.second_actor)
    update: dict = {}
    entries: list[dict] = []
    for field in CONTENT_FIELDS:
        if stated.get(field) is None or stated[field] == stored.get(field):
            continue
        entry = set_field(
            update,
            field,
            stated[field],
            Source.MANUAL,
            actor,
            note=note,
            current_doc=stored,
            entity_type="requirement",
            entity_id=req_id,
            field_label=f"requirement.{field}",
        )
        if entry is not None:
            entries.append(entry)
    if status_changed:
        entry = set_field(
            update,
            "status",
            body.status,
            Source.MANUAL,
            actor,
            note=note,
            current_doc=stored,
            entity_type="requirement",
            entity_id=req_id,
            field_label="requirement.status",
        )
        if entry is not None:
            entries.append(entry)
    elif content_changed and stored.get("status") not in AUTHORING_STATUSES:
        # Content moved on a frozen requirement, so review starts again over
        # the new text. A PATCH that states `status` itself decides instead.
        entry = set_field(
            update,
            "status",
            "Draft",
            Source.MANUAL,
            actor,
            note=_note_with_second_actor(
                "Returned to Draft: the content of a frozen requirement changed.",
                body.second_actor,
            ),
            current_doc=stored,
            entity_type="requirement",
            entity_id=req_id,
            field_label="requirement.status",
        )
        if entry is not None:
            entries.append(entry)

    update["content_sha256"] = digest
    update["item_version"] = (stored.get("item_version") or 1) + 1
    fresh_normative = normative_sha256(merged)
    if fresh_normative != stored.get("normative_sha256"):
        update["normative_sha256"] = fresh_normative
        update["normative_changed_at"] = datetime.now(UTC)

    db["requirements"].update_one({"_id": req_id}, {"$set": update})
    if entries:
        db["journal_entries"].insert_many(entries)
    return get_requirement_detail(db, req_id)


def retire_requirement(
    db: Database, req_id: str, body: RequirementRetireRequest, actor: str
) -> dict:
    """POST /requirements/{req_id}/retire. Refuses `stale_parent`, `already_obsolete`.

    The row and its id are kept forever; `successor_id`, when given, is
    prepended to `related_reqs` (authoring-controls spec.md §5).
    """
    stored = _requirement_or_404(db, req_id)
    if body.parent_version != stored.get("item_version"):
        raise ApiError(
            409,
            "this requirement changed since it was opened; reload and reapply the edit",
            "stale_parent",
        )
    if stored.get("status") == "Obsolete":
        raise ApiError(409, f"Requirement {req_id} is already retired", "already_obsolete")

    update: dict = {}
    entries: list[dict] = []
    status_entry = set_field(
        update,
        "status",
        "Obsolete",
        Source.MANUAL,
        actor,
        note=body.note,
        current_doc=stored,
        entity_type="requirement",
        entity_id=req_id,
        field_label="requirement.status",
    )
    if status_entry is not None:
        entries.append(status_entry)

    if body.successor_id:
        related = [body.successor_id, *(stored.get("related_reqs") or [])]
        related_entry = set_field(
            update,
            "related_reqs",
            related,
            Source.MANUAL,
            actor,
            note=body.note,
            current_doc=stored,
            entity_type="requirement",
            entity_id=req_id,
            field_label="requirement.related_reqs",
        )
        if related_entry is not None:
            entries.append(related_entry)
        # `related_reqs` is a CONTENT_FIELDS member: re-hash so `content_sha256`
        # keeps describing the row it is stored on, and a later no-op edit is
        # still judged against the true current content.
        merged = {**stored, **plain_values(update)}
        update["content_sha256"] = content_sha256(merged)

    update["item_version"] = (stored.get("item_version") or 1) + 1
    db["requirements"].update_one({"_id": req_id}, {"$set": update})
    if entries:
        db["journal_entries"].insert_many(entries)
    return get_requirement_detail(db, req_id)
