"""Run one test definition on one test run as a QuixLab headless Job, and read its verdict.

`POST /test-runs/{run_id}/definitions/{td_id}/run` seeds the definition's notebook when
it has none, files the definition's implementation under the run, and starts the Job;
`GET` on the same path polls it and, once the Job finished with a verdict, records that
verdict as a `processed_results` document and deletes the Job. `api/quixlab_run.py`
carries the Job recipe and `api/services/definition_runs.py` the notebook, the
implementation copy and the verdict.

**Every Portal call runs as the viewer.** The Portal token arrives in `x-portal-token`,
the header `routers/integrations.py` reads; no route here has a credential of its own.
"""

import logging
from collections.abc import Callable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pymongo.database import Database

from api import quix_identity, quixlab_provision, quixlab_run
from api.auth import journal_actor_or_id, require_token
from api.db import get_db
from api.errors import ApiError
from api.models.definition_runs import DefinitionRunJob, DefinitionRunResult
from api.models.results import VerdictOut
from api.quix_identity import Identity
from api.services import definition_runs
from api.services.file_bytes import (
    FileBytesProvider,
    FileBytesUnavailable,
    get_file_bytes_provider,
)
from api.services.file_writes import FileBytesWriter, definition_notebook_key, get_file_writer

logger = logging.getLogger(__name__)

router = APIRouter(tags=["test-definitions"])

PATH = "/test-runs/{run_id}/definitions/{td_id}/run"


def _viewer(request: Request) -> str:
    token = (request.headers.get("x-portal-token") or "").strip()
    if not token:
        raise ApiError(
            401,
            "no portal token; a definition run is started as the person who asked for it",
            "quixlab_needs_login",
        )
    return token


def _portal(call: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """One Portal call, its failures as this API's answers."""
    try:
        return call(*args, **kwargs)
    except quixlab_provision.NoTemplate as error:
        raise ApiError(409, str(error), "quixlab_no_template") from error
    except quix_identity.PlatformRefused as error:
        raise ApiError(403, str(error), "quixlab_refused") from error
    except (quix_identity.PlatformUnreachable, quixlab_provision.PlatformMissing) as error:
        raise ApiError(503, str(error), "quixlab_unreachable") from error


def _pair(db: Database, run_id: str, td_id: str) -> tuple[dict, dict]:
    """The run and the definition, or the 404 that names the missing one."""
    run = db["test_runs"].find_one({"_id": run_id})
    if run is None:
        raise ApiError(404, f"Run {run_id} not found", "run_not_found")
    definition = db["test_definitions"].find_one({"_id": td_id})
    if definition is None:
        raise ApiError(404, f"Test definition {td_id} not found", "td_not_found")
    return run, definition


@router.post(PATH, status_code=202)
def start_definition_run(
    run_id: str,
    td_id: str,
    request: Request,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    provider: Annotated[FileBytesProvider, Depends(get_file_bytes_provider)],
    writer: Annotated[FileBytesWriter, Depends(get_file_writer)],
) -> DefinitionRunJob:
    """Run the definition's notebook on this run as a headless Job; 202 while it runs.

    A Job still going on this pair is answered as-is rather than started twice. The
    definition's notebook is seeded with the default wrapper first when it has none,
    and the implementation is copied into this run's blob folder and registered as a
    file of the run, so the Files tab lists what judged the run.
    """
    token = _viewer(request)
    run, definition = _pair(db, run_id, td_id)
    if not ((definition.get("implementation") or {}).get("blob_path") or "").strip():
        raise ApiError(
            404, f"Test definition {td_id} carries no implementation", "implementation_not_found"
        )
    key = definition_notebook_key(td_id)
    try:
        definition_runs.ensure_notebook(provider, writer, key)
    except FileBytesUnavailable as error:
        logger.error("definition notebook %s could not be seeded: %s", key, error.detail)
        raise ApiError(503, error.detail, "storage_unreachable") from error
    try:
        definition_runs.place_implementation(
            db,
            provider,
            writer,
            run=run,
            definition=definition,
            actor=journal_actor_or_id(identity, "test-manager"),
        )
    except FileBytesUnavailable as error:
        logger.error(
            "implementation of %s could not be filed under run %s: %s",
            td_id,
            run_id,
            error.detail,
        )
        raise ApiError(503, error.detail, "storage_unreachable") from error
    job = _portal(
        quixlab_run.start_run,
        token,
        name=quixlab_provision.run_job_name(run_id, td_id),
        notebook=f"blob://{key}",
        params=definition_runs.run_params(run, definition),
    )
    return DefinitionRunJob(id=job.id, name=job.name, status=job.status)


def _stored_answer(name: str, doc: dict, **fields: Any) -> DefinitionRunResult:
    return DefinitionRunResult(
        name=name,
        state="finished",
        result_id=doc["_id"],
        verdict=VerdictOut.model_validate(doc.get("verdict") or {}),
        **fields,
    )


@router.get(PATH)
def get_definition_run(
    run_id: str,
    td_id: str,
    request: Request,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> DefinitionRunResult:
    """Where this pair's run Job stands, and its verdict once it finished.

    A finished Job's verdict is recorded once, then the Job is deleted; a later poll
    answers the stored verdict. A failed Job is kept for debugging until the next run
    replaces it. 404 `run_job_not_found` when there is neither a Job nor a verdict.
    """
    token = _viewer(request)
    run, definition = _pair(db, run_id, td_id)
    name = quixlab_provision.run_job_name(run_id, td_id)
    result = _portal(quixlab_run.poll_run, token, name=name)
    if result is None:
        stored = definition_runs.latest_verdict(db, run_id, td_id)
        if stored is None:
            raise ApiError(404, f"no run of {td_id} on {run_id}", "run_job_not_found")
        return _stored_answer(name, stored)
    fields = {
        "id": result.deployment_id,
        "status": result.status,
        "exit_code": result.exit_code,
        "quixlab_run_id": result.run_id,
    }
    if result.state != quixlab_run.STATE_FINISHED or not definition_runs.has_verdict(result):
        error = result.error
        if result.state == quixlab_run.STATE_FINISHED and error is None:
            error = "the run finished but its outputs carry no verdict"
        return DefinitionRunResult(name=name, state=result.state, error=error, **fields)
    doc = definition_runs.record_verdict(
        db, run=run, definition=definition, result=result, identity=identity
    )
    try:
        quixlab_run.delete_run(token, result.deployment_id)
    except (quix_identity.PlatformRefused, quix_identity.PlatformUnreachable) as error:
        # The verdict is stored and deduplicated by Job id; the next run replaces the Job.
        logger.warning("run job %s not deleted after its verdict: %s", result.deployment_id, error)
    return _stored_answer(name, doc, **fields)
