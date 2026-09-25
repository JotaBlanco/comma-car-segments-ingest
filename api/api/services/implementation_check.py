"""Whether a module text is one the Run job can import and call as an implementation.

The job loads the file as a fresh module and calls `evaluate(run_id, table=...)`
(`resources/verdict_notebook.py`). So the module must define that function with that
signature, must bind every global name it uses, and importing it must do no work: a
module-level query would run with the viewer's token on every import. Only imports,
definitions and assignments computed by builtins or the standard library may sit at
module level.
"""

from __future__ import annotations

import ast
import builtins
import symtable
import sys

ENTRYPOINT = "evaluate"

_BUILTINS = frozenset(dir(builtins)) | {"__file__", "__name__"}
_DEFINITIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
_MODULE_LEVEL = (ast.Import, ast.ImportFrom, ast.Assign, ast.AnnAssign, *_DEFINITIONS)


class ImplementationInvalid(Exception):
    """The module is not one the Run job can import and call."""


def check_implementation(module: str, *, unavailable: frozenset[str] = frozenset()) -> None:
    """Raise `ImplementationInvalid` unless *module* is importable and callable by the job.

    *unavailable* names what the author's environment provided but the job's will not
    (a notebook cell's inputs); using one is refused by name.
    """
    try:
        tree = ast.parse(module)
    except SyntaxError as error:
        raise ImplementationInvalid(
            f"the code does not parse: {error.msg} (line {error.lineno})"
        ) from error
    _check_entrypoint(tree)
    _check_unavailable(tree, unavailable)
    _check_module_level(tree)
    _check_bound(module)


def _check_entrypoint(tree: ast.Module) -> None:
    function = next(
        (n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == ENTRYPOINT), None
    )
    if function is None:
        raise ImplementationInvalid(f"the code defines no top-level {ENTRYPOINT}()")
    args = function.args
    positional = [*args.posonlyargs, *args.args]
    keywords = {a.arg for a in [*args.args, *args.kwonlyargs]}
    takes_run = bool(positional) or args.vararg is not None
    takes_table = "table" in keywords or args.kwarg is not None
    if not (takes_run and takes_table):
        raise ImplementationInvalid(
            f"{ENTRYPOINT}() must take (run_id, table): the Run job calls "
            f"{ENTRYPOINT}(run_id, table=...)"
        )


def _check_unavailable(tree: ast.Module, unavailable: frozenset[str]) -> None:
    read = sorted({n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id in unavailable})
    if read:
        raise ImplementationInvalid(
            f"the code reads {', '.join(read)}, which only the notebook provides"
        )


def _stdlib_bindings(tree: ast.Module) -> set[str]:
    """The module-level names an import of a standard-library module binds."""
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] in sys.stdlib_module_names:
                    names.add(alias.asname or alias.name.split(".")[0])
        elif (
            isinstance(node, ast.ImportFrom)
            and node.level == 0
            and (node.module or "").split(".")[0] in sys.stdlib_module_names
        ):
            names.update(alias.asname or alias.name for alias in node.names)
    return names


def _call_root(call: ast.Call) -> str | None:
    func = call.func
    while isinstance(func, ast.Attribute):
        func = func.value
    return func.id if isinstance(func, ast.Name) else None


def _check_module_level(tree: ast.Module) -> None:
    defined = {n.name for n in tree.body if isinstance(n, _DEFINITIONS)}
    allowed = (_BUILTINS - defined) | _stdlib_bindings(tree)
    for node in tree.body:
        if not isinstance(node, _MODULE_LEVEL):
            raise ImplementationInvalid(
                f"line {node.lineno}: a module-level {type(node).__name__.lower()} statement "
                f"runs on import; move it into {ENTRYPOINT}()"
            )
        if isinstance(node, (ast.Import, ast.ImportFrom, *_DEFINITIONS)):
            continue
        for call in (n for n in ast.walk(node) if isinstance(n, ast.Call)):
            if _call_root(call) not in allowed:
                raise ImplementationInvalid(
                    f"line {node.lineno}: {ast.unparse(call.func)}() runs on import; "
                    f"call it inside {ENTRYPOINT}()"
                )


def _global_reads(table: symtable.SymbolTable, top: bool) -> set[str]:
    reads = {
        s.get_name() for s in table.get_symbols() if s.is_referenced() and (top or s.is_global())
    }
    for child in table.get_children():
        reads |= _global_reads(child, top=False)
    return reads


def _check_bound(module: str) -> None:
    top = symtable.symtable(module, "<implementation>", "exec")
    bound = {s.get_name() for s in top.get_symbols() if s.is_assigned() or s.is_imported()}
    unbound = sorted(_global_reads(top, top=True) - bound - _BUILTINS)
    if unbound:
        hint = (
            " (a notebook cell gets ql and canvas for free; the Run job does not, so import them)"
            if {"ql", "canvas"} & set(unbound)
            else ""
        )
        raise ImplementationInvalid(
            f"the code uses {', '.join(unbound)} but never defines or imports it{hint}"
        )
