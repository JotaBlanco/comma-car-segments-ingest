"""The starter notebook of an implementation draft: one definition, drafted on one run.

Test Manager writes it into the run's notebook folder like `quixlab_notebook.notebook_source`
does for a plain analysis, so the same lab machinery opens it. The canvas carries the
definition's text and its requirements, the contract an implementation must meet, the
run's data, and one AI cell whose prompt asks for `evaluate()` and runs it on this run.
The person reviews the code and the verdict in the lab; accepting it into the definition is
a later step.
"""

from __future__ import annotations

from api.services import quixlab_notebook
from api.services.quixlab_notebook import TEST_DATA_COLUMNS, UnsafeValue, lake_tree

# The spec documents can be long; the canvas shows this much and points at the rest.
_SPEC_MAX_CHARS = 6000

CONTRACT = """\
evaluate(run_id: str, table: str) -> dict

The module is STANDALONE: only the standard library, numpy and requests. It reads the
run's samples from QuixLake by run_id alone (the table partitions by platform / work order
/ run) through POST {url}/query, url from the environment variables
Quix__Lakehouse__Query__Url or QUIX_LAKE_URL, bearer from Quix__Lakehouse__Query__AuthToken
or Quix__Sdk__Token, body = the SQL as text/plain, answer = CSV.

It returns {"verdict": "PASS" | "FAIL", "evidence": {<name>: <number>, ...}}: every number
the rule enforces or measures, named so a reader compares limit and achieved value.

Signals are CAN, so a signal is latched: on a shared grid a sample of another frame reads
as the last value at or before the instant, never interpolated. A signal the run does not
carry raises LookupError naming it.
"""


def _text(value: object) -> str:
    # A NUL byte cannot sit in Python source, whatever the escaping.
    return str(value or "").replace("\x00", "").strip()


def draft_source(
    *,
    run_id: str,
    table: str,
    folders: list[str],
    definition: dict,
    requirements: list[dict],
    spec_documents: list[tuple[str, str]],
) -> str:
    """The whole starter file of a draft: the run's data, the spec, and the drafting cell."""
    if not quixlab_notebook._SAFE.fullmatch(table or ""):
        raise UnsafeValue("the lake table is not a name this notebook may query")
    quixlab_notebook._literal(run_id, "the run id")
    td_id = _text(definition.get("_id") or definition.get("td_id"))
    quixlab_notebook._literal(td_id, "the definition id")
    if not folders:
        raise UnsafeValue("the notebook needs at least one partition to open on")
    for folder in folders:
        if not quixlab_notebook._SAFE.fullmatch(folder or ""):
            raise UnsafeValue("a partition folder is not a value this notebook may name")

    title = _text(definition.get("title"))
    req_lines = [
        f"- **{_text(r.get('_id') or r.get('req_id'))}** {_text(r.get('title'))}: "
        f"{_text(r.get('text_rendered') or r.get('text'))}"
        for r in requirements
    ]
    spec = "\n\n".join(
        f"### {name}\n\n{body[:_SPEC_MAX_CHARS]}"
        + ("\n\n_(document truncated)_" if len(body) > _SPEC_MAX_CHARS else "")
        for name, body in spec_documents
    )
    spec_markdown = (
        f"# Draft implementation of {td_id}\n\n**{title}**\n\n"
        + ("## Requirements it verifies\n\n" + "\n".join(req_lines) + "\n\n" if req_lines else "")
        + ("## Test specification\n\n" + spec + "\n\n" if spec else "")
        + "## Contract\n\n```\n"
        + CONTRACT
        + "```\n"
    )
    prompt = (
        f"Write the complete test implementation of {td_id} ({title}) and run it on run "
        f"{run_id}. Read the specification and the contract in the markup on this canvas, "
        f"and use @test_data only to learn the signal names, rates and value ranges the run "
        f"carries. The cell must define `evaluate(run_id, table)` exactly as the contract "
        f"says, as a standalone module (standard library, numpy, requests; the lake through "
        f"POST /query with the environment variables the contract names), with the limits "
        f"the specification states as named constants. Finish the cell with "
        f"`return evaluate({run_id!r}, {table!r})` so the verdict and evidence show below."
    )
    # The prompt is the AI cell's docstring: a literal, so it is escaped as one.
    docstring = prompt.replace("\\", "\\\\").replace('"', '\\"')
    paths = list(folders)
    tree = lake_tree(table, paths[0])
    columns = list(TEST_DATA_COLUMNS)
    return f'''"""Draft implementation of {td_id} on run {run_id}.

Test Manager wrote this notebook into the run's folder. The markup holds the
definition, its requirements and the contract; `draft` asks the AI to write
`evaluate()` and runs it on this run. Review the code, then accept it in the
Test Manager as the definition's implementation.
"""

import quixlab as ql

canvas = ql.Canvas(
    title="Draft {td_id} on {run_id}",
    lake_tree_open={tree!r},
    markups=[
        {{
            "id": "m_spec",
            "text": {spec_markdown!r},
            "x": -1180,
            "y": -340,
            "width": 700,
            "height": 720,
        }}
    ],
)


@canvas.dataset(position=(-420, -340), size=(740, 399), code_height=200, viz={{'datasetMode': 'partitions'}})
def test_data():
    return ql.lake_partitions({table!r}, {paths!r}, columns={columns!r})


@canvas.ai(
    position=(380, -340),
    size=(820, 720),
    viz={{"aiMode": "code", "aiEffort": "medium"}},
)
def draft(test_data):
    """{docstring}"""
'''
