"""Accepting a draft notebook: /test-runs/{run_id}/notebooks/{notebook_id}/draft.

A draft notebook (one whose row carries `definition_id`) holds an AI cell that writes
the definition's `evaluate()`. The preview lifts that code out of the notebook file as
the module Accept would store; accept stores it through the definition's implementation
upload route, so every gate and journal entry of that route applies unchanged.

Nothing here starts a lab or talks to the Portal: the notebook file is in blob, where
QuixLab writes each edit as it happens. **Nothing here writes a verdict either** - a
draft's trial run is not evidence, and the verdict rollups count every one they find.
"""

import hashlib
import io
import logging
from typing import Annotated

from fastapi import APIRouter, Depends, UploadFile
from pymongo.database import Database

from api import quixlab_provision
from api.auth import require_token
from api.db import get_db
from api.errors import ApiError
from api.models.integrations import DraftAcceptRequest, DraftImplementation
from api.models.planning import DefinitionImplementation
from api.quix_identity import Identity
from api.routers import test_definitions
from api.routers.quixlab_labs import COLLECTION
from api.services import file_bytes, file_writes, quixlab_accept

logger = logging.getLogger(__name__)

router = APIRouter(tags=["integrations"])


def _read_notebook(reader: file_bytes.FileBytesProvider, run_id: str, notebook_id: str) -> str:
    key = quixlab_provision.notebook_key(run_id, notebook_id)
    try:
        chunks, _size = reader.open(f"blob://{key}")
        return b"".join(chunks).decode("utf-8")
    except file_bytes.FileBytesUnavailable as error:
        logger.error("draft notebook %s/%s unreadable: %s", run_id, notebook_id, error.detail)
        if error.reason == "blob_missing":
            raise ApiError(
                404, "the notebook file is not in storage", "notebook_file_not_found"
            ) from error
        raise ApiError(503, error.detail, "storage_unreachable") from error
    except UnicodeDecodeError as error:
        logger.error("draft notebook %s/%s is not utf-8: %s", run_id, notebook_id, error)
        raise ApiError(422, "the notebook file is not utf-8 text", "draft_invalid") from error
    except Exception as error:  # the store states its own failure type
        logger.exception("draft notebook %s/%s read failed", run_id, notebook_id)
        raise ApiError(
            503, f"the notebook could not be read back: {error}", "storage_unreachable"
        ) from error


def _draft(
    db: Database, reader: file_bytes.FileBytesProvider, run_id: str, notebook_id: str
) -> DraftImplementation:
    """The module the draft notebook's `draft` cell holds right now, with its digest."""
    row = db[COLLECTION].find_one({"_id": notebook_id, "run_id": run_id})
    if row is None:
        raise ApiError(404, f"run {run_id} has no notebook {notebook_id}", "notebook_not_found")
    td_id = row.get("definition_id")
    if not td_id:
        raise ApiError(409, f"notebook {notebook_id} is not a draft", "not_a_draft")

    source = _read_notebook(reader, run_id, notebook_id)
    try:
        code = quixlab_accept.draft_implementation(source)
    except quixlab_accept.DraftNotGenerated as error:
        logger.info("draft %s/%s has nothing to accept: %s", run_id, notebook_id, error)
        raise ApiError(422, str(error), "draft_not_generated") from error
    except quixlab_accept.DraftInvalid as error:
        logger.warning("draft %s/%s refused: %s", run_id, notebook_id, error)
        raise ApiError(422, str(error), "draft_invalid") from error

    sha = hashlib.sha256(code.encode("utf-8")).hexdigest()
    return DraftImplementation(definition_id=td_id, filename=f"{td_id}.py", code=code, sha256=sha)


@router.get("/test-runs/{run_id}/notebooks/{notebook_id}/draft", response_model=DraftImplementation)
def preview_draft(
    run_id: str,
    notebook_id: str,
    db: Annotated[Database, Depends(get_db)],
    reader: Annotated[file_bytes.FileBytesProvider, Depends(file_bytes.get_file_bytes_provider)],
) -> DraftImplementation:
    """The module Accept would store, exactly: 409 `not_a_draft`, 422 before it is generated."""
    draft = _draft(db, reader, run_id, notebook_id)
    logger.info(
        "draft %s/%s previewed for %s: %d bytes, sha256 %s",
        run_id,
        notebook_id,
        draft.definition_id,
        len(draft.code),
        draft.sha256[:12],
    )
    return draft


@router.post(
    "/test-runs/{run_id}/notebooks/{notebook_id}/draft/accept",
    response_model=DefinitionImplementation,
    status_code=201,
)
def accept_draft(
    run_id: str,
    notebook_id: str,
    body: DraftAcceptRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
    reader: Annotated[file_bytes.FileBytesProvider, Depends(file_bytes.get_file_bytes_provider)],
    writer: Annotated[file_writes.FileBytesWriter, Depends(file_writes.get_file_writer)],
) -> DefinitionImplementation:
    """Store the previewed module as the definition's implementation.

    409 `draft_changed` when the cell's code is no longer the one previewed: the person
    accepts what they read. The store goes through `upload_implementation` itself, so the
    size cap, the journal entry and the pointer write are that route's, not a copy.
    """
    draft = _draft(db, reader, run_id, notebook_id)
    if draft.sha256 != body.sha256.strip().lower():
        logger.warning(
            "draft %s/%s changed since its preview: %s != %s",
            run_id,
            notebook_id,
            draft.sha256[:12],
            body.sha256[:12],
        )
        raise ApiError(
            409, "the draft changed since it was previewed; review it again", "draft_changed"
        )

    upload = UploadFile(io.BytesIO(draft.code.encode("utf-8")), filename=draft.filename)
    stored = test_definitions.upload_implementation(
        draft.definition_id, db=db, identity=identity, writer=writer, file=upload, entrypoint=None
    )
    logger.info(
        "draft %s/%s accepted as the implementation of %s: sha256 %s",
        run_id,
        notebook_id,
        draft.definition_id,
        draft.sha256[:12],
    )
    return stored
