# comma-car-segments-ingest — project directives

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
Requirement text carries `{parameter}` tokens; rendering substitutes `name (value unit)`.
`BMS_I_Dc` is **battery-sign: positive = discharge**, so a charge limit reads `>= -limit`.

| ID | Pattern | Requirement (tokens resolve against the parameter set) | Measurands |
|---|---|---|---|
| `BAT-SYS-PRF-001` | StateDriven | While the battery system is in the Charging state, the battery system shall limit the DC charging current to not more than {I_current_Chr_Max}. | `i_dc_chg` |
| `BAT-SYS-FUN-001` | Ubiquitous | The battery system shall determine the technical state of charge by integrating the measured DC current over time. | `soc_technical`, `i_dc`, `t` |
| `BAT-SYS-FUN-002` | Ubiquitous | The battery system shall derive the customer state of charge from the technical state of charge by a linear mapping in which a technical state of charge of {SOC_tech_at_cust_0pct} yields a customer state of charge of 0 % and a technical state of charge of {SOC_tech_at_cust_100pct} yields a customer state of charge of 100 %, clamped to the range 0 % to 100 %. | `soc_technical`, `soc_customer` |
| `BAT-SYS-PRF-002` | EventDriven | When the battery system enters the Sleep state, the battery terminal voltage shall converge to the open-circuit voltage within {t_transient_Voltage_sec}. | `u_dc`, `u_ocv`, `t` |
| `BAT-SYS-FUN-003` | StateDriven | While the battery system is in the Sleep state, the battery system shall equalise the cell voltages by the active discharge mechanism. | `u_cell_min`, `u_cell_max`, `balancing_active` |
| `BAT-SYS-SAF-001` | Ubiquitous | The battery system shall maintain the battery terminal voltage within the range {Udc_min} to {Udc_Max}. | `u_dc` |
| `BAT-SYS-SAF-002` | Ubiquitous | The battery system shall limit the battery temperature to not more than {T_batt_max}. | `t_batt` |
| `BAT-SYS-SAF-003` | StateDriven | While the battery temperature is not less than {T_batt_max} minus {T_batt_safety_threshold} and not more than {T_batt_max}, the battery system shall apply to the actual charging current limit a derating factor that decreases linearly from 1,0 to 0,0 across that band. | `t_batt`, `derating_factor`, `i_dc_chg` |
| `BAT-SYS-FUN-004` | Ubiquitous | The battery system shall provide the heater states 0, 1 and 2, corresponding to the heater being off, the heater operating at {P_heater_middle} and the heater operating at {P_heater_max}. | `heater_state`, `p_heater` |
| `BAT-SYS-FUN-005` | UnwantedBehaviour | If the battery temperature is below {T_batt_min}, then the battery system shall command heater state 2. | `t_batt`, `heater_state`, `p_heater` |

### Parameters
| Parameter | Value | Used by |
|---|---|---|
| `I_current_Chr_Max` | 300 A | BAT-SYS-PRF-001 |
| `t_transient_Voltage_sec` | 600 s | BAT-SYS-PRF-002 |
| `Udc_min` | 720 V | BAT-SYS-SAF-001 |
| `Udc_Max` | 840 V | BAT-SYS-SAF-001 |
| `T_batt_max` | 60 degC | BAT-SYS-SAF-002, BAT-SYS-SAF-003 |
| `T_batt_safety_threshold` | 5 degC | BAT-SYS-SAF-003 |
| `P_heater_middle` | 500 W | BAT-SYS-FUN-004 |
| `P_heater_max` | 2000 W | BAT-SYS-FUN-004 |
| `T_batt_min` | 5 degC | BAT-SYS-FUN-005 |
| `SOC_tech_at_cust_0pct` | 25 % | BAT-SYS-FUN-002 |
| `SOC_tech_at_cust_100pct` | 90 % | BAT-SYS-FUN-002 |

### Test cases → traces
Four MF4 traces cover the ten cases; exactly four fail, each for a distinct, declared
mechanism (thermal overshoot with a stale temperature filter; SOC-map calibration anchor
at 20 % instead of 25 %; wrong relaxation time constant; heater threshold set at 3 °C).

| Test case | Trace | Covers | Expected | Title |
|---|---|---|---|---|
| `BAT-SYS-TC-001` | T1 | BAT-SYS-PRF-001 | PASS | DC charging current held at or below I_current_Chr_Max |
| `BAT-SYS-TC-002` | T1 | BAT-SYS-SAF-003 | PASS | Charging current derating ramps linearly to zero across the safety band |
| `BAT-SYS-TC-003` | T1 | BAT-SYS-SAF-002 | **FAIL** | Battery temperature held at or below T_batt_max |
| `BAT-SYS-TC-004` | T2 | BAT-SYS-FUN-001 | PASS | Technical state of charge tracks the integrated DC current |
| `BAT-SYS-TC-005` | T2 | BAT-SYS-SAF-001 | PASS | Terminal voltage stays inside the Udc_min to Udc_Max window |
| `BAT-SYS-TC-006` | T2 | BAT-SYS-FUN-002 | **FAIL** | Customer state of charge maps linearly from the technical value |
| `BAT-SYS-TC-007` | T3 | BAT-SYS-FUN-003 | PASS | Cell voltages equalise while the battery system sleeps |
| `BAT-SYS-TC-008` | T3 | BAT-SYS-PRF-002 | **FAIL** | Terminal voltage relaxes to the open-circuit voltage within the budget |
| `BAT-SYS-TC-009` | T4 | BAT-SYS-FUN-004 | PASS | Heater provides the three specified power states |
| `BAT-SYS-TC-010` | T4 | BAT-SYS-FUN-005 | **FAIL** | Heater commanded to maximum below the minimum battery temperature |

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
  → HD-comment `test.run_key` → `TAS-\d+` in the filename → minted `<platform>_<route>`.
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
  `work_orders[]`, `test_definitions[{id, work_order_id, title, planned_runs,
  requirements_files[{name, content}]}]`, `links[]`. Requirements files are markdown. There
  is no `POST /test-definitions`; the in-cluster `Planning Sync Mock` is not reachable from a
  workstation. A PAT authorises the write.
- Uploaded traces link themselves to their work order through the HD-comment `test.*`
  claims; `links[]` confirms the linkage afterwards and never overwrites a `manual` edit.
  `PushedLink.definition_id` is optional and the seed omits it, so its four links state the
  work order only. Repeated `links[]` rows for one run are ADDITIVE (their definitions
  union), and a re-post answers `links_unchanged`.
- Each definition also carries one executable implementation: `POST /api/v1/test-definitions/
  {td}/implementation` (multipart) stores one `.py` in blob and records its sha256.
  `python -m seed all` from `battery-trace-gen/` does the whole seed.

## Backlog — everything we discuss lands here

`dev-planning/backlog.json` is the ticket store; this table is generated from it. Every item
carries one of **to do · discuss · in progress · finished**, and the status is updated in the
same change that moves the work. Nothing agreed in conversation stays only in conversation.

| ID | Status | Item | Notes |
|---|---|---|---|
| `BL-04` | **in progress** | Upstream plant polarity fix (dc-battery-sim, battery-sign current) | verified 53/53 in C:/repos/quixstreams-tests-polarity; commit there, then re-vendor here |
| `BL-20` | **in progress** | Status lifecycle NEW/Draft/Ready for Review/In Review/Reviewed/Implemented/Tested + Rejected/Obsolete | user 2026-09-25 set the policy: 'moving to rady for review, to draft, rejected or obsolete can be done freely, ready for rweview -> review must pass review -> implemented/tested must be by TRun coverage'. SPEC DONE dev-planning/requirement-status-gates/spec.md, building. The derived half ALREADY SHIPS: Implemented and Tested are projections of verification_state (Implemented = exercised|failed, Tested = tested), computed from run coverage on every read, never stored - so a regression needs no fallback rule, evidence_stale already degrades tested -> exercised. Net new: one table module, one check in patch_requirement, a mirror guard for planning_sync's status:'' write, a detail-header status control, refusal code illegal_transition (409). DEPARTURE FROM THE MIRO BOARD, accepted by the user: the board has Implemented set by the developer; the user put it under run coverage. CONSEQUENCE: Reviewed is unreachable until the review page (BL-32) ships, so a requirement can reach Ready for Review and stop - the disabled control has to say so. Retirement is final, a planning push stating a derived status is skipped silently |
| `BL-22` | **in progress** | Requirement status moves automatically when a run covers it; covering run id visible on the requirement | SPEC DONE (dev-planning/requirement-status-from-runs/spec.md) — not built |
| `BL-32` | **in progress** | Review page — review a requirement or a test definition | SPEC DONE (dev-planning/review-page/spec.md) — not built. SPEC REVISED 2026-09-25 (rev 2) against the shipped status gate: dev-planning/review-page/spec.md. A review is a REV-nnn doc in a new 'reviews' collection; requirements join only from Ready for Review and the join fires -> In Review; one open review per requirement. Decisions go through ONE route POST /reviews/{id}/decisions taking req_ids[] - a single decision is a list of one - answering {applied[], refused[{req_id, code, detail}]}: partial apply, always reported, because nothing in api/ opens a Mongo session so atomic would mean a hand-rolled rollback across three collections. Comment required on reject (409 comment_required), optional on accept, one per call. BL-71's demote-to-Draft kills rev-1's whole reviewed_stale machinery. Acceptance confirms NO link - traceability_links is unbuilt (BL-69). 4 OPEN QUESTIONS for the user, chief one: the person barred from accepting is the requirement's CONTENT AUTHOR (solo demo works, since every author is planning-sync today) rather than the review opener (solo demo blocked). REV 3, all four questions answered by the user 2026-09-25: (1) the requirement's CONTENT AUTHOR is barred from accepting, per-member, 409 self_review_refused - solo demo works; (2) a rejection lands in a NEW 'Changes requested' status, NOT Rejected - a NAMED DEPARTURE from the Miro board, recorded in spec §9 with the user's decision as the reason so it is not 'fixed' back. Rejected now means refused outright, Changes requested means needs rework; path back is band A to Draft or Ready for Review (coordinator decision); (3) ONE comment for a bulk rejection, each member still journalled with it, required for rejected AND changes_requested; (4) an ASSIGNEE, no due date. The assignee is grounded in the Portal's real user list - GET /users returns 14 users for this org and is reachable with the PAT, so NO user collection is invented; stored as a SNAPSHOT {user_id, display_name, email} so a departed person still renders and simply leaves the picker. The assignee GATES NOTHING - a second gate would compete with the author rule and make an unassigned review undecidable. 'Assigned to me' filters server-side because view_counts is whole-table. Spec has no open questions left |
| `BL-33` | **in progress** | Versioned verifies-link between requirement and test definition, stored in the database | user 2026-09-22: hyperlinks both ways carrying the version of each side. Board model: link_id = link_type|from_id|to_id with NO version in the preimage, recording the confirmed pair (R@v, TC@w) separately from current versions; the difference is what makes a link suspect. Folded into dev-planning/review-page |
| `BL-36` | **in progress** | Review window functional — not just a queue | SPEC DONE (dev-planning/review-page/spec.md) — not built. Folded into BL-32's rev-2 spec |
| `BL-75` | **in progress** | second_actor is accepted on a requirement PATCH, then silently dropped | found while speccing BL-20. queries_requirements.py:607-609 lists second_actor in body.model_dump(exclude={...}); it appears EXACTLY ONCE in api/api/ outside the models - in that exclude set. Never stored, never compared. Meanwhile edit-requirement-dialog.tsx:166 computes needsSecondActor = status === 'Reviewed' and gates Save on it, so the four-eyes guard is theatre: the UI demands a second name and the API throws it away. Fixed with BL-20 by journalling it, so a four-eyes claim is auditable. Deliberately NOT building an approval workflow around it - that is the review page's job (BL-32) |
| `BL-78` | **in progress** | Runs list shows whether a run was evaluated; a definition shows Passed/Failed and its last run | user 2026-09-25: 'test run overview doesn't make sence, tehre is no status if it was run or not, it showing TD assigned to it but only one, remove it' and 'test definition should cahnge status from on plan to Passed or Failed and Id of last testrun'. Two separate defects: the Definition column reads definition_id, the LEGACY scalar kept for old readers (models/runs.py:127-129) while a run carries definition_ids; and the Status column is INGESTION status (complete = data arrived), not evaluation. Verdicts are written and live. Following the Requirements screen's shipped idiom rather than the user's literal wording: status (plan adherence) KEPT and a derived Verification added beside it, because on_plan and Passed are different facts - 'Status is what people decide. Verification is what the runs prove.' Both folds derived on read, never stored |
| `BL-19` | to do | Covered != Tested: TESTED needs a confirmed link at (R@v,TC@w) AND a pass pinned to TC version w | shapes BL-11 (running implementations -> verdicts) |
| `BL-24` | to do | No verdict concept: results carry no pass/fail and name no definition | STALE as written: Verdict/VerdictOut, the POST path and the consuming fold shipped at d9dd5d4. What is missing is the WRITER — BL-11 |
| `BL-25` | to do | Regenerate api/docs/openapi.v1.json (api/scripts/snapshot.sh) | 3 models gained fields, 2 routes added — contract-snapshot test red until refreshed |
| `BL-26` | to do | Requirements page in the Test Manager (list + detail) | SPEC DONE (dev-planning/requirements-page/spec.md) — not built |
| `BL-27` | to do | Requirement attribute columns per the Miro SYS.2 board | SPEC DONE (dev-planning/requirements-page/spec.md) — not built |
| `BL-28` | to do | Work order carries the list of requirements to be tested in it | user 2026-09-22: a campaign states its requirement scope. Feeds the work-order page and the Covered/Tested rollup; interacts with BL-23 (requirements as entities) and requirement-status-from-runs OQ4 |
| `BL-31` | to do | 5 red tests in tests/test_import_claim.py after the definition claim was dropped | test_a_path_unsafe_id_is_refused[definition_id] x5, test_a_claim_in_the_filename_is_read, test_a_typed_claim_beats_the_filename, test_the_claim_rides_in_both_spellings, test_the_declared_bag_survives_the_connector_s_filter; plus test_sink_partitioning.py::test_the_declared_tree_is_the_traceability_chain already red |
| `BL-34` | to do | Requirements and test definitions need item_version + content_sha256 + normative_sha256 | Requirement half SHIPPED: planning_sync mints item_version/content_sha256/normative_sha256 and RequirementDetail serves them (verified live 2026-09-24). The TEST DEFINITION half does not exist and is the hard prerequisite for BL-69's link store |
| `BL-35` | to do | Authoring controls on every page: add / edit / remove | SPEC DONE (dev-planning/authoring-controls/spec.md) — not built |
| `BL-37` | to do | Evaluator: run a test case against a trace and produce a verdict | was tm-evaluator (criteria engine + readiness trigger, group_by(test_run_id)+State). Now nothing evaluates; BL-11 is its replacement for the battery set |
| `BL-39` | to do | Baselines: seal a named set of requirement versions (GET/POST /baselines) | existed on the old backend; the board's model (members[] manifest owned by the baseline, member_index_sha256 diff, derived reverse index). Blocked on BL-34 versions |
| `BL-40` | to do | Run execution and status: /runs/{id}/execute, /status, /summary, /series, /traces | the old backend drove an evaluation run and served its progress and series; nothing does today |
| `BL-41` | to do | Report generation per run (rendered report + report-completed) | old report_service; regenerable years later from the stored result documents |
| `BL-42` | to do | Test-vectors sink: decoded vectors into per-raster Iceberg tables | was test-vectors-sink (4 topics -> acc_pt_can_100hz etc. via QuixTSDataLakeSink). The battery line sinks raw CAN rows instead — decide whether per-raster tables are still wanted |
| `BL-43` | to do | Mongo writer: stream results/summaries/verdicts into queryable collections | was mongo-writer with a custom document_matcher per collection; the new api/ writes its own Mongo, so this may be obsolete — confirm |
| `BL-44` | to do | Parameter sets as DCM config events (/parameters, config-events) | the old chain turned parameter sets into DCM-shaped config events; our battery parameters are a DCM document but nothing consumes them at runtime |
| `BL-48` | to do | Six run-detail tests mock @/lib/hooks wholesale and now throw on useWorkOrder | GROWN: the six wholesale @/lib/hooks mocks now also need useAddRunDefinition, useRemoveRunDefinition and useTestDefinitions; frontend/tests/components/definitions-screen.test.tsx needs useTestDefinitionFacets and two changed empty-state strings |
| `BL-51` | to do | Test Results page: requirement coverage, pass/fail counts, per-run outcomes | SPEC DONE (dev-planning/test-results-page/spec.md) — not built. GET /coverage + page at /test-results; needs BL-11 to write verdicts into the SHIPPED processed_results.verdict block. SPEC BEING REVISED 2026-09-25: much of it already shipped. GET /requirements already serves view_counts and it is LIVE with real verdicts - {all:10, not_covered:0, covered:0, exercised:5, failed:2, tested:3}. The gap is the page itself plus a test-definition rollup; /coverage is 404. The honesty problem the spec must name: the board's TESTED needs a confirmed link at (R@v,TC@w) AND a pass pinned to TC version w, and neither the link store (BL-69) nor definition versions (BL-34 half) exist - so this page cannot honestly say TESTED and must say what it does count. SPEC REVISED (rev 2): covered reqs are SERVED but unrendered (no coverage figure anywhere), passed reqs are SERVED AND RENDERED (view_counts.tested, quick view + Verification column), passed TD is the ONLY real gap - TestDefinitionRow (models/planning.py:62-83) carries no outcome. Keeps the word Tested, reusing the shipped five-word verification vocabulary rather than inventing a sixth, plus a PERMANENT header note that ASPICE Tested needs a confirmed link (BL-69) and a TC version (BL-34), neither stored, and that Coverage counts AUTHORED links. One percentage, no compliance score. Page at /test-results, sidebar after Traceability, estate-wide (main thread's call on the one open question). Cuts listed in spec §0. TWO RISKS: it moves two maps out of queries_requirements._fold_inputs into a shared module, touching the LIVE Requirements page; and TestDefinitionPage gaining a required view_counts changes the envelope for the definitions screen, the traceability screen and the six already-red BL-48 mocks. COLLIDES WITH BL-78, which is adding the definition verdict fold right now - the page must CONSUME that fold, never build a second one |
| `BL-59` | to do | PLANT_ORIGIN sha256 lines mix CRLF-worktree and LF-blob conventions | signals.json's hash matches CRLF worktree bytes; lexicon.py and parameters.json match the LF git blob; main.py's old hash matched neither (stale since 8d7847e). The two refreshed lines are LF git-blob and name the command; the signals.json line still is not |
| `BL-62` | to do | Battery Sim widgets movable and resizable like a Quix Portal dashboard | user 2026-09-23. SPEC DONE (dev-planning/battery-sim-ui-grid/spec.md): GridStack 13.3.0 pinned (14.0.0 changed the float API), vendored to battery-sim-ui/static/ with Bootstrap, layout in localStorage, ResizeObserver redraws the chart canvas. Assets already fetched |
| `BL-66` | to do | One test case across several work orders, keyed by SW version | user 2026-09-23. SPEC DONE (dev-planning/tc-across-sw-versions/spec.md) — not built. test_runs.sw_version is evidence, work_orders.sw_version is intent, neither resolves the other. definitions.work_order_id -> work_order_ids[]; 'orphaned' keeps its meaning. verification_state_by_sw partitions the fold so a pass on build A survives a fail on build B. Deploy is a no-op: no lake partition change, no re-sink |
| `BL-67` | to do | delete_work_order cascades to definitions — data loss once a definition is shared | queries_runs.py:1870 delete_many({'work_order_id': wo_id}). Correct TODAY because a definition names one work order; the moment BL-66 makes them shared this deletes a definition another campaign still uses. Fix with BL-66: pull the id and delete only definitions left with an empty list |
| `BL-68` | to do | Files: surface version_group and post re-uploads to the versions route | version/supersedes/version_group and POST|GET /files/{id}/versions all exist already. Missing: the connector posting to the versions route when a run already holds that filename ((run_id, filename) is the logical key), FileBody.version_group on the wire, and a 'v2 of 3' cell. No stored field, no migration |
| `BL-69` | to do | Human-readable file versions (v1..vn) per re-run, and a link store carrying both ends' versions | user 2026-09-24. SPEC DONE (dev-planning/versions-and-links/spec.md) — not built. Same logical file = (run_id, filename); the registry forms the chain in register_file_document, not the connector, because two concurrent markers would both mint a root. File versions deliberately do NOT touch links: a link joins two specifications, a trace is evidence, and provenance.input_file_ids already pins the file version. Link store 'traceability_links', _id = link_type|from_id|to_id with no version in the preimage; the confirmed pair rides as four fields. No create route - confirming creates the document, because an authorable link set would be a second statement of coverage (defect D1) |
| `BL-76` | to do | Bulk run buttons: one atop a test run, one over selected runs on the list | user 2026-09-25. SPEC DONE dev-planning/bulk-run-buttons/spec.md - not built. RUN_CONCURRENCY=3 enforced in the BROWSER, no bulk route: the verdict is written by the per-pair polling GET (definition_runs.py:156-158 calls record_verdict inside get_definition_run), so a bulk POST would leave the expensive half untouched. An empty lake does NOT block - verdict_notebook.py:89-91 turns any exception into a recorded ERROR verdict, and a pre-flight check is the construct the directives refuse. Zero API change; the runs-list multiselect and RunsBatchBar already exist |
| `BL-77` | to do | The implementation .py is copied into the run's blob folder and listed in its Files tab | user 2026-09-25: 'there should be *.py added to blob storage to taht test and listed in files tab', completing the co-location asked for earlier (jama_ui -> test_run_id -> .mf4 and .py). Today the trace sits in jama_ui/TAS-1001/ and the implementation in jama_ui/unassigned/, because the upload route is per-DEFINITION and one definition serves many runs. SPEC DONE dev-planning/implementation-as-run-file/spec.md. Written by the API at run start - POST .../run already injects FileBytesProvider/Writer for ensure_notebook, so zero new deps. Key <digest8>-<filename>: the digest stops a re-run overwriting the bytes a stored verdict's tool_version cites. New role field recording|evaluator; _input_file_ids gains role {$ne: evaluator} so a verdict never claims it read its own evaluator, and $ne matches missing keys so the four traces need no backfill. Sets no version fields - BL-69 forms the chain in register_file_document. BLOCKED on BL-78: both edit queries_runs.py |
| `BL-13` | discuss | TM_RUN_KEY_PATTERN is an unbound project variable on decoder + connector (literal string) | harmless for us (header rung); tell Tomas |
| `BL-14` | discuss | Legacy rows: 4 battery routes in mf4_signals_v5 (pre-marker decode) | leave or delete |
| `BL-15` | discuss | Requirements seeding into the new TM model (requirements-files per definition) | seed markdown covers it per definition; direct upload route exists |
| `BL-17` | discuss | verified_by must be DERIVED from covers_req_ids, never authored (SYS.2 BP5, Miro) | we currently WRITE verified_by into battery-dc-requirements.json — conflicts with the board's D1 rule |
| `BL-18` | discuss | verification_criteria: new mandatory authored field on requirements (Miro) | today pass criteria live only on the test spec; board wants it on the requirement and agreeing with the spec |
| `BL-45` | discuss | ReqIF import/export round-trip | the board names ReqIF as the exchange format an OEM asks for (BP6); the old line had a ReqIF parser and canonical JSON. Nothing in api/ reads or writes it |
| `BL-46` | discuss | Requirements schema + validation (requirement-1.0.0.schema.json and friends) | the old backend validated every artifact against a JSON schema on ingest. The new line has none; our battery set is validated only by the generator |
| `BL-50` | discuss | Spec contradiction: requirements page says not editable, authoring-controls gives full CRUD | requirements-page/spec.md vs authoring-controls/spec.md; the user asked for add/edit/remove on that page |
| `BL-58` | discuss | Battery Sim UI loads Bootstrap from jsDelivr — unverified against the Portal's CSP when framed | page.py links cdn.jsdelivr.net with no SRI (a wrong hash silently kills the stylesheet). If the dashboard renders unstyled inside the Portal frame, vendor the one CSS file into battery-sim-ui/ — spec battery-sim-ui-v2 OQ6 documents the fallback |
| `BL-64` | discuss | Car visual: no freely-licensed clean-background Taycan image exists | user asked for an internet image. Commons' CC BY 4.0 side view is a showroom photo with bystanders, a PORSCHE floor mat and a crest banner; press renders are copyrighted. Plan: redraw as a proper vector (scales, recolours, wheels genuinely spin). User can drop a licensed asset into battery-sim-ui/static/ instead |
| `BL-65` | discuss | Plant derates DISCHARGE current, but SAF-003 specifies derating only for charging | plant/main.py:384 applies derating_factor to dc_current unconditionally, so a hot pack loses traction power too. BAT-SYS-SAF-003 states the derating applies to 'the actual charging current limit'. Measured live: 56.9 degC -> factor 0.578 -> 250 kW request delivered 144 kW. Vendored behaviour; the four traces depend on it |
| `BL-01` | finished | DBC BATTERY_DC_V1 in jamaui DCM (type=dbc), decoder DBC_PLATFORM set | d527f90a…, 0 dropped, decoder resolves it |
| `BL-02` | finished | Battery trace generator: 4 deterministic MF4s, 10 TCs, 6 pass / 4 fail | committed 8d7847e, pushed |
| `BL-03` | finished | Requirements + parameters + test cases as the statement of record | CLAUDE.md tables generated from battery-trace-gen/data + specs |
| `BL-05` | finished | QuixLab + Lakehouse framed inside Test Manager (no new window) | QA'd by the user in the Portal 2026-09-22: QuixLab and Lakehouse both frame correctly |
| `BL-06` | finished | TM backend: one run covers several definitions (definition_ids), claims test.definitions, lake partitions platform/work_order/run_id | committed 8d7847e, pushed |
| `BL-07` | finished | One implementation .py per test case in blob (test-manager/implementations/<td>/), linked from the definition, opened via QuixLab | committed 8d7847e, pushed |
| `BL-08` | finished | Seed the Test Manager: 1 work order, 10 definitions, 4 run links via POST /planning/sync | seeded: WO-BAT-2026-001 + 10 definitions live in jamaui |
| `BL-09` | finished | Regenerate traces with test.* claims + new timestamps, upload, verify battery_data_v1 and registration | 4 traces uploaded; runs TAS-1001..1004 registered; rows landing in battery_data_v1 |
| `BL-10` | finished | Commit + push battery feature and TM adaptation; rebase onto Portal auto-commits | pushed 7a758ef..8d7847e |
| `BL-11` | finished | Run the 10 implementations against the lake and write verdicts | user 2026-09-23 asked for a Run button instead of a jump to QuixLab. Spec at dev-planning/run-a-definition/spec.md; the verdict record it writes is defined in dev-planning/test-results-page/spec.md. MERGED from Daniel's origin/quixlab-testing 2026-09-25: six feature commits cherry-picked (5c6577b api/ job+verdict, ac4da64, c5080b4 frontend run cell, fcc776b user-token lake query, af22aa5 QuixLab lake-token secret, 4c60d15 run-all button). 9fa44f0 skipped as a verified no-op (our MongoDB already had state enabled/size 1). d1c89fd 'trim the environment' REFUSED: it cut quix.yaml from 14 deployments to 5, deleting the whole ingestion pipeline and resurrecting the Planning Sync Mock. Two conflicts in definitions-panel.tsx, both because his branch predates our multi-select AddDefinitionsDialog: kept ours + runDefinitionFailure, took his DefinitionRunCell/planRunAll/RowRunState/sameRowState, dropped DefinitionPicker/FAILURES/messageFor/ApiError/useAddRunDefinition as unused after the merge. OPEN RISK: his branch runs QuixLab pr-71-f35d1ef, we stay on main-a4c31e3 (BL-55) because the bump lived only in the refused commit - if the verdict jobs need a pr-71 endpoint the Run button fails at runtime |
| `BL-12` | finished | Wave 2: visualisation service (battery, gas/brake pedals) from uiservice.zip on Tomas's API | superseded by BL-49 — built as the Battery Sim (battery-trace-gen) + Battery Sim UI deployments |
| `BL-16` | finished | Old backend/ Test Manager + DCM-source design | superseded by Tomas's api/; archived as archive/dcm-source-on-old-backend |
| `BL-21` | finished | Parallel agents when code paths are disjoint; QA by the user in the Portal; no Tester round | working agreement 2026-09-22 |
| `BL-23` | finished | Requirements are not entities in the TM — only markdown files on a definition | answered 2026-09-22: requirements become entities with versions (BL-34), not a light registry — the user chose versioned links (BL-33) |
| `BL-29` | finished | Test Runs nested under Work order; Test definitions under Test Run (nav + run detail) | sidebar indents runs under work orders and definitions under runs; run overview gained a Definitions panel |
| `BL-30` | finished | Import form no longer claims a test definition | mf4-to-blob form: work order, run id, rig |
| `BL-38` | finished | Coverage endpoint and matrix (GET /coverage) | existed on the old backend; the board computes coverage at baseline seal. Needed by the requirements page and the work-order rollup (BL-28). CLOSED 2026-09-25 by deciding AGAINST it: the test-results spec (rev 2) answers the page with the two existing view_counts plus a browser join, following traceability-screen.tsx:13-30's shipped precedent. A third endpoint serving what two already serve is duplication. Reopen only if a consumer needs coverage the browser cannot join |
| `BL-47` | finished | No UI assigns a definition to a run | done 389def1 (routes) + 1f40ce7 (UI): POST/DELETE /test-runs/{id}/definitions add or remove one member; the Test Run page has a picker. The manual tag lands on the whole definition_ids field, so a run stops taking planning links after the first edit - the panel says so |
| `BL-49` | finished | Battery sim UI: pedals plus DC charging up to 250 kW | built and deployed 06cda3d: pedals, plug + 250 kW charge slider, heater/chiller, 4 rolling charts; crash-looped until BL-52 moved the app folder |
| `BL-52` | finished | Battery Sim deployment crash-looped 158x: app folder carried no plant sources | fixed 64fcc66: battery-trace-gen is the application folder, entrypoint plant/main.py, slim plant/requirements.txt |
| `BL-53` | finished | Sidebar flattened: no nesting, order Home / Requirements / Test definitions / Work orders / Test runs | fixed 7f42af3: depth/INDENT gone; Home, Requirements, Test definitions, Work orders, Test runs |
| `BL-54` | finished | GET /requirements/facets is called by the page but declared nowhere — every filter dropdown is empty | added GET /requirements/facets above the {req_id} route; one $group + $reduce/$setUnion fold, retired rows included because list_requirements filters none either |
| `BL-55` | finished | QuixLab image moved from the pr-42 build to latest main | ghcr.io/quixio/quixlab:pr-42-c9939a4 (built 2026-08-19) -> main-a4c31e3 (commit a4c31e39, built 2026-09-11); pinned to the immutable tag, not the floating main. REVERSED 2026-09-25 by the user's decision ('take image daniekl is using'): back onto a PR build, pr-71-f35d1ef, because the Run button needs it. quixlab_run.build_run_spec clones the EXISTING QuixLab deployment's image field (quixlab_run.py:88), so a verdict Job always runs on whatever image is deployed - and main-a4c31e3 serves no QUIXLAB_MODE=run (app.yaml and README declare edit/app only, and the headless-launcher-contract.md the code cites exists on neither branch). The 'DO NOT MERGE' title is NOT a quality signal - user 2026-09-25: it says that because the PR targets main, which is not QuixLab's leading branch at the moment. pr-71-f35d1ef is the build QuixLab development is actually on, and it is the one that serves QUIXLAB_MODE=run. Do not re-raise the title as a risk |
| `BL-56` | finished | Requirements collection was empty in jamaui — the page had nothing to show | found while smoke-testing BL-54. seed/ already sends requirements in the planning body (planning_sync.py:178) but had not been re-run since the collection shipped at 3b3910a. `python -m seed catalog` -> requirements_mirrored 10. NOTE: TM_API_URL is the BASE url, push.py appends /api/v1 itself |
| `BL-57` | finished | Battery Sim v2: compact layout, a speed/smaller-battery knob, car with spinning wheels | built: TIME_SCALE x1-x50 tunable lexicon param (one statement in the vendored plant, PLANT_ORIGIN 5+6), Q_MAX_AH=25 deployment var, Bootstrap one-screen layout, SVG car with drive/coast/regen, pedal ceilings 60->250 kW and regen 20->80 kW. Four trace sha256s verified unmoved by a full regenerate |
| `BL-60` | finished | Test definitions have no filters at all — API takes only `orphaned` | done e9ec3b4 (API) + 1f40ce7 (page): work_order/status/requirement/q filters, facets route, pills and hideable columns |
| `BL-61` | finished | Requirements page: filters overlay instead of pushing the table down, hideable columns, row actions moved left | done e4ec13f: filters in a popover, columns declared once and hidden per browser, row actions moved to the second cell |
| `BL-63` | finished | Battery Sim thermal model is 50x slower than the pack it now models | A_THERMAL 0.0002->0.001 and KE 1.6->8.0 (tau 52min -> 2.1min), initial temperature decoupled from A_THERMAL. Q_MAX_AH went 100->25 then back to 90: at 25 Ah the 250 kW pedal is 12.8C, so the pack hit 57 degC and the derating LUT throttled it to 58% - TIME_SCALE is the speed knob, not pack size |
| `BL-70` | finished | Requirement versions: served on the detail, absent from the list row | CORRECTED 2026-09-24: not a defect. item_version/content_sha256/normative_sha256 are declared on RequirementDetail (models/requirements.py:128-134) and absent from RequirementRow, so the DETAIL serves them and the LIST does not - verified live, BAT-SYS-PRF-001 reads item_version 2. If BL-69's link store or the tree needs a version in a list row, that is a deliberate widening of RequirementRow, not a bug fix |
| `BL-71` | finished | Requirement carries a system attribute; an edit reopens a frozen requirement | fd56ad0: system rides seed -> planning sync -> model -> projection -> filter -> facets, seeded BMS; not on the definition, which derives it from covers_req_ids. In content_sha256 (else a subsystem move is refused as a no-op), out of NORMATIVE_FIELDS (else every link suspects). A content edit outside NEW/Draft returns the row to Draft with its own journal entry; frozen is defined by complement because status is a free-form string. The seed's set_canonical_sha256 had been stale since verified_by was deleted at 3b3910a and now covers both drifts |
| `BL-72` | finished | Planning Sync Mock removed - the Test Manager's MongoDB is the single store | user 2026-09-24: 'get rid of it, keem in mongo'. The mock ran a push worker that POSTed api/mock_planning/fixture.json (6 Volvo work orders, 7 definitions, 0 requirements) to POST /planning/sync and replaced the battery catalog twice on 2026-09-24 (08:53, 11:18); _write_mirror (planning_sync.py:286-308) is a plain update_one with no precedence check, so a mirror push beats a manual edit. Deployment STOPPED via the Portal, block deleted from quix.yaml, PLANNING_API_URL blanked on the API. POST /planning/sync SURVIVES - it is how `python -m seed catalog` loads the catalog. api/mock_planning/ stays on disk: api/seed/fixtures.py:75 reads its fixture.json as CAST_PATH and six test modules import it. The /planning-sync/{status,toggle,trigger} routes stay too - removing them drags in five green test modules. DONE 38ecd12, gate green (new=0 pre-existing=54). Leftovers: two strings still name the planning system and are pinned by green tests - custom-properties-panel.tsx:96 (definition-custom-properties.test.tsx:125) and requirements-panel.tsx:325 (requirements-panel.test.tsx:142,162,173); string and assertion must move in ONE commit. frontend/e2e/trace-history.spec.ts step 1 asserts 'Read-only mirror', which the same change deleted from work-order-detail-screen.tsx - red until that assertion moves |
| `BL-73` | finished | MF4 Import prefills its claim fields from the trace's own header; a retyped value wins | user 2026-09-24: 'prefill with trace data, on retyping by user it wins'. Cause: a typed claim beats the recording (metadata.py:227) and the form was filled by hand, so the lake carries work_order=WO-2026-PT-001 rig_id=0225 vehicle=Taycan while the traces' HD comment states WO-BAT-2026-001 / battery-sim-01 / WP0ZZZY1ZMSA10042. No code swaps any field - the whole path form -> declared.* -> CLAIMED_COLUMNS -> lake column was traced and each field stays in its lane; a run's project comes off its work-order mirror (queries_runs.py:142), never off the rig. Two wrinkles the spec must settle: multi-file selection (each trace carries its own test.run_key, one shared claim card cannot prefill four files) and provenance (a prefilled-but-untouched field sent verbatim converts an embedded claim into a declared one - dirty-tracking needed). Spec at dev-planning/import-prefill-from-trace/spec.md. BUILT: mf4-to-blob/static/{mdf-header,claim-editor,upload-page}.js, shared card deleted. Two File.slice() reads (0..136 for the ##HD links, then md_comment..+1MiB for the ##MD XML); offsets verified independently against TAS-1001 (##HD at 0x40, links_nr 6, md_comment 168). R2 EXECUTED in node: nothing typed sends no declared.* and one &vehicle= stamp, a typed field sends only itself, a cleared field sends nothing. R1 (a half-typed claim surviving a progress tick) was NEVER EXECUTED - the Playwright file-chooser handle was stale for both Tester and the main thread, so no file reached the page. Static reading says it holds (render() appends only when !e.parts, updateRow writes only into entry.parts, no input.value write is on the progress path) but that is reasoning, not a keystroke. USER QA in the Portal is what closes it |
| `BL-74` | finished | MF4 Import declares the platform per file, so two car lines do not share a lake partition | user 2026-09-25: 'imagine you are uploading traces for Porsche Taycan and Porsche Macan, cannot be stored under same project in lake'. DBC_PLATFORM is one deployment variable doing two jobs - the DCM target_key that picks the DBC, and the batch's platform - so a Macan trace was decoded with the TAYCAN DBC and filed under platform=Porsche_Taycan. Field is platform, labelled Platform not Project (work_orders.project is a different, visible column). TWO decoder channels had to agree: main.py:1131 feeds the DCM key, and build_provenance (main.py:804) feeds the lake column off the MF4 header - one statement reconciles them. platform ALONE breaks dirty-tracking and is sent even untouched (alwaysSend), because the decoder cannot read the header before the DBC lookup runs, so silence means DBC_PLATFORM and the failure fires exactly when the user trusts a correct prefill. Gets a _DECLARED_PATTERNS entry - the deliberate exception to no-new-shape-checks, because it is a partition directory AND a DCM target_key. No trace regeneration: bus/mf4.py:152 already writes a top-level platform HD property and provenance.py:42 already reads it. No lake change - platform is already in HIVE_COLUMNS. Spec+architecture dev-planning/upload-claims-platform/. PREREQUISITE: each platform needs <PLATFORM>.dbc in DCM before its first upload; a missing one fails QUIETLY (lookup miss, one warning, zero batches, marker with no decode_error, mark_decoded still fires) so recovery needs the DBC and new bytes |

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
  `C:\repos\quixstreams-tests-polarity` on `fix/dc-battery-sim-polarity`, verified 53/53.
