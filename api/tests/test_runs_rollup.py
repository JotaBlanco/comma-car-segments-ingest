"""A-04 — `apply_file_rollup`, the helper Lane B calls from `POST /files`.

A run carries counts and a time range that belong to its files. The file route
owns the file; this helper owns what the file does to its run. Calling it twice
for the same file must not double-count, because a registration can replay.
"""

from datetime import UTC, datetime

from api.services import queries_runs
from api.services.queries_runs import apply_file_rollup
from tests.factories_planning import make_run

RUN = "TAS-88214"


def _file(file_id: str = "f-1", **overrides) -> dict:
    doc = {
        "_id": file_id,
        "run_id": RUN,
        "filename": "bat_cyc_20260814_0941.mf4",
        "time_start": datetime(2026, 8, 14, 9, 41, 7, tzinfo=UTC),
        "time_end": datetime(2026, 8, 14, 11, 18, 52, tzinfo=UTC),
    }
    doc.update(overrides)
    return doc


def _register(db, file_doc: dict, signal_names: list[str]) -> dict:
    """Store the file the way `POST /files` does, then return it.

    The route inserts the file and its inventory, then calls the rollup. The
    tests follow that order so they exercise the real call.
    """
    db["files"].replace_one({"_id": file_doc["_id"]}, file_doc, upsert=True)
    for name in signal_names:
        db["file_signals"].replace_one(
            {"file_id": file_doc["_id"], "name": name},
            {
                "_id": f"fs-{file_doc['_id']}-{name}",
                "file_id": file_doc["_id"],
                "run_id": file_doc.get("run_id"),
                "name": name,
            },
            upsert=True,
        )
    return file_doc


def _seed_run(db, **overrides) -> None:
    fields = {"file_count": 0, "signal_count": 0, "started_at": None, "ended_at": None}
    fields.update(overrides)
    # The run also STATES that window, the way `POST /test-runs` states it. The
    # rollup re-derives `started_at` and `ended_at` from the run's files joined
    # with the stated window, so a run that states nothing carries only what
    # its files carry.
    fields.setdefault("reported_started_at", fields["started_at"])
    fields.setdefault("reported_ended_at", fields["ended_at"])
    db["test_runs"].insert_one(make_run(run_id=RUN, **fields))


def test_the_first_file_sets_the_counts(db) -> None:
    _seed_run(db)

    names = ["HV_Batt_Cell_Temp_Max", "HV_Batt_Pack_Voltage"]
    apply_file_rollup(db, RUN, _register(db, _file(), names))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["file_count"] == 1
    assert run["signal_count"] == 2


def test_a_second_file_adds_to_the_counts(db) -> None:
    _seed_run(db)

    apply_file_rollup(db, RUN, _register(db, _file("f-1"), ["A", "B"]))
    apply_file_rollup(db, RUN, _register(db, _file("f-2"), ["C"]))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["file_count"] == 2
    assert run["signal_count"] == 3


def test_the_signal_count_is_distinct_across_files(db) -> None:
    """Two files recording the same signal is one signal on the run."""
    _seed_run(db)

    first = ["Shared", "OnlyInOne"]
    second = ["Shared", "OnlyInTwo"]
    apply_file_rollup(db, RUN, _register(db, _file("f-1"), first))
    apply_file_rollup(db, RUN, _register(db, _file("f-2"), second))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["signal_count"] == 3


def test_the_same_file_twice_does_not_double_count(db) -> None:
    """A registration can replay. The rollup has to be idempotent per file."""
    _seed_run(db)

    apply_file_rollup(db, RUN, _register(db, _file("f-1"), ["A", "B"]))
    apply_file_rollup(db, RUN, _register(db, _file("f-1"), ["A", "B"]))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["file_count"] == 1
    assert run["signal_count"] == 2


def test_the_time_range_grows_in_both_directions(db) -> None:
    _seed_run(db)

    apply_file_rollup(db, RUN, _register(db, _file("f-1"), []))
    wider = _file(
        "f-2",
        time_start=datetime(2026, 8, 14, 9, 0, tzinfo=UTC),
        time_end=datetime(2026, 8, 14, 12, 0, tzinfo=UTC),
    )
    apply_file_rollup(db, RUN, _register(db, wider, []))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["started_at"] == datetime(2026, 8, 14, 9, 0, tzinfo=UTC)
    assert run["ended_at"] == datetime(2026, 8, 14, 12, 0, tzinfo=UTC)


def test_a_narrower_file_does_not_shrink_the_range(db) -> None:
    _seed_run(db)

    apply_file_rollup(db, RUN, _register(db, _file("f-1"), []))
    narrower = _file(
        "f-2",
        time_start=datetime(2026, 8, 14, 10, 0, tzinfo=UTC),
        time_end=datetime(2026, 8, 14, 10, 30, tzinfo=UTC),
    )
    apply_file_rollup(db, RUN, _register(db, narrower, []))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["started_at"] == datetime(2026, 8, 14, 9, 41, 7, tzinfo=UTC)
    assert run["ended_at"] == datetime(2026, 8, 14, 11, 18, 52, tzinfo=UTC)


def test_an_earlier_file_lowers_first_data_at_with_started_at(db) -> None:
    """Lane B's rule: `first_data_at` is the list sort key. It never trails the start."""
    _seed_run(db, first_data_at=datetime(2026, 8, 14, 10, 0, tzinfo=UTC))

    apply_file_rollup(db, RUN, _register(db, _file(), []))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["started_at"] == datetime(2026, 8, 14, 9, 41, 7, tzinfo=UTC)
    assert run["first_data_at"] == datetime(2026, 8, 14, 9, 41, 7, tzinfo=UTC)


def test_a_later_file_never_raises_first_data_at(db) -> None:
    """Lower, never raise — the same rule `_extend_time_range` keeps."""
    _seed_run(db, first_data_at=datetime(2026, 8, 14, 9, 0, tzinfo=UTC))

    apply_file_rollup(db, RUN, _register(db, _file(), []))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["first_data_at"] == datetime(2026, 8, 14, 9, 0, tzinfo=UTC)


def test_a_timeless_file_keeps_first_data_at(db) -> None:
    """No file time means no evidence, so the stored value stands."""
    _seed_run(db, first_data_at=datetime(2026, 8, 14, 10, 0, tzinfo=UTC))

    timeless = _file("f-1", time_start=None, time_end=None)
    apply_file_rollup(db, RUN, _register(db, timeless, []))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["first_data_at"] == datetime(2026, 8, 14, 10, 0, tzinfo=UTC)


def test_the_epoch_sentinel_never_lowers_the_run_start(db) -> None:
    """The comma pipeline stamps 1970-01-01 for "no wall clock". It is not a time.

    Without the guard the run start and `first_data_at` both drop to 1970, and
    `first_data_at` is the runs-list sort key, so the run leaves the list top.
    """
    _seed_run(
        db,
        started_at=datetime(2026, 8, 10, 9, 0, tzinfo=UTC),
        first_data_at=datetime(2026, 8, 10, 9, 0, tzinfo=UTC),
    )

    sentinel = _file("f-1", time_start=datetime(1970, 1, 1, tzinfo=UTC))
    apply_file_rollup(db, RUN, _register(db, sentinel, []))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["started_at"] == datetime(2026, 8, 10, 9, 0, tzinfo=UTC)
    assert run["first_data_at"] == datetime(2026, 8, 10, 9, 0, tzinfo=UTC)


def test_the_sentinel_window_reaches_a_local_midnight_stamp(db) -> None:
    """A writer at local midnight lands up to 14 hours after the epoch."""
    _seed_run(
        db,
        started_at=datetime(2026, 8, 10, 9, 0, tzinfo=UTC),
        first_data_at=datetime(2026, 8, 10, 9, 0, tzinfo=UTC),
    )

    sentinel = _file("f-1", time_start=datetime(1970, 1, 1, 14, 0, tzinfo=UTC))
    apply_file_rollup(db, RUN, _register(db, sentinel, []))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["started_at"] == datetime(2026, 8, 10, 9, 0, tzinfo=UTC)
    assert run["first_data_at"] == datetime(2026, 8, 10, 9, 0, tzinfo=UTC)


def test_the_sentinel_file_still_counts_and_still_ends_the_run(db) -> None:
    """The guard drops the start only. The file and its end time stay."""
    _seed_run(db, started_at=datetime(2026, 8, 10, 9, 0, tzinfo=UTC))

    sentinel = _file(
        "f-1",
        time_start=datetime(1970, 1, 1, tzinfo=UTC),
        time_end=datetime(2026, 8, 10, 11, 0, tzinfo=UTC),
    )
    apply_file_rollup(db, RUN, _register(db, sentinel, ["A"]))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["file_count"] == 1
    assert run["signal_count"] == 1
    assert run["ended_at"] == datetime(2026, 8, 10, 11, 0, tzinfo=UTC)


def test_a_real_time_just_after_the_window_still_lowers_the_start(db) -> None:
    """The window stops at 1970-01-02. A later time is evidence, not a sentinel."""
    _seed_run(db, started_at=datetime(2026, 8, 10, 9, 0, tzinfo=UTC))

    early = _file("f-1", time_start=datetime(1970, 1, 3, tzinfo=UTC))
    apply_file_rollup(db, RUN, _register(db, early, []))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["started_at"] == datetime(1970, 1, 3, tzinfo=UTC)


def test_a_file_without_a_time_range_leaves_the_range_alone(db) -> None:
    """A quarantined file may carry no times. It still counts as a file."""
    _seed_run(db)

    apply_file_rollup(db, RUN, _register(db, _file("f-1"), []))
    timeless = _file("f-2", time_start=None, time_end=None)
    apply_file_rollup(db, RUN, _register(db, timeless, []))

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["file_count"] == 2
    assert run["started_at"] == datetime(2026, 8, 14, 9, 41, 7, tzinfo=UTC)


def test_the_rollup_re_derives_the_status(db) -> None:
    """The run keeps its amber state while no work order has arrived."""
    _seed_run(db, work_order_id=None, status="complete")

    apply_file_rollup(db, RUN, _register(db, _file(), ["A"]))

    assert db["test_runs"].find_one({"_id": RUN})["status"] == "awaiting_work_order"


def test_an_invalid_run_stays_invalid(db) -> None:
    _seed_run(
        db,
        invalid={"flagged": True, "reason": "sensor drift", "actor": "e.lindqvist", "at": None},
    )

    apply_file_rollup(db, RUN, _register(db, _file(), ["A"]))

    assert db["test_runs"].find_one({"_id": RUN})["status"] == "invalid"


def test_an_unknown_run_is_a_no_op(db) -> None:
    """An unlinked file names no run. The helper must not create one."""
    apply_file_rollup(db, "TAS-99999", _file(run_id="TAS-99999"))

    assert db["test_runs"].count_documents({}) == 0


def test_the_rollup_moves_updated_at(db) -> None:
    _seed_run(db)
    before = db["test_runs"].find_one({"_id": RUN})["updated_at"]

    apply_file_rollup(db, RUN, _register(db, _file(), ["A"]))

    assert db["test_runs"].find_one({"_id": RUN})["updated_at"] > before


# --- the lost update (finding 29b) ---------------------------------------------


def test_a_stale_derivation_never_overwrites_a_newer_count(db, monkeypatch) -> None:
    """Two registrations race, and the slow one used to put its count back.

    The helper reads the run, derives the counts from the files collection,
    then writes. Nothing joined those three steps, so a pass that derived
    "one file" could land AFTER a pass that derived "two files", and the run
    then reported one file while holding two.

    The test drives that order by hand. It runs the second registration inside
    the first one's derivation, so the first pass holds numbers that are
    already old by the time it writes. Without the guard the run ends with
    `file_count` 1. Delete the `rollup_seq` filter in `apply_file_rollup` and
    this test fails.
    """
    _seed_run(db)
    first = _register(db, _file("f-1"), ["A"])

    real_facts = queries_runs.run_facts
    raced = []

    def derive_then_let_the_other_pass_win(database, run_ids):
        facts = real_facts(database, run_ids)
        if not raced:
            raced.append(True)
            # The second registration lands and rolls the run up completely.
            second = _register(database, _file("f-2"), ["B"])
            queries_runs.apply_file_rollup(database, RUN, second)
        return facts

    monkeypatch.setattr(queries_runs, "run_facts", derive_then_let_the_other_pass_win)

    queries_runs.apply_file_rollup(db, RUN, first)

    run = db["test_runs"].find_one({"_id": RUN})
    assert run["file_count"] == 2
    assert run["signal_count"] == 2


def test_the_guard_moves_the_sequence_on_every_write(db) -> None:
    """The guard needs a value that changes, or a second write can never miss."""
    _seed_run(db)

    apply_file_rollup(db, RUN, _register(db, _file("f-1"), ["A"]))
    after_one = db["test_runs"].find_one({"_id": RUN})["rollup_seq"]
    apply_file_rollup(db, RUN, _register(db, _file("f-2"), ["B"]))
    after_two = db["test_runs"].find_one({"_id": RUN})["rollup_seq"]

    assert after_one == 1
    assert after_two == 2
