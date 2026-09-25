# Test report — decode-without-a-database (BL-79)

**Spec:** `dev-planning/decode-without-a-database/spec.md`
**Architecture:** `dev-planning/decode-without-a-database/architecture.md`
**Diff verified:** working tree at HEAD `1dc969f`, uncommitted (`mf4-decoder/idempotency.py`,
`mf4-decoder/main.py`, `mf4-decoder/decodability.py` [new], `tests/test_decodability.py` [new],
`tests/test_marker_contract.py`)

## Gate 1 — Lint

Tool: `.tmp/venv/Scripts/python.exe -m ruff check` / `ruff format --check` (ruff 0.15.12; no
root `.pre-commit-config.yaml` or `Makefile` exists, so this is the third-row fallback per the
verification protocol). Scope: the four changed/added Python files.

`ruff check` on the changed files reports 7 issues (6 in `main.py`, 1 `I001` in
`test_marker_contract.py`); `ruff format --check` reports 3 files needing reformatting.
**All of them are pre-existing.** Verified by running the same commands against `git show
HEAD:mf4-decoder/main.py` and `git show HEAD:tests/test_marker_contract.py` (the pre-diff
content) — identical error set, same rule codes, same (line-shifted) locations: `I001` import
grouping, two `BLE001` blind-`except Exception`, one `RUF059` unused `dropped`, one `S112`
try/except/continue, plus whole-file formatting drift (the file predates `ruff format` adoption).

`mf4-decoder/decodability.py` and `tests/test_decodability.py`: **clean** — 0 check errors, 0
format diffs.

**PASS — 0 new lint violations.**

## Gate 2 — Root suite, py -3.12

```
py -3.12 -m pytest tests/ -q
```
113 collected → **19 failed, 94 passed**. `new=0 pre-existing=19` (exact match to the stated
known-red baseline). The 8 new tests (7 in `test_decodability.py`, 1 —
`test_a_missing_database_quarantines_the_file` — in `test_marker_contract.py`) all pass; none of
the 19 failures are in either file. The 19 pre-existing failures are `test_architecture_law.py`
(7), `test_import_claim.py` (8, BL-31), `test_sink_partitioning.py` (3, one of which is BL-31's
`test_the_declared_tree_is_the_traceability_chain`) — unrelated code paths, untouched by this diff.

**PASS.**

## Gate 3 — `decodability.decode_failure` imports standalone

`py -3.12 -c "sys.path.insert(0,'mf4-decoder'); import decodability"` succeeds. AST-parsed
`decodability.py`: its only import statement is `from __future__ import annotations` — zero
third-party or stdlib deps. **Confirmed as claimed.**

## Gate 4 — the five file shapes (executed, not read off)

Ran a harness (`.tmp/harness_retry.py`, scratch, not committed) that calls the real
`decodability.decode_failure`, `idempotency.mark_decoded`, and `idempotency.needs_decode`
against a fake `State` (dict-backed `get`/`set`, matching `quixstreams.State`'s signature) —
mirroring `main.py`'s exact guard `decode_error is None or total_samples > 0` line for line.

| Case | `decode_error` | `total_samples` | Marked? | `needs_decode` next delivery |
|---|---|---|---|---|
| No CAN frames (ordinary MF4) | `None` | 500 | **Yes** | `False` (unchanged) |
| DBC missing (the incident) | set | 0 | **No** | **`True`** — retryable |
| Decodes fine | `None` | 25312 | **Yes** | `False` |
| `DBC_SOURCE=none` | `None` | 0 | **Yes** | `False` (configuration, not failure) |
| **Mixed file** (bus groups failed, ordinary groups emitted rows) | set | 42 | **Yes** (quarantined AND marked) | `False` — stays marked, no automatic retry |

The mixed-file row is the one the spec calls out as untested elsewhere (§6.3): `decode_error`
is non-`None` (quarantined) but `total_samples > 0` forces `should_mark=True`, so the file is
marked despite being quarantined — exactly the "quarantined and stays marked, human decision"
behaviour architecture.md specifies, verified by execution against the real guard expression,
not inferred from reading it.

Traced (not executed, no Docker) that `decode_error` reaches the registry as a quarantine:
`test_a_missing_database_quarantines_the_file` in `tests/test_marker_contract.py` feeds a marker
carrying `decode_failure(...)`'s output through the connector's real `bodies.file_body` reader and
validates the result against the registry's real `FileRegisterRequest` model — green.

## Gate 5 — retry-is-free claim (no second document/journal/alert)

**Not executed against live Mongo/API** — `api/` and `tm-connector/` are explicitly off-limits
this round ("another build is about to start... stay out of both"), and `api/`'s suite needs
Docker per `pyproject.toml`'s own comment. Confirmed instead by:

1. `git status --porcelain` / `git diff --stat` — **zero bytes changed in `api/` or
   `tm-connector/`** by this diff. The dedup logic this claim rests on
   (`_existing_quarantined(storage_ref, checksum)`, `api/api/routers/files.py:1062-1080`) is
   pre-existing and untouched.
2. `api/tests/test_files_idempotency.py` exists and already covers this path per the file
   inventory; not run here to respect the "stay out of api/" instruction.

This is a traced confirmation, not an executed one — flagged explicitly rather than reported as
verified.

## Gate 6 — `idempotency.py` diff shape

`git diff mf4-decoder/idempotency.py`: 4 insertions / 1 deletion, entirely inside
`mark_decoded`'s docstring (one sentence added: "So is one whose CAN frames could not be decoded
at all (`decodability.decode_failure`)..."). No code, no new import, no changed signature.
**Confirmed exactly as claimed — one docstring sentence.**

## Summary sanity print

- Lint: PASS, 0 new violations (ruff 0.15.12, no pinned pre-commit config at repo root)
- Root suite: PASS, `new=0 pre-existing=19` (113 collected, 94 passed / 19 failed, matches
  stated 19/94 baseline)
- File shapes: ordinary MF4 → marked, unchanged; DBC missing → **quarantined, NOT marked**,
  `needs_decode`→`True`; decodes fine → marked, unchanged; `DBC_SOURCE=none` → marked,
  unchanged; **mixed file → quarantined AND marked** (`needs_decode`→`False`, no auto-retry)
- Replayed-marker result: not executed (Docker/api out of scope this round); traced as
  unaffected — 0 bytes changed in `api/`, dedup keyed on unchanged `_existing_quarantined`
- `needs_decode` after a failed decode: **`True`**, executed and confirmed against the real
  `mark_decoded`/`needs_decode` pair
- `idempotency.py`: confirmed, one docstring sentence, no code change
