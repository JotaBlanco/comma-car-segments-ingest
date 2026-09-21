"""Mint per-blob SAS URLs so the browser uploads straight to Azure.

The FastAPI app never sees the bytes for the new direct-upload flow. It
only validates the request, picks the target blob path, and signs a SAS
URL the browser PUTs to. We reuse the same `Quix__BlobStorage__Connection__Json`
secret already used by the fsspec writer in `blob.py`; nothing new on the
deployment side.

The connection JSON's `azureBlobStorage.key` field is an Azure connection
*string* (e.g. `DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...`).
We pull `AccountKey` out of that string for `generate_blob_sas()`. The
fsspec backend keeps using the connection string as-is.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from azure.storage.blob import BlobSasPermissions, generate_blob_sas
from quixportal.storage.config import BlobStorageProvider, load_config_from_env

logger = logging.getLogger(__name__)


class NonAzureBackendError(RuntimeError):
    """Raised when the configured blob backend is not Azure.

    The new SAS endpoints translate this into HTTP 501 — there is no
    SAS-equivalent for S3/GCP/Local that we want to maintain in this app.
    """


_creds_cache: tuple[str, str, str] | None = None


def extract_azure_credentials() -> tuple[str, str, str]:
    """Return `(account_name, account_key, container_name)` from the env JSON.

    Cached after the first successful read; the value cannot change at
    runtime (it would require a restart).
    """
    global _creds_cache
    if _creds_cache is not None:
        return _creds_cache

    config = load_config_from_env()
    if config.provider != BlobStorageProvider.AZURE:
        raise NonAzureBackendError(
            f"SAS upload requires Azure backend, got {config.provider.value}"
        )

    azure = config.azure_blob_storage
    if azure is None:  # defensive; pydantic validator already enforces this
        raise NonAzureBackendError("Azure config block is missing")

    account_key = _extract_account_key(azure.key)
    _creds_cache = (azure.account_name, account_key, azure.container_name)
    logger.info(
        "SAS credentials loaded for account=%s container=%s",
        azure.account_name, azure.container_name,
    )
    return _creds_cache


def mint_blob_sas(blob_path: str, ttl_seconds: int) -> tuple[str, str]:
    """Mint a write-only SAS URL for `blob_path`.

    Returns `(sas_url, expires_at_iso)`. The URL is the full
    `https://<account>.blob.core.windows.net/<container>/<blob>?<token>`
    that the browser PUTs to via `BlockBlobClient(sasUrl).uploadData(...)`.

    Permissions are `create+write` only — the SAS cannot read, list, or
    delete. Start time is backdated 5 min for clock-skew tolerance.
    """
    account_name, account_key, container = extract_azure_credentials()

    now = datetime.now(timezone.utc)
    start = now - timedelta(minutes=5)
    expiry = now + timedelta(seconds=ttl_seconds)

    token = generate_blob_sas(
        account_name=account_name,
        container_name=container,
        blob_name=blob_path,
        account_key=account_key,
        permission=BlobSasPermissions(create=True, write=True),
        start=start,
        expiry=expiry,
        protocol="https",
    )

    # Azure expects the blob name URL-encoded but slashes preserved (they
    # are virtual folder separators). `quote(safe="/")` matches the SDK's
    # own URL composition for `BlobClient.url`.
    encoded_blob = quote(blob_path, safe="/")
    sas_url = (
        f"https://{account_name}.blob.core.windows.net/"
        f"{container}/{encoded_blob}?{token}"
    )
    expires_at = expiry.strftime("%Y-%m-%dT%H:%M:%SZ")
    return sas_url, expires_at


def _extract_account_key(connection_string: str) -> str:
    """Pull `AccountKey=...` out of an Azure storage connection string.

    Falls back to treating the whole value as the key if it doesn't look
    like a connection string (older deployments may have stored just the
    raw key in the `key` field).
    """
    if "AccountKey=" not in connection_string:
        return connection_string

    parts = connection_string.split(";")
    for part in parts:
        if part.startswith("AccountKey="):
            return part[len("AccountKey="):]

    raise NonAzureBackendError("AccountKey not found in connection string")
