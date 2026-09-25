"""The implementation an accepted draft becomes: the `draft` cell's generated code, as a module.

QuixLab keeps an AI cell as ONE function in the notebook file: the prompt is its docstring,
a `# ql-ai-mode:` marker may follow, then the generated code verbatim. The code-mode draft
ends by calling `evaluate` on its own run so the cell shows a verdict. A module a runner
imports must not do that - importing it would query the lake - so every body-level
statement that calls `evaluate` or uses what such a call produced, every bare expression,
and the closing `return` stay behind in the notebook. What is left must then pass
`implementation_check`, the Run job's own terms.
"""

from __future__ import annotations

import ast
import re
import textwrap

from api.services.implementation_check import (
    ENTRYPOINT,
    ImplementationInvalid,
    check_implementation,
)

DRAFT_CELL = "draft"

# QuixLab's own metadata lines: the generation marker and the mode marker.
_QUIXLAB_MARKER = re.compile(r"^\s*# ql-ai(-mode)?:.*$")


class DraftNotGenerated(Exception):
    """The notebook holds no generated code to accept yet."""


class DraftInvalid(ImplementationInvalid):
    """The generated code is not a module a runner can import and call."""


def draft_implementation(source: str, cell: str = DRAFT_CELL) -> str:
    """The module text of *cell*'s generated code in the notebook *source*.

    Raises:
        DraftNotGenerated: no such cell, or a cell nobody ran yet.
        DraftInvalid: the notebook does not parse, or the code fails
            `check_implementation`.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        raise DraftInvalid(
            f"the notebook does not parse: {error.msg} (line {error.lineno})"
        ) from error
    function = next(
        (n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == cell), None
    )
    if function is None:
        raise DraftNotGenerated(f"the notebook has no {cell!r} cell")

    body = function.body
    if body and _is_docstring(body[0]):
        body = body[1:]
    if not body:
        raise DraftNotGenerated(f"the {cell!r} cell has no generated code yet; run it first")

    module = _module_text(source, body)
    inputs = frozenset(arg.arg for arg in function.args.args)
    try:
        check_implementation(module, unavailable=inputs)
    except ImplementationInvalid as error:
        raise DraftInvalid(str(error)) from error
    return module


def _is_docstring(node: ast.stmt) -> bool:
    return (
        isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)
    )


def _names(node: ast.stmt, context: type[ast.expr_context]) -> set[str]:
    return {
        sub.id
        for sub in ast.walk(node)
        if isinstance(sub, ast.Name) and isinstance(sub.ctx, context)
    }


def _cells_own_run(body: list[ast.stmt]) -> list[ast.stmt]:
    """What only the cell needs: calls of evaluate, what uses them, bare expressions, return.

    A definition is never dropped: its body's locals are not the cell's names, and a
    helper that dangles after the drop is refused by the unbound-name check instead.
    """
    tainted = {ENTRYPOINT}
    run: list[ast.stmt] = []
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if isinstance(node, (ast.Return, ast.Expr)) or _names(node, ast.Load) & tainted:
            run.append(node)
            tainted |= _names(node, ast.Store)
    return run


def _span(node: ast.stmt) -> tuple[int, int]:
    """The 1-based line range a statement occupies, its decorators included."""
    decorators = getattr(node, "decorator_list", [])
    start = min([node.lineno, *(d.lineno for d in decorators)])
    return start, node.end_lineno or node.lineno


def _module_text(source: str, body: list[ast.stmt]) -> str:
    """The body's lines, dedented, minus the cell's own run and QuixLab's markers."""
    lines = source.splitlines()
    first, _ = _span(body[0])
    _, last = _span(body[-1])
    dropped: set[int] = set()
    for node in _cells_own_run(body):
        start, end = _span(node)
        dropped.update(range(start, end + 1))
    kept = [
        line
        for number, line in enumerate(lines[first - 1 : last], start=first)
        if number not in dropped and not _QUIXLAB_MARKER.match(line)
    ]
    return textwrap.dedent("\n".join(kept)).strip("\n") + "\n"
