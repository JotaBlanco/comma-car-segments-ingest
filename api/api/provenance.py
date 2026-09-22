"""Provenance helpers. The signatures are frozen from the base onward.

Every source tag, every journal line and every write precedence decision lives
here. No route writes a journal entry or a source tag by hand.

Write precedence is `manual` > `api:*` > `embedded` (BE-PLAN §3.1). A write
ranked below the stored value is skipped in silence: no value, no source entry,
no journal line. An equal-ranked write passes, because a person may correct a
person, and a second sync may correct the first.

The pre-A-01 call shape still works. Without `current_doc` there is no stored
state to compare, so the write passes and the old value comes from the update
dict, as it did before.

## The actor id

A journal row stores the actor name, and a name is not a person. A person
renames a Portal profile, and two people can share one display name. So a row
written by a proven caller also stores `actor_id`, the Portal `userId`, which
never changes.

The id rides on the actor string itself. `auth.journal_actor` returns a
`VerifiedActor`, a `str` that holds the id, so no route and no service
signature changed. `actor_id` reads it back here.

The key is optional and it stays out of the row when no platform proved the
caller. That covers the demo path, the service actors like `ingestion`, and
every row written before this field existed.

The response model reads the absent key as null, so the wire always carries
`actor_id`. Contract §A "Journal entry": null means the platform proved
nobody, and the server never backfills an old row.
"""

import uuid
from datetime import UTC, datetime

from api.models.common import Source
from api.models.journal import EMPTY

# Higher wins. A write with a lower rank than the stored value is skipped.
_RANK: dict[str, int] = {
    Source.EMBEDDED.value: 0,
    Source.API_PLANNING.value: 1,
    Source.API_CONFIG.value: 1,
    Source.API_CATALOGUE.value: 1,
    Source.API_POST_PROCESSING.value: 1,
    Source.MANUAL.value: 2,
}

# An actor names a person or a service. These strings name nobody.
_PLACEHOLDER_ACTORS = frozenset(
    # "quix user" is the portal client's last-resort display name, so a browser
    # sends it without anybody typing it.
    {"current-user", "unknown", "system", "null", "none", "user", "quix user"}
)


def _now() -> datetime:
    return datetime.now(UTC)


def _check_actor(actor: str) -> str:
    """Reject an actor that names nobody. Guard test 5."""
    cleaned = (actor or "").strip()
    if not cleaned or cleaned.lower() in _PLACEHOLDER_ACTORS:
        raise ValueError(f"actor must name a person or a service, got {actor!r}")
    return cleaned


def actor_id(actor) -> str | None:
    """Read the stable Portal user id an actor carries. Return None when none.

    `auth.journal_actor` returns a `VerifiedActor`, which is a string that
    holds the id. Every other caller passes a plain string: a service name, or
    the body actor on the demo path. Those name nobody the platform proved, so
    they carry no id and the row keeps only the name.

    Call this **before** you clean the actor. `str.strip()` returns a plain
    `str` and drops the id.
    """
    value = getattr(actor, "actor_id", None)
    return value if isinstance(value, str) and value else None


def _stamp(row: dict, identifier: str | None) -> dict:
    """Add the actor id to a row we write. Leave the row alone when none.

    The key is absent, never null, when the platform proved no person. Every
    row written before this field existed is absent in the same way, so a
    reader has one case to handle and no old row needs a backfill.
    """
    if identifier is not None:
        row["actor_id"] = identifier
    return row


def _display(value) -> str:
    """Render one journal side. An absent value reads as the empty marker."""
    return EMPTY if value is None else str(value)


def blocks(stored_source: str | None, incoming: Source) -> bool:
    """Report whether a stored source outranks an incoming write."""
    if stored_source is None:
        return False
    return _RANK.get(incoming.value, 0) < _RANK.get(stored_source, 0)


# Every entity that carries a `field_sources` map. TR-011 filters and counts
# over these four collections and no other.
TAGGED_COLLECTIONS = ("test_runs", "files", "signals", "work_orders")

# The map read as an array, so an aggregation can search it. `field_sources`
# keys the field name, and no index reads a map key, so every query over the
# tags starts here.
_TAGS_AS_ARRAY = {"$objectToArray": {"$ifNull": ["$field_sources", {}]}}


def source_clause(sources: list[str] | None) -> dict | None:
    """A Mongo clause matching a document tagged with any of ``sources``.

    Returns ``None`` when the caller named no source, so the route adds no
    clause and the list stays whole. A blank value is nothing and drops out.

    A document with no ``field_sources`` map matches nothing. That is the
    truth and not a gap: the server recorded no source for that document, so
    no source filter may claim it.
    """
    wanted = [str(value).strip() for value in (sources or []) if str(value).strip()]
    if not wanted:
        return None
    return {
        "$expr": {
            "$gt": [
                {
                    "$size": {
                        "$setIntersection": [
                            wanted,
                            {"$map": {"input": _TAGS_AS_ARRAY, "in": "$$this.v.source"}},
                        ]
                    }
                },
                0,
            ]
        }
    }


def mirror_tags(fields, source: Source, actor: str, at: datetime) -> dict:
    """`field_sources.<field>` entries for a row a mirror owns wholesale.

    A mirror replaces every field it names on every pass, so no precedence
    check applies and no journal line belongs here — `_mirror_journal` writes
    those. The tag is what makes the row answer a source filter and count in a
    source statistic (TR-011). A mirror carried none until 24 Aug 2026.
    """
    return {
        f"field_sources.{field}": {"source": source.value, "actor": actor, "at": at}
        for field in fields
    }


def count_fields_by_source(db, collections=TAGGED_COLLECTIONS) -> dict[str, int]:
    """Count the tagged metadata fields of each source, over the collections.

    One field of one document counts once. The answer therefore states how
    much of the registry each system and each person wrote, which is the
    aggregate TR-011 asks for.

    A source the enum does not name still counts, because an old document may
    carry a tag this build never writes. The caller decides what to show.
    """
    totals: dict[str, int] = {}
    pipeline = [
        {"$project": {"tags": _TAGS_AS_ARRAY}},
        {"$unwind": "$tags"},
        {"$group": {"_id": "$tags.v.source", "count": {"$sum": 1}}},
    ]
    for name in collections:
        for row in db[name].aggregate(pipeline):
            key = row["_id"]
            if isinstance(key, str):
                totals[key] = totals.get(key, 0) + row["count"]
    return totals


def stored_source(current_doc: dict | None, field: str) -> str | None:
    """Read the source tag a document carries for one field."""
    if not current_doc:
        return None
    sources = current_doc.get("field_sources") or {}
    entry = sources.get(field)
    if entry is None and "." in field:
        # A dotted field (a result's provenance.*) lands NESTED under
        # field_sources — `$set {"field_sources.provenance.tool": …}` nests,
        # it does not write a literal dotted key — so the read walks the path
        # the write produced (25 Aug 2026 deep review, finding 5).
        node = sources
        for part in field.split("."):
            node = node.get(part) if isinstance(node, dict) else None
            if node is None:
                break
        entry = node
    if not entry:
        return None
    source = entry.get("source") if isinstance(entry, dict) else None
    return source if isinstance(source, str) else None


def set_field(
    doc_update: dict,
    field: str,
    value,
    source: Source,
    actor: str,
    note: str | None = None,
    context_run_id: str | None = None,
    current_doc: dict | None = None,
    entity_type: str = "run",
    entity_id: str | None = None,
    field_label: str | None = None,
) -> dict | None:
    """Add one field write to a $set dict and return its journal entry.

    Returns ``None`` when precedence blocks the write. The caller then writes
    nothing: ``doc_update`` is untouched and no journal entry exists.

    ``current_doc`` is the stored document. Pass it to get the precedence check
    and a truthful old value. ``entity_type``, ``entity_id`` and ``field_label``
    let a caller journal against a signal or a file instead of a run.

    A field write happens on the server, so ``at`` and ``received_at`` carry the
    same moment here. They differ only where a caller states its own ``at``.
    """
    # Read the id first. `_check_actor` strips the name and returns a plain
    # `str`, which no longer carries it.
    identifier = actor_id(actor)
    actor = _check_actor(actor)

    if blocks(stored_source(current_doc, field), source):
        return None

    old_value = current_doc.get(field) if current_doc is not None else doc_update.get(field)
    at = _now()

    doc_update[field] = value
    doc_update[f"field_sources.{field}"] = _stamp(
        {"source": source.value, "actor": actor, "at": at}, identifier
    )

    return _stamp(
        {
            "_id": f"j-{uuid.uuid4()}",
            "entity_type": entity_type,
            "entity_id": entity_id
            or doc_update.get("_id")
            or (current_doc or {}).get("_id")
            or "",
            "field": field_label or field,
            "kind": "change",
            "old": _display(old_value),
            "new": _display(value),
            "source": source.value,
            "actor": actor,
            "note": note,
            "context_run_id": context_run_id,
            "at": at,
            "received_at": at,
        },
        identifier,
    )


def plain_values(update: dict) -> dict:
    """The value writes of a $set dict, without the source-map entries."""
    return {key: value for key, value in update.items() if not key.startswith("field_sources.")}


def sources(update: dict) -> dict:
    """The source-map entries of a $set dict, keyed by field name."""
    return {
        key.removeprefix("field_sources."): value
        for key, value in update.items()
        if key.startswith("field_sources.")
    }


def derive_status(doc: dict) -> str:
    """Derive a run status. Rule: invalid > awaiting_work_order > complete."""
    if (doc.get("invalid") or {}).get("flagged"):
        return "invalid"
    if doc.get("work_order_id") is None:
        return "awaiting_work_order"
    return "complete"


def add_event(
    entity_type: str,
    entity_id: str,
    field: str,
    source: Source,
    actor: str,
    note: str | None = None,
    at: datetime | None = None,
) -> dict:
    """Build one journal event document.

    ``at`` lets the caller state the moment the step happened. ``None`` keeps
    the clock stamp, so every older call site behaves as before.

    ``received_at`` is the server clock at the moment the entry arrives. The
    caller never sets it. A reader compares the two stamps and sees a caller
    date that lies. ``at`` stays the sort key.
    """
    received_at = _now()
    # Read the id before the name is cleaned. See `actor_id`.
    identifier = actor_id(actor)
    return _stamp(
        {
            "_id": f"j-{uuid.uuid4()}",
            "entity_type": entity_type,
            "entity_id": entity_id,
            "field": field,
            "kind": "event",
            "old": None,
            "new": None,
            "source": source.value,
            "actor": _check_actor(actor),
            "note": note,
            "context_run_id": None,
            "at": received_at if at is None else at,
            "received_at": received_at,
        },
        identifier,
    )
