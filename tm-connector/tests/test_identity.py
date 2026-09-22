"""The per-field precedence rule, and everything it must not do."""

from connector.config import DEFAULT_RUN_KEY_PATTERN
from connector.identity import (
    UNKNOWN_RIG,
    Identity,
    clean_declared,
    find_run_key,
    parse_instant,
    resolve_identity,
    resolve_source_system,
)

PATTERN = r"TAS-\d+"


def _resolve(declared=None, header=None, filename="TAS-90001_capture.mf4") -> Identity:
    return resolve_identity(declared or {}, header or {}, filename, PATTERN)


class TestDeclaredBag:
    def test_an_unknown_declared_key_is_dropped(self):
        # mf4-import forwards what it does not understand; RequestModel is
        # extra="forbid", so an unknown field would be a 422, not an ignored key.
        cleaned = clean_declared({"run_id": "TAS-1", "favourite_colour": "blue"})
        assert cleaned == {"run_id": "TAS-1"}

    def test_source_and_actor_are_never_accepted_from_the_bag(self):
        cleaned = clean_declared({"source": "manual", "actor": "somebody"})
        assert cleaned == {}

    def test_a_blank_value_reads_as_absent(self):
        assert clean_declared({"run_id": "   ", "rig_id": "RIG-01"}) == {"rig_id": "RIG-01"}

    def test_an_absent_bag_is_an_ordinary_upload(self):
        identity = _resolve(declared=None, header=None)
        assert identity.run_id == "TAS-90001"  # from the filename
        assert identity.run_id_derived is True


class TestLinkagePrecedence:
    def test_declared_wins_the_run_key(self):
        identity = _resolve(
            declared={"run_id": "TAS-90002"}, header={"test.run_key": "TAS-90001"}
        )
        assert identity.run_id == "TAS-90002"

    def test_the_losing_header_value_is_reported_not_destroyed(self):
        identity = _resolve(
            declared={"run_id": "TAS-90002"}, header={"test.run_key": "TAS-90001"}
        )
        # A header naming another run is also REFUSED its claims from here on
        # (TestAForeignRecordClaimsNothing), so a second note follows. The
        # precedence note itself is unchanged and still comes first.
        assert identity.conflicts[0] == "header stated run_id=TAS-90001; TAS-90002 won"

    def test_the_header_is_the_only_channel_when_the_bag_is_absent(self):
        identity = _resolve(header={"test.run_key": "TAS-70000", "test.rig": "RIG-09"})
        assert (identity.run_id, identity.rig_id) == ("TAS-70000", "RIG-09")
        assert identity.conflicts == []

    def test_claims_ride_through_from_either_channel(self):
        identity = _resolve(
            declared={"work_order_id": "WO-1"}, header={"test.definition": "TD-9"}
        )
        assert identity.fields["work_order_id"] == "WO-1"
        assert identity.fields["definition_id"] == "TD-9"

    def test_an_unresolvable_rig_is_the_sentinel_never_a_guess(self):
        assert _resolve().rig_id == UNKNOWN_RIG

    def test_no_channel_and_no_filename_match_leaves_the_run_unknown(self):
        identity = _resolve(filename="road_capture.mf4")
        assert identity.run_id is None


class TestTheRunKeyLadder:
    """declared -> header -> filename -> unresolved. One ladder, both apps."""

    def test_the_filename_rung_is_last_and_it_fires(self):
        identity = _resolve(filename="TAS-90001_capture.mf4")
        assert (identity.run_id, identity.run_id_derived) == ("TAS-90001", True)

    def test_the_header_rung_beats_the_filename_rung(self):
        identity = _resolve(
            header={"test.run_key": "TAS-70000"}, filename="TAS-90001_capture.mf4"
        )
        assert (identity.run_id, identity.run_id_derived) == ("TAS-70000", False)

    def test_a_malformed_pattern_falls_back_to_the_default(self):
        # A bad TM_RUN_KEY_PATTERN must never silently DISABLE the rung: the
        # connector would then yield an unlinkable file for a filename that
        # names its run perfectly well (ingestion/mf4.py:127-145).
        identity = resolve_identity({}, {}, "TAS-90001_capture.mf4", "TAS-[")
        assert identity.run_id == "TAS-90001"

    def test_a_configured_pattern_still_wins_when_it_compiles(self):
        identity = resolve_identity({}, {}, "RUN_4711_capture.mf4", r"RUN_\d+")
        assert identity.run_id == "RUN_4711"

    def test_an_empty_pattern_never_resolves_an_empty_run_key(self):
        # An empty regex matches at position 0 and would yield "" — an id the
        # registry would happily store and no query would ever find.
        identity = resolve_identity({}, {}, "road_capture.mf4", "")
        assert identity.run_id is None

    def test_all_four_rungs_in_one_place(self):
        # mf4-decoder climbs the same four. When the two apps disagree, the
        # registry holds the run and the lake holds its rows under another
        # partition; a query for that run then answers nothing, with no error.
        declared = _resolve(
            declared={"run_id": "TAS-1"},
            header={"test.run_key": "TAS-2"},
            filename="TAS-3_capture.mf4",
        )
        header = _resolve(header={"test.run_key": "TAS-2"}, filename="TAS-3_capture.mf4")
        name = _resolve(filename="TAS-3_capture.mf4")
        nothing = _resolve(filename="road_capture.mf4")

        assert [declared.run_id, header.run_id, name.run_id, nothing.run_id] == [
            "TAS-1",
            "TAS-2",
            "TAS-3",
            None,
        ]

    def test_the_default_pattern_is_the_one_both_apps_share(self):
        # R1: one env name, one default, in mf4-decoder and here.
        assert DEFAULT_RUN_KEY_PATTERN == r"TAS-\d+"
        assert find_run_key("TAS-90001_capture.mf4", DEFAULT_RUN_KEY_PATTERN) == "TAS-90001"


class TestAForeignRecordClaimsNothing:
    """A record naming another run never lends this run its work order.

    The fallback refuses the whole claims record when it disagrees
    (ingestion/watcher.py:385-394 — "the folder names one run and the body
    names another. Never guess a field."). A run inheriting another run's work
    order is a correctness failure that looks completely normal on screen.
    """

    FOREIGN = {
        "test.run_key": "TAS-90002",
        "test.work_order": "WO-OTHER",
        "test.definition": "TD-OTHER",
        "test.description": "a different run entirely",
        "test.cell": "CELL-9",
        "test.operator": "somebody else",
    }

    def test_no_claim_of_the_foreign_record_reaches_the_run(self):
        identity = _resolve(declared={"run_id": "TAS-90001"}, header=dict(self.FOREIGN))
        assert identity.run_id == "TAS-90001"
        assert identity.fields == {}

    def test_the_refusal_is_reported_not_silent(self):
        identity = _resolve(declared={"run_id": "TAS-90001"}, header=dict(self.FOREIGN))
        assert any(
            "TAS-90002" in note and "stayed out" in note for note in identity.conflicts
        ), identity.conflicts

    def test_the_window_survives_because_the_bytes_measured_it(self):
        # started_at/ended_at are properties of these bytes, not assignments a
        # record makes about a run, so the refusal never reaches them.
        identity = _resolve(
            declared={"run_id": "TAS-90001"},
            header=dict(self.FOREIGN) | {"test.started_at": "2026-08-20T10:42:07Z"},
        )
        assert identity.fields["started_at"] == "2026-08-20T10:42:07Z"

    def test_an_agreeing_record_still_lends_its_claims(self):
        identity = _resolve(
            declared={"run_id": "TAS-90001"},
            header={"test.run_key": "TAS-90001", "test.work_order": "WO-1"},
        )
        assert identity.fields["work_order_id"] == "WO-1"

    def test_a_record_that_names_no_run_is_never_refused(self):
        identity = _resolve(
            declared={"run_id": "TAS-90001"}, header={"test.work_order": "WO-1"}
        )
        assert identity.fields["work_order_id"] == "WO-1"

    def test_the_bag_that_names_the_run_is_never_the_foreign_one(self):
        # The guard is per-record. The declared bag wins the key, so its own
        # claims are by definition about this run and always ride through.
        identity = _resolve(
            declared={"run_id": "TAS-90002", "work_order_id": "WO-MINE"},
            header={"test.run_key": "TAS-90003", "test.work_order": "WO-OTHER"},
            filename="road_capture.mf4",
        )
        assert identity.run_id == "TAS-90002"
        assert identity.fields["work_order_id"] == "WO-MINE"



class TestMeasuredPrecedence:
    def test_the_header_wins_the_window(self):
        identity = _resolve(
            declared={"started_at": "2026-01-01T00:00:00Z"},
            header={"test.started_at": "2026-08-20T10:42:07Z"},
        )
        assert identity.fields["started_at"] == "2026-08-20T10:42:07Z"

    def test_the_declared_window_is_used_when_the_file_states_none(self):
        identity = _resolve(declared={"ended_at": "2026-08-20T10:43:37Z"})
        assert identity.fields["ended_at"] == "2026-08-20T10:43:37Z"

    def test_a_1970_stamp_means_the_source_states_none(self):
        # A false 1970 window is worse than no window (generation.py:76, :806).
        assert parse_instant("1970-01-01T00:00:00Z") is None
        identity = _resolve(header={"test.started_at": "1970-01-01T00:00:01Z"})
        assert "started_at" not in identity.fields

    def test_an_unparseable_stamp_never_reaches_the_registry(self):
        # It would answer 422 and cost the whole run upsert.
        assert parse_instant("last tuesday") is None


class TestContextPrecedence:
    def test_declared_wins_the_free_text(self):
        identity = _resolve(
            declared={"operator": "A. Nilsson"}, header={"test.operator": "unknown"}
        )
        assert identity.fields["operator"] == "A. Nilsson"


class TestSourceSystem:
    def test_the_header_states_it_when_it_is_in_the_enum(self):
        assert resolve_source_system({"test.source_system": "INCA"}, "x.mf4") == "INCA"

    def test_api_is_never_emitted(self):
        # "api" names a logical file minted by POST /test-runs/{id}/signals, not
        # a physical producer (api/api/models/files.py:11-13).
        assert resolve_source_system({"test.source_system": "api"}, "x.mf4") == "TAS"

    def test_an_out_of_enum_value_is_derived_not_forwarded(self):
        assert resolve_source_system({"test.source_system": "upload"}, "x.csv") == "ifile"

    def test_the_suffix_decides_without_a_header(self):
        assert resolve_source_system({}, "a.mf4") == "TAS"
        assert resolve_source_system({}, "a.csv") == "ifile"
        assert resolve_source_system({}, "a.bin") == "TAS"
