import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api_client import build_evaluate_params


def test_build_evaluate_params_empty_when_no_filters():
    assert build_evaluate_params() == {}


def test_build_evaluate_params_includes_only_provided_filters():
    assert build_evaluate_params(test_run_id="run-1") == {"test_run_id": "run-1"}
    assert build_evaluate_params(status="pass") == {"status": "pass"}
    assert build_evaluate_params(test_run_id="run-1", status="pass") == {
        "test_run_id": "run-1",
        "status": "pass",
    }
