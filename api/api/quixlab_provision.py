"""Spin one QuixLab out per viewer per run, rooted on that run's own folder.

**What changed and why.** This product used to send every person to ONE shared
QuixLab named by `TM_QUIXLAB_URL`. Everybody landed on the same canvas, so two
people analysing two runs overwrote each other's cells, and the run a notebook
addressed lived in a per-viewer session rather than in the notebook. A lab per
viewer per run removes both problems at once: the notebook IS the run's, and
nobody shares it.

**How a lab is made.** By cloning the workspace's QuixLab deployment, which is
how QuixLab itself makes its app and job children
(`quixlab/src/quixlab/quix_platform.py`, `build_app_deployment_spec`). The
clone copies the template's image, application and resources, drops the
variables that pin the template's own identity, and pins three of its own. No
image is built and no application is created, so the only cost is a container.

**Where the notebook goes.** `QUIXLAB_NOTEBOOK=blob://<key>` makes the FOLDER
of that key the project root — the notebook, its manifest, its runs, items and
chats all live there (`quixlab/src/quixlab/project.py`, `parse()`). The key is
built by `notebook_key` under the run id, so the run's folder is the root and
the run's own analysis never leaks into another run's.

**Whose credential.** The viewer's. A lab created with a service token would
belong to the service, and "a QuixLab for that one person" would be a label
rather than a fact. The route hands this module the viewer's Portal token, the
same one `api/quixlab.py` lists with, and the Portal enforces that person's
permissions. A viewer who may not create a deployment gets the Portal's own
refusal, which is the correct answer rather than a privilege this module
quietly escalates.

**A lab is found by name, never remembered.** The name is a pure function of
the viewer and the run, so `ensure_lab` asks the Portal rather than keeping a
table that could disagree with it. Nothing to migrate, and a lab removed in the
Portal is simply made again.

**Definition runs share the Portal half.** A definition run is a Job cloned from
the same template, per QuixLab's headless launcher contract
(`quixlab/docs/headless-launcher-contract.md`). The helpers at the bottom of this
module find the template, clone its variables and address the deployment routes
for it; `quixlab_run.py` builds the Job.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from api import quix_identity, quixlab
from api.quix_identity import PlatformMissing, PlatformRefused, PlatformUnreachable

logger = logging.getLogger(__name__)

# Every lab this module makes carries this prefix. It is how a lab is told from
# the template it was cloned from — without it, `_template` would eventually
# pick a lab and clone a clone.
LAB_PREFIX = "tm-lab"
# Every definition-run Job carries this prefix, so `_template_row` never clones a clone.
RUN_PREFIX = "tm-run"

# The blob folder the per-run notebooks live under, beneath the workspace
# folder SAG grants this deployment a write in (`services/file_writes.py`
# explains why the workspace folder leads every key).
NOTEBOOK_FOLDER = "quixlab-runs"
NOTEBOOK_NAME = "analysis.py"

# Names the Portal takes: lowercase alphanumerics and dashes. QuixLab's own
# `sanitize_deployment_name` stops at 60 and the deployment NAME keeps that.
NAME_LIMIT = 60

# The URL PREFIX is a different, much tighter limit, and it is not the name's.
# The Portal answers
#   400 {"message":"Url prefix '...' must be less than 34 characters"}
# so a prefix is at most 33. A viewer id alone is a 36-character uuid, so a
# readable prefix is not on offer at all: `lab_url_prefix` spends the budget on
# a digest instead, and the readable identity lives in the deployment name.
URL_PREFIX_LIMIT = 33

# The variables that pin ONE QuixLab's identity or runtime mode. Cloning them
# would make the child masquerade as its template — and the platform re-injects
# its own values for the identity ones anyway. The list is QuixLab's own
# (`quix_platform.py`, `_NO_CLONE_VARS`) plus `QUIXLAB_CODE_NS`: that one names
# the parent whose REPO code a child runs, and a lab runs the notebook in its
# blob project root instead, so inheriting it would point the lab at a folder
# holding somebody else's notebook.
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

# An operator may name the deployment to clone. Unset, `_template` finds one.
TEMPLATE_VAR = "TM_QUIXLAB_TEMPLATE"

WORKSPACE_FOLDER_VAR = "Quix__Workspace__Id"

DEPLOYMENTS_PATH = "/deployments"
DEPLOYMENT_PATH = "/deployments/{deployment_id}"
WORKSPACE_DEPLOYMENTS_PATH = "/workspaces/{workspace_id}/deployments"

_UNSAFE = re.compile(r"[^a-z0-9]+")


class NoTemplate(Exception):
    """The workspace holds no QuixLab to clone, so no lab can be made."""


@dataclass(frozen=True)
class Lab:
    """One person's QuixLab for one run."""

    id: str
    name: str
    status: str
    url: str
    notebook: str
    created: bool = False


def sanitize(value: str) -> str:
    """Lowercase alphanumerics and single dashes, as the Portal accepts."""
    out = _UNSAFE.sub("-", (value or "").lower())
    while "--" in out:
        out = out.replace("--", "-")
    return out.strip("-")


def _digest(user_id: str, run_id: str, length: int) -> str:
    """The stable identity of one viewer-and-run pair, as hex."""
    return hashlib.sha256(f"{user_id}\n{run_id}".encode()).hexdigest()[:length]


def lab_name(user_id: str, run_id: str) -> str:
    """The one name this viewer's lab for this run has, always.

    It is READ back by `ensure_lab`, so it must be a pure function of the pair.

    The RUN leads the readable stem, not the viewer: an operator scanning the
    deployment list wants to know which run a lab belongs to, and a viewer id
    is a 36-character uuid that would push the run id off the end. The digest
    carries the viewer, and keeps two people on one run apart.
    """
    digest = _digest(user_id, run_id, 8)
    stem = sanitize(f"{LAB_PREFIX}-{run_id}")[: NAME_LIMIT - len(digest) - 1]
    return f"{stem}-{digest}"


def lab_url_prefix(user_id: str, run_id: str) -> str:
    """The lab's host name. At most `URL_PREFIX_LIMIT` characters, always.

    Nothing readable fits: the prefix and the run id together are longer than
    the whole budget, so this is the pair's digest and nothing else. It is
    still a pure function of the pair, so a lab found by name has the address
    this would have built for it.
    """
    prefix = f"{LAB_PREFIX}-{_digest(user_id, run_id, 16)}"
    assert len(prefix) <= URL_PREFIX_LIMIT  # 7 + 1 + 16 = 24
    return prefix


def notebook_key(run_id: str) -> str:
    """The blob key of one run's notebook, workspace folder first.

    SAG reads the first folder under the bucket as the workspace and grants a
    deployment a write only under it, so the workspace folder leads the key
    exactly as it leads a result's (`services/file_writes.result_blob_key`).
    Outside a deployment the variable is unset and the key stays bare, which is
    what a local store wants.
    """
    workspace = os.environ.get(WORKSPACE_FOLDER_VAR, "").strip().strip("/")
    folder = f"{workspace}/{NOTEBOOK_FOLDER}" if workspace else NOTEBOOK_FOLDER
    return f"{folder}/{run_id}/{NOTEBOOK_NAME}"


def notebook_pointer(key: str) -> str:
    """`blob://<key>` — the value `QUIXLAB_NOTEBOOK` takes.

    It is bucket-relative and carries no leading slash, which is what
    `quixlab/src/quixlab/project.py` `parse()` requires; a malformed value
    raises there rather than falling back, so it is built in one place.
    """
    return f"blob://{key.lstrip('/')}"


def clone_variables(template: Mapping[str, Any], overrides: Mapping[str, str]) -> dict:
    """The template's variables, minus the pinning ones, plus this lab's.

    **The create DTO binds `variables` to a dict of variable OBJECTS**, keyed
    by name — a list-shaped payload fails to convert, and a bare string value
    silently fails to become a `DeploymentVariable`, which is how QuixLab's
    pinned variables once went missing without an error
    (`quix_platform.py`, `_clone_variables`). A GET may answer either shape, so
    both are read and only the dict shape is written.
    """
    current = template.get("variables")
    out: dict[str, dict] = {}
    if isinstance(current, dict):
        entries = [(name, value) for name, value in current.items()]
    elif isinstance(current, list):
        entries = [
            (row.get("name"), row) for row in current if isinstance(row, dict)
        ]
    else:
        entries = []
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


def build_lab_spec(template: dict, *, name: str, notebook: str, url_prefix: str) -> dict:
    """Clone one QuixLab deployment into a create request for a person's lab.

    Pure: the caller fetches the template and posts the result, so the field
    mapping is testable against no platform. The shape follows QuixLab's own
    child builder, which is the only spelling proven against a real Portal.
    """
    spec: dict = {}
    for key in (
        "workspaceId",
        "applicationId",
        "image",
        "deploymentType",
        "replicas",
        "cpuMillicores",
        "memoryInMb",
        "stateEnabled",
        "stateSize",
        "network",
    ):
        if template.get(key) is not None:
            spec[key] = template[key]
    spec.setdefault("deploymentType", "Service")
    spec["name"] = name
    # Track the application's latest build rather than pinning the template's
    # commit, so a lab made tomorrow carries today's QuixLab.
    spec["useLatest"] = True
    # An edit-mode lab serves a UI to one person, so it needs an address. The
    # prefix is NOT the name: the Portal caps it far shorter. See URL_PREFIX_LIMIT.
    spec["publicAccess"] = True
    spec["urlPrefix"] = url_prefix
    # A lab is one person's workspace, never a workspace-wide plugin. The
    # template IS a plugin, and copying its block would list every lab in
    # everybody's sidebar under the template's own name.
    spec["plugin"] = {"enabled": False, "isEnabled": False}
    spec["variables"] = clone_variables(
        template,
        {
            "QUIXLAB_MODE": "edit",
            "QUIXLAB_NOTEBOOK": notebook,
        },
    )
    return spec


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=quix_identity.portal_url(),
        transport=quix_identity.TRANSPORT,
        timeout=quix_identity.TIMEOUT_SECONDS,
    )


def _lab_from_row(row: dict, notebook: str, name: str, *, created: bool = False) -> Lab:
    """One Portal row as a lab.

    `name` is the name this module ASKED for, and it wins over the row's. The
    name is the key `ensure_lab` looks a lab up by, so a caller that reported
    whatever the create response happened to echo could name a lab that the
    next call would not find.
    """
    url = quixlab.usable_site_root(quixlab.read_text(row, "publicUrl")) or ""
    return Lab(
        id=quixlab.read_text(row, "deploymentId", "id"),
        name=name,
        status=quixlab.read_text(row, "status"),
        url=url,
        notebook=notebook,
        created=created,
    )


def _deployment_rows(client: httpx.Client, token: str, workspace: str) -> list[dict]:
    response = quix_identity.portal_get(
        client, WORKSPACE_DEPLOYMENTS_PATH.format(workspace_id=workspace), token
    )
    return quixlab.read_rows(response)


def _find(rows: list[dict], name: str) -> dict | None:
    for row in rows:
        if quixlab.read_text(row, "name") == name:
            return row
    return None


def _template_row(rows: list[dict]) -> dict | None:
    """The QuixLab deployment a lab is cloned from.

    Labs are excluded by name: a lab is itself built from the QuixLab library
    item, so without this the first lab made would become the template for the
    next and every pinned variable would compound.
    """
    named = os.environ.get(TEMPLATE_VAR, "").strip()
    for row in rows:
        if quixlab.read_text(row, "libraryItemId").lower() != quixlab.QUIXLAB_LIBRARY_ITEM_ID:
            continue
        if named:
            if quixlab.read_text(row, "deploymentId") == named or quixlab.read_text(row, "name") == named:
                return row
            continue
        if quixlab.read_text(row, "name").startswith((f"{LAB_PREFIX}-", f"{RUN_PREFIX}-")):
            continue
        return row
    return None


def find_lab(token: str, *, run_id: str, user_id: str) -> Lab | None:
    """This viewer's lab for this run, or None. It makes nothing.

    `ensure_lab` cannot serve a poll: it would create the lab that the poll is
    waiting for, every time the Portal was slow to list it.
    """
    workspace = quix_identity.workspace_id()
    if not quix_identity.portal_url() or not workspace:
        return None
    name = lab_name(user_id, run_id)
    pointer = notebook_pointer(notebook_key(run_id))
    with _client() as client:
        row = _find(_deployment_rows(client, token, workspace), name)
    return None if row is None else _lab_from_row(row, pointer, name)


def ensure_lab(
    token: str,
    *,
    run_id: str,
    user_id: str,
    notebook_source: str,
    write_notebook,
) -> Lab:
    """This viewer's lab for this run, made if it is not there yet.

    `write_notebook` takes `(key, text)` and stores the bytes. It is passed in
    rather than imported so a test proves the ORDER below without a blob store:
    the notebook is written BEFORE the deployment is created, because a lab
    that boots pointing at a key with nothing behind it opens the file picker
    instead of the run.
    """
    workspace = quix_identity.workspace_id()
    base = quix_identity.portal_url()
    if not base or not workspace:
        raise NoTemplate("this deployment cannot reach the Quix platform")

    name = lab_name(user_id, run_id)
    key = notebook_key(run_id)
    pointer = notebook_pointer(key)

    with _client() as client:
        rows = _deployment_rows(client, token, workspace)
        existing = _find(rows, name)
        if existing is not None:
            logger.info("quixlab lab %s already exists for run %s", name, run_id)
            return _lab_from_row(existing, pointer, name)

        template = _template_row(rows)
        if template is None:
            raise NoTemplate("the workspace holds no QuixLab deployment to clone")

        # The notebook first. See the docstring.
        write_notebook(key, notebook_source)

        template_id = quixlab.read_text(template, "deploymentId")
        full = quix_identity.portal_get(
            client, DEPLOYMENT_PATH.format(deployment_id=template_id), token
        ).json()
        spec = build_lab_spec(
            full,
            name=name,
            notebook=pointer,
            url_prefix=lab_url_prefix(user_id, run_id),
        )
        created = quix_identity.portal_send(
            client, "POST", DEPLOYMENTS_PATH, token, spec
        ).json()
        logger.info("quixlab lab %s created for run %s", name, run_id)
        return _lab_from_row(
            created if isinstance(created, dict) else {}, pointer, name, created=True
        )


def remove_lab(token: str, *, run_id: str, user_id: str) -> bool:
    """Remove this viewer's lab for this run. True when it is gone.

    A lab the Portal never had is already gone, so `PlatformMissing` is a
    success. Every other refusal is raised: a caller that dropped its link on a
    failed delete would leave a container running and billing.
    """
    workspace = quix_identity.workspace_id()
    if not quix_identity.portal_url() or not workspace:
        return False
    name = lab_name(user_id, run_id)
    with _client() as client:
        row = _find(_deployment_rows(client, token, workspace), name)
        if row is None:
            return True
        deployment_id = quixlab.read_text(row, "deploymentId")
        try:
            quix_identity.portal_send(
                client, "DELETE", DEPLOYMENT_PATH.format(deployment_id=deployment_id), token
            )
        except PlatformMissing:
            return True
    logger.info("quixlab lab %s removed for run %s", name, run_id)
    return True


# A create or a stored-log download can take seconds; the identity read's 5 s is too tight.
WRITE_TIMEOUT_SECONDS = 30.0


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


# Labs and definition-run Jobs clone the same template, excluding both kinds by name.
template_row = _template_row


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
    "NOTEBOOK_FOLDER",
    "NOTEBOOK_NAME",
    "NO_CLONE_VARS",
    "Lab",
    "NoTemplate",
    "PlatformMissing",
    "PlatformRefused",
    "PlatformUnreachable",
    "RUN_PREFIX",
    "TEMPLATE_VAR",
    "build_lab_spec",
    "client",
    "clone_variables",
    "delete_deployment",
    "deployment_rows",
    "ensure_lab",
    "find",
    "find_lab",
    "lab_name",
    "lab_url_prefix",
    "notebook_key",
    "notebook_pointer",
    "portal_send",
    "read_text",
    "remove_lab",
    "run_job_name",
    "sanitize",
    "template_row",
    "workspace",
]
