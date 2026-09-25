"""Accepting a draft: the `draft` cell's generated code becomes the definition's implementation.

QuixLab keeps an AI cell as one function in the notebook file: the prompt is the docstring,
the generated code follows it. Accept lifts that code out as a module a runner can import,
shows it first, and stores it through the one implementation upload route.
"""

import ast
import hashlib
import textwrap
from datetime import UTC, datetime

import pytest

from api import quixlab_provision
from api.services import quixlab_accept, quixlab_draft

RUN = "TAS-1001"
NB = "nb-draft"
TD = "BAT-SYS-TC-003"
PATH = f"/api/v1/test-runs/{RUN}/notebooks/{NB}/draft"

GENERATED = """\
# ql-ai: generated from prompt 1a2b3c
import quixlab as ql

LIMIT_DEGC = float(60)


def evaluate(run_id: str, table: str) -> dict:
    rows = ql.sql(f"SELECT max(value) AS m FROM {table} WHERE run_id = '{run_id}'")
    peak = float(rows["m"].iloc[0])
    verdict = "PASS" if peak <= LIMIT_DEGC else "FAIL"
    return {"tc_id": "BAT-SYS-TC-003", "run_id": run_id, "verdict": verdict}

return evaluate('TAS-1001', 'battery_data_v1')"""

EXPECTED = """\
import quixlab as ql

LIMIT_DEGC = float(60)


def evaluate(run_id: str, table: str) -> dict:
    rows = ql.sql(f"SELECT max(value) AS m FROM {table} WHERE run_id = '{run_id}'")
    peak = float(rows["m"].iloc[0])
    verdict = "PASS" if peak <= LIMIT_DEGC else "FAIL"
    return {"tc_id": "BAT-SYS-TC-003", "run_id": run_id, "verdict": verdict}
"""


def _notebook_file(body: str = GENERATED, *, marker: str = "") -> str:
    """The starter the Draft button writes, with *body* where QuixLab puts generated code."""
    starter = quixlab_draft.draft_source(
        run_id=RUN,
        table="battery_data_v1",
        folders=["platform=Porsche_Taycan/work_order=WO-1/run_id=TAS-1001"],
        definition={"_id": TD, "title": "Battery temperature held at or below T_batt_max"},
        requirements=[],
        spec_documents=[],
    )
    extra = "\n".join(line for line in (marker, body) if line)
    return starter.rstrip("\n") + "\n" + textwrap.indent(extra, "    ") + "\n"


# --------------------------------------------------------------------------
# The pure half: notebook text in, module text out.
# --------------------------------------------------------------------------


def test_the_generated_code_becomes_a_module_without_the_cells_own_run() -> None:
    module = quixlab_accept.draft_implementation(_notebook_file())

    assert module == EXPECTED
    assert any(
        isinstance(node, ast.FunctionDef) and node.name == "evaluate"
        for node in ast.parse(module).body
    )


def test_the_mode_marker_is_metadata_not_code() -> None:
    module = quixlab_accept.draft_implementation(_notebook_file(marker="# ql-ai-mode: agent"))

    assert module == EXPECTED


def test_a_draft_nobody_ran_yet_has_nothing_to_accept() -> None:
    starter = _notebook_file(body="")

    with pytest.raises(quixlab_accept.DraftNotGenerated):
        quixlab_accept.draft_implementation(starter)


def test_a_notebook_without_the_draft_cell_has_nothing_to_accept() -> None:
    with pytest.raises(quixlab_accept.DraftNotGenerated):
        quixlab_accept.draft_implementation("import quixlab as ql\n")


def test_code_without_evaluate_is_refused() -> None:
    body = "x = 1\nreturn x"

    with pytest.raises(quixlab_accept.DraftInvalid, match="evaluate"):
        quixlab_accept.draft_implementation(_notebook_file(body))


def test_code_that_reads_the_cells_input_is_refused() -> None:
    """`test_data` exists only inside the notebook; the Run job imports the module alone."""
    body = "def evaluate(run_id, table):\n    return {'n': len(test_data)}\n\nreturn evaluate('r', 't')"

    with pytest.raises(quixlab_accept.DraftInvalid, match="test_data"):
        quixlab_accept.draft_implementation(_notebook_file(body))


def test_a_top_level_call_of_evaluate_is_dropped_with_the_return() -> None:
    """Importing the module must not query the lake; only the runner calls evaluate."""
    body = (
        "def evaluate(run_id, table):\n    return {'verdict': 'PASS'}\n\n"
        "result = evaluate('r', 't')\nprint(result)\nreturn result"
    )

    module = quixlab_accept.draft_implementation(_notebook_file(body))

    assert module == "def evaluate(run_id, table):\n    return {'verdict': 'PASS'}\n"


def test_a_name_only_the_notebook_binds_is_refused() -> None:
    """QuixLab gives every cell `ql` and `canvas`; the Run job's module has neither."""
    body = (
        "def evaluate(run_id, table):\n    return ql.sql('SELECT 1')\n\nreturn evaluate('r', 't')"
    )

    with pytest.raises(quixlab_accept.DraftInvalid, match="ql"):
        quixlab_accept.draft_implementation(_notebook_file(body))


def test_evaluate_must_take_the_table_by_keyword() -> None:
    """The runner calls `evaluate(run_id, table=...)`."""
    body = "def evaluate(run, tbl):\n    return {}\n\nreturn evaluate('r', 't')"

    with pytest.raises(quixlab_accept.DraftInvalid, match="table"):
        quixlab_accept.draft_implementation(_notebook_file(body))


def test_a_helper_defined_after_the_cells_run_is_kept() -> None:
    body = (
        "def evaluate(run_id, table):\n    return _fmt({'verdict': 'PASS'})\n\n"
        "result = evaluate('r', 't')\n\n"
        "def _fmt(result):\n    return result\n\n"
        "return result"
    )

    module = quixlab_accept.draft_implementation(_notebook_file(body))

    assert "def _fmt(result):" in module
    assert "result = evaluate" not in module


def test_a_bare_expression_is_dropped_and_stdlib_constants_are_kept() -> None:
    body = (
        "import re\n\nPATTERN = re.compile('BMS_.*')\nprint('drafting')\n\n"
        "def evaluate(run_id, table):\n    return {'verdict': 'PASS'}\n\n"
        "return evaluate('r', 't')"
    )

    module = quixlab_accept.draft_implementation(_notebook_file(body))

    assert "PATTERN = re.compile('BMS_.*')" in module
    assert "print(" not in module


@pytest.mark.parametrize(
    "statement",
    [
        "import requests\nPREVIEW = requests.get('https://example.com')",
        "def _load():\n    return []\n\nROWS = _load()",
        "for i in range(3):\n    pass",
    ],
)
def test_code_that_does_work_on_import_is_refused(statement: str) -> None:
    """The Run job imports the module; only `evaluate` may reach the lake or the network."""
    body = (
        f"{statement}\n\n"
        "def evaluate(run_id, table):\n    return {'verdict': 'PASS'}\n\n"
        "return evaluate('r', 't')"
    )

    with pytest.raises(quixlab_accept.DraftInvalid, match="import"):
        quixlab_accept.draft_implementation(_notebook_file(body))


def test_a_notebook_that_does_not_parse_is_refused() -> None:
    with pytest.raises(quixlab_accept.DraftInvalid):
        quixlab_accept.draft_implementation("def draft(:\n")


# --------------------------------------------------------------------------
# The HTTP half: preview, then accept through the upload route.
# --------------------------------------------------------------------------


@pytest.fixture
def blob(app):
    """One store the reader and the writer share, holding the notebook QuixLab wrote."""
    from api.services import file_bytes, file_writes

    store: dict[str, bytes] = {quixlab_provision.notebook_key(RUN, NB): _notebook_file().encode()}

    class Reader:
        def open(self, storage_ref):
            key = storage_ref.removeprefix("blob://")
            if key not in store:
                raise file_bytes.FileBytesUnavailable("no such blob", reason="blob_missing")
            return iter([store[key]]), len(store[key])

    class Writer:
        def check_ready(self) -> None:
            return

        def write(self, key, chunks) -> int:
            store[key] = b"".join(chunks)
            return len(store[key])

    app.dependency_overrides[file_bytes.get_file_bytes_provider] = lambda: Reader()
    app.dependency_overrides[file_writes.get_file_writer] = lambda: Writer()
    yield store
    app.dependency_overrides.pop(file_bytes.get_file_bytes_provider, None)
    app.dependency_overrides.pop(file_writes.get_file_writer, None)


def _seed(db, *, definition_id: str | None = TD) -> None:
    db["notebooks"].insert_one(
        {
            "_id": NB,
            "run_id": RUN,
            "name": f"Draft {TD}",
            "definition_id": definition_id,
            "created_by": "viewer",
            "created_at": datetime(2026, 9, 25, 9, 0, tzinfo=UTC),
            "saved_at": None,
        }
    )
    db["test_definitions"].insert_one({"_id": TD, "title": "Battery temperature"})


def test_the_preview_shows_the_exact_module_and_its_digest(client, routed_db, blob) -> None:
    _seed(routed_db)

    response = client.get(PATH)

    assert response.status_code == 200, response.text
    assert response.json() == {
        "definition_id": TD,
        "filename": f"{TD}.py",
        "code": EXPECTED,
        "sha256": hashlib.sha256(EXPECTED.encode()).hexdigest(),
    }


def test_a_notebook_that_is_not_a_draft_has_no_preview(client, routed_db, blob) -> None:
    _seed(routed_db, definition_id=None)

    response = client.get(PATH)

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "not_a_draft"


def test_an_ungenerated_draft_answers_422(client, routed_db, blob) -> None:
    _seed(routed_db)
    blob[quixlab_provision.notebook_key(RUN, NB)] = _notebook_file(body="").encode()

    response = client.get(PATH)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "draft_not_generated"


def test_a_missing_notebook_file_answers_404(client, routed_db, blob) -> None:
    _seed(routed_db)
    blob.clear()

    response = client.get(PATH)

    assert response.status_code == 404, response.text
    assert response.json()["code"] == "notebook_file_not_found"


def test_accept_stores_the_previewed_module_as_the_implementation(client, routed_db, blob) -> None:
    _seed(routed_db)
    sha = client.get(PATH).json()["sha256"]

    response = client.post(f"{PATH}/accept", json={"sha256": sha})

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["filename"] == f"{TD}.py"
    assert body["sha256"] == sha
    assert body["entrypoint"] == "evaluate"
    stored = routed_db["test_definitions"].find_one({"_id": TD})["implementation"]
    assert stored["sha256"] == sha
    assert blob[stored["blob_path"].removeprefix("blob://")] == EXPECTED.encode()
    events = routed_db["journal_entries"].find({"entity_id": TD, "kind": "event"})
    assert [e["field"] for e in events] == ["test_definition.implementation_uploaded"]


def test_accept_refuses_code_that_changed_since_the_preview(client, routed_db, blob) -> None:
    """The person accepts what they read; a lab still editing the cell must not slip past."""
    _seed(routed_db)
    stale = client.get(PATH).json()["sha256"]
    edited = GENERATED.replace("float(60)", "float(65)")
    blob[quixlab_provision.notebook_key(RUN, NB)] = _notebook_file(edited).encode()

    response = client.post(f"{PATH}/accept", json={"sha256": stale})

    assert response.status_code == 409, response.text
    assert response.json()["code"] == "draft_changed"
    assert "implementation" not in routed_db["test_definitions"].find_one({"_id": TD})


def test_accept_writes_no_verdict(client, routed_db, blob) -> None:
    """A draft trial is not evidence: the rollups count every verdict they find."""
    _seed(routed_db)
    sha = client.get(PATH).json()["sha256"]

    client.post(f"{PATH}/accept", json={"sha256": sha})

    assert routed_db["processed_results"].count_documents({}) == 0
