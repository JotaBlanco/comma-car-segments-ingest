"""MF4-to-blob upload service.

Browser uploads go *directly* to Azure Blob Storage via a per-file SAS
URL minted by this app. The bytes never traverse this FastAPI process,
which removes the Quix public-ingress 502 we hit on large MF4 files.

Flow per file:
  1. POST /upload/sas        -> server validates, mints SAS, returns URL.
  2. Browser PUTs to Azure   -> via @azure/storage-blob BlockBlobClient.
  3. POST /upload/complete   -> server verifies blob exists at expected
                                size and produces the Kafka metadata
                                message exactly once.
"""


from __future__ import annotations

import logging
import os
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field
from quixstreams import Application

import blob
import metadata
import sas
import state

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mf4-to-blob")

OUTPUT_TOPIC = os.environ.get("output", "mf4_metadata")
BLOB_PREFIX = os.environ.get("blob_prefix", "mf4-uploads/")
MAX_FILE_BYTES = int(os.environ.get("max_file_bytes", str(5 * 1024 * 1024 * 1024)))
COLLISION_POLICY = os.environ.get("collision_policy", "suffix").lower()
CONCURRENCY_HINT = int(os.environ.get("concurrency_hint", "3"))
SAS_TTL_SECONDS = int(os.environ.get("sas_ttl_seconds", "1800"))

app = FastAPI()

_quix_app: Optional[Application] = None
_topic = None
_producer = None


def _producer_lazy():
    """Build the Quix Application/producer on first use, not at import.

    Lets `python -c "import main"` succeed without Kafka credentials.
    """
    global _quix_app, _topic, _producer
    if _producer is None:
        _quix_app = Application(
            consumer_group="mf4-uploader",
            auto_create_topics=True,
        )
        _topic = _quix_app.topic(name=OUTPUT_TOPIC, value_serializer="json")
        _producer = _quix_app.get_producer()
    return _topic, _producer


@app.get("/", response_class=HTMLResponse)
async def index():
    with open(os.path.join(os.path.dirname(__file__), "static", "index.html"), encoding="utf-8") as f:
        return f.read()


@app.get("/config")
async def config():
    return {
        "concurrency_hint": CONCURRENCY_HINT,
        "max_file_bytes": MAX_FILE_BYTES,
        "topic": OUTPUT_TOPIC,
    }


class SasRequest(BaseModel):
    filename: str = Field(..., min_length=1)
    size: int = Field(..., ge=0)


class CompleteRequest(BaseModel):
    uploadId: str = Field(..., min_length=1)
    blobPath: str = Field(..., min_length=1)
    size: int = Field(..., ge=0)


@app.post("/upload/sas")
async def upload_sas(req: SasRequest):
    """Validate and mint a per-blob SAS for the browser to PUT to."""
    if req.size > MAX_FILE_BYTES:
        return JSONResponse(
            {"status": "error", "message": f"file exceeds max_file_bytes={MAX_FILE_BYTES}"},
            status_code=413,
        )

    blob_path, collision_err = blob.resolve_blob_path(req.filename, BLOB_PREFIX, COLLISION_POLICY)
    if collision_err:
        return JSONResponse(
            {"status": "error", "message": collision_err, "blobPath": blob_path},
            status_code=409,
        )

    upload_id = metadata.make_upload_id(req.filename)
    try:
        sas_url, expires_at = sas.mint_blob_sas(blob_path, SAS_TTL_SECONDS)
    except sas.NonAzureBackendError as e:
        return JSONResponse({"status": "error", "message": str(e)}, status_code=501)
    except Exception as e:  # noqa: BLE001
        logger.exception("SAS minting failed for %s: %s", blob_path, e)
        return JSONResponse(
            {"status": "error", "message": f"sas mint failed: {e}"},
            status_code=500,
        )

    state.init(upload_id, req.filename, req.size)
    state.set_status(upload_id, "uploading", blob_path=blob_path)

    return {
        "uploadId": upload_id,
        "blobPath": blob_path,
        "sasUrl": sas_url,
        "expiresAt": expires_at,
    }


@app.post("/upload/complete")
async def upload_complete(req: CompleteRequest, request: Request):
    """Verify the blob landed and produce the Kafka metadata message."""
    info = state.get(req.uploadId)
    if not info:
        return JSONResponse(
            {"status": "error", "message": "unknown uploadId"},
            status_code=404,
        )
    expected_blob_path = info.get("blob_path")
    if expected_blob_path != req.blobPath:
        return JSONResponse(
            {"status": "error", "message": "uploadId/blobPath mismatch"},
            status_code=409,
        )

    filename = info.get("filename") or os.path.basename(req.blobPath)

    try:
        fs = blob.get_fs()
        actual_size = _blob_size(fs, req.blobPath)
    except FileNotFoundError:
        state.set_status(req.uploadId, "error", error="blob not found")
        return JSONResponse(
            {"status": "error", "message": "blob not found at expected path"},
            status_code=404,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("Stat failed for %s: %s", req.blobPath, e)
        state.set_status(req.uploadId, "error", error=f"stat failed: {e}")
        return JSONResponse(
            {"status": "error", "message": f"stat failed: {e}"},
            status_code=500,
        )

    if actual_size != req.size:
        logger.warning(
            "Size mismatch for %s: client=%s azure=%s",
            req.blobPath, req.size, actual_size,
        )
        blob.safe_remove(req.blobPath)
        state.set_status(req.uploadId, "error", error="size mismatch")
        return JSONResponse(
            {
                "status": "error",
                "message": f"size mismatch: client={req.size} azure={actual_size}",
            },
            status_code=409,
        )

    payload = metadata.build_payload(
        upload_id=req.uploadId,
        filename=filename,
        blob_path=req.blobPath,
        size_bytes=actual_size,
        sha256_hex=None,  # see spec §7.2 — direct SAS upload never hashes
        content_type="application/x-mdf",
        blob_url=_blob_url_or_none(req.blobPath),
        uploader_ip=request.client.host if request.client else None,
    )

    try:
        topic, producer = _producer_lazy()
        msg = topic.serialize(key=req.uploadId, value=payload)
        producer.produce(topic=topic.name, key=msg.key, value=msg.value)
        producer.flush()
    except Exception as e:  # noqa: BLE001
        logger.exception("Upload %s: blob present but producing metadata failed: %s", req.uploadId, e)
        state.set_status(
            req.uploadId, "error",
            error=f"metadata produce failed: {e}", blob_path=req.blobPath,
        )
        return JSONResponse(
            {
                "upload_id": req.uploadId,
                "status": "error",
                "filename": filename,
                "blob_path": req.blobPath,
                "message": f"blob uploaded but metadata produce failed: {e}",
            },
            status_code=500,
        )

    state.set_status(
        req.uploadId, "done",
        blob_path=req.blobPath, size_bytes=actual_size, sha256=None,
    )

    return {
        "upload_id": req.uploadId,
        "status": "done",
        "filename": filename,
        "blob_path": req.blobPath,
        "size_bytes": actual_size,
        "sha256": None,
    }


@app.get("/progress/{upload_id}")
async def progress(upload_id: str):
    info = state.get(upload_id)
    if not info:
        return {"status": "unknown"}
    state.pop_if_terminal(upload_id)
    return info


def _blob_size(fs, blob_path: str) -> int:
    """Return blob size in bytes, raising FileNotFoundError on miss.

    Different fsspec backends spell this differently; we try `size()`
    first, then `info()['size']`. adlfs supports both.
    """
    if hasattr(fs, "size"):
        size = fs.size(blob_path)
        if size is not None:
            return int(size)
    info = fs.info(blob_path)
    return int(info["size"])


def _blob_url_or_none(blob_path: str) -> Optional[str]:
    """Best-effort public-ish URL. fsspec backends vary; if anything raises
    or the backend does not expose a URL, return None and let blob_path be
    the source of truth (per spec §7.2).
    """
    try:
        fs = blob.get_fs()
        url_fn = getattr(fs, "url", None) or getattr(fs, "_url", None)
        if callable(url_fn):
            return url_fn(blob_path)
    except Exception:  # noqa: BLE001
        return None
    return None
