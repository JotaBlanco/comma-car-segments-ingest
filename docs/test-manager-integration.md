# Test Manager integration

The MF4 pipeline registers every upload in the Test Manager, and the lake is partitioned by
the Test Manager's traceability chain. This page is the map; `quix.yaml` is the authority.

The stack was ported from `va-pcap-pipeline`, which had itself taken it from an MF4 estate —
so most of this is a return trip, and `tm-connector` in particular is back on the two topics
it was written for.

## The flow

```
                   declared.work_order_id / definition_id / run_id (optional)
                                        │
browser ──POST bytes──▶ mf4-to-blob ──mf4_metadata──▶ mf4-decoder ──mf4-to-msg──▶ mf4-datalake-sink
                                          │                    │  kind:"samples"       │
                                          │                    │                       └─▶ LAKE_TABLE
                                          │                    └── kind:"file_complete" ──┐
                                          │                        (one per file)         │
                                          ▼                                               ▼
                                  tm-connector (metadata lane)              tm-connector (batch lane)
                                  POST /test-runs                           POST /test-runs, /files, /journal
```

1. **mf4-to-blob** streams the bytes to blob storage and produces one `mf4_metadata` message.
   The upload page's identity card takes an optional work order, test definition, run id and
   rig; they travel as `declared.*` (the registry's own field names) and, for the lake, as
   top-level `work_order` and `test_definition`. **A claim can ride in the filename** —
   `HYUNDAI_IONIQ_WO-2026-0851_TD-BAT-THERM_<route>_20.mf4` — and a claim typed on the page
   always wins.
2. **mf4-decoder** copies the identity onto every batch, tags each one `kind:"samples"`, and
   after the last batch emits ONE `kind:"file_complete"` marker carrying the file's whole
   signal inventory — unit, dtype, rate and min/max/mean/std/rms per signal, measured in
   process over each channel's own array (`mf4-decoder/inventory.py`).
3. **tm-connector** (deployed as *TS Metadata sink*) is the only app that knows the Test
   Manager exists and the only one holding its token. The metadata lane registers the run the
   moment the upload lands; the batch lane registers the file, its inventory and its timeline
   on the marker.
4. **The registry** links the claim when planning holds the work order; otherwise the run sits
   `awaiting_work_order` (amber) until the planning mock's next sync.

Both kinds ride ONE topic and the readers tell them apart by `kind`: the sink expands
`samples` and skips the marker, the connector accumulates `samples` and finalizes on the
marker. A batch with **no** `kind` is one the pre-integration decoder wrote, and both readers
still treat it as samples — which is what makes `AUTO_OFFSET_RESET=earliest` safe over the
backlog the topic already holds.

## 🔴 One run key, four rungs, two implementations

The decoder writes a file's samples into `run_id=<value>/`; the connector catalogues that
file's signals in the registry under the run IT resolved. If the two differ, the registry
holds a complete catalogue, the lake holds the rows under a name nothing in the registry
knows, a query for the run answers nothing, and **every step reports success.**

So one ladder is implemented twice — `mf4-decoder/identity.py` and
`tm-connector/connector/identity.py` — and `tests/test_run_key_agreement.py` runs both over
the same message and compares:

| Rung | Source | Why there |
|---|---|---|
| 1 | `declared.run_id` | An operator's assignment, made before any byte was written. A re-upload with a corrected id would otherwise need the file edited. |
| 2 | `header_properties["test.run_key"]` | A producer that states the run INSIDE the file. A measured property of these bytes, so it beats a name. |
| 3 | the filename, via `TM_RUN_KEY_PATTERN` | Last resort. **One project variable, two readers** — a different pattern on either side is the silent split above. |
| 4 | `<platform>_<route>`, minted by the decoder | Nothing upstream can reach it: an ordinary comma recording states its identity only in its own provenance block. Every SEGMENT of one route then lands in one run. |

Rung 4 is written back into the `declared` bag the decoder forwards, so the connector reads it
on rung 1 and **cannot** climb to a different answer. A file that reaches none of the four
registers with `run_id: null` and the registry's deliberate quarantine; its rows are dropped
by the sink rather than written under `run_id=unknown/`, which would be a directory that reads
like a real run and holds every unplaceable file in the estate.

## One table, one partition tree

    platform / work_order / test_definition / run_id     (~channel_name ~sender_node ~frame_name ~signal virtual)

`work_order` / `test_definition` are `unassigned` when nobody claimed the file — an absent
claim is a fact, not a fault. `device`, `route`, `segment` and `dcm_config_id` are still on
every row and still queryable; they are no longer directory levels, because `run_id` is minted
from platform and route and a level under it would only repeat what the level above says.

`platform` prefers what the FILE says: the MF4's own header names the vehicle, which beats any
plan. The `WorkOrder` configuration the Test Manager API pushes to Dynamic Configuration
(`api/api/config_push.py`, `content.project`) is consulted only when the header named none —
that keeps the pushed configuration load-bearing without letting a planning value overwrite a
measured one.

Changing the tree means a NEW `LAKE_TABLE` (the sink refuses an in-place repartition) and a
new consumer group on the sink.

## Dynamic Configuration, twice

This estate reads Dynamic Configuration on two independent paths, and they do not overlap:

| Consumer | Type | Reads |
|---|---|---|
| `mf4-decoder` | `dbc` | The CAN database for a file's platform, seeded by `dcm-seed-dbc`. Existed before this integration. |
| `mf4-datalake-sink` | `WorkOrder` | `$.project` as the platform FALLBACK, pushed by the Test Manager API when planning mirrors a work order. New. |

## Project variables

| Variable | Set by | Read by |
|---|---|---|
| `LAKE_TABLE` | you | the sink (writes), tm-connector, the API, the frontend |
| `TM_API_TOKEN` (secret) | you | the API, the planning mock, tm-connector, the frontend |
| `TM_RUN_KEY_PATTERN` | you | mf4-decoder, tm-connector |
| `mongo_password` (secret) | existing | the API, the Configuration Manager, the explorer |

`tests/test_architecture_law.py` pins each of these to every deployment that must bind it, and
pins that no deployment states one literally instead.

## Services that came across

| Directory | Deployments | Changed here |
|---|---|---|
| `api/` | Test Manager - API, Planning Sync Mock | Mongo pieces point at this estate's `mongodb`; `MF4_IMPORT_URL` at mf4-to-blob; `mock_planning`'s adoption themes and cast are the car estate's |
| `frontend/` | Test Manager - Frontend | lake partition defaults; the Workbooks nav entry is gated on `TM_FTS_URL` |
| `tm-connector/` | TS Metadata sink | back on `mf4_metadata` / `mf4-to-msg`; `format` default `MF4` |
| `mongo-explorer/` | Mongo Data Explorer | points at `mongodb` / `admin` |

**Not ported: the Flight Test Station.** It is an aviation instrument panel (attitude
indicator, heading tape) over the lake, and it has no meaning for CAN recordings. Its client
code still ships inside `frontend/station/`, reached through `/api/fts`; with `TM_FTS_URL`
empty the run screen's station panel and the Workbooks nav entry hide themselves. Set that
variable and both light up against whatever is deployed there.

## The registry's seed

The planning cast in `api/mock_planning/fixture.json` is the MF4 estate's own — six work
orders over two vehicle programmes, and the cast `api/seed/` is written against. It is a
PLACEHOLDER for the comma-car campaign, and the Airbus A350 campaign that replaced it in the
PCAP estate is deliberately not here.

A claim planning has never heard of is not stranded: `mock_planning/demo_admin.py` adopts it,
themed from the definition id's family (`TD-BAT-…` → HV battery, `TD-ACC-…` → adaptive cruise
control), and names the platform from the run's own rig. So an upload can claim any pair and
still link.

## Running it

| What | Command |
|---|---|
| Pipeline contract and law tests | `pytest -q` |
| tm-connector's own suite | `pytest tm-connector/tests -q` |
| The registry's own suite (needs Docker) | `cd api && pytest tests -q` |
| The frontend's own suite | `cd frontend && npm run test:all` (needs Node >= 22) |
| The whole chain locally | `docker compose -f docker-compose.local.yml up -d --build` |
| ...plus the sink and the UI | add `--profile sink --profile ui` |
| Seed the CAN databases locally | `docker compose -f docker-compose.local.yml run --rm --no-deps dcm-seed-dbc` |

The three Python suites are **separate invocations**: `tests/` and `tm-connector/tests/` are
both packages named `tests`, so naming them in one command collides.

Locally the Test Manager API is on http://localhost:18200 (bearer `local-ingest-token`),
MF4 Import on :18400, tm-connector's `/status` on :18500 and the frontend on :18300. There is
no QuixLake locally, so the statistics DETAIL screens answer 503; the run, file and signal
screens work on the numbers the pipeline measured.

### Deploying

Set the four project variables above, then bring up in this order — planning starts OFFLINE by
design, and the registry's first sync would otherwise mirror nothing:

1. **MongoDB**, **Dynamic Configuration Manager**, **Test Manager - API**, **Planning Sync
   Mock**.
2. **Bring planning online** — the toggle in the Test Manager's top bar, or
   `POST /api/v1/planning-sync/toggle` with `{"online": true}` and the bearer. While the
   switch is off every planning read answers 503.
3. **MF4 Import**, **MF4 Decoder**, **TS Metadata sink**, **MF4 DataLake Sink**.

The decoder and the sink both carry new consumer groups, so every stored file is re-decoded
with its identity into the new table and registered on first start.
