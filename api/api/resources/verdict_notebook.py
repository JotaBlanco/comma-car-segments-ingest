# Test Manager's default verdict notebook: runs one definition's implementation on one run.
# Test Manager seeds this file once per definition and never overwrites it, so edits made
# in QuixLab stay. The outputs of `result` are the verdict Test Manager records.

import importlib.util
import json
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import quixlab as ql
from quixlab.sources import storage

canvas = ql.Canvas()


def load_implementation(key):
    # The module is imported from a file, so its own relative reads and tracebacks work.
    folder = Path(tempfile.mkdtemp(prefix="tm-implementation-"))
    path = folder / (Path(key).name or "implementation.py")
    path.write_bytes(storage.read_file(key))
    spec = importlib.util.spec_from_file_location("tm_implementation", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def plain_json(value):
    return json.loads(json.dumps(value, default=str))


@canvas.cell(viz={"param": {"type": "string", "required": True}})
def run_id():
    return ql.param()


@canvas.cell(viz={"param": {"type": "string", "required": True}})
def td_id():
    return ql.param()


@canvas.cell(viz={"param": {"type": "string", "required": True}})
def implementation_key():
    return ql.param()


@canvas.cell(viz={"param": {"type": "string", "required": True}})
def lake_table():
    return ql.param()


@canvas.cell(viz={"param": {"type": "string", "default": "evaluate"}})
def entrypoint():
    return ql.param()


@canvas.cell(viz={"output": True})
def result(run_id, td_id, implementation_key, lake_table, entrypoint):
    try:
        module = load_implementation(implementation_key)
        answer = getattr(module, entrypoint or "evaluate")(run_id, table=lake_table)
        if not isinstance(answer, dict):
            raise TypeError(f"{entrypoint} returned {type(answer).__name__}, not a dict")
        verdict = str(answer.get("verdict") or "ERROR")
        evidence = plain_json(answer.get("evidence") or {})
        tc_id = answer.get("tc_id") or td_id
    except Exception as exc:  # noqa: BLE001 - any failure of the implementation is an ERROR verdict
        verdict = "ERROR"
        evidence = {"error": f"{type(exc).__name__}: {exc}"}
        tc_id = td_id
    return {
        "tc_id": tc_id,
        "run_id": run_id,
        "verdict": verdict,
        "evidence": evidence,
        "evaluated_at": datetime.now(UTC).isoformat(),
    }
