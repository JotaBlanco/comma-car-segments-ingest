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

import re

# A value safe to sit inside a single-quoted SQL string inside a Python
# triple-quoted string. No quote, no backslash, no newline, no `"""`.
_SAFE = re.compile(r"[A-Za-z0-9._:=/-]{1,200}")

# The partition columns of the lake, outermost first. The sink writes this tree
# (`HIVE_COLUMNS`), and the run's own row names the first three.
PARTITIONS = ("platform", "work_order", "test_definition", "run_id")


class UnsafeValue(ValueError):
    """A value the notebook source will not carry."""


def _literal(value: str, field: str) -> str:
    """One SQL string literal, or a refusal. See the module docstring."""
    if not _SAFE.fullmatch(value or ""):
        raise UnsafeValue(f"{field} is not a value this notebook may name")
    return f"'{value}'"


def lake_tree(table: str, parts: dict[str, str]) -> list[str]:
    """The partition folders the lake browser opens with, outermost first.

    Each entry is the one above it plus one `column=value` segment, which is
    the shape `ql.Canvas(lake_tree_open=...)` takes and the shape the seeded
    notebook already carries (`QuixLabNotebooks/quixlab/main.py`).
    """
    out = [table]
    path = table
    for column in PARTITIONS:
        value = (parts.get(column) or "").strip()
        if not value:
            break
        path = f"{path}/{column}={value}"
        out.append(path)
    return out


def partition_path(parts: dict[str, str]) -> str:
    """The run's own folder of the lake, as one `column=value/...` path.

    This is what a person ticks in QuixLab's partition tree, and what the
    dataset node below carries: `ql.lake_partitions(table, [path])`. Only the
    columns the run actually names are written, outermost first — a run with
    no work order still gets a working folder, just a wider one.
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


def notebook_source(*, run_id: str, table: str, parts: dict[str, str]) -> str:
    """The whole `analysis.py` for one run.

    Three nodes, and no more: the run's data, a per-signal summary, and a plot.
    A starting point is the point — a person opens the lab to ask their own
    question, and a canvas full of somebody else's cells is in the way.

    **The data is a partition dataset, in the middle of the canvas.** The node
    body is `ql.lake_partitions(table, [<the run's folder>])`, which QuixLab
    shows as its partition picker with the run's folders ticked, not as SQL:
    a person widens or narrows the selection by clicking, and the rows are
    loaded when the lab boots (QuixLab runs every node at boot), so the data
    is on screen when they arrive. The two cells sit either side of it, and
    the first view fits all three, with the data in the centre.
    """
    if not _SAFE.fullmatch(table or ""):
        raise UnsafeValue("the lake table is not a name this notebook may query")
    filters = dict(parts)
    filters["run_id"] = run_id
    path = partition_path(filters)
    tree = lake_tree(table, filters)
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
    return ql.lake_partitions({table!r}, [{path!r}])


@canvas.cell(position=(-1320, -300), size=(840, 600), code_height=200)
def inventory(samples):
    """What the run carries: one row per signal, with its range."""
    summary = (
        samples.df()
        .groupby(["protocol", "bus", "signal"])["value"]
        .agg(["count", "min", "max", "mean"])
        .reset_index()
        .sort_values("count", ascending=False)
    )
    ql.viz(summary, type="table", title="Signal inventory")
    return summary


@canvas.cell(position=(480, -300), size=(840, 600), code_height=200)
def timeline(samples):
    """The busiest few signals over time."""
    import pandas as pd

    rows = samples.df()
    busiest = rows["signal"].value_counts().head(6).index.tolist()
    frame = rows[rows["signal"].isin(busiest)].copy()
    frame["timestamp"] = pd.to_datetime(frame["timestamp"], unit="ms")
    wide = (
        frame.pivot_table(index="timestamp", columns="signal", values="value", aggfunc="mean")
        .sort_index()
        .interpolate(method="index", limit_direction="both")
        .reset_index()
    )
    ql.viz(
        wide,
        type="line",
        x="timestamp",
        y=[column for column in wide.columns if column != "timestamp"],
        title="Busiest signals",
        x_title="Time",
        legend=True,
        hover_mode="x unified",
    )
    return wide
'''


__all__ = ["PARTITIONS", "UnsafeValue", "lake_tree", "notebook_source", "partition_path"]
