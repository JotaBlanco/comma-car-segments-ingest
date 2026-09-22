# Requirements page — the read surface for the requirement entity

**Status:** Draft
**Project:** comma-car-segments-ingest
**Branch / HEAD:** `jama-ui-dev` @ `b8e3e62`
**Created:** 2026-09-22
**Planned with:** Buddy
**Backlog:** `BL-26` (the screen), `BL-27` (the attribute columns). Reads the model specced in
`dev-planning/requirement-status-from-runs/spec.md` (`BL-22`); shows what `BL-11` writes;
omits what `BL-18`, `BL-20` and the versioned model would add.

---

## 1. Goal

A **Requirements page** in the Test Manager — a list and a detail — whose columns are the
requirement attributes the user's ASPICE SYS.2 board specifies, **each rendered according to
where its value comes from**.

The board's whole point is that a reader can tell an authored value from a computed one at a
glance. That is the design problem this spec solves. Everything else — which columns, which
filters, which panels — follows from it.

This spec designs only the **read** surface. It writes no code and adds no write route.

---

## 2. Background

### 2.1 The model this page reads

`dev-planning/requirement-status-from-runs/spec.md` is the governing document and this spec
does not reopen any of its decisions. Its facts, restated only as far as this page needs them:

| Fact | Consequence for this page |
|---|---|
| A requirement is a **light mirrored row** in a new `requirements` collection, fed by `POST /planning/sync`. Planning owns every field. | Nothing on this page is editable. The screen carries the same read-only-mirror header the work-order and definition screens carry. |
| `status` is **authored** and no machine ever writes it. | The Status column shows exactly what a person wrote, always. |
| Automatic movement lands in a **derived** `verification_state`: `not_covered → covered → exercised → failed \| tested`. | A second, separate column. §5.3. |
| `verified_by` is **derived** by inverting the definitions' `covers_req_ids` (board BP5 / defect D1) and is never stored. | Rendered as computed, never as authored. |
| `covering_run_ids` (newest-first, invalid runs excluded, capped at 20) + `covering_run_count` + `latest_run_id`, all derived at read time. | §5.4. |
| `evidence_stale` degrades a `tested` requirement to `exercised` when the requirement moved under its evidence or the implementation was rewritten. | The nearest thing phase 1 has to the board's *suspect*. It is labelled differently on purpose — §9. |
| Verdicts arrive as an optional nested `verdict` block on `processed_results`, written by `BL-11`, which does not exist yet. | Every verdict-dependent value has a defined empty rendering. §8. |
| Every derived value is computed by one server-side projection, `_project` in `api/api/services/queries_requirements.py`. | **The browser computes nothing.** §7.4. |

**Two of that spec's open questions are the user's and this spec does not pre-empt them.**
It is designed to be correct under the recommended answers, and §12 states in full what
changes visually under the alternatives:

- **OQ1** — one status column or two. Recommendation there: **two**. This spec assumes two.
- **OQ2** — light registry vs the board's full versioned model. Recommendation there: **the
  light registry**. This spec assumes it, and omits `version` and `baseline` accordingly.

### 2.2 The board's column semantics

From `https://miro.com/app/board/uXjVHsQqWhY=/`, as recorded in `CLAUDE.md:164-175` and the
backlog note on `BL-27`. Every attribute is exactly one of three things, and the board is
explicit that **derived values are never stored**:

| Attribute | Board says | Notes that bite |
|---|---|---|
| `status` | MANDATORY, **authored** — "a person moves it" | The enum and the legal transitions are **customer configuration**, not code. Excluded from `normative_sha256`, so a status move suspects nothing. |
| `version` | MANDATORY, **system-assigned** | Mints when `content_sha256` changes; identical bytes are refused (`no_op_mint`). Never typed. |
| `baseline` | MANDATORY **as a VIEW**, **derived, multi-valued** | Read from the baseline reverse index; one version sits in many baselines; chips, never stored. |
| `verification_method` | MANDATORY, **authored** | Suspects links: **yes**. |
| `verification_criteria` | MANDATORY, **authored**, **NEW** | Does not exist in today's data — pass criteria live only on the test spec. Suspects links: **yes, strongly**. Must agree with the test spec's `pass_criteria`; disagreement is a sweep finding. |
| `asil` | OPTIONAL, **authored, nullable** | Suspects links when present. |
| `verified_by` | **derived** from the test cases' `covers_req_ids`, never authored | Defect **D1**: an authored value is discarded with a warning. |

Lifecycle: NEW → Draft → Ready for Review → In Review → Reviewed → Implemented → **Tested**,
with **Tested drawn dashed because it is computed and never set by hand**. Rejected leaves
review; Obsolete never reuses an id.

**Covered ≠ Tested**, stated twice on the board: coverage can read 100 % with nothing run.

A link goes **suspect** only on a `normative_sha256` change — `text`, `measurand`,
`system_states`, `verification_method`, `verification_criteria`, attachment refs.

Refusals the UI may one day have to render: `identity_unavailable` (401), `no_op_mint`,
`stale_parent`, `id_reuse`. None of them can occur in phase 1 (§11).

### 2.3 The data this page will be judged against

`battery-trace-gen/data/battery-dc-requirements.json` — ten requirements,
`BAT-SYS-(FUN|PRF|SAF)-NNN`, all `status: "Draft"`, all `verification_method: "Test"`, three
chapters (Functional ×5, Performance ×2, Safety-Fault-Handling ×3), `text` carrying
`{parameter}` tokens, `measurand[{name,unit}]`, `revision: "0.1"`, `related_reqs: []`,
`figure_refs: []`, and an authored `verified_by` that `BL-17` deletes.

`battery-trace-gen/data/battery-dc-parameters.json` — eleven parameters with `used_by`;
requirement text renders as `name (value unit)`, e.g. `T_batt_max (60 degC)`.

Ten definitions (one per requirement), four runs, an expected 6 pass / 4 fail
(`battery-trace-gen/out/manifest.csv`). **Nothing has been run against the lake yet**, so
every verdict-dependent column has an empty state that will be on screen for the whole demo
until `BL-11` lands. Designing those empty states is half this spec's work.

### 2.4 The frontend idioms this page must match

Read before building: `frontend/components/screens/work-orders/work-orders-screen.tsx`,
`.../runs/runs-screen.tsx`, `.../definitions/definitions-screen.tsx`,
`.../definitions/definition-detail-screen.tsx`.

| Idiom | Where |
|---|---|
| URL-backed table state — multi filters, single filters, sort whitelist, quick views, page size | `frontend/lib/table-state.ts`, `useTableState(config, pathname)` |
| Quick views as **set-equality presets** with counts from the list envelope's `view_counts` | `frontend/components/shared/quick-view-segment.tsx`; `runs-screen.tsx:82-86, :166-173` |
| Filter options from a **whole-table `/facets` route**, never a typed list, when the values are a customer's strings | `runs-screen.tsx:60-70, :162-164` — the comment records the bug a typed list caused |
| Active filters always named, whether the panel is open or shut | `shared/active-filter-pills.tsx` |
| Pager reads the envelope, never the request state | `shared/table-pager.tsx`; `definitions-screen.tsx:147-161` |
| Three distinct empty states: loading, filtered-empty, baseline-empty | `work-orders-screen.tsx:129-135, :205-220` |
| Detail = **stacked panels, no tabs** | `definition-detail-screen.tsx` (the run detail is the only tabbed screen, and only because it hosts SQL/Explore sub-apps) |
| A field's origin badge sits **in the label**, not the value | `shared/meta-grid.tsx:26-41` — `MetaCell` already takes `source` |
| No table column picker anywhere; the picker that exists governs the **export file** | `runs-screen.tsx:339-343`, `frontend/tests/components/export-columns.test.tsx` |

`frontend/components/screens/definitions/implementation-panel.tsx` was added by the
multi-definition work and is the newest example of a detail panel.

---

## 3. Design in one paragraph

The page is a **work-orders-shaped list** over the mirrored `requirements` collection, with
one addition that is the reason it exists: **every column declares where its value came
from, by one badge in the column header, and the badge is dashed when the value was computed
and solid when a person wrote it** — the board's own "Tested is dashed because it is
computed", generalised from one box to every attribute. Nine columns ship; the detail is a
stack of panels split the same way, an **Authored** block owned by planning and a **Derived**
block owned by the Test Manager, with the requirement's text rendered with its parameter
tokens resolved and one table joining covering runs to their verdicts. Four attributes the
board mandates — `version`, `baseline`, `verification_criteria`, `asil` — have no input in
phase 1 and are therefore **absent rather than blank**, because a blank column is a claim
("this requirement is in no baseline") that phase 1 cannot support, while an absent one
claims nothing. Filters, facets, quick views, pills, pager and empty states are the existing
components with a new config object; the only new shared primitives are a five-value
verification chip and one new `SourceKind`.

---

## 4. The column table

`A` = authored (planning owns it) · `S` = system-assigned · `D` = derived, never stored.

| # | Attribute | Origin | List | Detail | Empty behaviour | Phase |
|---|---|---|---|---|---|---|
| 1 | `req_id` | A | **col 1**, mono, row link | header, mono 1.35rem | never empty (it is `_id`) | **1** |
| 2 | `title` | A | **col 2**, `whitespace-normal` | sub-line + authored grid | `—` | **1** |
| 3 | `chapter` | A | **col 3** | authored grid | `—` | **1** |
| 4 | `status` | A | **col 4**, neutral `ToneBadge` | authored grid | `—` (a mirror with no status) | **1** |
| 5 | `verification_state` | D | **col 5**, coloured chip | derived grid | never empty — `not_covered` is a real answer, not an absence | **1** |
| 6 | `verification_method` | A | **col 6** | authored grid | `—` | **1** |
| 7 | `verified_by` | D | **col 7**, up to 2 td chips then `+N` | derived grid, all chips, each → `/definitions/{td}` | `Not covered` in `text-ink-3` — **not** a dash: the derivation ran and returned nothing, which is a finding, not a blank | **1** |
| 8 | `latest_run_id` | D | **col 8**, mono link → `/runs/{id}` | derived grid | `—` while no run carries a covering definition | **1** |
| 9 | `covering_run_count` | D | **col 9**, right-aligned mono | derived grid | `0` — a count is never a dash | **1** |
| 10 | `evidence_stale` | D | — (rides col 5 as a marker) | derived grid + per-evidence row | `false` renders nothing at all | **1** |
| 11 | `tested_at` | D | — (export only) | derived grid | `—` until a `tested` fold succeeds | **1** |
| 12 | `covering_run_ids` | D | transport only (capped 20) | the **Runs covering this requirement** table, uncapped | "No run has carried a covering test definition yet." | **1** |
| 13 | `evidence[]` (verdict, numbers, digest, current) | D | — | same table | "No verdict has been written yet — `BL-11` writes them." | **1** |
| 14 | `text` (+ `text_rendered`) | A | — | **Requirement text** panel | `—` | **1** |
| 15 | `measurand[]` | A | — | authored grid, chips `name (unit)` | `—` | **1** |
| 16 | `system_states[]` | A | — | authored grid, chips | `—` | **1** |
| 17 | `ears_pattern` | A | — | authored grid | `—` | **1** |
| 18 | `revision` | A | — | authored grid, labelled **Revision (authored)** | `—` | **1** |
| 19 | `rationale` | A | — | full-width block under the grid | hidden when absent | **1** |
| 20 | `source[]` | A | — | authored grid, chips | `—` | **1** |
| 21 | `related_reqs[]` | A | — | authored grid, chips → `/requirements/{id}` | `—` | **1** |
| 22 | `normative_sha256` / `normative_changed_at` | D | — | derived grid, mono 12-hex + timestamp | never empty | **1** |
| 23 | `synced_at` | S | — | header lock-line + derived grid | never empty | **1** |
| 24 | `asil` | A | **omitted** | authored grid, **rendered only when the row carries one** | — | 1 (field), 2 (column) |
| 25 | `verification_criteria` | A | **omitted** | authored grid, **rendered only when the row carries one** | — | `BL-18` |
| 26 | `version` | S | **omitted** | omitted | — | OQ2 |
| 27 | `baseline[]` | D | **omitted** | omitted | — | OQ2 |
| 28 | link `suspect` state | D | **omitted** | omitted (`evidence_stale` is the phase-1 approximation, under a different name) | — | OQ2 |

§8 justifies every omission. The default column set is **all nine** — there is no table column
picker in this repo and this page does not introduce one. The wider set (rows 10-13, 17, 18,
22) reaches a person through the **export**, which is where this repo already puts columns the
table does not show.

**Decision — Title is its own column, not a sub-line under the id.** The runs list puts
`description` under `run_id`; the work-order and definition lists give Title its own column.
This page is a mirrored planning catalog, so it follows the catalog screens. Requirement
titles run to 54 characters ("Charging current derating near the temperature ceiling") and
wrap cleanly in a `whitespace-normal` cell; stacked under a mono id they would double every
row height.
*Rejected:* id + title stacked (the runs shape) — it saves a column and costs row density on
the one screen where a person scans ten rows for one id.

**Decision — `verification_method` keeps a column although all ten of ours read `Test`.**
It is board-MANDATORY and it is one of the six fields whose change suspects a link. A constant
column today is a varying column the first time a customer states `Analysis` or `Review`, and
an ASPICE reader looks for it in the grid.
*Rejected:* detail-only — it would be the only mandatory authored attribute a person cannot
see while scanning, which is the opposite of what the board asks the grid to do.

---

## 5. The visual rule for origin

### 5.1 The rule

> **Dashed means computed. Solid means authored. The mark is the existing `SourceBadge`, it
> carries the origin of the value and never its health, and it appears exactly once per place
> a value appears — in the column header on the list, in the field label on the detail.**

That is the whole rule. It is not invented: the board already draws the one computed box of
its lifecycle **dashed** for exactly this reason. This spec applies the board's own notation
to every attribute instead of to one.

### 5.2 How it is built — one new tag on a component that already exists

`frontend/components/shared/source-badge.tsx` already renders the origin of a value, with a
tooltip and a matching `aria-label`, from `SourceKind = "embedded" | "manual" | "api:<system>"`.
`frontend/components/shared/meta-grid.tsx` already places it in the label of a `MetaCell`.
`frontend/components/screens/definitions/definition-detail-screen.tsx:157-164` already hoists
it to a `PanelHead` when a whole panel shares one origin.

The change is **one value and one class**:

```
SourceKind  += "derived"
variantClass += derived: "border-dashed border-line bg-transparent text-ink-3"
sourceMeaning("derived")
  -> "The Test Manager computed this value from other records. Nothing stores it and nobody can edit it."
```

Everything else — the lazy tooltip, the `role="note"`, the `aria-label`, the focus handling —
comes for free and stays identical. Authored requirement fields render the tag they already
carry, `api:planning`.

### 5.3 Where the mark lands

| Place | Mark |
|---|---|
| **List column header** | one badge beside the header text, once per column: `Status` + `api:planning` (solid), `Verification` + `derived` (dashed), `Verified by` + `derived`, `Latest run` + `derived`, `Runs` + `derived`. Columns 1-3 and 6 take `api:planning`. |
| **List cells** | **no badge at all.** Ten rows × five derived columns is fifty badges saying what five headers already say. |
| **List row id cell** | **no badge** — the work-orders list puts `api:planning` beside each `wo_id` because every field of that row shares one origin. Here they do not, so a badge on the id would mislabel the rest of the row. This is a deliberate divergence from `work-orders-screen.tsx:230` and the reason is in that sentence. |
| **Detail `MetaCell`** | the existing `source` prop, per field. |
| **Detail `PanelHead`** | one badge for a panel whose every field shares an origin, worded as the definition detail words it. |

### 5.4 Why it survives dark mode and a narrow window

- **Dark mode**: the badge is built from semantic tokens (`border-line`, `text-ink-3`,
  `bg-muted`, `bg-accent-soft`) that already flip with the theme, and the new variant adds a
  **border-style**, not a colour. `border-dashed` has no contrast ratio to fail. The one
  genuinely new colour decision on this page is the verification chip, and it reuses the
  existing `ToneBadge` tones (`green` / `red` / `amber` / `neutral`) whose dark values are
  already tuned.
- **Narrow window**: the badge is 0.6 rem mono inside a header cell that already wraps, and
  the table already lives in a horizontally scrolling `TableScrollArea`. When a header is too
  narrow to show text + badge, the badge wraps below the label — it never truncates the label,
  because it follows it.
- **Colour is never the only carrier.** Origin = border-style + tooltip + `aria-label`.
  Verification = tone + word + `aria-label`. A monochrome print, a colour-blind reader and a
  screen reader all get the same answer.
- **Degradation**: a reader who never hovers a badge still reads two labelled column groups
  and one sentence in the page header. The badge sharpens the story; it is not load-bearing
  for comprehension.

*Rejected — a per-column visual convention (italic derived headers, a grey background on
derived cells, a separator between the authored and derived halves of the table).* Each is a
new rule a reader must learn, each is invisible to a screen reader, a background tint fails
contrast against the row-hover state, and a column-group separator breaks the moment a
customer's column order differs from ours.
*Rejected — a legend row above the table.* It states the rule once, far from any value, and it
is the first thing a person stops reading.
*Rejected — inventing a second badge component for derived values.* Two components rendering
the same idea drift; one component with one more tag cannot.

---

## 6. The list screen

`frontend/app/requirements/page.tsx` → `frontend/components/screens/requirements/requirements-screen.tsx`.
Shaped on `work-orders-screen.tsx` (a mirrored catalog, one toolbar row, no sort control), not
on `runs-screen.tsx` (two toolbar tiers, batch selection, grouping) — this list has ten rows in
the demo and no batch operation exists on a read-only mirror.

```
PageHeader   "Requirements"
             sub: [api:planning] Read-only mirror of the planning system.
                  Status is authored there; Verification is computed here from runs and
                  verdicts — the two move independently.

Toolbar row  [ All | No evidence | Failed | Tested ]  [ search ]  ...  [Chapter▾] [Status▾]
             [Verification▾] [Method▾]  [Export]  [Save search]

ActiveFilterPills

Panel "Mirrored requirements"        action: synced_at <last planning sync>
  Table  (9 columns, each header carrying its origin badge)
  TablePager
```

- **Header**, exactly the mirror note the definitions and work-orders screens carry, plus the
  one sentence that pre-empts the `Draft` + `tested` reading (§5 of the risk list).
- **Row link** → `/requirements/{req_id}` through `RowLink` / `RowLinkLabel`.
- **Status cell** — `ToneBadge tone="neutral"` for **every** value. **The status enum is
  customer configuration (`BL-20`), so the code does not know which value is good.** Colouring
  `Reviewed` green would be the Test Manager asserting a policy it does not hold, and the
  first customer whose terminal state is `Released` gets a grey terminal state and a green
  intermediate one. Colour is reserved for `verification_state`, whose five values this code
  defines.
  *Rejected:* a tone map over the board's nine lifecycle values — correct for this customer,
  wrong for the next, and it would put two coloured badges side by side competing to be "the"
  status.
- **Verification cell** — `<VerificationChip state={...} stale={...} />`, a new shared
  component in `frontend/components/screens/requirements/verification-chip.tsx`, built on
  `ToneBadge`:

  | state | tone | label | when |
  |---|---|---|---|
  | `not_covered` | neutral, no dot | `Not covered` | no test case names it |
  | `covered` | neutral, dot | `Covered` | a test case names it, nothing has run |
  | `exercised` | amber, dot | `Exercised` | a run carried it; no verdict yet, or an `error` verdict |
  | `failed` | red, dot | `Failed` | the newest verdict of some covering test case is `fail` |
  | `tested` | green, dot | `Tested` | every covering test case's newest verdict is `pass`, and current |

  `evidence_stale` appends a separate neutral outline chip **`stale`** — never a colour change
  on the state chip, so "the evidence aged" can never be misread as "the test failed".
- **Verified by cell** — up to two mono td chips, then `+N`; `Not covered` in `text-ink-3` when
  the derivation returns nothing.
- **Latest run / Runs** — §6.1.
- **Export** — `ExportButton` with client-side paging only (no `serverExport`: no
  `/requirements/export` route exists and none is proposed). Its `CsvColumn[]` carries the nine
  table columns **plus** `ears_pattern`, `revision`, `verification_state`, `evidence_stale`,
  `tested_at`, `covering_run_ids` (joined), `normative_sha256`, `synced_at`. This is the answer
  to "a small default column set" — the extra attributes are reachable, in the place this repo
  already reaches them, through a component and a picker that already exist and are already
  tested (`frontend/tests/components/export-columns.test.tsx`).
  *Rejected:* a table column picker — this repo has none, it is state to persist and a second
  idiom to learn, and it would make the page the only list whose columns differ per person
  while the whole point of the page is that everyone reads the same nine.
  *Rejected:* no export at all — then a 9-column table is the only view of a 28-attribute
  entity and the ASPICE reader's first request has no answer.
- **Three empty states**, verbatim in shape from `work-orders-screen.tsx`: `LoadingRows`;
  `TableEmptyState` with Clear-all when filters are on; and the baseline
  *"No requirements mirrored yet — planning pushes them through `POST /planning/sync`."*
- **No sortable headers.** `GET /requirements` whitelists no sort key; the server orders by
  `req_id` ascending, which is the order an auditor reads a requirement set in. A `SortableTh`
  bound to a key the route rejects is the bug `runs-screen.tsx:412-417` records.

### 6.1 Covering runs on the list

| Column | Renders | Empty |
|---|---|---|
| **Latest run** | `latest_run_id` as a mono `Link` to `/runs/{id}`, exactly as the runs list renders a definition id (`runs-screen.tsx:472-483`) | `—` |
| **Runs** | `covering_run_count`, right-aligned mono, like Files / Signals | `0` |

**No chips on the list.** A cell holding up to twenty run chips sets the row height of the
whole table by its worst row, and a person scanning ten requirements wants "is there evidence,
and what is the newest" — a link and a number. The chips live on the detail, where there is
one requirement and room for them.

**Ordering** is the server's and the browser never re-sorts: newest **bench session** first —
`first_data_at` DESC, `run_id` DESC — the same key the definition detail already sorts its runs
by (`api/api/services/queries_runs.py:1467`), so the two screens can never disagree about which
run is the latest.

**The cap at 20 is a transport cap, not a display cap, in phase 1.** The list renders only
`latest_run_id` and `covering_run_count`, and the count is the **true** total, so nothing on
screen is truncated and nothing needs a "+N more". The cap becomes visible only if a future
column renders the chips; at that point the rule is: render the capped array, and when
`covering_run_count > covering_run_ids.length`, the last chip is `+N more` linking to the
detail, which is uncapped.

---

## 7. The detail screen

`frontend/app/requirements/[reqId]/page.tsx` →
`frontend/components/screens/requirements/requirement-detail-screen.tsx`.

**Panels, not tabs.** Every entity detail in this repo — definition, work order, file, signal —
is a stack of panels; the run detail is the only tabbed screen, and only because it hosts SQL,
Explore and Anomalies sub-apps. A requirement hosts no sub-app: it has one long text, two
attribute grids and one table. Tabs would hide the evidence table behind a click on the screen
whose reason for existing is the evidence.
*Rejected:* tabs `Attributes | Evidence | History` — three clicks to answer "is this
requirement tested and by what", and it breaks Ctrl-F over the page.

The stack, in order:

**A. Header block** — `req_id` mono 1.35 rem · `SourceBadge api:planning` ·
`ToneBadge` status · `VerificationChip` · sub-line `title · chapter · ears_pattern` · the
lock line *"Read-only mirror — owned by the planning system · synced_at …"*, copied from
`definition-detail-screen.tsx:147-153`. Breadcrumbs: `Crumb type="Req" current`.

**B. Panel "Requirement text"** — the requirement, rendered, with every `{parameter}` token
resolved to `name (value unit)` and each resolved token drawn as an inline mono chip so a
reader sees **where** substitution happened:

> While the battery temperature is not less than `T_batt_max (60 degC)` minus
> `T_batt_safety_threshold (5 degC)` and not more than `T_batt_max (60 degC)`, the battery
> system shall apply to the actual charging current limit a derating factor that decreases
> linearly from 1,0 to 0,0 across that band.

The panel's `action` carries a small toggle **"Show tokens"** that swaps the rendered string
for the raw `text` — because the raw string is the one inside `normative_sha256`, and an
auditor asking "what changed" needs the hashed bytes, not the render.

**Where the substitution happens — a decision this spec adds to the model.** The `requirements`
mirror holds no parameter set, so someone must resolve the tokens. **Chosen: the seed pushes
both** — `text` verbatim (tokens, hashed) **and** `text_rendered` (resolved) — as two mirrored
strings on the same row. The parameter set belongs to planning and to
`battery-trace-gen/data/battery-dc-parameters.json`; it is not the Test Manager's to model.
*Rejected:* a fourth mirrored collection for parameters — a whole collection, a sync path and
a resolution pass in the API, to produce a display string.
*Rejected:* resolving in the browser — the browser would need the parameter set over a route
that does not exist, and two clients would render one requirement two ways.
This addition has a hash consequence that is **OQ3** in §12, and ArchDev must not settle it
alone.

**C. Panel "Authored attributes"** — `PanelHead` action:
`all fields <SourceBadge source="api:planning" /> — owned by planning, never editable here`.
`MetaGrid` (4 columns): Status · Verification method · Chapter · EARS pattern · Revision
(authored) · System states · Measurands · Source · Related requirements — plus **ASIL** and
**Verification criteria** *only when the row carries them* (§8). `rationale` runs full width
**below** the grid, not inside a 4-column cell, because it is two sentences of prose.

Measurands render as chips `t_batt (degC)`. **They do not link to `/signals/{name}` in phase
1**: our measurand names include `t` (time) and `derating_factor`, which are not catalogued
signals, and a link that 404s on a traceability screen is worse than no link. Joining
measurands to the signal catalog is named in §11.

**D. Panel "Verification"** — the derived block. `PanelHead` action:
`all fields <SourceBadge source="derived" /> — computed from runs and verdicts, never stored`.
`MetaGrid`: Verification state (chip) · Evidence (`current` / `stale, since …`) · Verified by
(every td as a chip → `/definitions/{td}`) · Covering runs (count) · Latest run (link) ·
Tested at · `normative_sha256` (first 12 hex, mono) · `normative_changed_at`.

**E. Panel "Runs covering this requirement"** — one table, not two lists. `covering_run_ids`
without its verdict is half the answer, so the run and its verdict share a row. Shaped on
`definition-detail-screen.tsx:238-298`.

| Run | Definition | Arrived | Verdict | Evidence | Current |
|---|---|---|---|---|---|
| `TAS-1001` → `/runs/TAS-1001` | `BAT-SYS-TC-003` → `/definitions/...` | `formatArrival(first_data_at)` | `pass` / `fail` / `error` tone badge, or `—` | the verdict's numbers as `key: value` chips (`max_degc: 61.2 · limit_degc: 60.0`) | ✓, or `stale` + which check failed |

One row per `(run, definition)` — a run covering two definitions of one requirement yields two
rows, while `covering_run_count` counts **distinct runs**. Ordered newest bench session first,
uncapped. Two empty states, and they say different things:
*"No run has carried a covering test definition yet."* versus
*"These runs carry the covering test definitions. No verdict has been written for them yet."*

**F. `EntityHistoryPanel`** — the requirement's journal, the same component the file, signal,
work-order and definition screens show. The model spec already journals requirement mirrors and
already teaches `routers/journal.py:67-74` the `requirement` entity type, so the timeline says
who moved a status or a text, and when — which is the ASPICE bit that gets audited.
**Read-only in phase 1: no `AddNoteButton`**, because a note is a person writing into the
Test Manager and this page is a read surface (§11).

---

## 8. What is absent in phase 1, and why

**The rule, stated once:** *a column ships when at least one row can carry a value. Otherwise
the attribute is absent, because an absent column claims nothing while a blank column claims
something false.*

"Baselines: —" says *this requirement is in no baseline*. The truth is *this system does not
know what baselines exist*. The first is a defect an auditor can act on; the second is a scope
boundary. The same argument holds for each row below.

| Attribute | Blocked on | Phase 1 | Why this and not the other |
|---|---|---|---|
| `verification_criteria` | `BL-18` — the field exists in no requirement; pass criteria live only on the test spec | **Omitted from the list. Rendered on the detail only when the row carries one.** The field is added to the mirror and to `normative_sha256` now (the model spec already has it), so a customer who pushes one sees it the same day. | A permanently blank column beside eight populated ones teaches the reader the field is optional — the exact opposite of the board's MANDATORY. Adding it to the hash now, and to the grid later, costs nothing and reverses nothing. |
| `asil` | nothing structural; our ten requirements simply carry none | Same treatment: **`asil: str \| None` on the mirror and the row model** (one line, the board names it), **omitted from the list**, on the detail only when present. Promote to a list column when any requirement carries one. | The board itself calls it OPTIONAL, so an empty cell is not a finding — but ten empty cells are a column of noise on a nine-column table. |
| `version` | **OQ2** — the versioned model: an item/version split, `content_sha256`, minting, `no_op_mint` | **Omitted entirely.** `revision` (`"0.1"`, authored free text) is on the detail, labelled **Revision (authored)** so nobody reads a mint into it. | A `version` column filled from `revision` would be a lie with a number in it: `revision` is typed by a person and `version` is minted by a machine, and the board's whole point about `version` is that it is never typed. |
| `baseline` | **OQ2** + a baseline reverse index that does not exist | **Omitted entirely** — no column, no panel, no chips. | See above. A baseline chip row is also the one place where "derived, multi-valued, never stored" is most visible, so it is the first thing to build if the user answers OQ2 the other way. |
| link `suspect` state | the `verifies` link entity with confirmed/suspect states (**OQ2**) | **Omitted.** The model spec's `evidence_stale` ships and is rendered — but it is labelled **`stale`** and described as *"the requirement moved under this evidence"* or *"the implementation was rewritten since this pass"*. It is **never** called *suspect*. | Different mechanism, different word. Reusing the board's word for an approximation of it is how a reader comes to believe the system implements per-link suspect state when it does not. §9.4. |
| refusal codes (`identity_unavailable`, `no_op_mint`, `stale_parent`, `id_reuse`) | a minting API this system does not have | **No rendering.** Requirements arrive already minted through `POST /planning/sync`; none of these four can reach this page. | Rendering an error that cannot occur is untestable code defending a contract that already holds. |
| a coverage / ASPICE export report | nobody has asked | **Omitted.** The CSV export carries the columns; a formatted report is a different artifact. | Named in §11 so it is a choice and not an oversight. |

---

## 9. Departures from the board

1. **Dashed = computed is applied to every attribute, not just to `Tested`.** The board draws
   one dashed box. We generalise its notation into the page's single origin rule. **Cost:** a
   reader who knows the board will look for a dashed *box in a lifecycle* and find a dashed
   *badge on a header*. The tooltip and the `aria-label` say the same sentence the board's
   legend says.
2. **Two columns, not one lifecycle.** Inherited from the model spec §9.4 under **OQ1**: the
   board's dashed `Tested` sits inside the lifecycle; ours sits beside it, because a machine
   must never appear to have moved a person's value. §12 shows what changes if the user picks
   the in-line display instead.
3. **`verification_state` has five values; the board's lifecycle has one computed box.**
   Inherited from the model spec §9.3. `exercised` exists because it is the only state that
   can move before `BL-11` ships, and it is the state every one of our ten requirements will
   sit in for the whole demo.
4. **`verified_by` chips carry no confirmed/suspect state**, because phase 1 has no link
   entity to carry one. **Cost, and it is the sharpest one on this page:** the board's
   `verified_by` is a *verifies link with a state*, and an unadorned chip reads as *confirmed*.
   Mitigation: the derived panel's badge tooltip says "computed by inverting the test cases'
   `covers_req_ids`", which names the mechanism and implies its limit. Ugly, honest, and the
   first thing OQ2 fixes.
5. **Every authored `status` renders in one neutral tone** — the board colours nothing, but a
   reader expects colour and we withhold it deliberately. §6, and it is the direct consequence
   of the board's own "the enum and the transitions are customer configuration".
6. **`text_rendered` is a mirrored display string the board does not name.** §7B, **OQ3**.
7. **`version` and `baseline` are absent**, not empty. §8.

---

## 10. Read API contract

Three read routes, all `GET`. **No write route.** Authored edits — status moves, criteria,
ASIL — are out of scope for this page in this phase: requirements arrive from planning through
`POST /planning/sync`, which is the one door the catalog enters by, and a second write path
would fork the provenance story the mirror exists to keep whole.

```
GET /api/v1/requirements
      ?page=&page_size=&q=
      &chapter=<repeated>&status=<repeated>&state=<repeated>&method=<repeated>
GET /api/v1/requirements/facets
GET /api/v1/requirements/{req_id}
GET /api/v1/requirements/{req_id}/journal?page=&page_size=&kind=
```

### 10.1 `GET /requirements`

`RequirementPage` = `Page[RequirementRow]` + `view_counts`, the envelope `WorkOrderPage`
already uses (`api/api/models/planning.py:33-36`). Order: `req_id` ascending, server-side, not
configurable. Repeated params for the four multi filters, as `GET /test-runs` already takes
`status` / `rig` / `project`.

```jsonc
{
  "items": [ /* RequirementRow */ ],
  "page": 1, "page_size": 20, "total": 10, "total_pages": 1,
  "view_counts": {
    "all": 10, "not_covered": 0, "covered": 10, "exercised": 0,
    "failed": 0, "tested": 0,
    "no_evidence": 10          // not_covered + covered — the quick view's count, §11.1
  }
}
```

`RequirementRow` — every derived field marked `D`, and **every `D` is computed by the API**:

```jsonc
{
  "req_id": "BAT-SYS-SAF-002",
  "title": "Battery temperature ceiling",
  "chapter": "Safety-Fault-Handling",
  "status": "Draft",                       // authored
  "verification_method": "Test",           // authored
  "ears_pattern": "Ubiquitous",            // authored
  "revision": "0.1",                       // authored
  "asil": null,                            // authored, nullable — NEW on the model spec's row

  "verification_state": "covered",         // D
  "evidence_stale": false,                 // D
  "verified_by": ["BAT-SYS-TC-003"],       // D  — BP5, never stored
  "covering_run_ids": [],                  // D  — capped at 20 here, transport only in phase 1
  "covering_run_count": 0,                 // D  — the true total
  "latest_run_id": null,                   // D
  "tested_at": null,                       // D

  "synced_at": "2026-09-23T08:00:00Z"
}
```

`asil` is the one field this spec adds to the model spec's `RequirementRow`. It costs one
optional string on `PushedRequirement`, the mirror and the row; the board names it; and
without it a customer who pushes an ASIL sees it silently dropped into `raw`.

### 10.2 `GET /requirements/facets`

```jsonc
{ "chapters": ["Functional", "Performance", "Safety-Fault-Handling"],
  "statuses": ["Draft"],
  "methods":  ["Test"] }
```

Distinct values over the **whole** collection, each sorted ascending — the contract
`GET /test-runs/facets` and `GET /work-orders/facets` already keep. The filtered list cannot
serve these: after a chapter selection it holds one chapter, and a person could then never add
a second. `verification_state` is **not** in the facets: its five values are defined by this
code, so the option list is typed in the frontend.

### 10.3 `GET /requirements/{req_id}`

`RequirementDetail` extends the row with the authored long fields — `text`, `text_rendered`,
`measurand`, `system_states`, `rationale`, `source`, `related_reqs`, `verification_criteria`,
`figure_refs` — the derived `normative_sha256` / `normative_changed_at`, the **uncapped**
`covering_run_ids`, and `evidence[]`:

```jsonc
"evidence": [
  {"run_id": "TAS-1001", "definition_id": "BAT-SYS-TC-003",
   "definition_title": "Battery temperature ceiling holds under charge",
   "first_data_at": "2026-09-23T09:41:00Z",
   "outcome": "fail", "produced_at": "2026-09-23T10:12:00Z",
   "implementation_sha256": "9f2b0a11…", "current": true,
   "evidence_values": {"max_degc": 61.2, "limit_degc": 60.0}}
]
```

A covering run with **no** verdict still produces a row, with `outcome: null` — otherwise the
detail could not show *"this ran and nobody judged it"*, which is the state all ten of ours are
about to be in for weeks.

404 `requirement_not_found`, matching `td_not_found` / `wo_not_found`.

### 10.4 `GET /requirements/{req_id}/journal`

One more read, and it is the same read the other five entity types already serve
(`api/api/routers/journal.py:84-90`: same `kind` filter, same default page size 50, same
`at`-descending order, same `Page[JournalEntry]`). It exists because the model spec already
adds `"requirement": ("requirements", "Requirement", "requirement_not_found")` to
`_ENTITIES`, and because every detail screen in this app carries an `EntityHistoryPanel`. It
is a read; it adds no writer.

### 10.5 The rule that holds the page together

**The browser computes nothing.** Every `D` field is produced by the model spec's `_project`,
the one function both the list and the detail call, so the two can never disagree and a value
the UI labels `derived` was in fact derived by the service that owns the fold. A frontend that
computed `verification_state` from `evidence[]` would be a second implementation of §5.3 of
the model spec, and the first to drift.

---

## 11. Filters, facets and quick views

One `TableStateConfig`, the runs/work-orders idiom, nothing new:

```ts
const REQUIREMENTS_TABLE_CONFIG: TableStateConfig = {
  multiKeys: ["chapter", "status", "state", "method"],
  singleKeys: [],
  sortKeys: [],                 // GET /requirements whitelists none
  defaultSort: null,
  defaultPageSize: 20,
  pageSizeOptions: [10, 20, 50, 100, 200, 500],
  quickViews: [
    { id: "all",         params: {} },
    { id: "no-evidence", params: { state: ["not_covered", "covered"] } },
    { id: "failed",      params: { state: ["failed"] } },
    { id: "tested",      params: { state: ["tested"] } },
  ],
};
```

### 11.1 Quick views

`QuickViewSegment` with counts from `view_counts`: **All · No evidence · Failed · Tested**.

**"has no covering run" is the `no-evidence` quick view**, a two-value set-equality preset
exactly like the runs screen's `attention: ["awaiting_work_order", "invalid"]`. It is
`not_covered ∪ covered` — no test case at all, *or* a test case that nothing has run — because
both answer the question a person is actually asking: *what has no evidence behind it?* Its
count is served as `view_counts.no_evidence`, one more int in the fold, rather than summed in
the browser, so the badge and the row count come from one place.
*Rejected:* a boolean `has_no_covering_run=true` filter in the toolbar panel, the shape
`definitions-screen.tsx` uses for `?orphaned=true` — it would be a fifth control for a subset
the quick views already express, and quick views are where this repo puts "the subset a person
asks for on nearly every visit".

### 11.2 Panel filters

`MultiSelectFilter`, multi-select, four of them:

| Filter | Options from | Why |
|---|---|---|
| **Chapter** | `/requirements/facets` | a customer's free string; a typed list is the bug `runs-screen.tsx:60-70` records |
| **Status** | `/requirements/facets` | the enum is customer configuration (`BL-20`) — the code must not own the list |
| **Verification** | typed, five values | this code defines them; a facet over five constants is a wasted round trip and an empty option list on an empty estate |
| **Method** | `/requirements/facets` | free string from planning |

Plus `TableSearchInput` → `q` over `req_id`, `title`, `text`; `ActiveFilterPills` naming every
active filter whether the panel is open or shut; `SavedSearchButton scope="requirements"`;
`TablePager` reading the envelope.

Layout: the work-orders single toolbar row, not the runs two-tier `ToolbarPanel` — four filters
and a search fit one row, and the second tier exists on the runs screen to hold grouping and
batch controls this page does not have.

### 11.3 What the filter set touches outside this screen

`SavedSearchScope` is a closed union with a compile-enforced key map
(`frontend/lib/saved-searches.ts:45-64`): adding `"requirements"` is two lines and the compiler
finds every reader. Check whether `api/api/models/searches.py` validates the scope; if it is a
free string, the server needs nothing.

---

## 12. What changes if the user answers OQ1 / OQ2 the other way

Both answers change **this page only** — no route, no model, no fold.

**OQ1, the in-line display** (Status shows `Tested` when `verification_state == tested`, the
authored value otherwise): the list drops from nine columns to eight; the Status header's
origin badge becomes ambiguous and must be replaced by **both** badges, `api:planning` and
`derived`, which is the visual admission that the column now mixes two origins; the
`Draft` + `tested` case stops being visible at all, and with it the page's ability to show that
a tested requirement was never reviewed. The detail keeps both fields regardless, because the
evidence panel must state what produced the word. **Recommended answer stands: two columns.**

**OQ2, the board's full versioned model**: two columns return to the list — **Version**
(system-assigned, solid badge, mono) and **Baselines** (derived, dashed badge, chips with a
`+N` overflow) — taking it to eleven, at which point Chapter moves to the filter panel only and
the export carries it. The detail gains a **Baselines** panel and a **Versions** panel, the
`verified_by` chips gain a per-link `confirmed` / `suspect` marker, and `evidence_stale` is
replaced by the real thing and its word changes from `stale` to `suspect`. **That is the only
place in this design where a phase-2 answer renames a phase-1 word**, and §9.4 keeps the two
words apart precisely so the rename is safe.

---

## 13. Build list for ArchDev

Prerequisite: the model spec's build list (`dev-planning/requirement-status-from-runs/spec.md`
§10) lands first. This list is additive to it. **FrontEndEsthetic owns the look; ArchDev makes
it correct; Tester runs the gate.**

**API**

| # | File | Change |
|---|---|---|
| 1 | `api/api/models/requirements.py` | `asil: str \| None` on `RequirementRow`; `text_rendered: str \| None` and `figure_refs: list[str]` on `RequirementDetail`; `evidence[].outcome` nullable; `RequirementFacets`; `no_evidence` on `RequirementViewCounts` |
| 2 | `api/api/models/planning.py` | `PushedRequirement.asil`, `PushedRequirement.text_rendered` |
| 3 | `api/api/planning_sync.py` | `_mirror_requirements` carries both new fields. **`text_rendered` stays out of `_normative_sha256` until OQ3 is answered.** |
| 4 | `api/api/services/queries_requirements.py` | the `chapter` / `status` / `method` filters; `no_evidence` in the fold; `requirement_facets(db)` |
| 5 | `api/api/routers/requirements.py` | `GET /requirements/facets`; `GET /requirements/{req_id}/journal` beside the two GETs the model spec adds |
| 6 | `api/api/db.py` | `requirements` index on `("chapter", ASCENDING)` **only when the chapter filter has a caller** — at ten rows it has none |
| 7 | `api/scripts/snapshot.sh` | regenerate `api/docs/openapi.v1.json` in the same PR (`BL-25`) |

**Seed**

| # | File | Change |
|---|---|---|
| 8 | `battery-trace-gen/seed/planning_payload.py` | emit `text_rendered` per requirement, resolved against `battery-dc-parameters.json` as `name (value unit)` — the same substitution `seed/requirements_md.py` already performs for the markdown |
| 9 | `battery-trace-gen/seed/sources.py` | expose the parameter map to the payload builder |

**Frontend**

| # | File | New/changed | What |
|---|---|---|---|
| 10 | `frontend/types/requirement.ts` | new | `RequirementRow`, `RequirementDetail`, `RequirementEvidence`, `VerificationState`, `RequirementListFilters`, `RequirementFacets` |
| 11 | `frontend/lib/api/requirements.ts` | new | `requirementsApi = { list, get, facets, journal }`, shaped on `lib/api/testDefinitions.ts` |
| 12 | `frontend/lib/hooks.ts` | changed | `useRequirements`, `useRequirement`, `useRequirementFacets`, `useRequirementJournal` |
| 13 | `frontend/components/shared/source-badge.tsx` | changed | `SourceKind \|= "derived"`; `variantClass.derived = "border-dashed border-line bg-transparent text-ink-3"` |
| 14 | `frontend/types/source.ts` | changed | `sourceMeaning("derived")` — the one sentence in §5.2 |
| 15 | `frontend/components/screens/requirements/verification-chip.tsx` | new | five states + the separate `stale` chip |
| 16 | `frontend/components/screens/requirements/requirements-screen.tsx` | new | the nine-column list, §6 |
| 17 | `frontend/components/screens/requirements/requirement-detail-screen.tsx` | new | panels A-F, §7 |
| 18 | `frontend/components/screens/requirements/requirement-text-panel.tsx` | new | the rendered text + the Show-tokens toggle |
| 19 | `frontend/components/screens/requirements/covering-runs-panel.tsx` | new | the run × verdict table, panel E |
| 20 | `frontend/app/requirements/page.tsx` | new | route |
| 21 | `frontend/app/requirements/[reqId]/page.tsx` | new | route |
| 22 | `frontend/components/shell/sidebar.tsx:209-243` | changed | a **Requirements** entry with `count: resolved.requirements`, **above** Test definitions — the nav teaches requirement → definition → run, which is the rule the comment at `:206-208` already states |
| 23 | `frontend/components/shared/crumbs.tsx` | changed | a `Req` crumb type |
| 24 | `frontend/lib/saved-searches.ts:45-64` | changed | `"requirements"` in the union and the key map |
| 25 | `frontend/components/screens/definitions/definition-detail-screen.tsx` | changed | the "Verifies" row from the model spec becomes links to `/requirements/{id}` |

**Verification checklist for Tester:** `pre-commit run --all-files` (pinned versions, never
local ruff/mypy); the frontend type-check and unit tests; the contract snapshot regenerated;
an axe pass on `/requirements` covering the new dashed badge variant in both themes; and a
local round trip showing all ten requirements at `covered` after the catalog push and at
`exercised` with a latest run after the four traces upload.

---

## 14. Out of scope

- **Any write.** No status PATCH, no criteria editor, no ASIL editor, no `POST /requirements`,
  no add-note on the requirement journal. Requirements arrive from planning.
- **Baseline sealing**, the baseline reverse index, and the `Baselines` panel.
- **The verdict runner** — `BL-11` writes verdicts; this page reads them.
- **Requirement versions, the `verifies` link entity, confirmed/suspect link state** — OQ2.
- **Making `verification_criteria` mandatory** (`BL-18`) and **the status enum + transition
  table** (`BL-20`).
- **The criteria-vs-`pass_criteria` agreement sweep** the board calls a finding — it needs
  `verification_criteria` to exist first.
- **Linking measurands to the signal catalog** (§7C).
- **A `requirement` favourite type** — `FavouriteStar` takes a typed entity union and the
  favourites store would have to learn a sixth; no requirement screen needs it to be useful.
- **A server-side `/requirements/export` route** and any formatted ASPICE coverage report.
- **Column picker for the table.** The export picker already exists and governs the file.
- **Home-screen surfacing** — a "requirements without evidence" needs-attention line is the
  obvious follow-up and is not designed here.

---

## 15. Open questions

1. **OQ1 and OQ2 belong to the model spec and are still the user's.** This page assumes both
   recommended answers (two columns; light registry). §12 states exactly what moves if not.
   **OQ1 should be answered before ArchDev starts**, because it sets the column count.
2. **OQ3 — does a parameter value change suspect the evidence?** `T_batt_max: 60 → 55` changes
   what the requirement demands and every pass against it should stop counting — but the
   requirement's `text` does not change, so `normative_sha256` does not move and the board's
   named field list does not cover it. **Recommended: include `text_rendered` in
   `normative_sha256`**, which makes a parameter change behave exactly like a text change. That
   is a one-line change to the model spec §4.6 and a departure from the board's field list, so
   **ArchDev must not make it unilaterally** — §13 item 3 leaves it out until the user answers.
3. **Is `status: Draft` + `verification_state: tested` a finding worth surfacing?** It is legal,
   it will occur (all ten of ours are Draft), and under ASPICE it is a process gap: evidence
   exists for a requirement nobody reviewed. Recommended: **no marker in phase 1** — the two
   columns sit side by side and say it plainly. A "tested but not reviewed" quick view is cheap
   to add once the status enum is real (`BL-20`).
4. **Should the Requirements entry sit above or below Test definitions in the sidebar?**
   Recommended: **above**, so the nav reads requirement → definition → run. It reorders an
   existing list that a person has muscle memory for.
5. **Does the ASIL column ship the day one requirement carries an ASIL, or never until OQ2?**
   Recommended: **the day one carries it** — it is authored, nullable and independent of the
   versioned model.

---

## 16. Sanity print

### 16.1 Decisions

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| How origin is shown | **one `SourceBadge`, dashed = computed / solid = authored**, in the column header on the list and in the field label on the detail | a per-column convention (italics, tinted cells, a group separator); a legend row; a second badge component for derived values | the board already draws its one computed box dashed — this is its own notation generalised; the badge, its tooltip and its `aria-label` already exist and are already accessible; a tint fails contrast against row hover and says nothing to a screen reader |
| Where the badge repeats | **column header once; never per cell**; per field on the detail | a badge on every derived cell; a badge on the row id like `work-orders-screen.tsx:230` | fifty badges say what five headers say; and a badge on the id would label the whole row `api:planning`, which is false for five of its nine columns |
| Status vs verification | **two columns**; status in **one neutral tone for every value**; colour reserved for the five `verification_state` values | a tone map over the board's nine lifecycle values; folding `Tested` into Status (OQ1's alternative) | the status enum is *customer configuration* — the code cannot know which value is good; two coloured badges side by side compete to be "the" status |
| Column count | **nine**, with the wider set in the **export** | a table column picker; a five-column minimal table | this repo has no table picker, and the picker it has governs the export file — the extra attributes stay reachable in the idiom that already exists and is already tested |
| Covering runs on the list | **`latest_run_id` as a link + `covering_run_count` as a number** | up to 20 chips in a cell | a 20-chip cell sets the row height of the whole table; chips belong on the detail, where there is one requirement |
| Detail layout | **stacked panels, no tabs**; runs and verdicts in **one** table | tabs `Attributes / Evidence / History`; separate "covering runs" and "verdicts" lists | every entity detail in this repo is panels — only the run detail is tabbed, and only because it hosts sub-apps; a run id without its verdict is half the answer |
| "has no covering run" | a **`no-evidence` quick view** = `{not_covered, covered}`, counted server-side | a boolean `has_no_covering_run` filter in the panel | it is the same shape as the runs screen's `attention` preset; quick views are where this repo puts the subset a person asks for on nearly every visit |
| Absent attributes | **omit `version`, `baseline`, `verification_criteria`, `asil`, suspect state** from the list; show criteria and ASIL on the detail only when carried | ship them as permanently blank columns with an explanatory empty state | "Baselines: —" asserts *this requirement is in no baseline*; the truth is *this system does not know what baselines exist*. An absent column claims nothing |
| Parameter tokens | **the seed pushes `text` (hashed) and `text_rendered` (display) as two mirrored strings** | a `parameters` collection in `api/`; resolving in the browser | the parameter set is planning's, not the Test Manager's; a whole collection and a resolution pass to produce a display string is the wrong trade; two clients resolving independently render one requirement two ways |
| Writes | **none** — three GETs, no `POST`/`PATCH` | a status PATCH on the detail | `POST /planning/sync` is the one door the catalog enters by; a second write path forks the provenance story the mirror exists to keep whole |

### 16.2 The list screen, as text — the ten requirements

Ordered `req_id` ascending, as the server serves them. Titles truncated here for width only;
on screen the cell is `whitespace-normal` and wraps. Header badges shown in brackets —
`[planning]` is solid, `[derived]` is dashed.

**Moment A — today. The catalog has been pushed; no trace has been uploaded.**

```
Requirement      Title                              Chapter      Status    Verification  Method  Verified by      Latest run  Runs
[planning]       [planning]                         [planning]   [planning][derived]     [plan.] [derived]        [derived]   [derived]
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
BAT-SYS-FUN-001  Technical SOC by coulomb counting  Functional   Draft     ● Covered     Test    BAT-SYS-TC-004   —           0
BAT-SYS-FUN-002  Customer state of charge derivat…  Functional   Draft     ● Covered     Test    BAT-SYS-TC-006   —           0
BAT-SYS-FUN-003  Cell balancing while sleeping      Functional   Draft     ● Covered     Test    BAT-SYS-TC-007   —           0
BAT-SYS-FUN-004  Heater power states                Functional   Draft     ● Covered     Test    BAT-SYS-TC-009   —           0
BAT-SYS-FUN-005  Heater at maximum power below t…   Functional   Draft     ● Covered     Test    BAT-SYS-TC-010   —           0
BAT-SYS-PRF-001  Maximum DC charging current        Performance  Draft     ● Covered     Test    BAT-SYS-TC-001   —           0
BAT-SYS-PRF-002  Terminal voltage relaxation to O…  Performance  Draft     ● Covered     Test    BAT-SYS-TC-008   —           0
BAT-SYS-SAF-001  Terminal voltage operating range   Safety-Faul… Draft     ● Covered     Test    BAT-SYS-TC-005   —           0
BAT-SYS-SAF-002  Battery temperature ceiling        Safety-Faul… Draft     ● Covered     Test    BAT-SYS-TC-003   —           0
BAT-SYS-SAF-003  Charging current derating near t…  Safety-Faul… Draft     ● Covered     Test    BAT-SYS-TC-002   —           0

[ All 10 ] [ No evidence 10 ] [ Failed 0 ] [ Tested 0 ]
```

Every `Covered` chip is neutral. **Coverage reads 100 % and nothing has run** — the board's
*Covered ≠ Tested*, on screen, on day one.

**Moment B — the four traces have registered. `BL-11` has still written no verdict.**

```
Requirement      Title                              Chapter      Status    Verification  Method  Verified by      Latest run  Runs
[planning]       [planning]                         [planning]   [planning][derived]     [plan.] [derived]        [derived]   [derived]
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
BAT-SYS-FUN-001  Technical SOC by coulomb counting  Functional   Draft     ● Exercised   Test    BAT-SYS-TC-004   TAS-1002    1
BAT-SYS-FUN-002  Customer state of charge derivat…  Functional   Draft     ● Exercised   Test    BAT-SYS-TC-006   TAS-1002    1
BAT-SYS-FUN-003  Cell balancing while sleeping      Functional   Draft     ● Exercised   Test    BAT-SYS-TC-007   TAS-1003    1
BAT-SYS-FUN-004  Heater power states                Functional   Draft     ● Exercised   Test    BAT-SYS-TC-009   TAS-1004    1
BAT-SYS-FUN-005  Heater at maximum power below t…   Functional   Draft     ● Exercised   Test    BAT-SYS-TC-010   TAS-1004    1
BAT-SYS-PRF-001  Maximum DC charging current        Performance  Draft     ● Exercised   Test    BAT-SYS-TC-001   TAS-1001    1
BAT-SYS-PRF-002  Terminal voltage relaxation to O…  Performance  Draft     ● Exercised   Test    BAT-SYS-TC-008   TAS-1003    1
BAT-SYS-SAF-001  Terminal voltage operating range   Safety-Faul… Draft     ● Exercised   Test    BAT-SYS-TC-005   TAS-1002    1
BAT-SYS-SAF-002  Battery temperature ceiling        Safety-Faul… Draft     ● Exercised   Test    BAT-SYS-TC-003   TAS-1001    1
BAT-SYS-SAF-003  Charging current derating near t…  Safety-Faul… Draft     ● Exercised   Test    BAT-SYS-TC-002   TAS-1001    1

[ All 10 ] [ No evidence 0 ] [ Failed 0 ] [ Tested 0 ]
```

**What moved, and what did not.** Three derived columns moved — Verification neutral →
amber `Exercised`, Latest run `—` → a run id, Runs `0` → `1` — and the quick-view counts moved
with them. **Not one authored column changed**: Status is still `Draft` on all ten, because a
person moves it and no person did. That is the page's thesis in one diff, and it is why the
origin badges are in the header.

The third moment — after `BL-11` writes the ten verdicts, **6 `Tested` green, 4 `Failed` red**,
Status still `Draft` on all ten — is the model spec's §12 table
(`dev-planning/requirement-status-from-runs/spec.md:891-905`) and this page renders it with no
further change.

---

## 17. References

- `dev-planning/requirement-status-from-runs/spec.md` — the model this page reads. Its §4.2
  (authored vs derived status), §4.3 (`covering_run_ids`), §5.3 (the fold), §7.1 (the two
  reads), §9 (departures from the board), §13 (OQ1, OQ2).
- `dev-planning/tm-multi-definition-runs/spec.md` and `architecture.md:379-390` — `definition_ids`,
  the implementation `.py` and its sha256, the ten `passes` expressions and the 6/4 split.
- Board: `https://miro.com/app/board/uXjVHsQqWhY=/` (ASPICE SYS.2); `CLAUDE.md:164-175`.
- `dev-planning/backlog.json` — `BL-11`, `BL-17`, `BL-18`, `BL-20`, `BL-22`…`BL-27`.
- `frontend/components/screens/work-orders/work-orders-screen.tsx` — the list this page is
  shaped on.
- `frontend/components/screens/runs/runs-screen.tsx:60-70, :82-87, :339-343` — facets over a
  typed list; quick views as set-equality presets; why there is no table column picker.
- `frontend/components/screens/definitions/definition-detail-screen.tsx` — the panel stack, the
  mirror lock-line, the `PanelHead` origin badge.
- `frontend/components/shared/meta-grid.tsx:26-41`, `shared/source-badge.tsx` — the origin rule
  already in the codebase.
- `battery-trace-gen/data/battery-dc-requirements.json`, `battery-dc-parameters.json` — the ten
  requirements and the eleven parameters the sanity print renders.
- Global golden rules: light functional code, no PR1110 construct; a responsive framework
  (Tailwind, already in place); ArchDev writes, Tester verifies.
