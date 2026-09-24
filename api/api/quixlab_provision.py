"""Find the workspace's QuixLab deployment and address the Portal's deployment routes.

A definition run is a Job cloned from the workspace's own QuixLab deployment, the
recipe QuixLab's headless launcher contract states
(`quixlab/docs/headless-launcher-contract.md`). This module holds the Portal half
of that recipe: which deployment is the template, how its variables are cloned,
how a deployment is found by name and deleted. `quixlab_run.py` builds the Job.

**Whose credential.** The viewer's Portal token, for every call. The route reads
it from `x-portal-token`, as `routers/integrations.py` does, so the Portal
enforces that person's permissions and this module never escalates them.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from collections.abc import Mapping
from typing import Any

import httpx

from api import quix_identity, quixlab
from api.quix_identity import PlatformRefused, PlatformUnreachable

logger = logging.getLogger(__name__)

# Deployments the sibling lab spawner makes; never a template.
LAB_PREFIX = "tm-lab"
# Every definition-run Job carries this prefix, so `_template_row` never clones a clone.
RUN_PREFIX = "tm-run"

# QuixLab's own `sanitize_deployment_name` stops at 60.
NAME_LIMIT = 60

# The variables that pin ONE QuixLab's identity or mode (`quix_platform.py`, `_NO_CLONE_VARS`).
NO_CLONE_VARS = frozenset(
    {
        "Quix__Deployment__Id",
        "Quix__Deployment__Name",
        "Quix__DevSession__Id",
        "Quix__Sdk__Token",
        "QUIXLAB_CODE_NS",
        "QUIXLAB_MODE",
        "QUIXLAB_NODE",
        "QUIXLAB_NOTEBOOK",
        "QUIXLAB_PARAMS",
    }
)

# An operator may name the deployment to clone. Unset, `_template_row` finds one.
TEMPLATE_VAR = "TM_QUIXLAB_TEMPLATE"

DEPLOYMENTS_PATH = "/deployments"
DEPLOYMENT_PATH = "/deployments/{deployment_id}"

# A create or a stored-log download can take seconds; the identity read's 5 s is too tight.
WRITE_TIMEOUT_SECONDS = 30.0

_UNSAFE = re.compile(r"[^a-z0-9]+")


class NoTemplate(Exception):
    """The workspace holds no QuixLab to clone, so no Job can be made."""


class PlatformMissing(Exception):
    """The Portal answered 404: the deployment is not there."""


def sanitize(value: str) -> str:
    """Lowercase alphanumerics and single dashes, as the Portal accepts."""
    return _UNSAFE.sub("-", (value or "").lower()).strip("-")


def run_job_name(run_id: str, td_id: str) -> str:
    """The one name the Job running this definition on this run has, always.

    The digest keeps two pairs apart that sanitise alike (`A_1` and `a-1`).
    """
    digest = hashlib.sha256(f"{run_id}\n{td_id}".encode()).hexdigest()[:8]
    stem = sanitize(f"{RUN_PREFIX}-{run_id}-{td_id}")
    return f"{stem[: NAME_LIMIT - len(digest) - 1].rstrip('-')}-{digest}"


def read_text(row: Mapping[str, Any], *names: str) -> str:
    """The first present name off a Portal row, stripped; empty when none is."""
    return quixlab._text(dict(row), *names)


def clone_variables(template: Mapping[str, Any], overrides: Mapping[str, str]) -> dict:
    """The template's variables, minus the pinning ones, plus these overrides.

    The create DTO binds `variables` to a dict of variable objects keyed by name;
    a GET may answer a list, so both shapes are read and only the dict is written.
    """
    current = template.get("variables")
    if isinstance(current, dict):
        entries = list(current.items())
    elif isinstance(current, list):
        entries = [(row.get("name"), row) for row in current if isinstance(row, dict)]
    else:
        entries = []
    out: dict[str, dict] = {}
    for name, value in entries:
        if not name or name in NO_CLONE_VARS:
            continue
        entry = dict(value) if isinstance(value, dict) else {"value": value}
        entry.pop("name", None)
        entry.setdefault("inputType", "FreeText")
        entry.setdefault("required", False)
        out[name] = entry
    for name, value in overrides.items():
        out[name] = {"inputType": "FreeText", "required": False, "value": value}
    return out


def client() -> httpx.Client:
    """An httpx client on the Portal API, with the test transport when one is set."""
    return httpx.Client(
        base_url=quix_identity.portal_url(),
        transport=quix_identity.TRANSPORT,
        timeout=WRITE_TIMEOUT_SECONDS,
    )


def workspace() -> str:
    """The workspace this API serves; `NoTemplate` when no Portal call can be made."""
    found = quix_identity.workspace_id()
    if not quix_identity.portal_url() or not found:
        raise NoTemplate("this deployment cannot reach the Quix platform")
    return found


def portal_send(
    http: httpx.Client, method: str, path: str, token: str, body: Any = None
) -> httpx.Response:
    """Send one Portal request that may write. 404 raises `PlatformMissing`.

    401 and 403 are a decision about the caller (`PlatformRefused`); anything else at
    400 or above, and no answer at all, is an outage (`PlatformUnreachable`).
    """
    try:
        response = http.request(
            method,
            path,
            json=body,
            headers={
                "Authorization": f"Bearer {token}",
                "X-Version": quix_identity.PORTAL_API_VERSION,
            },
        )
    except httpx.HTTPError as error:
        raise PlatformUnreachable(
            f"the Quix platform did not answer: {type(error).__name__}"
        ) from error
    if response.status_code in (401, 403):
        raise PlatformRefused("the Quix platform refused the token")
    if response.status_code == 404:
        raise PlatformMissing(f"the Quix platform has nothing at {method} {path}")
    if response.status_code >= 400:
        # The body is not logged: a create's refusal may echo the cloned variables.
        logger.warning("portal %s %s answered %s", method, path, response.status_code)
        raise PlatformUnreachable(
            f"the Quix platform answered {response.status_code} on {method} {path}"
        )
    return response


def deployment_rows(http: httpx.Client, token: str, workspace_id: str) -> list[dict]:
    """Every deployment row of the workspace."""
    response = quix_identity.portal_get(
        http, quixlab.DEPLOYMENTS_PATH.format(workspace_id=workspace_id), token
    )
    return quixlab._rows(response)


def find(rows: list[dict], name: str) -> dict | None:
    """The row named `name`, or None."""
    for row in rows:
        if read_text(row, "name") == name:
            return row
    return None


def template_row(rows: list[dict]) -> dict | None:
    """The QuixLab deployment a Job is cloned from.

    Labs and run Jobs are built from the QuixLab library item too, so they are excluded
    by name: otherwise the first Job made would become the template of the next.
    """
    named = os.environ.get(TEMPLATE_VAR, "").strip()
    for row in rows:
        if read_text(row, "libraryItemId").lower() != quixlab.QUIXLAB_LIBRARY_ITEM_ID:
            continue
        if named:
            if named in (read_text(row, "deploymentId"), read_text(row, "name")):
                return row
            continue
        if read_text(row, "name").startswith((f"{LAB_PREFIX}-", f"{RUN_PREFIX}-")):
            continue
        return row
    return None


def delete_deployment(http: httpx.Client, token: str, deployment_id: str) -> None:
    """Delete one deployment. One the Portal no longer has is already deleted."""
    try:
        portal_send(http, "DELETE", DEPLOYMENT_PATH.format(deployment_id=deployment_id), token)
    except PlatformMissing:
        logger.info("quixlab deployment %s was already gone", deployment_id)
        return
    logger.info("quixlab deployment %s deleted", deployment_id)


__all__ = [
    "LAB_PREFIX",
    "NAME_LIMIT",
    "NO_CLONE_VARS",
    "RUN_PREFIX",
    "TEMPLATE_VAR",
    "NoTemplate",
    "PlatformMissing",
    "PlatformRefused",
    "PlatformUnreachable",
    "client",
    "clone_variables",
    "delete_deployment",
    "deployment_rows",
    "find",
    "portal_send",
    "read_text",
    "run_job_name",
    "sanitize",
    "template_row",
    "workspace",
]
