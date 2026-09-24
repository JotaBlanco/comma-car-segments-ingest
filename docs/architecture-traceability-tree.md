# Traceability tree

## What it does

`/traceability` draws the registry as one expand/collapse folder tree, the way the Lakehouse
draws lake partitions: `project → system → {Requirements, Test definitions} → entity → the
level below it`. A requirement discloses the test definitions that verify it; a definition
discloses the test runs that carry it. Every entity row links to its own detail page, and the
chevron and the name are separate targets — the chevron discloses, the name navigates.

## Why this shape

**Client-side assembly, not a tree endpoint.** The screen issues four list reads
(`/requirements`, `/test-definitions`, `/test-runs`, `/work-orders`, `page_size=200` each) and
joins them in the browser. The registry holds tens of rows per list, so the whole estate fits
in four answers; a `/tree` route would move the same join to the server and a lazy tree would
cost one call per opened folder. The lake's tree (`components/screens/workbooks/sessions-dialog.tsx`)
reads one level per call for the opposite reason: its estate is unbounded and its levels are
folder listings, not entities.

**Rooted at the project, not at the requirement.** The chain the user reads starts at the
programme. Neither a requirement nor a definition carries a project: only a work order does
(`work_orders.project`, `"Porsche Taycan"` on `WO-BAT-2026-001`). A definition resolves its
project through `work_order_id`; a requirement resolves it through the definitions that verify
it. Anything that resolves none lands under a **No project** node, which says why.

**The system level has no field behind it yet.** Requirements carry `chapter` and
`system_states`, nothing that names a subsystem. `FALLBACK_SYSTEM = "BMS"` in
`traceability-model.ts` is the whole of the fallback, and `systemOf()` reads three cases apart:

| `requirement.system` | Reads as | Meaning |
|---|---|---|
| absent (`undefined`) | `"BMS"` (the constant) | a mirror built before the field shipped |
| `null` or `""` | **No system** node | the row carries the field and names none |
| a value | that system | |

So the whole catalog groups under one `BMS` node today, and splits by itself the moment
planning sync ships the field — without then filing every system-less requirement under `BMS`,
which is why absent and null are not collapsed into one branch. **Delete `FALLBACK_SYSTEM` and
its line in `systemOf` together** once no mirror can answer without the field; nothing else in
the screen knows the string. The field is read through a local widening cast
(`RequirementRow & { system?: ... }`) rather than by editing `types/requirement.ts`, because
that type is owned by the requirements work in flight (the API side — `RequirementRow.system`,
`RequirementFacets.systems`, the planning-sync mirror write — is already in that agent's diff).

A **test definition has no system of its own**: it inherits every system named by the
requirements it covers, so a definition covering two systems stands under both, and one
covering no known requirement stands under a **No system** node.

**Requirements and test definitions are siblings.** Two groups under the system, per the
hierarchy the user stated — not one nested inside the other. A definition therefore appears
twice: once under each requirement it verifies, and once in the sibling group. That is the
point (the two groups answer two different questions), so the Test definitions group carries a
one-line note saying so instead of the screen deduplicating it away.

**No fourth level below a run.** A run's files are ingest evidence, not verification evidence;
the chain the tree states ends where a verdict will attach (the run). The run detail page
already lists files. Adding the level would also cost a read per run, which is the property
this screen was built to avoid.

## Data flow

```
useRequirements({page_size:200})   RequirementRow[]   ─┐
useTestDefinitions({page_size:200}) TestDefinition[]  ─┤
useRuns({page_size:200},{poll:false}) TestRunListItem[]┤─> buildTraceabilityTree() ─> TreeNode[]
useWorkOrders({page_size:200})     WorkOrderListItem[]─┘          (pure, no React)
                                                                          │
                                        defaultOpenKeys(nodes) ───────────┤
                                                                          v
                                                        <TreeRow/> recursion, one <ul> per level
```

Inside `buildTraceabilityTree`:

1. `runsByDefinition` from each run's `definition_ids` (falling back to the singular
   `definition_id`); a run naming none becomes a **loose run**.
2. The verifies relation from **both** of its projections — the requirement's derived
   `verified_by` (ASPICE SYS.2 BP5, never stored) and the definition's authored
   `covers_req_ids` — unioned into `reqIdsByDefinition` / `defIdsByRequirement`, so both
   directions of the tree agree.
3. `systemOf(requirement)`, `systemsOf(definition)`, `projectOf(definition)`,
   `projectsOf(requirement)` resolve each entity's coordinates.
4. Entities are bucketed into `project → system → {requirements, definitions}`; unnamed
   coordinates sort last.
5. Nodes are built top-down. Keys are path-prefixed (`p:…/s:…/g:reqs/r:…/d:…/n:…`), so the
   same definition under two parents has two independent expansion states.
6. Loose runs become a trailing root group.

Expansion lives in the screen as `ReadonlySet<string> | null`. `null` means untouched, and the
default spine (`defaultOpenKeys`: every project and system open, the two groups closed) stands;
the first toggle copies it. Nothing is persisted.

## Gaps read as gaps, never as empty folders

A row discloses a chevron only when it has children. A row with none states what it would have
disclosed, in words, at the end of the row:

| Case | Reads |
|---|---|
| Requirement nothing verifies | `— nothing verifies it`, next to its **Not covered** chip |
| Definition no run carries | `— no run carries it yet`, next to **Awaiting data** and `0/1 runs` |
| Definition with no work order | the row's **Orphaned** badge, and the row sits under **No project** |
| Run carrying no definition | the trailing **Runs carrying no test definition** group, whose note names the repair (assign one on the Test Run page) |
| System with no requirements | the **Requirements** group reads `— none in this system` |

## Per-level facts

| Level | Row states |
|---|---|
| Project | `PROJECT` + name + system count |
| System | `SYSTEM` + name + group count |
| Requirements / Test definitions | name + child count; links to `/requirements` and `/definitions` |
| Requirement | `req_id` + title + `VerificationChip` (state and staleness) |
| Test definition | `td_id` + title + `DefinitionStatusBadge` + `actual/planned runs` + `Orphaned` when it is |
| Test run | `run_id` + description + `rig_id` + `StatusBadge` + arrival |

Every chip is the one the list screens already use — `VerificationChip`
(`components/screens/requirements/verification-chip.tsx`), `DefinitionStatusBadge` and
`StatusBadge` (`components/shared/status-badge.tsx`). No new visual vocabulary.

## File inventory

| File | Lines | What |
|---|---|---|
| `frontend/components/screens/traceability/traceability-model.ts` | 364 | Pure assembly: `TreeNode`, `buildTraceabilityTree`, `defaultOpenKeys`, `FALLBACK_SYSTEM` |
| `frontend/components/screens/traceability/tree-row.tsx` | 169 | One recursive row: chevron, icon, name link, per-kind facts, nested `<ul>` |
| `frontend/components/screens/traceability/traceability-screen.tsx` | 113 | The four reads, the expand state, `FullHeightPage` + `Panel` |
| `frontend/app/traceability/page.tsx` | 9 | Route and static `metadata.title` |
| `frontend/components/shell/sidebar.tsx` | +4 | One flat nav entry, `FolderTree` icon, after **Test runs** |

## Integration

- **Neighbouring screens.** Read-only import of `VerificationChip` from the requirements
  screen; cross-screen imports are established here (`definitions-columns.tsx` ↔
  `chip-list.tsx`). Nothing in `screens/requirements/` or `screens/definitions/` changed.
- **Routes.** Links target the existing `/requirements/{id}`, `/definitions/{td}`, `/runs/{id}`
  detail pages and the `/requirements`, `/definitions`, `/runs` lists. No route was added
  beyond `/traceability` itself.
- **Nav.** The sidebar stays flat (BL-53). One entry, after Test runs, because the tree
  composes the four lists above it.
- **API.** Unchanged. The screen is additive over shipped reads.
- **Verdicts (BL-11).** When the verdict writer lands, requirement rows move from *Exercised*
  to *Tested* / *Failed* with no change here: the chip reads `verification_state`, which the
  API folds.
- **`system` field.** When it ships, delete `FALLBACK_SYSTEM` and the fallback branch; the
  system level then splits by itself.
