# Test Manager navigation hierarchy — architecture

**Brief:** main-thread dispatch, 2026-09-22 ("put Test Runs under Work order and
test definition under Test Run")
**Branch / base:** `jama-ui-dev` @ `5c2c2d6`
**Scope:** `frontend/` only. No `api/`, no route added, no dependency added.

---

## 1. What changed

The navigation now states the user's hierarchy — **a work order is a campaign
holding test runs; a test run covers test definitions** — in three places:

1. The sidebar indents `Test runs` under `Work orders` and `Test definitions`
   under `Test runs`.
2. The run screen gained a **Test definitions this run covers** panel, reading
   the run's whole `definition_ids` set.
3. The work-order screen lists its runs **before** its definitions, so the page
   reads down the same chain, and its definitions heading names its scope.

## 2. Sidebar — indent, not a tree

`components/shell/sidebar.tsx` renders a flat array of `{label, href, icon,
count}` rows inside one `<nav>`, grouped only by the `NavLabel` divs (`Registry`,
`Analysis`). Those divs are plain text, not headings, so the existing file
conveys grouping **visually only**. The nesting follows that idiom rather than
introducing a tree control or list semantics:

- `NavEntry` gained `depth?: 1 | 2`.
- `INDENT` maps a depth to a left padding (`pl-7`, `pl-11`); `cn` /
  tailwind-merge resolves it over `navItemClass`'s `px-2.5`.
- The collapsed 56px rail indents nothing — there is no room, and the rail
  already hides every label. Order there is unchanged, so the chain still reads
  top to bottom.

Every destination stays reachable, every href is untouched, and the counts come
from the same resolved query, so `sidebar-definitions.test.tsx`'s accessible
names (`"Test definitions 1,234"`) still hold.

Resulting expanded order:

```
Registry
  Home                 /
  Work orders          /work-orders      (count)
    Test runs          /runs             (count)
      Test definitions /definitions      (count)
  Files                /files            (count)
  Signals              /signals          (count)
  Issues               /issues
  Workbooks            /workbooks        (only when TM_FTS_URL is set)
  Explore              /explore
  Audit                /audit
Analysis
  QuixLab              /quixlab          (only when QuixLab is configured)
  Lakehouse            /lakehouse        (only when a Lakehouse URL resolves)
```

**Known limit:** the indent carries the hierarchy to the eye only. A screen
reader hears ten sibling links, as it did before. Real nesting needs
`<ul>/<li>` with a nested list, which rewrites every row's markup and the
`gap-0.5` spacing of the `<nav>` — out of scope for this change, and worth
doing whole if it is done.

## 3. Run detail — `DefinitionsPanel`

New file `components/screens/run-detail/definitions-panel.tsx` (123 lines),
rendered from `StandardRunHeader` directly under the Metadata panel.

**Why a section and not a tab.** The six tabs (Signals, Files, Processed
results, Issues, Journal, Explore) all hold the run's *data*; the definition set
is its *planning identity*, next of kin to the Metadata grid. It is 2–3 rows —
a tab would cost a click to read three lines. And the Explore layout swaps the
whole `StandardRunHeader` for a slim bar, so a section placed here disappears
with the metadata it belongs to, which a tab could not do.

**Data flow.**

```
run.definition_ids        (the stored truth; ids render with no further read)
        |
        v
useWorkOrder(run.work_order_id)   one request, the read the work-order screen
        |                          has usually cached
        v
workOrder.definitions -> Map<td_id, {title, status}>
        |
        v
row per id: link -> /definitions/<id> | title | DefinitionStatusBadge
```

Titles come from the work order rather than from N `useTestDefinition` reads:
`_write_link` (`api/api/planning_sync.py:439`) writes `work_order_id` and
`definition_ids` in one pass, so a run carrying definitions carries the work
order that mirrors them. `useWorkOrder("")` stays disabled, so a run with no
definitions issues no request at all.

**Three states.**

| State | What the panel shows |
|---|---|
| Ids present, work order loading | the id, plus two skeleton cells (`isLoading`, which is false for a disabled query — no forever-skeleton) |
| Id resolves to nothing | the id, still linked, and `no mirrored definition under this id` across the title and status cells. One line covers all three causes: no work order mirrored, work order mirrors no such definition, or the read failed |
| No ids at all | "No test definitions on this run" / *A trace no longer claims the definitions it answers. Today a planning link assigns them — this screen offers no control for it yet.* |

The empty state is the common case since `5c2c2d6` stopped traces claiming
definitions. It says where they come from and, deliberately, that no control on
this screen assigns them — see §6.

**Metadata cell.** `runMetaFields`'s `Test definition` cell shows
`definition_id`, which is only the first of the set. Directly above a panel
listing three, that read as a contradiction, so the cell now appends
`+N more` when the set is larger. The label and the field's source badge are
unchanged.

## 4. Work-order detail

The runs panel now precedes the definitions panel (a pure block move), so the
page reads work order -> runs -> definitions like the nav does. The definitions
heading became **Test definitions in this work order**, matching the runs
heading's scoping. No logic changed.

## 5. Comments rewritten

- `sidebar.tsx` — the comment claiming "a work order holds test definitions,
  and a test definition produces test runs" described the flat order and died
  with it; it now states the campaign chain and warns that the indent means
  containment, not a filtered list.
- `edit-run-dialog.tsx:52` — the claim "no definition list route reaches the
  front end" was **false**: `GET /test-definitions` reaches it through
  `testDefinitionsApi.list` / `useTestDefinitions`, and `/definitions` is a
  shipped screen. The real reason the field stays out of the form is that
  `_resolve_manual_links` (`api/api/services/queries_runs.py:1173`) writes
  `definition_ids = [definition_id]`, replacing the whole set, so a run covering
  three definitions would silently lose two. The comment now says that.

## 6. What could not be done here

- **Assigning a definition to a run has no UI.**
  `dev-planning/tm-multi-definition-runs/architecture.md` states "the
  definitions of a run are assigned by a person on the Test Run page", but no
  control does it: the edit dialog omits `definition_id`, and the only route
  that would take it replaces the set rather than adding to it. Building a
  set-editing control needs an API that adds and removes one definition (or a
  form that submits the whole set) — a spec question, not a frontend one.
- **Screen-reader nesting** in the sidebar — see §2.
- **`work-order-detail-screen.tsx`'s definitions table** carries six `<th>` and
  a `colSpan={5}` empty row (pre-existing, untouched), and its runs table's
  `Definition` column still shows only `run.definition_id`. Both predate this
  change.
