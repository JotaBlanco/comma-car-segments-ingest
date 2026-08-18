"""Placeholder test implementation for ACC-SYS-TC-001, uploaded by the demo seed.

The test_impl artifact set exists so a baseline can pin all four sets, and so the
Test Implementation page has something to show. Nothing executes it: the unit-test
runner is deferred out of this phase (see tm-evaluator/evaluate_case.py, the
``trace_required: false`` branch, which says the verdict has to be entered
manually while the runner is absent).

The verdict for ACC-SYS-TC-001 is produced by the criteria engine from the
``pass_criteria`` block of the test case, not by this file.
"""


def run(trace: dict) -> dict:
    """Report that this implementation is inert, rather than returning a verdict.

    A stub that returned ``{"verdict": "pass"}`` would be a fabricated result, and
    the whole point of the artifact chain is that a verdict is traceable to the
    criterion that produced it.
    """
    return {
        "verdict": "not_run",
        "reason_code": "runner_deferred",
        "note": (
            "placeholder implementation; the unit-test runner is not part of this phase, "
            f"trace_key={trace.get('trace_key')!r}"
        ),
    }
