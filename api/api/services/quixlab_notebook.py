"""The notebook Test Manager writes into one run's own folder.

**Why a file per run, and why in the run's own folder.** QuixLab's project root
is the FOLDER of the notebook `QUIXLAB_NOTEBOOK=blob://<key>` names, and that
root is where its manifest, runs, items and chats live
(`quixlab/src/quixlab/project.py`, `parse()`). Pointing one lab at
`<run>/analysis.py` therefore hands that run a workspace of its own, and two
runs never share a canvas, a chat or a result.

**This module only writes text.** It imports no QuixLab and reaches no
platform, so the source it produces is unit testable against nothing. The
caller stores the bytes.

**Every value that reaches the source is checked, never escaped.** A run id, a
table and a partition value all land inside a SQL string inside a Python source
file — two quoting layers, and a mistake in either is an injection. Rather than
escape twice, `_literal` REFUSES anything outside a conservative character set.
Every id this registry mints passes it, and a value that does not is a bug
worth a 500 rather than a notebook that runs someone else's SQL.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime

# A value safe to sit inside a single-quoted SQL string inside a Python
# triple-quoted string. No quote, no backslash, no newline, no `"""`.
_SAFE = re.compile(r"[A-Za-z0-9._:=/-]{1,200}")

# The physical partition columns of the lake, outermost first: the head of the sink's
# `HIVE_COLUMNS` (`mf4-datalake-sink/main.py`). There is no `test_definition` level.
PARTITIONS = ("platform", "work_order", "run_id")

# The columns `test_data` narrows to, as the sink writes them (`mf4-datalake-sink/expand.py`).
TEST_DATA_COLUMNS = ("file_name", "route", "ts_ms", "frame_name", "signal", "value")


class UnsafeValue(ValueError):
    """A value the notebook source will not carry."""


def _literal(value: str, field: str) -> str:
    """One SQL string literal, or a refusal. See the module docstring."""
    if not _SAFE.fullmatch(value or ""):
        raise UnsafeValue(f"{field} is not a value this notebook may name")
    return f"'{value}'"


def lake_tree(table: str, folder: str) -> list[str]:
    """The partition folders the lake browser opens with, outermost first.

    Each entry is the one above it plus one `column=value` segment of `folder`, which
    is the shape `ql.Canvas(lake_tree_open=...)` takes.
    """
    out = [table]
    path = table
    for segment in folder.split("/"):
        path = f"{path}/{segment}"
        out.append(path)
    return out


def partition_path(parts: dict[str, str]) -> str:
    """The run's own folder of the lake, as one `column=value/...` path.

    Only the columns the run actually names are written, outermost first; a missing
    column ends the folder, because the levels below it would be a guess.
    """
    # Every value is checked, whether or not it lands in the path: a bad one is a bug.
    for column in PARTITIONS:
        value = (parts.get(column) or "").strip()
        if value and not _SAFE.fullmatch(value):
            raise UnsafeValue(f"{column} is not a value this notebook may name")
    segments = []
    for column in PARTITIONS:
        value = (parts.get(column) or "").strip()
        if not value:
            break
        segments.append(f"{column}={value}")
    if not segments:
        raise UnsafeValue("the notebook needs at least one partition to open on")
    return "/".join(segments)


def notebook_source(*, run_id: str, table: str, folders: list[str]) -> str:
    """The whole `analysis.py` for one run, ticked on the run's own lake folders.

    Two partition datasets, and no more: `samples`, the whole run as a table, and
    `test_data`, the same folders narrowed to `TEST_DATA_COLUMNS`. Both bodies are
    `ql.lake_partitions(table, folders)`, which QuixLab shows as its partition picker
    with those folders ticked, and runs at boot so the data is on screen on arrival.

    `folders` are full `column=value/...` paths, outermost first. A run whose files
    claimed two work orders sits in two folders, and both are ticked.
    """
    if not _SAFE.fullmatch(table or ""):
        raise UnsafeValue("the lake table is not a name this notebook may query")
    _literal(run_id, "the run id")
    if not folders:
        raise UnsafeValue("the notebook needs at least one partition to open on")
    for folder in folders:
        if not _SAFE.fullmatch(folder or ""):
            raise UnsafeValue("a partition folder is not a value this notebook may name")
    paths = list(folders)
    tree = lake_tree(table, paths[0])
    columns = list(TEST_DATA_COLUMNS)
    return f'''"""Analysis of test run {run_id}.

Test Manager wrote this notebook into the run's own folder, which is this
QuixLab's project root. Everything you add here — cells, chats, results —
stays with the run.

The dataset in the middle is the whole run: its folders of the lake, ticked.
Click it to widen or narrow the selection, or add a cell of your own.
"""

import quixlab as ql

canvas = ql.Canvas(
    title="Run {run_id}",
    lake_tree_open={tree!r},
)


@canvas.dataset(
    position=(-420, -300),
    size=(840, 600),
    code_height=160,
    viz={{"datasetMode": "partitions", "type": "table"}},
)
def samples():
    return ql.lake_partitions({table!r}, {paths!r})


@canvas.dataset(position=(147, -326), size=(740, 399), code_height=200, viz={{'datasetMode': 'partitions'}})
def test_data():
    return ql.lake_partitions({table!r}, {paths!r}, columns={columns!r})
'''


# What QuixLab's code store records as the writer of a notebook; the lab's own pushes carry
# its deployment id here.
MANIFEST_SOURCE = "test-manager"


def manifest_source(notebook_name: str, text: str) -> str:
    """The manifest QuixLab's code store reads BESIDE the notebook, as JSON.

    A lab booted on a project root asks the code store for `<root>/<notebook>.manifest.json`
    first; the notebook alone reads as an EMPTY root, and QuixLab then seeds a blank
    "My Notebook" over it (`quixlab/src/quixlab/code_store.py`, `materialize`;
    `main.py`, `_boot_project`). The fingerprint is the store's own: sha256 of the text,
    with no file nodes (`content_sha`).
    """
    return json.dumps(
        {
            "notebook": notebook_name,
            "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "written": datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"),
            "files": [],
            "source": MANIFEST_SOURCE,
        }
    )


__all__ = [
    "PARTITIONS",
    "TEST_DATA_COLUMNS",
    "UnsafeValue",
    "lake_tree",
    "manifest_source",
    "notebook_source",
    "partition_path",
]
