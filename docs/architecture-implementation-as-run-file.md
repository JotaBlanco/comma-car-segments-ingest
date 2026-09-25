# The test implementation as a file of the test run — build notes

The design record is `dev-planning/implementation-as-run-file/spec.md`. This file holds
only what the build settled differently, or found to be untrue in the spec. Read the
spec first; read this before trusting §4.3, §4.1 or risk 3.

## What shipped

Starting a definition run copies that definition's implementation into the run's blob
folder and registers it as a file of the run with `role: "evaluator"`:

```
POST /test-runs/{run_id}/definitions/{td_id}/run
  _pair            -> 404 if either half is missing
  ensure_notebook  -> seeds the QuixLab wrapper once
  place_implementation  <- NEW: provider.open(implementation.blob_path)
                                writer.write(<ws>/jama_ui/<run_id>/<digest8>-<name>)
                                register_file_document(role="evaluator")
  quixlab_run.start_run
```

`_input_file_ids` excludes `role: "evaluator"`, so a verdict's
`provenance.input_file_ids` keeps naming the recordings only.

## Deviations and corrections

1. **`ToneBadge tone="accent"` did not exist.** `BadgeTone` was
   `green | amber | red | neutral` (`frontend/components/shared/status-badge.tsx:8`).
   The build added `accent`, mapped to the existing tokens `bg-accent-soft text-primary`
   (dot: `bg-primary`), so no new design token entered `app/globals.css`. Every other
   `BadgeTone` consumer uses it as a value type, so widening the union is safe.

2. **The POST gains no auth surface** (spec risk 3 is void). `main.py:621` already mounts
   every `/api/v1` route behind `Depends(require_token)`. The dependency added to
   `start_definition_run` only *reads* the identity that was already proven, so the
   `file.registered` journal entry names the person instead of `"ingestion"`.

3. **The evaluator row precedes the trace, it does not follow it.** Spec §4.3 says the
   rows are "ordered by arrival, so the evaluator naturally follows the trace".
   `queries_runs.list_run_files` sorts `registered_at` **descending**, so the evaluator —
   registered later — sorts **above** the trace. Only the labels distinguish the rows,
   which is what §4.3 relies on; no ordering was changed to match the prose.

4. **`size_bytes` is the size the provider reports** for the source object, per the spec's
   §4.6 snippet, not the byte count the writer returns.

## The one hazard the spec's §4.7 argument does not cover

§4.7 concludes that after the upload route stops guessing a run, "the two keys can never
be equal, so §4.6's copy never reads and writes the same object". That holds for every
implementation uploaded from now on, and for the ten already stored under `unassigned/`.
It does **not** hold for a pointer stored by the *old* upload route at a moment when a run
already carried the definition: `implementation.blob_path` then already names
`<ws>/jama_ui/<run_id>/<digest8>-<name>`, which is exactly the key `place_implementation`
computes for that run, and the copy streams from the object it is overwriting.

No guard was added — the directives refuse a defensive branch, and the estate's ten
implementations are all under `unassigned/`. Before the first Run click, confirm that no
definition's `implementation.blob_path` contains a run id:

```
GET /api/v1/test-definitions/{td_id}  ->  implementation.blob_path ends in /unassigned/...
```

A definition that fails that check is repaired by re-uploading its implementation, which
now always lands in `unassigned/`.

## Blob layout after the change

```
<ws>/jama_ui/<run_id>/<trace>.mf4                  MF4 Import
<ws>/jama_ui/<run_id>/<digest8>-<name>.py          place_implementation, one per (run, bytes)
<ws>/jama_ui/unassigned/<digest8>-<name>.py        upload_implementation, always
<ws>/jama_ui/definitions/<td_id>/notebook.py       ensure_notebook, untouched
```

## Files changed

| File | Why |
|---|---|
| `api/api/models/files.py` | `FileRole`; `role` on `FileBody` and `FileRegisterRequest`; the `"api"` source comment widened |
| `api/api/routers/files.py` | `register_file_document` stores `role`; the `_EMBEDDED_FIELDS` exclusion comment names it |
| `api/api/services/definition_runs.py` | `place_implementation`; `_input_file_ids` excludes evaluators |
| `api/api/routers/definition_runs.py` | calls `place_implementation`; reads the identity for the journal |
| `api/api/routers/test_definitions.py` | the upload stops guessing a run |
| `api/api/services/queries_runs.py` | `latest_run_id_for_definition` deleted (no caller) |
| `api/api/services/file_writes.py` | `implementation_blob_key` docstring: two callers, one convention each |
| `frontend/components/shared/status-badge.tsx` | the `accent` tone |
| `frontend/components/screens/run-detail/files-tab.tsx` | the **Evaluator** badge; `api: "Test Manager"` |
| `frontend/types/file.ts`, `frontend/lib/mock/{db,seed}.ts` | `FileRole` on the wire and in mock mode |
