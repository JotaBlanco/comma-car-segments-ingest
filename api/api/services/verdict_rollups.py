"""The two verdict folds: one per run, one per test definition.

Nothing here is stored. `processed_results` holds one version chain per
`(run_id, result_key)` and a verdict names its definition in
`verdict.definition_id` (`api/api/models/results.py:84-98`).

`newest_per_pair` and `latest_verdict_of` are the two reductions of "the
current verdict of a definition" and `queries_requirements` calls both, so one
rule ranks the candidates on both sides. The candidate *sets* still differ:
the requirements fold drops invalid-flagged runs and runs that no longer carry
the definition, and this module does not.

`dev-planning/verdict-rollups/architecture.md` states both folds and what
"latest" means.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from pymongo import DESCENDING
from pymongo.database import Database

COLLECTION = "processed_results"

# The `verdict_state` each stored outcome reads as
# (`dev-planning/test-results-page/spec.md` §3.3). `error` keeps its own word:
# the evaluator could not decide, which is never a failure.
STATE_WORDS = {"pass": "passed", "fail": "failed", "error": "error"}


def newest_per_pair(db: Database, query: dict) -> dict[tuple[str, str | None], dict]:
    """The highest-version verdict of each `(run_id, definition_id)`.

    The cursor is version-descending, so the first document seen for a pair is
    the current one and every later version of it is a superseded record.
    Shared with `queries_requirements._fold_inputs`.
    """
    newest: dict[tuple[str, str | None], dict] = {}
    for result in db[COLLECTION].find(query).sort("version", DESCENDING):
        block = result.get("verdict") or {}
        newest.setdefault((result["run_id"], block.get("definition_id")), result)
    return newest


def _outcome(result: dict) -> str:
    """The outcome one verdict document states.

    A value outside the three the `Verdict` model allows reads as `error`,
    never as unjudged: the document exists, so something judged it.
    """
    outcome = (result.get("verdict") or {}).get("outcome")
    return outcome if outcome in STATE_WORDS else "error"


def _latest_key(result: dict) -> tuple[Any, Any, str]:
    """Order two verdicts; the greatest is the latest.

    Two verdicts stating the same `produced_at` fall back to `created_at`, the
    registry's own arrival order, and then to the result id, so the answer
    never depends on the order Mongo returned.
    """
    produced_at = (result.get("provenance") or {}).get("produced_at")
    return (produced_at or result["created_at"], result["created_at"], result["_id"])


def latest_verdict_of(candidates: Iterable[dict]) -> dict | None:
    """The current verdict of one definition, across every run that judged it.

    The newest `provenance.produced_at` wins: a verdict states when the test
    case was *evaluated*, so re-running an older trace today makes that the
    current answer. When the data arrived is a separate fact, carried by
    `queries_requirements._state_fold` as `evidence_stale`.

    `definition_verdicts` and `queries_requirements._newest_verdict_of_td` are
    the two callers.
    """
    return max(candidates, key=_latest_key, default=None)


def run_verdicts(db: Database, definition_ids: dict[str, list[str]]) -> dict[str, dict]:
    """Count the newest verdict of every definition each run carries.

    **The unit is this run's test definitions**, not its runs and not its
    requirements. The four counts partition the set — `none` counts the
    definitions nothing has judged yet — so `pass + fail + error` is how many
    of them were evaluated and the total is how many there are.

    A verdict for a definition the run no longer carries is counted by
    nothing: the set on the run is what the screen shows.
    """
    run_ids = [run_id for run_id, td_ids in definition_ids.items() if td_ids]
    newest = (
        newest_per_pair(db, {"run_id": {"$in": run_ids}, "verdict": {"$ne": None}})
        if run_ids
        else {}
    )

    counted: dict[str, dict] = {}
    for run_id, td_ids in definition_ids.items():
        tally = {"pass": 0, "fail": 0, "error": 0, "none": 0}
        for td_id in td_ids:
            result = newest.get((run_id, td_id))
            tally["none" if result is None else _outcome(result)] += 1
        counted[run_id] = tally
    return counted


def definition_verdicts(db: Database, actual_runs: dict[str, int]) -> dict[str, dict]:
    """The `verdict_state` of each definition, and the verdict that decided it.

    `not_run` until a run carries the definition, `no_verdict` while no run
    has judged it, and `passed` / `failed` / `error` after that. A definition
    run again after a fix reads its newest attempt, never its first.

    `actual_runs` maps each definition to how many runs carry it — the count
    the caller has already derived — so `not_run` and `no_verdict` are told
    apart here and not twice on two screens.
    """
    td_ids = list(actual_runs)
    newest = newest_per_pair(db, {"verdict.definition_id": {"$in": td_ids}}) if td_ids else {}
    by_definition: dict[str, list[dict]] = {}
    for (_run_id, td_id), result in newest.items():
        by_definition.setdefault(str(td_id), []).append(result)

    projected: dict[str, dict] = {}
    for td_id, runs in actual_runs.items():
        latest = latest_verdict_of(by_definition.get(td_id) or [])
        if latest is None:
            state = "no_verdict" if runs else "not_run"
            projected[td_id] = {"verdict_state": state, "latest_verdict": None}
            continue
        outcome = _outcome(latest)
        projected[td_id] = {
            "verdict_state": STATE_WORDS[outcome],
            "latest_verdict": {
                "run_id": latest["run_id"],
                "result_id": latest["_id"],
                "outcome": outcome,
                "produced_at": (latest.get("provenance") or {}).get("produced_at"),
            },
        }
    return projected
