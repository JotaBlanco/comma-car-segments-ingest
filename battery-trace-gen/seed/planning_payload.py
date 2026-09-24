"""Build the `POST /planning/sync` body: one work order, ten definitions, four links.

The registry's inbound push (`api/api/models/planning.py`,
`PlanningPushRequest`) takes three lists. This module fills them from the seed's
inputs and nothing else, so a re-run against unchanged inputs produces a
byte-identical body and the push answers `links_unchanged`.

**The work order also lands in Dynamic Configuration**, as a side effect of the
registry's mirror write (`api/api/planning_sync._mirror_work_orders` ->
`config_push.push_work_orders`). The seed therefore makes no second push: a
competing writer on the same `(type, target_key)` pair would desynchronise the
version counter there.

`project` is the programme name a person reads on the work-order list. It is NOT
the platform: the platform is `Porsche_Taycan`, stated by every trace's own MF4
header (`bus/mf4.py`, `<common_properties>/platform`), and that is what the lake
partitions on. The sink falls back to this `project` only for a file whose header
names no platform — ours all do, so no partition directory carries this value.
"""

from __future__ import annotations

from seed import requirements_md, sources

WORK_ORDER_ID = "WO-BAT-2026-001"
WORK_ORDER_TITLE = "Battery DC system qualification — BATTERY_DC_V1"
WORK_ORDER_PROJECT = "Porsche Taycan"
WORK_ORDER_STATUS = "active"
WORK_ORDER_REQUESTOR = "ludvik@quix.io"
WORK_ORDER_DEPARTMENT = "Battery Systems Validation"
WORK_ORDER_PRIORITY = "High"
WORK_ORDER_CREATED_AT = "2026-09-23T08:00:00Z"

#: Every definition is exercised by one trace. The manifest declares the split.
PLANNED_RUNS = 1


def work_orders() -> list[dict]:
    return [
        {
            "id": WORK_ORDER_ID,
            "title": WORK_ORDER_TITLE,
            "project": WORK_ORDER_PROJECT,
            "status": WORK_ORDER_STATUS,
            "requestor": WORK_ORDER_REQUESTOR,
            "department": WORK_ORDER_DEPARTMENT,
            "priority": WORK_ORDER_PRIORITY,
            "created_at": WORK_ORDER_CREATED_AT,
        }
    ]


def test_definitions() -> list[dict]:
    """One definition per test case, each carrying its rendered requirements doc.

    The definition id IS the test case id. `CLAUDE.md` makes bidirectional
    traceability the audited property — `covers_req_ids`, authored here, against
    the requirement's `verified_by`, derived by the Test Manager from it — and
    both already name `BAT-SYS-TC-NNN`, so a third id form would put an
    unaudited indirection in the middle of the chain.
    """
    specs = sources.test_specs()
    documents = requirements_md.render_all()
    return [
        {
            "id": tc_id,
            "work_order_id": WORK_ORDER_ID,
            "title": specs[tc_id]["title"],
            "planned_runs": PLANNED_RUNS,
            "requirements_files": [
                {"name": f"{tc_id}.md", "content": documents[tc_id]}
            ],
            "covers_req_ids": specs[tc_id]["covers_req_ids"],
        }
        for tc_id in sorted(specs)
    ]


def requirements() -> list[dict]:
    """The ten requirements, each carrying `text_rendered` beside `text`.

    `verified_by` is not sent (BL-17 / BP5 / defect D1): the reverse link is
    derived by the Test Manager from `test_definitions()[*].covers_req_ids`,
    never authored here.
    """
    parameters = sources.parameters()
    items = sources.requirements()
    return [
        {
            "id": item["id"],
            "title": item["title"],
            "text": item["text"],
            "text_rendered": requirements_md.resolve_display(item["text"], parameters),
            "status": item["status"],
            "system": item["system"],
            "chapter": item["chapter"],
            "ears_pattern": item["ears_pattern"],
            "revision": item["revision"],
            "measurand": item["measurand"],
            "system_states": item["system_states"],
            "verification_method": item["verification_method"],
            "verification_criteria": item.get("verification_criteria"),
            "rationale": item["rationale"],
            "source": item["source"],
            "related_reqs": item["related_reqs"],
            "figure_refs": item["figure_refs"],
        }
        for item in sorted(items.values(), key=lambda item: item["id"])
    ]


def links() -> list[dict]:
    """One link per run, naming its work order and no definition.

    `PushedLink.definition_id` is optional (`api/api/models/planning.py`), and
    the link omitting it writes `work_order_id` alone — which is all
    `derive_status` needs for the run to read `complete`. The definitions of a
    run are assigned by a person on the Test Run page, so planning states none.
    """
    return [
        {"run_id": trace["run_key"], "work_order_id": WORK_ORDER_ID}
        for trace in sources.traces()
    ]


def catalog_body() -> dict:
    """Step 2 of the seed: the catalog alone, before any trace has been uploaded.

    `requirements` rides first, so a definition naming one in `covers_req_ids`
    lands after its target exists (`planning_sync.apply_planning_push` mirrors
    in that order too).
    """
    return {
        "requirements": requirements(),
        "work_orders": work_orders(),
        "test_definitions": test_definitions(),
        "links": [],
    }


def full_body() -> dict:
    """Step 5 of the seed: the same catalog, plus the run->work-order links."""
    return {**catalog_body(), "links": links()}
