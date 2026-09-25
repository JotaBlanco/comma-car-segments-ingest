"""Tests for `api.services.verdict_rollups` — the two read-time verdict folds.

Validates `dev-planning/verdict-rollups/architecture.md`: the runs list says
whether a run was evaluated and how it went (Fold A), and a test definition
says what the runs decided and which run produced it (Fold B). Both folds
resolve the newest verdict of a `(run_id, definition_id)` pair by the highest
`version`, then the newest across runs by `provenance.produced_at`, falling
back to `created_at` and finally the result id — and that reduction must
never depend on the order Mongo returns documents in.
"""

from datetime import UTC, datetime

from api.services import queries_requirements, queries_runs, verdict_rollups
from tests.factories_planning import make_definition, make_run
from tests.factories_results import provenance, seed_result

TD = "TD-1"


def _seed_verdict(
    db,
    *,
    run_id: str,
    td_id: str = TD,
    outcome: str = "pass",
    version: int = 1,
    produced_at: datetime | None = None,
    created_at: datetime | None = None,
    result_id: str | None = None,
) -> dict:
    """One verdict document for `(run_id, td_id)`, the shape `POST /results` writes."""
    return seed_result(
        db,
        _id=result_id or f"res-{run_id}-{td_id}-{version}",
        run_id=run_id,
        result_key=f"verdict/{td_id}",
        name=f"verdict-{td_id}.json",
        version=version,
        supersedes=None,
        verdict={"definition_id": td_id, "outcome": outcome, "evidence": {}},
        provenance=provenance(produced_at=produced_at),
        created_at=created_at or datetime(2026, 9, 20, tzinfo=UTC),
    )


# --- Fold A: run_verdicts — the sum invariant --------------------------------


def test_run_verdicts_tally_partitions_the_run_s_definition_set(db) -> None:
    """§ Fold A: pass + fail + error + none == len(the run's definition_ids)."""
    _seed_verdict(db, run_id="R-A", td_id="TD-1", outcome="pass")
    _seed_verdict(db, run_id="R-A", td_id="TD-2", outcome="fail")

    definition_ids = {
        "R-empty": [],
        "R-unjudged": ["TD-9", "TD-10"],
        "R-A": ["TD-1", "TD-2", "TD-3"],
    }

    counted = verdict_rollups.run_verdicts(db, definition_ids)

    for run_id, ids in definition_ids.items():
        assert sum(counted[run_id].values()) == len(ids), run_id

    assert counted["R-empty"] == {"pass": 0, "fail": 0, "error": 0, "none": 0}
    assert counted["R-unjudged"] == {"pass": 0, "fail": 0, "error": 0, "none": 2}
    assert counted["R-A"] == {"pass": 1, "fail": 1, "error": 0, "none": 1}


def test_a_verdict_for_a_definition_the_run_no_longer_carries_counts_nothing(db) -> None:
    """§ Fold A: 'the set on the run is what the screen shows'."""
    _seed_verdict(db, run_id="R-A", td_id="TD-dropped", outcome="pass")

    counted = verdict_rollups.run_verdicts(db, {"R-A": ["TD-1"]})

    assert counted["R-A"] == {"pass": 0, "fail": 0, "error": 0, "none": 1}


# --- Fold B: definition_verdicts — the five states ----------------------------


def test_definition_verdicts_covers_the_five_states(db) -> None:
    """§ Fold B: not_run, no_verdict, passed, failed, error."""
    _seed_verdict(db, run_id="R-1", td_id="TD-pass", outcome="pass")
    _seed_verdict(db, run_id="R-2", td_id="TD-fail", outcome="fail")
    _seed_verdict(db, run_id="R-3", td_id="TD-error", outcome="error")

    actual_runs = {
        "TD-not-run": 0,
        "TD-no-verdict": 1,
        "TD-pass": 1,
        "TD-fail": 1,
        "TD-error": 1,
    }

    projected = verdict_rollups.definition_verdicts(db, actual_runs)

    assert projected["TD-not-run"] == {"verdict_state": "not_run", "latest_verdict": None}
    assert projected["TD-no-verdict"] == {"verdict_state": "no_verdict", "latest_verdict": None}
    assert projected["TD-pass"]["verdict_state"] == "passed"
    assert projected["TD-fail"]["verdict_state"] == "failed"
    assert projected["TD-error"]["verdict_state"] == "error"
    assert projected["TD-pass"]["latest_verdict"] == {
        "run_id": "R-1",
        "result_id": "res-R-1-TD-pass-1",
        "outcome": "pass",
        "produced_at": None,
    }


def test_a_higher_version_supersedes_within_one_run_definition_pair(db) -> None:
    """§ 'What latest means', reduction 1: version wins within one pair."""
    same_time = datetime(2026, 9, 1, tzinfo=UTC)
    _seed_verdict(db, run_id="R-1", td_id="TD-1", outcome="fail", version=1, produced_at=same_time)
    _seed_verdict(db, run_id="R-1", td_id="TD-1", outcome="pass", version=2, produced_at=same_time)

    projected = verdict_rollups.definition_verdicts(db, {"TD-1": 1})

    assert projected["TD-1"]["verdict_state"] == "passed"


def test_a_definition_re_run_after_a_fix_reads_its_newest_attempt(db) -> None:
    """§ 'What latest means', reduction 2: newest produced_at wins across runs."""
    _seed_verdict(
        db,
        run_id="R-old",
        td_id="TD-1",
        outcome="fail",
        produced_at=datetime(2026, 9, 1, tzinfo=UTC),
    )
    _seed_verdict(
        db,
        run_id="R-new",
        td_id="TD-1",
        outcome="pass",
        produced_at=datetime(2026, 9, 20, tzinfo=UTC),
    )

    projected = verdict_rollups.definition_verdicts(db, {"TD-1": 2})

    assert projected["TD-1"]["verdict_state"] == "passed"
    assert projected["TD-1"]["latest_verdict"]["run_id"] == "R-new"


# --- The tie-break: must never depend on Mongo's return order ----------------


def test_a_tie_on_produced_at_falls_back_to_created_at_every_read(db) -> None:
    """§ 'Ties on produced_at ... fall back to created_at'. Five reads, one answer."""
    same_produced_at = datetime(2026, 9, 20, 10, 0, tzinfo=UTC)
    _seed_verdict(
        db,
        run_id="R-1",
        td_id="TD-1",
        outcome="fail",
        produced_at=same_produced_at,
        created_at=datetime(2026, 9, 20, 9, 0, tzinfo=UTC),
    )
    _seed_verdict(
        db,
        run_id="R-2",
        td_id="TD-1",
        outcome="pass",
        produced_at=same_produced_at,
        created_at=datetime(2026, 9, 20, 9, 30, tzinfo=UTC),
    )

    for _ in range(5):
        projected = verdict_rollups.definition_verdicts(db, {"TD-1": 2})
        assert projected["TD-1"]["verdict_state"] == "passed"
        assert projected["TD-1"]["latest_verdict"]["run_id"] == "R-2"


def test_a_full_tie_falls_back_to_the_result_id_every_read(db) -> None:
    """§ '...and then to the result id, so the answer never depends on the order

    Mongo returned documents in.' Same produced_at AND same created_at; only
    the result id differs, and the greater id must win on every read.
    """
    same_time = datetime(2026, 9, 20, 10, 0, tzinfo=UTC)
    _seed_verdict(
        db,
        run_id="R-1",
        td_id="TD-1",
        outcome="fail",
        produced_at=same_time,
        created_at=same_time,
        result_id="res-aaa",
    )
    _seed_verdict(
        db,
        run_id="R-2",
        td_id="TD-1",
        outcome="pass",
        produced_at=same_time,
        created_at=same_time,
        result_id="res-bbb",
    )

    winners = {
        verdict_rollups.definition_verdicts(db, {"TD-1": 2})["TD-1"]["latest_verdict"]["run_id"]
        for _ in range(5)
    }

    assert winners == {"R-2"}, "res-bbb > res-aaa lexicographically; must win every read"


def test_a_document_with_no_produced_at_falls_back_to_created_at_for_the_key(db) -> None:
    """§ 'a document written before produced_at was mandatory still sorts'."""
    _seed_verdict(
        db,
        run_id="R-old",
        td_id="TD-1",
        outcome="fail",
        created_at=datetime(2020, 1, 1, tzinfo=UTC),
    )
    _seed_verdict(
        db,
        run_id="R-new",
        td_id="TD-1",
        outcome="pass",
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
    )

    projected = verdict_rollups.definition_verdicts(db, {"TD-1": 2})

    assert projected["TD-1"]["latest_verdict"]["run_id"] == "R-new"


# --- `_outcome`: a stored value outside the three never reads as unjudged ----


def test_outcome_reads_an_unrecognised_stored_value_as_error() -> None:
    assert verdict_rollups._outcome({"verdict": {"outcome": "maybe"}}) == "error"
    assert verdict_rollups._outcome({"verdict": None}) == "error"
    assert verdict_rollups._outcome({"verdict": {"outcome": "pass"}}) == "pass"


# --- Wiring: the folds land on the screens the architecture doc names --------


def test_with_verdicts_overlays_the_run_list(db) -> None:
    db["test_runs"].insert_one(make_run(run_id="R-1", definition_ids=["TD-1", "TD-2"]))
    _seed_verdict(db, run_id="R-1", td_id="TD-1", outcome="pass")

    [run] = queries_runs.with_verdicts(db, [db["test_runs"].find_one({"_id": "R-1"})])

    assert run["verdicts"] == {"pass": 1, "fail": 0, "error": 0, "none": 1}


def test_derived_definitions_overlay_verdict_state_beside_status(db) -> None:
    db["test_definitions"].insert_one(
        make_definition(td_id="TD-1", work_order_id=None, planned_runs=1)
    )
    db["test_runs"].insert_one(make_run(run_id="R-1", definition_ids=["TD-1"]))
    _seed_verdict(db, run_id="R-1", td_id="TD-1", outcome="fail")

    [row] = queries_runs._derived_definitions(db)

    assert row["status"] == "on_plan", "plan adherence must not move"
    assert row["verdict_state"] == "failed"
    assert row["latest_verdict"]["run_id"] == "R-1"


def test_get_test_definition_detail_carries_the_same_verdict_state(db) -> None:
    db["test_definitions"].insert_one(
        make_definition(td_id="TD-1", work_order_id=None, planned_runs=1)
    )
    db["test_runs"].insert_one(make_run(run_id="R-1", definition_ids=["TD-1"]))
    _seed_verdict(db, run_id="R-1", td_id="TD-1", outcome="fail")

    detail = queries_runs.get_test_definition_detail(db, "TD-1")

    assert detail["verdict_state"] == "failed"
    assert detail["latest_verdict"]["run_id"] == "R-1"


def test_the_definition_verdict_and_the_requirement_it_covers_can_disagree(db) -> None:
    """architecture.md's Integration section claims the two folds 'read the

    same (run, definition) winners ... so a requirement reading failed and its
    covering definition reading Failed are the same evidence seen from two
    ends'. They do not always: `verdict_rollups.definition_verdicts` picks the
    newest verdict by `produced_at` across every run that carries the
    definition, while `queries_requirements._fold_inputs` walks the covering
    definition's runs newest-`first_data_at`-first and stops at the first one
    that carries ANY verdict. When the run with the newest `first_data_at` is
    not the run with the newest `produced_at`, the two folds can name
    different winning runs — and opposite outcomes.
    """
    db["test_runs"].insert_one(
        make_run(
            run_id="R-early-session-late-verdict",
            definition_ids=["TD-1"],
            first_data_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
    )
    db["test_runs"].insert_one(
        make_run(
            run_id="R-late-session-early-verdict",
            definition_ids=["TD-1"],
            first_data_at=datetime(2026, 6, 1, tzinfo=UTC),
        )
    )
    db["test_definitions"].insert_one(
        make_definition(td_id="TD-1", covers_req_ids=["REQ-1"], work_order_id=None)
    )
    db["requirements"].insert_one(
        {
            "_id": "REQ-1",
            "text": "x",
            "item_version": 1,
            "content_sha256": "a",
            "normative_sha256": "a",
            "status": "Draft",
        }
    )
    _seed_verdict(
        db,
        run_id="R-early-session-late-verdict",
        td_id="TD-1",
        outcome="pass",
        produced_at=datetime(2026, 9, 20, tzinfo=UTC),
    )
    _seed_verdict(
        db,
        run_id="R-late-session-early-verdict",
        td_id="TD-1",
        outcome="fail",
        produced_at=datetime(2026, 2, 1, tzinfo=UTC),
    )

    definition_side = verdict_rollups.definition_verdicts(db, {"TD-1": 2})
    [requirement_side] = queries_requirements._project(db, list(db["requirements"].find()))

    assert definition_side["TD-1"]["verdict_state"] == "passed", "Fold B: newest by produced_at"
    # Per architecture.md, this must be "tested" (Fold B's "passed") to be the
    # "same evidence seen from two ends". Fold A instead reads "failed": it
    # walks the covering definition's runs newest-first_data_at-first and
    # stops at the first that carries ANY verdict, which is a DIFFERENT run
    # here than the one `produced_at` names newest.
    assert requirement_side["verification_state"] == "tested"
