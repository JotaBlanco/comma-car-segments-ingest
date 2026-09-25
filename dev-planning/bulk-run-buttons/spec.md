# Bulk run buttons — one on the run page, one over a picked set of runs

**Status:** Draft
**Project:** comma-car-segments-ingest
**Created:** 2026-09-25
**Planned with:** Buddy
**Supersedes:** `dev-planning/run-a-definition/spec.md` §7 (the "one call at a time" rule, which the
shipped code never implemented) and answers its §9 OQ6.

## 1. Summary

Two controls that start many definition runs at once. On a test run's page, the `Run all` button
moves out of the Definitions panel and into the page header, where every other run-level action
already lives. On the Test Runs list, the existing multiselect gains a `Run N definitions` action
that walks every definition of every picked run. Both are browser loops over the shipped
per-definition route, bounded by one shared concurrency ceiling. **No new backend route, no new
progress model, no new state store.** Most of this already exists: `planRunAll`, `RowRunState`,
`useDefinitionRun`, the per-pair route and the runs-list multiselect all ship today.

## 2. Goals

- One `Run all (N)` at the top of a test run's page, visible without scrolling past Metadata.
- One `Run N definitions` in the runs-list batch bar, over the runs a person ticked.
- A stated, enforced ceiling on how many QuixLab Job clones a single press causes.
- Honest partial-failure reporting: what started, what refused, what is still going.
- Zero API change.

## 3. Non-goals

- No bulk API route (§4.3 states why the per-pair route is called N times instead).
- No change to `api/api/quixlab_provision.py`'s cloning strategy.
- No estate-wide "Run everything" — the trigger is always an explicit selection.
- No "skip the ones that already have a verdict" branch (§4.6).
- No pre-flight lake check (§4.5).
- Nothing on the Test Results page: `dev-planning/test-results-page/spec.md` §7 already rules that a
  report screen must not be the one place where reading triggers work.

## 4. User stories

1. I open `/runs/TAS-1001`. Without scrolling I see `Run all (3)` beside `Lineage` and
   `Open in QuixLab`. I press it; the button reads `Running 1 of 3…` and the rows below fill in
   with PASS / FAIL / ERROR one by one.
2. I open `/runs`, tick TAS-1001..1004, and the batch bar says `4 runs picked.` with
   `Run 10 definitions`. I press it, confirm, and watch a report fill: started, verdicts, refusals.
3. One definition has no implementation. The batch does not stop; that pair is listed as skipped and
   the other nine run.
4. I have not signed in to the Portal. The first pair answers 401 and the batch stops at once with
   the one sentence that applies to all ten, not ten copies of it.
5. I press `Run all` on a run that has no registered files. It is not blocked; the button's tooltip
   says the implementations will query an empty lake, and the verdicts come back ERROR with the
   exception in `evidence.error`.
6. A definition that already carries a verdict is run again by both controls, and the new verdict
   supersedes the old.

## 5. Proposed design

Both controls are browser loops over the shipped `POST`/`GET
/test-runs/{run_id}/definitions/{td_id}/run` pair, bounded by one exported constant.

The run-detail control keeps the shipped machinery exactly: rows report `RowRunState` upward,
`planRunAll` turns the reports into a count and a blocked reason, and a per-row trigger asks a row
to run. The only change is *where the button sits* and *how many rows the trigger admits at once*.

The runs-list control cannot reuse the rows, because the runs list does not render definitions. It
follows the other precedent already in this codebase: `delete-runs-dialog.tsx`, which owns a loop
over a picked set, reports per-item failures, and refuses to close while it works. The same shape,
with `runDefinition` (start + poll, `lib/definition-run.ts:99-107`) as the per-pair worker.

## 6. Work breakdown

### 6.1 The shared constant and the empty-set reason — ArchDev

`frontend/lib/definition-run.ts`.

- Add `export const RUN_CONCURRENCY = 3;` with the reason from §4.3.
- Add one branch at the top of `planRunAll` (`:183-197`):
  `if (ids.length === 0) return { count: 0, blocked: "This run covers no test definitions" };`
  Today the panel guards with `ids.length > 0 &&` (`definitions-panel.tsx:123`); in the header the
  button renders always, so the empty set needs its own sentence.

Nothing else in this file moves. `RowRunState`, `RunAllPlan` and `planRunAll`'s other three reasons
are used verbatim.

### 6.2 `useRunAll` — the admission loop — ArchDev

`frontend/lib/hooks/use-run-all.ts` (new, ~40 lines). Exported from `frontend/lib/hooks/index.ts`.

```
useRunAll(ids: readonly string[]): {
  plan: RunAllPlan;                                   // planRunAll(ids, rowStates)
  running: number;                                    // reported states with pending === true
  queued: number;                                     // wanted, not yet admitted
  requested: ReadonlySet<string>;                     // ids admitted to run
  reportRow(tdId: string, state: RowRunState | null): void;
  start(): void;                                      // queue every runnable, not-pending id
}
```

- `reportRow` and its `sameRowState` guard move verbatim out of `definitions-panel.tsx:26-28, 93-103`.
- `start()` sets `wanted` to the ids `planRunAll` counted.
- An effect admits from `wanted` into `requested` while `running + justAdmitted < RUN_CONCURRENCY`.
  A row's `run()` sets its view pending synchronously (`use-definition-run.ts:104-108`), so the next
  report raises `running` and the loop is stable.
- `wanted` empties as ids are admitted; `requested` is cleared when `wanted` is empty and
  `running === 0`.

### 6.3 The row trigger becomes a boolean — ArchDev

`frontend/components/screens/run-detail/definition-run-cell.tsx:52-91`.

`runAllToken?: number` → `runRequested?: boolean`. The effect body is unchanged
(`if (runnable && !pending) run()`); the mount guard keeps today's rule with
`useRef(runRequested)` instead of `useRef(runAllToken)`, so a row that mounts with its id already
admitted does not start — the same protection the comment at `:85` states.

### 6.4 The panel loses the button — ArchDev

`frontend/components/screens/run-detail/definitions-panel.tsx`.

- Delete `runAllToken`/`rowStates`/`reportRow`/`runAll` (`:91-104`) and the button (`:127-140`).
- Delete `sameRowState` (`:26-28`) and the `planRunAll`/`RowRunState` import (`:19`).
- New props: `requested: ReadonlySet<string>`, `onRunState: (tdId, state|null) => void`. Pass
  `runRequested={requested.has(tdId)}` and `onRunState` to each `DefinitionRunCell` (`:211-216`).
- Everything else stays: the `N covered` count, `Add definitions`, the per-row `Run` button, the
  per-row remove, the empty state.

### 6.5 The header button — ArchDev

`frontend/components/screens/run-detail/run-all-button.tsx` (new, ~35 lines) and
`run-detail-screen.tsx`.

- `RunDetailScreen` (`:718`) calls `useRunAll(run.definition_ids ?? [])` and passes `plan`,
  `running`, `queued`, `start` down to `StandardRunHeader`, and `requested`, `reportRow` to
  `DefinitionsPanel` (`:1087`).
- The button renders as the FIRST child of the header action row, `run-detail-screen.tsx:1073-1080`,
  immediately before `<RunActions/>`.
- **It does NOT go inside `RunActions`** (`:349-452`). `RunActions` is also rendered in the Explore
  slim bar's Details popover (`:589-595`), and the Explore layout drops `StandardRunHeader` whole —
  `DefinitionsPanel` with it (`:1084-1087`). With no rows mounted, nothing reports state and
  `planRunAll` would read `Reading the definitions…` for ever. The Explore tab therefore has no
  Run all, which is correct: it has no definition rows either.

### 6.6 The list dialog — ArchDev

`frontend/components/screens/runs/run-definitions-dialog.tsx` (new, ~200 lines). Shaped on
`delete-runs-dialog.tsx`, which it sits beside.

Props: `open`, `onOpenChange`, `runs: readonly TestRunListItem[]`, `onDone?(report)`.

- Pairs = `runs.flatMap(r => (r.definition_ids ?? []).map(td => ({ runId: r.run_id, tdId: td })))`,
  in table order, **not deduplicated** (§4.2).
- Confirm step: names the runs, states the job count, carries the empty-lake line (§4.5) and the
  re-run line (§4.6). **No typed confirmation word** — that is reserved for destructive actions.
- Work step: `RUN_CONCURRENCY` workers, each pulling the next pair and awaiting
  `runDefinition(runId, tdId, watch)` (`lib/definition-run.ts:99-107`), which starts and polls with
  the shipped `RUN_POLL_MS` / `RUN_GIVE_UP_MS` / `RUN_POLL_RETRIES`.
- On each finished pair with a verdict, invalidate `keys.results.all`, `keys.requirements.all` and
  `keys.runs.detail(runId)` — the same three `use-definition-run.ts:89-93` already invalidates.
- Report step and closing rules: §4.4.

### 6.7 The batch bar — ArchDev

`frontend/components/screens/runs/runs-batch-bar.tsx` and `runs-screen.tsx:387`.

- Prop `runIds: readonly string[]` → `runs: readonly TestRunListItem[]`; `runs-screen.tsx:387`
  passes `pickedRows` (it already computes it, `:272`). `DeleteRunsDialog` receives
  `runs.map(r => r.run_id)`.
- Bar order becomes: count text · `Run N definitions` · `Clear` · **`ml-auto`** · `Delete`.
- No test covers this file (the only reference is the comment at
  `requirements-batch-bar.tsx:9`), so moving `Delete` breaks nothing.

### 6.8 Tests — Tester, after ArchDev

- `frontend/tests/components/definition-run.test.tsx:243-332` — the six tests in
  `describe("Run all on the definitions panel")` render `DefinitionsPanel` and find the button by
  `/^Run all/`. The button leaves that component, so all six go **red**. They move to a harness that
  mounts `RunAllButton` and `DefinitionsPanel` together off one `useRunAll`, which is what
  `StandardRunHeader` does.
- `:334-360` `describe("the run-all token on one row")` passes `runAllToken={token}`; it follows the
  prop to `runRequested`.
- New: four runnable rows produce three POSTs, and the fourth only after one settles.
- New: the dialog's report — started / verdicts / refused / skipped, and the two batch-level aborts.

## 7. Data & interface contracts

**No API change.** No new route, no new field, no new response type, no migration.

| Thing | Where | Shape |
|---|---|---|
| `RUN_CONCURRENCY` | `frontend/lib/definition-run.ts` | `3` |
| `RunAllPlan.blocked` | same file, existing | gains one value, `"This run covers no test definitions"` |
| `DefinitionRunCellProps.runAllToken` | `definition-run-cell.tsx:56` | becomes `runRequested?: boolean` |
| `RunsBatchBarProps.runIds` | `runs-batch-bar.tsx:18` | becomes `runs: readonly TestRunListItem[]` |
| `RunBatchReport` | `run-definitions-dialog.tsx`, frontend-only | `{ started, pass, fail, error, skipped: Pair[], refused: {pair, message}[], stillRunning: Pair[], abortedBy: string \| null }` |

The route consumed is unchanged: `POST` starts (`api/api/routers/definition_runs.py:76-109`), `GET`
polls **and writes the verdict** (`:122-164`).

## 8. The six decisions

### 8.1 The run-detail control — move it, do not duplicate it

**Where:** the header action row, `run-detail-screen.tsx:1073-1080`, first in the row, before
`RunActions`. Not inside `RunActions` — §6.5 gives the reason.

**What happens to the panel button: it is deleted.** Two buttons with identical effect on one screen
is the defect. The panel is not left without run affordance — every row keeps its own `Run` button
(`definition-run-cell.tsx:105-116`), which is the control that runs *one* definition. The header
button is the control that runs *the run*, and it now sits where the run's other verbs sit.

The header is far from the rows it drives, so the button carries the progress itself:
`Running X of Y…` while any admitted row is pending. That costs nothing — `useRunAll` already counts
pending rows for `planRunAll`.

**Labels and disabled reasons, verbatim:**

| State | Label | `title` |
|---|---|---|
| runnable | `Run all (3)` | `Runs every definition with an implementation on this run, one QuixLab Job each` |
| runnable, run has no files | `Run all (3)` | `This run has no registered files yet, so each implementation queries an empty lake.` |
| walking | `Running 1 of 3…` | `Wait for the runs already going to finish` |
| reading | `Run all (0)` | `Reading the definitions…` |
| none runnable | `Run all (0)` | `No definition here has an implementation to run` |
| no definitions | `Run all (0)` | `This run covers no test definitions` |

Four of those six sentences are the strings `definition-run.ts:190-195` and
`definitions-panel.tsx:133-135` already ship.

### 8.2 The list control — count jobs, not runs; keep Delete at the far edge

**Label:** `Run 10 definitions` (`Run 1 definition` in the singular).

**What the count means: the number of Jobs the press causes.** It is
`sum over picked runs of (run.definition_ids ?? []).length`, **not deduplicated** — a definition
that sits on two picked runs is two `(run, td)` pairs, two Job names
(`quixlab_provision.run_job_name` hashes `run_id\ntd_id`) and two verdicts. The user picks runs; the
number they read is the number of things that will start.

This needs no extra read: `definition_ids` is already on the list row
(`frontend/types/test-run.ts:26`, "the API always sends it").

**Separation from Delete:** `Run` is `variant="outline"` with the `Play` glyph from `lucide-react`
(the package `runs-batch-bar.tsx:4` already imports `Trash2` from) and sits immediately after the
count text; `Clear` follows; `Delete` keeps `DESTRUCTIVE_CLASS` and `Trash2` and is pushed to the
far edge with `ml-auto` — the same `ml-auto` separation `RunActions` already applies to its
destructive control in the overlay layout (`run-detail-screen.tsx:369`). Different position,
different tone, different glyph, and a confirm dialog behind each.

**Disabled** only when the count is 0, with the title `No picked run covers a test definition`.

### 8.3 Concurrency — three in flight, enforced in the browser, no bulk route

**Decision: `RUN_CONCURRENCY = 3` starts in flight, enforced in the browser, on both controls.**

**Why the per-definition route is called N times rather than replaced by a bulk route:**

1. A bulk route would still create one cloned deployment per pair. The Portal cost is identical.
2. `POST` is not the expensive half. Every **poll** is a full `GET /deployments` workspace listing
   plus, once terminal, a `/runs` read and a stored-log download
   (`api/api/quixlab_run.py:274-303, 242-271`) — and `GET` is per-pair by design. A bulk POST would
   leave every poll exactly as it is.
3. **The verdict is written by the `GET`, not by the Job.** `record_verdict` is called inside
   `get_definition_run` (`api/api/routers/definition_runs.py:156-158`). The browser must poll every
   pair regardless, so a bulk start route buys nothing and the hard half stays where it is.
4. A server-side loop would hold one FastAPI worker for minutes per batch against a 30 s Portal
   write timeout (`api/api/quixlab_provision.py:60`).

**What an unbounded burst costs, stated.** Each start does `GET /deployments` (whole workspace) +
`GET /deployments/{template}` + an optional `DELETE` + `POST /deployments`
(`quixlab_run.py:176-210`), and each clone copies `cpuMillicores` and `memoryInMb` off the live
QuixLab deployment (`quixlab_run.py:88`). Ten at once against a 14-deployment workspace is ten new
deployments; at `RUN_POLL_MS = 3_000` ten in-flight rows sustain ~3.3 workspace listings per second
for the life of the batch.

**Why exactly 3.** It is the largest burst the shipped `Run all` already produces — the battery runs
carry 3+3+2+2 definitions, and `definition-run.test.tsx:250-263` asserts two simultaneous starts on
a three-definition run. So the ceiling changes nothing about today's behaviour and only bounds
tomorrow's. It caps the cloned footprint at 3× the QuixLab deployment's CPU and memory, and it keeps
poll traffic at about one workspace listing per second.

**Where it is enforced: the browser, in two places sharing one constant** — `useRunAll`'s admission
loop (§6.2) and the dialog's worker pool (§6.6). **Not in the API.** The API has no batch to meter:
each POST is one pair, and a per-workspace limiter there would be the validation layer this
project's directives refuse. A genuine platform quota refusal arrives as `quixlab_unreachable` or
`quixlab_refused` and is reported per pair.

This supersedes `run-a-definition/spec.md` §7's "one call at a time", whose stated reason (two
children sharing the API's 1000 MB) was about in-process execution and became obsolete the moment
runs became cloned QuixLab Jobs.

### 8.4 Partial failure — the rows are the report on one screen, the dialog on the other

**Nothing rolls back. A Job that started keeps running.** Both surfaces say so.

**Run detail: no new reporting.** Each row already owns its outcome — `DefinitionRunCell` renders
`view.kind` as a verdict chip, a pending line or a red failure line
(`definition-run-cell.tsx:36-50`). The header button only counts pending rows and returns to
`Run all (N)` when none is. The rows *are* the report; a second summary would be the second progress
model this spec forbids.

**Runs list: the dialog is the report**, in `delete-runs-dialog.tsx`'s grammar.

- While working, a `role="status"` line: `Working — 6 of 10 started, 4 finished.` plus one
  `useAnnounce` call per pair, as `delete-runs-dialog.tsx:147-149` does.
- At the end, a `role="alert"` block headed
  `10 started · 4 PASS · 4 FAIL · 1 ERROR · 1 skipped.`
- Per-refusal lines, `<td_id> on <run_id> — <sentence>`, the sentence from
  `runErrorMessage(caught)` (`definition-run.ts:161-166`), which already maps
  `quixlab_needs_login` to `NEEDS_LOGIN_MESSAGE` and otherwise uses `ApiError.message`.
- `A Job that started keeps running. Nothing here is rolled back.`
- `onDone` keeps the runs that carried a refusal picked — the convention
  `runs-screen.tsx:387` and `delete-runs-dialog.tsx:53-55` already set.

**Two refusals abort the whole batch, the rest do not.** `quixlab_needs_login` (401) and
`quixlab_no_template` (409) are facts about the viewer and about the workspace, identical for every
pair; the batch stops at the first and the report reads
`Stopped after the first refusal — it is the same for every definition.` Every other refusal
(`implementation_not_found`, `run_not_found`, `td_not_found`, `storage_unreachable`,
`quixlab_unreachable`, `quixlab_refused`) belongs to one pair and the batch continues.

**A definition with no implementation is skipped by the route, not by a pre-check.**
`implementation` lives on `TestDefinitionDetail` and not on `TestDefinitionListItem`
(`frontend/types/work-order.ts:229-235`), so the list screen would need N detail reads to prevent a
refusal the route already gives in one line
(`api/api/routers/definition_runs.py:92-95`). It is counted as `skipped`, not `refused`, and reads
`<td_id> on <run_id> — no implementation stored, so nothing ran.`

**Closing.** The dialog refuses to close while any pair is still queued or starting, the rule
`delete-runs-dialog.tsx:118-127` sets. Once every pair has been **started**, the Cancel button reads
`Stop waiting` and closing is allowed, because it is recoverable and the dialog says exactly how:
`The Jobs keep running. Each verdict is recorded the next time its run page is opened.` That is
true, not hopeful — `poll_run` finds a Job by its deterministic name
(`quixlab_provision.run_job_name`), and `get_definition_run` records the verdict and deletes the Job
on any later read (`definition_runs.py:151-164`).

### 8.5 What blocks the button — and an empty lake does not

| Condition | Run detail | Runs list |
|---|---|---|
| no definitions on the run | blocked · `This run covers no test definitions` | that run contributes 0 to the count; all-zero disables with `No picked run covers a test definition` |
| a definition has no implementation | it is not counted; `Run all (0)` blocks with `No definition here has an implementation to run` | not knowable cheaply — the route refuses that pair and it is listed as skipped (§8.4) |
| still reading the definitions | blocked · `Reading the definitions…` | not applicable — the dialog reads nothing first |
| a run on this page is already executing | blocked · `Wait for the runs already going to finish` | **not blocked**: `start_run` answers an in-progress Job as-is rather than starting a second (`quixlab_run.py:171-191`), so a second press costs one Portal listing and changes nothing |
| the run has no registered files | **not blocked** — warned | **not blocked** — warned |

**An empty lake is not a block. It is a warning, and the run is allowed.** Three reasons:

1. Nothing in the API states whether the lake holds rows for a run. The closest fact is
   `file_count`, which counts registered files and is already on both `TestRunListItem` and
   `TestRun` (`frontend/types/test-run.ts:36`). A real emptiness check is a lake query this UI does
   not make.
2. The implementation queries the lake itself and answers. A query over nothing returns FAIL or
   ERROR with evidence, and `api/api/resources/verdict_notebook.py:89-91` turns any exception into
   an `ERROR` verdict carrying `evidence.error`. That is the answer, and it is recorded and
   supersedable.
3. Blocking on `file_count === 0` would be a pre-flight check against a condition the pipeline
   already reports on — the construct this project's directives name and refuse.

**What the user learns by pressing Run today** (4 runs, 0 files, no lake rows): ten Jobs start, each
implementation raises against an absent or empty table, and ten `ERROR` verdicts land with the
exception in `evidence.error`. That exercises the whole path — provision, clone, notebook seed, Job,
result line, verdict write, fold into requirement status — and it is exactly why the warning states
the outcome instead of the button preventing it.

Warning strings:
- run detail, `run.file_count === 0`:
  `This run has no registered files yet, so each implementation queries an empty lake.`
- list dialog, amber line:
  `N of the picked runs have no registered files yet. Their implementations query an empty lake and will answer ERROR.`

### 8.6 Re-running — both controls re-run, without asking

**Bulk re-runs. It neither skips nor asks.** Consistency with the single-run cell is the reason:

- `DefinitionRunCell` disables `Run` only on `control.pending || !runnable`
  (`definition-run-cell.tsx:109`). A stored verdict does not disable it.
- `planRunAll` counts on `runnable && !pending` alone (`definition-run.ts:188`). Verdicts are not
  consulted.
- The backend supports it: `start_run` deletes a finished Job of the same name and creates a new one
  (`quixlab_run.py:192-198`), and each verdict mints version N+1 with `supersedes` set
  (`run-a-definition/spec.md` §5.4).

A "skip the already-run" branch would make bulk disagree with the single button and would hide the
re-run a fix demands. The dialog states the behaviour once:
`Definitions that already have a verdict are run again; each run adds a new version and supersedes the last.`

## 9. Risks and open questions

**R1 — Portal listing traffic.** Every start and every poll lists the whole workspace. At three in
flight this is about one listing per second for the life of a batch. Mitigation: the ceiling. No
further work proposed.

**R2 — The verdict is written by the `GET`.** A batch whose polling is abandoned leaves Jobs holding
workspace capacity until someone reads the pair. Mitigation: the dialog says so (§8.4); the Job
carries a deterministic name, so the next read finds it, stores the verdict and deletes it.

**R3 — Six shipped tests go red** when the button leaves `DefinitionsPanel`
(`definition-run.test.tsx:243-332`, plus the `runAllToken` block at `:334-360`). They must move in
the same commit as the code, per the working agreement.

**R4 — Not a risk, recorded so nobody "fixes" it.** `template_row` skips rows named `tm-lab-*` and
`tm-run-*` (`quixlab_provision.py:188-205`), so concurrent starts can never clone each other. The
prefix already guards that race; no change is needed.

**R5 — The runs list pages up to 500 rows** (`runs-screen.tsx:81`), and "select every run on this
page" plus Run could be a very large batch. Mitigation today: the button states the job count before
anything starts. See OQ1.

**OQ1 — Is there a hard upper bound on one batch?** Recommended: no cap; the button names the job
count and the dialog names it again before the first start. A cap is a number nobody can justify
until a real batch hurts. Needs the user's call because it is a policy, not a code shape.

**OQ2 — Press Run before the traces are uploaded?** The live estate has 0 files and no lake rows
(`BL-09`'s traces were regenerated at `a7db99c` and not re-uploaded). Pressing Run today produces
ten `ERROR` verdicts and ten result documents that a later real run supersedes. Whether that is a
useful smoke test of the path or noise in the result history is the user's call.

## 10. Alternatives considered

- **Keep the panel button and add a header one.** Rejected: two controls with identical effect on
  one screen, which the brief names as a defect and which no scope difference justifies.
- **A bulk API route.** Rejected on four counts in §8.3; the decisive one is that the verdict is
  written by the per-pair `GET`, so a bulk start would leave the expensive half untouched.
- **Sequential, one job at a time** (`run-a-definition/spec.md` §7). Rejected: its stated reason was
  two children sharing the API's memory, which stopped applying when runs became cloned QuixLab
  Jobs; and the shipped `Run all` has never done it.
- **Put the bulk control on the work-order page** instead, which `run-a-definition/spec.md` §9 OQ6
  called the natural home. Rejected for now: the runs list already carries the multiselect, the
  checkbox column and the batch bar, so the user's ask is the cheaper answer. The work-order page
  remains the right second home if campaign-wide running is ever wanted.
- **Poll nothing on the list; start and walk away.** Rejected: the verdict is written by the `GET`,
  so a batch that never polls writes no verdicts at all.
- **Prefetch every definition's detail on the list to grey out the unrunnable ones.** Rejected: N
  requests to pre-empt a refusal the route answers in one line.

## 11. References

- `dev-planning/run-a-definition/spec.md` — §5.4 (re-run versioning), §6.2 (the panel), §7 (the rule
  this spec supersedes), §9 OQ6 (the question this spec answers).
- `dev-planning/test-results-page/spec.md` §7 — why the report screen is not a trigger surface.
- `CLAUDE.md` — `BL-11` (run the ten implementations and write verdicts), `BL-51`.
- `api/api/quixlab_run.py`, `api/api/quixlab_provision.py` — the Job recipe, out of scope to change.
