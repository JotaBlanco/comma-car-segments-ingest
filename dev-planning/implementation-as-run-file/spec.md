# The test implementation as a file of the test run

**Status:** Draft
**Project:** comma-car-segments-ingest
**Branch / HEAD:** `jama-ui-dev` @ `da46817`
**Created:** 2026-09-25
**Planned with:** Buddy

The user's sentence, verbatim:

> *"there should be \*.py added to blob storage to taht test and listed in files tab"*

and, when the blob layout was designed:

> *"create environmental varaible, where test run mf4 and test implemetation .py must be stored
> together, so we need to store as jama_ui -> test_run_id -> .mf4 and .py"*

---

## 1. Summary

The layout the user asked for is half-built. `BLOB_ROOT=jama_ui` is honoured by both writers, the
trace lands in `jama_ui/<run_id>/`, and `implementation_blob_key`
(`api/api/services/file_writes.py:144-166`) already builds `<root>/<run>/<digest8>-<name>` — but
the only caller of it is a **per-definition** upload route that has no run in scope, so all ten
implementations sit in `jama_ui/unassigned/`:

```
trace           <ws>/jama_ui/TAS-1001/TAS-1001_T1_charge_thermal-68feef50.mf4   ← right place
implementation  <ws>/jama_ui/unassigned/d270183e-BAT-SYS-TC-001.py             ← not beside it
```

This spec moves the placement to the one moment a `(run, definition)` pair exists — the **Run**
button — and registers the placed object as a file of that run, so the Files tab lists the
evaluator beside the recording it judged. It adds **one** stored field (`role`), changes **one**
query (`_input_file_ids`), and deliberately writes **no** version field, because
`dev-planning/versions-and-links/spec.md` §3.1 already puts the chain rule where it will pick
these rows up for free.

---

## 2. Goals

- The `.py` that evaluated a run is a blob object under `<root>/<run_id>/`, beside that run's MF4.
- It is a row in the run's **Files** tab, visibly distinct from the recording.
- A verdict's `provenance.input_file_ids` keeps meaning *what the evaluation read* — traces only.
- A re-run with unchanged bytes adds no object and no row; a re-run with changed bytes is
  distinguishable and survives BL-69's chain rule unchanged.
- No new blob key builder, no new registration path, no new download route.

## 3. Non-goals

- The lake, the sink, `mf4-decoder`, `mf4-to-blob` and `tm-connector` are untouched.
- `quixlab_run.build_run_spec`'s cloning strategy is untouched (Daniel's merged design).
- No retroactive sweep of the ten objects already under `unassigned/`.
- No requirement, review, link or coverage work.
- No `role` filter on `GET /files` (§10 OQ3).

---

## 4. Decisions

### 4.1 When the copy happens — **at run start**

**Chosen: in `POST /test-runs/{run_id}/definitions/{td_id}/run`
(`api/api/routers/definition_runs.py:76-109`), after `ensure_notebook` and before
`quixlab_run.start_run`.**

Three reasons, in order of weight:

1. **It is the only moment the pair exists.** The route takes `run_id` and `td_id` in its path and
   runs exactly one pair per call. Everywhere else the pair has to be guessed — and the guess is
   already in the tree and already wrong: `upload_implementation` calls
   `queries_runs.latest_run_id_for_definition` (`api/api/routers/test_definitions.py:917`,
   `api/api/services/queries_runs.py:1623-1637`) and got `unassigned` for all ten, because at
   upload time no run carried any definition yet.
2. **The stored object then *is* evidence of what was dispatched.** A file in `TAS-1001/` states
   "these bytes were sent to judge this run", which is exactly the claim a person reading the run
   a year later wants. Placing it earlier states an intention; placing it later states a survivor.
3. **The route already holds both halves of the copy.** `provider: FileBytesProvider` and
   `writer: FileBytesWriter` are injected at lines 82-83 for `ensure_notebook`. No new dependency,
   and the store's refusal already maps to `503 storage_unreachable` at that exact point
   (`:99-101`), so the failure mode is one that already exists rather than a new one.

**Not on definition-assignment** (`POST /test-runs/{id}/definitions`, BL-47): assignment is
reversible from the UI picker, and filing evidence for a pairing that may be removed before
anything ran puts a `.py` in a run folder that never evaluated it.

**Not on upload with a later move**: moving bytes invalidates `implementation.blob_path`, which is
the pointer `run_params` hands the Job (`api/api/services/definition_runs.py:73-82`) and the
pointer a stored verdict resolves through. Content-addressed objects are cheap; moving them is not.

**A definition that is never run** keeps its implementation where the upload put it — under
`unassigned/` — and no run folder mentions it. That is correct: nothing evaluated anything, so
there is no evidence to file. The definition detail's implementation panel
(`frontend/components/screens/definitions/implementation-panel.tsx:104-108`) shows that path and
keeps showing it; see §4.7.

**A Job that fails to start** leaves the copy in place, because the copy happens first. That is
deliberate — 503 from `start_run` means the Portal refused, not that the evaluator was wrong, and
the next click writes the same content-addressed object at the same key.

### 4.2 Where and under what name — **the existing key builder, digest in the name**

**Chosen: `implementation_blob_key(run_id, filename, digest)`, unchanged
(`api/api/services/file_writes.py:144-166`).**

```
<workspace>/<blob_root()>/<run_id>/<digest8>-<filename>
<ws>/jama_ui/TAS-1001/d270183e-BAT-SYS-TC-001.py
```

Two collisions the name must survive, and the digest is what answers the second:

| Case | What keeps them apart |
|---|---|
| **One run, ten definitions** | `filename`. The seed names each module after its definition (`BAT-SYS-TC-001.py` … `BAT-SYS-TC-010.py`), so ten evaluators in one folder are ten distinct names with no digest needed. |
| **One definition, re-run after its implementation changed** | `digest8`. Without it the second run **overwrites the bytes the first verdict cites**: `record_verdict` stores `provenance.tool_version = "sha256:<12 hex>"` (`services/definition_runs.py:158`) and the v1 file document's `storage_ref` points at that key. The digest makes the object content-addressed, so both rounds' bytes survive and each verdict resolves to the bytes it actually read. |

**The digest never reaches `filename`.** The file document stores `implementation.filename`
(`BAT-SYS-TC-001.py`); only the blob object carries the prefix. This is the same split
`mf4-to-blob` already makes — a uuid suffix on the object, the original name on the wire — and it
is the property BL-69 §1.2 point 2 relies on to key a version chain on `(run_id, filename)`.

**Re-running with unchanged bytes writes the same key with the same content.** No branch, no
existence check: an idempotent overwrite of identical bytes is the cheapest correct behaviour and
the directives refuse the pre-flight check that would avoid it.

### 4.3 How the tab tells the evaluator from the recording — **a new `role` field, rendered as a label**

**Chosen: `role: Literal["recording", "evaluator"]`, default `"recording"`, on
`FileRegisterRequest` and `FileBody` (`api/api/models/files.py`).**

There is no `kind` and no `content_type` on the file model — the brief's guess; what exists is
`format` (free text: `"MDF 4.10"`, `"MF4"`) and `source_system` (a closed enum). Neither carries
this fact:

- `format` says what the bytes are, not what part they play. `PY` would work as a display hint and
  fail as a query predicate the moment a `.py` recording or a `.json` evaluator exists.
- `source_system` says who produced the bytes. §4.4's boundary must not rest on it: a file minted
  by `POST /test-runs/{id}/signals` is API-produced and is still a recording.

`role` is a genuinely new meaning, and it is the field §4.4 filters on. Values, closed:

| Value | Means |
|---|---|
| `recording` | the bytes the bench produced, or a sample set submitted as one. The default, so **every existing producer body and every stored document is unchanged** — Mongo's `$ne` matches a missing field, so the four registered traces need no backfill. |
| `evaluator` | the module that judged the run. Written by §4.6 and by nothing else. |

**`source_system` is `"api"`, and its definition widens by one comment.** Today the comment reads
*"'api' marks a logical file minted by `POST /test-runs/{run_id}/signals`"*
(`api/api/models/files.py:13-15`, mirrored at `frontend/types/file.ts:33-35`). It becomes *"a file
this API minted, rather than one a rig produced"* — which covers the signals facade and the
evaluator copy with one sentence. Adding a `"TM"` enum value instead would mean editing the
Literal, `frontend/types/file.ts`, `frontend/lib/mock/db.ts` and
`api/api/services/assistant_links.py:40`'s chip set for a distinction `role` already carries.

**The tab labels; it does not group.** Grouping splits a two-row table into two headed sections and
lies across page boundaries (the tab is paged, `files-tab.tsx:40-45`). The rows are already
ordered by arrival, so the evaluator naturally follows the trace it judged. Two small edits to
`frontend/components/screens/run-detail/files-tab.tsx`:

- the `Source` cell renders a second `ToneBadge tone="accent"` reading **Evaluator** when
  `file.role === "evaluator"`. A recording renders exactly what it renders today — no new column,
  no column-hiding config, no layout churn;
- `sourceLabel` (`:24-28`) gains `api: "Test Manager"`, so the sub-line under the filename reads
  `PY · Test Manager` instead of `PY · api`. That also fixes the signals-facade file, which prints
  the bare word today.

The tab refetches every ten seconds (`frontend/lib/hooks/use-runs.ts:78`), so the `.py` appears
while the Job is still running, with no reload and no new control.

### 4.4 The `input_file_ids` boundary — **one clause on the existing query**

`provenance.input_file_ids` means *what the evaluation read*. The implementation is the **tool**,
and its identity already rides as `provenance.tool = td_id` and
`provenance.tool_version = "sha256:<12 hex>"` (`services/definition_runs.py:156-158`). Today
`_input_file_ids` takes every registered file of the run (`:114-116`), so registering the evaluator
would make **every verdict claim it read its own evaluator** — and would quietly break BL-69 §6.2's
argument that `input_file_ids` pins the evidence to the exact trace version.

**Chosen: the filter goes on `_input_file_ids`, not on `role`'s meaning.**

```python
def _input_file_ids(db: Database, run_id: str) -> list[str]:
    # The evaluator is the tool, not an input; its digest rides as `tool_version`.
    rows = db["files"].find(
        {"run_id": run_id, "status": "registered", "role": {"$ne": "evaluator"}}, {"_id": 1}
    )
    return sorted(str(row["_id"]) for row in rows)
```

One clause, no branch, no migration — `$ne` matches documents that carry no `role` key, which is
every file registered before this change.

It does **not** fall out naturally from the new field, and it must not be left to fall out from
`source_system` or `format`: a future evaluator posted by a rig would be `TAS`, and a future
`.py`-shaped recording would be `PY`. The predicate names the fact it means.

### 4.5 Re-runs and versions — **the writer sets none of the three**

**Chosen: `place_implementation` calls `register_file_document` plainly. It passes no `version`,
no `supersedes`, no `version_group`, and it never calls `POST /files/{id}/versions`.**

| Case | What happens today | Why that is right |
|---|---|---|
| Re-run, **unchanged** bytes | `_existing_registered(db, checksum, run_id)` (`routers/files.py:1227-1233`) replays and returns the stored document. No second row, no journal entry, no rollup. | The folder is not littered and the tab does not grow, which is the ask. The blob write before it is an idempotent overwrite of identical bytes (§4.2). |
| Re-run, **changed** bytes | A new file document: its own id, its own checksum, its own `storage_ref`, `version: 1`, no `version_group`. Two rows share the filename and nothing says one replaced the other. | Both verdicts resolve to the bytes they read. The chain is BL-69's job, not this spec's. |

**BL-69 §3.1 makes the second case a chain for free, and that is why nothing is invented here.**
Its rule keys the same logical file on `(run_id, filename)` and forms the chain **inside**
`register_file_document`, after the replay lookup — so the moment it lands, a second
`BAT-SYS-TC-003.py` on `TAS-1001` becomes `v2` with `supersedes` and `version_group` set by the
registry, and this feature's writer changes by zero lines. The filename is stable per definition
and the digest rides on the object only (§4.2), which is exactly the *stable label over distinct
bytes* BL-69 §1.2 requires.

`POST /files/{file_id}/versions` is deliberately not used: it requires `actor` and writes a
`file.version_registered` entry tagged `Source.MANUAL` because *"a person uploaded it"*
(`routers/files.py:867-882`) — a machine write down that route puts a false claim in the audit
trail, which is BL-69 §3.2 reason 3, and it applies here identically.

### 4.6 Who writes it — **the API, at run start**

**Chosen: a new `place_implementation` in `api/api/services/definition_runs.py`, called by
`start_definition_run`.** It lives beside `ensure_notebook`, which is the same shape of act (read
the store, write the store, log one line) and the same caller.

```python
def place_implementation(db, provider, writer, *, run, definition, actor) -> dict:
    """Copy the definition's implementation into the run's folder and register it.

    Raises `FileBytesUnavailable` when the store refuses either half.
    """
    implementation = definition["implementation"]
    key = implementation_blob_key(run["_id"], implementation["filename"], implementation["sha256"])
    chunks, size = provider.open(implementation["blob_path"])
    writer.write(key, chunks)
    doc, _created = register_file_document(
        db,
        FileRegisterRequest.model_validate(
            {
                "filename": implementation["filename"],
                "run_id": run["_id"],
                "source_system": "api",
                "role": "evaluator",
                "format": "PY",
                "size_bytes": size,
                "checksum_sha256": implementation["sha256"],
                "storage_ref": f"blob://{key}",
            }
        ),
        actor=actor,
    )
    return doc
```

Called between `ensure_notebook` and `start_run`, inside the same `except FileBytesUnavailable`
shape the route already has (`routers/definition_runs.py:97-101`).

**Why not the Job.** It runs as the user with their portal token and holds the bytes, which is the
case for it — and against it: it would need the Test Manager's base URL and a credential inside
`QUIXLAB_PARAMS`, which is documented as *"Never a secret: they are logged"*
(`services/definition_runs.py:74`). It would also need an HTTP client in
`api/api/resources/verdict_notebook.py`, and its failure would be a line in a Job log nobody reads.
A registration whose only failure surface is a deleted Job's stdout is not a registration.

**Why not the polling GET.** It writes `processed_results` already, so it is the natural-looking
home — and it is the wrong one for three reasons: it injects neither `FileBytesWriter` nor
`FileBytesProvider` (two new dependencies, against one for the POST: none); it fires **only if
someone polls**, so a person who starts a run and navigates away gets a verdict on the next visit
and would have got no file; and it fires *repeatedly*, so it would need its own dedup on top of
`record_verdict`'s Job-id dedup (`:139-144`). "The file appears when the run starts" is also what a
person expects from a Files tab that refreshes every ten seconds.

**The POST gains `identity: Annotated[Identity, Depends(require_token)]`**, the dependency its
sibling GET already declares (`routers/definition_runs.py:128`), so the `file.registered` journal
entry names the person who pressed Run through `journal_actor_or_id(identity, "test-manager")`
rather than the default `"ingestion"`. Every caller that polls already sends that token.

### 4.7 The ten files under `unassigned/` — **left where they are, and no new guess is made**

**Chosen: leave them, and delete the run guess from the upload route so every future upload lands
in `unassigned/` too.**

- **Leaving them** costs nothing and breaks nothing: `implementation.blob_path` is the pointer every
  read follows (`run_params`, the download route, the panel), and it still resolves. Moving them
  would invalidate that pointer for no gain, since §4.1 places a run-scoped copy on the first run
  anyway.
- **Deleting the guess** is a removal, not an addition: `upload_implementation` passes
  `queries_runs.latest_run_id_for_definition(db, td_id)` (`routers/test_definitions.py:917`) and
  gets a folder whose correctness depends on when the person happened to upload. Passing `None`
  makes the upload copy unconditionally definition-scoped and the run copy unconditionally
  run-scoped — one convention each, and the two keys can never be equal, so §4.6's copy never reads
  and writes the same object.
  `latest_run_id_for_definition` then has **no caller and is deleted with its docstring**;
  `implementation_blob_key` keeps both parameters and both callers (upload → `None` → `unassigned`,
  run start → the run id) and its docstring paragraph about *"the newest run carrying it"* is
  rewritten in the same edit.

**What a person sees in the implementation panel:** the same `Blob path` row, now always reading
`blob://<ws>/jama_ui/unassigned/<digest8>-<name>.py`. That is honest — it is the definition's own
copy, filed under no run, because a definition is not a run. The run-scoped copies are on each run's
Files tab, which is the surface the user named. No change to
`frontend/components/screens/definitions/implementation-panel.tsx`.

---

## 5. Data & interface contracts

### 5.1 The one new field

```python
# api/api/models/files.py
# What part this file plays in its run. A recording is what the bench produced;
# an evaluator is the module that judged it. A stored document carries no key
# and reads as a recording, so `$ne: "evaluator"` selects the inputs of a run.
FileRole = Literal["recording", "evaluator"]
```

- `FileBody.role: FileRole = "recording"` — on the wire for every file surface.
- `FileRegisterRequest.role: FileRole = "recording"` — so `POST /files` is unchanged for every
  existing producer.
- Stored by `register_file_document` as one more key in `doc` (`routers/files.py:1252-1278`).
  **Not** added to `_EMBEDDED_FIELDS` (`:200-210`): the role is the API's statement about the file,
  not a fact read out of the bytes, so it takes no `field_sources` entry.
- `frontend/types/file.ts`: `role?: FileRole` on `FileEntity`, optional for the same reason
  `version` is.

No index. Every query that uses it already carries `run_id`, which is indexed
(`api/api/db.py:91-125`).

### 5.2 The registered evaluator document

```jsonc
{
  "_id": "f-3f0c…",
  "filename": "BAT-SYS-TC-001.py",
  "run_id": "TAS-1001",
  "source_system": "api",
  "role": "evaluator",
  "format": "PY",
  "size_bytes": 2184,
  "checksum_sha256": "d270183e…",      // implementation.sha256, verbatim
  "checksum_state": "unverified",      // nobody compared two digests on this path
  "status": "registered",
  "storage_ref": "blob://<ws>/jama_ui/TAS-1001/d270183e-BAT-SYS-TC-001.py",
  "signal_count": 0,
  "time_start": null, "time_end": null,
  "version": 1
}
```

Three consequences of the shape, each following from code that already exists:

- **`checksum_state: "unverified"` is the honest value.** `_derived_stages`
  (`routers/files.py:1132-1180`) then leaves `sync_status` absent, sets `upload_status: "success"`
  from the `storage_ref`, and leaves `conversion_status` absent from the empty signal list. Claiming
  `"verified"` would require comparing the copied bytes' digest against the pointer's and diverting
  on a mismatch — a validation layer the standing directives refuse.
- **The run's `file_count` grows.** `apply_file_rollup` → `run_facts` derives it from stored
  documents (`services/queries_runs.py:1383-1428`), so `TAS-1001` with one trace and three
  evaluators reads `file_count: 4`. Accepted, and consistent with BL-69 OQ6's answer for versions:
  the number counts what the run holds, and the tab explains it. §10 OQ2.
- **The run's time window is untouched.** `_file_window` unions the files' `time_start`/`time_end`,
  and the evaluator states neither.

### 5.3 Routes

None added, none changed on the wire. `POST /test-runs/{run_id}/definitions/{td_id}/run` keeps its
202 and its `DefinitionRunJob` body; it gains one dependency (§4.6) and one side effect.

---

## 6. Work breakdown

| # | What | Files | Owner | Depends on |
|---|---|---|---|---|
| 1 | `FileRole`, `role` on `FileBody` + `FileRegisterRequest`, stored in `register_file_document`; widen the `"api"` comment | `api/api/models/files.py:13-15, 66-111, 165-190`, `api/api/routers/files.py:1252-1278` | ArchDev | — |
| 2 | `_input_file_ids` excludes evaluators | `api/api/services/definition_runs.py:114-116` | ArchDev | 1 |
| 3 | `place_implementation`, called from the run route; `require_token` on the POST | `api/api/services/definition_runs.py`, `api/api/routers/definition_runs.py:76-109` | ArchDev | 1 |
| 4 | Drop the run guess from the upload; delete `latest_run_id_for_definition`; rewrite the two docstring paragraphs | `api/api/routers/test_definitions.py:876-922`, `api/api/services/queries_runs.py:1623-1637`, `api/api/services/file_writes.py:144-166` | ArchDev | 3 |
| 5 | The **Evaluator** badge and the `api: "Test Manager"` label | `frontend/components/screens/run-detail/files-tab.tsx:24-28, 106-108`, `frontend/types/file.ts:33-35, 37-71` | FrontEndEsthetic | 1 |
| 6 | Mirror `role` in the mock backend so mock mode matches | `frontend/lib/mock/db.ts:633, 982, 1588-1600`, `frontend/lib/mock/seed.ts:82` | FrontEndEsthetic | 1 |
| 7 | Tests: the evaluator registers once per (run, digest); a second run with unchanged bytes writes no second document; `input_file_ids` names the trace only; a definition never run places nothing | `api/tests/test_definition_runs*.py` | Tester | 3 |
| 8 | Regenerate `api/docs/openapi.v1.json` (`api/scripts/snapshot.sh`) | — | ArchDev | 1 |
| 9 | Backlog row + `CLAUDE.md` regeneration (`battery-trace-gen/tools/gen_claude_md.py`) | `dev-planning/backlog.json` | DocuGuy | 3 |

Items 1, 5 and 6 are disjoint from 2–4 after 1 lands; 5 and 6 can run in parallel with 2–4.

**BL-25 is already red** on the contract-snapshot test; item 8 rides that regeneration rather than
adding a second one.

---

## 7. What the blob tree looks like afterwards

`TAS-1001`, its three definitions run **twice**, with `BAT-SYS-TC-003.py` edited between the rounds:

```
<ws>/jama_ui/TAS-1001/
    TAS-1001_T1_charge_thermal-68feef50.mf4     the trace                 (round 0)
    d270183e-BAT-SYS-TC-001.py                  unchanged                 (rounds 1+2, one object)
    5b1c77a4-BAT-SYS-TC-002.py                  unchanged                 (rounds 1+2, one object)
    9af0e21b-BAT-SYS-TC-003.py                  round 1
    c4d8830f-BAT-SYS-TC-003.py                  round 2, edited
<ws>/jama_ui/unassigned/
    d270183e-BAT-SYS-TC-001.py … ×10            the upload copies, untouched
<ws>/jama_ui/definitions/BAT-SYS-TC-001/notebook.py … ×10   the QuixLab wrappers, untouched
```

Files tab for `TAS-1001` — **five rows**, `file_count: 5`:

| Filename | Role | Format · Source | Signals |
|---|---|---|---|
| `TAS-1001_T1_charge_thermal.mf4` | *(none)* | MDF 4.10 · TAS acquisition | 249 |
| `BAT-SYS-TC-001.py` | **Evaluator** | PY · Test Manager | 0 |
| `BAT-SYS-TC-002.py` | **Evaluator** | PY · Test Manager | 0 |
| `BAT-SYS-TC-003.py` | **Evaluator** | PY · Test Manager | 0 |
| `BAT-SYS-TC-003.py` | **Evaluator** | PY · Test Manager | 0 |

Four verdicts' `provenance.input_file_ids` all read `["f-<the trace>"]` — one id, never five.
After BL-69 §3.1 lands, the two `BAT-SYS-TC-003.py` rows read `v1` and `v2` of one chain and the
table becomes four logical files in five rows.

---

## 8. Risks and constraints

1. **Two definitions with byte-identical implementations on one run collide.** The registry's
   identity is `(run_id, checksum_sha256)` (`api/api/db.py:91-95`), so the second registration
   replays and returns the *first* definition's document — one blob object, one row, under the
   first definition's filename. All ten battery implementations differ, so this does not bite
   today. **Accepted, not guarded**: a filename-qualified checksum would be a second identity for
   files, which BL-69 §1.2 explicitly refuses. §10 OQ1.
2. **`file_count` grows by one per distinct evaluator.** §5.2. Visible on the run list and the run
   header.
3. **The POST route gains `require_token`.** Consistent with its sibling GET and with every other
   write route; a caller that polls already sends it. Worth one line in the Tester brief because it
   is an auth-surface change, not a behaviour change.
4. **The six run-detail tests that mock `@/lib/hooks` wholesale (BL-48) are already red** and this
   change does not touch `useRunFiles`; item 7's tests must not be folded into those files.
5. **`FORCE_REDECODE` is back to `false` at `da46817`** — no trace re-ingest is implied by any of
   this, and none should be triggered to test it.

---

## 9. Alternatives considered

| Alternative | Why not |
|---|---|
| Register the file **pointing at the existing `unassigned/` object**, no copy | The user asked for the bytes *"stored together"* under `<root>/<run_id>/`. A row whose `storage_ref` leaves the run folder answers the tab half of the ask and not the blob half. |
| Move the ten objects into run folders retroactively | Invalidates `implementation.blob_path` on ten definitions for artefacts that the first Run button places anyway. |
| Rename `unassigned/` to `definitions/<td_id>/` for upload copies | Tidier, and it puts two conventions in the tree at once (the ten existing objects would stay under `unassigned/`), for a folder nobody browses. |
| `format: "PY"` alone as the discriminator | Free text, and it says what the bytes are, not what part they play. §4.3. |
| A `"TM"` `source_system` value | Four files' enums for a distinction `role` already carries. §4.3. |
| Call `POST /files/{id}/versions` from the writer | Writes a `Source.MANUAL` journal entry claiming a person uploaded it. §4.5. |
| Write the file from the QuixLab Job | Needs a credential in `QUIXLAB_PARAMS`, which is logged; its failure is invisible. §4.6. |
| Write the file from the polling GET | Two new dependencies, only fires if someone polls, needs its own dedup. §4.6. |

---

## 10. Open questions

**OQ1 — two definitions sharing byte-identical implementations on one run produce one row, under
the first one's filename. Accept?**
*Recommended: accept.* It cannot happen in the battery set, the alternative is a second file
identity, and the recovery (edit one module) is ordinary. Raising it because the surprise, if it
ever lands, is silent: the second run's verdict is written normally and only the tab under-reports.

**OQ2 — should the `.py` count in the run's `file_count`?**
*Recommended: yes, unchanged.* The run holds the document, `run_facts` counts documents, and the
Role label in the same table explains the number. Changing it means teaching the rollup about roles
for a cosmetic count.

**OQ3 — should `GET /files` and the Files tab gain a `role` filter?**
*Recommended: not now.* A run holds one trace and a handful of evaluators; a filter over five rows
is a control nobody presses. The field exists, so the filter is one enum entry the day the global
`/files` table grows past a screen.

**OQ4 — should the QuixLab wrapper notebook also be filed under the run?**
*Recommended: no.* `definitions/<td_id>/notebook.py` is per-definition, identical across runs, and
QuixLab owns that folder as the Job's project root — it writes its manifest, runs and node records
beside the file (`services/file_writes.py:174-185`). The user asked for the *test implementation*,
which is the module the wrapper loads. Say so if the intent was "everything that executed".

---

## 11. References

- `api/api/routers/definition_runs.py:39, 76-109, 122-164` — the run route, the viewer token, the
  polling GET.
- `api/api/services/definition_runs.py:47-65` (`ensure_notebook`), `:73-82` (`run_params`),
  `:114-116` (`_input_file_ids`), `:124-183` (`record_verdict`, `tool`, `tool_version`).
- `api/api/services/file_writes.py:41-60` (`BLOB_ROOT`, `UNASSIGNED_RUN`), `:144-166`
  (`implementation_blob_key`), `:174-185` (`definition_notebook_key`).
- `api/api/services/file_bytes.py:186-243` — `blob_key`, `BlobFileBytes.open`.
- `api/api/routers/files.py:1090-1124` (`POST /files`), `:1132-1180` (`_derived_stages`),
  `:1192-1339` (`register_file_document`), `:718-756, 759-884` (the version chain).
- `api/api/models/files.py:13-15, 66-111, 165-190` — `SourceSystem`, `FileBody`,
  `FileRegisterRequest`.
- `api/api/routers/test_definitions.py:866-970` — `upload_implementation`;
  `api/api/services/queries_runs.py:1623-1637` — the run guess this spec deletes;
  `:1383-1428` — `apply_file_rollup`.
- `frontend/components/screens/run-detail/files-tab.tsx`, `frontend/types/file.ts:20-81`,
  `frontend/lib/hooks/use-runs.ts:74-83`,
  `frontend/components/screens/definitions/implementation-panel.tsx:101-109`.
- `dev-planning/versions-and-links/spec.md` §1.2, §3.1, §3.2, §6.2, OQ6 — the `(run_id, filename)`
  identity, the chain rule inside `register_file_document`, and why `input_file_ids` is the only
  place the evidence version needs to live. **This spec sets no version field precisely because
  that one does.**
- `dev-planning/run-a-definition/spec.md` §5.1-§5.2 — the verdict body and
  `provenance.input_file_ids`.
- `CLAUDE.md` § "Ingestion pipeline", § "Seeding the Test Manager", backlog **BL-11**, **BL-25**,
  **BL-48**, **BL-68**, **BL-69**.
