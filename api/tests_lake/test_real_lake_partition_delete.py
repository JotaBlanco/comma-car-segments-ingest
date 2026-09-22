"""The run delete's two lakehouse calls, against a REAL QuixLake.

`tests/test_lake_partition_delete.py` pins the wire shape against a mock, and a
mock agrees with our code by construction. These calls DELETE A FOLDER TREE, so
"the mock agreed" is not good enough: a wrong parameter name would be a silent
no-op, and a path one level short would take every run under it.

So this suite builds the lake table's REAL layout
(`platform/work_order/test_definition/run_id/protocol`, the lake-sink's
`HIVE_COLUMNS` — `tests/test_quix_yaml.py:120`), and proves on live data that:

* the folders are named from the partition metadata the service really serves,
* the delete takes the run's whole subtree, every protocol under it included,
* a second run under the same prefix survives,
* the same run under a DIFFERENT prefix is found and deleted too,
* a repeat delete is a no-op, so pressing delete twice is safe.

Run it with the harness in `conftest.py`.
"""

import httpx
import pytest

from api.services import lake

DOOMED = "sn002_20260915T090000000Z"
KEPT = "sn002_20260915T100000000Z"

# The lake-sink's physical columns, in order. `protocol` sits BELOW the run.
HIVE_COLUMNS = "platform,work_order,test_definition,run_id,protocol"


def _seed(url: str, token: str, table: str) -> None:
    """Write three runs: two under one prefix, one under another."""
    header = "platform,work_order,test_definition,run_id,protocol,timestamp,signal,value\n"
    rows = []
    for platform, work_order, definition, run in (
        ("sn002", "WO-2026-0851", "TD-14", DOOMED),
        ("sn002", "WO-2026-0851", "TD-14", KEPT),
        # The SAME run under a second prefix. One run can span two work orders,
        # and both folders have to go.
        ("sn003", "WO-2026-0852", "TD-15", DOOMED),
    ):
        for protocol in ("can", "analog"):
            for index in range(3):
                rows.append(
                    f"{platform},{work_order},{definition},{run},{protocol},"
                    f"2026-09-15T09:0{index}:00Z,sig_{index},{index}.5\n"
                )
    with httpx.Client(timeout=lake.TIMEOUT_SECONDS) as client:
        response = client.post(
            f"{url}/insert",
            params={
                "table": table,
                "hive_columns": HIVE_COLUMNS,
                "timestamp_column": "timestamp",
                # `none` keeps the layout exactly as HIVE_COLUMNS states it: a
                # time partition below the run would not change the delete, but
                # it would stop this test from pinning the layout it means to.
                "timestamp_format": "none",
            },
            headers={"Authorization": f"Bearer {token}", "Content-Type": "text/csv"},
            content=(header + "".join(rows)).encode("utf-8"),
        )
    response.raise_for_status()
    assert response.json()["rows_inserted"] == 18


def _rows_by_run(table: str) -> dict[str, int]:
    return {
        row["run_id"]: int(row["n"])
        for row in lake.query(
            f"SELECT run_id, count(*) AS n FROM {table} GROUP BY run_id"
        )
    }


@pytest.fixture
def seeded(lake_url, lake_token, lake_table):
    _seed(lake_url, lake_token, lake_table)
    return lake_table


def test_the_folders_come_from_the_metadata_the_service_really_serves(seeded):
    """One run under two prefixes is two folders, and `protocol` is in neither."""
    paths = lake.run_partitions(seeded, DOOMED)

    assert sorted(paths) == [
        f"platform=sn002/work_order=WO-2026-0851/test_definition=TD-14/run_id={DOOMED}",
        f"platform=sn003/work_order=WO-2026-0852/test_definition=TD-15/run_id={DOOMED}",
    ]
    # The level below the run is never named: the folder tree goes as a whole.
    assert not any("protocol=" in path for path in paths)


def test_deleting_a_run_takes_every_protocol_under_it_and_spares_the_other_run(seeded):
    assert _rows_by_run(seeded) == {DOOMED: 12, KEPT: 6}

    deleted = lake.delete_partitions(seeded, lake.run_partitions(seeded, DOOMED))

    assert deleted == 2, "one folder per prefix the run sits under"
    assert _rows_by_run(seeded) == {KEPT: 6}, "the other run keeps every row"


def test_the_other_run_keeps_its_own_folder(seeded):
    lake.delete_partitions(seeded, lake.run_partitions(seeded, DOOMED))

    assert lake.run_partitions(seeded, KEPT) == [
        f"platform=sn002/work_order=WO-2026-0851/test_definition=TD-14/run_id={KEPT}"
    ]


def test_pressing_delete_twice_is_safe(seeded):
    """The second press finds nothing, which is what makes a retry safe.

    The API turns an empty partition list into `lake.status == "empty"` and
    carries on with the registry, so a delete interrupted after the lakehouse
    step completes on the next press instead of refusing for ever.
    """
    lake.delete_partitions(seeded, lake.run_partitions(seeded, DOOMED))

    assert lake.run_partitions(seeded, DOOMED) == []
    assert lake.delete_partitions(seeded, []) == 0
    assert _rows_by_run(seeded) == {KEPT: 6}


def test_a_run_the_table_never_held_names_no_folder(seeded):
    assert lake.run_partitions(seeded, "sn002_NEVER_RAN") == []


def test_a_table_the_lake_does_not_hold_names_no_folder(lake_url, lake_token):
    # A run whose samples never reached the lake is not an error: the delete
    # goes on and takes the registry rows.
    assert lake.run_partitions("tm_no_such_table_at_all", DOOMED) == []
