# Vehicle on a trace (and the rig beside it)

## What it does

A trace can now say which physical car it came off. The claim is stated once — typed into the
import form as `declared.vehicle`, or written into the MF4's `<common_properties>` block as
`test.vehicle` — and the ingestion chain carries it to three places: a plain `vehicle` column
on every lake row, the `vehicle` field of the file registered in the Test Manager, and the
stored blob object's own user metadata (`x-ms-meta-vehicle`). The same pass carries the rig,
which was already claimed on that path and reached only the registry, into the lake as a
plain `rig_id` column.

Neither column partitions anything. `HIVE_COLUMNS` is unchanged
(`platform,work_order,run_id,~channel_name,~sender_node,~frame_name,~signal`), the table name
and the consumer group are unchanged, and no row already written is rewritten.

## Why this shape

**Plain columns, not partitions.** `QuixTSDataLakeSink._validate_existing_table_structure`
compares the on-disk Hive folders against the configured `hive_columns` at `setup()` and
raises on a mismatch, so a new partition key means a new table name and a full re-sink
(`quixstreams/sinks/core/quix_ts_datalake_sink.py:939`). A plain column costs nothing: the
table is created with a minimal schema and every column is inferred from the rows
(`:828`), so a new key appears in the parquet files written from now on and every row
written before today reads `NULL` for it. Neither field is a query-pruning dimension yet,
so `WHERE vehicle = …` scanning is the right trade.

**No sentinel.** `platform`, `device`, `route` and friends default to the literal `"unknown"`
because a null Hive key drops the row or defeats the catalog index. `vehicle` and `rig_id`
name no directory, so an unclaimed value stays `NULL` — the honest answer, and one a query
can distinguish from a car actually called "unknown". `value_text` is the precedent: it is
all-null for every numeric-only file in `battery_data_v1` and writes cleanly.

**The vehicle lives on the FILE, not on the run.** `rig_id` lives on the run
(`test_runs.rig_id`; every rig list is a `distinct()` over runs,
`api/api/services/queries_runs.py:462`) because a rig is where a session happened. A car is
what the *bytes* came off, which makes it a property of the file, exactly like
`source_system`. A run holds several files, and a file that re-links to another run must
keep its own answer rather than inherit the new run's. Putting it on the file also puts all
four copies at one grain: one file → one lake partition's worth of rows, one registry
document, one blob object. It is one claim resolved once per file and written to the stores
that serve different readers — the same relationship `run_id` and `work_order` already have
between the lake and the registry.

**`rig_id`, not `rig`, in the lake.** The registry field is `rig_id`, the declared key is
`rig_id`, and only the MF4 header spells it `test.rig` (namespaced, so it does not collide).
`work_order` is the estate's one field carrying two spellings, and `metadata.py` has a
paragraph explaining why the two readers must not drift; that wart is not worth repeating.

**`vehicle`, with no `_id`.** The value is whatever names the car — a VIN, a fleet tag, a
plate. Nothing validates its shape and nothing resolves it to an entity: there is no vehicle
registry, exactly as there is no rig registry.

**One ladder, two rungs, no mint.** Declared beats the header, for the reason every linkage
field does: a correction must not require editing the file. There is no filename rung and no
mint — a car cannot be derived from provenance the way a run id can.

## Data flow

```
import form  --declared.vehicle--> mf4-to-blob
                                     |  collect_declared() keeps it verbatim (no pattern)
                                     |  metadata.object_metadata() -> {"vehicle": ...}
                                     |
                                     +--> blob.set_object_metadata(path, meta)
                                     |      SAS path:    in /upload/complete, after the size
                                     |                   check, before the Kafka produce
                                     |      direct path: after the stream closes
                                     |      both:        fs.setxattrs -> x-ms-meta-vehicle
                                     |
                                     +--> mf4_metadata.declared.vehicle
                                                |
MF4 <HDcomment> test.vehicle / test.rig         |
                     |                          v
                     +------------------> mf4-decoder
                                            identity.resolve_claims(declared, header)
                                              vehicle <- declared.vehicle | test.vehicle
                                              rig_id  <- declared.rig_id  | test.rig
                                            file_scalars -> every batch message
                                                |                         |
                                                |                         +--> file_complete marker
                                                v                                   |
                                      mf4-datalake-sink                              v
                                        expand._expand_columnar()            tm-connector
                                        rows gain vehicle, rig_id             identity.resolve_vehicle()
                                                |                             bodies.file_body()
                                                v                                   |
                                      LAKE_TABLE (battery_data_v1)                  v
                                      plain columns, no new folder          POST /files {vehicle}
                                                                                    |
                                                                                    v
                                                                            files.vehicle -> FileDetail
                                                                            -> "Vehicle" cell on /files/{id}
```

The decoder and the connector each climb the two rungs from the same two bags (the resolved
`declared` bag and `header_properties`, both carried on the terminal marker), so they cannot
land on different answers for the same input — the same discipline
`mf4-decoder/identity.py` states for the run key.

## File inventory

| File | Change |
|---|---|
| `mf4-decoder/identity.py` | `CLAIMED_COLUMNS` (lake column → declared key, header key) and `resolve_claims()`; module docstring gained the claims paragraph |
| `mf4-decoder/main.py` | `**identity.resolve_claims(...)` in `file_scalars`; `_record_base` docstring corrected — it claimed nothing in the dict may be `None`, which was already untrue of `run_id` and `work_order` |
| `mf4-datalake-sink/expand.py` | reads `vehicle` / `rig_id` off the batch and appends both to the yielded row dict. **Required**: the sink builds its own fixed row dict, so a key on the decoder's record does not reach the parquet by itself |
| `mf4-to-blob/metadata.py` | `OBJECT_METADATA_FIELDS` + `object_metadata()`; `build_payload` docstring states why the two new claims get no second spelling |
| `mf4-to-blob/blob.py` | `set_object_metadata()` — `fs.setxattrs`, best-effort like `safe_remove` |
| `mf4-to-blob/main.py` | the stamp on both upload paths; module docstring |
| `mf4-to-blob/static/index.html` | a Vehicle input and `'vehicle'` in the `declared.*` map |
| `tm-connector/connector/identity.py` | `resolve_vehicle()`, `Identity.vehicle`, module docstring |
| `tm-connector/connector/bodies.py` | `"vehicle"` on the `POST /files` body |
| `api/api/models/files.py` | `vehicle` on `FileRegisterRequest` and on `FileBody` (defaulted, so an older document still serves) |
| `api/api/routers/files.py` | `vehicle` on the stored document and in `_EMBEDDED_FIELDS` |
| `frontend/types/file.ts` | optional `vehicle` on `FileEntity` |
| `frontend/components/screens/files/file-detail-screen.tsx` | a **Vehicle** `MetaCell`, source badge only when a car is named |
| `battery-trace-gen/scenarios/_identity.json` | `"vehicle": "WP0ZZZY1ZMSA10042"` in the shared `test` block |
| `battery-trace-gen/bus/mf4.py` | `"vehicle"` in `_test_props`' `keys` — **required**, the tuple is explicit |
| `battery-trace-gen/scenario.py`, `generate.py` | comments enumerating the shared `test.*` keys |

## Integration

- **Lake.** `dev-planning/battery-can-traces/` and the sink's partition tree are untouched. A
  reader joins `vehicle`/`rig_id` like any other column; a legacy row answers `NULL`, so use
  `IS NOT DISTINCT FROM` or tolerate nulls in an equality filter.
- **Registry.** The file document gains one key. `PATCH /files/{file_id}` does not accept it
  (`_PATCHABLE_FIELDS` is unchanged) — the car is what the pipeline resolved, and there is no
  manual repair path yet. Nothing derives a status from it and no filter reads it.
- **Contract snapshot.** `api/docs/openapi.v1.json` now lags by two more models (BL-25).
- **Traces.** All four MF4 sha256s move: the HD comment gains `test.vehicle`. The manifest's
  expected verdicts do not depend on the header block and are unchanged.
