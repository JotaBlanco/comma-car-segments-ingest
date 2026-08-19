"""The only place in the frontend that speaks HTTP.

Every page goes through this module. Nothing else imports ``requests``, so the
backend contract has exactly one seam and a changed route is a one-file edit.

Two things are load-bearing here:

* **Error shape.** The backend reports a failure in three different envelopes:
  ``deps.require_blob()`` raises ``HTTPException(503, detail={...})`` so the body
  is ``{"detail": {"error": ..., "message": ..., "hint": ...}}``; the registered
  ``BlobUnavailableError`` handler returns the same keys at the *top* level; and
  door validation returns ``{"detail": "upload rejected", "problems": [...]}``.
  :func:`_unwrap` flattens all of them into one :class:`ApiError`, so a page never
  inspects a status code or guesses at a payload layout.
* **Blob honesty.** Most read endpoints need blob storage and answer ``503`` with
  ``error == "blob_storage_unavailable"`` and the *cause* in ``message`` while the
  Storage Gateway is down. :attr:`ApiError.is_blob_unavailable` is what lets a page
  print that cause instead of drawing an empty table.
"""

import os
from typing import Any

import requests

BACKEND_API_URL = os.environ.get("BACKEND_API_URL", "http://backend-api:80").rstrip("/")

READ_TIMEOUT = 30
WRITE_TIMEOUT = 60
UPLOAD_TIMEOUT = 600

BLOB_UNAVAILABLE = "blob_storage_unavailable"


class ApiError(Exception):
    """One flattened backend failure, ready to be rendered to a human."""

    def __init__(
        self,
        status: int | None,
        code: str,
        message: str,
        hint: str = "",
        url: str = "",
        payload: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.hint = hint
        self.url = url
        self.payload = payload

    @property
    def is_blob_unavailable(self) -> bool:
        """True when the Storage Gateway, not the request, is the problem."""
        return self.status == 503 and self.code == BLOB_UNAVAILABLE

    @property
    def is_not_found(self) -> bool:
        return self.status == 404

    @property
    def problems(self) -> list[dict]:
        """Per-item door-validation problems, if this was an upload rejection."""
        if isinstance(self.payload, dict):
            found = self.payload.get("problems")
            if isinstance(found, list):
                return found
        return []

    @property
    def findings(self) -> list[dict]:
        """Baseline integrity findings, if this was a baseline rejection."""
        if isinstance(self.payload, dict):
            found = self.payload.get("findings")
            if isinstance(found, list):
                return found
        return []


def _format_pydantic_error(entry: Any) -> str:
    if not isinstance(entry, dict):
        return str(entry)
    location = ".".join(str(part) for part in entry.get("loc") or [])
    return f"{location or 'body'}: {entry.get('msg') or 'invalid'}"


def _unwrap(status: int, payload: Any, url: str) -> ApiError:
    """Flatten the three backend error envelopes into one object."""
    code = f"http_{status}"
    message = ""
    hint = ""

    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, dict):
            code = str(detail.get("error") or code)
            message = str(detail.get("message") or detail)
            hint = str(detail.get("hint") or "")
        elif isinstance(detail, list):
            code = "invalid_request"
            message = "; ".join(_format_pydantic_error(entry) for entry in detail)
        elif isinstance(detail, str):
            message = detail
            if payload.get("problems") is not None:
                code = "upload_rejected"
                message = (
                    f"{detail} at stage {payload.get('stage')!r}: "
                    f"{payload.get('problem_count')} problem(s)"
                )
            elif payload.get("findings") is not None:
                code = "baseline_rejected"
                message = f"{detail}: {payload.get('error_count')} error finding(s)"
        if not message:
            code = str(payload.get("error") or code)
            message = str(payload.get("message") or payload)
            hint = str(payload.get("hint") or hint)
    else:
        message = str(payload)

    return ApiError(
        status=status, code=code, message=message, hint=hint, url=url, payload=payload
    )


def _params(**kwargs: Any) -> dict:
    """Drop unset filters so the backend applies its own defaults."""
    return {key: value for key, value in kwargs.items() if value not in (None, "", [])}


def _call(
    method: str,
    path: str,
    *,
    params: dict | None = None,
    json: Any = None,
    files: Any = None,
    data: Any = None,
    timeout: int = READ_TIMEOUT,
    raw: bool = False,
) -> Any:
    url = f"{BACKEND_API_URL}{path}"
    try:
        response = requests.request(
            method, url, params=params, json=json, files=files, data=data, timeout=timeout
        )
    except requests.exceptions.Timeout as exc:
        raise ApiError(
            status=None,
            code="timeout",
            message=f"the backend did not answer within {timeout} s",
            hint="the request may still be running; reload before retrying a write",
            url=url,
        ) from exc
    except requests.exceptions.RequestException as exc:
        raise ApiError(
            status=None,
            code="unreachable",
            message=f"cannot reach the backend at {BACKEND_API_URL}: {exc}",
            hint="check BACKEND_API_URL and that the Backend API deployment is running",
            url=url,
        ) from exc

    if response.status_code >= 400:
        try:
            payload: Any = response.json()
        except ValueError:
            payload = response.text
        raise _unwrap(response.status_code, payload, url)

    if raw:
        return response.content
    if not response.content:
        return {}
    try:
        return response.json()
    except ValueError as exc:
        raise ApiError(
            status=response.status_code,
            code="not_json",
            message=f"{path} answered {len(response.content)} bytes that are not JSON",
            url=url,
        ) from exc


# --------------------------------------------------------------------------- ops


def health() -> dict:
    """Answers even with no Mongo, no broker and no blob; names every cause."""
    return _call("GET", "/health", timeout=10)


def mongo_health() -> dict:
    return _call("GET", "/health/mongo", timeout=10)


def fetch_bytes(path: str) -> bytes:
    """Fetch a backend-built path verbatim (figure urls arrive pre-built)."""
    return _call("GET", path, raw=True)


# --------------------------------------------------------------------- artifacts


def list_artifact_sets() -> dict:
    return _call("GET", "/artifact-sets")


def list_versions(set_name: str) -> dict:
    return _call("GET", f"/artifact-sets/{set_name}/versions")


def get_manifest(set_name: str, version: str) -> dict:
    return _call("GET", f"/artifact-sets/{set_name}/versions/{version}/manifest")


def version_diff(set_name: str, to_version: str, from_version: str | None = None) -> dict:
    return _call(
        "GET",
        f"/artifact-sets/{set_name}/diff",
        params=_params(to_version=to_version, from_version=from_version),
    )


# --------------------------------------------------------------------- baselines


def list_baselines() -> dict:
    return _call("GET", "/baselines")


def get_baseline(baseline_id: str) -> dict:
    return _call("GET", f"/baselines/{baseline_id}")


def create_baseline(
    requirements_version: str,
    test_specs_version: str,
    test_impl_version: str,
    signal_catalog_version: str,
    label: str = "",
    created_by: str = "",
) -> dict:
    return _call(
        "POST",
        "/baselines",
        json={
            "requirements_version": requirements_version,
            "test_specs_version": test_specs_version,
            "test_impl_version": test_impl_version,
            "signal_catalog_version": signal_catalog_version,
            "label": label,
            "created_by": created_by,
        },
        timeout=WRITE_TIMEOUT,
    )


def dry_run_baseline(
    requirements_version: str,
    test_specs_version: str,
    test_impl_version: str,
    signal_catalog_version: str,
) -> dict:
    return _call(
        "POST",
        "/baselines/dry-run",
        json={
            "requirements_version": requirements_version,
            "test_specs_version": test_specs_version,
            "test_impl_version": test_impl_version,
            "signal_catalog_version": signal_catalog_version,
        },
        timeout=WRITE_TIMEOUT,
    )


# ----------------------------------------------------------------------- catalog


def list_requirements(
    baseline: str | None = None,
    test_run_id: str | None = None,
    run_version: int | None = None,
    chapter: str | None = None,
    coverage: str | None = None,
    verification_method: str | None = None,
    verification_tag: str | None = None,
    q: str | None = None,
) -> dict:
    return _call(
        "GET",
        "/requirements",
        params=_params(
            baseline=baseline,
            test_run_id=test_run_id,
            run_version=run_version,
            chapter=chapter,
            coverage=coverage,
            verification_method=verification_method,
            verification_tag=verification_tag,
            q=q,
        ),
    )


def get_requirement(
    req_id: str,
    baseline: str | None = None,
    test_run_id: str | None = None,
    run_version: int | None = None,
) -> dict:
    return _call(
        "GET",
        f"/requirements/{req_id}",
        params=_params(baseline=baseline, test_run_id=test_run_id, run_version=run_version),
    )


def list_test_cases(
    baseline: str | None = None,
    test_run_id: str | None = None,
    run_version: int | None = None,
    req_id: str | None = None,
) -> dict:
    return _call(
        "GET",
        "/test-cases",
        params=_params(
            baseline=baseline,
            test_run_id=test_run_id,
            run_version=run_version,
            req_id=req_id,
        ),
    )


def get_test_case(
    tc_id: str,
    baseline: str | None = None,
    test_run_id: str | None = None,
    run_version: int | None = None,
) -> dict:
    return _call(
        "GET",
        f"/test-cases/{tc_id}",
        params=_params(baseline=baseline, test_run_id=test_run_id, run_version=run_version),
    )


def get_test_impl(tc_id: str, baseline: str | None = None) -> dict:
    return _call("GET", f"/test-impl/{tc_id}", params=_params(baseline=baseline))


def preview_test_impl(tc_id: str, baseline: str | None = None, max_lines: int = 200) -> dict:
    return _call(
        "GET",
        f"/test-impl/{tc_id}/preview",
        params=_params(baseline=baseline, max_lines=max_lines),
    )


def download_test_impl(
    tc_id: str, baseline: str | None = None, path: str | None = None
) -> bytes:
    """The backend streams the object; the frontend never sees a blob url."""
    return _call(
        "GET",
        f"/test-impl/{tc_id}/code",
        params=_params(baseline=baseline, path=path),
        raw=True,
    )


def get_signal_catalog(baseline: str | None = None) -> dict:
    return _call("GET", "/signal-catalog", params=_params(baseline=baseline))


# ---------------------------------------------------------------------- registry


def list_devices() -> dict:
    return _call("GET", "/devices")


def get_device(device_id: str) -> dict:
    return _call("GET", f"/devices/{device_id}")


def create_device(
    device_id: str, name: str, kind: str = "plant-sim", description: str = ""
) -> dict:
    """Register a device. ``kind`` is one of plant-sim / hil / vehicle / bench.

    Answers ``409`` when ``device_id`` already exists and ``422`` when it does not
    match the path-safe pattern. A device carries no version of its own:
    ``create_device_version`` is the second write, and a run needs both.
    """
    return _call(
        "POST",
        "/devices",
        json={
            "device_id": device_id,
            "name": name,
            "kind": kind,
            "description": description,
        },
        timeout=WRITE_TIMEOUT,
    )


def create_device_version(
    device_id: str,
    sw_version: str,
    hw_version: str,
    plant_spec_ref: str = "",
    tool_name: str = "",
    tool_version: str = "",
    asammdf_version: str = "",
    dbc_id: str | None = None,
    config_id: str | None = None,
    config_version: int | None = None,
    make_current: bool = True,
) -> dict:
    """Register one immutable ``(sw_version, hw_version)`` pair of a device.

    These are exactly the fields ``DeviceVersionCreate`` declares. That model sets
    ``extra="forbid"``, so anything else - ``notes`` above all - is a ``422`` and not
    an ignored key, which is why this function takes no ``notes``.

    ``make_current`` only touches the *device* document's ``current_sw_version`` /
    ``current_hw_version``. Nothing in this frontend reads those two fields: the run
    form lists the ``versions`` array of ``GET /devices/{id}``, so an unset current
    version cannot hide a registered pair.
    """
    return _call(
        "POST",
        f"/devices/{device_id}/versions",
        json={
            "sw_version": sw_version,
            "hw_version": hw_version,
            "plant_spec_ref": plant_spec_ref,
            "tool_name": tool_name,
            "tool_version": tool_version,
            "asammdf_version": asammdf_version,
            "dbc_id": dbc_id,
            "config_id": config_id,
            "config_version": config_version,
            "make_current": make_current,
        },
        timeout=WRITE_TIMEOUT,
    )


def list_parameter_sets(config_id: str | None = None) -> dict:
    return _call("GET", "/parameter-sets", params=_params(config_id=config_id))


def get_parameter_set(config_id: str, config_version: int) -> dict:
    return _call("GET", f"/parameter-sets/{config_id}/{config_version}")


def diff_parameter_sets(config_id: str, config_version: int, other_version: int) -> dict:
    return _call("GET", f"/parameter-sets/{config_id}/{config_version}/diff/{other_version}")


def create_parameter_set(
    config_id: str,
    config_version: int,
    target_key: str = "",
    category: str = "plant-config",
    params: dict | None = None,
    content_url: str | None = None,
    notes: str = "",
) -> dict:
    """Register one immutable ``(config_id, config_version)`` a run can pin.

    ``config_id`` must match ``^CFG-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`` and
    ``config_version`` must be an integer ``>= 1``; both are checked in
    ``ui/registry_forms.py`` before the call, so the operator gets a sentence instead
    of a ``422``. The backend canonicalises ``params`` and derives ``sha256sum``,
    ``canonical_sha256`` and ``config_hash12`` from it - the same rule the plant uses
    for the hash it embeds in every MF4, which is what makes the provenance check at
    evaluation time possible.
    """
    return _call(
        "POST",
        "/parameter-sets",
        json={
            "config_id": config_id,
            "config_version": config_version,
            "target_key": target_key,
            "category": category,
            "params": params or {},
            "content_url": content_url,
            "notes": notes,
        },
        timeout=WRITE_TIMEOUT,
    )


# ------------------------------------------------------------------------ traces


def list_traces(
    device_id: str | None = None,
    tc_id: str | None = None,
    test_run_id: str | None = None,
    ingest_status: str | None = None,
    config_hash12: str | None = None,
    limit: int = 500,
) -> dict:
    return _call(
        "GET",
        "/traces",
        params=_params(
            device_id=device_id,
            tc_id=tc_id,
            test_run_id=test_run_id,
            ingest_status=ingest_status,
            config_hash12=config_hash12,
            limit=limit,
        ),
    )


def get_trace(trace_key: str) -> dict:
    return _call("GET", f"/traces/{trace_key}")


def get_trace_meta(trace_key: str) -> dict:
    return _call("GET", f"/traces/{trace_key}/meta")


# --------------------------------------------------------------------- test runs


def list_test_runs(
    baseline: str | None = None,
    device_id: str | None = None,
    config_id: str | None = None,
    status: str | None = None,
    limit: int = 200,
) -> dict:
    return _call(
        "GET",
        "/test-runs",
        params=_params(
            baseline=baseline,
            device_id=device_id,
            config_id=config_id,
            status=status,
            limit=limit,
        ),
    )


def create_test_run(body: dict) -> dict:
    return _call("POST", "/test-runs", json=body, timeout=WRITE_TIMEOUT)


def get_test_run(test_run_id: str) -> dict:
    return _call("GET", f"/test-runs/{test_run_id}")


def submit_test_run(test_run_id: str) -> dict:
    return _call("POST", f"/test-runs/{test_run_id}/submit", timeout=WRITE_TIMEOUT)


def attach_traces(
    test_run_id: str, tc_ids: list[str], trace_keys: list[str], attached_by: str = ""
) -> dict:
    return _call(
        "POST",
        f"/test-runs/{test_run_id}/attachments",
        json={"tc_ids": tc_ids, "trace_keys": trace_keys, "attached_by": attached_by},
        timeout=WRITE_TIMEOUT,
    )


def get_attachments(test_run_id: str, run_version: int | None = None) -> dict:
    return _call(
        "GET",
        f"/test-runs/{test_run_id}/attachments",
        params=_params(run_version=run_version),
    )


def get_readiness(test_run_id: str, run_version: int | None = None) -> dict:
    return _call(
        "GET",
        f"/test-runs/{test_run_id}/readiness",
        params=_params(run_version=run_version),
    )


def request_evaluation(
    test_run_id: str,
    trigger: str = "manual",
    requested_by: str = "",
    new_run_version: bool = False,
) -> dict:
    return _call(
        "POST",
        f"/test-runs/{test_run_id}/evaluate",
        json={
            "trigger": trigger,
            "requested_by": requested_by,
            "new_run_version": new_run_version,
        },
        timeout=WRITE_TIMEOUT,
    )


def record_manual_verdict(
    test_run_id: str,
    tc_id: str,
    verdict: str,
    author: str,
    note: str = "",
    evidence_ref: str | None = None,
    run_version: int | None = None,
) -> dict:
    body: dict = {
        "tc_id": tc_id,
        "verdict": verdict,
        "author": author,
        "note": note,
        "evidence_ref": evidence_ref,
    }
    if run_version is not None:
        body["run_version"] = run_version
    return _call(
        "POST",
        f"/test-runs/{test_run_id}/manual-verdict",
        json=body,
        timeout=WRITE_TIMEOUT,
    )


def generate_report(
    test_run_id: str,
    run_version: int | None = None,
    requested_by: str = "",
    lessons_learned: str | None = None,
) -> dict:
    body: dict = {"requested_by": requested_by}
    if run_version is not None:
        body["run_version"] = run_version
    if lessons_learned is not None:
        body["lessons_learned"] = lessons_learned
    return _call("POST", f"/test-runs/{test_run_id}/report", json=body, timeout=UPLOAD_TIMEOUT)


def set_lessons_learned(test_run_id: str, lessons_learned: str) -> dict:
    return _call(
        "PUT",
        f"/test-runs/{test_run_id}/lessons-learned",
        json={"lessons_learned": lessons_learned},
        timeout=WRITE_TIMEOUT,
    )


# ----------------------------------------------------------------------- results


def list_results(
    test_run_id: str,
    run_version: int | None = None,
    verdict: str | None = None,
    tc_id: str | None = None,
    req_id: str | None = None,
) -> dict:
    return _call(
        "GET",
        "/results",
        params=_params(
            test_run_id=test_run_id,
            run_version=run_version,
            verdict=verdict,
            tc_id=tc_id,
            req_id=req_id,
        ),
    )


def get_metrics(test_run_id: str, run_version: int) -> dict:
    return _call("GET", f"/metrics/{test_run_id}/{run_version}")


def get_requirement_verdicts(test_run_id: str, run_version: int) -> dict:
    return _call("GET", f"/requirement-verdicts/{test_run_id}/{run_version}")


def list_report_revisions(test_run_id: str, run_version: int) -> dict:
    return _call("GET", f"/reports/{test_run_id}/{run_version}")


def report_json(test_run_id: str, run_version: int, revision: str) -> dict:
    return _call("GET", f"/reports/{test_run_id}/{run_version}/{revision}/report.json")


def report_html(test_run_id: str, run_version: int, revision: str) -> bytes:
    return _call(
        "GET", f"/reports/{test_run_id}/{run_version}/{revision}/report.html", raw=True
    )


def report_plot(test_run_id: str, run_version: int, revision: str, filename: str) -> bytes:
    return _call(
        "GET",
        f"/reports/{test_run_id}/{run_version}/{revision}/plots/{filename}",
        raw=True,
    )


# ----------------------------------------------------------------------- uploads


def upload_requirements(
    filename: str, data: bytes, uploaded_by: str = "", notes: str = ""
) -> dict:
    """``.reqif``, ``.reqifz`` or ``.json``; one upload mints one version."""
    return _call(
        "POST",
        "/uploads/requirements",
        files={"file": (filename, data)},
        data={"uploaded_by": uploaded_by, "notes": notes},
        timeout=UPLOAD_TIMEOUT,
    )


def upload_test_specs(
    filename: str, data: bytes, uploaded_by: str = "", notes: str = ""
) -> dict:
    return _call(
        "POST",
        "/uploads/test-specs",
        files={"file": (filename, data)},
        data={"uploaded_by": uploaded_by, "notes": notes},
        timeout=UPLOAD_TIMEOUT,
    )


def upload_signal_catalog(
    filename: str, data: bytes, uploaded_by: str = "", notes: str = ""
) -> dict:
    return _call(
        "POST",
        "/uploads/signal-catalog",
        files={"file": (filename, data)},
        data={"uploaded_by": uploaded_by, "notes": notes},
        timeout=UPLOAD_TIMEOUT,
    )


def upload_test_impl(
    filename: str,
    data: bytes,
    tc_id: str,
    entrypoint: str,
    language: str = "python",
    requirements_txt: tuple[str, bytes] | None = None,
    timeout_s: int = 120,
    trace_required: bool = True,
    description: str = "",
    uploaded_by: str = "",
    notes: str = "",
) -> dict:
    files: dict = {"file": (filename, data)}
    if requirements_txt is not None:
        files["requirements_file"] = requirements_txt
    return _call(
        "POST",
        "/uploads/test-impl",
        files=files,
        data={
            "tc_id": tc_id,
            "entrypoint": entrypoint,
            "language": language,
            "timeout_s": str(timeout_s),
            "trace_required": str(trace_required).lower(),
            "description": description,
            "uploaded_by": uploaded_by,
            "notes": notes,
        },
        timeout=UPLOAD_TIMEOUT,
    )


def upload_trace(
    filename: str,
    data: bytes,
    device_id: str,
    sw_version: str,
    hw_version: str,
    test_run_id: str | None = None,
    tc_ids: list[str] | None = None,
    uploaded_by: str = "",
) -> dict:
    """One MF4 may be attached to several cases in the same submit."""
    form: list[tuple[str, str]] = [
        ("device_id", device_id),
        ("sw_version", sw_version),
        ("hw_version", hw_version),
        ("uploaded_by", uploaded_by),
    ]
    if test_run_id:
        form.append(("test_run_id", test_run_id))
    for tc_id in tc_ids or []:
        form.append(("tc_ids", tc_id))
    return _call(
        "POST",
        "/uploads/traces",
        files={"file": (filename, data, "application/octet-stream")},
        data=form,
        timeout=UPLOAD_TIMEOUT,
    )


def convergence_check(
    reqif_name: str, reqif_data: bytes, json_name: str, json_data: bytes
) -> dict:
    """Prove the ReqIF and JSON upload paths converge. No version is minted."""
    return _call(
        "POST",
        "/uploads/requirements/convergence-check",
        files={
            "reqif_file": (reqif_name, reqif_data),
            "json_file": (json_name, json_data),
        },
        timeout=UPLOAD_TIMEOUT,
    )


# ------------------------------------------------------------------------- graph


def graph_neighbourhood(
    entity: str, entity_id: str, baseline: str | None = None, depth: int = 1
) -> dict:
    return _call(
        "GET",
        f"/graph/{entity}/{entity_id}",
        params=_params(baseline=baseline, depth=depth),
    )
