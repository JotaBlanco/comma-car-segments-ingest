# V-Model Test Manager - frontend architecture

**Phase 3, frontend only.** Implements section 1 of `dev-planning/test-manager-v/spec.md`
(acc_project repo) against the API described in
`dev-planning/test-manager-backend-architecture.md`. Written as a **separate file**
rather than appended to the backend document, because the frontend is its own
deployment with its own contract and the backend document is being verified
concurrently.

Read this before changing anything under `frontend/`.

---

## 1. What the code does

`frontend/` is a five-page Streamlit multipage app - Requirements, Test
Specification, Test Implementation, Test Run, Test Result - over the Test Manager
API. It uploads requirements (ReqIF **or** JSON), test specifications, test
implementations, the signal catalogue and MF4 traces; publishes baselines; renders
the requirement register with per-requirement coverage and, when a run is selected,
its verdict; renders each test case's description, preconditions, steps and
`pass_criteria` as a readable table; previews and fetches implementation code;
registers a device, a device
version and a parameter set when the registry is missing one (section 9); creates a run
(parameter set, device version, scope, many-to-many trace attachment), watches ingest
readiness and triggers evaluation; and shows the run's
metrics, per-case and per-requirement verdicts, plots and generated report. Every
call goes through one module, `api_client.py`; no page imports `requests`, no page
joins two entities, and no page renders an empty table when the real answer is "the
Storage Gateway is down".

## 2. Why this shape

### 2.1 `st.navigation` over a `pages/` directory

The pages live in `views/`, not `pages/`, and are registered explicitly with
`st.Page(..., url_path=...)`. Two reasons:

* A `pages/` directory triggers Streamlit's *automatic* page discovery, which would
  compete with `st.navigation` and take the page order and titles out of our hands.
  Spec 1.0 fixes both.
* `url_path` is part of a contract. `backend-api/report_html.py:77,86` builds
  outbound links as `<frontend>/Requirements?baseline=…&req_id=…` and
  `<frontend>/Test_Specification?baseline=…&tc_id=…`. Those two path segments must
  keep their spelling, and the query-parameter names `baseline`, `req_id`, `tc_id`
  must keep theirs.

### 2.2 Traceability navigation: session state plus query parameters

Streamlit has no anchors and no router, and `st.page_link` cannot carry query
parameters (its first argument is a page or an absolute external URL). So a
"clickable chip" is a button that (1) queues the target ids, (2) calls
`st.switch_page`. The target page reads the ids and opens that record. Both storage
mechanisms are needed and they can fight, so the rules are explicit in
`ui/state.py`:

* **Session state carries the selection across a page switch.** It is the source of
  truth during a session.
* **Query parameters make the same selection a shareable URL** - which is what the
  report links into, and what an operator pastes into chat.
* **A query parameter is adopted only when it differs from the value this app last
  published to the URL** (`state._PUBLISHED`). Our own URL echoing back is ignored;
  an inbound link or a hand-edited address bar wins. Without that rule, changing a
  sidebar selectbox would be reverted on the next rerun by the stale URL.
* **Link targets are queued, not written directly** (`state.request` →
  `state.apply_pending`). Most selection keys are also widget keys, and Streamlit
  refuses to modify a widget-bound key *after* its widget has been instantiated -
  which is exactly when a link click happens, since the sidebar is already drawn.
  The queue is drained at the top of the next run, before any widget exists.
* **A dataframe row click is only honoured when it is new** (`render.select_row`).
  A dataframe keeps its selection across reruns, so a stale highlighted row would
  otherwise beat every other way of choosing a record on the following rerun.

Even if a future Streamlit release made query-parameter writes trigger a rerun, the
equality guard in `state.publish_query_params` makes that converge after one extra
run instead of looping.

### 2.3 Mixed versions are unreachable, not merely rejected

The backend refuses a mixed pair (`409 version_mix_rejected`). The UI additionally
makes one unconstructable:

* every page reads the baseline through `state.read_context()`, so no page can pass
  a different one;
* selecting a **test run** resolves that run's `baseline_id` and writes it into the
  baseline selection *before* the baseline widget is built, then renders that widget
  `disabled` - a run's baseline is immutable, so the only honest thing the selector
  can show is the run's own pin (`ui/sidebar.py:_forced_baseline`,
  `_baseline_selector`);
* if the selected run is not in the filtered run list (a deep link can name one),
  its baseline is fetched from `GET /test-runs/{id}` rather than left unresolved -
  that was the one remaining way to get a run and a foreign baseline on screen
  together;
* the sidebar badge states which baseline resolved what is on screen.

**Deviation from spec 1.0:** the run selector is *not* filtered by baseline. The
baseline is derived from the run, so filtering the run list by the baseline the run
then overrides is circular in a single-pass script model. Each run option shows its
own baseline instead, and the device / parameter-set filters still apply.

### 2.4 Honest degradation, page by page

The Storage Gateway is unreachable, so blob-backed reads answer `503` with
`error == "blob_storage_unavailable"` and the cause in `message`, while everything
Mongo-backed keeps working. `ui/errors.py` owns the whole behaviour:

* `ApiError.is_blob_unavailable` distinguishes an outage from a bad request;
* `errors.show` prints the cause **and** names what still works, so an empty page can
  never be misread as "there is no data";
* `errors.baseline_required` separates "no baseline is pinned yet" (a thing the user
  can fix) from "no baseline can be resolved because blob is down" (a thing they
  cannot) - those are different sentences;
* the sidebar carries a permanent indicator built from `GET /health`, cached for 20 s,
  which reports the resolved backend (`quix` / `local` / `off`) and the reason.

`api_client._unwrap` exists because the backend has three error envelopes:
`deps.require_blob()` raises `HTTPException(503, detail={...})` (nested under
`detail`), the registered `BlobUnavailableError` handler returns the same keys at the
top level, and door validation returns `{"detail": "upload rejected", "problems":
[...]}`. All three are flattened once, so no page inspects a status code.

### 2.5 `pass_criteria` is rendered, not dumped

A criterion is a structured object - signal, channel group, window, reduction, rule,
unit, tolerance, quantifier, `min_samples`, `on_missing_signal`. `ui/criteria.py`
flattens each nested part into one human-readable cell and emits **one row per
criterion**:

| Object | Rendered as |
|---|---|
| `{op: moving_average, window_s: 2.0}` | `moving average over 2 s (trailing)` |
| `{type: state_mask, signal: ACC_Status, in: [2,3], settle_s: 0.5}` | `ACC_Status in [2, 3], after 0.5 s settle` |
| `{op: ge, value: -3.5, quantifier: all}` + `unit: m/s^2` | `every sample ≥ -3.5 m/s^2` |
| `{abs: 0.05}` | `±0.05 abs` (and `none` when null - zero tolerance is stated, not hidden) |
| `{type: all_of, parts: [...]}` | the parts joined with ` AND ` |
| `time_between_edges{from, to}` | `time from [BrkReq_mps2 < -0.3] to [rising edge of BrkLmp_Actv_Flg], first` |

The formatters are total over the closed vocabularies in
`backend-api/schemas/test-case-1.0.0.schema.json`: every `reduce.op`, every
`window.type` and every `rule.op` has a rendering, and an unknown value degrades to a
labelled compact form rather than vanishing.

With a run selected, page 2 merges the run's criterion outcomes into the same table
(`actual`, `bound (after tolerance)`, `samples`, `uncertainty s`, verdict, reason).
Page 5 uses a **second** renderer, `criteria_ui.render_results`, because a result
block is not a criterion: the evaluator flattens `rule` into `rule_op` / `bound` /
`quantifier` and adds `effective_bound` / `tolerance_applied`. Reusing the criterion
formatters there would have left the window, reduction and rule columns blank.

### 2.6 No client-side joins, and therefore no scope preview

Spec 2.6 forbids joining entities in the browser; the backend exposes pre-resolved
neighbourhoods for exactly that reason. Consequences worth knowing:

* the requirement register's coverage, `verified_by` chips and verdict all come from
  one `GET /requirements` response;
* the test-case detail's covers-chips, implementation, attachments and results all
  come from one `GET /test-cases/{tc_id}`;
* the traceability graph is `GET /graph/{entity}/{id}` turned into DOT and handed to
  `st.graphviz_chart` (`ui/graph.py`) - the frontend never walks the relation table;
* **the create-run form has no expansion preview before creation.** Expanding
  chapters into the union of covering test cases is a graph walk, and there is no
  scope dry-run endpoint. So the flow is: create the *draft* (the backend expands and
  persists `scope.planned_tc_ids`), review it, then `Submit` freezes it. Section 6
  lists this as a missing endpoint.

### 2.7 Deliberate omissions

* **No "run the unit test now" control anywhere.** The unit-test runner is deferred
  by explicit decision, so a case with `trace_required: false` resolves to
  `not_run / manual_verdict_pending`; page 5's manual-verdict form closes it.
* **No styling work.** Structure only: `st.columns`, wide layout,
  `use_container_width`. No bespoke CSS, no hand-rolled breakpoints.

---

## 3. Data flows

### 3.1 One rerun

```
main.py
  st.set_page_config(layout="wide")
  st.navigation(nav.build_pages())          # 5 st.Page objects, fixed order, url_path set
  sidebar.render()
      state.adopt_query_params()            # inbound deep link wins over stale URL echo
      state.apply_pending()                 # link targets queued by the previous run
      GET /health              (cached 20 s) -> storage banner
      GET /test-runs                         -> run selector  (Mongo)
      GET /test-runs/{id}      (only if the run is not in the list) -> its baseline
      GET /baselines                         -> baseline selector (blob; 503-prone)
      GET /devices, /parameter-sets          -> filters (Mongo)
      forced baseline written + widget disabled when a run is selected
      state.publish_query_params()          # URL now describes what is on screen
  page.run()                                # views/<page>.py executes top to bottom
      context = state.read_context()        # {baseline, test_run_id, run_version}
```

### 3.2 Traceability click (requirement -> test case -> implementation)

```
Requirements: chip "ACC-SYS-TC-014"
  nav.chip_links -> st.button -> nav.go(TEST_SPECIFICATION, tc_id="ACC-SYS-TC-014")
        state.request("tc_id", ...)         # queued: tc_id is a widget key on page 3
        st.switch_page("views/test_specification.py")
  rerun:
        sidebar: apply_pending -> tm_sel_tc_id = ACC-SYS-TC-014
                 publish_query_params -> ?baseline=BL-0007&tc_id=ACC-SYS-TC-014
        page 2: GET /test-cases/{tc_id}?baseline=&test_run_id= -> detail opens on that case
                chip "Implementation" -> nav.go(TEST_IMPLEMENTATION, tc_id=same)
  rerun:
        page 3: GET /test-impl/{tc_id} + /preview -> metadata, first 200 lines, fetch button
```

The same mechanism serves the report's outbound links: the report's
`<frontend>/Requirements?baseline=…&req_id=…` is adopted by `adopt_query_params` on
first load and lands on the requirement drawer.

### 3.3 A run, end to end

```
page 4 "Create a run"
  GET /parameter-sets           -> config_id@vN + canonical_sha256[:12] + created_at
  GET /parameter-sets/{id}/{v}/diff/{other}   -> parameter diff
  GET /devices, GET /devices/{id}             -> device + forced (sw, hw) pair
  POST /devices, POST /devices/{id}/versions, POST /parameter-sets
                                              -> register a missing record (section 9)
  GET /requirements | GET /test-cases         -> scope options (+ uncovered-in-scope warning)
  POST /test-runs                             -> draft, backend expands planned_tc_ids
  POST /test-runs/{id}/submit                 -> plan FROZEN (metric denominator)

page 4 "Attach data and evaluate"
  GET /traces?device_id=                      -> attach existing (many-to-many)
  POST /test-runs/{id}/attachments            -> links + per-row pre-flight
  POST /uploads/traces (multipart, repeated tc_ids) -> upload MF4 and attach in one submit
  GET /test-runs/{id}/attachments             -> traces per case
  GET /test-runs/{id}/readiness               -> stored -> vectorised -> linked, lake rows
  POST /test-runs/{id}/evaluate               -> 202, evaluation-requests published

page 5
  GET /test-runs/{id}                         -> header (device id first), status
  GET /metrics/{run}/{v}                      -> coverage + outcomes + sum check
  GET /results?test_run_id=&run_version=      -> per case, per criterion actual vs bound
  GET /requirement-verdicts/{run}/{v}         -> per requirement
  GET /reports/{run}/{v}                      -> revisions
  GET /reports/{run}/{v}/{rev}/report.json|.html|/plots/*.svg
  POST /test-runs/{id}/report                 -> new revision (lessons_learned carried)
  POST /test-runs/{id}/manual-verdict         -> Inspection / Demonstration cases
```

---

## 4. File inventory

### Created

| File | Lines | Concern |
|---|---|---|
| `frontend/api_client.py` | 849 | **The only HTTP seam.** Every endpoint, one flattened `ApiError`, blob-503 detection |
| `frontend/ui/state.py` | 187 | Selection state: adopt/publish query params, pending queue, `read_context` |
| `frontend/ui/nav.py` | 111 | The five `PageSpec`s (incl. `url_path`), `go`, `link_button`, `chip_links` |
| `frontend/ui/errors.py` | 198 | Cause-first error rendering, blob banner, `guarded`, `baseline_required` |
| `frontend/ui/sidebar.py` | 290 | Version selector, forced baseline, badge, baseline publishing |
| `frontend/ui/criteria.py` | 333 | `pass_criteria` and result-block rendering; the formatters of section 2.5 |
| `frontend/ui/render.py` | 115 | `select_row` (new-click guard), tables, key/value blocks, `percent` |
| `frontend/ui/graph.py` | 62 | `/graph` nodes+edges -> DOT -> `st.graphviz_chart` |
| `frontend/ui/run_create.py` | 289 | Page 4's create-run form (device, parameter set, scope) |
| `frontend/ui/registry_forms.py` | 459 | Page 4's registration forms: device, device version, parameter set (section 9) |
| `frontend/ui/result_metrics.py` | 146 | Page 5's metric cards and per-requirement verdict table |
| `frontend/views/requirements.py` | 321 | Page 1 |
| `frontend/views/test_specification.py` | 335 | Page 2 |
| `frontend/views/test_implementation.py` | 234 | Page 3 |
| `frontend/views/test_run.py` | 349 | Page 4 |
| `frontend/views/test_result.py` | 405 | Page 5 |
| `frontend/ui/__init__.py` | 6 | Package marker with the rationale for the split |

`ui/run_create.py` and `ui/result_metrics.py` exist because `views/test_run.py` and
`views/test_result.py` crossed the ~500-line ceiling; the seams chosen are
"constructing a run" versus "feeding an existing one", and "metrics" versus
"per-case detail and report". `api_client.py` is deliberately left as one file: it is
a flat, uniform, branch-free surface, and splitting it would add an import layer
without making anything easier to read while breaking the "single seam" property.

### Replaced / deleted

| File | Change |
|---|---|
| `frontend/main.py` | Rewritten: 86 lines of four generic CRUD tabs -> a 32-line `st.navigation` shell |
| `frontend/api_client.py` | Rewritten: `list_items` / `create_item` / `build_evaluate_params` / `evaluate` all called routes that no longer exist (`GET /evaluate`, generic `POST /requirements`) |
| `frontend/requirements.txt` | Streamlit floor raised to `>=1.40.0`, then bounded to `>=1.61.1,<1.62` (see below) |
| `frontend/tests/test_api_client.py` | **Deleted.** It tested `build_evaluate_params`, which no longer exists; leaving it would have been a guaranteed import error. Tester owns the replacement tests |

`frontend/dockerfile`, `frontend/app.yaml` and `frontend/.env.example` are unchanged
and still correct: the entrypoint is still `streamlit run main.py --server.port 80`,
and `BACKEND_API_URL` still defaults to `http://backend-api:80`, matching
`network.serviceName: backend-api` in `quix.yaml`.

**`quix.yaml` is untouched.** The Frontend deployment needs no new variable:
`app.yaml` already declares `BACKEND_API_URL` with the correct in-cluster default,
and nothing else about the deployment changed. Section 6 lists the one variable that
*is* missing, on the Backend API deployment, which is out of this dispatch's scope.

### Dependency ranges

`streamlit>=1.61.1,<1.62`. The **floor** is load-bearing for what the code calls:
`st.query_params` (1.30), dataframe row selection through `on_select` (1.35),
`st.navigation` / `st.Page(url_path=...)` (1.36) and the `:material/...` icon
shorthand. The **ceiling** is load-bearing for reproducibility, and it was bought with
a live defect: the original bare floor `>=1.40.0` resolved to 1.61.1, which tightened
`st.dataframe(height=...)` to reject `None`, and `render.select_row` had been passing
`None` since 1.40. The fix in `ui/render.py:71-74` is to omit the kwarg entirely
rather than pass `None`; the range is what stops the next minor release from doing the
same thing to a different kwarg mid-demo. 1.61.1 is the version this frontend is
verified against.

`requests>=2.31.0,<3`, `python-dotenv>=1.0.0,<2`, `pandas>=2.0.0,<3` keep their floors
and gain major-version ceilings for the same reason. **Never pass a version-sensitive
sizing kwarg as `None`** - `height`, `width` - and prefer the plainest widget call that
works over one that depends on a recently added parameter.

---

## 5. Integration with what already exists

| Existing thing | Relationship |
|---|---|
| `backend-api` | The only thing the frontend talks to. It never touches Mongo, blob or the Lakehouse, and never receives a blob credential or a blob URL: code, figures, traces, reports and plots are all streamed through the API |
| `backend-api/report_html.py` | Consumes our `url_path` values and the `baseline` / `req_id` / `tc_id` query parameters. Renaming a page's `url_path` breaks the report's outbound links |
| `backend-api/deps.require_blob` | Its 503 body shape is what `api_client._unwrap` and `errors.show` are built around |
| `GET /health` | Drives the sidebar storage indicator, cached 20 s. It answers with Mongo, blob and the broker all absent, which is why it is safe to call on every page |
| Mongo-backed endpoints | Devices, parameter sets, traces, runs, results and already-sunk metrics keep working with blob down; the frontend says which half is degraded rather than showing empty tables |
| `quix.yaml` Frontend deployment | `publicAccess.urlPrefix: app`, 200 mCPU / 400 MB. Unchanged; the new app has the same dependency set (Streamlit + pandas + requests) |

### API surface reachable from the client but not yet called by a page

Kept because they are real endpoints and the seam is meant to document the contract:
`mongo_health`, `get_manifest`, `list_versions`, `get_baseline`, `get_signal_catalog`,
`get_trace`, `get_trace_meta`, `set_lessons_learned` (page 5 sends
`lessons_learned` with the report request instead, which is the same write).

---

## 6. Endpoints the spec's UI needs and the backend does not expose

Reported, not added - the backend is out of scope for this dispatch.

1. **Scope-expansion dry run.** Spec 1.4 step 3 wants the expansion preview (the
   resulting `tc_id`s) *before* anything is created. Expansion only happens inside
   `POST /test-runs`. Needed: `POST /test-runs/scope-preview` (or
   `POST /test-runs/dry-run`) returning `planned_tc_ids` + `expansion_note` without
   minting a run id. Current behaviour: the draft is created first and reviewed
   before `Submit` freezes it.
2. **Discarding a draft run.** With no scope dry-run, an abandoned draft is
   permanent: there is no `DELETE /test-runs/{id}` and no `status: cancelled`
   transition, so exploratory scoping litters the run list.
3. **Detaching a trace from a case.** `POST /test-runs/{id}/attachments` only adds
   `run_trace_links` rows. A mis-attached trace cannot be removed from the UI;
   needed: `DELETE /test-runs/{id}/attachments` with `{tc_id, trace_key}`.
4. **Attachment pre-flight before the link is written.** Spec 1.4 wants the
   required-signal shortfall shown *immediately*, per row, while the user is
   choosing. The `preflight` block is only returned by the attach call, i.e. after
   the rows exist. Needed: the same check as a dry run.
5. **Evidence file for a manual verdict.** Spec 1.5 asks for "pass/fail + note +
   optional evidence file". `ManualVerdict` accepts `evidence_ref: str | None` only;
   there is no multipart endpoint that stores an evidence object. The UI takes a
   reference string and says so.
6. **`TM_FRONTEND_BASE_URL` is not declared on the Backend API deployment** in
   `quix.yaml`. Without it, `report_service._frontend_base()` returns `""` and the
   generated report falls back to in-document anchors instead of linking back into
   this app. Not a code change - one deployment variable, on a deployment this
   dispatch may not edit.

### Backend defect found while reading the contract

`backend-api/schemas/requirement-1.0.0.schema.json` line 39 is not valid JSON:

```json
"revision": { "type": "string", "pattern": "^[0-9]+\.[0-9]+$" },
```

`\.` is not a legal JSON escape, so `json.load` raised
`Invalid \escape: line 39 column 56`. The other ten schemas parsed. Anything that
loads this file - `schema_registry`, therefore `GET /health`, `GET /schemas` and
every requirements upload - failed.

**Already fixed** in the working tree to `\\.` by the concurrent backend
verification pass, so this is recorded as history rather than an open item. Not
touched from this dispatch: `backend-api/` is out of its scope.

---

## 7. Sanity tables

### 7.1 `page | module | endpoints called | links out to`

| Page | Module | Endpoints called | Links out to |
|---|---|---|---|
| 1 Requirements | `views/requirements.py` | `POST /uploads/requirements`, `POST /uploads/requirements/convergence-check`, `GET /artifact-sets/requirements/diff`, `GET /requirements`, `GET /requirements/{req_id}`, `GET /artifact-sets/requirements/versions/{v}/figures/{f}`, `GET /graph/requirement/{id}` | Test Specification (per covering `tc_id`), Test Result (per-requirement verdict), Requirements (`related_reqs`) |
| 2 Test Specification | `views/test_specification.py` | `POST /uploads/test-specs`, `POST /uploads/signal-catalog`, `GET /test-cases`, `GET /test-cases/{tc_id}`, `GET /graph/test_case/{id}` | Requirements (per covered `req_id`), Test Implementation, Test Run, Test Result |
| 3 Test Implementation | `views/test_implementation.py` | `POST /uploads/test-impl`, `GET /test-cases`, `GET /test-impl/{tc_id}`, `GET /test-impl/{tc_id}/preview`, `GET /test-impl/{tc_id}/code` | Test Specification, Test Run |
| 4 Test Run | `views/test_run.py` + `ui/run_create.py` + `ui/registry_forms.py` | `GET /devices`, `POST /devices`, `GET /devices/{id}`, `POST /devices/{id}/versions`, `POST /parameter-sets`, `GET /parameter-sets`, `GET /parameter-sets/{id}/{v}/diff/{other}`, `GET /requirements`, `GET /test-cases`, `POST /test-runs`, `GET /test-runs`, `GET /test-runs/{id}`, `POST /test-runs/{id}/submit`, `POST`/`GET /test-runs/{id}/attachments`, `GET /test-runs/{id}/readiness`, `POST /test-runs/{id}/evaluate`, `GET /traces`, `POST /uploads/traces` | Test Result, Test Specification, Test Implementation |
| 5 Test Result | `views/test_result.py` + `ui/result_metrics.py` | `GET /test-runs/{id}`, `GET /metrics/{run}/{v}`, `GET /results`, `GET /requirement-verdicts/{run}/{v}`, `GET /reports/{run}/{v}`, `.../report.json`, `.../report.html`, `.../plots/{f}`, `POST /test-runs/{id}/report`, `POST /test-runs/{id}/manual-verdict`, `GET /parameter-sets/{id}/{v}`, `GET /traces` | Requirements, Test Specification, Test Implementation |
| Sidebar (all pages) | `ui/sidebar.py` | `GET /health`, `GET /baselines`, `GET /devices`, `GET /parameter-sets`, `GET /test-runs`, `GET /test-runs/{id}`, `GET /artifact-sets`, `POST /baselines/dry-run`, `POST /baselines` | drives every page |

### 7.2 `endpoint | method | page(s) using it`

| Endpoint | Method | Used by |
|---|---|---|
| `/health` | GET | sidebar (cached 20 s), `errors.baseline_required` |
| `/uploads/requirements` | POST | 1 |
| `/uploads/requirements/convergence-check` | POST | 1 |
| `/uploads/test-specs` | POST | 2 |
| `/uploads/signal-catalog` | POST | 2 |
| `/uploads/test-impl` | POST | 3 |
| `/uploads/traces` | POST | 4 |
| `/artifact-sets` | GET | sidebar (baseline publishing) |
| `/artifact-sets/requirements/diff` | GET | 1 |
| `/artifact-sets/{set}/versions/{v}/figures/{f}` | GET | 1 |
| `/baselines` | GET, POST | sidebar |
| `/baselines/dry-run` | POST | sidebar |
| `/requirements` | GET | 1, 4 (scope options) |
| `/requirements/{req_id}` | GET | 1 |
| `/test-cases` | GET | 2, 3, 4 |
| `/test-cases/{tc_id}` | GET | 2 |
| `/test-impl/{tc_id}` | GET | 3 |
| `/test-impl/{tc_id}/preview` | GET | 3 |
| `/test-impl/{tc_id}/code` | GET | 3 |
| `/devices`, `/devices/{id}` | GET | sidebar, 4 |
| `/devices` | POST | 4 (registration form, section 9) |
| `/devices/{id}/versions` | POST | 4 (registration form, section 9) |
| `/parameter-sets` | GET | sidebar, 4 |
| `/parameter-sets` | POST | 4 (registration form, section 9) |
| `/parameter-sets/{id}/{v}` | GET | 5 |
| `/parameter-sets/{id}/{v}/diff/{other}` | GET | 4 |
| `/traces` | GET | 4, 5 |
| `/test-runs` | GET, POST | sidebar, 4 |
| `/test-runs/{id}` | GET | sidebar (forced baseline), 4, 5 |
| `/test-runs/{id}/submit` | POST | 4 |
| `/test-runs/{id}/attachments` | GET, POST | 4 |
| `/test-runs/{id}/readiness` | GET | 4 |
| `/test-runs/{id}/evaluate` | POST | 4 |
| `/test-runs/{id}/manual-verdict` | POST | 5 |
| `/test-runs/{id}/report` | POST | 5 |
| `/results` | GET | 5 |
| `/metrics/{run}/{v}` | GET | 5 |
| `/requirement-verdicts/{run}/{v}` | GET | 5 |
| `/reports/{run}/{v}` and its three artifacts | GET | 5 |
| `/graph/{entity}/{id}` | GET | 1, 2 |

### 7.3 `blob-unavailable behaviour | per page`

| Page | With `503 blob_storage_unavailable` |
|---|---|
| Sidebar | Storage banner names the cause. Baseline selector renders a caption with the backend's message instead of an empty dropdown. Device, parameter-set and run selectors keep working (Mongo). Baseline publishing shows the same cause instead of a version list |
| 1 Requirements | Uploads and register both blocked. `errors.baseline_required` explains that no baseline can be *resolved* (not "none selected") and names the cause; the register, the drawer and the figures never render an empty table. Convergence check also 503s and says so |
| 2 Test Specification | Same gate. Test-spec and signal-catalogue uploads report the cause |
| 3 Test Implementation | Same gate; preview, fetch and upload all report the cause |
| 4 Test Run | **Partly usable.** Device and parameter-set registries, the run list, `GET /test-runs/{id}`, `submit`, `evaluate` and `GET /attachments` are Mongo-backed and work. Creation (`POST /test-runs`), `POST /attachments`, `readiness` and `POST /uploads/traces` need the baseline bundle or blob and report the cause. The create tab is gated by `baseline_required` with the blob wording |
| 5 Test Result | **Mostly usable.** Header, `GET /results`, and `GET /metrics` / `GET /requirement-verdicts` all work when the sink has written `run_metrics` / `req_verdicts`; when it has not, the recompute path needs blob and reports the cause. Report revisions, `report.json`, `report.html` and the SVG plots are blob-only: the panel says revisions cannot be listed and the per-criterion plots fall back to the decimated series stored **inside** each result document, with a caption saying so |

---

## 8. Things to be careful about when changing this

* **`url_path` and the three query-parameter names are a contract** with
  `backend-api/report_html.py`. Renaming `Requirements`, `Test_Specification`,
  `baseline`, `req_id` or `tc_id` silently breaks every link in every stored report.
* **Never write a selection key after its widget exists.** Use `state.request` from
  anywhere; direct `state.set_value` is only safe for non-widget keys (`req_id`,
  `tc_id`) or before the sidebar builds its widgets. The same rule holds for *page*
  widget keys: `registry_forms` queues the identity of a record it just wrote and
  `run_create` applies it at the top of the next run, before the selectbox exists
  (section 9.3).
* **A message written immediately before `st.rerun` is never seen.** The rerun throws
  away everything the run has drawn. Stash it (`registry_forms._flash`) and print it on
  the next run.
* **Do not read `current_sw_version` / `current_hw_version`.** They are `null` on the
  deployed stack even after `make_current: true` (section 9.6). Device versions come
  from the `versions` array of `GET /devices/{id}`.
* **Do not adopt query parameters unconditionally.** The `_PUBLISHED` comparison is
  what stops a stale URL from reverting a fresh selectbox change on the next rerun.
* **Do not let a page call `requests`.** `api_client` is the seam; the error
  flattening and the blob-503 detection live there and nowhere else.
* **Do not join two responses to render one view.** If a view needs a join, the
  composite read belongs in the backend (spec 2.6), which already has the pattern.
* **Do not render a criterion result through the criterion formatters** (or vice
  versa). The two shapes differ; that is why `render_criteria` and `render_results`
  both exist.
* **An empty table is never an acceptable answer to a 503.** Route every failure
  through `errors.show` / `errors.guarded` so the cause is printed.

---

## 9. Registering a device, a device version and a parameter set

### 9.1 The defect this closes

`ui/run_create.py` used to answer an empty registry with instructions the app could
not carry out:

> No device is registered. Register one through `POST /devices` and a version through
> `POST /devices/{device_id}/versions` before creating a run.

`api_client` had `list_devices` and `get_device` and **no POST at all** for devices,
device versions or parameter sets, so `Create draft run` stayed disabled and the only
way forward was curl. Found by driving the running app, not by a test - the create tab
gated on preconditions it gave the operator no means to satisfy.

### 9.2 Where the forms live, and why there

In `ui/registry_forms.py`, rendered as `st.expander`s **inside the two selector
blocks** of `ui/run_create.py`:

| Form | Rendered by | Position |
|---|---|---|
| Register a parameter set | `parameter_block` | after the parameter selector, and in its empty branch |
| Register a device | `device_block` | after the device selector, and in its empty branch |
| Register a version of `<device_id>` | `device_block` | after the device-version selector, for the selected device only |

Three reasons for that placement rather than a sixth page or a sidebar section:

* **The blockage is felt here.** The message that used to name a curl command is
  replaced by a pointer to the expander two lines below it, so the fix is where the
  problem is announced.
* **It is the page's existing idiom.** Page 1 uploads requirements from an expander,
  the sidebar publishes a baseline from an expander. A write that feeds a selector
  sits next to that selector; no new pattern was invented.
* **The version form needs a device.** It is rendered only for the device the selector
  currently holds, so `POST /devices/{device_id}/versions` cannot be aimed at a device
  the operator is not looking at.

The forms sit behind `errors.baseline_required`, like the rest of the create tab. That
is a real constraint - no baseline selected means no registration either - but it is
not a dead end: the sidebar publishes a baseline and is visible on every page.

### 9.3 How a new record reaches the selector (Streamlit's rerun model)

Nothing on the registry read path is cached - `errors.backend_health` is the only
`st.cache_data` in the frontend - so a rerun re-issues `GET /devices` and
`GET /parameter-sets` and the new record is simply *in* the options. Being present is
not enough; it must be *selected*, and these selectors are keyed widgets whose session
value beats any `index=`. So:

```
POST /devices  201
   -> registry_forms._queue("device", "acc-plant-sim-02")   # non-widget session key
   -> registry_forms._flash("Registered device ...")        # survives the rerun
   -> st.rerun()                                            # discards this run's output
next run
   sidebar   -> state.apply_pending()                       # unrelated selection keys
   page 4    -> registry_forms.show_flash()                 # prints the confirmation
             -> device_block: GET /devices (fresh, uncached)
             -> registry_forms.preselect("run_new_device", take_device(), devices)
                # writes the selectbox's own widget key BEFORE the widget is built
             -> st.selectbox("Device", devices, key="run_new_device")   # shows it
```

Two rules are being obeyed, both already documented for the sidebar in `ui/state.py`:

* **A widget-bound session key may only be written before its widget exists.** The
  write happens inside the expander, i.e. *after* the selectbox above it was built, so
  the identity is queued and applied at the top of the next run instead. `preselect`
  ignores a value that is absent from the fresh options, so a record that disappeared
  between runs cannot raise.
* **`st.rerun` discards everything already drawn.** A success message written before
  the rerun is never seen - which the baseline publisher demonstrates. Hence `_flash` /
  `show_flash`, and `show_flash` runs *before* the baseline gate so a confirmation is
  printed even when creation is blocked for an unrelated reason.

Adoption resolves the record's **fields**, not a rebuilt label string
(`run_create._label_of`): the device-version and parameter-set options are formatted
labels, and matching on `sw_version` / `hw_version` / `config_id` / `config_version`
means the label format can change without silently breaking adoption. The queued
device-version identity carries its `device_id`, so a pair registered for one device is
never adopted by another. The sidebar's global device and parameter-set **filters are
deliberately left alone** - registering a device is not a request to narrow the run list
to it.

One related change in the same block: the device selectbox no longer takes
`index=devices.index(...)`. It seeds its widget key from `state.device()` on first
render instead, so "point this selectbox at a record" has exactly one mechanism, and a
session-state write can never collide with a widget default (Streamlit warns when it
sees both, and the session value wins regardless).

### 9.4 Validation before sending, and errors that state the cause

`device_id`, `config_id` and `params` are checked client-side, so the operator gets a
sentence under the field instead of a `422` from the server:

| Field | Check | Message |
|---|---|---|
| `device_id` | `^[a-z0-9][a-z0-9._-]{2,31}$` | names the rule and says it has to stay path-safe |
| `config_id` | `^CFG-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` | names the rule, gives `CFG-BASE` as an example |
| `config_version` | `st.number_input(min_value=1, step=1)` | unreachable by construction |
| `params` | `json.loads`, then "is it an object" | the parser's own line and column, or the type it got |
| `sw_version` / `hw_version` | non-empty, at most 64 characters | required-field sentence |
| `config_id` on a version | the `CFG-` pattern when non-empty | says it could never match a registered set |

Every write button is `disabled` while a blocker stands, and **every blocker prints its
reason** next to the button - a disabled control with no explanation is the defect this
section exists to fix. The patterns are mirrored from `backend-api/ids.py:16,21` and the
kind enum from `api_models.py:27`; the duplication is deliberate, the alternative being a
round trip to discover a typo. The backend stays the authority - these checks only decide
whether a request is worth sending.

Failures render through `errors.show`, so nothing is ever a bare status code:

* **409** (`device x already exists`, `parameter set CFG-X@v1 already exists`) - the
  backend's own sentence, verbatim.
* **422** - `message` plus one table row per entry in `problems[]`, the `pointer` naming
  the field. `errors.show`'s problems branch was **generalised** for this: the single
  error envelope now carries `problems[]` on every 422, so the atomic-upload wording
  ("no partial version is minted") is keyed on `error == "upload_rejected"` and a
  rejected registry write gets neutral wording instead.
* **503 / unreachable / timeout** - unchanged. The registry is Mongo-backed, so it keeps
  working while blob storage is down.

### 9.5 What the request bodies may contain

Every request model sets `extra="forbid"` (`backend-api/api_models.py:20`), so a field
the model does not declare is a `422`, not an ignored key. `DeviceVersionCreate` has **no
`notes` field**, so `api_client.create_device_version` takes no `notes` argument and the
version form offers no such box; `ParameterSetCreate` *does* have `notes`, and the
parameter-set form offers it. The asymmetry is intentional and load-bearing.

### 9.6 `make_current` does not populate `current_sw_version` on the live stack

Registering a version with `make_current: true` answered `201` and the device's
`current_sw_version` / `current_hw_version` stayed `null`. The source at
`backend-api/routers/registry.py:97-106` *does* perform that `$set`, and
`DeviceVersionCreate.make_current` defaults to `True`, so the backend running on `:8080`
is most likely built from an older image than the working tree - a redeploy, not a code
change. **Not fixed here: `backend-api/` is out of this dispatch's scope.**

It does not affect this frontend, and that is by design rather than by luck:
`device_block` lists the `versions` array of `GET /devices/{id}`, so an unset current
version cannot hide a registered pair, and **no page reads `current_sw_version` or
`current_hw_version` at all**. Do not start reading them: the field is not maintained on
the deployed stack. `api_client.create_device_version` carries the same warning.

### 9.7 These forms are a stopgap; ingest should derive the records

Every MF4 carries `device_id`, `tool_version`, `asammdf_version` and `config_hash12` in
its header metadata, its sidecar and `manifest.csv`. Trace ingest could therefore
auto-register the device, the device version and the parameter set, marked
`source: derived-from-trace` (the parameter-set document already carries `source: "api"`,
so the field exists), and reject only a genuine contradiction between a run's claimed
`device_id` and its attached trace's. When that lands, these fields stop needing a human:

| Form field | Derivable from | Still manual |
|---|---|---|
| `device_id` | MF4 header, sidecar, `manifest.csv` | no |
| `sw_version` / `hw_version` | MF4 header; already asserted per upload by `POST /uploads/traces` | no |
| `tool_name` / `tool_version` | MF4 header | no |
| `asammdf_version` | MF4 writer stamp | no |
| `config_id` / `config_version` / `params` | `config_hash12` matched against the registry | only when the hash is unknown to the registry |
| `config_hash12` | derived from `params` by the backend already | no - never entered by hand |
| `name`, `description`, `kind` | nothing in the MF4 | **yes**, human labels |
| `plant_spec_ref`, `dbc_id`, `notes`, `content_url` | nothing in the MF4 | **yes**, provenance a human asserts |
| `make_current` | nothing | **yes**, and it should be dropped rather than derived |

The residue is exactly the human-asserted half of spec 5.5, open question Q2: what the
trace can prove, ingest should derive; what only a person knows keeps a form. At that
point `registry_forms.device_version_form` becomes a rarely used override rather than a
step on the demo path, and the empty-registry branches in `run_create` should become
unreachable in practice.
