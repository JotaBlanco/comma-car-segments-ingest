# Multi-definition test runs, and the QuixLab test implementation

**Status:** Draft
**Project:** comma-car-segments-ingest
**Branch / HEAD:** `jama-ui-dev` @ `e4f172a`
**Created:** 2026-09-22
**Planned with:** Buddy

---

## 1. Summary

One uploaded MF4 trace is one test run. Today a run carries **one** test definition
(`test_runs.definition_id`, singular, everywhere). The battery set has ten
requirements, ten test cases and four traces, so a trace must fulfil two or three
definitions at once — which is also what a real validation bench does: an operator
runs one profile and ticks off several test cases from it.

This spec makes a run carry a **set** of definitions, seeds one work order and ten
definitions into the jamaui Test Manager through `POST /planning/sync`, and adds the
third artefact of the traceability chain: one executable **test implementation**
(`.py`) per definition, stored in blob and opened from the definition screen in
QuixLab.

The chain this produces, end to end:

```
requirement (10)  ->  test case = test definition (10)  ->  implementation .py (10)
                                        |
                                        +--> run = trace (4)  ->  verdict (10: 6 PASS / 4 FAIL)
```

---

## 2. Goals

- A run holds **0..N** test definitions. Ten definitions are exercised by four runs.
- The definition detail screen lists every run that carries it; the run lists every
  definition it fulfils.
- Repeated `links` in one planning push for the same `run_id` are **additive**, and a
  re-post of the same links writes nothing (`links_unchanged`).
- A trace states its own chain in its MF4 header (`test.run_key`, `test.work_order`,
  `test.definitions`), so the evidence file is self-describing.
- The lake stops pretending a run has one definition: `test_definition` leaves the
  partition tree.
- One work order + ten definitions + ten links are seeded from
  `battery-trace-gen/` with a PAT, reproducibly.
- Each definition points at one `.py` implementation in blob, by path **and by
  sha256**, so a verdict can name the exact bytes that produced it.
- Every existing frontend screen and every existing response field keeps working
  without a frontend change.

## 3. Non-goals

- Redesigning Tomas's registry, the provenance precedence, or the planning mirror.
- An evaluator service that *runs* the implementations and writes verdicts. This
  spec produces the implementations and the pointers; running them is the next
  feature.
- Removing a definition from a run through a planning push (see §10, OQ2).
- Any `join_lookup` in FastAPI code. The sink's existing `QuixConfigurationService`
  join (`mf4-datalake-sink/main.py:327-342`) is untouched and still works — see §6.8.
- A second push of the work order into Dynamic Configuration. `api/api/config_push.py`
  already does it off the mirror write (§6.8).
- Migrating the legacy `mf4_signals_v5` rows. Those four traces were decoded before
  the terminal marker existed and will never register; they are replaced, not moved.

---

## 4. Background — every place the model is singular today

Read this section before touching anything. Each line is a place that assumes one
definition per run.

### 4a. Registry — models

| File:line | What is singular |
|---|---|
| `api/api/models/runs.py:108` | `RunListItem.definition_id: str \| None` |
| `api/api/models/runs.py:133` | `RunListItem.claimed_definition_id` (the unresolved claim memory) |
| `api/api/models/runs.py:194` | `RunDetail` extends `RunListItem`, so it inherits both |
| `api/api/models/runs.py:227` | `RunPatchRequest.definition_id` — the hand-repair field |
| `api/api/models/runs.py:324` | `RunUpsertRequest.definition_id` — the ingestion CLAIM |
| `api/api/models/runs.py:409` | `RecentRun.definition_id` (Home summary) |
| `api/api/models/runs.py:487` | `LineageResponse.definition: LineageDefinition \| None` |
| `api/api/models/planning.py:86` | `WorkOrderRun.definition_id` — the row shape both detail screens use |
| `api/api/models/planning.py:172` | `TestDefinitionDetail.runs: list[WorkOrderRun]` — "the runs that carry it" |
| `api/api/models/planning.py:323` | `PushedLink.definition_id: str \| None` |

Vocabularies, unchanged by this spec: `WorkOrderStatus = active | closed`
(`planning.py:10`), `DefinitionStatus = on_plan | awaiting_data` (`:11`),
`RunStatus = complete | awaiting_work_order | invalid` (`runs.py:19`).
`WorkOrderRow` (`planning.py:14`) carries `wo_id, title, project, status,
definition_count, run_count, synced_at`.

### 4b. Registry — services and writes

| File:line | What is singular |
|---|---|
| `api/api/planning_sync.py:45` | `PLANNING_FIELDS = ("work_order_id", "definition_id", "project")` |
| `api/api/planning_sync.py:427-477` | `_write_link(db, run, work_order_id, definition_id, project, note)` — **the one write path for a planning link**. Skips a field whose stored value already equals the incoming one (`:454`), then `update["status"] = derive_status(...)` (`:472`). |
| `api/api/planning_sync.py:501` | `_backfill_runs` calls `_write_link` with `definition["id"]` |
| `api/api/planning_sync.py:552-575` | `_resolve_retained_claim` reads `claimed_definition_id`, one id |
| `api/api/planning_sync.py:612-638` | the push's link loop — one `definition_id` per link, **last-wins** if two links name one run |
| `api/api/planning_sync.py:708-742` | `demo_reset` reverts each `PLANNING_FIELDS` entry to `None` |
| `api/api/planning_sync.py:315-361` | `_mirror_work_orders` — every NEW or CHANGED work order goes to Dynamic Configuration (§6.8). Untouched by this spec. |
| `api/api/services/queries_runs.py:61` | `_FIELD_LABELS = {..., "definition_id": "run.definition"}` |
| `api/api/services/queries_runs.py:76` | `_CLAIM_MIRRORS = {..., "definition_id": "test_definitions"}` |
| `api/api/services/queries_runs.py:95-98` | `CLAIM_RETAINED = {..., "definition_id": "claimed_definition_id"}` |
| `api/api/services/queries_runs.py:101-124` | `_resolve_claims` — `getattr(body, field)`, one value per field |
| `api/api/services/queries_runs.py:231` | `_insert_run` seeds `"definition_id": None` in the new doc |
| `api/api/services/queries_runs.py:497` | `list_runs` filter: `{"definition_id": definition}` |
| `api/api/services/queries_runs.py:511` | free-text search reads `definition_id` |
| `api/api/services/queries_runs.py:762-769` | `run_lineage` resolves one definition |
| `api/api/services/queries_runs.py:1115` | `_LINK_ERRORS["definition_id"]` — the manual-PATCH check |
| `api/api/services/queries_runs.py:1391` | `list_test_definitions`: `_count_by(db, "test_runs", "definition_id", …)` |
| `api/api/services/queries_runs.py:1426` | `get_test_definition_detail`: `find({"definition_id": td_id})` |
| `api/api/services/queries_runs.py:1572-1574` | `get_work_order_detail` counts `actual_runs` off `run["definition_id"]` |
| `api/api/db.py:39, :46` | two indexes on `definition_id` |

**`derive_status` (`api/api/provenance.py:289-295`) reads `work_order_id` only.**
Rule: `invalid > awaiting_work_order > complete`. The **work order** is the claim that
completes a run; the **definition** is never consulted. So definitions can be many
without touching the status, and **nothing in `derive_status` changes**:

| Work order | Definitions | `invalid.flagged` | Status |
|---|---|---|---|
| set | 0 | false | `complete` |
| set | ≥1 | false | `complete` |
| null | 0 or ≥1 | false | `awaiting_work_order` |
| any | any | true | `invalid` |

### 4c. Ingestion

| File:line | What is singular |
|---|---|
| `tm-connector/connector/identity.py:81` | `HEADER_RUN_FIELDS["test.definition"] = "definition_id"` |
| `tm-connector/connector/identity.py:58-71` | `DECLARED_FIELDS` holds `definition_id` |
| `tm-connector/connector/identity.py:91` | `LINKAGE_FIELDS = (run_id, rig_id, work_order_id, definition_id)` — declared beats header |
| `tm-connector/connector/identity.py:102` | `ASSERTED_FIELDS` = LINKAGE + CONTEXT, refused wholesale for a foreign record |
| `tm-connector/connector/bodies.py:102` | `body.update(identity.fields)` — forwards whatever resolved, verbatim |
| `mf4-decoder/identity.py` | **touches no definition at all.** It resolves `run_id` only. |
| `mf4-decoder/main.py:836` | `"test_definition": metadata.get("test_definition") or declared.get("definition_id")` — the only decoder line that knows the word |
| `mf4-datalake-sink/expand.py:175, :222` | `test_definition` defaulted to `unassigned` and written on every row |
| `mf4-datalake-sink/main.py:96-119` | `HIVE_COLUMNS = platform,work_order,test_definition,run_id,~…` |
| `quix.yaml:72` | the deployed `HIVE_COLUMNS` value |
| `quix.yaml:270` | `TM_LAKE_SESSION_PARTITIONS = platform,work_order,test_definition,run_id` |
| `frontend/app.yaml:43`, `mf4-datalake-sink/app.yaml:28` | the same two defaults |
| `tests/test_sink_partitioning.py:160-165` | the guard test that asserts head + tail == the sink tree |

**A lake row can sit in exactly one `test_definition=` directory.** A run carrying
three definitions cannot be partitioned by definition without triplicating its rows.
That is the fact that forces §6.3.

### 4d. Frontend

`definition_id` appears in 37 files under `frontend/` — `types/test-run.ts:19`,
`types/work-order.ts`, `types/summary.ts`, the runs screen, the run detail, the edit
dialog, the work-order detail, the definition detail and ~24 tests. **Changing the
wire meaning of `definition_id` costs a frontend rewrite.** §6.1 is shaped so the
frontend needs no change at all.

---

## 5. Proposed design, in one paragraph

Store **one** field, `test_runs.definition_ids: list[str]`, and project the legacy
scalar `definition_id` at read time as `definition_ids[0]`. Mongo's array-containment
semantics mean most queries change only the field *name* (`{"definition_ids": td_id}`
matches a run whose array holds it), the two indexes become multikey, and every
response model keeps the field the frontend already reads. The set is kept **sorted
ascending**, so the primary is deterministic and a push is order-independent. Planning
links merge as a **union**, so two `PushedLink` rows for one run are additive and a
re-post is a no-op. A trace claims its whole set in one MF4 header key,
`test.definitions`, comma-separated. `test_definition` leaves the lake partition tree,
because a shared run cannot be placed in it honestly; `work_order` stays, because the
sink's Dynamic Configuration lookup is keyed on it. Each definition gains an
`implementation` sub-document naming a `.py` in blob by path and sha256, uploaded
through a route that copies the existing binary requirements-file route line for line.

---

## 6. Design decisions

### 6.1 Cardinality — how a run holds several definitions

**Chosen: replace the stored scalar with `definition_ids: list[str]`; derive
`definition_id` at read time as the first element of the sorted set.**

Stored document:

```jsonc
{
  "_id": "TAS-1001",
  "work_order_id": "WO-BAT-2026-001",
  "definition_ids": ["BAT-SYS-TC-001", "BAT-SYS-TC-002", "BAT-SYS-TC-003"],
  "claimed_definition_id": null,          // unchanged, still scalar
  "field_sources": {
    "definition_ids": {"source": "embedded", "actor": "tm-connector", "at": "…"}
  }
}
```

There is **one** stored truth. `definition_id` is never written; it is computed on the
way out. So no write path can leave the two disagreeing, which is the failure mode a
denormalised mirror would have introduced across four writers (`_write_link`,
`_write_claims`, `patch_run`, `demo_reset`).

Why the set is **sorted**: it makes the primary deterministic (no "which link arrived
first?"), and it makes `merged == stored` a reliable idempotency test, which is what
`links_unchanged` is built on.

**Rejected — a `definition_id` "primary" plus a `definition_ids` list, both stored.**
Two fields, one truth, four write paths that must each maintain both. The first writer
that forgets leaves a run showing one definition on the list screen and three on the
detail, with nothing reporting it.

**Rejected — a `definition_runs` join collection.** It is the textbook answer and it is
wrong here: every read would gain a lookup stage, `_count_by`, `list_runs`, the
free-text search and the two indexes would all need a second collection, `_write_link`
would stop being the one write path, and `demo_reset`'s `PLANNING_FIELDS` revert would
need a delete scope of its own. For a set that is 2-3 long at demo scale and ~10 long
at any plausible scale, an embedded array is the right shape. Mongo's array-containment
matching is what makes the diff small.

#### What changes, field by field

| Place | Change |
|---|---|
| `models/runs.py:108` | keep `definition_id: str \| None`; **add** `definition_ids: list[str] = Field(default_factory=list)` |
| `models/runs.py` (new helper) | `_primary_definition` — a `@model_validator(mode="before")` that sets `data["definition_id"] = ids[0] if ids else None` when `definition_ids` is present. Mounted on `RunListItem`, `RecentRun` (`:409`) and `WorkOrderRun` (`planning.py:86`). One rule, three mounts, every read path covered whatever service built the dict. |
| `models/runs.py:227` `RunPatchRequest` | **unchanged on the wire.** `definition_id` now means "set this run's definitions to exactly this one id". This is the person's escape hatch and the only way to REMOVE a definition (§10, OQ2). The FE edit dialog keeps working. |
| `models/runs.py:324` `RunUpsertRequest` | keep `definition_id`; **add** `definition_ids: list[str] = Field(default_factory=list)`. Both are claims; `_resolve_claims` unions them. |
| `models/runs.py:487` `LineageResponse` | keep `definition` (the primary); **add** `definitions: list[LineageDefinition] = Field(default_factory=list)` |
| `models/planning.py:323` `PushedLink` | **unchanged.** One link states one definition. Several links for one run are how planning states a set. |
| `planning_sync.py:45` | `PLANNING_FIELDS = ("work_order_id", "definition_ids", "project")` |
| `planning_sync.py:427` `_write_link` | signature `definition_ids: list[str]` (callers pass `[]` or a one-element list). The values dict at `:447` becomes `{"work_order_id": …, "definition_ids": merged, "project": …}` where `merged = sorted(set(run.get("definition_ids") or []) \| set(definition_ids))`. An empty incoming list leaves the field alone (it evaluates equal to stored). Everything else — `set_field`, the `field_label` map, `derive_status`, the journal insert — is untouched. |
| `planning_sync.py:501` | `_backfill_runs` passes `[definition["id"]]` |
| `planning_sync.py:546` | `_link_retained_claims` passes `[definition_id]` or `[]` |
| `planning_sync.py:612-638` | the push loop passes `[definition_id] if definition_id else []`. **Union in `_write_link` is what makes repeated links additive.** |
| `planning_sync.py:726` | `demo_reset` clears `definition_ids` to `None` like every other planning field; readers use `or []` |
| `queries_runs.py:61` | `_FIELD_LABELS = {"work_order_id": "run.work_order", "definition_ids": "run.definition"}` — the journal label is unchanged, so the timeline keeps reading `run.definition` |
| `queries_runs.py:76` | `_CLAIM_MIRRORS` keeps `definition_id -> test_definitions`; `_resolve_claims` (`:101`) gains a list branch: union `body.definition_id` with `body.definition_ids`, resolve each against the mirror, put the resolved ones in `resolved["definition_ids"]`, append the rest to `unresolved` |
| `queries_runs.py:95` `CLAIM_RETAINED` | **unchanged, still scalar.** The seed pushes the catalog before any trace uploads, so every claim resolves and retention never fires. A bench running ahead of planning still remembers the FIRST unresolved definition, and `_resolve_retained_claim` re-opens the work order from it — enough to close the loop. Named as a limitation in §12. |
| `queries_runs.py:231` | `_insert_run` seeds `"definition_ids": []` instead of `"definition_id": None` |
| `queries_runs.py:497` | `{"definition_ids": definition}` — array containment, same one-line clause |
| `queries_runs.py:511` | the search tuple reads `definition_ids`; a regex against an array field matches element-wise |
| `queries_runs.py:762` | `run_lineage` loops `run.get("definition_ids") or []`, builds `definitions`, sets `definition` to the first |
| `queries_runs.py:1115` | `_LINK_ERRORS` keeps `definition_id` (the PATCH wire field); `_resolve_manual_links` (`:1119`) turns a stated `definition_id` into `values["definition_ids"] = [claimed]` and drops the scalar |
| `queries_runs.py:1391, :1530` | `_count_by(db, "test_runs", "definition_ids", …)` |
| `queries_runs.py:1546` `_count_by` | add `{"$unwind": f"${field}"}` between the `$match` and the `$group`. `$unwind` on a scalar yields the document unchanged, so the one helper keeps serving `work_order_id` too. |
| `queries_runs.py:1426` | `find({"definition_ids": td_id})` |
| `queries_runs.py:1572-1574` | `for td in run.get("definition_ids") or []: actual_runs[td] += 1` |
| `db.py:39, :46` | the two indexes move to `definition_ids` — multikey, same syntax; the compound stays legal because only one field is an array |

### 6.2 Claims from the trace — the MF4 header key

**Chosen: `test.definitions`, one comma-separated value.**

```xml
<e name="test.run_key">TAS-1001</e>
<e name="test.work_order">WO-BAT-2026-001</e>
<e name="test.definitions">BAT-SYS-TC-001,BAT-SYS-TC-002,BAT-SYS-TC-003</e>
```

`test.definition` (singular) stays accepted and reads as a one-element list, so any
other producer keeps working.

**Rejected — repeated `test.definition` entries.** `<common_properties>` is a
name→value map and `clean_header` (`tm-connector/connector/identity.py:146`) builds a
`dict`. A repeated name collides; only the last survives. The format cannot express it.

**Rejected — indexed keys `test.definition.1 … .N`.** Needs a scan of the whole header
and an arbitrary cap, and it reads worse in a hex dump than a comma list.

Changes:

- `tm-connector/connector/identity.py`
  - new `HEADER_LIST_FIELDS = {"test.definitions": "definition_ids"}` and a
    `split_ids(value)` helper (split on `,`, strip, drop empties).
  - `clean_header` (`:146`) maps `test.definition` → `definition_ids` as a one-element
    list and `test.definitions` → the split list; `test.definitions` wins when both are
    present.
  - `clean_declared` (`:131`) does the same for a declared `definition_ids` string, so
    an operator's browser form can state a set. `DECLARED_FIELDS` (`:58`) gains
    `definition_ids` and loses nothing.
  - `LINKAGE_FIELDS` (`:91`) replaces `definition_id` with `definition_ids`, so
    declared still beats header and `ASSERTED_FIELDS` (`:102`) still refuses the whole
    set when a record names a different run. **Declared wins wholesale — no union
    across the two channels.** A partial merge of two disagreeing assignments is the
    one thing `_refuse_foreign_record` exists to prevent.
  - `resolve_identity`'s `pick` (`:301`) compares two lists with `!=`; the conflict line
    it appends is already generic.
- `tm-connector/connector/bodies.py` — **no change.** `run_body` (`:74`) already does
  `body.update(identity.fields)` at `:102`, so `definition_ids` rides through.
- `mf4-decoder/identity.py` — **no change.** It resolves `run_id` only and forwards
  `header_properties` verbatim in the terminal marker, so the connector reads
  `test.definitions` without the decoder parsing it.
- `mf4-decoder/main.py:836` — the `"test_definition"` scalar is **deleted** from
  `file_scalars` (see §6.3). `"work_order"` at `:835` **stays**: the sink's DCM lookup
  is keyed on it (§6.8).

### 6.3 Lake partitions

**Chosen: remove `test_definition` from the partition tree and from the row.**

```
platform / work_order / run_id / ~channel_name / ~sender_node / ~frame_name / ~signal
```

A row can sit in one directory. A run carrying three definitions has no honest
directory, and `unassigned` for exactly the runs the demo is about would make the level
noise. The registry is the system of record for run→definitions, and every lake row
already carries `run_id`, which joins to it.

**Rejected — keep `test_definition` as `unassigned` for shared runs.** The level would
then be `unassigned` for 100 % of the battery estate: a directory that says nothing,
costs a path segment, and splits files.

**Rejected — triplicate the rows, one copy per definition.** Three times the bytes and
a `SELECT` that double-counts unless every query remembers to filter. No.

`work_order` stays a partition level and stays on the row. It is single-valued, and the
sink's `join_lookup` on `work_order_target_key` (§6.8) reads it.

**Table name.** The sink validates an existing table's partition spec at `setup()` and
refuses a mismatch (`mf4-datalake-sink/main.py:117-119`). Nothing has flowed through
the new sink, so **`battery_data_v1` can start life with the new layout and keeps its
name** — *provided* the Query API `/tables` still lists no `battery_data_v1` at deploy
time. That check is step 0 of the build list. If it exists, the name becomes
`battery_data_v2` and the `LAKE_TABLE` project variable moves with it (one value, read
by the sink, the connector, the API and the frontend). **Bump `CONSUMER_GROUP`
regardless**, so `AUTO_OFFSET_RESET=earliest` replays the four traces into the new
spec.

Files: `mf4-datalake-sink/main.py:94-119` (docstring + the `HIVE_COLUMNS` prose),
`mf4-datalake-sink/expand.py:175, :222`, `mf4-datalake-sink/app.yaml:28`,
`quix.yaml:72`, `quix.yaml:270`, `frontend/app.yaml:43`, the
`*lake_session_partitions` anchor in `docker-compose.local.yml`, and the guard test
`tests/test_sink_partitioning.py:160-165`.

### 6.4 The definition ids

**Chosen: the definition id IS the test-case id — `BAT-SYS-TC-001 … BAT-SYS-TC-010`.**

`CLAUDE.md` makes bidirectional traceability the audited property:
`requirement.verified_by` ↔ `test-spec.covers_req_ids`. Both already name
`BAT-SYS-TC-NNN`. A third id form would need a TC↔TD mapping table that nothing
validates and that an auditor would ask to see.

**Rejected — `TD-BAT-091`-style ids mirroring the fixture.** That style is cosmetic,
belongs to the demo fixture, and would put an unaudited indirection in the middle of
the chain.

### 6.5 Where the seed builder lives

**Chosen: a `battery-trace-gen/seed/` package.**

```
battery-trace-gen/seed/__main__.py          # the CLI: catalog | traces | links | impl | all
battery-trace-gen/seed/planning_payload.py  # build the PlanningPushRequest body from data/ + specs/ + out/manifest.csv
battery-trace-gen/seed/requirements_md.py   # render one requirements markdown per definition
battery-trace-gen/seed/implementations.py   # render + upload the 10 .py (§6.7)
battery-trace-gen/seed/push.py              # POST with the PAT (planning sync + the impl uploads)
battery-trace-gen/tools/gen_claude_md.py    # MOVED here from the scratchpad
```

Every input (`data/battery-dc-requirements.json`, `data/battery-dc-parameters.json`,
`specs/battery-dc-test-specs.json`, `out/manifest.csv`) is a sibling. A repo-level
`tools/` would import across directory boundaries for no gain. Splitting into five
small modules keeps each well under the 500-line ceiling.

`CLAUDE.md` currently says "regenerate with `scratchpad/gen_claude_md.py`". **Fix that
pointer to `battery-trace-gen/tools/gen_claude_md.py`** in the same PR.

### 6.6 Trace identity

Each `scenarios/T*.json` gains a `"test"` block, and `scenario.Scenario` (`:79`) a
matching frozen dataclass field read in `load_scenario` (`:142`):

```jsonc
"test": {
  "run_key":     "TAS-1001",
  "work_order":  "WO-BAT-2026-001",
  "definitions": ["BAT-SYS-TC-001", "BAT-SYS-TC-002", "BAT-SYS-TC-003"],
  "rig":         "battery-sim-01",
  "cell":        "BENCH-DC-1",
  "operator":    "battery-trace-gen",
  "bench_sw":    "battery-trace-gen 0.2",
  "description": "T1 charge and thermal — 300 A into a warm pack, chiller off"
}
```

`bus/mf4.py:83` `write()` takes a `test: dict` argument and merges these into `props`
(`:121`) as `test.run_key`, `test.work_order`, `test.definitions` (comma-joined),
`test.rig`, `test.cell`, `test.operator`, `test.bench_sw`, `test.description`, plus
`test.started_at` = `start_time_utc` and `test.ended_at` = start + `duration_s`.
`generate.py:94` passes `scenario.test` through.

**New route and start times, so every sha256 changes.** The decoder dedups on
sha256 and the four current files are already in the estate. Shift each scenario's
`start_time_utc` to **2026-09-23** at its existing clock time and regenerate `route`
from `route_template` (`{device}--{date}--{time}`) to match. The HD-comment change
alone would already change the hash; moving the date makes the new files obviously
distinct in a listing.

`TM_RUN_KEY_PATTERN` is bound to the literal string `TM_RUN_KEY_PATTERN` on both the
decoder and the connector. That compiles as a regex, so it does **not** fall back to
`TAS-\d+` — it searches for that literal in the filename and never matches. The
filename rung is dead, and rung 2 (`test.run_key`) is what resolves the run. The
`TAS-100N` ids are chosen for readability, not because the pattern will fire.

### 6.7 The test implementation — storage, link and provenance

#### Where the `.py` lives

**Chosen: a third `test-manager/` folder in the same blob container as the raw MF4s.**

`api/api/services/file_writes.py` already defines two sibling folders — `RESULT_FOLDER
= "test-manager/results"` (`:43`) and `REQUIREMENTS_FOLDER = "test-manager/requirements"`
(`:48`) — both under the workspace folder that SAG grants the deployment a write on,
beside the importer's `mf4-uploads/YYYY/MM/DD/` landing prefix. Add a third:

```python
IMPLEMENTATION_FOLDER = "test-manager/implementations"

def implementation_blob_key(td_id: str, filename: str, digest: str) -> str:
    # <workspace>/test-manager/implementations/<td_id>/<sha8>-<filename>
```

The key carries the content hash, not a uuid4 as `result_blob_key` (`:64`) and
`requirements_blob_key` (`:112`) do. Those two need a uuid so two uploads of one
filename cannot collide; here the digest gives the same non-collision **and** makes the
key name the exact bytes — the point of the artefact. Re-uploading identical bytes
lands on the same key, which is the right idempotency.

**Rejected — the MF4's own dated prefix** (`mf4-uploads/2026/09/23/<stem>-<hash8>.<tc_id>.py`,
`mf4-to-blob/blob.py:76-102`). An implementation belongs to a *definition*, not to an
upload day; it outlives every trace and would be re-filed under a new date each time.
The dated prefix is the importer's landing zone and MF4 Import must never see a `.py`.

**Rejected — riding as a binary entry in `requirements_files`.** That field is prose a
person reads (`RequirementsFile`, `models/planning.py:122-158`, `render_markdown:
null` for bytes). Mixing an executable into it makes "which requirements documents does
this definition have" unanswerable, and planning owns that list wholesale — a sync pass
replaces it.

#### How it gets there

**Chosen: a new API route that copies the existing binary upload route line for line.**

```
POST /test-definitions/{td_id}/implementation        (multipart/form-data, field `file`)
GET  /test-definitions/{td_id}/implementation/download
```

Both copy `upload_requirements_file_bytes` (`api/api/routers/test_definitions.py:597-685`)
and `download_requirements_file` (`:687-745`): the pre-spool cap via the route class
(`:96-140`), the exact cap over the chunks (`:545`), `writer.check_ready()` → 503
`storage_unreachable`, `writer.write(key, chunks)`, the journal entry **before** the row
(`:255`), the same `FileBytesProvider` on the way back. The upload computes sha256 over
the same chunks it writes.

**Rejected — writing the blob directly from the seed with
`quixportal.get_filesystem()`.** It would be a second writer into the same bucket with
no journal entry, no `field_sources` tag and no 503 path, and the registry would end up
holding a pointer it did not write and cannot vouch for. The API already owns a proven
blob-write path; the seed POSTs to it with the same PAT it uses for `/planning/sync`.

#### How the definition points at it

A new **manual-side** sub-document on the definition, kept out of the mirror fields the
way `manual_requirements_files` is (`routers/test_definitions.py:60`), so no planning
sync pass can erase it:

```jsonc
"implementation": {
  "blob_path":  "blob://<workspace>/test-manager/implementations/BAT-SYS-TC-001/9f2b0a11-BAT-SYS-TC-001.py",
  "filename":   "BAT-SYS-TC-001.py",
  "sha256":     "9f2b0a11…",            // 64 hex, the identity of the bytes
  "size_bytes": 4096,
  "language":   "python",
  "entrypoint": "evaluate",             // evaluate(run_id, table) -> {verdict, evidence}
  "uploaded_at": "2026-09-23T…Z",
  "uploaded_by": "<actor>"
}
```

Model: `DefinitionImplementation` in `api/api/models/planning.py`, and
`TestDefinitionDetail.implementation: DefinitionImplementation | None = None` — a
detail-only field, exactly as `requirements_files` is (`:173`). Each subfield is written
through `set_field` as `implementation.<key>`; `stored_source`
(`api/api/provenance.py:188-208`) already walks dotted paths for precisely this shape.

**Rejected — a `custom_properties` key.** That map is a person's free text, capped at
512 characters per value and 50 keys (`models/runs.py:27-29`). A load-bearing
traceability pointer must not sit where a typo silently breaks the chain and nothing
but `check_custom_properties` stands in the way.

#### How QuixLab opens it

**Do not invent a parallel mechanism.** Tomas's rule
(`api/api/routers/integrations.py:18-30`): the **frame** completes a token handshake
and then receives `TM_IMPORT {runId}` by `postMessage`, so the run id travels in memory
and never in a URL; the **tab** opens `url + "?open=analysis&kind=notebook"` and the
notebook finds the newest run itself.

- The definition detail screen's "Open in QuixLab" control calls the existing
  `GET /integrations/quixlabs` (`:185`) — or `GET /integrations/quixlab-url` (`:117`)
  as the fallback — and frames the instance through `quixlab.embed_url`
  (`api/api/quixlab.py:60`) / `portal_embedded_url` (`:168`). **No change to
  `api/api/quixlab.py` and no new integrations route.**
- **Works today, zero QuixLab change:** the screen shows the implementation's filename,
  sha256 and a download link served by the new `/implementation/download` route, and
  the QuixLab control opens QuixLab at the run the way it already does.
- **The extension, flagged as out-of-repo:** a second postMessage alongside
  `TM_IMPORT`, e.g. `TM_OPEN {blobPath}`, so QuixLab opens that `.py` directly. It needs
  a handler in `quixlab/src/quixlab/server/embed.py`, which is another repository. §10,
  OQ4.

#### Provenance — how a verdict names its implementation

The result provenance block is frozen at six keys and forbids an extra one
(`api/api/models/results.py:14-57`, `Provenance` is a `RequestModel`). It does not need
one. A verdict written against a run states:

| Key | Value |
|---|---|
| `tool` | `BAT-SYS-TC-001` — the definition/test-case the verdict answers |
| `tool_version` | `sha256:9f2b0a11f3c4` — the first 12 hex of the implementation's digest |
| `parameters` | `blob://…/BAT-SYS-TC-001/9f2b0a11-BAT-SYS-TC-001.py table=battery_data_v1 run_id=TAS-1001` |
| `input_file_ids` | the registered file ids of the trace |
| `produced_by`, `produced_at` | the evaluator and its clock |

This is the same device a lake row uses for the DBC: the row carries `dcm_config_id`,
the verdict carries the implementation digest. **Zero model change.**

### 6.8 The work order is also a Dynamic Configuration — do not push it twice

`api/api/planning_sync.py:315-361` `_mirror_work_orders` is the **one chokepoint** for
every arrival — the outbound pull, the inbound push and planning's adoption all mirror
through it — and it hands every NEW or CHANGED row to `config_push.push_work_orders`
(`api/api/config_push.py:38`). That files the work order in the deployed Configuration
Manager as `type="WorkOrder"`, `target_key=<wo id>`, content = planning's verbatim
payload:

- create — `POST /api/v1/configurations {metadata:{type,target_key}, content}`; 409 when
  the pair exists;
- update — `PUT /api/v1/configurations/{sha1("WorkOrder-<wo id>")} {content}`, bumping
  the version.

Best-effort **by contract** (`config_push.py:15-18`): a missed push heals on the next
change, and only ids that actually landed are stamped `config_pushed_at`
(`planning_sync.py:337-341, :358-361`), so a refused push retries next pass.

**So the seed's `POST /planning/sync` files the work order in DCM automatically. The
seed must NOT add a second push.** Doing so would create a competing writer for the
same `(type, target_key)` pair and desynchronise the version counter.

The sink reads it back: `mf4-datalake-sink/main.py:327-342` joins
`QuixConfigurationService` on `work_order_target_key`, field
`F_WORK_ORDER_PLATFORM = QuixConfigurationServiceJSONField(type="WorkOrder",
jsonpath="$.project", default=UNKNOWN)`, and `expand.py:171-173` uses it as the
**platform fallback** for a file whose own MF4 header named no platform. This join is
the reason `work_order` stays on the row and in the partition tree (§6.3), and it is
untouched by this spec.

**The `project` value of our work order — chosen: `BATTERY_DC_V1`.**

`project` does double duty: it is the runs-list filter and `group_by=project` value, the
`WorkOrderRow.project` column, the value `_resolve_claims` copies onto a run
(`queries_runs.py:122-123`) — *and* a lake **partition directory** whenever the platform
fallback fires. Making it equal to the platform id makes the fallback harmless by
construction: if any file ever claims `WO-BAT-2026-001` without naming a platform, it
lands under `platform=BATTERY_DC_V1/`, which is where it belongs. Our four traces all
name `BATTERY_DC_V1` in their header, so for them the fallback never fires at all.

**Rejected — `"Battery DC"` as a programme name.** It reads better on the work-order
list and in the project filter, but it would become a partition directory containing a
space the first time a platform-less file claimed the work order. The human-readable
programme name goes in the work order's **title**, which is where a person reads it.

---

## 7. Data and interface contracts

### 7.1 Run document (Mongo `test_runs`)

| Field | Before | After |
|---|---|---|
| `definition_id` | `str \| None`, stored | **removed from storage**, projected at read time |
| `definition_ids` | — | `list[str]`, sorted ascending, `[]` when none |
| `claimed_definition_id` | `str \| None` | unchanged |
| `field_sources.definition_id` | the tag | becomes `field_sources.definition_ids` |

### 7.2 Wire

`GET /test-runs`, `GET /test-runs/{id}`, `GET /work-orders/{id}`,
`GET /test-definitions/{id}`, `GET /summary`:

```jsonc
{
  "run_id": "TAS-1001",
  "definition_id": "BAT-SYS-TC-001",                                  // unchanged: the primary
  "definition_ids": ["BAT-SYS-TC-001","BAT-SYS-TC-002","BAT-SYS-TC-003"], // new
  "work_order_id": "WO-BAT-2026-001",
  "status": "complete"
}
```

`POST /test-runs` (ingestion): `definition_ids: list[str]` added; `definition_id` kept
and unioned into it.
`PATCH /test-runs/{id}`: unchanged shape; `definition_id` now **replaces** the set.
`POST /planning/sync`: unchanged shape; repeated `links` for one `run_id` are additive.
`GET /test-runs/{id}/lineage`: `definitions: [...]` added beside `definition`.
`GET /test-definitions/{id}`: `implementation: {...} | null` added.
`POST /test-definitions/{id}/implementation`, `GET .../implementation/download`: new.

### 7.3 MF4 `<common_properties>` — the `test.*` block

| Key | Meaning |
|---|---|
| `test.run_key` | the run id (rung 2 of the ladder, on both decoder and connector) |
| `test.work_order` | one work order id |
| `test.definitions` | **new** — comma-separated definition ids |
| `test.definition` | still accepted, reads as a one-element list |
| `test.rig`, `test.cell`, `test.operator`, `test.bench_sw`, `test.description` | unchanged |
| `test.started_at`, `test.ended_at` | unchanged (header beats declared) |

### 7.4 Lake

`HIVE_COLUMNS = platform,work_order,run_id,~channel_name,~sender_node,~frame_name,~signal`
`TM_LAKE_SESSION_PARTITIONS = platform,work_order,run_id`
`TM_LAKE_DATA_PARTITIONS` unchanged. The `test_definition` **column** is removed from
the row entirely, not merely de-partitioned. `device`, `route`, `segment`,
`dcm_config_id` stay as plain columns.

---

## 8. Seed payload and order of operations

### 8.1 The push body

```jsonc
{
  "work_orders": [
    {
      "id": "WO-BAT-2026-001",
      "title": "Battery DC system qualification — BATTERY_DC_V1",
      "project": "BATTERY_DC_V1",          // see §6.8: this doubles as the lake platform fallback
      "status": "active",
      "requestor": "ludvik@quix.io",
      "department": "Battery Systems Validation",
      "priority": "High",
      "created_at": "2026-09-23T08:00:00Z"
    }
  ],
  "test_definitions": [
    {
      "id": "BAT-SYS-TC-001",
      "work_order_id": "WO-BAT-2026-001",
      "title": "Maximum DC charging current — I_current_Chr_Max",
      "planned_runs": 1,
      "requirements_files": [
        { "name": "BAT-SYS-TC-001.md", "content": "<rendered, see 8.2>" }
      ]
    }
    // … BAT-SYS-TC-002 … BAT-SYS-TC-010, same shape
  ],
  "links": [
    { "run_id": "TAS-1001", "work_order_id": "WO-BAT-2026-001", "definition_id": "BAT-SYS-TC-001" },
    { "run_id": "TAS-1001", "work_order_id": "WO-BAT-2026-001", "definition_id": "BAT-SYS-TC-002" },
    { "run_id": "TAS-1001", "work_order_id": "WO-BAT-2026-001", "definition_id": "BAT-SYS-TC-003" },
    { "run_id": "TAS-1002", "work_order_id": "WO-BAT-2026-001", "definition_id": "BAT-SYS-TC-004" },
    { "run_id": "TAS-1002", "work_order_id": "WO-BAT-2026-001", "definition_id": "BAT-SYS-TC-005" },
    { "run_id": "TAS-1002", "work_order_id": "WO-BAT-2026-001", "definition_id": "BAT-SYS-TC-006" },
    { "run_id": "TAS-1003", "work_order_id": "WO-BAT-2026-001", "definition_id": "BAT-SYS-TC-007" },
    { "run_id": "TAS-1003", "work_order_id": "WO-BAT-2026-001", "definition_id": "BAT-SYS-TC-008" },
    { "run_id": "TAS-1004", "work_order_id": "WO-BAT-2026-001", "definition_id": "BAT-SYS-TC-009" },
    { "run_id": "TAS-1004", "work_order_id": "WO-BAT-2026-001", "definition_id": "BAT-SYS-TC-010" }
  ]
}
```

Ten links, four runs. `_write_link`'s union turns them into four sets of 3/3/2/2.
The work order in this body also lands in Dynamic Configuration as a side effect of the
mirror write — §6.8. The seed adds no second push.

### 8.2 One requirements markdown, in full (the template for all ten)

`BAT-SYS-TC-001.md`, rendered by `seed/requirements_md.py` from
`data/battery-dc-requirements.json`, `data/battery-dc-parameters.json`,
`specs/battery-dc-test-specs.json` and `out/manifest.csv`:

```markdown
# BAT-SYS-TC-001 — Maximum DC charging current

## Requirement BAT-SYS-PRF-001 (Performance, StateDriven, rev 0.1, Draft)

> While the battery system is in the Charging state, the battery system shall limit
> the DC charging current to not more than **300 A**.

| | |
|---|---|
| Measurand | `i_dc_chg` (A) |
| System states | Charging |
| Verification method | Test |
| Source | STAKEHOLDER:battery-dc-brief-2026-09-21; PROJECT-CHOICE:systems-engineer |
| Rationale | I_current_Chr_Max bounds the charge acceptance of the cell chemistry and the current rating of the DC contactors and busbars. |
| Verified by | BAT-SYS-TC-001 |

### Parameters
| Name | Value | Unit | Source |
|---|---|---|---|
| `I_current_Chr_Max` | 300 | A | data/battery-dc-parameters.json |

## Test case
**Objective.** Show that while the battery system is Charging the DC charging current
never exceeds I_current_Chr_Max = 300 A in magnitude, under the battery sign convention
in which a charging current is negative.

**Entry criteria.** The run's BMS_01 group decodes and carries BMS_I_Dc and BMS_State.
**Exit criteria.** Both criteria PASS and the achieved charge-current minimum is
reported together with its margin to -300 A.

### Pass criteria
| Id | Signal | Window | Reduce | Rule | Tolerance |
|---|---|---|---|---|---|
| C1 | `BMS_I_Dc` | BMS_State in {3}, settle 0,5 s | min | >= -300,0 A | abs 0,05 |
| C2 | `BMS_I_Dc` | BMS_State in {3}, settle 0,5 s | max | <= 0 A | abs 0,05 |

## Evidence
| | |
|---|---|
| Run | `TAS-1001` (trace T1_charge_thermal.mf4) |
| Lake table | `battery_data_v1`, partition `platform=BATTERY_DC_V1/work_order=WO-BAT-2026-001/run_id=TAS-1001` |
| Implementation | `BAT-SYS-TC-001.py` |
| Expected verdict | **PASS** |
| Expected measurement | min_i_dc_a = -300; limit_a = -300; margin_a = 0 |
```

For the four rigged failures the Evidence block additionally renders the
`mechanism` column of `out/manifest.csv`, e.g. for `BAT-SYS-TC-003`:

> **Expected verdict: FAIL.** Mechanism: derating law correct, temperature input stale
> (`T_FILT_TAU` = 9,0 s against a nominal 2,0 s). Measured max 61,2 °C against a
> 60 °C limit, 151,3 s of dwell above it.

### 8.3 Order of operations, and what is authoritative

| # | Step | Effect |
|---|---|---|
| 0 | Query API `GET /tables` — confirm no `battery_data_v1` | decides the table name (§6.3) |
| 1 | Deploy the sink with the new `HIVE_COLUMNS`, new `CONSUMER_GROUP` | the table is created with the new spec on first write |
| 2 | `POST /planning/sync` — work orders + definitions, `links: []` | mirror holds 1 WO + 10 TDs; every definition is `orphaned: false`; **the WO is filed in Dynamic Configuration by the same write** (§6.8) |
| 3 | `POST /test-definitions/{td}/implementation` ×10 | each definition points at its `.py` in blob |
| 4 | Regenerate + upload the 4 MF4s through MF4 Import | decoder → connector → `POST /test-runs`; the header claims resolve against the mirror from step 2; runs go `complete` with `definition_ids` tagged `embedded` |
| 5 | `POST /planning/sync` again — the same catalog + the 10 `links` | planning confirms; the union is idempotent, so a re-post reports `links_unchanged` |

**Planning (step 5) is authoritative.** The precedence is Tomas's:
`manual > api:* > embedded` (`api/api/provenance.py:41-49`). The trace's claim is the
bench stating what it believes it ran; planning is the record of what was planned; a
person outranks both.

**A consequence to expect and not to "fix" by accident.** After step 4 the link fields
are tagged `embedded`. In step 5 `_write_link` skips a field whose stored value already
equals the incoming one, so the tag **stays `embedded`**. That is the honest reading:
the bench stated the link, planning agreed, nobody overrode it. If `api:planning` tags
are wanted on the links, the change is two lines in `_write_link`'s loop guard (re-tag
on an equal value when the incoming source outranks the stored one) — see §10, OQ1.
**Do not make that change without an answer.**

Step 2 is re-run in step 5 with the same content, so `_mirror_work_orders` sees an
unchanged `raw` **and** a stamped `config_pushed_at`, and pushes nothing to DCM a
second time (`planning_sync.py:334-341`).

### 8.4 The four runs

| Run | Trace | Definitions | Expected verdicts |
|---|---|---|---|
| `TAS-1001` | `T1_charge_thermal.mf4` | TC-001, TC-002, TC-003 | PASS, PASS, **FAIL** |
| `TAS-1002` | `T2_discharge_sweep.mf4` | TC-004, TC-005, TC-006 | PASS, PASS, **FAIL** |
| `TAS-1003` | `T3_sleep_balance.mf4` | TC-007, TC-008 | PASS, **FAIL** |
| `TAS-1004` | `T4_cold_heater.mf4` | TC-009, TC-010 | PASS, **FAIL** |

6 PASS / 4 FAIL. The four failures are rigged in trace *content* — a stale temperature
filter, a mis-anchored customer-SOC map, a diffusion time constant longer than the
relaxation budget, a heater entry threshold two kelvin low — never a missing channel or
a schema error. See `battery-trace-gen/out/manifest.csv`.

### 8.5 The ten implementations

`seed/implementations.py` renders one module per test case from
`specs/battery-dc-test-specs.json` into `battery-trace-gen/out/impl/<tc_id>.py`, then
POSTs each to `/test-definitions/{td_id}/implementation`. A module is thin and has one
public function:

```python
def evaluate(run_id: str, table: str) -> dict:
    """Return {"verdict": "PASS"|"FAIL", "evidence": {...}} for one run.

    Reads the run's rows from the lake through the Query API, applies the criteria
    of specs/battery-dc-test-specs.json for this test case, and returns the same
    evidence keys out/manifest.csv already names for it.
    """
```

It reads the lake by `run_id` through the Query API — never by definition, which the
lake no longer partitions on. Its evidence keys match the `measured` column of
`out/manifest.csv` exactly, so the expected and the achieved numbers are comparable
without a mapping.

---

## 9. Red-first tests

Each must be RED on the unfixed tree before the fix lands.

| # | Test | Asserts |
|---|---|---|
| 1 | `api/tests/test_multi_definition_links.py::test_two_links_for_one_run_are_additive` | push `(TAS-1001, TC-001)` then `(TAS-1001, TC-002)`; the run holds **both**; today the second overwrites the first |
| 2 | `…::test_a_re_post_of_the_same_links_changes_nothing` | the same 10 links twice → `links_applied: 10` then `links_unchanged: 10` |
| 3 | `…::test_a_run_appears_in_every_definition_it_carries` | `GET /test-definitions/BAT-SYS-TC-001` and `…-002` both list `TAS-1001`; `actual_runs == 1` on each; `list_test_definitions` agrees |
| 4 | `…::test_the_upsert_claims_several_definitions` | `POST /test-runs` with `definition_ids: [a, b]` against a mirror holding both → `definition_ids == [a, b]`, tagged `embedded`, `status == "complete"` |
| 5 | `…::test_the_legacy_scalar_still_links` | `POST /test-runs` with `definition_id: a` → stored `definition_ids == [a]`, response `definition_id == "a"` on the list, the detail, the work-order detail and the Home summary |
| 6 | `…::test_a_patch_replaces_the_whole_set` | PATCH `definition_id: c` on a run holding `[a, b]` → `[c]`, tagged `manual`, one journal entry labelled `run.definition` |
| 7 | `…::test_a_work_order_and_no_definitions_is_complete` | `derive_status` unchanged across all four rows of the §4b table |
| 8 | `tm-connector/tests/test_identity.py::test_the_header_maps_test_definitions_to_a_list` | `test.definitions: "a,b"` → `definition_ids: ["a","b"]`; `test.definition: "a"` → `["a"]`; a foreign `test.run_key` still refuses the whole set |
| 9 | `tests/test_sink_partitioning.py::test_the_tree_has_no_definition_level` | `HIVE_COLUMNS` == `platform,work_order,run_id,~…`; `head + "," + tail == sink_tree` still holds across `quix.yaml`, both `app.yaml`s and `docker-compose.local.yml` |
| 10 | `mf4-datalake-sink/tests/test_expand.py::test_a_row_carries_no_test_definition` | the expanded row dict has no `test_definition` key, and `work_order` is still present so the DCM join key survives |
| 11 | `api/tests/test_definition_implementation.py::test_the_upload_records_path_and_digest` | POST a `.py` → `implementation.sha256` matches the bytes, `blob_path` starts `blob://`, a journal entry exists, and a planning sync pass does **not** erase it |

---

## 10. Risks, constraints, open questions

### Risks

| Risk | Mitigation |
|---|---|
| **The read-time projection misses a call site.** Not every read goes through `with_facts` (`queries_runs.py:706`). | The projection is a `@model_validator(mode="before")` on the three response models, not a service-layer overlay, so it fires whatever built the dict. Test 5 covers the list, the detail, the work-order detail and the Home summary. |
| **`_count_by` (`queries_runs.py:1546`) groups by an array.** Without `$unwind` every definition count becomes 0. | Test 3 is red on exactly this. `$unwind` on a scalar is a no-op, so the shared helper keeps serving `work_order_id`. |
| **Free-text search over an array.** `every_word_matches` builds regex clauses; Mongo matches a regex element-wise on an array, but this has never been exercised here. | Add a case to the existing search test with a two-definition run. |
| **The partition change is irreversible per table.** The sink refuses a spec mismatch at `setup()`. | Step 0 of the build list checks `/tables` before anything is deployed. `CONSUMER_GROUP` is bumped regardless. |
| **Dropping `test_definition` must not drop `work_order`.** The sink's DCM `join_lookup` is keyed on it (§6.8). | Test 10 asserts `work_order` survives on the row. |
| **`demo_reset` clears `definition_ids` to `None`, not `[]`.** | Readers use `or []`, matching how `planned_runs` and `requirements_files` are already read. Seed-path only; no production caller. |
| **Six repos-worth of `HIVE_COLUMNS` copies must move together** (`quix.yaml` ×2, two `app.yaml`s, `docker-compose.local.yml`, the sink docstring). | `tests/test_sink_partitioning.py` is the existing guard and test 9 extends it. |

### The riskiest part, named

**`_write_link` (`api/api/planning_sync.py:427-477`) is the single write path for every
planning link, inbound and outbound.** Both `run_sync_pass` and `apply_planning_push`
land there precisely so they cannot drift. Changing its signature and its equality test
touches the backfill, the inbound push, and the retained-claim repair in one edit. Get
the union wrong in either direction and the failure is silent: too eager and a stale
link can never be corrected, too lazy and `links_unchanged` lies. Tests 1, 2 and 6 are
the fence.

### The things in Tomas's code that make this harder than it looks

1. **The provenance equality guard.** `_write_link:454` skips a field whose stored value
   already equals the incoming one, and `set_field` (`api/api/provenance.py:241`) skips a
   write whose source is outranked. Together they mean a link already claimed by the bench
   is never re-tagged by planning, even though planning is the master of the field. With a
   scalar this was invisible; with a merged set it decides whether step 5 of the seed does
   anything at all. It is correct behaviour and it is not what a reader expects — OQ1.
2. **`ASSERTED_FIELDS` / `_refuse_foreign_record`
   (`tm-connector/connector/identity.py:102, :269`) refuses a record wholesale** when it
   names a different run. Adding `definition_ids` to `LINKAGE_FIELDS` puts the whole set
   inside that refusal, which is right — but a header with a typo'd `test.run_key`
   silently drops the definitions too, reported only in the `file.header_parsed` note.
3. **Mirroring a work order has a side effect outside Mongo** (`config_push`, §6.8).
   Nothing in `_mirror_work_orders`'s signature says so. A seed that pushes the catalog
   twice is harmless only because `config_pushed_at` and the `raw` comparison gate it.

### Open questions for the user

1. **Should planning's push re-tag a link the bench already claimed?** Recommended
   answer: **no** — `embedded` is the honest record ("the bench stated it, planning
   agreed"), and the run is linked either way. Changing it is two lines in
   `_write_link`; do not do it without a decision.
2. **Should a planning push ever be able to REMOVE a definition from a run?** Today's
   answer with union semantics: no — only `PATCH /test-runs/{id}` with a single
   `definition_id` replaces the set. Recommended: leave it. A "replace" link semantic
   would need a per-run "clear" step in the push, which `PushedLink` cannot express.
3. **"Next to the raw file" — literally, or the same container?** This spec reads it as
   the same blob container, in a `test-manager/implementations/` folder beside the two
   `test-manager/*` folders the repo already writes. If the literal dated MF4 prefix was
   meant, say so before ArchDev starts.
4. **`TM_OPEN` in QuixLab.** Opening a specific `.py` in the framed QuixLab needs a
   handler in `quixlab/src/quixlab/server/embed.py` — another repository. Is that in
   scope, or does the download link plus the existing run deep-link suffice for now?
5. **`project = "BATTERY_DC_V1"` or `"Battery DC"`?** §6.8 chooses the platform id
   because the value doubles as a lake partition directory. If the runs-list project
   filter reading as a programme name matters more, say so — it is a one-line flip.
6. **Does a verdict get written in this feature?** §6.7 specifies how a verdict *names*
   its implementation, but no evaluator writes one here. Confirm that stays a follow-up.

---

## 11. Build list for ArchDev

Ordered. Every path is exact.

**0. Precondition (no code).** Query API `GET /tables` — confirm `battery_data_v1` does
not exist. If it does, use `battery_data_v2` everywhere below and move the `LAKE_TABLE`
project variable.

**1. Registry — models.** `api/api/models/runs.py`: add `definition_ids` to
`RunListItem` (`:108`) and `RecentRun` (`:409`); add the `_primary_definition`
`model_validator`; add `definition_ids` to `RunUpsertRequest` (`:324`); add
`definitions` to `LineageResponse` (`:487`).
`api/api/models/planning.py`: add `definition_ids` to `WorkOrderRun` (`:86`) with the
same validator; add `DefinitionImplementation` and
`TestDefinitionDetail.implementation` (`:160-178`).

**2. Registry — writes.** `api/api/planning_sync.py`: `PLANNING_FIELDS` (`:45`);
`_write_link` (`:427-477`) signature + union; the three call sites (`:501`, `:546`,
`:635`); `demo_reset` (`:726`) needs no logic change, only the constant.
`_mirror_work_orders` (`:315`) and `api/api/config_push.py`: **do not touch.**

**3. Registry — reads and claims.** `api/api/services/queries_runs.py`: `:61`, `:76`,
`:101-124`, `:231`, `:497`, `:511`, `:762-769`, `:1119`, `:1391`, `:1426`, `:1530`,
`:1546` (`$unwind`), `:1572-1574`.

**4. Indexes.** `api/api/db.py:39, :46` → `definition_ids`.

**5. Connector.** `tm-connector/connector/identity.py`: `:58`, `:77-88` (+
`HEADER_LIST_FIELDS`, `split_ids`), `:91`, `:131-155`, `:301-320`.
`tm-connector/connector/bodies.py`: **no change**.

**6. Decoder.** `mf4-decoder/main.py:836` — delete the `test_definition` scalar; leave
`:835` `work_order` alone. `mf4-decoder/identity.py`: **no change**.

**7. Sink.** `mf4-datalake-sink/expand.py:175, :222`;
`mf4-datalake-sink/main.py:94-119` (docstring); `mf4-datalake-sink/app.yaml:28`. The
`join_lookup` block at `:327-342` is **untouched**.

**8. Deployment values.** `quix.yaml:72`, `quix.yaml:270`, `frontend/app.yaml:43`, the
`*lake_session_partitions` anchor in `docker-compose.local.yml`, and a new
`CONSUMER_GROUP` on the sink.

**9. Implementation storage.** `api/api/services/file_writes.py`:
`IMPLEMENTATION_FOLDER` beside `:48`, `implementation_blob_key` beside `:112`, both
exported at `:281-294`. `api/api/routers/test_definitions.py`: the two new routes,
copying `:597-685` and `:687-745`.

**10. Trace generator.** `battery-trace-gen/scenarios/_identity.json` (a `test` default
block), `scenarios/T1..T4.json` (the `test` block + new `route` / `start_time_utc`),
`battery-trace-gen/scenario.py:79, :142`, `battery-trace-gen/bus/mf4.py:83, :121`,
`battery-trace-gen/generate.py:94`. Regenerate the four MF4s and `out/manifest.*`.

**11. Seed package.** `battery-trace-gen/seed/{__main__,planning_payload,requirements_md,implementations,push}.py`;
move `gen_claude_md.py` to `battery-trace-gen/tools/` and fix the pointer in
`CLAUDE.md`.

**12. Tests.** The eleven in §9.

**Verification checklist to hand to Tester:** `pre-commit run --all-files` (pinned
versions, never local ruff/mypy); the eleven tests red then green;
`tests/test_sink_partitioning.py` green; a local `docker-compose.local.yml` round trip
of one regenerated trace showing `definition_ids` with three entries on the run and the
run appearing under all three definitions.

---

## 12. Out of scope

- An evaluator that runs the implementations and writes `processed_results`.
- A frontend change. Everything here is additive on the wire; showing all three
  definitions as chips instead of one is a follow-up for FrontEndEsthetic.
- Extending `CLAIM_RETAINED` to a list (§6.1). A bench that runs ahead of planning
  remembers only its FIRST unresolved definition claim. The seed's order of operations
  makes this unreachable.
- Removing a definition through a planning push (§10, OQ2).
- Any change to `config_push.py` or the sink's `join_lookup` (§6.8).
- Migrating `mf4_signals_v5`.

## 13. References

- `CLAUDE.md` (repo root) — the ASPICE chain, the EARS patterns, the 6/4 failure split,
  the open decisions on the ID namespace.
- `dev-planning/battery-can-traces/spec.md` — the trace generator this builds on.
- `battery-trace-gen/data/battery-dc-requirements.json` (10),
  `data/battery-dc-parameters.json` (11),
  `specs/battery-dc-test-specs.json` (10), `out/manifest.csv` (the 6/4 split).
- `api/api/planning_sync.py` module docstring — "the arrow is being turned around".
- `api/api/config_push.py` module docstring — the real Dynamic Configuration contract,
  and why the push is best-effort by design.
- `api/api/routers/integrations.py:18-30` — the QuixLab frame/tab rule this feature
  must not fork.
- Global golden rules: light functional code, no PR1110 construct; ArchDev writes,
  Tester verifies; lint via pinned pre-commit.
