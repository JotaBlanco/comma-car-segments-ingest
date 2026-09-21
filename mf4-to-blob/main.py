"""MF4-to-blob upload service.

Two upload paths; `GET /config` tells the browser which one this deployment
can use, derived from the provider in the auto-injected
`Quix__BlobStorage__Connection__Json`.

**Azure (`upload_mode: "sas"`)** - the browser uploads *directly* to Azure
Blob Storage via a per-file SAS URL minted by this app. Bytes never
traverse this process, which removes the Quix public-ingress 502 we hit on
large MF4 files:
  1. POST /upload/sas        -> server validates, mints SAS, returns URL.
  2. Browser PUTs to Azure   -> via @azure/storage-blob BlockBlobClient.
  3. POST /upload/complete   -> server verifies blob exists at expected
                                size and produces the Kafka metadata
                                message exactly once.

**Any provider (`upload_mode: "direct"`)** - S3 / S3Compatible / Minio /
GCP / Local have no SAS equivalent, so the browser POSTs the raw file body
to this app and we stream it into blob storage through the fsspec writer:
  1. POST /upload/direct     -> one request: server mints the key, streams
                                the body to blob in provider-native blocks
                                while hashing, then produces the Kafka
                                metadata message.

Both paths mint the pipeline key once via `metadata.make_upload_id`, write
under `blob_prefix`, keep `state.py` progress current and emit the same
`mf4_metadata` message, so everything downstream is identical.
"""


from __future__ import annotations

import hashlib
import logging
import os
from typing import Any, Optional

import anyio
from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request
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
# auto   -> sas on Azure, direct everywhere else (the sane default)
# sas    -> force browser-to-Azure SAS (501 on a non-Azure backend)
# direct -> force server-side streaming upload, even on Azure
UPLOAD_MODE = os.environ.get("upload_mode", "auto").strip().lower() or "auto"

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


def _resolve_upload_mode() -> tuple[Optional[str], str]:
    """Return `(provider, upload_mode)` for this deployment.

    `upload_mode` is what the browser must use. Only Azure can hand out SAS
    URLs, so every other provider - and an undetectable provider - resolves
    to `direct`. An explicit `upload_mode` env value overrides the probe.
    """
    provider = blob.get_provider()
    if UPLOAD_MODE in ("sas", "direct"):
        return provider, UPLOAD_MODE
    is_azure = provider is not None and provider.lower() == "azure"
    return provider, "sas" if is_azure else "direct"


@app.get("/", response_class=HTMLResponse)
async def index():
    with open(os.path.join(os.path.dirname(__file__), "static", "index.html"), encoding="utf-8") as f:
        return f.read()


@app.get("/config")
async def config():
    provider, upload_mode = _resolve_upload_mode()
    return {
        "concurrency_hint": CONCURRENCY_HINT,
        "max_file_bytes": MAX_FILE_BYTES,
        "topic": OUTPUT_TOPIC,
        "provider": provider,
        "upload_mode": upload_mode,
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
        _produce_metadata(req.uploadId, payload)
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


class UploadTooLargeError(Exception):
    """Body exceeded `max_file_bytes` mid-stream; partial blob is removed."""


@app.post("/upload/direct")
async def upload_direct(
    request: Request,
    filename: str = Query(..., min_length=1),
    size: int = Query(0, ge=0),
):
    """Stream the raw request body into blob storage - any provider.

    One round trip: the browser POSTs the file as the request body
    (`application/octet-stream`) with `filename`/`size` as query params, and
    this handler does everything the SAS pair does across its two calls -
    mint the key, write the blob, hash it, produce `mf4_metadata`.

    The body is consumed chunk-by-chunk from `request.stream()` and each
    chunk handed to the fsspec writer, which flushes in provider-native
    blocks, so peak memory is one block regardless of file size. `size` is
    advisory (used for the progress percentage and an early 413); the
    authoritative size is what we actually wrote.
    """
    if size > MAX_FILE_BYTES:
        return JSONResponse(
            {"status": "error", "message": f"file exceeds max_file_bytes={MAX_FILE_BYTES}"},
            status_code=413,
        )

    blob_path, collision_err = blob.resolve_blob_path(filename, BLOB_PREFIX, COLLISION_POLICY)
    if collision_err:
        return JSONResponse(
            {"status": "error", "message": collision_err, "blobPath": blob_path},
            status_code=409,
        )

    # Minted once, here - the same value is the progress-registry key, the
    # Kafka message key, the metadata `id` and the response `upload_id`.
    upload_id = metadata.make_upload_id(filename)
    state.init(upload_id, filename, size)
    state.set_status(upload_id, "uploading", blob_path=blob_path)

    try:
        size_bytes, sha256_hex = await _stream_body_to_blob(request, blob_path, upload_id)
    except UploadTooLargeError as e:
        blob.safe_remove(blob_path)
        state.set_status(upload_id, "error", error=str(e))
        return JSONResponse({"status": "error", "message": str(e)}, status_code=413)
    except Exception as e:  # noqa: BLE001
        logger.exception("Direct upload %s failed writing %s: %s", upload_id, blob_path, e)
        blob.safe_remove(blob_path)
        state.set_status(upload_id, "error", error=f"blob write failed: {e}")
        return JSONResponse(
            {"status": "error", "message": f"blob write failed: {e}"},
            status_code=500,
        )

    if size and size_bytes != size:
        logger.warning(
            "Size mismatch for %s: client=%s written=%s", blob_path, size, size_bytes,
        )
        blob.safe_remove(blob_path)
        state.set_status(upload_id, "error", error="size mismatch")
        return JSONResponse(
            {
                "status": "error",
                "message": f"size mismatch: client={size} written={size_bytes}",
            },
            status_code=409,
        )

    state.set_status(upload_id, "finalizing", blob_path=blob_path, size_bytes=size_bytes)

    payload = metadata.build_payload(
        upload_id=upload_id,
        filename=filename,
        blob_path=blob_path,
        size_bytes=size_bytes,
        sha256_hex=sha256_hex,
        content_type="application/x-mdf",
        blob_url=_blob_url_or_none(blob_path),
        uploader_ip=request.client.host if request.client else None,
    )

    try:
        _produce_metadata(upload_id, payload)
    except Exception as e:  # noqa: BLE001
        logger.exception("Upload %s: blob written but producing metadata failed: %s", upload_id, e)
        state.set_status(
            upload_id, "error",
            error=f"metadata produce failed: {e}", blob_path=blob_path,
        )
        return JSONResponse(
            {
                "upload_id": upload_id,
                "status": "error",
                "filename": filename,
                "blob_path": blob_path,
                "message": f"blob uploaded but metadata produce failed: {e}",
            },
            status_code=500,
        )

    state.set_status(
        upload_id, "done",
        blob_path=blob_path, size_bytes=size_bytes, sha256=sha256_hex,
    )

    return {
        "upload_id": upload_id,
        "status": "done",
        "filename": filename,
        "blob_path": blob_path,
        "size_bytes": size_bytes,
        "sha256": sha256_hex,
    }


async def _stream_body_to_blob(
    request: Request, blob_path: str, upload_id: str,
) -> tuple[int, str]:
    """Pipe the request body into `blob_path`, returning `(bytes, sha256hex)`.

    The sha256 is computed on the way past, so the blob is never re-read.
    fsspec writers are synchronous and their flushes are network calls, so
    every `write`/`close` goes through `anyio.to_thread` - otherwise a flush
    would stall the event loop and freeze `/progress` polling for every
    other in-flight upload.
    """
    digest = hashlib.sha256()
    written = 0
    writer = await anyio.to_thread.run_sync(blob.open_writer, blob_path)
    try:
        async for chunk in request.stream():
            if not chunk:
                continue
            written += len(chunk)
            if written > MAX_FILE_BYTES:
                raise UploadTooLargeError(f"file exceeds max_file_bytes={MAX_FILE_BYTES}")
            digest.update(chunk)
            await anyio.to_thread.run_sync(writer.write, chunk)
            state.update_bytes(upload_id, written)
    except BaseException:
        # Shielded: a client disconnect cancels the surrounding scope, and an
        # unshielded await here would be cancelled too, leaking the writer.
        with anyio.CancelScope(shield=True):
            await anyio.to_thread.run_sync(_close_quietly, writer)
        raise
    await anyio.to_thread.run_sync(writer.close)
    return written, digest.hexdigest()


def _close_quietly(fh) -> None:
    """Close a writer on the failure path; the caller already has an error."""
    try:
        fh.close()
    except Exception as e:  # noqa: BLE001
        logger.warning("Ignoring close() error on aborted upload: %s", e)


def _produce_metadata(upload_id: str, payload: dict[str, Any]) -> None:
    """Publish one `mf4_metadata` message keyed by the upload id."""
    topic, producer = _producer_lazy()
    msg = topic.serialize(key=upload_id, value=payload)
    producer.produce(topic=topic.name, key=msg.key, value=msg.value)
    producer.flush()


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
