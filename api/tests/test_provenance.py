"""A-01 — the provenance helper: write precedence, status, journal conventions.

Precedence: manual > api:* > embedded (BE-PLAN §3.1). A lower-ranked write over
a higher-ranked stored value is skipped in silence: no value, no source entry,
no journal line. An equal-ranked write passes, because a person may correct a
person.
"""

import pytest

from api.models.common import Source
from api.models.journal import EMPTY
from api.provenance import derive_status, set_field

ACTOR = "a.bergstrom"


def _stored(field: str, source: Source, value: str = "old-value") -> dict:
    """A stored document whose one field carries the given source."""
    return {
        "_id": "TAS-88214",
        field: value,
        "field_sources": {field: {"source": source.value, "actor": "someone", "at": None}},
    }


# --- the precedence table ---------------------------------------------------


@pytest.mark.parametrize(
    ("stored", "incoming"),
    [
        (Source.MANUAL, Source.API_PLANNING),
        (Source.MANUAL, Source.API_CONFIG),
        (Source.MANUAL, Source.EMBEDDED),
        (Source.API_PLANNING, Source.EMBEDDED),
        (Source.API_CATALOGUE, Source.EMBEDDED),
    ],
)
def test_a_lower_ranked_write_is_blocked(stored: Source, incoming: Source) -> None:
    update: dict = {}
    entry = set_field(
        update, "operator", "new-value", incoming, ACTOR, current_doc=_stored("operator", stored)
    )

    assert entry is None, "a blocked write returns no journal entry"
    assert update == {}, "a blocked write touches neither the value nor the source map"


@pytest.mark.parametrize(
    ("stored", "incoming"),
    [
        (Source.EMBEDDED, Source.MANUAL),
        (Source.EMBEDDED, Source.API_PLANNING),
        (Source.API_PLANNING, Source.MANUAL),
        (Source.MANUAL, Source.MANUAL),
        (Source.EMBEDDED, Source.EMBEDDED),
        (Source.API_PLANNING, Source.API_CATALOGUE),
    ],
)
def test_an_equal_or_higher_ranked_write_passes(stored: Source, incoming: Source) -> None:
    update: dict = {}
    entry = set_field(
        update, "operator", "new-value", incoming, ACTOR, current_doc=_stored("operator", stored)
    )

    assert entry is not None
    assert update["operator"] == "new-value"
    assert update["field_sources.operator"]["source"] == incoming.value


def test_a_field_with_no_stored_source_accepts_any_write() -> None:
    """A first write has nothing to lose to. Every source may take it."""
    update: dict = {}
    entry = set_field(
        update, "operator", "first", Source.EMBEDDED, ACTOR, current_doc={"_id": "TAS-88214"}
    )

    assert entry is not None
    assert update["operator"] == "first"


def test_without_a_stored_document_the_write_passes() -> None:
    """The pre-A-01 call shape still works: no stored doc, no precedence check."""
    update: dict = {}
    entry = set_field(update, "operator", "value", Source.EMBEDDED, ACTOR)

    assert entry is not None
    assert update["operator"] == "value"


# --- journal conventions ----------------------------------------------------


def test_the_old_value_comes_from_the_stored_document() -> None:
    """The caller no longer seeds the update dict to get a truthful old value."""
    update: dict = {}
    entry = set_field(
        update,
        "operator",
        "A. Bergström",
        Source.MANUAL,
        ACTOR,
        current_doc=_stored("operator", Source.EMBEDDED, value="unknown"),
    )

    assert entry["old"] == "unknown"
    assert entry["new"] == "A. Bergström"


def test_an_absent_stored_value_reads_as_the_empty_marker() -> None:
    update: dict = {}
    entry = set_field(
        update, "work_order_id", "WO-2026-0851", Source.API_PLANNING, "planning-sync",
        current_doc={"_id": "TAS-88214"},
    )

    assert entry["old"] == EMPTY
    assert entry["field"] == "work_order_id"


def test_the_entry_can_name_another_entity_and_a_display_path() -> None:
    """A signal edit names its own entity — the caller stops patching the entry."""
    update: dict = {}
    entry = set_field(
        update,
        "unit",
        "°C",
        Source.MANUAL,
        ACTOR,
        entity_type="signal",
        entity_id="Coolant_Inlet_Temp",
        field_label="signal.Coolant_Inlet_Temp.unit",
        context_run_id="TAS-88214",
    )

    assert entry["entity_type"] == "signal"
    assert entry["entity_id"] == "Coolant_Inlet_Temp"
    assert entry["field"] == "signal.Coolant_Inlet_Temp.unit"
    assert entry["context_run_id"] == "TAS-88214"


def test_the_entry_defaults_to_the_run_of_the_update() -> None:
    update = {"_id": "TAS-88214"}
    entry = set_field(update, "operator", "value", Source.MANUAL, ACTOR)

    assert entry["entity_type"] == "run"
    assert entry["entity_id"] == "TAS-88214"
    assert entry["kind"] == "change"


def test_actor_never_placeholder() -> None:
    """Guard test 5. The journal actor is a real string, never a placeholder."""
    forbidden = {"current-user", "unknown", "system", "", "null", "none", "user"}

    entry = set_field({}, "operator", "value", Source.MANUAL, ACTOR)
    assert entry["actor"] == ACTOR
    assert entry["actor"].strip().lower() not in forbidden

    for empty in ("", "   "):
        with pytest.raises(ValueError, match="actor"):
            set_field({}, "operator", "value", Source.MANUAL, empty)


# The literal list is the oracle. Reading the set from the code under test
# would let an emptied set pass with zero test cases.
PLACEHOLDERS = ("current-user", "unknown", "system", "null", "none", "user", "quix user")


@pytest.mark.parametrize("placeholder", PLACEHOLDERS)
def test_each_placeholder_actor_is_rejected(placeholder: str) -> None:
    """Guard test 5, one case per placeholder the plan names."""
    with pytest.raises(ValueError, match="actor"):
        set_field({}, "operator", "value", Source.MANUAL, placeholder)


def test_the_helper_and_the_model_agree_on_the_placeholders() -> None:
    """Two frozen copies exist on purpose. Drift between them must fail here."""
    from api.models.journal import PLACEHOLDER_ACTORS
    from api.provenance import _PLACEHOLDER_ACTORS

    assert set(_PLACEHOLDER_ACTORS) == set(PLACEHOLDERS)
    assert set(PLACEHOLDER_ACTORS) == set(PLACEHOLDERS)


# --- derive_status ----------------------------------------------------------


def test_derive_status_covers_the_three_states() -> None:
    complete = {"work_order_id": "WO-2026-0847", "invalid": {"flagged": False}}
    awaiting = {"work_order_id": None, "invalid": {"flagged": False}}
    invalid = {"work_order_id": "WO-2026-0847", "invalid": {"flagged": True}}

    assert derive_status(complete) == "complete"
    assert derive_status(awaiting) == "awaiting_work_order"
    assert derive_status(invalid) == "invalid"


def test_invalid_outranks_awaiting_work_order() -> None:
    """The rule is ordered: invalid > awaiting_work_order > complete."""
    both = {"work_order_id": None, "invalid": {"flagged": True}}

    assert derive_status(both) == "invalid"


def test_a_run_without_an_invalid_block_is_not_invalid() -> None:
    assert derive_status({"work_order_id": "WO-2026-0847"}) == "complete"
