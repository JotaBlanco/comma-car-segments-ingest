"""Regenerate the V-model fixtures from a local checkout of ``acc_project``.

The fixtures committed next to this script are **not hand-authored**. Three of them are
verbatim copies of acc_project exports; two are produced by running acc_project's own code
and capturing its output. This script does both, so the provenance of every number in the
Test Manager is a command someone else can re-run.

    python backend/api/vmodel_fixtures/tools/build_vmodel_fixtures.py --acc-project C:/repos/acc_project

Requires acc_project's check dependencies (``asammdf``, ``numpy``) on the interpreter that
runs it, because the verdicts are produced by importing and running acc_project's registry.
Nothing here is imported by the Test Manager backend at runtime.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

FIXTURES_DIR = Path(__file__).resolve().parents[1]

# source path (relative to acc_project) -> fixture path (relative to the fixtures dir)
VERBATIM_COPIES = {
    "Reqs/export/json/acc-system-requirements.json": "requirements/acc-system-requirements.json",
    "TestSpecs/acc-system-test-specs.json": "test_specs/acc-system-test-specs.json",
    "Reqs/export/json/acc-signal-catalogue.json": "signals/acc-signal-catalogue.json",
}

FIGURE_GLOB = "Reqs/export/figures/F[1-6]*.svg"

# The nine implementation modules, in registry order.
IMPL_MODULES = (
    "tc_acc_sys_fun_005",
    "tc_acc_sys_fun_021",
    "tc_acc_sys_fun_061",
    "tc_acc_sys_prf_001",
    "tc_acc_sys_prf_020",
    "tc_acc_sys_prf_041",
    "tc_acc_sys_saf_021",
    "tc_acc_sys_saf_024",
    "tc_acc_sys_saf_040",
)

TRACE_SLUG_RE = re.compile(r"[^a-z0-9._-]+")


def sha256_of(path: Path) -> str:
    """sha256 hex digest of a file's bytes."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_sha256(payload: Any) -> str:
    """sha256 over a deterministic serialisation (sorted keys, no insignificant space)."""
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def write_json(path: Path, payload: Any) -> None:
    """Write a fixture as indented UTF-8 JSON with a trailing newline."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def copy_verbatim(acc_project: Path) -> list[tuple[str, str, int, str]]:
    """Copy the exported artifacts across untouched. Returns rows for the README table."""
    rows = []
    for source_rel, target_rel in VERBATIM_COPIES.items():
        source = acc_project / source_rel
        target = FIXTURES_DIR / target_rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        rows.append((target_rel, source_rel, target.stat().st_size, sha256_of(target)))

    for source in sorted(acc_project.glob(FIGURE_GLOB)):
        target = FIXTURES_DIR / "figures" / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        rows.append(
            (
                f"figures/{source.name}",
                f"Reqs/export/figures/{source.name}",
                target.stat().st_size,
                sha256_of(target),
            )
        )
    return rows


def build_test_impls(acc_project: Path) -> dict[str, Any]:
    """Import acc_project's registry and emit one artifact-set document for the nine impls.

    ``check_spec`` is read off the ``CheckSpec`` dataclass each module declares, not parsed
    out of the source text: the declared bound is the single source of truth and re-deriving
    it from a regex would be a second, divergent one.
    """
    sys.path.insert(0, str(acc_project))
    from TestImpl.registry import CHECKS  # noqa: PLC0415 - acc_project must be on sys.path first

    impl_dir = acc_project / "TestImpl"
    shared_files = ("verdict.py", "trace.py")

    items = []
    for module_name, check in zip(IMPL_MODULES, CHECKS, strict=True):
        spec = check.spec
        check_spec = asdict(spec) if is_dataclass(spec) else dict(spec.__dict__)
        check_spec = {key: _plain(value) for key, value in check_spec.items()}

        paths = [f"{module_name}.py", *shared_files]
        files = []
        source: dict[str, str] = {}
        for rel in paths:
            path = impl_dir / rel
            text = path.read_text(encoding="utf-8")
            source[rel] = text
            files.append(
                {
                    "path": rel,
                    "size_bytes": path.stat().st_size,
                    "sha256": sha256_of(path),
                    "lines": text.count("\n"),
                }
            )

        module_doc = (source[f"{module_name}.py"].split('"""')[1:2] or [""])[0].strip()
        item = {
            # The verdicts and the registry speak TC-ACC-SYS-PRF-020; the test specs speak
            # ACC-SYS-TC-014. Both are carried so neither side has to guess.
            "impl_id": spec.test_case_id,
            "requirement_id": spec.requirement_id,
            "language": "python",
            "entrypoint": f"{module_name}:run",
            "runtime": "python:3.12",
            "timeout_s": 120,
            "trace_required": True,
            "recommended_scenario": check.recommended_scenario,
            "description": module_doc,
            "files": files,
            "source": source,
            "check_spec": check_spec,
        }
        item["canonical_sha256"] = canonical_sha256(item)
        items.append(item)

    return {
        "schema_version": "1.0.0",
        "set": "test_impl",
        "version": "v0001",
        "item_count": len(items),
        "item_ids": sorted(item["impl_id"] for item in items),
        "set_canonical_sha256": canonical_sha256(items),
        "created_by": "acc_project TestImpl.registry via build_vmodel_fixtures.py",
        "items": items,
    }


def _plain(value: Any) -> Any:
    """Enums and tuples out of the dataclass, JSON primitives in."""
    if isinstance(value, tuple | list):
        return [_plain(entry) for entry in value]
    if hasattr(value, "value"):
        return value.value
    return value


def trace_key_for(path: Path) -> str:
    """``TRC-{scenario-slug}-{hex12}`` from a catalogue filename.

    acc_project already ends every trace filename with the 12 hex characters of its content
    digest, so the key is derived, never invented.
    """
    stem = path.stem
    digest = stem.rsplit("__", 1)[-1] if "__" in stem else sha256_of(path)[:12]
    if not re.fullmatch(r"[0-9a-f]{12}", digest):
        digest = sha256_of(path)[:12]
    slug = TRACE_SLUG_RE.sub("-", stem.rsplit("__", 1)[0].lower())[:32].strip("-")
    return f"TRC-{slug}-{digest}"


def build_traces(acc_project: Path) -> dict[str, Any]:
    """Metadata for every catalogue trace: real digests and sizes, no parsing of contents."""
    data_dir = acc_project / "Data"
    items = []
    for index, path in enumerate(sorted(data_dir.rglob("*.mf4")), start=1):
        items.append(
            {
                "trace_key": trace_key_for(path),
                "run_id": f"TR-{index:04d}",
                "scenario": path.parent.name,
                "source_path": str(path.relative_to(acc_project)).replace("\\", "/"),
                "content_sha256": sha256_of(path),
                "size_bytes": path.stat().st_size,
            }
        )
    return {
        "schema_version": "1.0.0",
        "set": "traces",
        "version": "v0001",
        "item_count": len(items),
        "created_by": "build_vmodel_fixtures.py over acc_project/Data",
        "items": items,
    }


def build_verdicts(acc_project: Path) -> Any:
    """Run acc_project's own CLI over the whole catalogue and capture its JSON output.

    Exit code 1 is expected and is not an error: ``TC-ACC-SYS-PRF-020`` fails on the achieved
    deceleration. That failure is the finding the demo exists to show.
    """
    completed = subprocess.run(
        [sys.executable, "-m", "TestImpl.cli", "--dir", "Data", "--json"],
        cwd=acc_project,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode not in (0, 1):
        raise SystemExit(f"TestImpl.cli failed ({completed.returncode}): {completed.stderr[:2000]}")
    return json.loads(completed.stdout)


def main() -> int:
    """Rebuild every fixture and print the provenance table."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--acc-project", type=Path, default=Path("C:/repos/acc_project"))
    arguments = parser.parse_args()
    acc_project = arguments.acc_project.resolve()

    rows = copy_verbatim(acc_project)

    impls = build_test_impls(acc_project)
    write_json(FIXTURES_DIR / "test_impls" / "acc-test-impls.json", impls)

    traces = build_traces(acc_project)
    write_json(FIXTURES_DIR / "results" / "acc-traces.json", traces)

    verdicts = build_verdicts(acc_project)
    write_json(FIXTURES_DIR / "results" / "acc-verdicts.json", verdicts)

    for target_rel, source_rel, size, digest in rows:
        print(f"copied   {target_rel:<52} {size:>8}  {digest[:16]}  <- {source_rel}")
    print(f"generated test_impls/acc-test-impls.json            {impls['item_count']:>8} items")
    print(f"generated results/acc-traces.json                   {traces['item_count']:>8} items")
    print(f"generated results/acc-verdicts.json                 {len(verdicts):>8} verdicts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
