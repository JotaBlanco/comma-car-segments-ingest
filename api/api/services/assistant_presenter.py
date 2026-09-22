"""The registry assistant's presenter: `present_answer` proposals in, frames out.

This module is the TRUST BOUNDARY, stated once: the model ROUTES, it never
AUTHORS record content. When the agent ends a turn by calling
``present_answer``, the chat proxy hands that call's arguments here, and
every card (``hits``), chain node and deep link in the resulting frames is
hydrated server-side from the db and the link whitelist. A model-proposed id
that does not exist is dropped, and the model's own words only ever travel
in ``answer_delta`` text, which the FE never linkifies.

The hydrators and the frame composer moved here verbatim from the deleted
``assistant_ai.py`` loop (AI-SIDEBAR §10, ticket U-4): the mechanism around
them changed — Quix.AI sessions instead of a bespoke Anthropic loop — but
the trust design survives unchanged. ``present`` is a pure function of
``(db, args)``: no I/O beyond Mongo reads, frames out in reading order.
"""

from datetime import UTC, datetime

from pymongo.database import Database

from api.errors import ApiError
from api.services import assistant_links
from api.services.queries_runs import get_run, run_lineage

# Final text is chunked so the panel renders progressively even when the
# whole answer arrives in one tool call.
_ANSWER_CHUNK_CHARS = 200

_MAX_HITS = 8

# What the deeplink frame's label says per screen. Authored here, never by
# the model — a model-authored label on a clickable element is a steered link.
_LINK_LABELS = {
    "runs": "Open runs",
    "files": "Open files",
    "work-orders": "Open work orders",
    "signals": "Open signals",
    "run-detail": "Open run",
    "run-lineage": "Open run lineage",
    "work-order-detail": "Open work order",
    "file-detail": "Open file",
    "signal-detail": "Open signal",
}


def _iso(value) -> str | None:
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _delta_frames(text: str) -> list[dict]:
    return [
        {"type": "answer_delta", "text": text[i : i + _ANSWER_CHUNK_CHARS]}
        for i in range(0, len(text), _ANSWER_CHUNK_CHARS)
    ]


def _journal_reason(db: Database, run_id: str, journal_id: str) -> dict | None:
    """Quote a journal entry's stored text — only if it belongs to this run."""
    entry = db["journal_entries"].find_one({"_id": journal_id})
    if entry is None:
        return None
    belongs = (
        entry.get("entity_type") == "run" and entry.get("entity_id") == run_id
    ) or entry.get("context_run_id") == run_id
    if not belongs or not entry.get("note"):
        return None
    return {
        "text": entry["note"],
        "actor": entry.get("actor"),
        "at": _iso(entry.get("at")),
        "journal_id": entry["_id"],
    }


def _invalid_reason(db: Database, run: dict) -> dict | None:
    """Quote the run's stored invalid block, with its journal line when found."""
    invalid = run.get("invalid") or {}
    if not invalid.get("flagged") or not invalid.get("reason"):
        return None
    entry = db["journal_entries"].find_one(
        {"entity_type": "run", "entity_id": run["_id"],
         "field": "run.invalid_flag", "new": "true"},
        sort=[("at", -1)],
    )
    return {
        "text": invalid["reason"],
        "actor": invalid.get("actor"),
        "at": _iso(invalid.get("at")),
        "journal_id": entry["_id"] if entry else None,
    }


def _hydrate_hit(db: Database, proposal: dict) -> dict | None:
    """Rebuild one hit card from the registry. No stored run, no card.

    Every field comes from the db document; the model's proposal contributes
    only the ids. The quoted reason follows the same rule: a journal_id is
    verified to belong to the run and its STORED text is used, else the run's
    own invalid block speaks, else there is no reason line.
    """
    run_id = str(proposal.get("run_id") or "").strip()
    if not run_id:
        return None
    try:
        run = get_run(db, run_id)
    except ApiError:
        return None

    reason = None
    journal_id = proposal.get("journal_id")
    if journal_id:
        reason = _journal_reason(db, run_id, str(journal_id))
    if reason is None:
        reason = _invalid_reason(db, run)

    return {
        "entity": "run",
        "run_id": run["_id"],
        "status": run.get("status"),
        "rig_id": run.get("rig_id"),
        "project": run.get("project"),
        "first_data_at": _iso(run.get("first_data_at")),
        "url": assistant_links.build_link("run-detail", {"id": run["_id"]}),
        "reason": reason,
    }


def _chain_nodes(db: Database, run_id: str) -> list[dict] | None:
    """Turn a run's lineage into chain nodes with real ids and detail urls."""
    try:
        chain = run_lineage(db, run_id)
    except ApiError:
        return None

    nodes: list[dict] = []
    work_order = chain.get("work_order")
    if work_order:
        nodes.append({
            "kind": "work_order",
            "id": work_order["wo_id"],
            "label": work_order.get("title") or work_order["wo_id"],
            "url": assistant_links.build_link("work-order-detail", {"id": work_order["wo_id"]}),
        })
    definition = chain.get("definition")
    if definition:
        # No definition screen exists yet, so the node carries no url.
        nodes.append({
            "kind": "definition",
            "id": definition["td_id"],
            "label": definition.get("title") or definition["td_id"],
            "url": None,
        })
    run = chain["run"]
    nodes.append({
        "kind": "run",
        "id": run["run_id"],
        "label": run["run_id"],
        "url": assistant_links.build_link("run-detail", {"id": run["run_id"]}),
    })
    files = chain.get("files") or []
    if files:
        nodes.append({
            "kind": "files",
            "id": run["run_id"],
            "label": f"{len(files)} file(s)",
            "url": assistant_links.build_link("files", {"run": run["run_id"]}),
        })
    results = chain.get("results") or []
    if results:
        nodes.append({
            "kind": "results",
            "id": run["run_id"],
            "label": f"{len(results)} result(s)",
            "url": None,
        })
    return nodes


def present(db: Database, args: dict) -> list[dict]:
    """Compose the closing frames of a turn from a ``present_answer`` call.

    Frame order is fixed: answer_delta*, hits?, chain?, deeplink? — the FE
    renders in arrival order and this is the reading order. ``done`` is not
    ours to emit: the sessions stream closes itself.

    The MCP tool schema names the proposal fields ``hit_refs`` and
    ``link_spec`` (AI-SIDEBAR §10); the earlier loop's ``hits``/``link``
    spellings are accepted as aliases, so a schema drift between the agent
    and this presenter costs nothing — a proposal under either name still
    hydrates, and everything else is dropped as always.
    """
    if not isinstance(args, dict):
        args = {}
    frames = _delta_frames(str(args.get("text") or ""))

    proposals = args.get("hit_refs")
    if not isinstance(proposals, list):
        proposals = args.get("hits")
    if isinstance(proposals, list):
        hits = []
        for item in proposals[:_MAX_HITS]:
            if isinstance(item, dict):
                card = _hydrate_hit(db, item)
                if card is not None:
                    hits.append(card)
        if hits:
            frames.append({"type": "hits", "hits": hits})

    chain_run_id = args.get("chain_run_id")
    if chain_run_id:
        nodes = _chain_nodes(db, str(chain_run_id))
        if nodes:
            frames.append({"type": "chain", "nodes": nodes})

    link = args.get("link_spec")
    if not isinstance(link, dict):
        link = args.get("link")
    if isinstance(link, dict):
        url = assistant_links.build_link(
            str(link.get("screen") or ""), link.get("params") or {}
        )
        if url is not None:
            label = _LINK_LABELS.get(str(link.get("screen")), "Open in the app")
            frames.append({"type": "deeplink", "label": label, "url": url})

    return frames
