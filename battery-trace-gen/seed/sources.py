"""The seed's inputs, read once and indexed by id.

Every path below is a sibling of this package and a statement of record listed
in `CLAUDE.md`. Nothing here computes a verdict or a limit; it reads.

`out/manifest.csv` is the one GENERATED input. It exists only after
`python generate.py --scenario all`, and the seed refuses to build a payload
without it rather than shipping a definition whose evidence block is blank.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parents[1]
REQUIREMENTS_PATH = TOOL_ROOT / "data" / "battery-dc-requirements.json"
PARAMETERS_PATH = TOOL_ROOT / "data" / "battery-dc-parameters.json"
SPECS_PATH = TOOL_ROOT / "specs" / "battery-dc-test-specs.json"
MANIFEST_CSV_PATH = TOOL_ROOT / "out" / "manifest.csv"
SCENARIO_DIR = TOOL_ROOT / "scenarios"
IDENTITY_PATH = SCENARIO_DIR / "_identity.json"


class MissingInput(RuntimeError):
    """One of the seed's inputs is not there."""


def _items(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))["items"]


def requirements() -> dict[str, dict]:
    """The ten requirements, keyed by `BAT-SYS-{FUN,PRF,SAF}-NNN`."""
    return {item["id"]: item for item in _items(REQUIREMENTS_PATH)}


def parameters() -> dict[str, dict]:
    """The eleven parameters the requirement tokens resolve against, by name."""
    return {item["name"]: item for item in _items(PARAMETERS_PATH)}


def test_specs() -> dict[str, dict]:
    """The ten test cases, keyed by `tc_id`. The test case IS the definition."""
    return {item["tc_id"]: item for item in _items(SPECS_PATH)}


def verdicts() -> dict[str, dict]:
    """The expected verdict and measured evidence of each test case, by `tc_id`.

    One row of `out/manifest.csv`, which the generator measured off the same
    quantised bus history the lake holds.
    """
    if not MANIFEST_CSV_PATH.exists():
        raise MissingInput(
            f"{MANIFEST_CSV_PATH} is not there. Run `python generate.py --scenario all` first."
        )
    with MANIFEST_CSV_PATH.open(encoding="utf-8", newline="") as handle:
        return {row["tc_id"]: row for row in csv.DictReader(handle)}


def identity() -> dict:
    """`scenarios/_identity.json` — the platform and the shared `test.*` block."""
    return json.loads(IDENTITY_PATH.read_text(encoding="utf-8"))


def traces() -> list[dict]:
    """Each scenario's chain claim, in trace order.

    `{"trace_id", "file", "run_key", "definitions"}`. The scenario documents are
    what the MF4 headers were written from, so the links this seed pushes and
    the claims the traces carry come from one source.
    """
    rows = []
    for path in sorted(SCENARIO_DIR.glob("T*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        rows.append(
            {
                "trace_id": document["trace_id"],
                "file": f"{path.stem}.mf4",
                "run_key": document["test"]["run_key"],
                "definitions": list(document["test"]["definitions"]),
            }
        )
    return rows


def run_of_definition() -> dict[str, str]:
    """`{tc_id: run_key}` — which trace answers each definition."""
    return {
        tc_id: trace["run_key"]
        for trace in traces()
        for tc_id in trace["definitions"]
    }


def trace_of_definition() -> dict[str, str]:
    """`{tc_id: trace filename}` — the evidence file behind each definition."""
    return {
        tc_id: trace["file"] for trace in traces() for tc_id in trace["definitions"]
    }
