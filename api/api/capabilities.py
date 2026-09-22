"""What this process can actually serve, read from its own environment.

A deployment can look correct and still receive nothing. ``blobStorage:
bind: true`` makes the Portal inject a credential only when the workspace has
blob storage enabled. With that switch off the manifest is right, the pod is
empty, and the only trace used to be one log line on one screen.

So this module reads **the environment the process holds**. It never reads a
manifest and it never names a second variable for a value the platform already
injects.

Two capabilities depend on an injected value:

* ``statistics`` needs the QuixLake query URL and a token. Without them
  ``GET /signals/{name}/stats`` and the Explore queries answer 503. The
  run-signals list does not depend on them: it serves the numbers the
  ingestion pipeline measured, straight from the registry.
* ``file_downloads`` needs the blob connection JSON. Without it
  ``GET /files/{file_id}/download`` answers 503.

Nothing here stops the process. A demo with neither value still serves the
registry, so a missing configuration costs a reader some numbers and never the
whole application.
"""

import logging
import os

from api.services import lake

logger = logging.getLogger(__name__)

# The platform injects this name when the workspace has blob storage enabled.
# `quixportal` reads it, `ingest.store.build_blob_store` builds on it, and the
# download route fails closed without it. Never define a second name for it.
BLOB_CONNECTION_VAR = "Quix__BlobStorage__Connection__Json"

_STATISTICS_COST = (
    "the statistics queries are not available: the per-signal statistics and "
    "the Explore queries answer 503; the run-signals list keeps the numbers "
    "the ingestion pipeline measured"
)
_DOWNLOAD_COST = "file downloads are not available: the download route answers 503"

_warned = False


def _capability(name: str, missing: str | None, cost: str) -> dict:
    return {
        "name": name,
        "configured": missing is None,
        "missing_variable": missing,
        "impact": None if missing is None else cost,
    }


def _statistics() -> dict:
    return _capability("statistics", lake.missing_variable(), _STATISTICS_COST)


def _file_downloads() -> dict:
    """Report the blob credential this process holds.

    The check reads the environment, not the provider. Building the blob client
    would import `quixportal` and cost time on a probe, and the credential is
    the thing an operator fixes.
    """
    present = bool(os.environ.get(BLOB_CONNECTION_VAR, "").strip())
    return _capability("file_downloads", None if present else BLOB_CONNECTION_VAR, _DOWNLOAD_COST)


def report() -> list[dict]:
    """List every capability, configured or not. `/ready` serves this."""
    return [_statistics(), _file_downloads()]


def missing() -> list[dict]:
    """List the capabilities this process cannot serve."""
    return [item for item in report() if not item["configured"]]


def warn_once() -> list[dict]:
    """Log one warning line per missing capability, the first time only.

    A warning on every request is noise, and a pod already proves that. The
    process states the gap once at start, `/ready` answers it on demand, and
    the run-signals response carries it to the screen.

    This never raises and never stops the process.
    """
    global _warned
    if _warned:
        return []
    _warned = True
    gaps = missing()
    for item in gaps:
        logger.warning("%s is not set, so %s", item["missing_variable"], item["impact"])
    return gaps
