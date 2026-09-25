# Test Results page — coverage, passed requirements, passed test definitions

**Status:** Draft (revision 2)
**Project:** comma-car-segments-ingest
**Branch / HEAD:** `jama-ui-dev` @ `da46817`
**Created:** 2026-09-23 · **Revised:** 2026-09-25
**Planned with:** Buddy
**Backlog:** answers `BL-51`; **closes `BL-38` without building `GET /coverage`** (§4); reads what
`BL-11`'s shipped writer produces; renders `BL-19` (Covered ≠ Tested) honestly under the gap
`BL-69` / `BL-34` leave.

The user's sentence:

> *"so last step is to create result page with covered reqs, passed reqs, passed TD"*

---

## 0. What this revision cut, and why

Revision 1 was written at `d9dd5d4`, before the verdict writer, the requirement fold's shipped
state, the facets route and the status gate existed. Most of it described work that has since
landed. Everything below was **deleted**:

| Cut | Was | Why it goes |
|---|---|---|
| **§2 in full** — the verdict document, field by field, and "who writes it" | *"What is missing is a writer"* | The writer **shipped**. `api/api/services/definition_runs.py:124-183` (`record_verdict`) builds a `ResultCreateRequest` from a finished QuixLab Job and stores it through `_store_result`. `api/api/routers/definition_runs.py:156-158` calls it. The `Verdict` / `VerdictOut` blocks (`api/api/models/results.py:84-109`) and the index (`api/api/db.py:165`) were already there. Nothing about the record is this page's to design. |
| **§2.2's two ADDED fields** — `definition_version`, `criterion` | proposed on the `Verdict` block | `definition_version` has no value to write: `test_definitions` carries no `item_version` at all (`BL-34`'s TC half is not built), so the field would be null on every document forever. `criterion` needs the evaluator to return it, which is a change to the shipped notebook wrapper (`api/resources/verdict_notebook.py`) and belongs to whoever owns that line, not to a report screen. Neither is needed to render the three things the user asked for. |
| **§3 in full** — the `GET /coverage` response shape | a 40-line envelope with `summary`, four lists, a matrix and facets | §4 decides not to build it. Every number in that envelope is now served by two shipped lists plus one widened one. |
| **§4 in full** — the new route, its filters, its refusal map entry, `queries_coverage.py` | one new GET | Same reason. A third fold over `requirements` × `test_definitions` × `test_runs` × `processed_results` would be the second implementation of `queries_requirements._project` and the first to drift. |
| **§6.4's claim that `GET /requirements/facets` does not exist** | *"declared nowhere… answers 404"* | **False since `BL-54`.** The route is at `api/api/routers/requirements.py:81-88`, declared above `/requirements/{req_id}` with a comment saying why. The page uses it. |
| **§6.5 in full** — the zero-verdict empty state and its banner | *"Today `summary.runs.verdicts == 0`"* | Stale. The live registry answers `{"all": 10, "not_covered": 0, "covered": 0, "exercised": 5, "failed": 2, "tested": 3}` — five verdicts are written, three pass, two fail. §6.6 replaces it with the partial-evaluation state, which is the state the page will actually open in. |
| **§5.1 / §5.2 / §5.4's "today = exercised / after BL-11 = tested" tables** | a three-moment walkthrough per requirement | Same reason: `BL-11` is half-done, not undone. §5.3 keeps the Covered ≠ Tested walkthrough against the live numbers. |
| **§7.1 — the `BL-50` position** | a paragraph resolving requirements-page §10 against authoring-controls | Already resolved in code: `POST /requirements`, `PATCH /requirements/{req_id}`, `POST /requirements/{req_id}/retire` ship and `requirements-screen.tsx:205-211` carries Add / Edit / Retire. Not this page's business; `BL-50` is a docs cleanup on another spec. |
| **§8's dependency rows for `BL-11`, `BL-24`, `BL-37`** | *"not built"* | `BL-11`'s writer and `BL-24`'s whole contract shipped. `BL-37`'s streaming evaluator was replaced by the QuixLab Job path and is not a dependency of anything here. |
| **§9 OQ6 — "does the page need a trend?"** | an open question | It was already answered *no* with the right reason (it is `BL-39` baselines wearing a chart). A question whose answer is settled is a non-goal, and §7 states it as one. |

**Kept, revised in place:** §1 (purpose), §3.1 (the two units of counting — still the single most
important rule here), §5 (Covered ≠ Tested, re-costed against live numbers), §6.3 (the matrix cell
table), §6.6 (the CSV export), §7 (no authoring controls on this page).

---

## 1. Purpose — the one question the page answers

**"Where does this campaign stand?"** — asked once, answered in one screen: how much of the
requirement set a test case names at all, how many of those requirements a passing run backs, how
many test definitions passed, and which of them nothing has judged yet. Every other screen answers
about **one** entity — one requirement, one run, one definition — or about **structure** (the
traceability tree). This is the only screen that answers about the **set's outcomes**, and it is
what a person screenshots for a status meeting.

It writes nothing. Every number is a projection of records the registry already holds, so the page
is correct by construction the moment those records change.

---

## 2. What is already built — the user's three asks, field by field

| Ask | Verdict | Where it lives today |
|---|---|---|
| **covered reqs** | **served, partially rendered** | `GET /api/v1/requirements` answers `view_counts` (`api/api/models/requirements.py:67-79`), and `not_covered` is the whole of "not covered". Live: `{"all": 10, "not_covered": 0, ...}`. The Requirements screen renders it as quick-view badges (`requirements-screen.tsx:130-135`) but shows **no coverage figure over the set** — no `10 / 10`, no percentage. That figure is a one-line projection of numbers already on the wire. |
| **passed reqs** | **served and rendered** | Same envelope: `view_counts.tested = 3`, `failed = 2`, `exercised = 5`. Folded by `queries_requirements._state_fold` (`:181-229`) on every read from run coverage and verdicts, never stored. The Requirements screen already shows a `Tested` quick view with its count and a per-row **Verification** column beside the authored **Status** column. |
| **passed TD** | **ABSENT** | There is no definition-side rollup anywhere. `TestDefinitionRow` (`api/api/models/planning.py:62-83`) carries `planned_runs`, `actual_runs`, `status` (`on_plan`/`behind`), `orphaned`, `covers_req_ids` — and no outcome. `TestDefinitionPage` (`:85-90`) explicitly carries no `view_counts`. The only place a definition's verdict is visible is `frontend/components/screens/run-detail/definition-run-cell.tsx`, one `(run, definition)` pair at a time, and reading it costs a live Portal poll. |

**So the build is: one rollup that does not exist, plus one page that renders all three.** Two
thirds of what the user asked for is already on the wire and merely unrendered on one screen.

Also already shipped and **not** to be re-derived:

- **The verdict writer.** `definition_runs.record_verdict` (`api/api/services/definition_runs.py:124-183`)
  stores one `processed_results` document per finished Job, with `provenance.tool = td_id`,
  `provenance.tool_version = "sha256:…"`, `provenance.input_file_ids`, and the `verdict` block
  (`definition_id`, `outcome`, `evidence`, `implementation_sha256`). Version chain per
  `(run_id, "verdict/<td_id>")`; a re-run mints `version + 1`.
- **The route that serves verdicts.** `GET /api/v1/results?run=<run>&latest_only=true`
  (`api/api/routers/results.py:106-150`). `GET /api/v1/processed-results` does not exist and never
  did — `processed_results` is the Mongo collection name, not a path.
- **The status gate.** `Implemented` ≙ `exercised|failed` and `Tested` ≙ `tested` are projections
  of `verification_state`, refused as authored values (`api/api/requirement_lifecycle.py:11, 56-63`).
- **`GET /requirements/facets`** (`api/api/routers/requirements.py:81-88`) and
  **`GET /test-definitions/facets`** (`api/api/routers/test_definitions.py:179`).
- **`evidence_stale`**, which degrades a stale `tested` back to `exercised`
  (`queries_requirements.py:224`).

---

## 3. The test-definition rollup — the one thing that is missing

### 3.1 The two units of counting, kept apart

This survives revision 1 unchanged and is the rule the whole page hangs on. **"How many passed" and
"how many requirements are tested" count different things**, and they coincide only because this
seed is one test case per requirement:

- a **requirement** is `not_covered | covered | exercised | failed | tested` — the five-value fold
  at `queries_requirements.py:181-229`;
- a **test definition** is `not_run | no_verdict | passed | failed | error` — §3.3 below.

A definition covering three requirements produces **one** fail and **three** failed requirements. A
requirement covered by three definitions is `failed` if *any* of them failed. **Every tile on this
page prints its unit.** Merging the two into one "passed" number is the defect this section exists
to prevent.

### 3.2 Where a definition's pass/fail comes from

From the same documents the requirement fold already reads, by the same rule:

1. the runs carrying the definition — `test_runs.definition_ids`, **invalid-flagged runs excluded**
   (`queries_requirements.py:121-124`), newest bench session first (`first_data_at` DESC, `_id` DESC);
2. the newest `processed_results` document per `(run_id, verdict.definition_id)` — sorted
   `version` DESC, first seen wins (`:136-146`), on the index at `api/api/db.py:165`;
3. the definition's outcome = **the verdict of the newest run that carries one** —
   `_newest_verdict_of_td` (`:155-165`). *A test case re-run after a fix is judged on its latest
   attempt, not its first.*

**A definition run twice with different outcomes** — the case to get right — has two shapes and they
are answered separately:

| Shape | Answer | Why |
|---|---|---|
| same definition, **same run**, run again | the highest `version` wins | The version chain is the shipped mechanism (`_store_result` mints `version + 1`, `supersedes` points back). Nothing new. |
| same definition, **different runs** (different traces / bench sessions) | the **newest run carrying a verdict** decides `verdict_state`; the older outcomes stay visible as `verdict_counts` | Reuses `_newest_verdict_of_td` verbatim. A second rule here would put the definitions list and the requirements list in disagreement about the same pair of documents, which is the exact failure `queries_requirements`'s module docstring says `_project` exists to prevent. Hiding the older outcome entirely would be dishonest: a definition that failed on T1 and passed on T2 is not the same fact as one that only ever passed. |

A row whose `verdict_counts` show both a pass and a fail across runs prints them
(`passed · 1 of 2 runs failed`). **It does not get its own tile bucket** — a sixth word for a
history that the counts already state would be the third vocabulary this spec is forbidden to
invent.

### 3.3 `verdict_state` — the five words

| Value | Condition |
|---|---|
| `not_run` | no non-invalid run carries this definition |
| `no_verdict` | a run carries it, no `processed_results` document names it |
| `passed` | the newest run carrying a verdict says `pass` |
| `failed` | …says `fail` |
| `error` | …says `error` — the evaluator could not decide. **Never rendered red.** It is not a failure (`api/api/models/results.py:94`). |

**`error` is the one fact this page adds that no other screen can show.** The requirement fold
folds `error` and "no verdict yet" both into `exercised` (`queries_requirements.py:216-218, :222`),
so a requirement whose evaluator is permanently broken reads exactly like one nobody has run. The
definition rollup separates them, and §6.2's tiles print the error count. This is not a second
derivation of the same fact — it is the fact the requirement fold deliberately discards.

### 3.4 Staleness on a definition: the implementation pin only

A definition's verdict carries `current: bool` computed from **one** test:
`implementation.sha256 is None or implementation.sha256 == verdict.implementation_sha256` — the
`pinned` half of `queries_requirements.py:207` and `:494`. A pass produced by bytes that have since
been replaced is not current.

**The requirement-side freshness test (`produced_at >= normative_changed_at`) is NOT applied here**,
and the reason is a seam, not an omission: a definition's pass is a claim about *the implementation
that ran*, while normative drift is a claim about *a requirement that changed*. A definition covering
three requirements, one of which was edited, is not two thirds stale — the requirement that moved
goes `exercised` + `evidence_stale` on its own row and says so there. Folding requirement drift into
the definition count would double-count the same edit on two tiles.

### 3.5 Where the code goes — one fold, two callers

`queries_requirements._fold_inputs` (`:103-152`) already builds `runs_of_td` and `newest_verdict`.
`_derived_definitions` (`queries_runs.py:1499-1524`) needs exactly those two maps. Copying them
would be the second derivation the standing rule forbids.

**New module `api/api/services/verdict_fold.py`**, holding only what both callers share:

```python
def fold_verdicts(db, td_ids) -> dict          # {"runs_of_td": …, "newest_verdict": …}
def newest_of_td(fold, td_id) -> tuple[dict | None, dict | None]
def is_pinned(definition, verdict_block) -> bool
```

lifted verbatim out of `queries_requirements.py:118-165` and `:207`. Both
`queries_requirements._fold_inputs` and `queries_runs._derived_definitions` then import it.
`queries_requirements` keeps `verified_by` and `definitions_by_id`, which are requirement-side only.

Cost on `GET /test-definitions`: **two extra queries**, both on existing indexes
(`test_runs.definition_ids` at `db.py:42/49`, `processed_results.verdict.definition_id + version` at
`db.py:165`). At 10 definitions / 4 runs / 5 verdicts this is sub-millisecond.

---

## 4. `GET /coverage`: not built. `BL-38` closes here.

**Decision: no third endpoint.** Revision 1's `GET /coverage` is deleted.

What it was going to serve, and what serves it instead:

| `/coverage` was going to carry | Served instead by |
|---|---|
| `summary.requirements` | `GET /requirements` → `view_counts` (shipped, whole-table, filter-independent) |
| `summary.definitions` | `GET /test-definitions` → `view_counts` (§3, new) |
| `requirements[]` rows with `verification_state`, `verified_by`, `covering_run_ids` | `GET /requirements` → `items[]` — every one of those fields is already on `RequirementRow` |
| `definitions[]` rows with outcomes | `GET /test-definitions` → `items[]` (§3) |
| `matrix.cells` — requirement × definition with its verdict | **joined in the browser.** A requirement row carries `verified_by: list[td_id]`; a definition row carries `covers_req_ids` and (new) `latest_verdict`. The cell is the intersection of the two lists. |
| `work_orders[]`, `runs[]` rollups | nothing — and nothing asks for them. §7 explains. |

**The browser join is the shipped precedent, not a shortcut.** `traceability-screen.tsx:13-30`
assembles the whole project → system → requirement → definition → run tree from four list reads at
`page_size = 200`, with the reason written into its own docstring: *"The registry holds tens of rows
per list, so a tree route on the API would only move the same join to the server."* The same
argument holds verbatim here, over two lists instead of four.

**The ceiling, stated so nobody has to rediscover it:** this page fetches `page_size = 200` of each
list and joins in `useMemo`. Past roughly 500 requirements the join stops being one screen and one
round trip, and the upgrade is a server-side fold — at which point `GET /coverage` becomes the right
answer and this section becomes wrong on purpose. Today's estate is 10 and 10.

**`BL-38` should be closed with this reasoning recorded**, not left open as "coverage endpoint not
built". A backlog item that names an endpoint the design has decided against will be built by
someone in six months.

---

## 5. The honesty problem — the word this page uses

### 5.1 What the board means by TESTED, and why it is not computable today

`CLAUDE.md` § Requirements workflow: **TESTED needs a confirmed `verifies` link at `(R@v, TC@w)`
AND a pass for that TC in a run whose manifest pinned TC at exactly version `w`. A suspect link
blocks it.** Three things that needs, and none exists:

| Needed | State |
|---|---|
| a link store holding confirmed pairs | `traceability_links` is **not built** (`BL-69`, spec at `dev-planning/versions-and-links/spec.md`). The `verifies` relation today is `test_definitions.covers_req_ids` — authored, never confirmed, with no per-link state at all. |
| `R@v` — a requirement version | **shipped.** `requirements.item_version` / `content_sha256` / `normative_sha256` (`api/api/models/requirements.py:128-134`). |
| `TC@w` — a test-definition version | **not built** (`BL-34`, TC half). `test_definitions` carries no version field. |
| a verdict pinned to `w` | not possible; the writer pins `implementation_sha256` instead, which is a pin on *bytes*, not on a *version*. |

So a strict TESTED cannot be computed. A page that printed "6 requirements verified" would be
asserting something the registry cannot back.

### 5.2 The decision

**The page uses the shipped five-word Verification vocabulary, verbatim, and adds no word of its
own:** `Not covered · Covered · Exercised · Failed · Tested`.

Reasons, in order:

1. The Requirements screen already shows exactly these words in a **Verification** column beside the
   authored **Status** column, under the line *"Status is authored here; Verification is computed
   here from runs and verdicts"* (`requirements-screen.tsx:178-182`). A second vocabulary for the
   same five states would make two screens disagree about one requirement in wording alone.
2. `Tested` is already defined in code, narrowly and checkably: *every covering definition's newest
   verdict is `pass`, every pass is pinned to the current implementation bytes, and no covering
   requirement text changed after the pass* (`queries_requirements.py:219-229`). That is a real,
   defensible claim. It is simply **weaker** than the board's.
3. Inventing a hedge word — "Provisionally tested", "Evidence found" — would be a third vocabulary
   and would not make the claim any more true.

### 5.3 How the page states the gap

**One permanent note under the page header — not a dismissible banner, not a tooltip:**

> **Tested here means every test case covering the requirement passed on its latest run, and the
> pass is pinned to the implementation bytes that produced it.** It is not yet ASPICE *Tested*: that
> needs a confirmed verifies link carrying both sides' versions, and this registry stores neither a
> link record (`BL-69`) nor a test-definition version (`BL-34`). Coverage below counts authored
> links, which nobody has confirmed.

Two more honesty rules on the page itself:

- **The only percentage is Coverage**, and Coverage counts *authored links* — a test case naming the
  requirement. It is not a verification figure and is never labelled one. There is no "compliance %",
  no "verified %", no single score.
- **A `Covered 100 %` beside `Tested 3` is the correct reading of this estate, not a bug.** §5.4
  walks it.

### 5.4 Covered ≠ Tested on the live set

Live `view_counts`: `{all: 10, not_covered: 0, covered: 0, exercised: 5, failed: 2, tested: 3}`.
Expected truth from `battery-trace-gen/out/manifest.csv`: 6 PASS / 4 FAIL, one test case per
requirement.

```
Coverage  10 / 10 · 100 %      ← every requirement has a test case naming it
Tested     3 requirements      ← three passes landed and are current
Failed     2 requirements      ← two rigged failures landed
Exercised  5 requirements      ← runs carry them; nothing has judged them yet
```

**Coverage is 100 % and will stay 100 % through every one of those moves.** When the remaining five
definitions run, the tiles read `Tested 6 · Failed 4 · Exercised 0` and Coverage still reads 100 %.
That is the board's *Covered ≠ Tested* on screen, with the user's own rigged data producing the
correct negative — `BAT-SYS-SAF-002` is covered throughout, names its run throughout, and is
`tested` at none of them.

---

## 6. The page

`frontend/app/test-results/page.tsx` → `frontend/components/screens/test-results/test-results-screen.tsx`.
Route `/test-results`.

**Sidebar:** a **Test results** entry **directly after Traceability**, before Files
(`frontend/components/shell/sidebar.tsx:193-194`), **with no count badge** — the treatment
Traceability, Issues and Explore already get, for the stated reason: *it is a view, not a list*, so a
badge would be a number with no referent. Adjacent to Traceability on purpose: both are composed
views over the four entity lists, one structural and one about outcomes.

### 6.1 Layout

```
PageHeader   "Test results"
             sub: the §5.3 note, always visible

SummaryTiles   Coverage 10/10 · 100%  |  Tested 3 req  |  Failed 2 req  |  Passed 3 TC  |  Failed 2 TC
               under them: 5 of 10 test cases not judged yet · 0 errored · 0 stale

Toolbar row  [ All | Failed | Not judged | Passed ]  [ search ]  …  [Work order▾] [System▾]
             [Chapter▾] [Verification▾] [Outcome▾]  [Export]

ActiveFilterPills

Panel "Coverage matrix"        requirements × test definitions, sticky first column
Panel "Test definitions"       one row per definition: outcome, latest run, evidence, sha
```

### 6.2 The summary tiles

**Five tiles, each printing its unit** (§3.1), plus one context line.

| Tile | Reads | Source | Tone |
|---|---|---|---|
| **Coverage** | `10 / 10` and `100 %` | `requirements.view_counts`: `(all - not_covered) / all` | neutral — a percentage is not good or bad |
| **Tested** | `3 requirements` | `requirements.view_counts.tested` | green |
| **Failed** | `2 requirements` | `requirements.view_counts.failed` | red |
| **Passed** | `3 test cases` | `definitions.view_counts.passed` | green |
| **Failed** | `2 test cases` | `definitions.view_counts.failed` | red |

Context line under them, not tiles — they are context, not headline:
`5 of 10 test cases not judged yet · 0 errored · 0 stale`.

`error > 0` renders **amber** in that line, never red (§3.3).

The authored requirement `status` (Draft / Reviewed / …) is **never coloured anywhere on this page**,
for the reason the Requirements page already states: the enum is customer configuration (`BL-20`), so
this code cannot know which value is good.

### 6.3 The coverage matrix

Rows = requirements, `req_id` ascending. Columns = test definitions, `definition_id` ascending. First
column sticky (`req_id` + title); the grid inside the existing `TableScrollArea`, which already
scrolls horizontally.

**The cell list is sparse: a cell exists only where a link exists.** Ten requirements × ten
definitions is a hundred intersections of which ten are real; drawing ninety empty cells would each
assert *"this test case was considered for this requirement and found not to apply"*, which is false —
it was never linked.

| Cell | Glyph | Tone |
|---|---|---|
| `pass`, current | ✓ | green |
| `pass`, `current: false` | ✓ with a dashed outline | green + `stale` |
| `fail` | ✗ | red |
| `error` | ! | amber — never red |
| linked, run carries it, no verdict | ○ | neutral |
| linked, no run carries it | ○ hollow, dimmed | neutral |
| not linked | *empty* | — |

A cell links to `/runs/{run_id}?tab=results`; its `title` carries the outcome, the run id and the
`evidence` as `key: value` pairs. **Colour is never the only carrier**: glyph + tone + `aria-label`,
the rule `requirements-page/spec.md` §5.4 sets.

**Row and column headers are links** — `req_id` → `/requirements/{id}`, `definition_id` →
`/definitions/{td}`.

### 6.4 The test-definitions panel

One row per definition, because a matrix cell has no room for the evidence, the run or the
implementation digest, and because "passed TD" is a list as much as a number:

`td_id · title · work order · covers (req ids) · outcome · latest run · evidence · impl sha (12) · produced at`

A definition with verdicts on several runs prints the older ones as a count beside the outcome
(§3.2): `passed · 1 of 2 runs failed`.

### 6.5 Filters

One `TableStateConfig`, the idiom `requirements-table-config.ts` already holds:

```ts
export const TEST_RESULTS_TABLE_CONFIG: TableStateConfig = {
  multiKeys: ["work_order", "system", "chapter", "state", "outcome"],
  singleKeys: [],
  sortKeys: [],
  defaultSort: null,
  defaultPageSize: 200,     // one page of each list; the join is client-side (§4)
  pageSizeOptions: [200],
  quickViews: [
    { id: "all",        params: {} },
    { id: "failed",     params: { state: ["failed"] } },
    { id: "not-judged", params: { state: ["covered", "exercised"] } },
    { id: "passed",     params: { state: ["tested"] } },
  ],
};
```

- `work_order`, `system`, `chapter` and `state` pass straight to `GET /requirements` (every one is a
  declared param, `api/api/routers/requirements.py:32-45`); `work_order` also narrows
  `GET /test-definitions` (`queries_runs.list_test_definitions`).
- `outcome` (`verdict_state`) is a **new** repeated param on `GET /test-definitions` (§8.2).
- Dropdown options come from the shipped facet routes: `GET /requirements/facets`
  (`requirements.py:81`) and `GET /test-definitions/facets` (`test_definitions.py:179`).
- `verdict_state` and `verification_state` are **closed enums, declared as client constants**, the
  way `VERIFICATION_STATES` already is (`frontend/types/requirement.ts:34`). No facet field is added
  for either.

Everything else is shipped components with a new config: `QuickViewSegment`, `ActiveFilterPills`,
`TableSearchInput`, `ToolbarRow`, `Panel` / `PanelHead` / `TableScrollArea`, `ExportButton`,
`LoadingRows`, `ErrorState`, `TableEmptyState`, `FullHeightPage`, `PageHeader`. The **only** new
shared primitive is the matrix cell.

### 6.6 The three empty states, kept distinct

The shape `work-orders-screen.tsx:129-135, :205-220` distinguishes:

1. **loading** — skeleton rows (`LoadingRows`);
2. **filtered-empty** — `TableEmptyState` + Clear all;
3. **baseline-empty** — only when the `requirements` mirror itself is empty: *"No requirements
   mirrored yet — planning pushes them through `POST /planning/sync`."*

**A partially-judged estate is none of the three.** Today five of ten definitions carry no verdict;
the page is full, correct and useful, and the tiles say so. There is no banner, no spinner and no
"no data" illustration for it — conflating a known phase with "no data" is how a correct screen gets
reported as a bug.

### 6.7 Export

`ExportButton` with client-side paging over the joined rows (no `serverExport`, no export route).
**One CSV, one row per matrix cell**, so the file is the traceability matrix an ASPICE reader asks
for:

`req_id, requirement_title, system, chapter, status, verification_state, definition_id,
definition_title, work_order_id, run_id, outcome, current, produced_at, implementation_sha256,
evidence`

Unlinked intersections are omitted — a row per non-link would be 90 % noise at this shape.

---

## 7. Scope boundary — what this page is NOT

| Not this page | Whose it is | The line between them |
|---|---|---|
| **Authoring** — add / edit / retire a requirement or definition | Requirements page (`requirements-screen.tsx`, shipped) and `dev-planning/authoring-controls/spec.md` | This page writes nothing. Every number on it is derived, so there is nothing here a person could edit that would survive the next read. Every `req_id` and `td_id` links to the screen that does own the edit. |
| **Review** — accept a requirement, claim it, confirm a link | `dev-planning/review-page/spec.md` (`BL-32`, `BL-36`, `BL-33`) | Review is where a human **confirms**. The link store `BL-69` designs is created by confirming, and that act is the review page's. This page reads authored links and says so (§5.3). |
| **The traceability tree** | `/traceability`, `traceability-model.ts` (shipped) | The tree answers *what hangs under what* — project → system → requirement → definition → run. It carries no outcome and gains none here. This page answers *what passed*. They share the join and nothing else. |
| **Baselines and trends** | `BL-39` | A baseline is a **sealed, named set of requirement versions** with coverage computed at seal. This page is always *now* and snapshots nothing. "Coverage over time" is the diff between two seals, not a chart here — building a snapshot table for a trend would be the thing baselines then have to replace. |
| **Running anything** | `dev-planning/bulk-run-buttons/spec.md` and `dev-planning/run-a-definition/spec.md` | No Run button, no re-run, no "evaluate all". `bulk-run-buttons/spec.md` §3 already states this, citing this spec. A report screen must not be the one place in the app where *reading* triggers work. |
| **Per-run detail** | `/runs/{id}` and its Definitions panel | A run's own outcomes, with a live Run cell, already have a screen. Restating them here would be a third place a run's outcome is asserted. The matrix cell links there instead. |
| **Changing the verdict record** | `run-a-definition` / `definition_runs.py` | No field is added to `Verdict`, no change to `verdict_notebook.py`, no change to `record_verdict`. §0 cut both proposed fields. |

---

## 8. Data & interface contracts

### 8.1 Nothing derived is stored

No collection is added, no field is stored, no count is cached. `verdict_state`, `verdict_counts`,
`latest_verdict`, `view_counts` and every matrix cell are computed on each read, for the reason
`requirement-status-from-runs/spec.md` §4.3 already won: the inputs move in six ways nothing would
report — a run deleted, a run flagged invalid, a definition's `covers_req_ids` re-pushed, a
definition removed from a run, a requirement's text edited, a new verdict version stored — and a
stored rollup needs a compensating write on each.

**No index is added.** `test_runs.definition_ids` (`db.py:42, :49`),
`test_definitions.covers_req_ids` (`db.py:69`) and
`processed_results.verdict.definition_id + version` (`db.py:165`) are every access path the fold
uses, and all three exist.

### 8.2 `GET /api/v1/test-definitions` — widened

**New query param**

```
&verdict_state=<repeated>   list[str]   not_run|no_verdict|passed|failed|error
```

Applied in `queries_runs._definition_matches` (`:1527-1551`) beside the existing `work_order`,
`status`, `requirement`, `q`, over the already-derived row, the way `status` is.

**New fields on `TestDefinitionRow`** (`api/api/models/planning.py:62-83`):

| Field | Type | Meaning |
|---|---|---|
| `verdict_state` | `Literal["not_run","no_verdict","passed","failed","error"]` | §3.3 |
| `latest_verdict` | `DefinitionVerdictRef \| None` | null unless some run carries a verdict |
| `verdict_counts` | `{pass:int, fail:int, error:int}` | over the newest verdict of **each** run carrying the definition |
| `runs_with_verdict` | `int` | how many of `actual_runs` produced one |

```python
class DefinitionVerdictRef(ApiModel):
    """The verdict that decided this definition, and the run it came from."""
    run_id: str
    result_id: str
    outcome: Literal["pass", "fail", "error"]
    produced_at: UtcDatetime | None
    implementation_sha256: str
    current: bool          # §3.4 — the implementation pin only
    evidence: dict         # the evaluator's measured values, as stored
```

`evidence` rides on the list row rather than the detail because it is the matrix cell's tooltip and
the evaluators return three to five scalars (`manifest.csv`'s `measured` column). `requirements_files`
is detail-only for the opposite reason — a document is unbounded.

**New envelope field on `TestDefinitionPage`** (`:85-90`):

```python
class DefinitionViewCounts(ApiModel):
    all: int
    not_run: int
    no_verdict: int
    passed: int
    failed: int
    error: int

class TestDefinitionPage(Page[TestDefinitionRow]):
    view_counts: DefinitionViewCounts
```

Whole-table and **filter-independent**, built before the filters narrow the set — the rule
`list_requirements` already states (`queries_requirements.py:357-364`): a filtered tile that
disagrees with what clearing the filter shows is the bug that rule prevents.

> `TestDefinitionPage`'s current docstring says *"It carries no view counts: the Home summary already
> reports the whole-table orphan count, so a second count on this page would say the same thing
> twice."* That reasoning was about **orphans** and stays true — the orphan count is not added here.
> The docstring must be rewritten in the same edit that adds the field, or it becomes a comment
> describing code that no longer exists.

### 8.3 Unchanged

`GET /requirements`, `GET /requirements/facets`, `GET /requirements/{req_id}`,
`GET /test-definitions/facets`, `GET /results`, `POST /results`, the `Verdict` block, the notebook
wrapper, `record_verdict`, the status gate and `planning_sync` are **all untouched**.
`queries_requirements._fold_inputs` changes only by importing §3.5's shared module instead of
holding its two maps inline; `_project`, `_state_fold` and `_view_counts` keep their behaviour byte
for byte.

---

## 9. Work breakdown

| # | Piece | Touches | Owner | Depends on |
|---|---|---|---|---|
| 1 | Extract the shared verdict fold | **new** `api/api/services/verdict_fold.py`; `api/api/services/queries_requirements.py:103-165, :207` (import instead of inline) | ArchDev | — |
| 2 | Definition rollup in the derived row | `api/api/services/queries_runs.py:1499-1524` (`_derived_definitions`), `:1527-1551` (`_definition_matches`), `:1554-1581` (`list_test_definitions` → `view_counts`) | ArchDev | 1 |
| 3 | Models + route param | `api/api/models/planning.py:62-90` (row fields, `DefinitionVerdictRef`, `DefinitionViewCounts`, `TestDefinitionPage.view_counts`, **rewrite the page docstring**); `api/api/routers/test_definitions.py:145-178` (`verdict_state` param) | ArchDev | 2 |
| 4 | Frontend types + client | `frontend/types/test-definition.ts` (the four new row fields, `DefinitionVerdictRef`, `DefinitionViewCounts`, the `VERDICT_STATES` constant); `frontend/lib/api/testDefinitions.ts` (the `verdict_state` filter) | ArchDev | 3 |
| 5 | The join | **new** `frontend/components/screens/test-results/test-results-model.ts` — requirement rows × definition rows → matrix cells, modelled on `traceability-model.ts` | ArchDev | 4 |
| 6 | The screen | **new** `frontend/app/test-results/page.tsx`, `frontend/components/screens/test-results/{test-results-screen,summary-tiles,coverage-matrix,definitions-outcome-table,test-results-table-config}.tsx` | FrontEndEsthetic / ArchDev | 5 |
| 7 | Sidebar entry | `frontend/components/shell/sidebar.tsx:193-194` (one row after Traceability, no count) | ArchDev | 6 |
| 8 | Contract snapshot | `api/docs/openapi.v1.json` via `api/scripts/snapshot.sh` — **`BL-25` is already red for three other models; this adds a fourth** | Tester | 3 |
| 9 | Gate | `pre-commit run --all-files`; `api/tests/test_test_definitions.py` and `api/tests/test_pagination.py` are the two modules most likely to move (the definitions page envelope gains a key); `frontend/tests/components/definitions-screen.test.tsx` already red per `BL-48` | Tester | 7 |

---

## 10. Risks and open questions

**Risks**

1. **Extracting the shared fold touches a live screen.** `queries_requirements._fold_inputs` serves
   the Requirements page, which the user QA'd. Mitigation: the extraction is a move, not a rewrite —
   the two maps and `_newest_verdict_of_td` go across unchanged, and `_project` / `_state_fold` are
   not opened. A red-first check is cheap: call `GET /requirements` before and after and diff
   `view_counts`.
2. **`TestDefinitionPage` gaining a required `view_counts`** changes the envelope shape every caller
   of `GET /test-definitions` sees — the definitions screen, the traceability screen and six mocked
   tests (`BL-48`). None reads the envelope's unknown keys, but the contract snapshot and the mock
   DB (`frontend/lib/mock/db.ts`) both need it.
3. **The client-side join has a real ceiling** and it is written down in §4 rather than discovered:
   `page_size = 200` per list. A customer estate of 500 requirements breaks the page silently — it
   renders a truncated matrix with no warning. Mitigation worth building with the page: if
   `total > items.length` on either list, the panel prints *"showing the first 200 of N"* instead of
   a matrix.

**Open question — the user decides**

1. **OQ1 — Does the page open on the whole estate, or on one work order?** Today there is exactly
   one (`WO-BAT-2026-001`), so the two look identical. **Recommended: estate-wide by default, one
   work order one click away via the Work order filter** — the honest shape for a customer with
   forty campaigns, and if the user wants it to open *on* a campaign the change is a default filter
   value and nothing else.

Everything else revision 1 left open is now settled and recorded above: the `/coverage` route (§4,
not built), `definition_version` and `criterion` (§0, cut), where `stale` renders (§6.3 — on the
cell, never on the row), whether `error` gets a tile (§6.2 — the context line, amber, because §3.3
makes it the one fact only this page can show), and the trend (§7 — `BL-39`'s, not a chart).

---

## 11. Sanity print

### 11.1 The user's three asks

```
covered reqs   SERVED, UNRENDERED  GET /requirements → view_counts.not_covered (live: 0 of 10);
                                   no coverage figure on any screen today
passed reqs    SERVED AND RENDERED GET /requirements → view_counts.tested (live: 3);
                                   Requirements screen quick view + Verification column
passed TD      ABSENT              no definition-side rollup exists anywhere; the only verdict
                                   view is one (run, definition) cell on the run detail
```

### 11.2 The §4 decisions, one line each

```
§4.2 TD rollup   verdict_state + latest_verdict + verdict_counts on TestDefinitionRow, view_counts
                 on TestDefinitionPage. NO new route. Several runs -> the newest run carrying a
                 verdict decides; the older ones stay visible as counts, never as a sixth word.
§4.3 /coverage   NOT BUILT. BL-38 closes: view_counts x2 + the browser join answer the page, and
                 traceability-screen.tsx:13-30 is the shipped precedent for joining in the browser.
§4.4 honesty     The page says "Tested" and means the shipped verification_state, no new word. A
                 permanent header note states that ASPICE Tested needs a confirmed link (BL-69) and
                 a TC version (BL-34), neither of which exists. Coverage is the only percentage and
                 counts AUTHORED links.
§4.5 the page    /test-results, sidebar right after Traceability, no count badge. Five tiles (each
                 printing its unit) + a sparse coverage matrix + a per-definition outcome table.
                 No per-run panel: the run detail owns that.
§4.6 scope       NOT the review page (confirming links), NOT the traceability tree (structure),
                 NOT a baseline (sealed versions), NOT a runner (bulk-run-buttons), NOT authoring.
```

### 11.3 Routes

```
GET /api/v1/requirements            SHIPPED, unchanged   items[] + view_counts -> coverage, tested,
                                                         failed, exercised, verified_by, covering_run_ids
GET /api/v1/requirements/facets     SHIPPED, unchanged   system/chapter/status dropdowns
GET /api/v1/test-definitions        WIDENED              + verdict_state param; rows gain
                                                         verdict_state, latest_verdict,
                                                         verdict_counts, runs_with_verdict;
                                                         envelope gains view_counts
GET /api/v1/test-definitions/facets SHIPPED, unchanged   work_order dropdown
GET /api/v1/results?run=&latest_only=true  SHIPPED       the raw verdict documents; drill-down only
GET /api/v1/coverage                NOT BUILT            §4
GET /api/v1/processed-results       DOES NOT EXIST       processed_results is the collection name
```

### 11.4 Files an implementation touches

```
api/  (ArchDev)
  NEW api/api/services/verdict_fold.py
      api/api/services/queries_requirements.py   :103-165, :207  (import the shared fold)
      api/api/services/queries_runs.py           :1499-1581      (rollup, filter, view_counts)
      api/api/models/planning.py                 :62-90          (+ docstring rewrite)
      api/api/routers/test_definitions.py        :145-178        (verdict_state param)
      api/docs/openapi.v1.json                                   (snapshot; BL-25 already red)

frontend/  (ArchDev + FrontEndEsthetic)
  NEW frontend/app/test-results/page.tsx
  NEW frontend/components/screens/test-results/test-results-model.ts
  NEW frontend/components/screens/test-results/test-results-screen.tsx
  NEW frontend/components/screens/test-results/summary-tiles.tsx
  NEW frontend/components/screens/test-results/coverage-matrix.tsx
  NEW frontend/components/screens/test-results/definitions-outcome-table.tsx
  NEW frontend/components/screens/test-results/test-results-table-config.ts
      frontend/types/test-definition.ts
      frontend/lib/api/testDefinitions.ts
      frontend/lib/mock/db.ts                                    (mock envelope gains view_counts)
      frontend/components/shell/sidebar.tsx      :193-194

nothing else — no collection, no index, no migration, no deployment change
```

---

## 12. References

- `CLAUDE.md` — the 10 requirements, 10 test cases, the 6 PASS / 4 FAIL table, and the SYS.2 rules
  (`verified_by` derived; Covered ≠ Tested; what makes a link suspect).
- `battery-trace-gen/out/manifest.csv` — the expected verdict of every test case.
- `api/api/services/queries_requirements.py:103-272` — the fold this page reads and does not
  reimplement.
- `api/api/services/definition_runs.py:124-190` · `api/api/routers/definition_runs.py` — the shipped
  verdict writer.
- `api/api/services/queries_runs.py:1499-1620` — the definition list this page widens.
- `api/api/requirement_lifecycle.py:11, :56-63` — `Implemented` / `Tested` as projections.
- `frontend/components/screens/traceability/traceability-screen.tsx:13-30` and
  `traceability-model.ts` — the browser-join precedent §4 rests on, and the screen §7 keeps separate.
- `frontend/components/screens/requirements/requirements-screen.tsx:130-135, :178-182` — the quick
  views and the Status / Verification wording this page reuses verbatim.
- `dev-planning/versions-and-links/spec.md` (`BL-69`) · `dev-planning/review-page/spec.md` ·
  `dev-planning/bulk-run-buttons/spec.md` · `dev-planning/requirement-status-from-runs/spec.md` §4.3,
  §4.6, §5.3 — the four specs §7 draws the boundary against.
- `dev-planning/backlog.json` — `BL-19`, `BL-20`, `BL-25`, `BL-34`, `BL-38`, `BL-39`, `BL-48`,
  `BL-51`, `BL-69`.
