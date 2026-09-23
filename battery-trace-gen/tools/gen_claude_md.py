"""Regenerate the project CLAUDE.md from the battery seed sources.

Tables are generated from battery-trace-gen/data/*.json, specs/*.json and out/manifest.csv
so the document cannot drift from the machine-readable seed.
"""
import csv
import json
import pathlib

GEN = pathlib.Path(__file__).resolve().parents[1]
ROOT = GEN.parent
reqs = json.loads((GEN / "data" / "battery-dc-requirements.json").read_text(encoding="utf-8"))
params = json.loads((GEN / "data" / "battery-dc-parameters.json").read_text(encoding="utf-8"))
specs = json.loads((GEN / "specs" / "battery-dc-test-specs.json").read_text(encoding="utf-8"))
backlog = json.loads((ROOT / "dev-planning" / "backlog.json").read_text(encoding="utf-8"))
manifest = {r["tc_id"]: r for r in csv.DictReader((GEN / "out" / "manifest.csv").open(encoding="utf-8"))}


ORDER = {"in progress": 0, "to do": 1, "discuss": 2, "finished": 3}


def backlog_rows() -> str:
    out = ["| ID | Status | Item | Notes |", "|---|---|---|---|"]
    for i in sorted(backlog["items"], key=lambda x: (ORDER[x["status"]], x["id"])):
        s = i["status"]
        s = f"**{s}**" if s == "in progress" else s
        out.append(f"| `{i['id']}` | {s} | {i['title']} | {i['notes']} |")
    return "\n".join(out)


def req_rows() -> str:
    out = ["| ID | Pattern | Requirement (tokens resolve against the parameter set) | Measurands |", "|---|---|---|---|"]
    for r in reqs["items"]:
        meas = ", ".join(f"`{m['name']}`" for m in r["measurand"])
        out.append(f"| `{r['id']}` | {r['ears_pattern']} | {r['text']} | {meas} |")
    return "\n".join(out)


def param_rows() -> str:
    out = ["| Parameter | Value | Used by |", "|---|---|---|"]
    for p in params["items"]:
        unit = f" {p['unit']}" if p["unit"] else ""
        out.append(f"| `{p['name']}` | {p['value']}{unit} | {', '.join(p['used_by'])} |")
    return "\n".join(out)


def tc_rows() -> str:
    out = ["| Test case | Trace | Covers | Expected | Title |", "|---|---|---|---|---|"]
    for t in specs["items"]:
        m = manifest.get(t["tc_id"], {})
        exp = m.get("expected", "?")
        exp = f"**{exp}**" if exp == "FAIL" else exp
        out.append(f"| `{t['tc_id']}` | {m.get('trace_id', '?')} | {', '.join(t['covers_req_ids'])} | {exp} | {t['title']} |")
    return "\n".join(out)


doc = f"""# comma-car-segments-ingest — project directives

Complements the global golden rules; does not restate them. Branch `jama-ui-dev`;
target environment `testrigorg-commacarsegmentsingest-jamaui`.

## Battery DC — the seed

These tables are the human-readable statement of record. The machine-readable seed
the pipeline consumes lives beside the generator and must stay identical to them:

| Artifact | Source of truth |
|---|---|
| 10 requirements (EARS, ASPICE SYS.2 attributes) | `battery-trace-gen/data/battery-dc-requirements.json` |
| 11 parameters (values the requirement tokens resolve to) | `battery-trace-gen/data/battery-dc-parameters.json` |
| 10 test cases (one per requirement, `covers_req_ids`, pass criteria) | `battery-trace-gen/specs/battery-dc-test-specs.json` |
| Expected verdicts per trace (6 pass / 4 fail, mechanism for each fail) | `battery-trace-gen/out/manifest.csv` (generated) |
| CAN database `BATTERY_DC_V1` (8 frames, 249 signals, 4 nodes) | `dcm-seed-dbc/dbc/Porsche_Taycan.dbc` |
| Spec / architecture / test reports | `dev-planning/battery-can-traces/` |

Regenerate this file with `battery-trace-gen/tools/gen_claude_md.py` after editing any
of them; never edit the tables by hand.

### Requirements
Requirement text carries `{{parameter}}` tokens; rendering substitutes `name (value unit)`.
`BMS_I_Dc` is **battery-sign: positive = discharge**, so a charge limit reads `>= -limit`.

{req_rows()}

### Parameters
{param_rows()}

### Test cases → traces
Four MF4 traces cover the ten cases; exactly four fail, each for a distinct, declared
mechanism (thermal overshoot with a stale temperature filter; SOC-map calibration anchor
at 20 % instead of 25 %; wrong relaxation time constant; heater threshold set at 3 °C).

{tc_rows()}

## Ingestion pipeline (Tomas's `1148def` line — how a trace becomes data)

```
MF4 Import  --mf4_metadata-->  MF4 Decoder  --"samples" + ONE "file_complete" marker-->  mf4-to-msg
                                     |                                         |                 |
                     resolves run_id ONCE (ladder below)          DataLake Sink -> LAKE_TABLE   tm-connector -> POST /test-runs, /files
                                                                  partitions platform/work_order/run_id
```
- **DBC comes from DCM**, not the file: `type=dbc`, `target_key=<platform>`; the decoder runs
  with `DBC_PLATFORM=Porsche_Taycan` because MF4 Import never emits `platform`. The DBC file
  must be named `<PLATFORM>.dbc` (`dcm-seed-dbc` keys by basename) and carry no `VAL_` tables.
- **Run-id ladder** (`mf4-decoder/identity.py`, mirrored by `tm-connector`): `declared.run_id`
  → HD-comment `test.run_key` → `TAS-\\d+` in the filename → minted `<platform>_<route>`.
  A batch with no run at all is dropped by the sink. HD-comment `test.*` properties feed the
  run (`test.run_key`, `test.work_order`, `test.rig`, `test.description`, …), and those are
  the only claims our traces make. A producer that also sends `test.definitions` states a
  COMMA-SEPARATED SET, which the run stores as `test_runs.definition_ids`; ours omits it and
  the definitions are assigned from the Test Run page instead.
- **Registration happens only on the `file_complete` marker.** Files decoded by an older
  decoder never register; the decoder dedups on file sha256, so re-uploading identical bytes
  is skipped — change the route timestamp to re-ingest.
- **Reproducible traces**: two runs of `generate.py` must be sha256-identical (asammdf `##FH`
  timestamps are pinned to `start_time`). `out/` is gitignored.
- Lake table is the `LAKE_TABLE` project variable (`battery_data_v1` in jamaui); `dcm_config_id`
  on every row is the DCM document id. Query API from a workstation:
  `https://lh-query-3d7475f5-testrigorg-global.testrig-depl.dev.quix.io` with a PAT.

## Seeding the Test Manager (Tomas's `api/`)

**Hierarchy (user's definition, 2026-09-22):** a **work order** is a test campaign and
contains several **test runs**; one test run (one trace / one bench session) **covers several
test definitions**; a **test definition** is one test case for one requirement. A trace claims
its work order, run key and rig from the HD comment (`test.work_order`, `test.run_key`,
`test.rig`) and nothing else; its definitions are assigned later, on the Test Run page.
- Definitions and work orders enter **only** via planning: `POST /api/v1/planning/sync` with
  `work_orders[]`, `test_definitions[{{id, work_order_id, title, planned_runs,
  requirements_files[{{name, content}}]}}]`, `links[]`. Requirements files are markdown. There
  is no `POST /test-definitions`; the in-cluster `Planning Sync Mock` is not reachable from a
  workstation. A PAT authorises the write.
- Uploaded traces link themselves to their work order through the HD-comment `test.*`
  claims; `links[]` confirms the linkage afterwards and never overwrites a `manual` edit.
  `PushedLink.definition_id` is optional and the seed omits it, so its four links state the
  work order only. Repeated `links[]` rows for one run are ADDITIVE (their definitions
  union), and a re-post answers `links_unchanged`.
- Each definition also carries one executable implementation: `POST /api/v1/test-definitions/
  {{td}}/implementation` (multipart) stores one `.py` in blob and records its sha256.
  `python -m seed all` from `battery-trace-gen/` does the whole seed.

## Backlog — everything we discuss lands here

`dev-planning/backlog.json` is the ticket store; this table is generated from it. Every item
carries one of **to do · discuss · in progress · finished**, and the status is updated in the
same change that moves the work. Nothing agreed in conversation stays only in conversation.

{backlog_rows()}

## Working agreement
- **QA is the user's**, in the Quix Portal. No Tester round unless asked; the lint/type gate
  still runs when a build touches code that has one.
- **Parallel agents** whenever their file sets are disjoint; never two agents in one file.
- **Code and comments stay aligned**: a comment that outlives the code it described is a defect.
- Commit per feature, right after its gate. Push is authorised.

## Requirements workflow (ASPICE SYS.2 — the Miro board)
Board: `https://miro.com/app/board/uXjVHsQqWhY=/` · spec artifact linked from it.
- **BP5 is what this system adds**: `verified_by` is **derived** from the test cases'
  `covers_req_ids` and never authored; coverage is computed at baseline seal, not asserted.
- **Covered != Tested.** TESTED needs a *confirmed* verifies link at `(R@v, TC@w)` **and** a pass
  for that TC in a run whose manifest pinned TC at exactly version `w`. A suspect link blocks it.
- A link goes **suspect** on a `normative_sha256` change only: `text`, `measurand`,
  `system_states`, `verification_method`, `verification_criteria`, attachment refs. `status`,
  `rationale` and `title` are excluded, so Draft -> Reviewed suspects nothing.
- Lifecycle: NEW -> Draft -> Ready for Review -> In Review -> Reviewed -> Implemented -> *Tested*
  (derived); Rejected from review; Obsolete never reuses an id.
- Refusals: `identity_unavailable` (401), `no_op_mint`, `stale_parent`, `id_reuse`.

## Environment notes
- Auto-injected Quix variables (`Quix__BlobStorage__Connection__Json`, `Quix__Lakehouse__*`)
  do not belong in `quix.yaml`; secret-typed variables bind with `variableKey`.
- Never force-push a branch an environment builds from; the Portal's clone then rejects every
  git operation. Recover with `git commit-tree <tree> -p <portal tip>`.
- Portal variable edits auto-commit to the branch: fetch and rebase before pushing.
- Parked by the user (2026-09-22): the old `backend/` Test Manager and its DCM-source design
  (`archive/dcm-source-on-old-backend`); the upstream polarity fix lives in
  `C:\\repos\\quixstreams-tests-polarity` on `fix/dc-battery-sim-polarity`, verified 53/53.
"""

(ROOT / "CLAUDE.md").write_text(doc, encoding="utf-8")
print(f"CLAUDE.md written: {len(doc.splitlines())} lines, {len(reqs['items'])} reqs, {len(params['items'])} params, {len(specs['items'])} test cases")
