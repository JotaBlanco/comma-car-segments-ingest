"""Publish a processed result from a QuixLab notebook back to the Test Manager.

Paste this whole file into one QuixLab cell, then call `publish_result(...)` or
`publish_result_file(...)` in the next cell. The file imports nothing from this
repository, so the paste is the whole install.

## Where this runs

A QuixLab cell runs **inside the QuixLab server process**: `exec()` at
`quixlab/src/quixlab/server/app.py:2395` and `quixlab/src/quixlab/canvas.py:203`.
So a cell can import the QuixLab server modules, and this file does.

## The run id — QuixLab already keeps it

The Test Manager frame posts `{type: "TM_IMPORT", runId, signals}`
(`frontend/components/screens/run-detail/quixlab-panel.tsx:139`). QuixLab's
`boot.js` POSTs it to its own `/api/import/run`, which stores the run id **in
the viewer's session** (`quixlab/src/quixlab/server/embed.py`, route
`import_run`). A cell reads it back with `ql.current_run()`. So this file never
asks a person for a run id: `run_id=None` reads the imported one.

The session is per viewer, so two people may open two runs in one QuixLab
deployment and neither one sees the other's run.

## The token — the viewer's own, never a new variable

QuixLab already resolves the caller's Quix token, and the order matters:

1. `quixlab.server.auth.viewer_token_var` — the token of the request being
   served right now. On a shared deployment this is the only resolution that
   cannot cross two viewers.
2. `quixlab.quix_platform._resolve_user_token()` — QuixLab's own full chain:
   the request context, then the local auth proxy, then the environment names
   at `quix_platform.py:35-41`.
3. `quixlab.server.auth.current_token()` — **last**, not first. It returns the
   *most recently validated* session (`_latest_valid_session`), which on a
   shared deployment may belong to another viewer. It is right for a one-person
   dev session and wrong for a shared one, so it sits below the two resolutions
   that name this viewer.
4. The environment names, for a standalone run with no QuixLab session.

The Test Manager API accepts that token: `api/api/auth.py:require_token` takes
the static token or a live Quix token, and `api/api/quix_identity.py` turns the
live one into a real person. The journal then names that person
(`auth.py:journal_actor`). So the write is attributable without any new
credential and without any new variable.

**No token ever leaves this module.** It is never printed, never logged, never
put in a URL and never put in an error message.

## Finding the Test Manager — the same way the Test Manager finds QuixLab

`api/api/quixlab.py` asks the Portal for `GET /workspaces/{id}/deployments` and
keeps the rows whose `libraryItemId` is "quixlab". This file makes the same
call in the other direction, but it cannot use the same filter: the Test
Manager is not a library item, so its `libraryItemId` is empty.

So the match runs in three steps, and only the second one decides.

**Step 1 narrows, and spends no credential.** Keep a row when it is a `Service`,
when `publicUrl` passes the same four-part proof `usable_site_root` applies in
`api/api/quixlab.py`, and when it is not a QuixLab.

**Step 2 proves, with an unauthenticated GET.** Read `{root}/openapi.json` with
no `Authorization` header at all. Accept the row only when the answer is a JSON
object whose `info.title` is exactly "Test Manager API" and whose `paths` holds
**both** `/api/v1/results` and `/api/v1/results/upload`.

**Step 3 breaks a tie, and only a tie.** When two deployments both pass step 2,
prefer the one whose `applicationId` is the API application path, then the one
whose name carries the word "api". Both hints are weak on their own, and
neither is ever used on its own: every row they choose between has already
proved it serves the two routes. When no hint separates the list, this file
still refuses to guess.

Why that match is safe:

* **The probe carries no credential.** A wrong guess costs one bare GET. The
  viewer's token is sent only after the proof holds, and only to the host that
  passed it. A name match or an image match cannot say that: it would have to
  send the token to decide.
* **It proves the routes, not a label.** A deployment somebody named "Test
  Manager" fails unless it serves the two routes this file posts to. A Test
  Manager somebody renamed still passes. So no rename and no coincidence of
  names can move the write.
* **`/openapi.json` is open on purpose, in every environment**
  (`api/api/main.py:create_app`, held by `api/tests/test_docs_gate.py`). The
  probe therefore never needs auth and never reads a 401 it would have to guess
  about. The document names routes and shapes only: no host, no credential, no
  data.
* **The front end cannot answer it.** `frontend/next.config.ts` rewrites
  `/api/v1/:path*` and nothing else, and `frontend/app/` holds no `openapi`
  route, so the front-end deployment serves its own 404 and never becomes a
  second match. `/health` would have been the wrong probe for exactly this
  reason: `frontend/app/health/` answers it too, and its body says nothing
  about who answered.

The one residual risk: somebody who can deploy into the workspace could stand up
a pod that serves a fake `openapi.json`. They would then be a **second** match
and this file raises instead of choosing. To win they would have to stop the
real Test Manager as well — and workspace Update is already far more power than
one viewer's token. That risk is stated, not hidden.

**Exactly one match wins with no question.** More than one raises with the list,
so a person names one. None raises and names what to check.

## What this file never bends

The Test Manager owns these rules and this file only obeys them:

* the provenance gate and all six mandatory fields — a blank one answers 422
  `provenance_required`;
* the byte-identical replay rule — an identical body answers **200** and mints
  no version, so a retry is safe;
* **409 `version_conflict`** on a contended write — this file reports it and
  never retries into it;
* the **100 MiB** cap on an upload — checked here as well, before a byte leaves
  this process, so a refused upload never crosses the network;
* audit before bytes on a read, and bytes before audit on a write. Both are the
  server's order (`api/api/routers/results.py:upload_result`), and nothing here
  reorders them.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
import uuid
from datetime import UTC, datetime
from urllib.parse import urlsplit

# --------------------------------------------------------------------------
# What the platform injects. Never define a second name for one of these.
# --------------------------------------------------------------------------

PORTAL_API_VAR = "Quix__Portal__Api"
WORKSPACE_VAR = "Quix__Workspace__Id"

# The Portal reads the version from this header, and the deployments route
# declares `[ApiVersion("2.0")]`. Every Quix client sends it.
PORTAL_API_VERSION = "2.0"

# The route `api/api/quixlab.py` already calls, in the other direction.
DEPLOYMENTS_PATH = "/workspaces/{workspace_id}/deployments"

# A QuixLab is built from this library item. This file EXCLUDES those rows: a
# QuixLab is the page the cell runs on, never the Test Manager it posts to.
QUIXLAB_LIBRARY_ITEM_ID = "quixlab"

# The token names QuixLab reads when no session exists. The order is
# `quixlab/src/quixlab/quix_platform.py:35-41`, and it is deliberate there: an
# explicit Portal token or PAT beats the SDK token the platform injects
# everywhere, so a person who sets one to fix a 403 actually fixes it.
TOKEN_ENV_NAMES = (
    "QUIX_PAT_TOKEN",
    "QUIX_PORTAL_TOKEN",
    "Quix__Portal__Token",
    "QUIX_PAT",
    "Quix__Sdk__Token",
    "QUIX_SDK_TOKEN",
)

# --------------------------------------------------------------------------
# What proves a deployment is the Test Manager.
# --------------------------------------------------------------------------

# The open schema document. `api/api/main.py` keeps it open in every
# environment, and `api/tests/test_docs_gate.py` holds that line.
OPENAPI_PATH = "/openapi.json"

# `FastAPI(title=...)` in `api/api/main.py:create_app`.
API_TITLE = "Test Manager API"

# Every route sits under this prefix (`api/api/main.py`, and `API_PREFIX` in
# `api/seed/fixtures.py:60`). The design document's snippet omits it; the real
# address carries it.
API_PREFIX = "/api/v1"

# The two routes this file posts to. The probe demands both, so a match always
# serves what the write needs.
RESULTS_PATH = f"{API_PREFIX}/results"
UPLOAD_PATH = f"{API_PREFIX}/results/upload"
PROOF_PATHS = (RESULTS_PATH, UPLOAD_PATH)

# Two TIE-BREAKERS, and neither one ever decides a match on its own. They only
# separate deployments that ALREADY passed the probe above. See `_prefer`.
#
# The application path the API deployment runs: `application: api` in
# `quix.yaml`. The front end runs `frontend`.
API_APPLICATION_ID = "api"

# The deployment name, last of all, because a person may edit it. The real
# workspace holds "Test Manager - API" and this repository's `quix.yaml` writes
# "Test Manager API", so this looks for the word and never for a whole string.
_API_NAME = re.compile(r"\bapi\b", re.IGNORECASE)

# The cap on one uploaded result
# (`MAX_UPLOAD_BYTES`, `api/api/routers/results.py`).
MAX_UPLOAD_BYTES = 100 * 1024 * 1024

# `quix_identity.TIMEOUT_SECONDS` is five seconds per Portal call. The probe
# uses the same. The two writes use the design document's own numbers.
PORTAL_TIMEOUT_SECONDS = 5.0
PROBE_TIMEOUT_SECONDS = 5.0
POST_TIMEOUT_SECONDS = 30.0
UPLOAD_TIMEOUT_SECONDS = 60.0

_ALLOWED_SCHEMES = frozenset({"http", "https"})

# A filename lands inside a multipart header, so a quote, a backslash or a
# control character would break the envelope or forge a second part.
_UNSAFE_FILENAME = re.compile("[\"\\\\\x00-\x1f\x7f]")


# What an optional QuixLab import, or a read outside a request, can raise. A
# cell must fall through to the next source, never crash on a name that a given
# QuixLab build does not carry.
_OPTIONAL = (ImportError, AttributeError, LookupError, TypeError, OSError)


class PublishError(RuntimeError):
    """Something stopped the publish, and the message says what to do next.

    No message of this class ever carries a token. A reason that would need one
    names the variable instead.
    """


# --------------------------------------------------------------------------
# 1. The token
# --------------------------------------------------------------------------


def _token_from_viewer_session() -> str:
    """The token of the request being served right now, or an empty string.

    This is the exact viewer. On a shared QuixLab deployment it is the only
    resolution that cannot answer with another person's token.
    """
    try:
        from quixlab.server.auth import viewer_token_var

        return (viewer_token_var.get() or "").strip()
    except _OPTIONAL:
        return ""


def _token_from_quixlab_chain() -> str:
    """QuixLab's own resolver: request context, then auth proxy, then the
    environment. It answers `(token, source)` and this drops the source."""
    try:
        from quixlab.quix_platform import _resolve_user_token

        token, _source = _resolve_user_token()
        return (token or "").strip()
    except _OPTIONAL:
        return ""


def _token_from_latest_session() -> str:
    """The most recently validated session's token, or an empty string.

    `quixlab.server.auth.current_token()` reads `_latest_valid_session`, so on a
    shared deployment it may name another viewer. It is correct on a personal
    dev session, so it stays — below both resolutions that name this viewer.
    """
    try:
        from quixlab.server.auth import current_token

        return (current_token() or "").strip()
    except _OPTIONAL:
        return ""


def _token_from_environment() -> str:
    """The first token name the environment sets. For a standalone run."""
    for name in TOKEN_ENV_NAMES:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def viewer_token() -> str:
    """Return the caller's Quix token. Raise when no source holds one.

    The returned value never reaches a log, a print or an error message.
    """
    for source in (
        _token_from_viewer_session,
        _token_from_quixlab_chain,
        _token_from_latest_session,
        _token_from_environment,
    ):
        token = source()
        if token:
            if not token.isascii():
                # A header value must encode to latin-1, so a non-ASCII token
                # cannot leave this process. `quix_identity.identify` refuses
                # the same way, and for the same reason.
                raise PublishError("the resolved token is not a Quix token")
            return token
    raise PublishError(
        "no Quix token is available — open this notebook from the Test Manager "
        "so the frame signs you in, or set QUIX_PAT_TOKEN for a standalone run"
    )


# --------------------------------------------------------------------------
# 2. One HTTP call, and one seam the tests replace
# --------------------------------------------------------------------------


def _http(
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes | None,
    timeout: float,
) -> tuple[int, bytes]:
    """Send one request. Return the status and the body.

    An HTTP error status is an answer, not a failure, so this returns it. Only
    a transport fault raises, and that message names no header and no token.
    """
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except Exception as error:
        raise PublishError(
            f"{method} {url} did not answer: {type(error).__name__}"
        ) from error


def _json_body(payload: bytes):
    """Read a body as JSON, or answer None. A body we cannot read is not JSON."""
    try:
        return json.loads(payload)
    except (ValueError, TypeError):
        return None


# --------------------------------------------------------------------------
# 3. Finding the Test Manager
# --------------------------------------------------------------------------


def usable_site_root(value: str) -> str | None:
    """Return the site root of *value*, or None when it is not usable.

    This is the same four-part proof `api/api/quixlab.py:usable_site_root`
    applies: an http or https scheme, a host, no query and no fragment, and no
    userinfo. A bad row drops out of the list; it never fails the whole call.
    """
    candidate = (value or "").strip()
    if not candidate:
        return None
    parts = urlsplit(candidate)
    if parts.scheme not in _ALLOWED_SCHEMES or not parts.hostname:
        return None
    if parts.query or parts.fragment or parts.username or parts.password:
        return None
    return candidate.rstrip("/")


def _text(row: dict, name: str) -> str:
    """Read one named field off a Portal row as a stripped string.

    The name is passed explicitly, never guessed, so a renamed Portal field
    reads as empty and never as a wrong value.
    """
    value = row.get(name)
    return value.strip() if isinstance(value, str) and value.strip() else ""


def _workspace_deployments(portal: str, workspace: str, token: str) -> list[dict]:
    """Ask the Portal for the workspace deployments. Raise on any refusal.

    **This reads the body, never the status.** The Portal answers a denial with
    200 and a body of `false` (`Quix.Portal.Api/Controllers/AuthController.cs`),
    so a status check would read every denial as a grant.
    """
    url = portal.rstrip("/") + DEPLOYMENTS_PATH.format(workspace_id=workspace)
    status, payload = _http(
        "GET",
        url,
        {"Authorization": f"Bearer {token}", "X-Version": PORTAL_API_VERSION},
        None,
        PORTAL_TIMEOUT_SECONDS,
    )
    if status in (401, 403):
        raise PublishError(
            "the Quix platform refused to list this workspace — sign in to the "
            "Test Manager again, then re-open this notebook"
        )
    if status >= 400:
        raise PublishError(
            f"the Quix platform answered {status} for the deployment list"
        )
    body = _json_body(payload)
    if not isinstance(body, list):
        # `false` lands here, and so does any error object. Neither is a list.
        raise PublishError("the Quix platform did not answer with a deployment list")
    return [row for row in body if isinstance(row, dict)]


def _serves_test_manager(root: str) -> bool:
    """Probe *root* with NO credential. True when it is a Test Manager API.

    The proof is the open schema document: the exact title, and both routes
    this file posts to. Nothing in this call can leak the viewer's token,
    because the call carries no token.
    """
    try:
        status, payload = _http(
            "GET",
            root + OPENAPI_PATH,
            {"Accept": "application/json"},
            None,
            PROBE_TIMEOUT_SECONDS,
        )
    except PublishError:
        # A deployment that does not answer is not a match. One dead pod in the
        # workspace must never stop the publish.
        return False
    if status != 200:
        return False
    document = _json_body(payload)
    if not isinstance(document, dict):
        return False
    info = document.get("info")
    if not isinstance(info, dict) or info.get("title") != API_TITLE:
        return False
    paths = document.get("paths")
    if not isinstance(paths, dict):
        return False
    return all(path in paths for path in PROOF_PATHS)


def _candidates(rows: list[dict]) -> list[tuple[str, str, str]]:
    """Narrow the Portal rows to the ones worth probing. Spends no credential.

    Keeps a public `Service` with a usable site root, and drops every QuixLab:
    a QuixLab is the page this cell runs on, never the target of the write.
    Answers `(name, site root, applicationId)` per row. Sorted by name, so the
    order never depends on the Portal's row order — the same rule
    `api/api/quixlab.py:list_instances` follows.
    """
    out: list[tuple[str, str, str]] = []
    for row in rows:
        if _text(row, "deploymentType").lower() != "service":
            continue
        if _text(row, "libraryItemId").lower() == QUIXLAB_LIBRARY_ITEM_ID:
            continue
        root = usable_site_root(_text(row, "publicUrl"))
        if root is None:
            continue
        out.append(
            (_text(row, "name") or "Test Manager", root, _text(row, "applicationId"))
        )
    out.sort(key=lambda item: item[0].lower())
    return out


def _prefer(found: list[tuple[str, str, str]]) -> list[tuple[str, str, str]]:
    """Break a tie between deployments that ALL already proved as a Test Manager.

    **A hint never decides on its own.** Every row reaching this function passed
    the unauthenticated probe, so each one already serves both routes this file
    posts to. The hints only choose between two proven Test Managers — for
    example an API deployment and a front end that proxies the schema too. That
    is why a weak signal is safe here and would not be safe as the match itself.

    Two hints, in order, and both come from the deployment quix.yaml:

    1. **`applicationId`**, which is the application path the deployment runs
       (`ApplicationPath`, `Quix.Portal.Api.Contract/Deployment.cs:207`). The API
       deployment names `application: api`, the front end names `frontend`.
    2. **The deployment name**, last, because a person may edit it. The real
       workspace holds "Test Manager - API" and this repository's quix.yaml
       writes "Test Manager API", so the test is a lower-case "api" word and
       never an exact string.

    Returns the narrowed list, or the list unchanged when no hint separates it.
    The caller still refuses to guess when more than one survives.
    """
    by_application = [row for row in found if row[2].lower() == API_APPLICATION_ID]
    if len(by_application) == 1:
        return by_application
    by_name = [row for row in found if _API_NAME.search(row[0])]
    if len(by_name) == 1:
        return by_name
    return found


def find_test_manager(token: str | None = None, quiet: bool = False) -> str:
    """Return the site root of the one Test Manager in this workspace.

    Exactly one match returns it and prints the chosen name, nothing else.
    More than one raises with the list, so a person names one.
    No match raises and names what to check.
    """
    portal = os.environ.get(PORTAL_API_VAR, "").strip().rstrip("/")
    workspace = os.environ.get(WORKSPACE_VAR, "").strip()
    if not portal or not workspace:
        raise PublishError(
            f"this pod cannot ask the Quix platform: {PORTAL_API_VAR} and "
            f"{WORKSPACE_VAR} must both be set — or pass base_url=... to "
            "publish to a Test Manager you name yourself"
        )

    rows = _workspace_deployments(portal, workspace, token or viewer_token())
    candidates = _candidates(rows)
    found = [row for row in candidates if _serves_test_manager(row[1])]
    if len(found) > 1:
        found = _prefer(found)

    if len(found) == 1:
        name, root, _application = found[0]
        if not quiet:
            print(name)
        return root

    if len(found) > 1:
        listed = "\n".join(f"  {name} — {root}" for name, root, _a in found)
        raise PublishError(
            f"{len(found)} deployments answer as a Test Manager API in workspace "
            f"{workspace}. Name one with base_url=...:\n{listed}"
        )

    raise PublishError(
        f"no deployment in workspace {workspace} answers as a Test Manager API. "
        f"This checked {len(candidates)} public service(s) at {OPENAPI_PATH}. "
        "Check that the Test Manager API deployment runs, that its public "
        "access is on, and that your Quix user may read this workspace."
    )


# --------------------------------------------------------------------------
# 4. The result body
# --------------------------------------------------------------------------


def _now_rfc3339() -> str:
    """The current UTC moment, in the shape the API's UtcDatetime accepts."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _current_run() -> str:
    """The run the Test Manager imported for this viewer, or an empty string.

    QuixLab stores it in the viewer's session when the frame posts `TM_IMPORT`,
    so the notebook never has to ask a person which run is on screen.
    """
    try:
        import quixlab

        return (quixlab.current_run() or "").strip()
    except _OPTIONAL:
        return ""


def build_body(
    *,
    result_key: str,
    name: str,
    tool: str,
    tool_version: str,
    parameters: str,
    input_file_ids: list[str],
    produced_by: str,
    run_id: str | None = None,
    description: str | None = None,
    produced_at: str | None = None,
) -> dict:
    """Build the `POST /results` body, with all six provenance fields.

    `run_id=None` reads the run the Test Manager imported into this session.
    `produced_at=None` stamps the current UTC moment.

    This never fills a provenance field with a placeholder. A blank one is the
    caller's to fix, and the API answers 422 `provenance_required` for it. An
    empty `input_file_ids` list is legal and it is not blank: the API stores the
    result and marks it `provenance_status: "flagged"`.
    """
    resolved_run = (run_id or "").strip() or _current_run()
    if not resolved_run:
        raise PublishError(
            "no run id — open this notebook from a Test Manager run so the "
            "frame imports one, or pass run_id=..."
        )
    return {
        "run_id": resolved_run,
        "result_key": result_key,
        "name": name,
        "description": description,
        "provenance": {
            "tool": tool,
            "tool_version": tool_version,
            "parameters": parameters,
            "input_file_ids": list(input_file_ids),
            "produced_by": produced_by,
            "produced_at": produced_at or _now_rfc3339(),
        },
    }


def _read_answer(status: int, payload: bytes, what: str) -> dict:
    """Turn the API's answer into the stored result, or raise naming the fault.

    201 is a new version. **200 is a byte-identical replay**: the API stored
    nothing and minted no version, so a retry is safe and this answers with the
    stored row. Every other status raises with the API's own code and message.
    """
    body = _json_body(payload)
    if status in (200, 201) and isinstance(body, dict):
        return body
    message = ""
    code = ""
    if isinstance(body, dict):
        message = str(body.get("message") or body.get("detail") or "")
        code = str(body.get("code") or "")
    if status == 409:
        # Another write holds this version. Never retry into it: the next
        # attempt would mint a second version of one result.
        raise PublishError(
            f"{what} answered 409 {code or 'version_conflict'} — another write "
            f"holds this result version. Read the result back before you retry. "
            f"{message}".strip()
        )
    raise PublishError(f"{what} answered {status} {code}: {message}".strip())


# --------------------------------------------------------------------------
# 5. The two calls
# --------------------------------------------------------------------------


def publish_result(
    *,
    result_key: str,
    name: str,
    tool: str,
    tool_version: str,
    parameters: str,
    input_file_ids: list[str],
    produced_by: str,
    run_id: str | None = None,
    description: str | None = None,
    produced_at: str | None = None,
    base_url: str | None = None,
) -> dict:
    """POST /results — store the row alone. Return the stored result.

    Use this when the numbers are the result. Use `publish_result_file` when a
    file is the result.
    """
    token = viewer_token()
    root = base_url.rstrip("/") if base_url else find_test_manager(token)
    body = build_body(
        result_key=result_key,
        name=name,
        tool=tool,
        tool_version=tool_version,
        parameters=parameters,
        input_file_ids=input_file_ids,
        produced_by=produced_by,
        run_id=run_id,
        description=description,
        produced_at=produced_at,
    )
    status, answer = _http(
        "POST",
        root + RESULTS_PATH,
        {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        json.dumps(body).encode("utf-8"),
        POST_TIMEOUT_SECONDS,
    )
    return _read_answer(status, answer, f"POST {RESULTS_PATH}")


def _multipart(filename: str, content: bytes, metadata: str) -> tuple[str, bytes]:
    """Build the two-part body: the file bytes and the metadata JSON string.

    Return the content type and the body. This checks the file name rather than
    escaping it: a quote, a backslash or a control character would close the
    header early and forge a second part, so such a name is refused outright.
    """
    clean = (filename or "").strip().replace("\\", "/").split("/")[-1]
    if not clean or _UNSAFE_FILENAME.search(clean):
        raise PublishError(
            "the file name must carry no quote, no backslash and no control character"
        )
    boundary = "----TestManager" + uuid.uuid4().hex
    marker = f"--{boundary}\r\n".encode()
    disposition = f'Content-Disposition: form-data; name="file"; filename="{clean}"\r\n'
    body = b"".join(
        (
            marker,
            b'Content-Disposition: form-data; name="metadata"\r\n',
            b"Content-Type: application/json\r\n\r\n",
            metadata.encode("utf-8"),
            b"\r\n",
            marker,
            disposition.encode("utf-8"),
            b"Content-Type: application/octet-stream\r\n\r\n",
            content,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        )
    )
    return f"multipart/form-data; boundary={boundary}", body


def publish_result_file(
    *,
    path: str,
    result_key: str,
    name: str,
    tool: str,
    tool_version: str,
    parameters: str,
    input_file_ids: list[str],
    produced_by: str,
    run_id: str | None = None,
    description: str | None = None,
    produced_at: str | None = None,
    base_url: str | None = None,
) -> dict:
    """POST /results/upload — store the bytes, then the row. Return the result.

    The body is the body `publish_result` sends, as a JSON string in the
    `metadata` part, **minus `storage_ref`**: the server mints that from the key
    it writes, and a supplied one answers 422 `storage_ref_not_allowed`.

    The 100 MiB cap is checked here as well, before a byte leaves this process.
    That never weakens the server's cap; it only stops a doomed upload early.

    The server's own order stands: the metadata, the checksum and the cap, the
    run, the replay check, the store, the bytes, the audit entry, then the row.
    Nothing here reorders it.
    """
    with open(path, "rb") as handle:
        content = handle.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise PublishError(
            f"the file is {len(content)} bytes and the cap is {MAX_UPLOAD_BYTES}"
        )

    token = viewer_token()
    root = base_url.rstrip("/") if base_url else find_test_manager(token)
    body = build_body(
        result_key=result_key,
        name=name,
        tool=tool,
        tool_version=tool_version,
        parameters=parameters,
        input_file_ids=input_file_ids,
        produced_by=produced_by,
        run_id=run_id,
        description=description,
        produced_at=produced_at,
    )
    content_type, payload = _multipart(path, content, json.dumps(body))
    status, answer = _http(
        "POST",
        root + UPLOAD_PATH,
        {
            "Authorization": f"Bearer {token}",
            "Content-Type": content_type,
            "Content-Length": str(len(payload)),
            "Accept": "application/json",
        },
        payload,
        UPLOAD_TIMEOUT_SECONDS,
    )
    return _read_answer(status, answer, f"POST {UPLOAD_PATH}")
