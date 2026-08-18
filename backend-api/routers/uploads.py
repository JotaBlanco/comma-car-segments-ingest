"""Upload endpoints - real multipart, real validation at the door.

Replaces ``POST /uploads/test-data``, which accepted JSON only, had no
``python-multipart`` installed, could not receive an MF4 and persisted nothing.

The trace upload streams the request body to a temporary file while hashing it, so
a multi-megabyte MF4 never has to be held in memory, and the content hash that
mints the trace key is computed in the same pass.
"""

import logging
import os
import tempfile

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

import convergence
import deps
import impl_service
import settings
import trace_service
import upload_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/uploads", tags=["uploads"])

CHUNK = 1024 * 1024


def _read_limited(upload: UploadFile) -> bytes:
    limit = settings.max_upload_bytes()
    data = upload.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(
            status_code=413,
            detail=f"upload exceeds TM_MAX_UPLOAD_BYTES ({limit} bytes)",
        )
    if not data:
        raise HTTPException(status_code=400, detail="upload is empty")
    return data


@router.post("/requirements")
def upload_requirements(
    file: UploadFile = File(...),
    uploaded_by: str = Form(""),
    notes: str = Form(""),
) -> dict:
    """Accepts ``.reqif``, ``.reqifz`` and ``.json``; mints one immutable version."""
    deps.require_blob()
    data = _read_limited(file)
    return upload_service.ingest_requirements(file.filename or "", data, uploaded_by, notes)


@router.post("/test-specs")
def upload_test_specs(
    file: UploadFile = File(...),
    uploaded_by: str = Form(""),
    notes: str = Form(""),
) -> dict:
    deps.require_blob()
    data = _read_limited(file)
    return upload_service.ingest_test_specs(file.filename or "", data, uploaded_by, notes)


@router.post("/signal-catalog")
def upload_signal_catalog(
    file: UploadFile = File(...),
    uploaded_by: str = Form(""),
    notes: str = Form(""),
) -> dict:
    deps.require_blob()
    data = _read_limited(file)
    return upload_service.ingest_signal_catalog(file.filename or "", data, uploaded_by, notes)


@router.post("/test-impl")
def upload_test_impl(
    file: UploadFile = File(...),
    tc_id: str = Form(...),
    entrypoint: str = Form(...),
    language: str = Form("python"),
    requirements_file: UploadFile | None = File(None),
    timeout_s: int = Form(120),
    trace_required: bool = Form(True),
    description: str = Form(""),
    uploaded_by: str = Form(""),
    notes: str = Form(""),
) -> dict:
    """One ``.py`` (plus optional ``requirements.txt``) or a ``.zip`` + entrypoint."""
    deps.require_blob()
    data = _read_limited(file)
    requirements_txt = _read_limited(requirements_file) if requirements_file is not None else None
    return impl_service.ingest_test_impl(
        tc_id=tc_id,
        language=language,
        entrypoint=entrypoint,
        filename=file.filename or "",
        data=data,
        created_by=uploaded_by,
        requirements_txt=requirements_txt,
        timeout_s=timeout_s,
        trace_required=trace_required,
        description=description,
        notes=notes,
    )


@router.post("/requirements/convergence-check")
def convergence_check(
    reqif_file: UploadFile = File(...),
    json_file: UploadFile = File(...),
) -> dict:
    """Prove the two upload paths converge, without minting a version.

    A ``converged: false`` response is a release blocker, not a warning.
    """
    left = _read_limited(reqif_file)
    right = _read_limited(json_file)
    return convergence.compare(
        reqif_file.filename or "upload.reqif", left, json_file.filename or "upload.json", right
    )


@router.post("/traces")
def upload_trace(
    file: UploadFile = File(...),
    device_id: str = Form(...),
    sw_version: str = Form(...),
    hw_version: str = Form(...),
    test_run_id: str | None = Form(None),
    tc_ids: list[str] | None = Form(None),
    uploaded_by: str = Form(""),
    db=Depends(deps.get_db),
    bus=Depends(deps.get_bus),
) -> dict:
    """Stream an MF4 to blob and publish one metadata message. Never evaluates."""
    deps.require_blob()
    limit = settings.max_upload_bytes()
    # Not a context manager on purpose: the handle is closed and the file unlinked
    # in the try/finally below, and the *path* has to outlive the handle because
    # trace_service streams the closed file into blob.
    staged = tempfile.NamedTemporaryFile(delete=False, suffix=".mf4")  # noqa: SIM115
    total = 0
    try:
        while True:
            chunk = file.file.read(CHUNK)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise HTTPException(
                    status_code=413,
                    detail=f"upload exceeds TM_MAX_UPLOAD_BYTES ({limit} bytes)",
                )
            staged.write(chunk)
        staged.close()
        if total == 0:
            raise HTTPException(status_code=400, detail="upload is empty")
        return trace_service.ingest_trace(
            db=db,
            bus=bus,
            staged_path=staged.name,
            filename=file.filename or "trace.mf4",
            device_id=device_id,
            sw_version=sw_version,
            hw_version=hw_version,
            uploaded_by=uploaded_by,
            test_run_id=test_run_id or None,
            tc_ids=[tc for tc in (tc_ids or []) if tc],
        )
    finally:
        if not staged.closed:
            staged.close()
        try:
            os.unlink(staged.name)
        except OSError:
            logger.warning("Could not remove staged upload %s", staged.name)
