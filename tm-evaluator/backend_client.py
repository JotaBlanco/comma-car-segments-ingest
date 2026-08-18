"""HTTP client for the Test Manager API.

The evaluator deliberately owns exactly one thing the API does not: the criteria
engine and the lake queries. Everything else - artifacts, the baseline resolver,
the registry, the metric formulas, the requirement-verdict precedence, the blob
archive and the outgoing topics - stays in the API, because Quix builds each
application from its own folder and a shared module would have to be duplicated.
Two copies of the metric formulas that can disagree is a worse failure mode than
one HTTP hop.

The in-cluster address is ``http://backend-api`` (the Backend API deployment
declares ``network.serviceName: backend-api`` on port 80).
"""

import logging
import os

import requests

logger = logging.getLogger(__name__)

TIMEOUT_S = 60


class BackendError(RuntimeError):
    """The API refused or failed a call."""


def base_url() -> str:
    return (os.environ.get("BACKEND_API_URL") or "http://backend-api").rstrip("/")


def _get(path: str) -> dict:
    url = f"{base_url()}{path}"
    try:
        response = requests.get(url, timeout=TIMEOUT_S)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise BackendError(f"GET {url} failed: {exc}") from exc
    return response.json()


def _post(path: str, payload: dict) -> dict:
    url = f"{base_url()}{path}"
    try:
        response = requests.post(url, json=payload, timeout=TIMEOUT_S)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise BackendError(f"POST {url} failed: {exc}") from exc
    return response.json()


def evaluation_input(test_run_id: str, run_version: int) -> dict:
    """Run, baseline artifacts, per-case traces and the signal catalogue, in one call."""
    return _get(f"/internal/evaluation-input/{test_run_id}?run_version={run_version}")


def trace_runs(trace_key: str) -> dict:
    """Which runs and cases a completed trace belongs to."""
    return _get(f"/internal/trace-runs/{trace_key}")


def readiness(test_run_id: str, run_version: int) -> dict:
    return _get(f"/test-runs/{test_run_id}/readiness?run_version={run_version}")


def submit_results(payload: dict) -> dict:
    """Hand the per-case results back; the API derives metrics and verdicts."""
    return _post("/internal/evaluations", payload)


def request_evaluation(test_run_id: str, requested_by: str) -> dict:
    """Ask the API to publish a readiness-triggered evaluation request.

    Going through the API rather than producing the message here keeps the run's
    status transition and the message in one place, so a run cannot be marked
    ``evaluating`` without a request having been published.
    """
    return _post(
        f"/test-runs/{test_run_id}/evaluate",
        {"trigger": "readiness", "requested_by": requested_by},
    )
