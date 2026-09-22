"""A full topic replay must create no duplicates.

The connector keeps NO state store of its own for correctness. The decoder's
content-keyed decode-once store usually stops an `mf4_metadata` replay before the
blob download, but this service consumes `mf4-to-msg` DIRECTLY, so a new consumer
group or an offset reset on that topic bypasses the decoder entirely.

Under that replay the registry does the work:
* run upserts merge (201 create / 200 merge, routers/test_runs.py:183-197);
* file registers dedup on the checksum, backed by a unique partial index on
  `status: "registered"` (routers/files.py:363-365, 430-434; api/db.py:71-76);
* journal has NO dedup (routers/journal.py:63-97), so the connector journals
  only when POST /files answered 201.
"""

from tests.conftest import complete_message, metadata_message, samples_message


def _replay(connector):
    connector.on_metadata(metadata_message())
    connector.on_batch(samples_message(signal="ENGINE_RPM", n=21))
    connector.on_batch(samples_message(signal="VEHICLE_SPEED", n=11))
    connector.on_batch(complete_message(signal_count=2, sample_count=32))


class TestFullReplay:
    def test_one_run_and_one_file_survive_three_passes(self, connector, api):
        for _pass in range(3):
            _replay(connector)

        assert len(api.runs) == 1
        assert len(api.files) == 1

    def test_the_timeline_never_doubles(self, connector, api):
        _replay(connector)
        first = list(api.journal)

        _replay(connector)
        _replay(connector)

        assert api.journal == first
        assert connector.files_replayed == 2

    def test_the_replay_is_recognised_as_a_replay(self, connector, api):
        _replay(connector)
        _replay(connector)
        assert connector.files_registered == 1
        assert connector.files_replayed == 1

    def test_the_stored_run_keeps_its_claims(self, connector, api):
        _replay(connector)
        _replay(connector)
        run = api.runs["TAS-90001"]
        assert run["work_order_id"] == "WO-2026-0853"
        assert run["definition_id"] == "TD-RLD-301"

    def test_the_inventory_is_not_rewritten_by_a_replay(self, connector, api):
        _replay(connector)
        registered = api.only_file()["_signals"]
        _replay(connector)
        assert api.only_file()["_signals"] == registered

    def test_a_rotated_consumer_group_costs_work_not_correctness(self, connector, api):
        # A Portal-rotated group is a full replay. Harmless — but wasted, which
        # is why the group is hard-coded in code, not app.yaml.
        _replay(connector)
        calls_after_first = len(api.calls)
        _replay(connector)
        # The second pass makes calls (they are merges and replays), but mints
        # nothing new.
        assert len(api.calls) > calls_after_first
        assert (len(api.runs), len(api.files), len(api.journal)) == (1, 1, 4)


class TestCrossRunReplay:
    def test_the_same_bytes_register_fresh_on_a_second_run(self, connector, api):
        """Same bytes, new declared run: a SECOND file is registered, on the
        new run. Identity is (run, checksum) since 24 Aug 2026 — re-running a
        known recording is normal test-platform work, and the earlier
        "nothing was registered here" cross-run warning has no trigger left."""
        _replay(connector)

        connector.on_metadata(metadata_message())
        connector.on_batch(samples_message(signal="ENGINE_RPM", n=21))
        connector.on_batch(
            complete_message(
                signal_count=1,
                sample_count=21,
                run_id="TAS-90099",
                declared={"run_id": "TAS-90099", "rig_id": "RIG-02"},
            )
        )

        registered = [doc for doc in api.files.values() if doc["status"] == "registered"]
        assert len(registered) == 2
        assert {doc["run_id"] for doc in registered} == {"TAS-90001", "TAS-90099"}
        assert connector.files_registered == 2
        assert not [
            event
            for event in api.journal
            if event["field"] == "run.file_checksum_already_registered"
        ]

    def test_a_same_run_replay_stays_quiet(self, connector, api):
        _replay(connector)
        first = list(api.journal)
        _replay(connector)
        assert api.journal == first
