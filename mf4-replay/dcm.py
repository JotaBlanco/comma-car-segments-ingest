"""Client for the Dynamic Configuration Manager.

Fetches the DBC that an MF4 file names in its own header and caches the compiled
database. Compiling the Ford DBC takes seconds and yields 331 messages / 2150
signals, so it must happen once per version - never per message.
"""

from __future__ import annotations

import hashlib
import io
import logging
import os
import tempfile

import cantools
import requests

logger = logging.getLogger(__name__)

# In-cluster address of the managed DCM deployment (network.serviceName in
# quix.yaml). The public hostname works too but adds an ingress hop.
DEFAULT_BASE = "http://config-api-svc/api/v1"


class ConfigError(RuntimeError):
    pass


class DcmClient:
    def __init__(self, base_url: str | None = None, token: str | None = None):
        self.base = (base_url or os.environ.get("DCM_BASE_URL", DEFAULT_BASE)).rstrip("/")
        # Inside a deployment Quix injects the SDK token; it carries workspace
        # scope, which is what DCM's auth checks.
        self.token = (
            token
            or os.environ.get("DCM_TOKEN")
            or os.environ.get("Quix__Sdk__Token")
            or ""
        )
        if not self.token:
            logger.warning("no DCM token available; requests will get 403")
        self._cache: dict[str, tuple[str, cantools.database.Database]] = {}

    # ---- low level ----------------------------------------------------------
    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}"}

    def config_id(self, type_: str, target_key: str) -> str:
        """DCM addresses a config by sha1('<type>-<target_key>')."""
        return hashlib.sha1(f"{type_}-{target_key}".encode()).hexdigest()

    def get_metadata(self, config_id: str) -> dict:
        r = requests.get(
            f"{self.base}/configurations/{config_id}",
            headers=self._headers(),
            timeout=60,
        )
        if r.status_code != 200:
            raise ConfigError(
                f"DCM metadata {config_id}: HTTP {r.status_code} {r.text[:200]}"
            )
        return r.json()["data"]["metadata"]

    def get_content(self, config_id: str) -> bytes:
        r = requests.get(
            f"{self.base}/configurations/{config_id}/content",
            headers=self._headers(),
            timeout=300,
        )
        if r.status_code != 200:
            raise ConfigError(
                f"DCM content {config_id}: HTTP {r.status_code} {r.text[:200]}"
            )
        return r.content

    # ---- what callers use ---------------------------------------------------
    def load_database(self, config_id: str) -> cantools.database.Database:
        """Return the compiled DBC for a config id, cached by content sha256.

        The metadata call is cheap and carries sha256sum, so a changed DBC is
        detected and recompiled without re-downloading on every message.
        """
        meta = self.get_metadata(config_id)
        sha = meta.get("sha256sum") or ""

        cached = self._cache.get(config_id)
        if cached and cached[0] == sha:
            return cached[1]

        raw = self.get_content(config_id)
        actual = hashlib.sha256(raw).hexdigest()
        if sha and actual != sha:
            raise ConfigError(
                f"DCM content sha mismatch for {config_id}: "
                f"metadata={sha[:16]} actual={actual[:16]}"
            )

        # cantools needs a path or a text stream; the content is stored as
        # binary, so decode it here rather than guessing at upload time.
        try:
            db = cantools.database.load_string(
                raw.decode("utf-8", "replace"), database_format="dbc", strict=False
            )
        except Exception:
            with tempfile.NamedTemporaryFile("wb", suffix=".dbc", delete=False) as fh:
                fh.write(raw)
                tmp = fh.name
            try:
                db = cantools.database.load_file(tmp, strict=False)
            finally:
                os.unlink(tmp)

        logger.info(
            "loaded DBC from DCM %s: %d messages, %d signals, sha256=%s",
            config_id,
            len(db.messages),
            sum(len(m.signals) for m in db.messages),
            actual[:16],
        )
        self._cache[config_id] = (actual, db)
        return db
