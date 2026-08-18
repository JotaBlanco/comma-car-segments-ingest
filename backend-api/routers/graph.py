"""The traceability neighbourhood as nodes and edges (spec 2.6).

Serves ``st.graphviz_chart`` directly: the response is already a graph, so the
frontend never walks the relation table itself. Every edge carries the relation id
from spec 2.2 (``R1`` .. ``R18``) so a reader can look up its cardinality, the
field it lives in and the store that holds it.
"""

from fastapi import APIRouter, Depends, HTTPException, Query

import artifact_store
import baseline_service
import deps
import mongo_schema

router = APIRouter(prefix="/graph", tags=["graph"])

ENTITIES = ("requirement", "test_case", "test_implementation", "trace", "test_run")


def _node(node_id: str, kind: str, label: str) -> dict:
    return {"id": node_id, "kind": kind, "label": label}


def _edge(source: str, target: str, relation: str, field: str) -> dict:
    return {"source": source, "target": target, "relation": relation, "field": field}


@router.get("/{entity}/{entity_id}")
def neighbourhood(
    entity: str,
    entity_id: str,
    baseline: str | None = Query(None),
    depth: int = Query(1, ge=1, le=2),
    db=Depends(deps.get_db),
) -> dict:
    """Nodes and edges around one entity, resolved through one baseline."""
    if entity not in ENTITIES:
        raise HTTPException(
            status_code=404, detail=f"unknown entity {entity!r}; known: {list(ENTITIES)}"
        )
    deps.require_blob()

    if entity == "test_run":
        run = db[mongo_schema.TEST_RUNS].find_one({"test_run_id": entity_id})
        if run is None:
            raise HTTPException(status_code=404, detail=f"test run {entity_id} does not exist")
        baseline_id = run["baseline_id"]
    elif baseline:
        baseline_id = baseline
    else:
        available = artifact_store.list_baseline_ids()
        if not available:
            raise HTTPException(status_code=404, detail="no baseline exists yet")
        baseline_id = available[-1]

    bundle = baseline_service.load_bundle(baseline_id)
    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    def add_requirement(req_id: str) -> str:
        node_id = f"req:{req_id}"
        requirement = bundle["requirements"].get(req_id) or {}
        nodes.setdefault(
            node_id, _node(node_id, "requirement", f"{req_id}\n{requirement.get('title', '')}")
        )
        return node_id

    def add_test_case(tc_id: str) -> str:
        node_id = f"tc:{tc_id}"
        test_case = bundle["test_cases"].get(tc_id) or {}
        nodes.setdefault(
            node_id, _node(node_id, "test_case", f"{tc_id}\n{test_case.get('title', '')}")
        )
        return node_id

    def expand_test_case(tc_id: str) -> None:
        tc_node = add_test_case(tc_id)
        test_case = bundle["test_cases"].get(tc_id) or {}
        for req_id in test_case.get("covers_req_ids") or []:
            edges.append(_edge(tc_node, add_requirement(req_id), "R1", "covers_req_ids"))
        impl = bundle["impls"].get(tc_id)
        if impl is not None:
            impl_node = f"impl:{tc_id}"
            nodes.setdefault(
                impl_node,
                _node(impl_node, "test_implementation", f"{tc_id}\n{impl.get('entrypoint')}"),
            )
            edges.append(_edge(tc_node, impl_node, "R3", "impl_ref"))
        for link in db[mongo_schema.RUN_TRACE_LINKS].find({"tc_id": tc_id}):
            trace_node = f"trace:{link['trace_key']}"
            nodes.setdefault(
                trace_node, _node(trace_node, "trace", link["trace_key"])
            )
            edges.append(_edge(tc_node, trace_node, "R5", "run_trace_links"))
            run_node = f"run:{link['test_run_id']}"
            nodes.setdefault(run_node, _node(run_node, "test_run", link["test_run_id"]))
            edges.append(_edge(run_node, trace_node, "R6", "run_trace_links"))

    if entity == "requirement":
        root = add_requirement(entity_id)
        covering = (bundle["baseline"].get("req_links") or {}).get(entity_id) or []
        for tc_id in covering:
            edges.append(_edge(add_test_case(tc_id), root, "R1", "covers_req_ids"))
            if depth > 1:
                expand_test_case(tc_id)
        for related in (bundle["requirements"].get(entity_id) or {}).get("related_reqs") or []:
            edges.append(_edge(root, add_requirement(related), "R18", "related_reqs"))

    elif entity in ("test_case", "test_implementation"):
        expand_test_case(entity_id)

    elif entity == "trace":
        trace_node = f"trace:{entity_id}"
        nodes.setdefault(trace_node, _node(trace_node, "trace", entity_id))
        for link in db[mongo_schema.RUN_TRACE_LINKS].find({"trace_key": entity_id}):
            edges.append(_edge(add_test_case(link["tc_id"]), trace_node, "R5", "run_trace_links"))
            run_node = f"run:{link['test_run_id']}"
            nodes.setdefault(run_node, _node(run_node, "test_run", link["test_run_id"]))
            edges.append(_edge(run_node, trace_node, "R6", "run_trace_links"))
            if depth > 1:
                expand_test_case(link["tc_id"])

    else:  # test_run
        run_node = f"run:{entity_id}"
        nodes.setdefault(run_node, _node(run_node, "test_run", entity_id))
        run = db[mongo_schema.TEST_RUNS].find_one({"test_run_id": entity_id})
        for tc_id in (run or {}).get("scope", {}).get("planned_tc_ids") or []:
            edges.append(_edge(run_node, add_test_case(tc_id), "R4", "scope.planned_tc_ids"))
            if depth > 1:
                expand_test_case(tc_id)

    unique_edges = {
        (edge["source"], edge["target"], edge["relation"]): edge for edge in edges
    }
    return {
        "baseline_id": baseline_id,
        "root": f"{entity}:{entity_id}",
        "depth": depth,
        "nodes": list(nodes.values()),
        "edges": list(unique_edges.values()),
    }
