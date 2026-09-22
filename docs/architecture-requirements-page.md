# Requirements page — architecture

## What this is

A list-and-detail Requirements screen in the Test Manager frontend, at
`/requirements` and `/requirements/{reqId}`, over the mirrored `requirements`
collection the API side of this feature builds in parallel. The list carries
fifteen data columns — every authored attribute the spec's default nine
omitted (`ears_pattern`, `system_states`, `measurand`, `revision`, `source`,
`related_reqs`) plus the nine originally specced — and every visible column
is filterable, server-side, in the shape the runs and work-orders screens
already use (facets, quick views, URL-backed state, active-filter pills). The
detail is a stack of panels: the rendered requirement text with its
`{parameter}` tokens drawn as inline chips, an authored-attributes grid, a
derived-verification grid, a runs-and-verdicts table, and the entity journal.
Add / edit / retire controls sit on both the list and the detail, following
`authoring-controls/spec.md`'s verb matrix: a manual row can be added and
edited; a planning row's authored fields cannot be edited here at all; every
row, either origin, can be retired (never deleted).

## Why this architecture

**Two origins, one screen, no new component.** Before this feature every list
in this app was either fully planning-mirrored (work orders, definitions) or
fully local (runs' five patchable fields). A requirement is the first entity
where two rows of the same table can be written by two different doors —
`POST /planning/sync` for one, the new `POST /requirements` for the other.
Rather than build a second screen or a mode switch, the existing table/detail
idiom reads each row's origin off `RequirementDetail.field_sources` (the
committed API's per-field provenance map, the same shape `sourced()` already
gives every other entity — `types/requirement.ts`'s `requirementOrigin()`
helper), and every write control checks it before rendering
(`authoring-controls/spec.md` §4's rule: *a control renders if and only if
some source can legally own the write right now; otherwise it is absent,
never disabled*). This is the same pattern the read-only mirror screens
already use for their permanently-absent controls — just applied per-row
instead of per-screen, and, because origin only travels on the *detail*
read, applied at detail-load time rather than at list-render time (see
"Known simplifications").

**The dispatch brief overrides two of `requirements-page/spec.md`'s own
decisions, deliberately.** That spec's §2 line *"Nothing on this page is
editable"* is stale the moment `authoring-controls/spec.md` exists, and the
brief says so explicitly — follow the authoring spec's verb matrix instead.
Separately, the brief widens the shipped column set past the read spec's
"nine columns, wider set only in the export" decision (§4, §6 of that spec)
because the user asked for more columns and for filtering by any of them.
Both departures are named here rather than silently reopened, per the
project's own rule that a change to an agreed decision is a decision, not a
guess.

**One `SourceBadge` variant carries the whole "authored vs computed"
distinction, not a new component.** `requirements-page/spec.md` §5 already
designs this: dashed border = computed, solid = authored, one badge per
column header on the list and per field label on the detail, never per cell.
`components/shared/source-badge.tsx` gained one more `SourceKind` value,
`"derived"`, with a border-style-only variant class so it costs no contrast
ratio and needs no dark-mode-specific colour. Every derived column here
(Verification, Verified by, Latest run, Runs) carries it; every authored
column carries `api:planning` at the column-header level, which is a
simplification — see "Known simplifications" below.

**Filters that the read contract does not (yet) define are additive query
params, not client-side re-filtering of a loaded page.** Filtering only the
rows already on screen would silently misreport a filtered count that has
nothing to do with the server's total, which is worse than a filter that
currently does nothing. Every filter this screen sends is a real
`GET /requirements` query parameter; an API that does not yet implement one
simply ignores it (FastAPI does not 422 on an unbound extra query param), so
the screen degrades to "filter not yet wired" rather than "filter lies."
See "Beyond §10" below for the exact list the parallel API build needs to
pick up.

**Retire reuses the runs list's destructive-confirm idiom, word changed.**
`delete-runs-dialog.tsx`'s typed-word confirm, its report-of-failures shape
and its `DESTRUCTIVE_CLASS` styling are the one destructive-control pattern
this app has. Retire is not delete — the row and its id survive — so the
dialog is a new file with the confirm word changed to `retire` and delete's
"gone forever" language replaced with "stays reachable by id," but it borrows
the styling constant directly rather than re-deriving it, so the two
destructive buttons in this app never visually drift apart.

**Edit fetches the detail on open, not on hover.** `RequirementRow` (the list
row) does not carry `text`, `rationale`, `verification_criteria` or
`figure_refs` — only the detail read does. The edit dialog is therefore
mounted on demand (the same "mount only while there is a target" pattern
`AddNoteDialog` already uses from `definition-detail-screen.tsx`) and calls
`useRequirement(reqId)` itself, showing a skeleton until the full row
arrives, then prefilling the form from it.

## Data flow

```
GET /requirements?chapter=&status=&state=&method=&ears_pattern=&system_state=
                  &measurand=&source=&revision=&related_req=&has_verified_by=
                  &has_latest_run=&q=&page=&page_size=
        │
        ▼
requirementsApi.list()  (lib/api/requirements.ts)
        │
        ▼
useRequirements(filters)  (lib/hooks/use-requirements.ts, TanStack Query)
        │
        ▼
RequirementsScreen  ──renders──▶  15-column table, quick views, facets panel,
                                   active-filter pills, batch retire bar
        │ row click
        ▼
/requirements/{reqId}  ──▶  useRequirement(reqId)  ──▶  RequirementDetailScreen
                                                          (panels A–F)
```

Writes:

```
+ New requirement           ──▶ POST /requirements            (manual only)
row/detail Edit (manual only) ──▶ PATCH /requirements/{id}    (item_version-guarded)
row/detail/batch Retire       ──▶ POST /requirements/{id}/retire  (either origin)
```

Every write hook (`use-requirements.ts`) invalidates `keys.requirements.all`
and, for create/retire, `keys.home` — the sidebar's requirement count reads
`GET /home/summary`'s `counts.requirements`, so an add or a retire updates the
nav badge on the next poll without a page reload.

## File inventory

**Types**
- `types/requirement.ts` — new. `RequirementRow`, `RequirementDetail`,
  `RequirementEvidence`, `RequirementMeasurand`, `VerificationState`,
  `EarsPattern`, `RequirementFacets`, `RequirementListFilters`, the three
  write bodies.
- `types/index.ts`, `types/summary.ts` (`HomeCounts.requirements`),
  `types/journal.ts` (`JournalEntityType |= "requirement"`) — additive.

**API client & data hooks**
- `lib/api/requirements.ts` — new. `list`, `facets`, `get`, `journal`,
  `create`, `patch`, `retire`.
- `lib/hooks/use-requirements.ts` — new. Query + mutation hooks, mirroring
  `use-work-orders.ts` / `use-runs.ts`'s shape exactly.
- `lib/hooks/keys.ts`, `lib/hooks/index.ts` — additive.

**Shared primitives touched**
- `components/shared/source-badge.tsx`, `types/source.ts` — the `"derived"`
  `SourceKind` and its tooltip sentence (spec §5.2, applied verbatim).
- `lib/export-columns.ts`, `lib/saved-searches.ts`, `lib/api/searches.ts`,
  `lib/hooks/use-saved-searches.ts` — `"requirements"` added to the three
  independent scope unions these stores keep (export-column choice, the
  device-local saved-search store, the server saved-search API), each one
  mechanical and additive.
- `lib/journal-href.ts`, `lib/hooks/use-file-link.ts`,
  `components/screens/audit/audit-screen.tsx` — `"requirement"` added to the
  journal entity-type maps so an Audit-table row for a requirement links to
  its detail screen and the journal note infrastructure knows which query key
  to invalidate. (`crumbs.tsx` needed **no** change — `Crumb`'s `type` prop is
  already a free string, not a closed union; the spec's build list assumed a
  union that does not exist in this codebase.)
- `components/shell/sidebar.tsx` — `SidebarCounts.requirements`; a new
  **Requirements** nav entry, depth 2, directly above **Test definitions**
  (§"Sidebar placement" below).
- `types/work-order.ts` (`TestDefinitionListItem.covers_req_ids`),
  `components/screens/definitions/definition-detail-screen.tsx` (a
  **Verifies** row in the Planning-metadata grid, linking each id to
  `/requirements/{id}`) — the other half of the Requirements page's
  "Verified by" column, so the traceability chain is walkable from either
  end.

**Requirements screen**
- `app/requirements/page.tsx`, `app/requirements/[reqId]/page.tsx` — routes.
- `components/screens/requirements/`:
  - `requirements-screen.tsx` — the list.
  - `requirements-table-config.ts` — `TableStateConfig`, the CSV column set,
    the presence/absence filter option constant.
  - `requirements-filters-panel.tsx` — the filter-panel controls, split out
    of the screen file to keep it under the soft file-length ceiling.
  - `requirements-active-pills.ts` — pure builder for `ActiveFilterPills`,
    one function per filter group, unit-testable with no DOM.
  - `contains-filter-input.tsx` — a substring-match text filter (Revision,
    Related-to), the same shape as the Audit screen's `ExactFilterInput` but
    worded for "contains" instead of "matches exactly."
  - `verification-chip.tsx` — the five-state derived chip + the separate
    `stale` marker.
  - `chip-list.tsx` — the one multi-valued-cell rule (first N, then `+N`),
    used by every chip column on the list and every chip field on the detail.
  - `requirement-detail-screen.tsx` — panels A–F.
  - `requirement-text-panel.tsx` — the rendered text + the "Show tokens"
    toggle + per-token inline chips.
  - `covering-runs-panel.tsx` — panel E, one row per `(run, definition)`.
  - `requirement-form-fields.tsx` — the authored-field form shared by the
    add and the edit dialog.
  - `add-requirement-dialog.tsx`, `edit-requirement-dialog.tsx`,
    `retire-requirement-dialog.tsx`, `requirements-batch-bar.tsx`.

## Integration with neighbouring features

- **Definitions.** `covers_req_ids` on `TestDefinitionListItem`/Detail feeds
  a new "Verifies" row on the definition detail, linking outward to
  `/requirements/{id}` — the same authored fact the Requirements page's
  derived `Verified by` column reads by inversion (BP5). Neither screen
  computes the other's value; both read from the definition's authored field
  or its inversion, so they cannot disagree.
- **Runs.** `latest_run_id` / the covering-runs table link into
  `/runs/{run_id}` using the exact `RowLink` / `Link` idiom the runs list and
  the definition detail already use. No change to the runs screen itself —
  the model spec's build list confirms `GET /test-runs` (the list) is
  untouched by this feature.
- **Home / sidebar.** `HomeCounts.requirements` feeds the sidebar's
  Requirements badge exactly the way `test_definitions` already feeds the
  Test-definitions badge — same optional-field, fall-back-to-zero pattern.
- **Audit / journal.** `"requirement"` joins the six existing entity types in
  the journal entity-type maps, so a requirement's history shows in the
  cross-entity Audit table and its rows link back to the detail screen.
- **Saved searches / CSV export column choice.** `"requirements"` is a fifth
  scope in the three independent scope unions those two stores keep, so a
  saved requirements search and a chosen export column set persist and
  restore exactly the way a runs or work-orders one does.

## Sidebar placement

`requirement-status-from-runs/spec.md` §7.3 recommends the entry sit "above
Test definitions," reasoning that the nav should teach requirement →
definition → run. This repo's actual nav chain, per the comment already at
`sidebar.tsx:212-215`, is *work order (campaign) → test runs (evidence) →
test definitions (what a run covers)* — not the model spec's assumed shape.
Rather than resolve that mismatch by re-deriving the whole nav order, this
build honours the model spec's literal instruction: **Requirements sits at
depth 2, immediately above Test definitions**, both nested under the same
Work-orders → Test-runs chain. A reader now meets the thing a definition
verifies just before meeting the definition itself.

## Beyond §10 — where this build extends the read contract

`requirements-page/spec.md` §10 is the authoritative read contract, and
another agent built `api/api/models/requirements.py` /
`api/api/routers/requirements.py` in parallel (committed as `3b3910a` during
this build). This frontend was checked directly against that committed code,
not only the spec text, and the two disagree in more places than a spec
reading alone would predict. Every gap below is real, not speculative, and
every one degrades to an empty/absent state on this frontend, never to a
crash — but each is a genuine integration item for whoever reconciles the
two builds next:

| Gap | Committed API | This frontend's answer |
|---|---|---|
| `GET /requirements/facets` | **Does not exist.** No route, no `queries_requirements` function. | Chapter/Status/Method/System state/Measurand/Source filters render with no options until the route is added; `useRequirementFacets()` fails silently (`data` stays `undefined`). |
| `GET /requirements/{id}/journal` | **Does not exist**, and `api/api/routers/journal.py`'s entity map was not extended with `"requirement"` either. | The History panel shows its normal `ErrorState` until both land. |
| `RequirementRow` | No `system_states`, `measurand`, `source`, `related_reqs`, `item_version`, `content_sha256`, `asil`, or any row-origin field. Only `req_id, title, status, chapter, ears_pattern, revision, verification_method` (four of those seven **nullable**) plus the seven derived fields. | The four widened columns render empty until the row carries them (`RequirementRow.system_states` etc. are optional in `types/requirement.ts`); row-level Retire fetches a fresh `item_version` via `GET /requirements/{id}` immediately before writing (see "Known simplifications"); row-level Edit always opens, and the dialog's own detail fetch (which **does** carry provenance) decides whether a form renders. |
| `asil` | **Does not exist anywhere** — not on `RequirementRow`, not on `RequirementDetail`, not on either write request. `requirements-page/spec.md` proposed adding it; it was not built. | Removed entirely from this frontend — no column, no form field, no CSV column. Keeping it would have meant a form field that silently 422s the whole `PATCH` the moment `extra="forbid"` sees the key (see next row). |
| `RequirementPatchRequest` | `RequestModel`, `extra="forbid"`. Fields: `title, text, ears_pattern, chapter, system_states, rationale, source, verification_method, measurand, revision, related_reqs, figure_refs, verification_criteria, parent_version, actor, second_actor, note`. **No `status`.** | The edit form's Status control is hidden (`RequirementFormFields showStatus={false}`) and `status` is never diffed into the patch body — a status move is not this route's job. |
| Row-level provenance | **No flat field.** `RequirementDetail.field_sources: FieldSources` — the same per-field provenance map every other entity detail already carries (`sourced()`, `types/source.ts`) — is the only place origin lives, and only on the detail read. | `requirementOrigin(detail)` reads `field_sources.title.source` as the row-level proxy. This independently avoids the naming collision an earlier draft of this doc flagged for Buddy (a `source: "manual"\|"api:planning"` field would have collided with the requirement's own authored `source: string[]` stakeholder-tag field) — the committed API's choice of `field_sources` sidesteps that question entirely, without anyone having to pick a name. |
| `RequirementEvidence` | `run_id, definition_id, definition_title, outcome, produced_at, implementation_sha256, current: bool \| None, evidence_values`. **No `first_data_at`.** | The covering-runs table's "Arrived" column reads "—" until the API adds it. |
| Filters beyond `chapter`/`status`/`state`/`method`/`q` | Not read by `list_requirements` at all. | Every widened-column filter (`ears_pattern`, `system_state`, `measurand`, `source`, `revision`, `related_req`, `has_verified_by`, `has_latest_run`) is sent as an ordinary query param FastAPI does not bind and therefore ignores — no 422, the filter is simply inert until the route reads it. |
| `RequirementDetail.resolved_tokens` | Does not exist; only `text` and `text_rendered` (flat string) do. | §7B asks for a chip **per** resolved `{token}`; without a token→resolution list this frontend falls back to rendering the flat `text_rendered` string with no per-token chips (`RequirementTextPanel` already handles the absent case). |
| `RequirementViewCounts` | `all, not_covered, covered, exercised, failed, tested`. **No `no_evidence`.** | The "No evidence" quick view still filters correctly (`state=not_covered&state=covered`); it just shows no count badge until the fold adds the field. |

None of these break the contract as written — every one is additive or
gracefully absent, and this frontend was typechecked and linted against the
actual committed models (not just the spec prose) to confirm every gap above
degrades rather than crashes.

## Known simplifications

- **Column-header origin badges are column-level, not per-row**, and the
  **list's row-level Edit icon always renders**, unconditionally. Both follow
  from the same fact: `RequirementRow` carries no provenance data at all (see
  "Beyond §10"), so the list genuinely cannot know a row's origin without
  fetching its detail first. The detail screen's header block shows the
  correct per-row origin badge and correctly gates its Edit button, because
  it has already loaded `field_sources`. Opening Edit from the list on a
  planning row shows the dialog's "mirrored from planning, edited there, not
  here" notice instead of a form — one extra click to discover what a
  per-row list badge would have said up front, traded for not fetching every
  visible row's detail just to paint an icon.
- **Row-level and batch Retire fetch a fresh `item_version` immediately
  before writing**, rather than using a version read at list-load time.
  `RequirementRow` carries no `item_version` to reuse (see "Beyond §10"), and
  fetching fresh is also the more correct concurrency guard regardless: a
  version cached from when the list first loaded could already be stale by
  the time a person confirms a retire several minutes later. The detail
  screen already holds a just-loaded `item_version` and passes it directly,
  skipping the extra round trip.
- **The four-eyes `second_actor` field is a plain text box**, not a picker
  against a user directory — this codebase has no such directory or search
  endpoint (`useActor()` only resolves the *current* signed-in identity).
  `authoring-controls/spec.md` §7 explicitly leaves eligibility policy to
  `review-page/spec.md`; this build wires the gate's presence/absence only.
- **Edit diffing cannot clear an optional field back to empty** — an emptied
  text box reads as "no change," the same limitation `edit-run-dialog.tsx`
  already has and states explicitly in its own dialog copy. Consistent with
  existing app behaviour, not a new gap.
- **Multi-valued authored fields (`system_states`, `source`, `figure_refs`,
  `related_reqs`) are edited as one comma-separated text box each**, not a
  dedicated per-field row editor (`measurand` keeps its own row editor
  because it is `{name, unit}`, not a flat string). Matches "light functional
  code" over building four near-identical list widgets for a form already
  carrying fourteen fields.
- **The local mock backend (`lib/mock/db.ts`, `app/api/v1/*`) was not
  extended.** Every other entity in this app has a matching mock so the
  screen works with `TM_USE_MOCK_API=1` and in tests that hit the mock
  directly. This feature's read/write surface was coded only against the
  real contract per the dispatch brief's explicit instruction not to "stub a
  fake client that will be forgotten." Until the mock gains `requirements`
  data and routes, `/requirements` renders its error state under
  `TM_USE_MOCK_API=1`, exactly as it will against a real backend that has not
  deployed this feature yet.
