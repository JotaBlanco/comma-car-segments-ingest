# Multi-definition test runs, and the QuixLab test implementation — architecture

**Spec:** `dev-planning/tm-multi-definition-runs/spec.md`
**Branch / base:** `jama-ui-dev` @ `e4f172a`
**Built:** 2026-09-22

---

## 1. What this change does

A test run now carries a **set** of test definitions instead of one. The stored
truth is `test_runs.definition_ids: list[str]`, sorted ascending; the legacy
scalar `definition_id` is projected at read time as its first element, so every
existing response field and every existing frontend screen keeps working
untouched. A trace claims its own set in one MF4 header key
(`test.definitions`, comma-separated), a planning push states one definition per
link and `_write_link` unions them, and the lake stops partitioning by
`test_definition` because a run fulfilling three definitions has no honest
directory. Each definition gains one executable `.py` implementation, stored in
blob by path and by the sha256 of its bytes, uploaded through a new API route
that copies the existing binary requirements-upload route. A `seed/` package in
`battery-trace-gen/` builds the whole seed: one work order, ten definitions with
a rendered requirements document each, ten links, and the ten implementations.

---

## 2. Why this shape

### 2.1 One stored field, not two

`definition_ids` is the only stored value. `definition_id` is never written; it
is computed on the way out by a `@model_validator(mode="before")` mounted on the
three response models that carry a run row. Four writers touch the link fields
(`_write_link`, `_write_claims`, `patch_run`, `demo_reset`); a denormalised
"primary + list" pair would have to be maintained by all four, and the first one
that forgot would leave a run showing one definition on the list screen and three
on the detail with nothing reporting it.

The validator does two jobs, and the second one is not cosmetic: it normalises a
null list to `[]`. `demo_reset` clears every `PLANNING_FIELDS` entry to `None`,
and a stored null against `list[str]` is a response `ValidationError`, which is
not a request error and would have answered 500 for the whole runs page. Doing
the normalisation in the same rule is what let `demo_reset` stay untouched.

### 2.2 The set is sorted

Sorting makes the primary deterministic — no "which link arrived first?" — and
it makes `merged == stored` a reliable idempotency test, which is what
`links_unchanged` reports on.

### 2.3 An embedded array, not a join collection

At demo scale the set is 2–3 long and at any plausible scale ~10. Mongo's
array-containment matching means most queries change only the field *name*:
`{"definition_ids": td_id}` matches a run whose array holds it, and the two
indexes become multikey with no syntax change. A `definition_runs` join
collection would have added a lookup stage to every read, a second collection to
`_count_by`, `list_runs`, the free-text search and both indexes, and a delete
scope of its own to `demo_reset` — and `_write_link` would have stopped being
the one write path.

### 2.4 `test_definition` leaves the lake

A row sits in exactly one directory. `unassigned` would then be the value for
100 % of the battery estate, and triplicating rows would triple the bytes and
double-count every `SELECT` that forgot to filter. `work_order` stays a
partition level and stays on the row, because the sink's
`QuixConfigurationService` join on `work_order_target_key`
(`mf4-datalake-sink/main.py:327-342`) reads it as the platform fallback. That
join is untouched.

### 2.5 The implementation is a manual-side field

`implementation` lives beside `manual_requirements_files` in the definition
document. Planning names no such field, so `_mirror_definitions` — which writes
exactly `work_order_id`, `title`, `planned_runs` and `requirements_files` — can
never erase it. Each subfield is written through `set_field` as
`implementation.<key>`, and `provenance.stored_source` already walks dotted paths
for that shape.

The blob key carries the content digest where `result_blob_key` and
`requirements_blob_key` carry a uuid4. The digest gives the same non-collision
**and** makes the key name the exact bytes, which is the point of the artefact: a
verdict cites `tool_version = "sha256:<first 12 hex>"`. Re-uploading identical
bytes lands on the same key, which is the right idempotency here.

---

## 3. Data flow

### 3.1 A trace becomes a multi-definition run

```
battery-trace-gen/generate.py
  scenarios/T1.json  test{run_key, definitions[]}      scenarios/_identity.json  test{work_order, rig, ...}
        \______________________________________________________/
                               |
                    bus/mf4.py  _test_props()
                               v
   <common_properties>
     test.run_key     = TAS-1001
     test.work_order  = WO-BAT-2026-001
     test.definitions = BAT-SYS-TC-001,BAT-SYS-TC-002,BAT-SYS-TC-003
                               |
                        MF4 Import -> blob
                               v
   mf4-decoder/main.py   resolves run_id ONCE; forwards header_properties
                         verbatim in the terminal marker. It parses no
                         definition; `test_definition` is gone from file_scalars.
                               |
              +----------------+-----------------+
              v                                  v
   mf4-datalake-sink                    tm-connector/connector/identity.py
     expand.py drops test_definition      clean_header(): HEADER_LIST_FIELDS maps
     row: platform/work_order/run_id      test.definition  -> ["a"]
                                          test.definitions -> ["a","b","c"]  (wins)
                                        LINKAGE_FIELDS holds definition_ids, so
                                        declared beats header wholesale and a
                                        foreign test.run_key refuses the whole set
                                               |
                                        bodies.run_body(): body.update(identity.fields)
                                               v
                                   POST /test-runs {definition_ids: [...]}
                                               v
                       queries_runs._resolve_claims(): unions definition_id with
                       definition_ids, resolves each against the mirror, writes
                       the resolved ones to definition_ids tagged `embedded`
```

### 3.2 A planning push links a run to several definitions

```
POST /planning/sync
  links: [{TAS-1001, WO-BAT-2026-001, BAT-SYS-TC-001},
          {TAS-1001, WO-BAT-2026-001, BAT-SYS-TC-002},
          {TAS-1001, WO-BAT-2026-001, BAT-SYS-TC-003}, ...]
        |
   apply_planning_push loop  ->  _write_link(db, run, wo, [td], project, note)   x3
        |
   _write_link:
     merged = sorted(set(run["definition_ids"]) | set(incoming))
     values["definition_ids"] = merged or None        # None is skipped by the loop
     for field, value in values.items():
         if value is None or run.get(field) == value:  continue    # idempotency
         set_field(..., field_label=_LINK_LABELS[field])           # precedence
     update["status"] = derive_status(...)                          # unchanged
```

Pass 1 writes `[TC-001]`, pass 2 `[TC-001, TC-002]`, pass 3 the full three. A
re-post of all three finds `merged == stored` each time, writes nothing, journals
nothing and returns `False`, so the route counts them in `links_unchanged`.

### 3.3 The implementation

```
python -m seed impl
  seed/implementations.render(tc_id)    <- seed/implementation_cases.CASES
        |                                  (the same reduction manifest.py runs)
   out/impl/BAT-SYS-TC-001.py
        |
   POST /test-definitions/BAT-SYS-TC-001/implementation   (multipart, PAT)
        |
   routers/test_definitions.upload_implementation:
     _read_digest_within_cap()  -> size + sha256 over the chunks it then writes
     writer.check_ready()       -> 503 storage_unreachable
     implementation_blob_key(td, filename, digest)
     writer.write(key, _chunks(file))
     add_event(test_definition.implementation_uploaded)  -> 503 not_ready
     set_field(implementation.<key>) x8, one $set
        |
   GET /test-definitions/{td}  ->  implementation: {blob_path, sha256, ...}
   GET /test-definitions/{td}/implementation/download  ->  the bytes
        |
   the generated module at run time:
     POST {Quix__Lakehouse__Query__Url}/query?union_by_name=true
     SELECT ts_ms, signal, value FROM battery_data_v1 WHERE run_id = 'TAS-1001'
     -> evaluate(run_id, table) -> {"verdict", "evidence"}
```

---

## 4. Per-service diffs, with file:line

Line numbers are of the **changed** tree.

### 4.1 `api/` — registry

| File:line | Change |
|---|---|
| `api/api/models/runs.py:103-116` | new `primary_definition(data)` — normalises `definition_ids` and derives `definition_id` from it |
| `api/api/models/runs.py:119-131` | `RunListItem` gains `definition_ids: list[str]` beside the scalar |
| `api/api/models/runs.py:156-159` | the validator, mounted on `RunListItem` (so `RunDetail` inherits it) |
| `api/api/models/runs.py:243-250` | `RunPatchRequest` docstring: `definition_id` now REPLACES the set; unchanged on the wire |
| `api/api/models/runs.py:352-357` | `RunUpsertRequest` gains `definition_ids`; both fields are claims |
| `api/api/models/runs.py:439-452` | `RecentRun` gains `definition_ids` + the validator |
| `api/api/models/runs.py:519-523` | `LineageResponse` gains `definitions: list[LineageDefinition]` |
| `api/api/models/planning.py:84-97` | `WorkOrderRun` gains `definition_ids` + the validator |
| `api/api/models/planning.py:160-181` | new `DefinitionImplementation` model |
| `api/api/models/planning.py:191-196` | `TestDefinitionDetail.implementation: … \| None = None` |
| `api/api/models/planning.py:345-356` | `PushedLink` docstring: several links for one run are additive |
| `api/api/planning_sync.py:44-53` | `PLANNING_FIELDS` takes `definition_ids`; new `_LINK_LABELS` keeps the journal label `run.definition` |
| `api/api/planning_sync.py:435-500` | `_write_link` signature `definition_ids: list[str]`, the union, `merged or None`, `_LINK_LABELS` |
| `api/api/planning_sync.py:524` | `_backfill_runs` passes `[definition["id"]]` |
| `api/api/planning_sync.py:548-570` | `_link_retained_claims`: the waiting selector reads `{"definition_ids": {"$in": [None, []]}}`; passes `[definition_id]` or `[]` |
| `api/api/planning_sync.py:660-662` | the push loop passes `[definition_id] if definition_id else []` |
| `api/api/planning_sync.py:610-614` | `apply_planning_push` docstring: additive links |
| `api/api/services/queries_runs.py:60-63` | `_FIELD_LABELS` keys `definition_ids` -> `run.definition` |
| `api/api/services/queries_runs.py:101-145` | new `_claimed_ids`; `_resolve_claims` resolves every claimed definition into `resolved["definition_ids"]` |
| `api/api/services/queries_runs.py:181-199` | `_retained_claims` remembers the FIRST unknown id per field |
| `api/api/services/queries_runs.py:257` | `_insert_run` seeds `"definition_ids": []` |
| `api/api/services/queries_runs.py:524-526` | the `definition` filter is array containment |
| `api/api/services/queries_runs.py:540` | free-text search reads `definition_ids` |
| `api/api/services/queries_runs.py:769-812` | `run_lineage` builds `definitions` and takes `definition` as the first |
| `api/api/services/queries_runs.py:1151-1174` | `_resolve_manual_links` turns a stated `definition_id` into `values["definition_ids"] = [id]` |
| `api/api/services/queries_runs.py:1428` | `list_test_definitions` counts on `definition_ids` |
| `api/api/services/queries_runs.py:1463` | `get_test_definition_detail` finds on `definition_ids` |
| `api/api/services/queries_runs.py:1583-1602` | `_count_by` gains `$unwind` plus a second `$match` |
| `api/api/services/queries_runs.py:1623-1626` | `get_work_order_detail` counts each definition of each run |
| `api/api/db.py:36-39, :46` | both run indexes move to `definition_ids` (multikey) |
| `api/api/services/exports.py:117-120` | the CSV `Definition` column reads the primary |
| `api/api/services/queries_stats.py:633, :649` | the signal-stats definition filter and column |
| `api/api/services/file_writes.py:50-56` | `IMPLEMENTATION_FOLDER = "test-manager/implementations"` |
| `api/api/services/file_writes.py:129-143` | `implementation_blob_key(td_id, filename, digest)` |
| `api/api/services/file_writes.py:297-310` | both exported |
| `api/api/routers/test_definitions.py:11-15` | module docstring: three fields bend the mirror rule, not two |
| `api/api/routers/test_definitions.py:88-89, :134` | `_UPLOAD_SUFFIXES` — the pre-spool cap now also guards `/implementation` |
| `api/api/routers/test_definitions.py:788-830` | `_read_digest_within_cap` — size and sha256 over the same chunks |
| `api/api/routers/test_definitions.py:833-930` | `POST /test-definitions/{td_id}/implementation` |
| `api/api/routers/test_definitions.py:933-1005` | `GET /test-definitions/{td_id}/implementation/download` |
| `api/api/services/lake.py:208-210` | the comment naming the sink's partition order |
| `api/api/stub_data.py:82, :111, :135, :158, :205` | the test-factory cast stores `definition_ids` |
| `api/seed/fixtures.py:193` | the demo seed tags `definition_ids` with a one-element list |
| `api/seed/filler.py:267` | filler runs seed `"definition_ids": []` |
| `api/seed/seed_demo.py:102` | the seed's journal label map keys `definition_ids` |

**Not touched, on purpose:** `provenance.derive_status` (it reads `work_order_id`
only), `planning_sync._mirror_work_orders`, `config_push.py`,
`queries_runs.CLAIM_RETAINED` (still scalar — see §7).

### 4.2 `tm-connector/`

| File:line | Change |
|---|---|
| `connector/identity.py:19-24` | module docstring: the linkage set wins or loses wholesale |
| `connector/identity.py:58-72` | `DECLARED_FIELDS` gains `definition_ids` |
| `connector/identity.py:74-99` | `test.definition` leaves `HEADER_RUN_FIELDS`; new `HEADER_LIST_FIELDS` maps both spellings onto `definition_ids`, with `test.definitions` last so it wins |
| `connector/identity.py:101` | `LINKAGE_FIELDS` replaces `definition_id` with `definition_ids`, which puts the set inside `ASSERTED_FIELDS` and `_refuse_foreign_record` |
| `connector/identity.py:132-138` | new `split_ids(value)` |
| `connector/identity.py:141-163` | `clean_declared` folds a declared `definition_id`/`definition_ids` into one list and never lets the scalar through |
| `connector/identity.py:166-185` | `clean_header` maps the list fields |
| `connector/identity.py:283, :306, :324-326` | the three annotations widen to `dict[str, object]` |
| `connector/bodies.py:77` | docstring only; `run_body` forwards `identity.fields` verbatim as before |

### 4.3 `mf4-decoder/`

| File:line | Change |
|---|---|
| `main.py:834-840` | the `test_definition` scalar is deleted from `file_scalars`; `work_order` stays, with the reason on the line |

`mf4-decoder/identity.py` is untouched: it resolves `run_id` only and forwards
`header_properties` verbatim, so the connector reads `test.definitions` without
the decoder knowing the key exists.

### 4.4 `mf4-datalake-sink/`

| File:line | Change |
|---|---|
| `main.py:93-112` | the partition docstring: no `test_definition` level, and why |
| `expand.py:35-38` | the `UNASSIGNED` comment now names one column |
| `expand.py:174` | the `test_definition` default is gone |
| `expand.py:216-221` | the emitted row drops `test_definition`; `work_order` stays |
| `app.yaml:24-29` | `HIVE_COLUMNS` default and its prose |
| `app.yaml:13` | `TABLE_NAME` default -> `battery_data_v1` |
| `app.yaml:55` | `CONSUMER_GROUP` default -> `battery_data_v1_lake_v1` |

The `join_lookup` block at `main.py:327-342` is untouched.

### 4.5 Deployment values

| File:line | Change |
|---|---|
| `quix.yaml:72` | `HIVE_COLUMNS = platform,work_order,run_id,~channel_name,~sender_node,~frame_name,~signal` |
| `quix.yaml:75-77` | `CONSUMER_GROUP = battery_data_v1_lake_v1` |
| `quix.yaml:270` | `TM_LAKE_SESSION_PARTITIONS = platform,work_order,run_id` |
| `frontend/app.yaml:42-43` | the same two halves |
| `docker-compose.local.yml:22` | `x-lake-table` -> `battery_data_local` |
| `docker-compose.local.yml:28` | `x-lake-session-partitions` |
| `docker-compose.local.yml:293-294` | the sink's `HIVE_COLUMNS` and `CONSUMER_GROUP` |

### 4.6 `battery-trace-gen/`

| File:line | Change |
|---|---|
| `scenarios/_identity.json:8-14` | new `test` block: work order, rig, cell, operator, bench |
| `scenarios/T1..T4.json:4-5` | new `route` and `start_time_utc`, both on 2026-09-23 |
| `scenarios/T1..T4.json:7-15` | new `test` block: `run_key`, `definitions`, `description` |
| `scenario.py:22-33` | `Identity.test` |
| `scenario.py:88-91` | `Scenario.test` |
| `scenario.py:161` | `load_scenario` reads it |
| `bus/mf4.py:10-14` | module docstring: the `test.*` block |
| `bus/mf4.py:83-100` | new `_test_props(test, start, duration_s)` |
| `bus/mf4.py:116, :131` | `write()` takes `test: dict` |
| `bus/mf4.py:145, :170-181` | `start_time` computed before `props`; the block merged in; the `<TX>` names the chain |
| `generate.py:107-110` | `generate.py` passes `{**identity.test, **scenario.test}` |
| `manifest.py:280-283` | the manifest records `run_key` and `definitions` per trace |
| `seed/` | NEW — see §5 |
| `tools/gen_claude_md.py` | MOVED from the scratchpad; the two hard-coded paths become `__file__`-relative |
| `README.md:96-118` | the seed section |
| `CLAUDE.md:20-21, :89, :97-99, :118-123` | the regenerate pointer, the partition order, `test.definitions`, the additive links and the implementation route — mirrored in `tools/gen_claude_md.py` so the two stay identical |

### 4.7 `frontend/`

Confined to the definition-detail screen, the API client and the two type files.
**Nothing under `components/shell/`, `components/screens/run-detail/`,
`app/quixlab/`, `app/lakehouse/`, `lib/quixlab*.ts`, `lib/shell-breakout.ts` or
`lib/api/integrations.ts` was touched** — a second ArchDev owns those.

| File:line | Change |
|---|---|
| `types/work-order.ts:26-38` | `WorkOrderRunRollup.definition_ids?: string[]` |
| `types/work-order.ts:160-179` | new `DefinitionImplementation` |
| `types/work-order.ts:191-192` | `TestDefinitionDetail.implementation?` |
| `types/test-run.ts:16-27` | `TestRunListItem.definition_ids?: string[]` |
| `lib/api/testDefinitions.ts:94-107` | `downloadImplementation(tdId, filename)` |
| `components/screens/definitions/implementation-panel.tsx` | NEW — filename, entrypoint, size, sha256, blob path, uploader, download button |
| `components/screens/definitions/definition-detail-screen.tsx:29, :222-228` | the panel is mounted |
| `lib/explore/lake-partitions.ts:17, :38-42` | the session-partition fallback drops `test_definition` |

The panel is functional and unstyled beyond the existing `Panel`/`MetaGrid`
primitives — FrontEndEsthetic owns the look.

---

## 5. The seed package

```
battery-trace-gen/seed/__init__.py                 what the package does
battery-trace-gen/seed/__main__.py                 CLI: render | catalog | impl | links | all
battery-trace-gen/seed/sources.py                  the four inputs, read once and indexed
battery-trace-gen/seed/planning_payload.py         the PlanningPushRequest body
battery-trace-gen/seed/requirements_md.py          one markdown per definition
battery-trace-gen/seed/implementation_cases.py     what each of the ten tests measures
battery-trace-gen/seed/implementations.py          the module template, renderer and uploader
battery-trace-gen/seed/push.py                     the two POSTs, with a PAT
battery-trace-gen/tools/gen_claude_md.py           moved here from the scratchpad
```

`sources.py` and `implementation_cases.py` are two more modules than the spec's
§6.5 named. `sources.py` exists so the payload builder, the markdown renderer and
the CLI read one loader rather than three; `implementation_cases.py` exists so
`implementations.py` holds the template and nothing else. Both keep every file
well under the 500-line ceiling.

### 5.1 The generated implementations

Each module is **standalone**: the blob holds one file and a runner fetches one
file, so a shared library it could import does not exist at the far end. The
shared half is the template in `implementations.py`; the per-test-case half is
one `Case` in `implementation_cases.py`.

A module reads its run's samples from QuixLake by `run_id` alone — the table
partitions by `platform/work_order/run_id` and carries no definition level — and
aligns every signal onto the first one's raster with a **step hold**
(`np.searchsorted`, last value at or before the instant). A CAN signal is
latched; interpolating a state would invent a state the bus never held.

The `measure` body of each case is the same reduction `manifest.py` already runs
over the generator's own signal history, so the evidence keys match the
`measured` column of `out/manifest.csv` key for key and the expected numbers
compare with the achieved ones without a mapping. The `passes` expression is the
only thing the generator adds: a threshold over those keys, taken from the
requirement's own parameter where one exists and from the test spec's
`tolerance.abs` otherwise. Every number a module enforces sits in its own
`LIMITS`, so the uploaded `.py` carries its limits and needs no catalogue.

The ten `passes` expressions reproduce the declared 6 PASS / 4 FAIL split
against the manifest's measured values:

| Definition | Passes when | Manifest measured | Verdict |
|---|---|---|---|
| TC-001 | `min_i_dc_a >= limit_a - 0,05` | −300 vs −300 | PASS |
| TC-002 | `max_law_error <= 0,02` and `max_limit_excess_a <= 0,5` | 0,01 / 0,1 | PASS |
| TC-003 | `max_degc <= limit_degc + 0,1` | 61,2 vs 60 | **FAIL** |
| TC-004 | `error_pct <= 0,2` | 0,0045 | PASS |
| TC-005 | `min_v >= 720 − 0,5` and `max_v <= 840 + 0,5` | 732,8 / 840 | PASS |
| TC-006 | `max_abs_error_pct <= 0,5` | 7,15 | **FAIL** |
| TC-007 | `end_over_start <= 0,5` and `max_increase_v <= 0,0001` | 0,2525 / 0 | PASS |
| TC-008 | `error_v_at_budget <= 2,0` | 2,43 | **FAIL** |
| TC-009 | `max_power_error_w <= 1` and every dwell `>= 1 s` | 0 / 38,8 / 543 / 18,2 | PASS |
| TC-010 | `violation_s <= 0,05` | 272,5 | **FAIL** |

---

## 6. Order of operations, and the exact commands

`battery-trace-gen/` is the working directory for every generator command.
`TM_API_URL` is the environment's `backend-api` public base; `TM_API_TOKEN` is
the same static bearer every other `/api/v1` client presents.

| # | Step | Command |
|---|---|---|
| 0 | Confirm the lake table name (see §8) | `curl -H "Authorization: Bearer $PAT" "$QUERY_API/tables"` |
| 1 | Deploy the sink with the new `HIVE_COLUMNS` and `CONSUMER_GROUP` | Quix sync of `quix.yaml` |
| 2 | Regenerate the four traces and the manifest | `python generate.py --scenario all` |
| 3 | Read the seed before sending it | `python -m seed render` |
| 4 | Push the catalog (no links) | `TM_API_URL=… TM_API_TOKEN=… python -m seed catalog` |
| 5 | Upload the ten implementations | `TM_API_URL=… TM_API_TOKEN=… python -m seed impl` |
| 6 | Upload the four MF4s through MF4 Import | the existing browser upload of `out/T*.mf4` |
| 7 | Confirm the links | `TM_API_URL=… TM_API_TOKEN=… python -m seed links` |

Step 4 also files the work order in Dynamic Configuration, through
`planning_sync._mirror_work_orders` -> `config_push.push_work_orders`. **The seed
makes no second push**: a competing writer on the same `(type, target_key)` pair
would desynchronise the version counter there. Step 7 re-sends the same catalog,
so `_mirror_work_orders` sees an unchanged `raw` and a stamped `config_pushed_at`
and pushes nothing a second time.

After step 6 the link fields are tagged `embedded`. In step 7 `_write_link` skips
a field whose stored value already equals the incoming one, so the tag **stays
`embedded`** and the whole push reports `links_unchanged: 10`. That is the
decided behaviour (spec §10 OQ1, answered "no re-tag"): the bench stated the
link, planning agreed, nobody overrode it.

`python -m seed all` runs steps 4, 5 and 7 back to back — useful only when the
traces are already in the estate.

---

## 7. Deviations from the spec, and consequences it did not name

1. **Step 0 was not executed here.** The brief's §5 forbids running anything
   against the live environment, and the system-level rule forbids endpoint
   pings. The caller's own check minutes before this build reported only
   `mf4_signals_v5` in `GET /tables`, so the build uses `battery_data_v1` as the
   spec directs. If `/tables` now lists it, the name becomes `battery_data_v2`
   and the `LAKE_TABLE` project variable moves with it — the only repo change
   would be the `TABLE_NAME` default in `mf4-datalake-sink/app.yaml:13` and the
   evidence/lake strings in `seed/requirements_md.py:22` and the generated
   modules' `evaluate(..., table=...)` default.

2. **`_write_link` states "no change" with `None`, not with an equality.** The
   spec said "an empty incoming list leaves the field alone (it evaluates equal
   to stored)". That is only true once every run document carries the key; a
   document written before the array existed reads `None` from `run.get`, and an
   empty merged list would then have written `[]` and journalled `— -> []` on
   every backfill pass over every legacy run. `values["definition_ids"] = merged
   or None` reuses the loop's existing `value is None` skip instead.

3. **`_count_by` has two `$match` stages, not one.** `$unwind` after a single
   `$match` yields every element of a matched array, including definitions the
   caller did not ask about, and those would have entered the grouped answer as
   spurious keys. The second `$match` after the unwind drops them.

4. **`CLAIM_RETAINED` stays scalar, and it now remembers the FIRST unknown id.**
   The spec left `_retained_claims` alone, but the old dict comprehension kept
   the LAST of several unresolved claims, and a payload can now carry several.
   `first.setdefault(...)` makes it the first, which is what §6.1 describes.

5. **`clean_declared` never lets a declared `definition_id` through.** The spec
   only said `DECLARED_FIELDS` gains `definition_ids`. Since `LINKAGE_FIELDS` no
   longer names the scalar, a declared `definition_id` would have been silently
   dropped by `resolve_identity`'s field loop. It is folded into
   `definition_ids` instead, so an operator's browser form keeps working.

6. **The demo seed and the test-factory cast were converted too.** The spec's
   file list did not name `api/seed/fixtures.py`, `api/seed/filler.py`,
   `api/seed/seed_demo.py` or `api/api/stub_data.py`, but all four write run
   documents straight into Mongo with a stored `definition_id`. Left alone, the
   demo cast would have shown no runs under any definition. The change is
   mechanical: `definition_id: X` -> `definition_ids: [X]`.

7. **`exports.py` and `queries_stats.py` serve the PRIMARY definition.** Both
   read raw Mongo rows. The CSV export's "Definition" column and
   `SignalStatsRow.definition_id` are single-valued by their own contracts
   (`frontend/.../runs-screen.tsx` RUN_CSV_COLUMNS repeats them cell for cell),
   so both take `definition_ids[0]`. A run carrying three shows its first in a
   spreadsheet; the wire and every screen carry all three.

8. **Nine journal lines per implementation upload became one.** Writing each of
   the eight `implementation.<key>` subfields through `set_field` and journalling
   every returned entry would put eight change lines in the definition's timeline
   per upload. The tags are still written; one `test_definition.implementation_uploaded`
   event names the file, its size and its digest.

9. **The seed CLI has `render` where the spec listed `traces`.** Regenerating the
   MF4s is `python generate.py --scenario all` and wrapping it would have been a
   second entry point to one tool. `render` writes the push bodies and the ten
   modules to `out/` without posting anything, which is what a reviewer needs.

10. **The local compose table name moved too.** The sink validates an existing
    table's partition spec at `setup()` and refuses a mismatch, so
    `docker-compose.local.yml`'s `mf4_signals_local` would have refused the new
    spec on a developer's machine. It is `battery_data_local` now, with a matching
    `CONSUMER_GROUP`.

11. **`frontend/lib/explore/lake-partitions.ts` was not on the spec's list.** It
    holds `DEFAULT_SESSION_PARTITIONS`, the fallback when
    `TM_LAKE_SESSION_PARTITIONS` is unset. Left stale it would have addressed a
    directory level that no longer exists.

### Consequences the spec did not anticipate

* **`api/docs/openapi.v1.json` is now stale.** Three response models gained a
  field and two routes appeared, so `test_contract_snapshot.py` is red until the
  snapshot is regenerated (`api/scripts/snapshot.sh`). The spec's §9 did not list
  it. `plans/API-CONTRACT.md`, which the test's comment names, does not exist in
  this tree.
* **`tests/test_sink_partitioning.py:160-165` and `tests/test_import_claim.py:150`
  are red by design.** They assert the old tree and the old `test_definition`
  scalar. Spec §9 tests 9 and 10 replace them.
* **The four MF4 sha256s change**, because both the header block and the start
  time moved. The decoder dedups on sha256, so the new files ingest cleanly
  alongside the old ones rather than being skipped. The old four rows in
  `mf4_signals_v5` are not migrated (spec §3).
* **`TM_RUN_KEY_PATTERN` is bound to the literal string `TM_RUN_KEY_PATTERN` on
  both the decoder and the connector.** It compiles as a regex, so it searches
  filenames for that literal and never matches: the filename rung is dead and
  rung 2 (`test.run_key`) is what resolves the run. The `TAS-100N` ids are chosen
  for readability, not because the pattern will fire.

---

## 8. Integration with neighbouring features

* **`dev-planning/battery-can-traces/`** — this builds directly on that trace
  generator. The scenarios, the plant, the controller, the DBC and the manifest
  are unchanged except for the `test` block and the new dates.
* **The planning mirror and `config_push`** — untouched. The seed's push files
  the work order in Dynamic Configuration as a side effect, which is exactly what
  the lake sink's platform fallback reads back.
* **The framed QuixLab work (concurrent, other owner)** — no shared file. The
  definition screen's implementation panel serves the bytes through the existing
  download proxy and adds no integrations route; opening a specific `.py` inside
  QuixLab would need a `TM_OPEN` handler in
  `quixlab/src/quixlab/server/embed.py`, another repository, and is out of scope
  (spec §10 OQ4).
* **The next feature — an evaluator.** Everything it needs is now in place: the
  implementation's blob path and digest on the definition, `run_id` on every lake
  row, and the frozen six-key result `Provenance` block, where a verdict names
  `tool = <tc_id>`, `tool_version = "sha256:<12 hex>"` and `parameters =
  "<blob path> table=… run_id=…"`. No model changes.

---

## 9. The planning push body

`python -m seed render` writes this to `out/seed/planning-full.json`. The work
order, one complete definition and all ten links:

```jsonc
{
  "work_orders": [
    {
      "id": "WO-BAT-2026-001",
      "title": "Battery DC system qualification — BATTERY_DC_V1",
      "project": "BATTERY_DC_V1",
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
      "title": "DC charging current held at or below I_current_Chr_Max",
      "planned_runs": 1,
      "requirements_files": [
        {
          "name": "BAT-SYS-TC-001.md",
          "content": "# BAT-SYS-TC-001 — Maximum DC charging current\n\n## Requirement BAT-SYS-PRF-001 (Performance, StateDriven, rev 0.1, Draft)\n\n> While the battery system is in the Charging state, the battery system shall limit the DC charging current to not more than **I_current_Chr_Max = 300 A**.\n\n| | |\n|---|---|\n| Measurand | `i_dc_chg` (A) |\n| System states | Charging |\n| Verification method | Test |\n| Source | STAKEHOLDER:battery-dc-brief-2026-09-21; PROJECT-CHOICE:systems-engineer |\n| Rationale | I_current_Chr_Max bounds the charge acceptance of the cell chemistry and the current rating of the DC contactors and busbars. |\n| Verified by | BAT-SYS-TC-001 |\n\n### Parameters\n| Name | Value | Unit | Description |\n|---|---|---|---|\n| `I_current_Chr_Max` | 300 | A | Maximum DC charging current |\n\n## Test case\n**Objective.** Show that while the battery system is Charging the DC charging current never exceeds I_current_Chr_Max = 300 A in magnitude, under the battery sign convention in which a charging current is negative.\n\n**Entry criteria.** The run's BMS_01 group decodes and carries BMS_I_Dc and BMS_State.\n**Exit criteria.** Both criteria PASS and the achieved charge-current minimum is reported together with its margin to -300 A.\n\n### Pass criteria\n| Id | Signal | Window | Reduce | Rule | Tolerance |\n|---|---|---|---|---|---|\n| C1 | `BMS_I_Dc` | BMS_State in {3}, settle 0,5 s | min | ge -300 A | abs 0,05 |\n| C2 | `BMS_I_Dc` | BMS_State in {3}, settle 0,5 s | max | le 0 A | abs 0,05 |\n\n## Evidence\n| | |\n|---|---|\n| Run | `TAS-1001` (trace T1_charge_thermal.mf4) |\n| Lake table | `battery_data_v1`, partition `platform=BATTERY_DC_V1/work_order=WO-BAT-2026-001/run_id=TAS-1001` |\n| Implementation | `BAT-SYS-TC-001.py` |\n| Expected verdict | **PASS** |\n| Expected measurement | min_i_dc_a=-300; limit_a=-300; margin_a=0 |\n"
        }
      ]
    }
    // BAT-SYS-TC-002 … BAT-SYS-TC-010, same shape
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

Ten links over four runs. `_write_link`'s union turns them into four sets of
3 / 3 / 2 / 2.

---

## 10. File inventory

| File | New/Changed | Lines | Purpose |
|---|---|---|---|
| `api/api/models/runs.py` | Changed | +41 | the projection rule, `definition_ids` on three models, `definitions` on lineage |
| `api/api/models/planning.py` | Changed | +39/−4 | `WorkOrderRun.definition_ids`, `DefinitionImplementation`, the detail field |
| `api/api/planning_sync.py` | Changed | +43/−12 | `PLANNING_FIELDS`, `_LINK_LABELS`, `_write_link`'s union, three call sites |
| `api/api/services/queries_runs.py` | Changed | +124/−44 | claims, filters, search, lineage, PATCH, the two counts, `$unwind` |
| `api/api/services/file_writes.py` | Changed | +25 | `IMPLEMENTATION_FOLDER`, `implementation_blob_key` |
| `api/api/routers/test_definitions.py` | Changed | +234/−7 | the two implementation routes |
| `api/api/db.py` | Changed | +7/−3 | both run indexes |
| `api/api/services/exports.py` | Changed | +5/−2 | the CSV Definition column |
| `api/api/services/queries_stats.py` | Changed | +4/−2 | the signal-stats filter and column |
| `api/api/services/lake.py` | Changed | +5/−3 | the partition-order comment |
| `api/api/stub_data.py` | Changed | +10/−5 | the test-factory cast |
| `api/seed/{fixtures,filler,seed_demo}.py` | Changed | +3/−3 | the demo seed's run writes |
| **`api/` total** | | **+540/−85** | |
| `tm-connector/connector/identity.py` | Changed | +69/−22 | `HEADER_LIST_FIELDS`, `split_ids`, the linkage set |
| `tm-connector/connector/bodies.py` | Changed | +1/−1 | docstring |
| **`tm-connector/` total** | | **+70/−23** | |
| `mf4-decoder/main.py` | Changed | +5/−2 | the `test_definition` scalar goes |
| **`mf4-decoder/` total** | | **+5/−2** | |
| `mf4-datalake-sink/main.py` | Changed | +17/−7 | the partition docstring |
| `mf4-datalake-sink/expand.py` | Changed | +8/−9 | the column goes |
| `mf4-datalake-sink/app.yaml` | Changed | +11/−7 | defaults |
| **`mf4-datalake-sink/` total** | | **+36/−23** | |
| `battery-trace-gen/seed/__init__.py` | New | 14 | what the package does |
| `battery-trace-gen/seed/__main__.py` | New | 101 | the CLI and the sanity print |
| `battery-trace-gen/seed/sources.py` | New | 102 | the four inputs, indexed |
| `battery-trace-gen/seed/planning_payload.py` | New | 103 | the push body |
| `battery-trace-gen/seed/requirements_md.py` | New | 167 | one markdown per definition |
| `battery-trace-gen/seed/implementation_cases.py` | New | 274 | what each test measures and passes on |
| `battery-trace-gen/seed/implementations.py` | New | 210 | the module template, renderer, uploader |
| `battery-trace-gen/seed/push.py` | New | 75 | the two POSTs with a PAT |
| `battery-trace-gen/tools/gen_claude_md.py` | New (moved) | 138 | regenerate `CLAUDE.md` |
| `battery-trace-gen/scenarios/_identity.json` | Changed | 15 | the shared `test` block |
| `battery-trace-gen/scenarios/T1..T4.json` | Changed | 272 | `test` block, new route and start time |
| `battery-trace-gen/scenario.py` | Changed | +9 | `Identity.test`, `Scenario.test` |
| `battery-trace-gen/bus/mf4.py` | Changed | +31/−3 | `_test_props`, the `test` argument |
| `battery-trace-gen/generate.py` | Changed | +4 | passes the merged block |
| `battery-trace-gen/manifest.py` | Changed | +3 | `run_key`, `definitions` per trace |
| `battery-trace-gen/README.md` | Changed | +26/−1 | the seed section |
| **`battery-trace-gen/` total** | | **1184 new + ~73 changed** | |
| `frontend/types/work-order.ts` | Changed | +26 | `definition_ids`, `DefinitionImplementation` |
| `frontend/types/test-run.ts` | Changed | +7 | `definition_ids` |
| `frontend/lib/api/testDefinitions.ts` | Changed | +14 | `downloadImplementation` |
| `frontend/lib/explore/lake-partitions.ts` | Changed | +1/−2 | the session fallback |
| `frontend/components/screens/definitions/implementation-panel.tsx` | New | 118 | the panel |
| `frontend/components/screens/definitions/definition-detail-screen.tsx` | Changed | +9 | mounts it |
| `frontend/app.yaml` | Changed | +2/−2 | the session partitions |
| **`frontend/` total** | | **118 new / +59−4** | |
| `quix.yaml` | Changed | +6/−6 | `HIVE_COLUMNS`, `CONSUMER_GROUP`, session partitions |
| `docker-compose.local.yml` | Changed | +4/−4 | the local table and tree |
| `CLAUDE.md` | Changed | +13/−5 | the pointer, the partition order, `test.definitions` |
