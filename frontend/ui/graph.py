"""The traceability neighbourhood as a Graphviz chart (spec 1.0, 2.6).

``GET /graph/{entity}/{id}`` already returns nodes and edges with the relation id
from spec 2.2 on every edge, so this module only turns that into DOT. The frontend
never walks the relation table itself, and no client-side join happens here either.

``st.graphviz_chart`` renders a DOT *string* in the browser, so no Graphviz binary
and no extra Python dependency are involved.
"""

import streamlit as st

import api_client
from ui import errors

KIND_SHAPES = {
    "requirement": "box",
    "test_case": "ellipse",
    "test_implementation": "component",
    "trace": "note",
    "test_run": "folder",
}


def to_dot(payload: dict) -> str:
    """Nodes and edges to DOT, with the relation id printed on every edge."""
    lines = [
        "digraph traceability {",
        "  rankdir=LR;",
        '  node [fontname="sans-serif", fontsize=10];',
        '  edge [fontname="sans-serif", fontsize=8];',
    ]
    for node in payload.get("nodes") or []:
        label = str(node.get("label") or node.get("id")).replace('"', "'").replace("\n", "\\n")
        shape = KIND_SHAPES.get(str(node.get("kind")), "box")
        lines.append(f'  "{node.get("id")}" [label="{label}", shape={shape}];')
    for edge in payload.get("edges") or []:
        lines.append(
            f'  "{edge.get("source")}" -> "{edge.get("target")}" '
            f'[label="{edge.get("relation")}"];'
        )
    lines.append("}")
    return "\n".join(lines)


def render(entity: str, entity_id: str, baseline: str | None, key: str) -> None:
    """One expander holding the neighbourhood of one entity."""
    with st.expander("Traceability neighbourhood"):
        depth = st.slider("Depth", min_value=1, max_value=2, value=1, key=f"graph_depth_{key}")
        payload, ok = errors.guarded(
            lambda: api_client.graph_neighbourhood(
                entity, entity_id, baseline=baseline, depth=int(depth)
            ),
            f"load the traceability graph of {entity_id}",
        )
        if not ok:
            return
        st.graphviz_chart(to_dot(payload), use_container_width=True)
        st.caption(
            "Edge labels are the relation ids of spec 2.2: R1 covers_req_ids, "
            "R3 impl_ref, R4 planned_tc_ids, R5/R6 run_trace_links, R18 related_reqs."
        )
