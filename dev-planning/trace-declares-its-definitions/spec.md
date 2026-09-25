# A trace states the test definitions it answers

**Status:** Draft
**Project:** comma-car-segments-ingest
**Backlog:** BL-80
**Created:** 2026-09-25
**Planned with:** Buddy

## 1. Summary

On 2026-09-25 a person attached ten test definitions to four runs by hand — ten
`POST /test-runs/{run_id}/definitions` calls, with the mapping read out of
`battery-trace-gen/out/manifest.csv`. The pipeline should have carried that claim
itself, and every hop needed to carry it already ships. `bus/mf4.py:104` writes the
HD-comment key, `tm-connector/connector/identity.py:103-106` maps it onto
`definition_ids`, and `api/api/services/queries_runs.py:118-145` resolves the set
against the planning mirror. The only missing piece is the **data**: no scenario
puts `definitions` in its `test` block, so `bus/mf4.py:104` never fires.

This feature fills that hole and nothing else. The generator derives each trace's
definition set from the same authored `covers_req_ids` it already inverts to write
`manifest.json`, states it once in the trace's HD comment, and the existing claim
path does the rest.

## 2. Goals

- A regenerated trace states, in its own bytes, the test definitions it was built
  to answer.
- Uploading that trace registers a run whose `definition_ids` is already filled, at
  `embedded` provenance, with no human step.
- The set in the HD comment and the set in `manifest.json` come from **one**
  expression, so the two can never disagree.
- A definition the registry does not mirror costs the run nothing: the others still
  link, the unknown one is journalled.
- Two runs of `generate.py` stay sha256-identical.

## 3. Non-goals

- **Work-order creation from a claim** (BL-81). The read path is the same shape; the
  missing piece there is an insert into `work_orders`, and it is a separate ticket.
- **The platform claim** — already shipped (`bus/mf4.py:153`, `DBC_PLATFORM` on the
  decoder). Untouched.
- **Coverage computation** (BL-38) and **Covered ≠ Tested** (BL-19). A run's
  `definition_ids` is an *input* to those; filling it is not computing coverage.
- **Verdict writing** (BL-11). This spec attaches definitions to runs; deciding
  whether each passed is BL-11's job.
- **A lake column for the definition set.** `mf4-decoder/identity.py:71-74`
  `CLAIMED_COLUMNS` stays at two entries (`vehicle`, `rig_id`). The definition set is
  registry linkage, not a sample attribute.
- **New routes, new collections, new inference.** None of the three.
- **The run-id ladder.** Untouched.

## 4. User stories

1. A bench engineer regenerates the four traces and uploads them through MF4 Import,
   typing nothing. Each run's Test Run page already lists its definitions — three for
   TAS-1001, three for TAS-1002, two for TAS-1003, two for TAS-1004.
2. A person disagrees with what the trace claims, opens the Test Run page and removes
   one definition. The run's set becomes `manual` and a later re-ingest of the same
   trace leaves it exactly as the person left it.
3. A trace claims three definitions and the registry mirrors only two of them. The two
   link; the third appears in the run's journal as
   `run.definition_claim_unresolved`, and the run is not refused.
4. A reviewer opens `manifest.json` and the trace's HD comment and reads the same
   three ids in the same order.

## 5. Proposed design — the six decisions

### D1. The generator states the mapping. The registry does not derive it.

**Decision: candidate (a) — the trace states `test.definitions`.**

Two reasons, one principled and one mechanical.

*Principled.* A recording is **evidence**: it says what the bench was set up to
exercise, and it says it before anybody looks at the result. Deriving the set inside
the registry would be a **second statement of coverage** computed from the first — the
exact shape the Miro board's defect D1 refuses, and the reason `verified_by` is derived
from `covers_req_ids` rather than authored. The project already holds that line
deliberately: `manifest.py:199-211` and `seed/sources.py:49-61` both invert
`covers_req_ids` and both say in their docstrings that they are the derived direction.
This feature moves that same inversion one step earlier — into the producer that knows
the answer — rather than adding a second inference at the consumer.

*Mechanical — (b) cannot be built here at all.* "Derive the set from the definitions'
`covers_req_ids` against what the run measured" needs a bridge from measured signals to
requirements. The only bridge that exists is
`specs/battery-dc-test-specs.json` → `data_requirements.required_signals`, and it does
not discriminate: `runner.py:50` builds the scheduler from `dbc.messages`, so **every
one of the four traces emits all 8 frames and all 249 signals of `BATTERY_DC_V1` on its
cycle**. A signal-presence derivation would attach all ten definitions to all four
runs. There is no other candidate discriminator in the lake — the row shape is
`(signal, ts, value)` plus the partition keys.

So (b) loses twice: it is the wrong kind of statement, and it has no data to make it
from. No departure from BP5 is required and none is proposed.

### D2. The cost of (a), stated honestly.

Adding one `<e>` element to `<common_properties>` changes the HD comment, so **all four
sha256s move and the traces must be regenerated and re-uploaded.**

What does *not* change:

- `out/manifest.csv` — its columns are `trace_id, tc_id, req_id, expected, measurand,
  signal, limit, measured, mechanism`. No hash, and the plant run is unaffected by a
  header property, so every row is byte-identical.
- The requirements markdown the seed renders (`seed/requirements_md.py`) — it reads
  `manifest.csv`, the run key and the trace filename, all unchanged. **`python -m seed
  all` is therefore not required**; running it is a no-op.
- Determinism. `_test_props` (`bus/mf4.py:88-109`) builds its dict in a fixed key
  order and `mf4.py:187` pins `header.start_time` to the scenario's `start_time_utc`,
  which is what pins the `##FH` block. A list joined in a fixed order keeps both
  properties.

What does change: `manifest.json`'s per-trace `sha256` and `size_bytes`.

**The trap.** Re-uploading into the runs that already exist is wrong twice:

1. `mf4-decoder/idempotency.py:12-30` dedups on **content sha256**, so new bytes
   decode — which is what we want — and the decoded samples land in
   `battery_data_v1` under the same `run_id=TAS-1001/` partition. Iceberg appends.
   The run ends up holding **two full copies** of its samples, which silently
   corrupts every dwell-time and sample-count criterion BL-11 will evaluate.
2. The four runs' `definition_ids` is already at `manual` provenance from yesterday's
   hand repair, so the incoming claim is blocked (see D5) and the whole point of the
   change is invisible.

Both are removed by the same step: **delete the four runs first.**
`DELETE /test-runs/{run_id}` (`api/api/routers/test_runs.py:305-325` →
`api/api/services/run_deletion.py:251-280`) removes the lakehouse partitions, the
registered bytes and the registry rows, in that order; the Test Run page already has
the button (`frontend/components/screens/run-detail/run-detail-screen.tsx:390`). The
ten test definitions and the work order are untouched by a run delete, so the claim
resolves against a mirror that is still complete.

The exact sequence a person runs is §8.1.

### D3. Where the claim is read, hop by hop.

| # | Service | Status | Line |
|---|---|---|---|
| 0 | `battery-trace-gen` — author the set | **MISSING** | `generate.py:108` |
| 1 | `battery-trace-gen` — write the HD key | ships | `bus/mf4.py:104-105`, XML at `:73-85` |
| 2 | `mf4-to-blob` — upload | ships, **no change** | `static/mdf-header.js:34-38` |
| 3 | `mf4-decoder` — forward | ships, **no change** | `provenance.py:68-105`, `main.py:802`, `marker.py:36,56` |
| 4 | `tm-connector` — map to `definition_ids` | ships | `identity.py:103-106,109,157-162`, `bodies.py:102` |
| 5 | `api` — resolve and link | ships | `models/runs.py:399`, `queries_runs.py:105-178` |

Hop by hop:

**Hop 0 (the only change).** `generate.py:108` builds the header's `test` dict as
`{**identity.test, **scenario.test}`. Neither side carries `definitions`, so
`bus/mf4.py:104`'s guard is false for every trace today.

**Hop 1.** `bus/mf4.py:104-105` already does exactly the right thing:
`props["test.definitions"] = ",".join(test["definitions"])`. The comma-separated form
is deliberate and `_test_props`' own docstring (`:91-95`) explains why: the block is a
name→value map, so a repeated `<e name="test.definition">` could not express a set.

**Hop 2.** MF4 Import never touches it. `static/mdf-header.js:34-38` prefills only
`run_key`, `work_order`, `rig` and `vehicle` into the claim editor, so nothing
converts the definition set into a `declared.*` parameter. That is correct and stays:
the set is a property of the bytes.

**Hop 3 — no line in `mf4-decoder` reads `test.definitions`, and none should.**
`provenance.py:68-105` `parse_header_properties` returns **every** `<common_properties>`
entry, unfiltered; `main.py:802` builds the map and it rides verbatim as
`header_properties` on every batch (`main.py:1044`) and on the `file_complete` marker
(`marker.py:36,56`). `identity.py`'s `CLAIMED_COLUMNS`, `resolve_work_order` and
`resolve_run_key` are all about values the **lake partition** or the run id need; the
definition set is neither. Adding a decoder-side reader would create a second
authority for a value the connector already owns.

**Hop 4.** `connector/connector.py:181` hands `value.get("header_properties")` to
`resolve_identity`. `clean_header` (`identity.py:189-204`) walks `HEADER_LIST_FIELDS`
(`:103-106`), which maps **both** `test.definition` (singular, one-element) and
`test.definitions` (the set) onto `definition_ids`, with the plural stated second so
it wins when a file carries both. `split_ids` (`:157-162`) splits on commas and drops
blanks and surrounding space. `definition_ids` is in `LINKAGE_FIELDS` (`:109`), so a
`declared.*` value would outrank the header — nothing sends one, so the header's set
stands. `_refuse_foreign_record` (`:336-354`) drops it wholesale if the record names a
different run, which is the correct failure mode for a set. `bodies.run_body:102`
(`body.update(identity.fields)`) puts the list on the `POST /test-runs` body.

**Hop 5.** `RunUpsertRequest.definition_ids: list[str]` (`api/api/models/runs.py:399`).
`queries_runs._claimed_ids:105-115` unions the scalar `definition_id` and the list into
one sorted, deduplicated claim; `_resolve_claims:118-145` looks each id up in
`test_definitions` and puts the hits into `resolved["definition_ids"]`;
`_write_claims:152-178` writes that list with `Source.EMBEDDED`. `definition_ids` is
deliberately **not** in `_MERGEABLE_FIELDS` (`:33`), so the claim path is the single
ingestion writer of the field — no double write.

### D4. A claim naming an unknown definition.

**Decision: no new code. The existing retained-claim machinery already does the right
thing, and it must not be made to refuse.**

What happens today, for a claimed set of three where one id is unknown:

- The two known ids land in `resolved["definition_ids"]` and are written
  (`_resolve_claims:137-139`). **They are not lost.**
- The unknown id goes to `unresolved`, which produces a journal entry
  `run.definition_claim_unresolved` carrying "Claimed `X`. The planning mirror holds no
  such row." (`_unresolved_claim_events:203-219`, deduplicated against replays).
  **It is not silently dropped.**
- It is also remembered on the run as `claimed_definition_id`
  (`_retained_claims:181-200`).
- The run is **not refused**. `POST /test-runs` answers 201/200 either way.

This is deliberately different from the manual route. `POST /test-runs/{run_id}/
definitions` refuses 422 `unknown_definition` via `_require_definition:1254-1262`,
because a person who typed a wrong id can retype it; a trace already on disk cannot.
Keep both behaviours as they are.

**One named limitation, not fixed here.** `_retained_claims:193-195` uses
`first.setdefault`, so only **one** unknown id per field is remembered, and
`planning_sync._link_retained_claims`' selector (`planning_sync.py:667-675`) only fires
when `definition_ids` is empty or null. A *partial* set — two resolved, one unknown —
therefore leaves a non-empty field and is never repaired by a later sync. For this
project it cannot arise: `python -m seed catalog` mirrors all ten definitions before any
trace is uploaded (`seed/__main__.py:4-14`). Record it; do not build a repair loop for a
case the seed order prevents. See OQ2.

### D5. The `manual` tag collision (BL-47).

`_write_definition_set` (`queries_runs.py:1299-1325`) stamps
`field_sources.definition_ids` with `Source.MANUAL` on **the whole field**, whichever
single member the person added or removed. `provenance.py:42-46` ranks
`embedded` at 0 and `manual` at the top, and `set_field:241-242` returns `None` when
the stored source outranks the incoming write.

**Therefore: a re-ingest of the same trace into a run whose set is `manual` writes
nothing and journals nothing.** `set_field` returns `None`, so `_write_claims` appends
no entry — the claim is a *silent* no-op, not a visible refusal. That is the desired
precedence (the person's edit survives), but it is invisible, and it is the reason D2
insists on deleting the four existing runs rather than re-uploading over them.

**The panel warning must change.** `frontend/components/screens/run-detail/
definitions-panel.tsx:162-165` currently reads:

> Assigning a definition here makes this run's set manual — a later planning sync
> leaves it alone.

That is still true and no longer the whole truth. After this change the same tag also
outranks the run's own trace, and `embedded` ranks *below* planning, so the trace's
claim is the first thing the edit silences. Reword to name both, e.g.: "…makes this
run's set manual — a later planning sync, and the trace's own claim, both leave it
alone." Exact wording is ArchDev's; the requirement is that the sentence names the
trace. The change is a string plus whichever test pins it.

### D6. Scope boundary.

**In this feature:** the generator's `test` block, the single shared derivation, the
comments and docstrings that this makes false, and the one frontend string.

**Adjacent, and elsewhere:**

| Concern | Where it belongs |
|---|---|
| An upload creates the work order it claims | BL-81 |
| The platform claim | shipped (`bus/mf4.py:153`) |
| Computing coverage from the linked definitions | BL-38 |
| Covered ≠ Tested, version-pinned | BL-19 / BL-33 / BL-69 |
| Writing a verdict per definition | BL-11 |
| Re-uploads as file versions v1..vn | BL-68 / BL-69 |
| The set as a lake column | never — see §3 |

## 6. Work breakdown

### 6.1 One derivation, used twice — `battery-trace-gen` (ArchDev)

`manifest.py:295-298` already computes a trace's definition list inside
`manifest.build`:

```python
"definitions": [tc_ids[expectation.req_id] for expectation in run.scenario.expectations],
```

Lift it into a named function in `manifest.py` beside `test_case_ids()` (`:199-211`) —
e.g. `definitions_of(scenario, tc_ids) -> list[str]` — and call it from **both**
`manifest.build` (replacing the inline comprehension) and `generate.py`. Two callers,
one expression: the header and the manifest cannot drift.

Order: keep `scenario.expectations` order, which is the scenario file's `evaluates`
order and is what `manifest.json` already prints. Do not sort — a different order in the
two places would be a second statement. (It happens to be ascending already, and
`_claimed_ids:115` sorts on the registry side anyway, so nothing downstream depends on
it.)

Dependencies: none.

### 6.2 The generator states the set — `battery-trace-gen/generate.py` (ArchDev)

In `main()`, read the map once before the loop (`tc_ids = manifest.test_case_ids()`)
and extend the `test` dict at `:108`:

```python
test={**identity.test, **scenario.test, "definitions": manifest.definitions_of(scenario, tc_ids)},
```

No change to `bus/mf4.py`'s code — `:104-105` fires on its own once the key is present.
Do **not** put the list into `scenarios/T*.json`: those files author the requirements a
trace evaluates (`evaluates[].req_id`), and the definition ids are derived from them
through the test specs' `covers_req_ids`. Authoring them a second time in the scenario
file is exactly the duplication D1 argues against.

Depends on 6.1.

### 6.3 The comments that go false (ArchDev, same commit)

Each of these states that a trace claims no definitions. They die with the behaviour
they describe:

| File | Lines | What it says now |
|---|---|---|
| `battery-trace-gen/bus/mf4.py` | 91-95 | "written only for a scenario that declares definitions, **and none does**" |
| `battery-trace-gen/scenario.py` | 90-92 | "Definitions are assigned in the Test Manager." |
| `battery-trace-gen/manifest.py` | 291-293 | "The trace claims no definition; the run is assigned them in the Test Manager." |
| `battery-trace-gen/seed/sources.py` | 86-89 | "The trace states none of them — a run is assigned its definitions in the Test Manager." |
| `battery-trace-gen/seed/planning_payload.py` | 117-118 | "The definitions of a run are assigned by a person on the Test Run page, so planning states none." |
| `battery-trace-gen/seed/__main__.py` | 12-14 | "A run's definitions are assigned afterwards, on the Test Run page." |
| `mf4-to-blob/static/index.html` | 249-250 | "Test definitions are NOT claimed here: … that set is assigned from the Test Run page." |

`planning_payload.links()` still legitimately states no definition — planning does not
need to, because the trace does. Reword the *reason*, keep the behaviour.
`index.html`'s comment stays true about the **form** (the operator does not type them);
the reason changes from "the Test Run page assigns them" to "the recording states
them, and the Test Run page corrects them".

`tm-connector/connector/identity.py:96-106` is already accurate and needs no change.

Depends on 6.2.

### 6.4 The panel string (ArchDev)

`frontend/components/screens/run-detail/definitions-panel.tsx:162-165` per D5. Move the
string and any test that asserts it in **one** commit — `frontend/tests/components/`
holds run-detail tests that pin panel copy.

Independent of 6.1-6.3 (disjoint file set; may run in parallel).

### 6.5 Project directives (DocuGuy)

`CLAUDE.md`, "Ingestion pipeline" section, currently reads:

> A producer that also sends `test.definitions` states a COMMA-SEPARATED SET, which the
> run stores as `test_runs.definition_ids`; **ours omits it and the definitions are
> assigned from the Test Run page instead.**

Rewrite the clause after the semicolon: our traces state it, derived from the test
specs' `covers_req_ids`, and the Test Run page is the correction path. The prose is
hand-written — do not run `gen_claude_md.py` for this (that tool owns the tables only,
and no table changes).

Depends on 6.2. Backlog: flip BL-80 to **in progress** in `dev-planning/backlog.json`
in the same change that moves the work.

### 6.6 Verification (main thread + user)

§8.1. No Tester round beyond the standing lint/smoke gate.

## 7. Data & interface contracts

### 7.1 The HD-comment key

One entry inside `<HDcomment><common_properties>`, written by `bus/mf4.py:73-85`:

```xml
<e name="test.definitions">BAT-SYS-TC-001,BAT-SYS-TC-002,BAT-SYS-TC-003</e>
```

- **Key:** `test.definitions` — exactly, lowercase, singular `test.` prefix.
  `tm-connector/connector/identity.py:105`.
- **Value:** the test case ids joined by `,` with no spaces. Spaces would be tolerated
  (`split_ids` strips) but are not written.
- **Position:** after `test.description`, before `test.started_at`
  (`_test_props:99-108`). Fixed, so the bytes stay deterministic.
- **Absent** when a scenario declares no definitions — the `if test.get("definitions")`
  guard at `:104` stands unchanged.

### 7.2 The four traces

| Trace | Run key | `test.definitions` value |
|---|---|---|
| T1 | `TAS-1001` | `BAT-SYS-TC-001,BAT-SYS-TC-002,BAT-SYS-TC-003` |
| T2 | `TAS-1002` | `BAT-SYS-TC-004,BAT-SYS-TC-005,BAT-SYS-TC-006` |
| T3 | `TAS-1003` | `BAT-SYS-TC-007,BAT-SYS-TC-008` |
| T4 | `TAS-1004` | `BAT-SYS-TC-009,BAT-SYS-TC-010` |

Derived, not authored: T1's `evaluates` names `BAT-SYS-PRF-001`, `BAT-SYS-SAF-003`,
`BAT-SYS-SAF-002` (`scenarios/T1_charge_thermal.json:43,50,57`), and
`manifest.test_case_ids()` inverts the specs' `covers_req_ids` to `TC-001`, `TC-002`,
`TC-003`. The definition id **is** the test case id
(`seed/planning_payload.py:56`, `seed/sources.py:45`).

### 7.3 The wire, unchanged

`POST /test-runs` body gains a field it already declares:

```json
{"run_id": "TAS-1001", "rig_id": "battery-sim-01", "work_order_id": "WO-BAT-2026-001",
 "definition_ids": ["BAT-SYS-TC-001", "BAT-SYS-TC-002", "BAT-SYS-TC-003"],
 "source": "embedded", "actor": "tm-connector"}
```

No model change, no route change, no migration. `test_runs.definition_ids` already
exists on every document (`queries_runs.py:259`) and
`field_sources.definition_ids` will read `{"source": "embedded", ...}` instead of
`{"source": "manual", ...}`.

## 8. Risks, constraints and open questions

### 8.1 What a person runs, and what they check

From `battery-trace-gen/`:

```
python generate.py --scenario all
python generate.py --scenario all --out ..\.tmp\gen-check
```

Check, in order:

1. **Verdicts.** The printed table's `exp` column: 6 PASS / 4 FAIL, with the FAILs at
   `BAT-SYS-TC-003`, `-006`, `-008`, `-010` and nowhere else.
2. **Determinism.** The four `sha256` lines from the two runs are pairwise identical.
   If they are not, the `test` dict acquired a non-deterministic order — stop.
3. **`manifest.csv` did not move.** `git diff --stat battery-trace-gen/out/` shows
   `manifest.json` changed (`sha256`, `size_bytes`) and `manifest.csv` unchanged. A
   changed `manifest.csv` means the plant run moved, which a header property cannot do
   — stop.
4. **The key is there.**
   `python -c "from asammdf import MDF; print(MDF('out/TAS-1001_T1_charge_thermal.mf4').header.comment)"`
   contains
   `<e name="test.definitions">BAT-SYS-TC-001,BAT-SYS-TC-002,BAT-SYS-TC-003</e>`.

Then, in the Portal:

5. Delete runs `TAS-1001`…`TAS-1004` on the Test Run page (D2 — this removes the lake
   partitions and the `manual` tag together). The ten definitions and
   `WO-BAT-2026-001` survive a run delete.
6. Re-upload the four MF4s through MF4 Import, **typing nothing** in the claim editors.
7. Each Test Run page shows its definitions with no human step: 3 / 3 / 2 / 2.
   `field_sources.definition_ids.source` reads `embedded`.

`python -m seed all` is **not** required — `manifest.csv` is unchanged, so the
requirements markdown renders byte-identically. `python -m seed links` is optional
confirmation; the run's own `test.work_order` claim already links it.

### 8.2 Risks

| Risk | Mitigation |
|---|---|
| Re-uploading over the existing runs doubles their lake rows (Iceberg appends into the same `run_id=` partition) and silently corrupts BL-11's dwell/count criteria | Delete the four runs first — `run_deletion.py:251-280` removes the partitions |
| The `manual` tag makes the claim a *silent* no-op, so a failed verification looks like a code defect | D5; verification step 5 removes the tag by removing the run |
| A person's edit still wins forever afterwards, per BL-47's field-wide tag | Unchanged behaviour, now stated in the panel (6.4) |
| A partial set (some ids unknown) is never repaired by a later sync | §D4 limitation; cannot arise given the seed order. OQ2 |
| Re-upload creates a second `files` document under the same `(run_id, filename)` | Only if the runs are *not* deleted first; BL-68/BL-69 territory otherwise |

### 8.3 Open questions

- **OQ1 (user).** Delete `TAS-1001`…`TAS-1004` before re-uploading, accepting that
  their journals go with them? Recommended, and §8.1 assumes it. The alternative —
  keep them — means the claim stays invisible until some future run with a new key, and
  the lake rows double. A third option, bumping the four run keys in the scenario
  files, avoids both but strands the existing runs as orphaned history; not
  recommended.
- **OQ2 (user).** Leave the partial-set repair gap (D4) unfixed and recorded? Fixing it
  means widening `CLAIM_RETAINED` from one id to a list and relaxing
  `_link_retained_claims`' selector — machinery for a case `seed/__main__.py`'s order
  prevents. Recommendation: leave it, note it in the backlog.

## 9. Alternatives considered

- **(b) The registry derives the set from `covers_req_ids` against what the run
  measured.** Rejected on both grounds in D1: it is a second statement of coverage
  (board defect D1), and it has no discriminating input — all four traces emit all 249
  signals of `BATTERY_DC_V1` (`runner.py:50`), so it would attach all ten definitions
  to every run.
- **Author `definitions` in each `scenarios/T*.json`.** Rejected: the scenario already
  authors `evaluates[].req_id`, and the definition ids follow from those through the
  specs' `covers_req_ids`. Writing them a second time creates a pair that can drift
  silently, and the generator already inverts the map at `manifest.py:199-211`.
- **A decoder-side reader that lifts `test.definitions` onto the metadata message.**
  Rejected: `parse_header_properties` already forwards the whole block verbatim and the
  connector already owns the field. A second reader would be a second authority.
- **Extend MF4 Import's claim editor with a definitions field.** Rejected for now: the
  set is a property of the bytes, not of the upload form, and the Test Run page is
  already the correction path. It would also re-open BL-73's dirty-tracking question
  for a multi-valued field.
- **Refuse the whole upsert when any claimed id is unknown.** Rejected: ingestion never
  refuses a claim (`_resolve_claims`' docstring), and a 422 there costs the run its
  registration, not just its link.

## 10. References

- `dev-planning/backlog.json` — BL-80 (this), BL-47 (the `manual` tag is field-wide),
  BL-81 (work-order claim), BL-11 (verdict writer), BL-19 / BL-38 (coverage).
- `CLAUDE.md`, "Ingestion pipeline" and "Requirements workflow (ASPICE SYS.2)" —
  BP5, defect D1, Covered ≠ Tested.
- `dev-planning/battery-can-traces/` — the generator's own spec and architecture.
- `dev-planning/import-prefill-from-trace/spec.md` — why the claim editor prefills only
  four fields (BL-73).
- Miro board `https://miro.com/app/board/uXjVHsQqWhY=/`.
