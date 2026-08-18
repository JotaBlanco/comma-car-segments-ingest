"""The acceptance test of spec 1.1.2, against the real 37-requirement export.

``converged: false`` is a release blocker, and in round 1 this could not even be
computed: the ReqIF path rejected the fixture outright (see
``test_xhtml_subset.py``). Both fixtures are vendored so this test is hermetic -
it does not reach into the ``acc_project`` repo, and ``.gitattributes`` marks them
``-text`` so no EOL rewrite can change a hash under it.

``acc-system-requirements.canonical.json`` is a rendering of the CSV register
(``Reqs/data/acc_system_requirements.csv``), a *sibling* generated artifact of the
ReqIF export rather than something derived from it, and it keeps the register's
authoring order for ``system_states`` on purpose: that is what makes the N6 ordinal
sort load-bearing here instead of decorative.
"""

from pathlib import Path

import canonical
import convergence
import upload_service

FIXTURES = Path(__file__).resolve().parent / "fixtures"
REQIF = FIXTURES / "acc-system-requirements.reqif"
JSON = FIXTURES / "acc-system-requirements.canonical.json"
EXPECTED_ITEMS = 37


def _compare() -> dict:
    return convergence.compare(
        REQIF.name, REQIF.read_bytes(), JSON.name, JSON.read_bytes()
    )


def _items(path: Path) -> dict[str, dict]:
    items, _, _, _ = upload_service.canonical_requirements(path.name, path.read_bytes())
    return {item["id"]: item for item in items}


def test_the_real_export_converges_with_its_canonical_json():
    result = _compare()
    assert result["reqif"]["item_count"] == EXPECTED_ITEMS
    assert result["json"]["item_count"] == EXPECTED_ITEMS
    assert result["only_in_reqif"] == []
    assert result["only_in_json"] == []
    assert result["assertions"]["per_item_hashes_equal"], result["mismatch_detail"]
    assert result["assertions"]["set_hash_equal"]
    assert result["assertions"]["stored_bytes_equal"]
    assert result["converged"] is True


def test_the_flattened_xhtml_matches_the_json_path_character_for_character():
    """Amended N1's whole justification, asserted field by field so a failure names it."""
    left = _items(REQIF)
    right = _items(JSON)
    assert sorted(left) == sorted(right)
    for req_id in sorted(right):
        assert left[req_id]["text"] == right[req_id]["text"], req_id
        assert left[req_id]["rationale"] == right[req_id]["rationale"], req_id


def test_no_markup_survives_into_a_canonical_value():
    """Flattening must produce text, not tag soup."""
    for req_id, item in _items(REQIF).items():
        for field in ("text", "rationale"):
            assert "<" not in item[field], f"{req_id}.{field} still carries markup"
            assert ">" not in item[field], f"{req_id}.{field} still carries markup"
            assert item[field] == item[field].strip()
            assert item[field], f"{req_id}.{field} flattened to nothing"


def test_the_two_paths_agree_on_every_canonical_field():
    """Broader than the hash assertion, and it names the field when it fails."""
    left = _items(REQIF)
    right = _items(JSON)
    for req_id in sorted(right):
        for field in sorted(set(left[req_id]) | set(right[req_id])):
            assert left[req_id].get(field) == right[req_id].get(field), f"{req_id}.{field}"


def test_the_stored_form_is_stable_across_a_reparse():
    """Both stored documents are a deterministic function of the same items."""
    result = _compare()
    left = _items(REQIF)
    stored = canonical.stored_bytes({"items": [left[key] for key in sorted(left)]})
    assert stored.endswith(b"\n")
    assert result["reqif"]["stored_bytes"] == len(stored)
