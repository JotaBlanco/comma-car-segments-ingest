"""Run one notebook headless as a QuixLab Job, and read its result back.

A run is a Job that executes the notebook once with `QUIXLAB_MODE=run` and exits
(`quixlab/docs/headless-launcher-contract.md`). It clones the workspace's QuixLab
deployment (`quixlab_provision.template_row`), so no image is built.

**One Job per name, found by name.** Starting while that Job is still going answers
the same Job; starting after it finished deletes the old one and creates a new one.

**The exit code is authoritative.** It comes from `/deployments/{id}/runs`, and the
outputs from the last stdout line QuixLab prints,
`{"runId", "status", "exitCode", "manifest", "outputs", "error"}`. No such line and a
non-zero exit means the process died: an infrastructure failure, never a test result.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from api import quix_identity, quixlab_provision
from api.quixlab_provision import NoTemplate, read_text

logger = logging.getLogger(__name__)

RUNS_PATH = "/deployments/{deployment_id}/runs"
LOG_PATH = "/deployments/{deployment_id}/logs/history/download"

# The Portal's words for a deployment that will not change again, lowercased.
TERMINAL = frozenset(
    {
        "completed",
        "stopped",
        "failed",
        "crashed",
        "runtimeerror",
        "deploymentfailed",
        "buildfailed",
    }
)
# A Job still coming up or running. Any other status, empty included, is replaced.
IN_PROGRESS = frozenset({"queued", "building", "deploying", "starting", "running", "pending"})
# Terminal states where the container may never have run, so no run record ever lands.
NEVER_RAN = frozenset({"deploymentfailed", "buildfailed"})

STATE_RUNNING = "running"
STATE_FINISHED = "finished"
STATE_FAILED = "failed"


@dataclass(frozen=True)
class RunJob:
    """One headless run Job, as the Portal accepted it."""

    id: str
    name: str
    status: str


@dataclass(frozen=True)
class RunResult:
    """Where a run Job stands, and what it produced once it is done."""

    deployment_id: str
    state: str
    status: str
    exit_code: int | None = None
    run_id: str | None = None
    outputs: dict[str, Any] | None = None
    error: str | None = None


def build_run_spec(
    template: Mapping[str, Any], *, name: str, notebook: str, params: Mapping[str, Any] | None
) -> dict[str, Any]:
    """Clone one QuixLab deployment into a create request for a headless run Job.

    Pure. No public address, no state volume, no network block: a Job serves nothing.
    """
    spec: dict[str, Any] = {
        key: template[key]
        for key in ("workspaceId", "applicationId", "image", "cpuMillicores", "memoryInMb")
        if template.get(key) is not None
    }
    overrides = {"QUIXLAB_MODE": "run", "QUIXLAB_NOTEBOOK": notebook}
    if params is not None:
        overrides["QUIXLAB_PARAMS"] = json.dumps(dict(params))
    spec.update(
        {
            "name": name,
            "deploymentType": "Job",
            "replicas": 1,
            "useLatest": True,
            "publicAccess": False,
            "stateEnabled": False,
            "autoStart": True,
            "blobStorageBind": True,
            "plugin": {"enabled": False, "isEnabled": False},
            "variables": quixlab_provision.clone_variables(template, overrides),
        }
    )
    return spec


def result_line(log_text: str) -> dict[str, Any] | None:
    """The newest `{"runId": …}` line QuixLab printed, from a newest-first, BOM-prefixed log."""
    for line in log_text.lstrip("﻿").splitlines():
        stripped = line.strip()
        if not stripped.startswith('{"runId"'):
            continue
        try:
            parsed = json.loads(stripped)
        except ValueError:
            logger.warning("quixlab run: a result line did not parse as JSON; skipped")
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _exit_code(record: Mapping[str, Any]) -> int | None:
    code = record.get("exitCode")
    try:
        return None if code is None else int(code)
    except (TypeError, ValueError):
        return None


def finished_result(
    deployment_id: str, status: str, exit_code: int, line: Mapping[str, Any] | None
) -> RunResult:
    """Map a finished Job's exit code and result line to a result. The exit code decides."""
    if line is None:
        if exit_code == 0:
            return RunResult(
                deployment_id,
                STATE_FINISHED,
                status,
                exit_code=0,
                error="the run exited 0 but printed no result line; its outputs are unknown",
            )
        return RunResult(
            deployment_id,
            STATE_FAILED,
            status,
            exit_code=exit_code,
            error=(
                f"the run process died (exit {exit_code}) without a result line: "
                "an infrastructure failure, not a test result"
            ),
        )
    outputs = line.get("outputs")
    error = line.get("error")
    return RunResult(
        deployment_id,
        STATE_FINISHED if exit_code == 0 else STATE_FAILED,
        status,
        exit_code=exit_code,
        run_id=str(line["runId"]) if line.get("runId") is not None else None,
        outputs=outputs if isinstance(outputs, dict) else None,
        error=str(error) if error else (None if exit_code == 0 else f"the run exited {exit_code}"),
    )


def start_run(token: str, *, name: str, notebook: str, params: Mapping[str, Any] | None) -> RunJob:
    """Start the headless run Job `name` on `notebook`, replacing a finished earlier one.

    A Job that is still going is answered as-is, so a second click never starts a second run.
    """
    started = time.monotonic()
    workspace = quixlab_provision.workspace()
    with quixlab_provision.client() as http:
        rows = quixlab_provision.deployment_rows(http, token, workspace)
        existing = quixlab_provision.find(rows, name)
        if existing is not None:
            existing_id = read_text(existing, "deploymentId")
            existing_status = read_text(existing, "status")
            if existing_status.lower() in IN_PROGRESS:
                logger.info(
                    "quixlab run job %s (%s) still %s; answering it",
                    name,
                    existing_id,
                    existing_status,
                )
                return RunJob(existing_id, name, existing_status)
            quixlab_provision.delete_deployment(http, token, existing_id)
            logger.info(
                "quixlab run job %s (%s) was %s; deleted to run again",
                name,
                existing_id,
                existing_status,
            )

        template = quixlab_provision.template_row(rows)
        if template is None:
            raise NoTemplate("the workspace holds no QuixLab deployment to clone")
        template_id = read_text(template, "deploymentId")
        full = quix_identity.portal_get(
            http, quixlab_provision.DEPLOYMENT_PATH.format(deployment_id=template_id), token
        ).json()
        spec = build_run_spec(full, name=name, notebook=notebook, params=params)
        created = quixlab_provision.portal_send(
            http, "POST", quixlab_provision.DEPLOYMENTS_PATH, token, spec
        ).json()
    row = created if isinstance(created, dict) else {}
    job = RunJob(read_text(row, "deploymentId", "id"), name, read_text(row, "status") or "Queued")
    logger.info(
        "quixlab run job %s (%s) created from template %s on %s, params=%s, in %.0f ms",
        name,
        job.id,
        template_id,
        notebook,
        sorted(params) if params else [],
        (time.monotonic() - started) * 1000,
    )
    return job


def _run_records(response: httpx.Response) -> list[dict[str, Any]]:
    """The `/runs` rows, newest first. An empty body or `null` is no run yet, not a refusal."""
    if not response.content.strip():
        return []
    try:
        body = response.json()
    except ValueError as error:
        raise quix_identity.PlatformUnreachable(
            "the Quix platform returned a /runs body we cannot read"
        ) from error
    if body is None:
        return []
    if not isinstance(body, list):
        raise quix_identity.PlatformRefused("the Quix platform did not answer /runs with a list")
    return [row for row in body if isinstance(row, dict)]


def _read_result(http: httpx.Client, token: str, deployment_id: str, status: str) -> RunResult:
    """A terminal Job's result, or `running` while its run record and log are still landing."""
    runs = _run_records(
        quix_identity.portal_get(http, RUNS_PATH.format(deployment_id=deployment_id), token)
    )
    record = runs[0] if runs else {}
    exit_code = _exit_code(record)
    if exit_code is None:
        if status.lower() in NEVER_RAN:
            return RunResult(
                deployment_id, STATE_FAILED, status, error=f"the run Job never ran: {status}"
            )
        return RunResult(deployment_id, STATE_RUNNING, status)
    if not record.get("logsStored"):
        # A log read before it is stored lacks the result line and reads as a dead process.
        return RunResult(deployment_id, STATE_RUNNING, status, exit_code=exit_code)
    try:
        log = quix_identity.portal_get(
            http,
            LOG_PATH.format(deployment_id=deployment_id),
            token,
            params={"includeTimestamp": "false"},
        )
    except quix_identity.PlatformUnreachable as error:
        logger.warning("quixlab run job %s log not readable yet: %s", deployment_id, error)
        return RunResult(deployment_id, STATE_RUNNING, status, exit_code=exit_code)
    line = result_line(log.text)
    if line is None:
        logger.warning("quixlab run job %s exited %s with no result line", deployment_id, exit_code)
    return finished_result(deployment_id, status, exit_code, line)


def poll_run(token: str, *, name: str) -> RunResult | None:
    """Where the run Job `name` stands; None when the Portal holds no Job of that name."""
    started = time.monotonic()
    workspace = quixlab_provision.workspace()
    with quixlab_provision.client() as http:
        row = quixlab_provision.find(
            quixlab_provision.deployment_rows(http, token, workspace), name
        )
        if row is None:
            logger.info("quixlab run job %s not found", name)
            return None
        deployment_id = read_text(row, "deploymentId")
        status = read_text(row, "status")
        if status.lower() not in TERMINAL:
            logger.debug("quixlab run job %s (%s) is %s", name, deployment_id, status)
            return RunResult(deployment_id, STATE_RUNNING, status)
        result = _read_result(http, token, deployment_id, status)
    if result.state != STATE_RUNNING:
        logger.info(
            "quixlab run job %s (%s) %s: status=%s exit_code=%s run_id=%s error=%s, in %.0f ms",
            name,
            deployment_id,
            result.state,
            status,
            result.exit_code,
            result.run_id,
            result.error,
            (time.monotonic() - started) * 1000,
        )
    return result


def delete_run(token: str, deployment_id: str) -> None:
    """Delete one run Job, once its result is safely recorded."""
    with quixlab_provision.client() as http:
        quixlab_provision.delete_deployment(http, token, deployment_id)


__all__ = [
    "STATE_FAILED",
    "STATE_FINISHED",
    "STATE_RUNNING",
    "RunJob",
    "RunResult",
    "build_run_spec",
    "delete_run",
    "finished_result",
    "poll_run",
    "result_line",
    "start_run",
]
