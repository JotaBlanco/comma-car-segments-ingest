"""The registry is down, and the registry refuses us. Two different faults.

* 5xx / 429 / connection error / timeout — the registry is down and our message
  is fine. Retry with a capped backoff; if the budget is spent, raise so the
  offset stays uncommitted. Bounded in-process, unbounded across deliveries.
* 4xx other than 429 — our message is malformed. Re-sending the same bytes
  forever blocks the partition and can never succeed: log, count, commit.
"""

import httpx
import pytest

from connector.registry import Registry, RegistryRejected, RegistryUnavailable
from tests.conftest import complete_message, metadata_message


def _registry(api, attempts=4, max_backoff=60.0):
    delays: list[float] = []
    registry = Registry(
        base_url="http://tm/api/v1",
        token="t0ken",
        max_attempts=attempts,
        max_backoff=max_backoff,
        sleep=delays.append,
        client=api.client("http://tm/api/v1"),
    )
    return registry, delays


class TestBoundedRetry:
    def test_a_transient_outage_is_ridden_out(self, api):
        registry, delays = _registry(api)
        api.transient["/test-runs"] = 2

        registry.upsert_run({"run_id": "TAS-1", "rig_id": "RIG-01"})

        assert len(delays) == 2
        assert registry.retries_spent == 2

    def test_the_retry_budget_is_bounded_and_never_spins(self, api):
        registry, delays = _registry(api, attempts=4)
        api.force_status["/test-runs"] = 503

        with pytest.raises(RegistryUnavailable):
            registry.upsert_run({"run_id": "TAS-1", "rig_id": "RIG-01"})

        assert len(api.calls) == 4  # attempts, not an infinite loop
        assert len(delays) == 3  # no sleep after the final attempt

    def test_the_backoff_grows_and_is_capped(self, api):
        registry, delays = _registry(api, attempts=8, max_backoff=2.0)
        api.force_status["/test-runs"] = 503

        with pytest.raises(RegistryUnavailable):
            registry.upsert_run({"run_id": "TAS-1", "rig_id": "RIG-01"})

        assert delays == [0.5, 1.0, 2.0, 2.0, 2.0, 2.0, 2.0]

    def test_a_connection_error_is_retried_like_a_5xx(self, api):
        registry, delays = _registry(api)
        api.disconnect["/test-runs"] = 2

        registry.upsert_run({"run_id": "TAS-1", "rig_id": "RIG-01"})
        assert len(delays) == 2

    def test_a_429_is_the_registry_asking_us_to_wait(self, api):
        registry, delays = _registry(api, attempts=2)
        api.force_status["/test-runs"] = 429

        with pytest.raises(RegistryUnavailable):
            registry.upsert_run({"run_id": "TAS-1", "rig_id": "RIG-01"})
        assert len(delays) == 1


class TestCallerFaults:
    def test_a_422_is_never_retried(self, api):
        registry, delays = _registry(api)
        api.force_status["/files"] = 422

        with pytest.raises(RegistryRejected) as caught:
            registry.register_file({"filename": "x"})

        assert caught.value.status_code == 422
        assert delays == []
        assert len(api.calls) == 1

    def test_a_rejected_body_is_counted_and_committed(self, connector, api):
        api.force_status["/files"] = 422

        connector.on_batch(complete_message())  # no exception: it commits

        assert connector.poisoned == 1
        assert connector.files_registered == 0


class TestTheConnectorUnderAnOutage:
    def test_the_metadata_lane_refuses_to_commit_past_a_dead_registry(
        self, connector, api
    ):
        api.force_status["/test-runs"] = 503
        with pytest.raises(RegistryUnavailable):
            connector.on_metadata(metadata_message())

    def test_a_journal_outage_never_costs_the_file(self, connector, api):
        api.force_status["/journal"] = 503

        connector.on_batch(complete_message())

        assert api.only_file()["status"] == "registered"
        assert connector.journal_failures > 0

    def test_a_journal_404_skips_that_event_and_continues_the_burst(self, connector, api):
        # The event's own fault, never the file's.
        real_handle = api._add_event
        seen = {"n": 0}

        def flaky(body):
            seen["n"] += 1
            if seen["n"] == 1:
                return httpx.Response(404, json={"detail": "File not found"})
            return real_handle(body)

        api._add_event = flaky
        connector.on_batch(complete_message())

        # The first was refused; the OTHER THREE landed (checksum_verified,
        # header_parsed, samples_written - the marker's stated count fires
        # the samples event again since 26 Aug 2026).
        assert len(api.journal) == 3
        assert connector.journal_failures == 1
        assert api.only_file()["status"] == "registered"


class TestAuthFaults:
    def test_a_401_is_an_outage_not_a_poison(self, api):
        """A rotated or missing TM_API_TOKEN is a CONFIG fault: classifying
        401/403 as rejected once poisoned-and-committed every marker in the
        window — files silently never registered, recoverable only by a
        manual group rotation (found 25 Aug 2026)."""
        registry, delays = _registry(api, attempts=2)
        api.force_status["/test-runs"] = 401

        with pytest.raises(RegistryUnavailable):
            registry.upsert_run({"run_id": "TAS-1", "rig_id": "RIG-01"})
        assert len(delays) == 1, "retried like an outage"

    def test_a_403_is_an_outage_not_a_poison(self, api):
        registry, delays = _registry(api, attempts=2)
        api.force_status["/test-runs"] = 403

        with pytest.raises(RegistryUnavailable):
            registry.upsert_run({"run_id": "TAS-1", "rig_id": "RIG-01"})
        assert len(delays) == 1
