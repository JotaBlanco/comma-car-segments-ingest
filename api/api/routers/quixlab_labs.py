"""One QuixLab per viewer per run: POST and DELETE /test-runs/{run_id}/quixlab.

The product used to point every person at ONE shared QuixLab. These two routes
replace that with a lab of the viewer's own, opened on a notebook written into
the run's own folder. `api/quixlab_provision.py` carries the design and the
reasons; this module is the HTTP edge and the argument gathering.

**It runs as the viewer, not as this service.** The Portal token arrives in
`x-portal-token`, the header `explore_chat.py` and `integrations.py` already
read, and no route here has a credential of its own. A viewer with no token
gets 403 rather than a lab owned by the service identity.

**A create is idempotent.** POST answers the existing lab when there is one, so
a person who clicks twice, or reloads while the container is still building,
gets the same deployment rather than a second one.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pymongo.database import Database

from api import quix_identity, quixlab_provision
from api.db import get_db
from api.errors import ApiError
from api.models.integrations import RunQuixLab
from api.services import file_writes, queries_runs, quixlab_notebook, run_deletion

router = APIRouter(tags=["integrations"])


def _viewer(request: Request) -> str:
    token = (request.headers.get("x-portal-token") or "").strip()
    if not token:
        raise ApiError(
            403,
            "no portal token; a QuixLab is created as the person who asked for it",
            "quixlab_needs_login",
        )
    return token


def _identity(token: str):
    try:
        return quix_identity.identify(token)
    except quix_identity.PlatformRefused as error:
        raise ApiError(403, str(error), "quixlab_refused") from error
    except quix_identity.PlatformUnreachable as error:
        raise ApiError(503, str(error), "quixlab_unreachable") from error


def _partitions(run: dict) -> dict[str, str]:
    """The lake partition values this run names, by the lake's own column names.

    `project` is what the registry calls the platform, and `platform` is what
    the sink partitions on — the WorkOrder config carries the value across
    (`$.project`). The mapping lives here so the notebook module needs to know
    nothing about a run document.
    """
    return {
        "platform": (run.get("project") or "").strip(),
        "work_order": (run.get("work_order_id") or "").strip(),
        "test_definition": (run.get("definition_id") or "").strip(),
    }


@router.post("/test-runs/{run_id}/quixlab", response_model=RunQuixLab)
def create_run_quixlab(
    run_id: str,
    request: Request,
    db: Annotated[Database, Depends(get_db)],
    writer: Annotated[file_writes.FileBytesWriter, Depends(file_writes.get_file_writer)],
) -> RunQuixLab:
    """This viewer's QuixLab for this run, made if it is not there yet.

    404 when the registry has no such run — a lab for a run that does not
    exist would open on an empty query. 503 when there is no QuixLab to clone
    or no blob store to write the notebook into, because both are the
    deployment's wiring and neither is the caller's mistake.
    """
    token = _viewer(request)
    identity = _identity(token)
    run = queries_runs.get_run(db, run_id)
    # The one answer to "which table holds this run's samples", already written.
    table = run_deletion.lake_table_of(run)

    try:
        source = quixlab_notebook.notebook_source(
            run_id=run_id, table=table, parts=_partitions(run)
        )
    except quixlab_notebook.UnsafeValue as error:
        raise ApiError(500, str(error), "quixlab_unsafe_value") from error

    def write(key: str, text: str) -> None:
        try:
            writer.check_ready()
            writer.write(key, iter([text.encode("utf-8")]))
        except Exception as error:  # the writer states its own failure type
            raise ApiError(
                503,
                f"the notebook could not be stored: {error}",
                "quixlab_storage_unavailable",
            ) from error

    try:
        lab = quixlab_provision.ensure_lab(
            token,
            run_id=run_id,
            user_id=identity.user_id,
            notebook_source=source,
            write_notebook=write,
        )
    except quixlab_provision.NoTemplate as error:
        raise ApiError(503, str(error), "quixlab_no_template") from error
    except quix_identity.PlatformRefused as error:
        raise ApiError(403, str(error), "quixlab_refused") from error
    except quix_identity.PlatformUnreachable as error:
        raise ApiError(503, str(error), "quixlab_unreachable") from error

    return RunQuixLab(
        id=lab.id,
        name=lab.name,
        status=lab.status,
        url=lab.url,
        notebook=lab.notebook,
        created=lab.created,
    )


@router.get("/test-runs/{run_id}/quixlab", response_model=RunQuixLab)
def get_run_quixlab(run_id: str, request: Request) -> RunQuixLab:
    """This viewer's lab for this run, or 404 when they have none yet.

    The launch control polls this while a freshly created lab builds, so it
    takes no database read and makes nothing: a poll must be cheap, and it must
    never be the call that creates a second deployment.
    """
    token = _viewer(request)
    identity = _identity(token)
    try:
        lab = quixlab_provision.find_lab(token, run_id=run_id, user_id=identity.user_id)
    except quix_identity.PlatformRefused as error:
        raise ApiError(403, str(error), "quixlab_refused") from error
    except quix_identity.PlatformUnreachable as error:
        raise ApiError(503, str(error), "quixlab_unreachable") from error
    if lab is None:
        raise ApiError(404, "no QuixLab for this run yet", "quixlab_not_found")
    return RunQuixLab(
        id=lab.id,
        name=lab.name,
        status=lab.status,
        url=lab.url,
        notebook=lab.notebook,
        created=False,
    )


@router.delete("/test-runs/{run_id}/quixlab", status_code=204)
def delete_run_quixlab(run_id: str, request: Request) -> None:
    """Remove this viewer's lab for this run. 204 whether or not there was one.

    It takes no database read: the lab is found by a name derived from the
    viewer and the run id, so removing one for a run the registry has already
    forgotten still works — which is exactly what run deletion needs.
    """
    token = _viewer(request)
    identity = _identity(token)
    try:
        quixlab_provision.remove_lab(token, run_id=run_id, user_id=identity.user_id)
    except quix_identity.PlatformRefused as error:
        raise ApiError(403, str(error), "quixlab_refused") from error
    except quix_identity.PlatformUnreachable as error:
        raise ApiError(503, str(error), "quixlab_unreachable") from error
