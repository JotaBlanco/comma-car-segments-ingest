"""POST and DELETE /test-runs/{run_id}/quixlab — one QuixLab per viewer per run.

The product used to send everybody to ONE shared QuixLab. These tests hold the
three properties that replaced it:

1. **The lab belongs to the viewer and the run.** Its name is a pure function
   of the pair, so two people on one run, and one person on two runs, never
   land on the same canvas.
2. **The notebook is written before the deployment is created.** A lab that
   boots pointing at a key with nothing behind it opens the file picker instead
   of the run, and a person sees an empty QuixLab.
3. **A clone is a clone, not a copy.** The variables that pin the template's
   own identity and mode must not travel, or the lab masquerades as its
   template and opens the template's notebook.
"""

from datetime import UTC, datetime

import httpx
import pytest

from api import quix_identity, quixlab_provision
from api.services import quixlab_notebook

RUN = "sn002_20260723T131303942Z"
PORTAL = "https://portal-api.dev.quix.io"
WORKSPACE = "ws-demo"
VIEWER = {"x-portal-token": "viewer-token"}
PATH = f"/api/v1/test-runs/{RUN}/quixlab"

TEMPLATE_ROW = {
    "deploymentId": "dep-template",
    "name": "QuixLab Aerospace",
    "libraryItemId": "quixlab",
    "status": "Running",
    "publicUrl": "https://quixlab-template.dev.quix.io",
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
    "plugin": {"enabled": True, "sidebarItem": {"label": "QuixLab"}},
    "variables": {
        "TM_LAKE_TABLE": {"inputType": "FreeText", "value": "pcap_data_v1"},
        "QUIXLAB_MODE": {"inputType": "FreeText", "value": "edit"},
        "QUIXLAB_NOTEBOOK": {"inputType": "FreeText", "value": "main.py"},
        "Quix__Deployment__Id": {"inputType": "FreeText", "value": "dep-template"},
        "Quix__Sdk__Token": {"inputType": "Secret", "value": "sdk-secret"},
    },
}


# --------------------------------------------------------------------------
# The pure half: no platform, no database.
# --------------------------------------------------------------------------


def test_a_lab_is_named_for_one_viewer_and_one_run() -> None:
    mine = quixlab_provision.lab_name("user-a", RUN)

    assert mine == quixlab_provision.lab_name("user-a", RUN), "the name must be stable"
    assert mine != quixlab_provision.lab_name("user-b", RUN), "two people, two labs"
    assert mine != quixlab_provision.lab_name("user-a", "other-run"), "two runs, two labs"


def test_a_name_fits_what_the_portal_takes() -> None:
    """A deployment name doubles as a DNS label, and the stem gets truncated."""
    long_user = "a-very-long-federated-user-identifier-0123456789"
    long_run = "sn002_20260723T131303942Z_with_a_long_tail_as_well"

    name = quixlab_provision.lab_name(long_user, long_run)

    assert len(name) <= quixlab_provision.NAME_LIMIT
    assert name == quixlab_provision.sanitize(name), "lowercase, digits and dashes only"
    assert name.startswith(f"{quixlab_provision.LAB_PREFIX}-")
    # Two ids that share the truncated stem must still be two labs.
    other = quixlab_provision.lab_name(long_user, long_run + "-second")
    assert name != other


def test_the_notebook_key_leads_with_the_workspace_folder(monkeypatch) -> None:
    """SAG grants a deployment a write only under the workspace folder."""
    monkeypatch.setenv(quixlab_provision.WORKSPACE_FOLDER_VAR, WORKSPACE)

    key = quixlab_provision.notebook_key(RUN)

    assert key == f"{WORKSPACE}/{quixlab_provision.NOTEBOOK_FOLDER}/{RUN}/analysis.py"
    # `blob://` is bucket-relative and carries no leading slash: QuixLab's
    # `project.parse()` raises on one rather than falling back.
    assert quixlab_provision.notebook_pointer(key) == f"blob://{key}"
    assert "//" not in quixlab_provision.notebook_pointer(key)[len("blob://") :]


def test_the_folder_of_the_notebook_is_the_run_folder(monkeypatch) -> None:
    """The project root is the notebook's FOLDER, so it must be the run's."""
    monkeypatch.setenv(quixlab_provision.WORKSPACE_FOLDER_VAR, WORKSPACE)

    root = quixlab_provision.notebook_key(RUN).rsplit("/", 1)[0]

    assert root.endswith(f"/{RUN}")
    assert quixlab_provision.notebook_key("other").rsplit("/", 1)[0] != root


def test_the_pinning_variables_never_travel_into_a_lab() -> None:
    """Property 3. A cloned identity makes the lab masquerade as its template."""
    out = quixlab_provision.clone_variables(TEMPLATE_SPEC, {"QUIXLAB_MODE": "edit"})

    for pinned in quixlab_provision.NO_CLONE_VARS:
        if pinned == "QUIXLAB_MODE":
            continue  # pinned by the override below, not cloned
        assert pinned not in out, f"{pinned} must not be cloned"
    assert out["TM_LAKE_TABLE"]["value"] == "pcap_data_v1", "the rest do travel"


def test_variables_are_objects_whichever_shape_the_portal_answered() -> None:
    """The create DTO binds a dict of variable OBJECTS. A bare string is dropped
    silently, which is how QuixLab's own pins once went missing."""
    as_list = {
        "variables": [
            {"name": "TM_LAKE_TABLE", "value": "pcap_data_v1"},
            {"name": "QUIXLAB_NOTEBOOK", "value": "main.py"},
        ]
    }

    out = quixlab_provision.clone_variables(as_list, {"QUIXLAB_MODE": "edit"})

    assert "QUIXLAB_NOTEBOOK" not in out
    assert out["TM_LAKE_TABLE"] == {
        "inputType": "FreeText",
        "required": False,
        "value": "pcap_data_v1",
    }
    assert out["QUIXLAB_MODE"]["value"] == "edit"
    assert all(isinstance(entry, dict) for entry in out.values())
    assert all("name" not in entry for entry in out.values()), "the key carries the name"


def test_a_lab_spec_clones_the_template_and_pins_its_own_notebook() -> None:
    spec = quixlab_provision.build_lab_spec(
        TEMPLATE_SPEC, name="tm-lab-x", notebook="blob://ws/quixlab-runs/r/analysis.py"
    )

    assert spec["applicationId"] == "app-quixlab", "same application, no new build"
    assert spec["image"] == "quixlab:1.2.3"
    assert spec["cpuMillicores"] == 500
    assert spec["name"] == "tm-lab-x"
    assert spec["urlPrefix"] == "tm-lab-x"
    assert spec["publicAccess"] is True, "a person has to be able to open it"
    assert spec["useLatest"] is True, "a lab made today carries today's QuixLab"
    assert spec["variables"]["QUIXLAB_MODE"]["value"] == "edit"
    assert (
        spec["variables"]["QUIXLAB_NOTEBOOK"]["value"]
        == "blob://ws/quixlab-runs/r/analysis.py"
    )
    # A lab is one person's, never a workspace-wide plugin: the template IS a
    # plugin, and copying its block lists every lab in everybody's sidebar.
    assert spec["plugin"]["enabled"] is False
    assert "deploymentId" not in spec, "the Portal mints the id"


def test_the_notebook_names_the_run_and_compiles() -> None:
    source = quixlab_notebook.notebook_source(
        run_id=RUN,
        table="pcap_data_v1",
        parts={"platform": "sn002", "work_order": "WO-1", "test_definition": "TD-1"},
    )

    compile(source, "analysis.py", "exec")  # a notebook that will not parse is no notebook
    assert f"run_id = '{RUN}'" in source
    assert "platform = 'sn002'" in source
    assert "FROM pcap_data_v1" in source
    assert source.count("WHERE") == 1, "one WHERE, the rest are ANDs"


def test_the_notebook_refuses_a_value_it_cannot_safely_carry() -> None:
    """The value lands in SQL inside Python: two quoting layers, so it is
    refused rather than escaped twice."""
    with pytest.raises(quixlab_notebook.UnsafeValue):
        quixlab_notebook.notebook_source(
            run_id="r'; DROP TABLE x; --", table="pcap_data_v1", parts={"platform": "sn002"}
        )


# --------------------------------------------------------------------------
# The routes.
# --------------------------------------------------------------------------


@pytest.fixture
def portal(monkeypatch):
    """A Portal that answers from a dict, and records what was written.

    `calls` holds one `(method, path, payload)` per write, so a test can prove
    the ORDER of the notebook write against the deployment create.
    """
    monkeypatch.setenv(quix_identity.PORTAL_URL_VAR, PORTAL)
    monkeypatch.setenv(quix_identity.WORKSPACE_VAR, WORKSPACE)
    monkeypatch.setenv(quixlab_provision.WORKSPACE_FOLDER_VAR, WORKSPACE)
    quix_identity.reset_cache()

    state = {
        "deployments": [TEMPLATE_ROW],
        "template": TEMPLATE_SPEC,
        "created": httpx.Response(
            200,
            json={
                "deploymentId": "dep-lab",
                "name": "tm-lab",
                "status": "Building",
                "publicUrl": "https://tm-lab.dev.quix.io",
            },
        ),
        "calls": [],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method in ("POST", "DELETE") and "/deployments" in path:
            state["calls"].append((request.method, path))
            if request.method == "DELETE":
                return httpx.Response(200, json={})
            return state["created"]
        if path == "/profile":
            return httpx.Response(
                200, json={"userId": "user-a", "name": "Ana", "email": "ana@example.com"}
            )
        if path == quix_identity.PERMISSIONS_PATH or "permission" in path:
            return httpx.Response(200, json=True)
        if path.endswith("/deployments"):
            return httpx.Response(200, json=state["deployments"])
        if "/deployments/" in path:
            return httpx.Response(200, json=state["template"])
        return httpx.Response(200, json=[])

    quix_identity.TRANSPORT = httpx.MockTransport(handler)
    yield state
    quix_identity.TRANSPORT = None
    quix_identity.reset_cache()


@pytest.fixture
def written(monkeypatch, portal):
    """Capture the notebook write, in order with the Portal writes."""
    store: list[tuple[str, str]] = []

    class Writer:
        def check_ready(self) -> None:
            return

        def write(self, key, chunks) -> int:
            body = b"".join(chunks)
            store.append((key, body.decode("utf-8")))
            portal["calls"].append(("WRITE", key))
            return len(body)

    from api.main import app
    from api.services import file_writes

    app.dependency_overrides[file_writes.get_file_writer] = lambda: Writer()
    yield store
    app.dependency_overrides.pop(file_writes.get_file_writer, None)


def _seed(db) -> None:
    """One run document, written straight in.

    It does NOT come from `tests.factories_planning`: that module imports the
    demo seed, which reads the planning mock's cast, and this file needs a run
    with the lake partition values rather than a cast member.
    """
    db["test_runs"].insert_one(
        {
            "_id": RUN,
            "description": None,
            "work_order_id": "WO-1",
            "definition_id": "TD-1",
            "project": "sn002",
            "rig_id": "RIG-02",
            "test_cell": "TC-1",
            "operator": None,
            "bench_sw": None,
            "started_at": None,
            "ended_at": None,
            "first_data_at": datetime(2026, 8, 14, 8, 12, tzinfo=UTC),
            "invalid": {"flagged": False, "reason": None, "actor": None, "at": None},
            "file_count": 5,
            "signal_count": 96,
            "status": "complete",
            "lake_table": "pcap_data_v1",
            "field_sources": {},
            "created_at": datetime(2026, 8, 14, 8, 12, tzinfo=UTC),
            "updated_at": datetime(2026, 8, 14, 8, 12, tzinfo=UTC),
        }
    )


def test_a_viewer_with_no_portal_token_gets_no_lab(client, routed_db) -> None:
    """A lab created without the viewer is a lab owned by this service."""
    _seed(routed_db)

    response = client.post(PATH)

    assert response.status_code == 403, response.text
    assert response.json()["code"] == "quixlab_needs_login"


def test_creating_a_lab_writes_the_notebook_before_the_deployment(
    client, routed_db, portal, written
) -> None:
    """Property 2. A lab pointed at a key with nothing behind it opens the
    file picker, and the person sees an empty QuixLab instead of their run."""
    _seed(routed_db)

    response = client.post(PATH, headers=VIEWER)

    assert response.status_code == 200, response.text
    kinds = [kind for kind, _ in portal["calls"]]
    assert kinds.index("WRITE") < kinds.index("POST"), "the notebook goes first"


def test_the_lab_opens_on_a_notebook_in_the_run_folder(
    client, routed_db, portal, written
) -> None:
    _seed(routed_db)

    body = client.post(PATH, headers=VIEWER).json()

    key, source = written[0]
    assert key == f"{WORKSPACE}/quixlab-runs/{RUN}/analysis.py"
    assert body["notebook"] == f"blob://{key}"
    assert f"run_id = '{RUN}'" in source, "the notebook queries THIS run"
    assert body["url"] == "https://tm-lab.dev.quix.io"
    assert body["created"] is True


def test_a_second_click_answers_the_same_lab_and_creates_nothing(
    client, routed_db, portal, written
) -> None:
    """A person who clicks twice, or reloads while it builds, gets one lab."""
    _seed(routed_db)
    first = client.post(PATH, headers=VIEWER).json()
    assert first["name"] == quixlab_provision.lab_name("user-a", RUN)
    # The Portal now lists the lab the first call made, under the name it was
    # created with — which is the name the next call looks up.
    portal["deployments"] = [
        TEMPLATE_ROW,
        {
            "deploymentId": "dep-lab",
            "name": first["name"],
            "libraryItemId": "quixlab",
            "status": "Running",
            "publicUrl": "https://tm-lab.dev.quix.io",
        },
    ]
    portal["calls"].clear()

    second = client.post(PATH, headers=VIEWER).json()

    assert second["id"] == "dep-lab"
    assert second["created"] is False
    assert [kind for kind, _ in portal["calls"]] == [], "nothing was written twice"


def test_a_lab_is_never_cloned_from_another_lab(client, routed_db, portal, written) -> None:
    """A lab is built from the QuixLab library item too. Without the name
    filter the first lab becomes the template for the next, and every pinned
    variable compounds."""
    _seed(routed_db)
    portal["deployments"] = [
        {
            "deploymentId": "dep-someone-elses-lab",
            "name": f"{quixlab_provision.LAB_PREFIX}-someone-else",
            "libraryItemId": "quixlab",
            "status": "Running",
            "publicUrl": "https://other-lab.dev.quix.io",
        },
        TEMPLATE_ROW,
    ]

    response = client.post(PATH, headers=VIEWER)

    assert response.status_code == 200, response.text


def test_no_quixlab_to_clone_is_the_deployment_s_fault_not_the_caller_s(
    client, routed_db, portal, written
) -> None:
    _seed(routed_db)
    portal["deployments"] = []

    response = client.post(PATH, headers=VIEWER)

    assert response.status_code == 503, response.text
    assert response.json()["code"] == "quixlab_no_template"
    assert written == [], "no notebook is stored for a lab that cannot be made"


def test_a_run_the_registry_does_not_know_gets_no_lab(client, routed_db, portal, written) -> None:
    """A lab for a run that does not exist would open on an empty query."""
    response = client.post("/api/v1/test-runs/no-such-run/quixlab", headers=VIEWER)

    assert response.status_code == 404, response.text
    assert written == []


def test_removing_a_lab_answers_204_even_when_there_was_none(
    client, routed_db, portal
) -> None:
    """Run deletion must not fail because a person never opened a lab."""
    response = client.request("DELETE", PATH, headers=VIEWER)

    assert response.status_code == 204, response.text
