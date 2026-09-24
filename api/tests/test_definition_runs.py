"""/test-runs/{run_id}/definitions/{td_id}/run — a definition run as a QuixLab headless Job.

The properties held here:

1. **A run is a Job cloned from the workspace's QuixLab**, in run mode, on the
   definition's own notebook folder, with no public address and none of the template's
   pinning variables.
2. **The notebook is seeded once and never overwritten**, so a customised one stays.
3. **The exit code decides.** Exit 0 with a verdict records it, once; any other exit is
   failed and records nothing; a non-zero exit with no result line is an
   infrastructure failure, never a test result.
"""

import ast
import json
import re
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime

import httpx
import pytest
from pymongo.database import Database

from api import quix_identity, quixlab_provision, quixlab_run
from api.services import definition_runs, file_bytes, file_writes
from api.services.file_bytes import FileBytesUnavailable
from tests.factories_planning import make_definition, make_run
from tests.factories_results import seed_file

RUN = "sn002_20260723T131303942Z"
TD = "TD-EM-201"
PORTAL = "https://portal-api.dev.quix.io"
WORKSPACE = "ws-demo"
VIEWER = {"x-portal-token": "viewer-token"}
PATH = f"/api/v1/test-runs/{RUN}/definitions/{TD}/run"
JOB_ID = "dep-run"
SHA = "ab" * 32
IMPL_KEY = f"{WORKSPACE}/jama_ui/{RUN}/abababab-impl.py"
NOTEBOOK_KEY = f"{WORKSPACE}/jama_ui/definitions/{TD}/notebook.py"

TEMPLATE_ROW = {
    "deploymentId": "dep-template",
    "name": "QuixLab Aerospace",
    "libraryItemId": "quixlab",
    "status": "Running",
}

TEMPLATE_SPEC = {
    "deploymentId": "dep-template",
    "workspaceId": WORKSPACE,
    "applicationId": "app-quixlab",
    "image": "quixlab:1.2.3",
    "deploymentType": "Service",
    "cpuMillicores": 500,
    "memoryInMb": 2000,
    "replicas": 1,
    "stateEnabled": True,
    "network": {"serviceName": "quixlab", "ports": [{"port": 80, "targetPort": 8080}]},
    "publicAccess": True,
    "urlPrefix": "quixlab",
    "plugin": {"enabled": True, "sidebarItem": {"label": "QuixLab"}},
    "variables": {
        "TM_LAKE_TABLE": {"inputType": "FreeText", "value": "pcap_data_v1"},
        "QUIXLAB_MODE": {"inputType": "FreeText", "value": "edit"},
        "QUIXLAB_NOTEBOOK": {"inputType": "FreeText", "value": "main.py"},
        "QUIXLAB_PARAMS": {"inputType": "FreeText", "value": '{"leak": 1}'},
        "Quix__Deployment__Id": {"inputType": "FreeText", "value": "dep-template"},
        "Quix__Sdk__Token": {"inputType": "Secret", "value": "sdk-secret"},
    },
}

EVALUATED_AT = "2026-09-24T10:15:30.123000+00:00"
OUTPUTS = {
    "tc_id": "TC-EM-201",
    "run_id": RUN,
    "verdict": "PASS",
    "evidence": {"max_value": 12.5, "n": 3},
    "evaluated_at": EVALUATED_AT,
}
LINE = {
    "runId": "run-42",
    "status": "ok",
    "exitCode": 0,
    "manifest": f"{WORKSPACE}/jama_ui/definitions/{TD}/runs/run-42.json",
    "outputs": OUTPUTS,
    "error": None,
}


def _log(*lines: str) -> str:
    """A stored log as the Portal serves it: BOM first, newest line first."""
    return "﻿" + "\n".join(lines) + "\n"


# --------------------------------------------------------------------------
# The pure half.
# --------------------------------------------------------------------------


def test_a_run_job_name_is_stable_sanitised_and_apart_per_pair() -> None:
    name = quixlab_provision.run_job_name(RUN, TD)

    assert name == quixlab_provision.run_job_name(RUN, TD)
    assert name.startswith("tm-run-sn002-20260723t131303942z-td-em-201-")
    assert name == quixlab_provision.sanitize(name)
    assert len(name) <= quixlab_provision.NAME_LIMIT
    assert name != quixlab_provision.run_job_name("SN002-20260723T131303942Z", TD)
    assert len(quixlab_provision.run_job_name("r" * 80, "t" * 80)) <= quixlab_provision.NAME_LIMIT


def test_a_run_spec_is_a_job_in_run_mode_on_the_notebook_with_no_address() -> None:
    pointer = f"blob://{NOTEBOOK_KEY}"
    spec = quixlab_run.build_run_spec(TEMPLATE_SPEC, name="tm-run-x", notebook=pointer, params=None)

    assert spec["deploymentType"] == "Job"
    assert spec["applicationId"] == "app-quixlab", "same application, no new build"
    assert spec["useLatest"] is True
    assert spec["memoryInMb"] == 2000
    assert spec["autoStart"] is True
    assert spec["blobStorageBind"] is True
    assert spec["publicAccess"] is False
    assert "urlPrefix" not in spec
    assert "network" not in spec, "a Job serves nothing"
    assert spec["stateEnabled"] is False
    assert spec["plugin"]["enabled"] is False
    assert "deploymentId" not in spec
    variables = spec["variables"]
    assert variables["QUIXLAB_MODE"]["value"] == "run"
    assert variables["QUIXLAB_NOTEBOOK"]["value"] == pointer
    assert "QUIXLAB_PARAMS" not in variables, "the template's params never travel"
    assert "Quix__Sdk__Token" not in variables
    assert "Quix__Deployment__Id" not in variables
    assert variables["TM_LAKE_TABLE"]["value"] == "pcap_data_v1", "the rest do travel"


def test_run_params_ride_as_one_json_object() -> None:
    spec = quixlab_run.build_run_spec(
        TEMPLATE_SPEC, name="tm-run-x", notebook="blob://k", params={"run_id": RUN, "n": 5}
    )

    assert json.loads(spec["variables"]["QUIXLAB_PARAMS"]["value"]) == {"run_id": RUN, "n": 5}


def test_the_result_line_is_the_newest_one_past_the_bom() -> None:
    older = json.dumps({**LINE, "runId": "run-41"})
    text = _log(json.dumps(LINE), "2026-09-23 plain log line", older)

    assert quixlab_run.result_line(text) == LINE
    assert quixlab_run.result_line(_log("nothing", "to see")) is None
    assert quixlab_run.result_line(_log('{"runId": broken', json.dumps(LINE))) == LINE


def test_exit_zero_is_finished_with_the_outputs() -> None:
    result = quixlab_run.finished_result(JOB_ID, "Completed", 0, LINE)

    assert result.state == "finished"
    assert result.outputs == OUTPUTS
    assert result.run_id == "run-42"
    assert result.error is None


def test_exit_one_is_failed_with_quixlab_s_error() -> None:
    line = {**LINE, "status": "error", "exitCode": 1, "outputs": None, "error": "node x failed"}

    result = quixlab_run.finished_result(JOB_ID, "Completed", 1, line)

    assert result.state == "failed"
    assert result.outputs is None
    assert result.error == "node x failed"


def test_a_non_zero_exit_with_no_line_is_an_infrastructure_failure() -> None:
    result = quixlab_run.finished_result(JOB_ID, "RuntimeError", 137, None)

    assert result.state == "failed"
    assert result.exit_code == 137
    assert "infrastructure failure" in (result.error or "")


def test_the_template_is_never_a_run_job_or_a_lab() -> None:
    job = {**TEMPLATE_ROW, "deploymentId": "d1", "name": "tm-run-x-1234"}
    lab = {**TEMPLATE_ROW, "deploymentId": "d2", "name": "tm-lab-x-1234"}
    other = {"deploymentId": "d3", "name": "mongo", "libraryItemId": "mongodb"}

    assert quixlab_provision.template_row([job, lab, other, TEMPLATE_ROW]) == TEMPLATE_ROW
    assert quixlab_provision.template_row([job, lab, other]) is None


def test_an_operator_may_name_the_template(monkeypatch) -> None:
    second = {**TEMPLATE_ROW, "deploymentId": "dep-second", "name": "QuixLab Two"}
    monkeypatch.setenv(quixlab_provision.TEMPLATE_VAR, "QuixLab Two")

    assert quixlab_provision.template_row([TEMPLATE_ROW, second]) == second


def test_the_notebook_key_leads_with_the_workspace_folder(monkeypatch) -> None:
    monkeypatch.setenv(file_writes.WORKSPACE_VARIABLE, WORKSPACE)
    monkeypatch.delenv(file_writes.BLOB_ROOT_VARIABLE, raising=False)

    assert file_writes.definition_notebook_key(TD) == NOTEBOOK_KEY
    assert file_writes.definition_notebook_key("../x") == (
        f"{WORKSPACE}/jama_ui/definitions/_x/notebook.py"
    ), "no traversal out of the folder"


def test_the_default_notebook_declares_the_params_and_one_output() -> None:
    source = definition_runs.default_notebook().decode("utf-8")
    tree = ast.parse(source)
    cells = {
        node.name: ast.unparse(node.decorator_list[0])
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.decorator_list
    }

    for name in ("run_id", "td_id", "implementation_key", "lake_table", "entrypoint"):
        assert "'param'" in cells[name], name
    assert cells["result"] == "canvas.cell(viz={'output': True})"
    # QuixLab's parser reads a decorator on one line only.
    assert not re.search(r"^@canvas\.cell\([^)]*$", source, flags=re.MULTILINE)


@pytest.mark.parametrize(
    ("raw", "outcome"), [("PASS", "pass"), ("FAIL", "fail"), ("ERROR", "error"), ("maybe", "error")]
)
def test_the_notebook_verdict_maps_onto_the_stored_enum(raw, outcome) -> None:
    got, evidence = definition_runs._outcome({"verdict": raw, "evidence": {"n": 1}})

    assert got == outcome
    assert evidence["n"] == 1


# --------------------------------------------------------------------------
# The routes.
# --------------------------------------------------------------------------


class _Store:
    """One blob store behind both the reader and the writer protocol."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def open(self, storage_ref: str | None) -> tuple[Iterator[bytes], int]:
        key = file_bytes.blob_key(storage_ref)
        if key not in self.objects:
            raise FileBytesUnavailable(f"no {key}", reason="blob_missing")
        return iter([self.objects[key]]), len(self.objects[key])

    def check_ready(self) -> None:
        return

    def write(self, key: str, chunks: Iterable[bytes]) -> int:
        self.objects[key] = b"".join(chunks)
        return len(self.objects[key])


@pytest.fixture
def store(app) -> Iterator[_Store]:
    blob = _Store()
    app.dependency_overrides[file_bytes.get_file_bytes_provider] = lambda: blob
    app.dependency_overrides[file_writes.get_file_writer] = lambda: blob
    yield blob
    app.dependency_overrides.pop(file_bytes.get_file_bytes_provider, None)
    app.dependency_overrides.pop(file_writes.get_file_writer, None)


@pytest.fixture
def portal(monkeypatch) -> Iterator[dict]:
    """A Portal answering from a dict; `calls` records every write in order."""
    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL)
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)
    monkeypatch.delenv(file_writes.BLOB_ROOT_VARIABLE, raising=False)
    name = quixlab_provision.run_job_name(RUN, TD)
    state = {
        "deployments": [TEMPLATE_ROW],
        "job": {"deploymentId": JOB_ID, "name": name, "status": "Running"},
        "runs": [],
        "log": "",
        "calls": [],
        "specs": [],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "POST" and path == "/deployments":
            state["calls"].append(("POST", path))
            state["specs"].append(json.loads(request.content))
            return httpx.Response(200, json={"deploymentId": JOB_ID, "status": "Queued"})
        if request.method == "DELETE":
            state["calls"].append(("DELETE", path))
            return httpx.Response(200, json={})
        if path == f"/workspaces/{WORKSPACE}/deployments":
            return httpx.Response(200, json=state["deployments"])
        if path.endswith("/logs/history/download"):
            return httpx.Response(200, text=state["log"])
        if path.endswith("/runs"):
            return httpx.Response(200, json=state["runs"])
        if path == "/deployments/dep-template":
            return httpx.Response(200, json=TEMPLATE_SPEC)
        return httpx.Response(404, json={})

    quix_identity.TRANSPORT = httpx.MockTransport(handler)
    yield state
    quix_identity.TRANSPORT = None


def _implementation() -> dict:
    return {
        "blob_path": f"blob://{IMPL_KEY}",
        "filename": "impl.py",
        "sha256": SHA,
        "size_bytes": 10,
        "language": "python",
        "entrypoint": "evaluate",
        "uploaded_at": datetime(2026, 9, 20, tzinfo=UTC),
        "uploaded_by": "Ana",
    }


@pytest.fixture
def pair(routed_db) -> Database:
    routed_db["test_runs"].insert_one(make_run(run_id=RUN, lake_table="pcap_data_v1"))
    routed_db["test_definitions"].insert_one(
        make_definition(td_id=TD, implementation=_implementation())
    )
    return routed_db


def _finished(portal: dict, line: dict | None = LINE, exit_code: int = 0) -> None:
    portal["job"]["status"] = "Completed"
    portal["deployments"] = [TEMPLATE_ROW, portal["job"]]
    portal["runs"] = [{"exitCode": exit_code, "logsStored": True}]
    portal["log"] = _log(json.dumps(line)) if line else _log("Killed")


def _verdicts(db: Database) -> list[dict]:
    return list(db["processed_results"].find({"result_key": f"verdict/{TD}"}))


def test_starting_without_a_portal_token_is_refused(client, pair, store, portal) -> None:
    response = client.post(PATH)

    assert response.status_code == 401, response.text
    assert response.json()["code"] == "quixlab_needs_login"
    assert portal["calls"] == []


def test_polling_without_a_portal_token_is_refused(client, pair, portal) -> None:
    response = client.get(PATH)

    assert response.status_code == 401, response.text
    assert response.json()["code"] == "quixlab_needs_login"


def test_starting_seeds_the_notebook_and_creates_one_job(client, pair, store, portal) -> None:
    response = client.post(PATH, headers=VIEWER)

    assert response.status_code == 202, response.text
    name = quixlab_provision.run_job_name(RUN, TD)
    assert response.json() == {"id": JOB_ID, "name": name, "status": "Queued"}
    assert store.objects[NOTEBOOK_KEY] == definition_runs.default_notebook()
    assert portal["calls"] == [("POST", "/deployments")]
    variables = portal["specs"][0]["variables"]
    assert variables["QUIXLAB_NOTEBOOK"]["value"] == f"blob://{NOTEBOOK_KEY}"
    assert json.loads(variables["QUIXLAB_PARAMS"]["value"]) == {
        "run_id": RUN,
        "td_id": TD,
        "implementation_key": IMPL_KEY,
        "lake_table": "pcap_data_v1",
        "entrypoint": "evaluate",
    }


def test_a_customised_notebook_is_never_overwritten(client, pair, store, portal) -> None:
    store.objects[NOTEBOOK_KEY] = b"# my own notebook\n"

    response = client.post(PATH, headers=VIEWER)

    assert response.status_code == 202, response.text
    assert store.objects[NOTEBOOK_KEY] == b"# my own notebook\n"


@pytest.mark.parametrize(
    ("setup", "code"),
    [
        ("no_run", "run_not_found"),
        ("no_definition", "td_not_found"),
        ("no_implementation", "implementation_not_found"),
    ],
)
def test_a_pair_that_cannot_run_is_a_404(client, routed_db, store, portal, setup, code) -> None:
    if setup != "no_run":
        routed_db["test_runs"].insert_one(make_run(run_id=RUN))
    if setup == "no_implementation":
        routed_db["test_definitions"].insert_one(make_definition(td_id=TD))

    response = client.post(PATH, headers=VIEWER)

    assert response.status_code == 404, response.text
    assert response.json()["code"] == code
    assert portal["calls"] == []
    assert store.objects == {}


def test_a_workspace_with_no_quixlab_is_a_409(client, pair, store, portal) -> None:
    portal["deployments"] = [{"deploymentId": "d", "name": "mongo", "libraryItemId": "mongodb"}]

    response = client.post(PATH, headers=VIEWER)

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "quixlab_no_template"
    assert portal["calls"] == []


def test_a_second_click_while_the_run_is_going_answers_the_same_job(
    client, pair, store, portal
) -> None:
    portal["deployments"] = [TEMPLATE_ROW, portal["job"]]

    response = client.post(PATH, headers=VIEWER)

    assert response.status_code == 202, response.text
    assert response.json()["status"] == "Running"
    assert portal["calls"] == [], "no second run"


def test_running_again_after_a_finished_run_replaces_its_job(client, pair, store, portal) -> None:
    portal["deployments"] = [TEMPLATE_ROW, {**portal["job"], "status": "Failed"}]

    response = client.post(PATH, headers=VIEWER)

    assert response.status_code == 202, response.text
    assert portal["calls"] == [("DELETE", f"/deployments/{JOB_ID}"), ("POST", "/deployments")]


def test_a_job_still_going_polls_as_running(client, pair, portal) -> None:
    portal["deployments"] = [TEMPLATE_ROW, portal["job"]]

    body = client.get(PATH, headers=VIEWER).json()

    assert body["state"] == "running"
    assert body["status"] == "Running"
    assert body["verdict"] is None


def test_a_completed_job_whose_record_has_not_landed_is_still_running(client, pair, portal) -> None:
    _finished(portal)
    portal["runs"] = [{"exitCode": 0, "logsStored": False}]

    body = client.get(PATH, headers=VIEWER).json()

    assert body["state"] == "running"
    assert portal["calls"] == []


def test_exit_zero_records_the_verdict_once_and_deletes_the_job(client, pair, portal) -> None:
    file_doc = seed_file(pair, run_id=RUN)
    _finished(portal)

    response = client.get(PATH, headers=VIEWER)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["state"] == "finished"
    assert body["exit_code"] == 0
    assert body["quixlab_run_id"] == "run-42"
    assert body["verdict"] == {
        "definition_id": TD,
        "outcome": "pass",
        "evidence": {"max_value": 12.5, "n": 3},
        "implementation_sha256": SHA,
    }
    assert portal["calls"] == [("DELETE", f"/deployments/{JOB_ID}")]
    [doc] = _verdicts(pair)
    assert body["result_id"] == doc["_id"]
    assert doc["run_id"] == RUN
    assert doc["provenance"]["tool"] == TD
    assert doc["provenance"]["tool_version"] == f"sha256:{SHA[:12]}"
    assert doc["provenance"]["input_file_ids"] == [file_doc["_id"]]
    assert doc["provenance"]["produced_by"] == "verdict-runner"
    assert doc["provenance"]["produced_at"] == datetime.fromisoformat(EVALUATED_AT)
    assert doc["provenance_status"] == "verified"


def test_a_re_poll_of_the_same_job_writes_no_second_verdict(client, pair, portal) -> None:
    _finished(portal)

    first = client.get(PATH, headers=VIEWER).json()
    second = client.get(PATH, headers=VIEWER).json()

    assert len(_verdicts(pair)) == 1
    assert second["result_id"] == first["result_id"]


def test_once_the_job_is_gone_the_poll_answers_the_stored_verdict(client, pair, portal) -> None:
    _finished(portal)
    first = client.get(PATH, headers=VIEWER).json()
    portal["deployments"] = [TEMPLATE_ROW]

    body = client.get(PATH, headers=VIEWER).json()

    assert body["state"] == "finished"
    assert body["id"] is None
    assert body["result_id"] == first["result_id"]
    assert body["verdict"]["outcome"] == "pass"
    assert len(_verdicts(pair)) == 1


def test_an_implementation_that_raised_is_an_error_verdict(client, pair, portal) -> None:
    raised = {**OUTPUTS, "verdict": "ERROR", "evidence": {"error": "LookupError: no rows"}}
    _finished(portal, {**LINE, "outputs": raised})

    body = client.get(PATH, headers=VIEWER).json()

    assert body["state"] == "finished"
    assert body["verdict"]["outcome"] == "error"
    assert body["verdict"]["evidence"] == {"error": "LookupError: no rows"}


def test_exit_one_is_failed_records_nothing_and_keeps_the_job(client, pair, portal) -> None:
    _finished(portal, {**LINE, "exitCode": 1, "outputs": None, "error": "td_id missing"}, 1)

    body = client.get(PATH, headers=VIEWER).json()

    assert body["state"] == "failed"
    assert body["exit_code"] == 1
    assert body["error"] == "td_id missing"
    assert _verdicts(pair) == []
    assert portal["calls"] == [], "a failed job stays for debugging"


def test_a_job_that_died_without_a_line_is_an_infrastructure_failure(client, pair, portal) -> None:
    _finished(portal, None, 137)

    body = client.get(PATH, headers=VIEWER).json()

    assert body["state"] == "failed"
    assert "infrastructure failure" in body["error"]
    assert _verdicts(pair) == []


def test_no_job_and_no_verdict_is_a_404(client, pair, portal) -> None:
    response = client.get(PATH, headers=VIEWER)

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "run_job_not_found"
