"""/test-runs/{run_id}/notebooks — a run's QuixLab notebooks, one lab per viewer per notebook.

The product used to send everybody to ONE shared QuixLab. These tests hold the
three properties that replaced it:

1. **The lab belongs to the viewer and the notebook.** Its name is a pure function
   of the pair, so two people on one notebook, and one person on two notebooks,
   never land on the same canvas - and a run holds as many notebooks as its
   people make.
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
PATH = f"/api/v1/test-runs/{RUN}/notebooks"
NB = "nb-1"

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


def test_a_lab_is_named_for_one_viewer_and_one_notebook() -> None:
    mine = quixlab_provision.lab_name("user-a", NB, RUN)

    assert mine == quixlab_provision.lab_name("user-a", NB, RUN), "the name must be stable"
    assert mine != quixlab_provision.lab_name("user-b", NB, RUN), "two people, two labs"
    assert mine != quixlab_provision.lab_name("user-a", "nb-2", RUN), "two notebooks, two labs"


def test_a_name_fits_what_the_portal_takes() -> None:
    """A deployment name doubles as a DNS label, and the stem gets truncated."""
    long_user = "a-very-long-federated-user-identifier-0123456789"
    long_run = "sn002_20260723T131303942Z_with_a_long_tail_as_well"

    name = quixlab_provision.lab_name(long_user, "nb-0123456789ab", long_run)

    assert len(name) <= quixlab_provision.NAME_LIMIT
    assert name == quixlab_provision.sanitize(name), "lowercase, digits and dashes only"
    assert name.startswith(f"{quixlab_provision.LAB_PREFIX}-")
    # Two ids that share the truncated stem must still be two labs.
    other = quixlab_provision.lab_name(long_user, "nb-0123456789ac", long_run)
    assert name != other


def test_the_url_prefix_fits_what_the_portal_takes() -> None:
    """The Portal answers 400 `Url prefix '...' must be less than 34 characters`.

    It is a far tighter limit than the deployment name's, and the first version
    of this used the name for both: a viewer id alone is a 36-character uuid, so
    every create failed. Nothing readable fits, so the prefix is the pair's
    digest and the readable identity stays on the name.
    """
    long_user = "0ab32ff2-6082-4e3a-8dd9-c48faf41d403"
    long_run = "sn059_20170211T094512001Z_and_a_long_tail"

    del long_run
    prefix = quixlab_provision.lab_url_prefix(long_user, NB)

    assert len(prefix) <= quixlab_provision.URL_PREFIX_LIMIT
    assert quixlab_provision.URL_PREFIX_LIMIT == 33
    assert prefix == quixlab_provision.sanitize(prefix), "it is also a host name"
    assert prefix == quixlab_provision.lab_url_prefix(long_user, NB), "stable"
    # Two viewers on one notebook are two labs, so they must be two addresses.
    assert prefix != quixlab_provision.lab_url_prefix("someone-else", NB)
    assert prefix != quixlab_provision.lab_url_prefix(long_user, "nb-2")


def test_the_name_leads_with_the_run_not_the_viewer() -> None:
    """An operator scanning the deployment list wants to know which run a lab
    belongs to. A uuid first would push the run id off the end of the limit."""
    name = quixlab_provision.lab_name("0ab32ff2-6082-4e3a-8dd9-c48faf41d403", NB, RUN)

    assert len(name) <= quixlab_provision.NAME_LIMIT
    assert name.startswith(f"{quixlab_provision.LAB_PREFIX}-{quixlab_provision.sanitize(RUN)}")


def test_the_notebook_key_leads_with_the_workspace_folder(monkeypatch) -> None:
    """SAG grants a deployment a write only under the workspace folder."""
    monkeypatch.setenv(quixlab_provision.WORKSPACE_FOLDER_VAR, WORKSPACE)

    key = quixlab_provision.notebook_key(RUN, NB)

    assert key == f"{WORKSPACE}/{quixlab_provision.NOTEBOOK_FOLDER}/{RUN}/{NB}/analysis.py"
    # `blob://` is bucket-relative and carries no leading slash: QuixLab's
    # `project.parse()` raises on one rather than falling back.
    assert quixlab_provision.notebook_pointer(key) == f"blob://{key}"
    assert "//" not in quixlab_provision.notebook_pointer(key)[len("blob://") :]


def test_each_notebook_has_a_folder_of_its_own_under_the_run(monkeypatch) -> None:
    """The project root is the notebook's FOLDER - its manifest, runs, items and chats live
    there - so two notebooks in one folder would be one canvas."""
    monkeypatch.setenv(quixlab_provision.WORKSPACE_FOLDER_VAR, WORKSPACE)

    root = quixlab_provision.notebook_key(RUN, NB).rsplit("/", 1)[0]

    assert root.endswith(f"/{RUN}/{NB}")
    assert quixlab_provision.notebook_key(RUN, "nb-2").rsplit("/", 1)[0] != root
    assert quixlab_provision.notebook_key("other", NB).rsplit("/", 1)[0] != root


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
        TEMPLATE_SPEC,
        name="tm-lab-x",
        notebook="blob://ws/quixlab-runs/r/analysis.py",
        url_prefix="tm-lab-abc123",
    )

    assert spec["applicationId"] == "app-quixlab", "same application, no new build"
    assert spec["image"] == "quixlab:1.2.3"
    assert spec["cpuMillicores"] == 500
    assert spec["name"] == "tm-lab-x"
    assert spec["urlPrefix"] == "tm-lab-abc123", "the prefix is not the name"
    assert spec["publicAccess"] is True, "a person has to be able to open it"
    assert spec["useLatest"] is True, "a lab made today carries today's QuixLab"
    assert spec["variables"]["QUIXLAB_MODE"]["value"] == "edit"
    assert spec["variables"]["QUIXLAB_NOTEBOOK"]["value"] == "blob://ws/quixlab-runs/r/analysis.py"
    # A lab is one person's, never a workspace-wide plugin: the template IS a
    # plugin, and copying its block lists every lab in everybody's sidebar.
    assert spec["plugin"]["enabled"] is False
    assert "deploymentId" not in spec, "the Portal mints the id"


BATTERY_RUN = "T1_20260915T090000000Z"
BATTERY_FOLDER = f"platform=Porsche_Taycan/work_order=WO-BAT-2026-001/run_id={BATTERY_RUN}"
BATTERY_COLUMNS = '["file_name", "route", "ts_ms", "frame_name", "signal", "value"]'


def test_the_notebook_names_the_run_and_compiles() -> None:
    source = quixlab_notebook.notebook_source(
        run_id=BATTERY_RUN, table="battery_data_v1", folders=[BATTERY_FOLDER]
    )

    compile(source, "analysis.py", "exec")  # a notebook that will not parse is no notebook
    # The data is a PARTITION dataset with the run's own folder ticked - QuixLab
    # draws it as its picker, not as SQL, and runs it at boot.
    assert f"return ql.lake_partitions('battery_data_v1', ['{BATTERY_FOLDER}'])" in source
    assert '"datasetMode": "partitions"' in source
    assert "SELECT" not in source, "no SQL to read; the picker is the query"
    # In the middle: the dataset straddles the origin.
    assert "@canvas.dataset(\n    position=(-420, -300),\n    size=(840, 600)," in source
    # And the same folder narrowed to the columns the sink writes for a sample.
    assert (
        f"return ql.lake_partitions('battery_data_v1', ['{BATTERY_FOLDER}'], "
        f"columns={BATTERY_COLUMNS.replace(chr(34), chr(39))})"
    ) in source
    assert "def test_data():" in source
    assert "@canvas.cell" not in source, "two datasets, no cells"
    assert "test_definition" not in source, "the lake has no definition level"
    assert "ts_ns" not in source, "this lake stamps milliseconds"


def test_the_lake_browser_opens_down_to_the_run() -> None:
    assert quixlab_notebook.lake_tree("battery_data_v1", BATTERY_FOLDER) == [
        "battery_data_v1",
        "battery_data_v1/platform=Porsche_Taycan",
        "battery_data_v1/platform=Porsche_Taycan/work_order=WO-BAT-2026-001",
        f"battery_data_v1/{BATTERY_FOLDER}",
    ]


def test_a_run_in_two_folders_ticks_both() -> None:
    """A run whose files claimed two work orders sits in two folders of the lake."""
    other = f"platform=Porsche_Taycan/work_order=unassigned/run_id={BATTERY_RUN}"

    source = quixlab_notebook.notebook_source(
        run_id=BATTERY_RUN, table="battery_data_v1", folders=[BATTERY_FOLDER, other]
    )

    assert (
        f"return ql.lake_partitions('battery_data_v1', ['{BATTERY_FOLDER}', '{other}'])" in source
    )


def test_the_notebook_folder_names_only_the_partitions_the_run_has() -> None:
    assert quixlab_notebook.PARTITIONS == ("platform", "work_order", "run_id")
    assert (
        quixlab_notebook.partition_path({"platform": "sn002", "work_order": ""}) == "platform=sn002"
    )
    assert (
        quixlab_notebook.partition_path({"platform": "sn002", "work_order": "WO-1", "run_id": "r"})
        == "platform=sn002/work_order=WO-1/run_id=r"
    )
    assert (
        quixlab_notebook.partition_path({"platform": "sn002", "run_id": "r"}) == "platform=sn002"
    ), "a missing middle column ends the folder; the run id alone would be a lie"
    with pytest.raises(quixlab_notebook.UnsafeValue):
        quixlab_notebook.partition_path({})


def test_the_notebook_refuses_a_value_it_cannot_safely_carry() -> None:
    """The value lands in SQL inside Python: two quoting layers, so it is
    refused rather than escaped twice."""
    with pytest.raises(quixlab_notebook.UnsafeValue):
        quixlab_notebook.notebook_source(
            run_id="r'; DROP TABLE x; --", table="battery_data_v1", folders=[BATTERY_FOLDER]
        )
    with pytest.raises(quixlab_notebook.UnsafeValue):
        quixlab_notebook.notebook_source(
            run_id=BATTERY_RUN, table="battery_data_v1", folders=["platform=Porsche Taycan"]
        )
    with pytest.raises(quixlab_notebook.UnsafeValue):
        quixlab_notebook.notebook_source(run_id=BATTERY_RUN, table="battery_data_v1", folders=[])


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
        if path.endswith(("/start", "/stop")) and "/deployments/" in path:
            # The flat path under PUT, which is the first shape probed; the rest are never
            # reached, so a test that sees a POST here has a client probing in the wrong order.
            state["calls"].append((request.method, path))
            return httpx.Response(200, json={}) if request.method == "PUT" else httpx.Response(405)
        if request.method in ("POST", "DELETE") and "/deployments" in path:
            state["calls"].append((request.method, path))
            if request.method == "DELETE":
                return httpx.Response(200, json={})
            return state["created"]
        if path == "/profile":
            return httpx.Response(
                200, json={"userId": "user-a", "firstName": "Ana", "email": "ana@example.com"}
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


def _notebook(db, notebook_id: str = NB, **over) -> None:
    db["notebooks"].insert_one(
        {
            "_id": notebook_id,
            "run_id": RUN,
            "name": "Notebook 1",
            "created_by": "Ana",
            "created_at": datetime(2026, 9, 22, 9, 0, tzinfo=UTC),
            "saved_at": None,
            **over,
        }
    )


def _lab_row(notebook_id: str = NB, status: str = "Stopped") -> dict:
    return {
        "deploymentId": "dep-lab",
        "name": quixlab_provision.lab_name("user-a", notebook_id, RUN),
        "libraryItemId": "quixlab",
        "status": status,
        "publicUrl": "https://tm-lab.dev.quix.io",
    }


STOPPED_LAB = _lab_row()
RUNNING_LAB = _lab_row(status="Running")
NOTEBOOK_TEXT = "import quixlab as ql\n# edited in the lab\n"


def test_a_viewer_with_no_portal_token_gets_no_lab(client, routed_db) -> None:
    """A lab created without the viewer is a lab owned by this service."""
    _seed(routed_db)

    response = client.post(PATH, json={})

    assert response.status_code == 403, response.text
    assert response.json()["code"] == "quixlab_needs_login"
    assert routed_db["notebooks"].count_documents({}) == 0


def test_creating_a_notebook_writes_the_file_before_the_deployment(
    client, routed_db, portal, written
) -> None:
    """Property 2. A lab pointed at a key with nothing behind it opens the
    file picker, and the person sees an empty QuixLab instead of their run."""
    _seed(routed_db)

    response = client.post(PATH, headers=VIEWER, json={})

    assert response.status_code == 201, response.text
    kinds = [kind for kind, _ in portal["calls"]]
    assert kinds == ["WRITE", "WRITE", "POST"], "the notebook, its manifest, then the deployment"


def _seed_battery(db) -> None:
    """A battery run as this registry holds it: `project` is the work order's planning name."""
    db["test_runs"].insert_one(
        {
            "_id": BATTERY_RUN,
            "description": None,
            "work_order_id": "WO-BAT-2026-001",
            "definition_id": "BAT-SYS-TC-001",
            "definition_ids": ["BAT-SYS-TC-001", "BAT-SYS-TC-002", "BAT-SYS-TC-003"],
            "project": "Porsche Taycan",
            "rig_id": "RIG-01",
            "status": "complete",
            "lake_table": "battery_data_v1",
            "invalid": {"flagged": False, "reason": None, "actor": None, "at": None},
            "field_sources": {},
            "first_data_at": datetime(2026, 9, 15, 9, 0, tzinfo=UTC),
            "created_at": datetime(2026, 9, 15, 9, 0, tzinfo=UTC),
            "updated_at": datetime(2026, 9, 15, 9, 0, tzinfo=UTC),
        }
    )


def test_a_battery_notebook_opens_on_the_folder_the_lake_lists(
    client, routed_db, portal, written, monkeypatch
) -> None:
    """The lake's platform is the MF4 header's (`Porsche_Taycan`), not the run's
    `project` (`Porsche Taycan`), so the folder comes from the lake's own listing."""
    from api.services import lake

    _seed_battery(routed_db)
    asked: list[tuple[str, str]] = []

    def run_partitions(table: str, run_id: str) -> list[str]:
        asked.append((table, run_id))
        return [BATTERY_FOLDER]

    monkeypatch.setattr(lake, "is_configured", lambda: True)
    monkeypatch.setattr(lake, "run_partitions", run_partitions)

    response = client.post(f"/api/v1/test-runs/{BATTERY_RUN}/notebooks", headers=VIEWER, json={})

    assert response.status_code == 201, response.text
    assert asked == [("battery_data_v1", BATTERY_RUN)]
    _, source = written[0]
    assert f"return ql.lake_partitions('battery_data_v1', ['{BATTERY_FOLDER}'])" in source
    assert f"columns={BATTERY_COLUMNS.replace(chr(34), chr(39))}" in source


def test_a_battery_notebook_falls_back_to_the_run_document_with_the_lake_spelling(
    client, routed_db, portal, written, monkeypatch
) -> None:
    """No lake folder yet: the run's `project` "Porsche Taycan" is written as the sink spells
    it, `Porsche_Taycan`, instead of failing the notebook's value check."""
    from api.services import lake

    _seed_battery(routed_db)
    monkeypatch.setattr(lake, "is_configured", lambda: True)
    monkeypatch.setattr(lake, "run_partitions", lambda table, run_id: [])

    response = client.post(f"/api/v1/test-runs/{BATTERY_RUN}/notebooks", headers=VIEWER, json={})

    assert response.status_code == 201, response.text
    _, source = written[0]
    assert f"['{BATTERY_FOLDER}']" in source


def test_a_notebook_falls_back_to_the_run_document_when_the_lake_cannot_list(
    client, routed_db, portal, written, monkeypatch
) -> None:
    from api.services import lake

    _seed(routed_db)

    def refuse(table: str, run_id: str) -> list[str]:
        raise lake.LakeError("QuixLake answered 502")

    monkeypatch.setattr(lake, "is_configured", lambda: True)
    monkeypatch.setattr(lake, "run_partitions", refuse)

    response = client.post(PATH, headers=VIEWER, json={})

    assert response.status_code == 201, response.text
    _, source = written[0]
    folder = f"platform=sn002/work_order=WO-1/run_id={RUN}"
    assert f"return ql.lake_partitions('pcap_data_v1', ['{folder}'])" in source


def test_a_new_notebook_is_listed_and_its_lab_opens_on_its_own_folder(
    client, routed_db, portal, written
) -> None:
    _seed(routed_db)

    body = client.post(PATH, headers=VIEWER, json={"name": "Flutter sweep"}).json()

    notebook_id = body["notebook_id"]
    key, source = written[0]
    assert key == f"{WORKSPACE}/quixlab-runs/{RUN}/{notebook_id}/analysis.py"
    # QuixLab's code store reads the manifest FIRST: without it the root is empty and the
    # lab seeds a blank "My Notebook" over the starter.
    import hashlib
    import json

    manifest_key, manifest = written[1]
    assert manifest_key == f"{key}.manifest.json"
    parsed = json.loads(manifest)
    assert parsed["notebook"] == "analysis.py"
    assert parsed["sha256"] == hashlib.sha256(source.encode()).hexdigest()
    assert parsed["files"] == []
    assert body["lab"]["notebook"] == f"blob://{key}"
    assert f"/run_id={RUN}'" in source, "the notebook opens on THIS run's folder"
    assert body["lab"]["url"] == "https://tm-lab.dev.quix.io"
    assert body["lab"]["created"] is True
    assert body["name"] == "Flutter sweep"
    assert body["created_by"] == "Ana"
    assert body["saved_at"] is None
    listed = client.get(PATH).json()
    assert [row["notebook_id"] for row in listed] == [notebook_id]
    assert listed[0]["lab"] is None, "no token, no Portal read"


def test_a_run_holds_several_notebooks_each_its_own_file_and_lab(
    client, routed_db, portal, written
) -> None:
    """The idea is more than one notebook per run."""
    _seed(routed_db)

    first = client.post(PATH, headers=VIEWER, json={}).json()
    second = client.post(PATH, headers=VIEWER, json={}).json()

    assert first["notebook_id"] != second["notebook_id"]
    assert first["name"] == "Notebook 1"
    assert second["name"] == "Notebook 2"
    assert len({key for key, _ in written if key.endswith("analysis.py")}) == 2, (
        "two files, two folders"
    )
    assert first["lab"]["name"] != second["lab"]["name"], "two labs"
    assert [row["name"] for row in client.get(PATH).json()] == ["Notebook 1", "Notebook 2"]


def test_the_list_carries_this_viewer_s_labs_in_one_portal_read(client, routed_db, portal) -> None:
    _seed(routed_db)
    _notebook(routed_db)
    _notebook(routed_db, "nb-2", name="Notebook 2")
    portal["deployments"] = [TEMPLATE_ROW, RUNNING_LAB]

    rows = client.get(PATH, headers=VIEWER).json()

    assert rows[0]["lab"]["status"] == "Running"
    assert rows[1]["lab"] is None
    assert portal["calls"] == [], "a list makes nothing"


def test_the_workflows_list_carries_every_run_s_notebooks_in_one_portal_read(
    client, routed_db, portal
) -> None:
    """GET /notebooks is the Workflows page: all runs, newest first, this viewer's labs."""
    _seed(routed_db)
    other_run = "sn059_20170302T091407312Z"
    routed_db["test_runs"].insert_one(
        {**routed_db["test_runs"].find_one({"_id": RUN}), "_id": other_run}
    )
    _notebook(routed_db)
    routed_db["notebooks"].insert_one(
        {
            "_id": "nb-9",
            "run_id": other_run,
            "name": "Wing deflection",
            "created_by": "Ana",
            "created_at": datetime(2026, 9, 23, 9, 0, tzinfo=UTC),
            "saved_at": None,
        }
    )
    running_elsewhere = {
        **_lab_row("nb-9", status="Running"),
        "name": quixlab_provision.lab_name("user-a", "nb-9", other_run),
    }
    portal["deployments"] = [TEMPLATE_ROW, STOPPED_LAB, running_elsewhere]

    rows = client.get("/api/v1/notebooks", headers=VIEWER).json()

    assert [row["notebook_id"] for row in rows] == ["nb-9", NB], "newest first, every run"
    assert rows[0]["run_id"] == other_run
    assert rows[0]["lab"]["status"] == "Running"
    assert rows[1]["lab"]["status"] == "Stopped"
    assert portal["calls"] == [], "a list makes nothing"
    # Without a token the notebooks are still listed, with no lab on them.
    assert [row["lab"] for row in client.get("/api/v1/notebooks").json()] == [None, None]


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

    response = client.post(PATH, headers=VIEWER, json={})

    assert response.status_code == 201, response.text


def test_no_quixlab_to_clone_is_the_deployment_s_fault_not_the_caller_s(
    client, routed_db, portal, written
) -> None:
    _seed(routed_db)
    portal["deployments"] = []

    response = client.post(PATH, headers=VIEWER, json={})

    assert response.status_code == 503, response.text
    assert response.json()["code"] == "quixlab_no_template"
    assert written == [], "no notebook is stored for a lab that cannot be made"
    assert routed_db["notebooks"].count_documents({}) == 0, "and none is listed"


def test_a_run_the_registry_does_not_know_gets_no_notebook(
    client, routed_db, portal, written
) -> None:
    """A notebook for a run that does not exist would open on an empty query."""
    response = client.post("/api/v1/test-runs/no-such-run/notebooks", headers=VIEWER, json={})

    assert response.status_code == 404, response.text
    assert written == []


def test_opening_a_saved_notebook_starts_the_stopped_lab_and_writes_nothing(
    client, routed_db, portal, written
) -> None:
    """A notebook that was saved and closed keeps its file in its folder. Opening it is a
    start, never a second create and never a file written over the person's work."""
    _seed(routed_db)
    _notebook(routed_db, saved_at=datetime(2026, 9, 22, 10, 0, tzinfo=UTC))
    portal["deployments"] = [TEMPLATE_ROW, STOPPED_LAB]

    body = client.post(f"{PATH}/{NB}/open", headers=VIEWER).json()

    assert body["lab"]["status"] == "Starting"
    assert body["lab"]["created"] is False
    assert [kind for kind, _ in portal["calls"]] == ["PUT"], portal["calls"]
    assert portal["calls"][0][1].endswith("/deployments/dep-lab/start")
    assert written == [], "the saved notebook is not overwritten"


def test_opening_a_colleague_s_notebook_makes_a_lab_of_your_own_on_the_same_file(
    client, routed_db, portal, written
) -> None:
    """A notebook is the run's. A viewer with no lab on it yet gets one created on its
    folder - and the file, which is the colleague's work, is not written."""
    _seed(routed_db)
    _notebook(routed_db, created_by="Ben")

    body = client.post(f"{PATH}/{NB}/open", headers=VIEWER).json()

    assert body["lab"]["created"] is True
    assert body["lab"]["notebook"] == f"blob://{quixlab_provision.notebook_key(RUN, NB)}"
    assert written == []


def test_a_running_lab_is_not_started_again(client, routed_db, portal, written) -> None:
    _seed(routed_db)
    _notebook(routed_db)
    portal["deployments"] = [TEMPLATE_ROW, RUNNING_LAB]

    body = client.post(f"{PATH}/{NB}/open", headers=VIEWER).json()

    assert body["lab"]["status"] == "Running"
    assert portal["calls"] == []


def test_the_lab_poll_makes_nothing_and_404s_before_there_is_one(client, routed_db, portal) -> None:
    _seed(routed_db)
    _notebook(routed_db)

    missing = client.get(f"{PATH}/{NB}/lab", headers=VIEWER)
    portal["deployments"] = [TEMPLATE_ROW, RUNNING_LAB]
    found = client.get(f"{PATH}/{NB}/lab", headers=VIEWER)

    assert missing.status_code == 404
    assert missing.json()["code"] == "quixlab_not_found"
    assert found.json()["id"] == "dep-lab"
    assert portal["calls"] == []


@pytest.fixture
def notebook_in_blob(monkeypatch, portal):
    """A blob store holding the notebook where QuixLab keeps it."""
    from api.main import app
    from api.services import file_bytes

    store: dict[str, bytes] = {quixlab_provision.notebook_key(RUN, NB): NOTEBOOK_TEXT.encode()}

    class Reader:
        def open(self, storage_ref):
            key = storage_ref.removeprefix("blob://")
            if key not in store:
                raise file_bytes.FileBytesUnavailable("no such blob", reason="blob_missing")
            return iter([store[key]]), len(store[key])

    app.dependency_overrides[file_bytes.get_file_bytes_provider] = lambda: Reader()
    yield store
    app.dependency_overrides.pop(file_bytes.get_file_bytes_provider, None)


def test_save_and_close_records_the_save_and_stops_the_lab(
    client, routed_db, portal, notebook_in_blob
) -> None:
    _seed(routed_db)
    _notebook(routed_db)
    portal["deployments"] = [TEMPLATE_ROW, RUNNING_LAB]

    response = client.post(f"{PATH}/{NB}/close", headers=VIEWER)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["lab"]["status"] == "Stopping"
    assert body["saved_at"] is not None
    assert [c for c in portal["calls"] if c[1].endswith("/stop")] == [
        ("PUT", "/deployments/dep-lab/stop")
    ]
    row = routed_db["notebooks"].find_one({"_id": NB})
    assert row["saved_at"] is not None
    assert row["size_bytes"] == len(NOTEBOOK_TEXT)
    # The file stays where QuixLab wrote it: nothing was copied and nothing was removed.
    assert notebook_in_blob == {quixlab_provision.notebook_key(RUN, NB): NOTEBOOK_TEXT.encode()}


def test_a_notebook_that_cannot_be_read_back_saves_nothing_and_stops_nothing(
    client, routed_db, portal, notebook_in_blob
) -> None:
    """Losing the lab before the work is known to be on disk would lose the work; a lab
    that keeps running after a refused save costs a container, which is the cheaper
    mistake."""
    _seed(routed_db)
    _notebook(routed_db)
    portal["deployments"] = [TEMPLATE_ROW, RUNNING_LAB]
    del notebook_in_blob[quixlab_provision.notebook_key(RUN, NB)]

    response = client.post(f"{PATH}/{NB}/close", headers=VIEWER)

    assert response.status_code == 503, response.text
    assert routed_db["notebooks"].find_one({"_id": NB})["saved_at"] is None
    assert not any(c[1].endswith("/stop") for c in portal["calls"])


def test_stop_halts_the_lab_and_records_no_save(client, routed_db, portal) -> None:
    """The list's Stop: the container goes, the notebook stays as QuixLab left it."""
    _seed(routed_db)
    _notebook(routed_db)
    portal["deployments"] = [TEMPLATE_ROW, RUNNING_LAB]

    response = client.post(f"{PATH}/{NB}/stop", headers=VIEWER)

    assert response.status_code == 200, response.text
    assert response.json()["lab"]["status"] == "Stopping"
    assert response.json()["saved_at"] is None
    assert [c for c in portal["calls"] if c[1].endswith("/stop")] == [
        ("PUT", "/deployments/dep-lab/stop")
    ]
    portal["deployments"] = [TEMPLATE_ROW]
    assert client.post(f"{PATH}/{NB}/stop", headers=VIEWER).status_code == 404


def test_closing_with_no_lab_is_a_404(client, routed_db, portal, notebook_in_blob) -> None:
    _seed(routed_db)
    _notebook(routed_db)
    portal["deployments"] = [TEMPLATE_ROW]

    response = client.post(f"{PATH}/{NB}/close", headers=VIEWER)

    assert response.status_code == 404
    assert response.json()["code"] == "quixlab_not_found"


def test_deleting_a_notebook_removes_the_lab_and_the_row(client, routed_db, portal) -> None:
    _seed(routed_db)
    _notebook(routed_db)
    portal["deployments"] = [TEMPLATE_ROW, RUNNING_LAB]

    response = client.request("DELETE", f"{PATH}/{NB}", headers=VIEWER)

    assert response.status_code == 204, response.text
    assert [c for c in portal["calls"] if c[0] == "DELETE"] == [("DELETE", "/deployments/dep-lab")]
    assert routed_db["notebooks"].count_documents({}) == 0
    assert client.request("DELETE", f"{PATH}/{NB}", headers=VIEWER).status_code == 204


def test_deleting_the_run_removes_every_notebook_and_the_caller_s_labs(
    client, routed_db, portal
) -> None:
    """Run deletion must not fail because a person never opened a lab, and must not
    leave a notebook row pointing at a run that is gone."""
    _seed(routed_db)
    _notebook(routed_db)
    _notebook(routed_db, "nb-2", name="Notebook 2")
    portal["deployments"] = [TEMPLATE_ROW, RUNNING_LAB]

    response = client.request(
        "DELETE", f"/api/v1/test-runs/{RUN}", headers=VIEWER, json={"actor": "ana"}
    )

    assert response.status_code in (200, 204), response.text
    assert [c for c in portal["calls"] if c[0] == "DELETE"] == [
        ("DELETE", "/deployments/dep-lab")
    ], "one lab existed, one is removed; the other notebook had none"
    assert routed_db["notebooks"].count_documents({"run_id": RUN}) == 0
