# Add several test definitions to a run — architecture

**Branch:** `jama-ui-dev` · **Built:** 2026-09-24 · **Scope:** frontend only, no route change

## What it does

The Test Run page's definitions panel used to open an inline combobox that added **one**
definition per confirm (`definition-picker.tsx`, landed `1f40ce7`). It now opens a modal that
narrows the mirrored definitions by **project** and **feature**, shows them as a checkbox list
with their chapter and status, and applies every newly ticked one in a single confirm.

## Why this shape

**Project and feature are joins, not fields.** A test definition carries neither. The project
comes from its work order (`WorkOrderListItem.project`, the only row that names one) and the
feature is the `system` of the requirements it verifies. `system` is the level the traceability
tree already nests under (`Project → Porsche Taycan → BMS → …`), which is why it — and not the
requirement's `chapter` — is the Feature selector. The chapter rides on each row instead, so the
distinction stays visible; swapping the two means changing which field `definition-choices.ts`
reads into `features` and which into `chapters`.

**The verifies relation is read from both projections**, the way
`components/screens/traceability/traceability-model.ts` reads it: the requirement's derived
`verified_by` and the definition's authored `covers_req_ids`. A definition covering requirements
in two systems stands under both features.

**Three list reads, joined in the browser.** Requirements, definitions and work orders, one page
of 200 each — the registry holds tens of each, so a join route on the API would only move the
same work to the server. Same call pattern as the traceability screen.

**The dialog mounts only while open.** No request and no hook runs on a Test Run page whose add
button has not been pressed.

**Add only, one POST per tick.** `POST /test-runs/{run_id}/definitions` moves one member and
answers the whole run; it is idempotent per member. Three new ticks are three calls, issued in
order. A bulk route would exist only to save two HTTP round-trips on a ten-row estate. Removal
stays on the panel row, where one click already says exactly what it does — a dialog that both
added and removed would have to report two kinds of partial failure from one confirm.

**A definition already on the run renders ticked and disabled**, labelled `already on this run`.
The tick states the fact, the disable refuses the action; an unticked-but-marked row would invite
a click that does nothing.

**Partial failure is named, never swallowed.** The loop records what landed and what was refused.
All-success closes with a toast; anything refused keeps the dialog open and says which ids landed
and which did not, with the registry's reason. Nothing is rolled back — the landed members are
real. The refused ids stay ticked, the landed ones come back as `present` from the refreshed run
and lock themselves.

**A tick survives a facet change.** Ticking two under one feature, switching, then ticking two
more confirms all four; a footer line states how many ticks are currently out of view.

## Data flow

```
Add definitions (PanelHead)
  └─ AddDefinitionsDialog (mounted while open)
       ├─ useRequirements({page_size:200}) ─┐
       ├─ useTestDefinitions({page_size:200})├─ buildDefinitionChoices()
       ├─ useWorkOrders({page_size:200}) ───┘        │
       │                                             ▼
       │                      DefinitionChoice[] {tdId,title,status,project,features,chapters,present}
       │                                             │
       │              project select ──► narrow() ──►│──► feature select ──► narrow() ──► rows
       │                                             │
       └─ confirm ─► for each ticked ∧ ¬present: useAddRunDefinition.mutateAsync(tdId)
                        └─ POST /test-runs/{id}/definitions → RunDetail
                             └─ setQueryData(runs.detail) + invalidate runs.all,
                                testDefinitions.all, workOrders.all, home
                                  └─ run prop redraws → panel + dialog see the new definition_ids
```

## File inventory

| File | Change |
|---|---|
| `frontend/components/screens/run-detail/add-definitions-dialog.tsx` | new — the dialog: two selectors, the checkbox list, the confirm loop |
| `frontend/components/screens/run-detail/definition-choices.ts` | new — the pure join (choices, facet values, narrowing) and the refusal copy shared with the panel |
| `frontend/components/screens/run-detail/definitions-panel.tsx` | Add control opens the dialog; `useAddRunDefinition` and the local refusal map moved out; per-row remove and the manual-linkage line untouched |
| `frontend/components/screens/run-detail/definition-picker.tsx` | deleted — replaced |
| `frontend/types/requirement.ts` | `RequirementRow.system?: string \| null` declared; the API has served it since the system-attribute commit (`api/api/models/requirements.py:50`) |

`use-debounced-query.ts` stays: `edit-run-dialog.tsx` still searches work orders with it.

## Integration and known edges

- The panel resolves a covered definition's title through the **run's work order**
  (`useWorkOrder(run.work_order_id).definitions`). The dialog can now offer a definition from
  another work order, and such a row reads `no mirrored definition under this id` on the panel
  until the page is reloaded onto a work order that mirrors it. The dialog opens on the run's own
  project, so this is reachable only by deliberately widening the Project selector.
- Nothing in `api/` changed: the two per-member routes and their refusals (`run_not_found`,
  `unknown_definition`) are as shipped.
- Test surface (BL-48): the panel no longer calls `useAddRunDefinition`, and the closed dialog
  calls nothing, so the run-detail tests that mock `@/lib/hooks` wholesale need one hook less at
  rest. A test that opens the dialog needs `useRequirements`, `useWorkOrders`, `useTestDefinitions`
  and `useAddRunDefinition` on the mock.
