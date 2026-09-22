"""The amber beat: a claim naming a work order planning does not know.

`_resolve_claims` links a claim only when the planning mirror holds the row. An
unknown id links nothing and refuses nothing: the run stays amber, the claim is
REMEMBERED on the run, and the next planning sync repairs it
(api/api/services/queries_runs.py:84-107, :143-155). That amber -> green beat is
the demo's payoff, so the connector must not pre-validate, drop or retry a claim.
"""

from tests.conftest import DECLARED, complete_message, metadata_message


class TestAnUnknownWorkOrder:
    def test_the_run_stays_amber(self, connector, api):
        api.work_orders.clear()

        connector.on_metadata(metadata_message())

        assert api.runs["TAS-90001"]["status"] == "awaiting_work_order"

    def test_the_claim_is_remembered_not_dropped(self, connector, api):
        api.work_orders.clear()

        connector.on_metadata(metadata_message())

        run = api.runs["TAS-90001"]
        assert run["work_order_id"] is None
        assert run["claimed_work_order_id"] == "WO-2026-0853"

    def test_the_connector_never_pre_validates_the_claim(self, connector, api):
        api.work_orders.clear()

        connector.on_metadata(metadata_message())

        # No planning lookup of any kind — three routes, and none of them ask.
        assert set(api.paths()) == {"/test-runs"}
        assert api.bodies("/test-runs")[0]["work_order_id"] == "WO-2026-0853"

    def test_an_unresolved_claim_is_a_2xx_not_an_error(self, connector, api):
        api.work_orders.clear()
        api.definitions.clear()

        connector.on_metadata(metadata_message())

        assert connector.runs_upserted == 1
        assert connector.poisoned == 0
        assert connector._registry.retries_spent == 0

    def test_the_file_still_registers_against_an_amber_run(self, connector, api):
        api.work_orders.clear()

        connector.on_metadata(metadata_message())
        connector.on_batch(complete_message())

        assert api.only_file()["status"] == "registered"
        assert api.runs["TAS-90001"]["status"] == "awaiting_work_order"

    def test_planning_learning_the_row_turns_it_green(self, connector, api):
        api.work_orders.clear()
        connector.on_metadata(metadata_message())
        assert api.runs["TAS-90001"]["status"] == "awaiting_work_order"

        # Planning catches up, and the next upsert honours the same claim.
        api.work_orders.add("WO-2026-0853")
        connector.on_batch(complete_message())

        assert api.runs["TAS-90001"]["status"] == "complete"
        assert api.runs["TAS-90001"]["work_order_id"] == "WO-2026-0853"


class TestBothClaimsRideThrough:
    def test_a_definition_claim_is_forwarded_untouched(self, connector, api):
        api.definitions.clear()
        connector.on_metadata(metadata_message())
        assert api.runs["TAS-90001"]["claimed_definition_id"] == "TD-RLD-301"

    def test_no_claim_at_all_is_not_a_conflict(self, connector, api):
        declared = {name: DECLARED[name] for name in ("run_id", "rig_id")}
        connector.on_metadata(metadata_message(declared=declared))
        body = api.bodies("/test-runs")[0]
        assert "work_order_id" not in body
        assert "definition_id" not in body
