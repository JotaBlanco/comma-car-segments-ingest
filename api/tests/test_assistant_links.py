# services/assistant_links — the deep-link builder, the only door a URL has
# into an assistant frame. These tests pin the grammar byte-for-byte: key
# order, repeated multi-value keys, closed value sets, and the encoding that
# keeps hostile values inert.

from api.services.assistant_links import build_link

# --- filter screens build the exact expected URL ---


def test_runs_link_carries_every_allowed_key_in_listing_order():
    url = build_link(
        "runs",
        {
            "q": "sensor",
            "signal": "HV_Batt_Cell_Temp_Max",
            "definition": "TD-1",
            "work_order": "WO-2026-0847",
            "project": ["P1"],
            "rig": ["RIG-04"],
            "status": ["awaiting_work_order", "invalid"],
        },
    )
    # The built order is the whitelist order, not the dict order the model used.
    assert url == (
        "/runs?status=awaiting_work_order&status=invalid&rig=RIG-04&project=P1"
        "&work_order=WO-2026-0847&definition=TD-1&signal=HV_Batt_Cell_Temp_Max&q=sensor"
    )


def test_files_link_repeats_multi_value_keys():
    url = build_link(
        "files",
        {"status": ["quarantined"], "source_system": ["TAS", "INCA"], "unlinked": True},
    )
    assert url == "/files?status=quarantined&source_system=TAS&source_system=INCA&unlinked=true"


def test_work_orders_link_encodes_values():
    url = build_link("work-orders", {"status": ["active"], "project": ["P1", "P 2"]})
    assert url == "/work-orders?status=active&project=P1&project=P%202"


def test_signals_link_builds_unit_and_quick_view():
    url = build_link("signals", {"unit": ["°C"], "missing_unit": "true", "q": "temp"})
    assert url == "/signals?unit=%C2%B0C&missing_unit=true&q=temp"


def test_a_filter_screen_with_no_surviving_params_is_the_bare_path():
    assert build_link("runs", {}) == "/runs"
    assert build_link("files", {"unlinked": False}) == "/files"  # only "true" is a value


# --- detail screens ---


def test_detail_links_build_from_the_id():
    assert build_link("run-detail", {"id": "TAS-88214"}) == "/runs/TAS-88214"
    assert build_link("run-lineage", {"id": "TAS-88214"}) == "/runs/TAS-88214/lineage"
    assert build_link("work-order-detail", {"id": "WO-2026-0847"}) == "/work-orders/WO-2026-0847"
    assert build_link("file-detail", {"id": "f-9a41"}) == "/files/f-9a41"
    assert build_link("signal-detail", {"name": "HV_Batt_Cell_Temp_Max"}) == (
        "/signals/HV_Batt_Cell_Temp_Max"
    )


def test_an_empty_or_missing_id_drops_the_link():
    assert build_link("run-detail", {"id": ""}) is None
    assert build_link("run-detail", {"id": "   "}) is None
    assert build_link("run-detail", {}) is None


def test_an_id_cannot_add_path_segments():
    # "/" is encoded, so a hostile id stays one path segment under /runs/.
    assert build_link("run-detail", {"id": "../evil"}) == "/runs/..%2Fevil"


# --- the whitelist drops what it does not know ---


def test_an_unknown_screen_is_dropped():
    assert build_link("admin", {"q": "x"}) is None
    assert build_link("", {}) is None


def test_unknown_keys_and_disallowed_values_are_dropped():
    assert build_link("runs", {"nope": "1", "q": "x"}) == "/runs?q=x"
    assert build_link("runs", {"status": ["bogus", "complete"]}) == "/runs?status=complete"
    assert build_link("files", {"source_system": ["evil"], "q": "x"}) == "/files?q=x"


def test_a_single_value_key_keeps_its_first_value_only():
    assert build_link("runs", {"work_order": ["WO-1", "WO-2"]}) == "/runs?work_order=WO-1"


# --- hostile values stay inert, encoded query VALUES ---


def test_hostile_characters_are_url_encoded():
    assert build_link("runs", {"q": 'a b&c"d'}) == "/runs?q=a%20b%26c%22d"


def test_a_javascript_scheme_stays_an_inert_encoded_value():
    url = build_link("runs", {"q": "javascript:alert(1)"})
    assert url == "/runs?q=javascript%3Aalert%281%29"
    assert url.startswith("/")
    assert ":" not in url  # the scheme separator never survives encoding


def test_an_external_url_as_a_value_never_becomes_a_host():
    url = build_link("files", {"q": "http://evil.example/x"})
    assert url == "/files?q=http%3A%2F%2Fevil.example%2Fx"
    assert "http://" not in url
