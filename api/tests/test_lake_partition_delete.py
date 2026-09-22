"""The two calls a run delete makes on QuixLake, on the wire.

No test here reaches the network. httpx.MockTransport answers every call.

The stake is specific: `delete?mode=partitions` removes a FOLDER TREE. A path
built one level too short takes every run under it, and one level too long
leaves the run's other protocols behind. So these tests pin the exact path, the
exact parameters, and every case where the client must refuse to name a folder
at all.
"""

import httpx
import pytest

from api.services import lake

RUN = "TAS-88214"
TABLE = "pcap_data_v1"

# The lake-sink's real layout (`tests/test_quix_yaml.py:120`): four physical
# levels above `protocol`, with the virtual ones (`~bus`, `~signal`) absent from
# the manifest and therefore absent from `partition_keys`.
KEYS = ["platform", "work_order", "test_definition", "run_id", "protocol"]


@pytest.fixture(autouse=True)
def lake_env(monkeypatch):
    for name in ("QUIX_LAKE_URL", "Quix__Lakehouse__Query__AuthToken", "API_AUTH_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", "http://lake.test/")
    monkeypatch.setenv("Quix__Sdk__Token", "token-not-a-secret")


def _answer(seen: list, payload, status: int = 200) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if isinstance(payload, str):
            return httpx.Response(status, text=payload)
        return httpx.Response(status, json=payload)

    return httpx.MockTransport(handler)


def _combinations(rows, keys=None, truncated=False) -> dict:
    return {
        "combinations": rows,
        "count": len(rows),
        "truncated": truncated,
        "partition_keys": keys if keys is not None else KEYS,
    }


def test_the_folder_stops_at_the_run_and_never_one_level_deeper():
    """`protocol` sits BELOW the run, so it is not part of the path.

    QuixLake removes the tree and the catalog matches a partition by the values
    given, so the prefix takes every protocol under the run in one call.
    """
    seen: list[httpx.Request] = []
    rows = [
        {
            "platform": "sn002",
            "work_order": "WO-2026-0851",
            "test_definition": "TD-14",
            "run_id": RUN,
            # The innermost key arrives aggregated, semicolon separated.
            "protocol": "arinc429;can;ethernet",
        }
    ]

    paths = lake.run_partitions(TABLE, RUN, transport=_answer(seen, _combinations(rows)))

    assert paths == [
        f"platform=sn002/work_order=WO-2026-0851/test_definition=TD-14/run_id={RUN}"
    ]
    request = seen[0]
    assert request.url.path == "/partition-combinations"
    assert request.url.params["table"] == TABLE
    assert request.url.params["filter"] == f"run_id:{RUN}"
    assert request.headers["Authorization"] == "Bearer token-not-a-secret"


def test_a_run_that_spans_two_work_orders_names_both_folders():
    """One run under two prefixes is two folders, and both must go."""
    rows = [
        {"platform": "sn002", "work_order": "WO-1", "test_definition": "TD-14",
         "run_id": RUN, "protocol": "can"},
        {"platform": "sn002", "work_order": "WO-2", "test_definition": "TD-14",
         "run_id": RUN, "protocol": "can"},
    ]

    paths = lake.run_partitions(TABLE, RUN, transport=_answer([], _combinations(rows)))

    assert paths == [
        f"platform=sn002/work_order=WO-1/test_definition=TD-14/run_id={RUN}",
        f"platform=sn002/work_order=WO-2/test_definition=TD-14/run_id={RUN}",
    ]


def test_two_rows_that_differ_only_below_the_run_name_one_folder():
    # The aggregate collapses the innermost key already; a table with a deeper
    # spec would not. The same folder must never be deleted twice.
    rows = [
        {"platform": "sn002", "work_order": "WO-1", "test_definition": "TD-14",
         "run_id": RUN, "protocol": "can"},
        {"platform": "sn002", "work_order": "WO-1", "test_definition": "TD-14",
         "run_id": RUN, "protocol": "ethernet"},
    ]

    paths = lake.run_partitions(TABLE, RUN, transport=_answer([], _combinations(rows)))

    assert paths == [f"platform=sn002/work_order=WO-1/test_definition=TD-14/run_id={RUN}"]


def test_a_table_partitioned_by_run_alone_names_the_run_folder():
    # The seed writer's layout is `run_id,signal`: the run IS the top folder.
    paths = lake.run_partitions(
        "test_signal_samples",
        RUN,
        transport=_answer([], _combinations([{"run_id": RUN, "signal": "a;b"}],
                                            keys=["run_id", "signal"])),
    )

    assert paths == [f"run_id={RUN}"]


def test_a_table_the_lake_does_not_hold_names_no_partition():
    # A run whose samples never arrived is not an error. Nothing to delete.
    assert lake.run_partitions(TABLE, RUN, transport=_answer([], {"error": "no"}, 404)) == []


def test_a_table_that_is_not_partitioned_by_run_names_no_partition():
    """Deleting a folder here would take other runs with it, so name none."""
    paths = lake.run_partitions(
        TABLE,
        RUN,
        transport=_answer([], _combinations([{"year": "2026"}], keys=["year", "month"])),
    )

    assert paths == []


def test_a_truncated_listing_refuses_instead_of_deleting_half_a_run():
    with pytest.raises(lake.LakePartitionError):
        lake.run_partitions(
            TABLE,
            RUN,
            transport=_answer([], _combinations([{"platform": "sn002", "work_order": "WO-1",
                                                  "test_definition": "TD-14", "run_id": RUN,
                                                  "protocol": "can"}], truncated=True)),
        )


def test_a_null_value_above_the_run_refuses_rather_than_leaving_data():
    # There is no folder this client can name for a NULL level. Skipping the row
    # would leave samples behind and still report the run deleted.
    rows = [{"platform": None, "work_order": "WO-1", "test_definition": "TD-14",
             "run_id": RUN, "protocol": "can"}]

    with pytest.raises(lake.LakePartitionError):
        lake.run_partitions(TABLE, RUN, transport=_answer([], _combinations(rows)))


def test_a_comma_in_a_partition_value_refuses_rather_than_splitting_the_list():
    # QuixLake takes the list as one comma-joined parameter, so this path would
    # arrive as two paths that name nothing.
    rows = [{"platform": "sn002,sn003", "work_order": "WO-1", "test_definition": "TD-14",
             "run_id": RUN, "protocol": "can"}]

    with pytest.raises(lake.LakePartitionError):
        lake.run_partitions(TABLE, RUN, transport=_answer([], _combinations(rows)))


def test_the_delete_names_the_mode_the_table_and_every_folder():
    seen: list[httpx.Request] = []
    paths = [f"platform=sn002/work_order=WO-1/test_definition=TD-14/run_id={RUN}",
             f"platform=sn002/work_order=WO-2/test_definition=TD-14/run_id={RUN}"]

    deleted = lake.delete_partitions(
        TABLE, paths, transport=_answer(seen, {"deletion_result": {"partitions_deleted": 2}})
    )

    assert deleted == 2
    request = seen[0]
    assert request.method == "DELETE"
    assert request.url.path == "/delete"
    assert request.url.params["mode"] == "partitions"
    assert request.url.params["table"] == TABLE
    assert request.url.params["partitions"] == ",".join(paths)


def test_an_empty_list_never_reaches_the_wire():
    seen: list[httpx.Request] = []

    assert lake.delete_partitions(TABLE, [], transport=_answer(seen, {})) == 0
    assert seen == []


@pytest.mark.parametrize("status", [500, 502, 503])
def test_a_lake_that_fails_the_delete_raises(status):
    with pytest.raises(lake.LakeError):
        lake.delete_partitions(TABLE, ["run_id=x"], transport=_answer([], "boom", status))


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_token_reads_as_a_credential_on_both_calls(status):
    with pytest.raises(lake.LakeAuthError):
        lake.run_partitions(TABLE, RUN, transport=_answer([], "no", status))
    with pytest.raises(lake.LakeAuthError):
        lake.delete_partitions(TABLE, ["run_id=x"], transport=_answer([], "no", status))


def test_an_unset_lakehouse_names_the_variable_an_operator_sets(monkeypatch):
    monkeypatch.delenv("Quix__Lakehouse__Query__Url")

    with pytest.raises(lake.LakeError) as raised:
        lake.run_partitions(TABLE, RUN, transport=_answer([], {}))

    assert lake.URL_VAR in str(raised.value)


def test_a_lake_that_cannot_be_reached_is_a_lake_error_and_not_a_crash():
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    with pytest.raises(lake.LakeError):
        lake.run_partitions(TABLE, RUN, transport=httpx.MockTransport(refuse))


def test_the_body_of_a_delete_answer_may_say_nothing_and_the_count_still_holds():
    # An older lake answers `{"message": ...}` with no result block.
    assert lake.delete_partitions(
        TABLE, ["run_id=x"], transport=_answer([], {"message": "ok"})
    ) == 1
