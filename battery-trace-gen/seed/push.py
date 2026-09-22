"""The HTTP half: post the planning body and the implementation files with a PAT.

Two routes, one credential. `TM_API_URL` names the registry's public base — the
`backend-api` URL prefix of the target environment — and `TM_API_TOKEN` is the
same static bearer every other client of `/api/v1` presents.

Both routes are idempotent by the registry's own rules: a re-post of the same
catalog mirrors identically and answers `links_unchanged`, and an implementation
whose bytes have not changed lands on the same blob key.
"""

from __future__ import annotations

import os
from pathlib import Path

import requests

API_PREFIX = "/api/v1"
TIMEOUT_SECONDS = 60.0

URL_VARIABLE = "TM_API_URL"
TOKEN_VARIABLE = "TM_API_TOKEN"


class NotConfigured(RuntimeError):
    """The registry's URL or token is not in the environment."""


def _base_url() -> str:
    url = os.environ.get(URL_VARIABLE, "").strip().rstrip("/")
    if not url:
        raise NotConfigured(f"Set {URL_VARIABLE} to the registry's public base URL.")
    return url


def _headers() -> dict[str, str]:
    token = os.environ.get(TOKEN_VARIABLE, "").strip()
    if not token:
        raise NotConfigured(f"Set {TOKEN_VARIABLE} to the registry's API token.")
    return {"Authorization": f"Bearer {token}"}


def _answer(response: requests.Response, what: str) -> dict:
    if response.status_code >= 400:
        raise RuntimeError(f"{what} answered {response.status_code}: {response.text}")
    return response.json()


def planning_sync(body: dict) -> dict:
    """`POST /planning/sync`. Returns the registry's push report."""
    response = requests.post(
        f"{_base_url()}{API_PREFIX}/planning/sync",
        json=body,
        headers=_headers(),
        timeout=TIMEOUT_SECONDS,
    )
    return _answer(response, "POST /planning/sync")


def implementation(td_id: str, path: Path) -> dict:
    """`POST /test-definitions/{td_id}/implementation`, multipart.

    The bytes go through the API, never straight into blob: the route owns the
    journal entry, the source tag and the 503 path, and a second writer into the
    same bucket would leave the registry holding a pointer it did not write.
    """
    with path.open("rb") as handle:
        response = requests.post(
            f"{_base_url()}{API_PREFIX}/test-definitions/{td_id}/implementation",
            files={"file": (path.name, handle, "text/x-python")},
            headers=_headers(),
            timeout=TIMEOUT_SECONDS,
        )
    return _answer(response, f"POST /test-definitions/{td_id}/implementation")
