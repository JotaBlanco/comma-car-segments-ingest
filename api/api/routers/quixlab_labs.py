"""A run's QuixLab notebooks: /test-runs/{run_id}/notebooks and the labs that open them.

A notebook is a file in a blob folder of its own under the run, and a run holds as
many as its people make. Opening one spins up a QuixLab of the VIEWER's own on that
folder; Save and Close stops the lab and leaves the notebook where QuixLab wrote it,
so the next Open starts the same lab on the same work. `api/quixlab_provision.py`
carries the deployment recipe and its reasons; this module is the HTTP edge, the
`notebooks` collection and the argument gathering.

**Every lab runs as the viewer, not as this service.** The Portal token arrives in
`x-portal-token`, the header `explore_chat.py` and `integrations.py` already read,
and no route here has a credential of its own. A viewer with no token can LIST the
notebooks - they are the run's - but gets 403 rather than a lab owned by the
service identity.

**Open is idempotent.** It answers the existing lab when there is one, so a person
who clicks twice, or reloads while the container is still building, gets the same
deployment rather than a second one.
"""

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pymongo.database import Database

from api import quix_identity, quixlab_provision
from api.db import get_db
from api.errors import ApiError
from api.models.integrations import Notebook, NotebookCreateRequest, RunQuixLab
from api.services import (
    file_bytes,
    file_writes,
    lake,
    queries_runs,
    quixlab_notebook,
    run_deletion,
)

logger = logging.getLogger(__name__)

COLLECTION = "notebooks"

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
    """The lake partition values the run document itself names, by the lake's column names.

    Only the fallback for `_run_folders`: `project` is the work order's planning name, and
    the sink partitions on the platform the MF4 header states, which may be spelled apart.
    Spaces become underscores, the spelling the seeded battery traces carry.
    """
    return {
        "platform": re.sub(r"\s+", "_", (run.get("project") or "").strip()),
        "work_order": (run.get("work_order_id") or run.get("claimed_work_order_id") or "").strip(),
        "run_id": str(run.get("_id") or run.get("run_id") or "").strip(),
    }


def _run_folders(table: str, run: dict) -> list[str]:
    """The run's own folders of the lake, as the lake lists them; the run document otherwise."""
    run_id = str(run.get("_id") or run.get("run_id") or "")
    if lake.is_configured():
        try:
            folders = lake.run_partitions(table, run_id)
        except lake.LakeError as error:
            logger.warning("the lake folders of run %s were not listed: %s", run_id, error)
        else:
            if folders:
                logger.info("run %s opens on %d lake folder(s) of %s", run_id, len(folders), table)
                return folders
            logger.info("the lake holds no folder of run %s in %s yet", run_id, table)
    return [quixlab_notebook.partition_path(_partitions(run))]


def _lab_dto(lab: quixlab_provision.Lab) -> RunQuixLab:
    return RunQuixLab(
        id=lab.id,
        name=lab.name,
        status=lab.status,
        url=lab.url,
        notebook=lab.notebook,
        created=lab.created,
    )


def _portal(call, *args, **kwargs):
    """One Portal call, its failures as this API's answers."""
    try:
        return call(*args, **kwargs)
    except quixlab_provision.NoTemplate as error:
        raise ApiError(503, str(error), "quixlab_no_template") from error
    except quix_identity.PlatformRefused as error:
        raise ApiError(403, str(error), "quixlab_refused") from error
    except quix_identity.PlatformUnreachable as error:
        raise ApiError(503, str(error), "quixlab_unreachable") from error


def _notebook(db: Database, run_id: str, notebook_id: str) -> dict:
    row = db[COLLECTION].find_one({"_id": notebook_id, "run_id": run_id})
    if row is None:
        raise ApiError(404, f"run {run_id} has no notebook {notebook_id}", "notebook_not_found")
    return row


def _ensure(
    token: str,
    identity,
    run_id: str,
    notebook_id: str,
    source: str | None,
    writer: file_writes.FileBytesWriter,
) -> quixlab_provision.Lab:
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

    return _portal(
        quixlab_provision.ensure_lab,
        token,
        run_id=run_id,
        notebook_id=notebook_id,
        user_id=identity.user_id,
        notebook_source=source,
        write_notebook=write,
    )


@router.get("/notebooks", response_model=list[Notebook])
def list_all_notebooks(
    request: Request, db: Annotated[Database, Depends(get_db)]
) -> list[Notebook]:
    """Every notebook of every run, newest first: the Workflows page.

    One Mongo read and, when the caller sent a token, one Portal read for this viewer's
    labs on all of them. Like the run's own list it makes nothing, and a person not
    signed in to the platform still sees what is there.
    """
    rows = list(db[COLLECTION].find({}).sort("created_at", -1))
    token = (request.headers.get("x-portal-token") or "").strip()
    labs: dict[tuple[str, str], quixlab_provision.Lab] = {}
    if token and rows:
        identity = _identity(token)
        labs = _portal(
            quixlab_provision.find_labs_across_runs,
            token,
            notebooks=[(row["run_id"], row["_id"]) for row in rows],
            user_id=identity.user_id,
        )
    return [
        Notebook.model_validate(
            {
                **row,
                "lab": (
                    _lab_dto(labs[(row["run_id"], row["_id"])])
                    if (row["run_id"], row["_id"]) in labs
                    else None
                ),
            }
        )
        for row in rows
    ]


@router.get("/test-runs/{run_id}/notebooks", response_model=list[Notebook])
def list_notebooks(
    run_id: str, request: Request, db: Annotated[Database, Depends(get_db)]
) -> list[Notebook]:
    """The run's notebooks, oldest first, each with this viewer's lab on it when there is one.

    The labs come from one Portal read, and only when the caller sent a token: the list is
    the run's, and a person who is not signed in to the platform still sees what is there.
    """
    queries_runs.get_run(db, run_id)
    rows = list(db[COLLECTION].find({"run_id": run_id}).sort("created_at", 1))
    token = (request.headers.get("x-portal-token") or "").strip()
    labs: dict[str, quixlab_provision.Lab] = {}
    if token and rows:
        identity = _identity(token)
        labs = _portal(
            quixlab_provision.find_labs,
            token,
            run_id=run_id,
            notebook_ids=[row["_id"] for row in rows],
            user_id=identity.user_id,
        )
    return [
        Notebook.model_validate(
            {**row, "lab": _lab_dto(labs[row["_id"]]) if row["_id"] in labs else None}
        )
        for row in rows
    ]


@router.post("/test-runs/{run_id}/notebooks", response_model=Notebook, status_code=201)
def create_notebook(
    run_id: str,
    body: NotebookCreateRequest,
    request: Request,
    db: Annotated[Database, Depends(get_db)],
    writer: Annotated[file_writes.FileBytesWriter, Depends(file_writes.get_file_writer)],
) -> Notebook:
    """A new notebook on this run, its starter file written, and this viewer's lab started on it.

    404 when the registry has no such run — a notebook for a run that does not exist would
    open on an empty query. 503 when there is no QuixLab to clone or no blob store to write
    the notebook into, because both are the deployment's wiring and neither is the caller's
    mistake. The row is written AFTER the lab exists: a notebook the list shows must have a
    file behind it.
    """
    token = _viewer(request)
    identity = _identity(token)
    run = queries_runs.get_run(db, run_id)
    # The one answer to "which table holds this run's samples", already written.
    table = run_deletion.lake_table_of(run)
    try:
        source = quixlab_notebook.notebook_source(
            run_id=run_id, table=table, folders=_run_folders(table, run)
        )
    except quixlab_notebook.UnsafeValue as error:
        raise ApiError(500, str(error), "quixlab_unsafe_value") from error

    notebook_id = f"nb-{uuid.uuid4().hex[:12]}"
    name = (
        body.name or ""
    ).strip() or f"Notebook {db[COLLECTION].count_documents({'run_id': run_id}) + 1}"
    lab = _ensure(token, identity, run_id, notebook_id, source, writer)
    row = {
        "_id": notebook_id,
        "run_id": run_id,
        "name": name,
        "created_by": identity.display_name or identity.user_id,
        "created_at": datetime.now(UTC),
        "saved_at": None,
    }
    db[COLLECTION].insert_one(row)
    return Notebook.model_validate({**row, "lab": _lab_dto(lab)})


@router.post("/test-runs/{run_id}/notebooks/{notebook_id}/open", response_model=Notebook)
def open_notebook(
    run_id: str,
    notebook_id: str,
    request: Request,
    db: Annotated[Database, Depends(get_db)],
    writer: Annotated[file_writes.FileBytesWriter, Depends(file_writes.get_file_writer)],
) -> Notebook:
    """This viewer's lab on a saved notebook, started or made, and the file NEVER written over.

    The notebook is already in its folder - it was written when the notebook was made and
    QuixLab has been keeping it since - so a stopped lab is started and a missing one (a
    colleague's notebook, or a lab somebody removed) is created on the same folder.
    """
    token = _viewer(request)
    identity = _identity(token)
    row = _notebook(db, run_id, notebook_id)
    lab = _ensure(token, identity, run_id, notebook_id, None, writer)
    return Notebook.model_validate({**row, "lab": _lab_dto(lab)})


@router.get("/test-runs/{run_id}/notebooks/{notebook_id}/lab", response_model=RunQuixLab)
def get_notebook_lab(
    run_id: str, notebook_id: str, request: Request, db: Annotated[Database, Depends(get_db)]
) -> RunQuixLab:
    """This viewer's lab for this notebook, or 404 when they have none.

    The panel polls this while a freshly created lab builds, so it makes nothing: a poll
    must be cheap, and it must never be the call that creates a second deployment.
    """
    token = _viewer(request)
    identity = _identity(token)
    _notebook(db, run_id, notebook_id)
    lab = _portal(
        quixlab_provision.find_lab,
        token,
        run_id=run_id,
        notebook_id=notebook_id,
        user_id=identity.user_id,
    )
    if lab is None:
        raise ApiError(404, "no QuixLab on this notebook yet", "quixlab_not_found")
    return _lab_dto(lab)


@router.post("/test-runs/{run_id}/notebooks/{notebook_id}/close", response_model=Notebook)
def close_notebook(
    run_id: str,
    notebook_id: str,
    request: Request,
    db: Annotated[Database, Depends(get_db)],
    reader: Annotated[file_bytes.FileBytesProvider, Depends(file_bytes.get_file_bytes_provider)],
) -> Notebook:
    """Save and Close: the notebook confirmed on disk, its save recorded, then the lab stopped.

    QuixLab writes the notebook a person edits back into its own folder as they go, so
    there is nothing to copy: the save is the CHECK that the file is there and readable,
    and the timestamp. **A failed check stops nothing.** Losing the lab before the work is
    known to be on disk would lose the work; a lab that keeps running after a refused save
    costs a container, which is the cheaper mistake.

    The lab is STOPPED, not removed. Its blob root keeps the notebook, and Open later
    restarts it there in seconds where a new lab would build.
    """
    token = _viewer(request)
    identity = _identity(token)
    row = _notebook(db, run_id, notebook_id)
    lab = _portal(
        quixlab_provision.find_lab,
        token,
        run_id=run_id,
        notebook_id=notebook_id,
        user_id=identity.user_id,
    )
    if lab is None:
        raise ApiError(404, "no QuixLab on this notebook yet", "quixlab_not_found")

    key = quixlab_provision.notebook_key(run_id, notebook_id)
    try:
        chunks, _size = reader.open(f"blob://{key}")
        size = sum(len(chunk) for chunk in chunks)
    except file_bytes.FileBytesUnavailable as error:
        raise ApiError(503, error.detail, "storage_unreachable") from error
    except Exception as error:  # the store states its own failure type
        raise ApiError(
            503, f"the notebook could not be read back: {error}", "storage_unreachable"
        ) from error
    if size == 0:
        raise ApiError(
            503, "the notebook on disk is empty; not stopping the lab", "storage_unreachable"
        )

    now = datetime.now(UTC)
    db[COLLECTION].update_one({"_id": notebook_id}, {"$set": {"saved_at": now, "size_bytes": size}})
    row = {**row, "saved_at": now}
    try:
        stopped = quixlab_provision.stop_lab(
            token, run_id=run_id, notebook_id=notebook_id, user_id=identity.user_id
        )
    except quix_identity.PlatformRefused as error:
        raise ApiError(403, str(error), "quixlab_refused") from error
    except quix_identity.PlatformUnreachable as error:
        # The notebook is saved; only the container is still up. Say exactly that.
        raise ApiError(
            503, f"the notebook is saved, but the lab did not stop: {error}", "quixlab_unreachable"
        ) from error
    return Notebook.model_validate({**row, "lab": _lab_dto(stopped or lab)})


@router.post("/test-runs/{run_id}/notebooks/{notebook_id}/stop", response_model=Notebook)
def stop_notebook(
    run_id: str, notebook_id: str, request: Request, db: Annotated[Database, Depends(get_db)]
) -> Notebook:
    """Stop this viewer's lab on the notebook, and record nothing.

    The list's Stop control: a lab left running costs a container, and a person who is
    not in the notebook has nothing to save. QuixLab pushes every edit to the notebook's
    folder as it goes, so nothing is lost either; `saved_at` stays what Save and Close
    last wrote. 404 when there is no lab to stop.
    """
    token = _viewer(request)
    identity = _identity(token)
    row = _notebook(db, run_id, notebook_id)
    lab = _portal(
        quixlab_provision.stop_lab,
        token,
        run_id=run_id,
        notebook_id=notebook_id,
        user_id=identity.user_id,
    )
    if lab is None:
        raise ApiError(404, "no QuixLab on this notebook yet", "quixlab_not_found")
    return Notebook.model_validate({**row, "lab": _lab_dto(lab)})


@router.delete("/test-runs/{run_id}/notebooks/{notebook_id}", status_code=204)
def delete_notebook(
    run_id: str, notebook_id: str, request: Request, db: Annotated[Database, Depends(get_db)]
) -> None:
    """Forget a notebook: this viewer's lab on it removed, then the row. 204 either way.

    The blob folder stays, as a deleted result's file does: a delete of a row is not a
    delete of bytes. Without a Portal token the row goes and any lab is left to the
    Portal's own housekeeping.
    """
    token = (request.headers.get("x-portal-token") or "").strip()
    if token:
        identity = _identity(token)
        _portal(
            quixlab_provision.remove_lab,
            token,
            run_id=run_id,
            notebook_id=notebook_id,
            user_id=identity.user_id,
        )
    db[COLLECTION].delete_one({"_id": notebook_id, "run_id": run_id})


def drop_run_notebooks(db: Database, request: Request, run_id: str) -> None:
    """Run deletion: the caller's labs on every notebook of the run removed, then the rows.

    The labs are named for the PORTAL viewer, so the viewer is read from the Portal
    token and never from the API's own token - the static identity a service token
    carries names nobody's lab. Never raises: a stuck container is not a failed delete,
    and a run gone from the registry must not come back because a container would not
    stop.
    """
    rows = list(db[COLLECTION].find({"run_id": run_id}, {"_id": 1}))
    token = (request.headers.get("x-portal-token") or "").strip()
    if token and rows:
        try:
            user_id = quix_identity.identify(token).user_id
            for row in rows:
                quixlab_provision.remove_lab(
                    token, run_id=run_id, notebook_id=row["_id"], user_id=user_id
                )
        except Exception as error:  # noqa: BLE001 - see the docstring
            logger.warning("the QuixLabs on run %s were not all removed: %s", run_id, error)
    db[COLLECTION].delete_many({"run_id": run_id})
