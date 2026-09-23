# One test case across software versions

**Status:** Draft
**Project:** comma-car-segments-ingest
**Branch / HEAD:** `jama-ui-dev` @ `a933478`
**Created:** 2026-09-23
**Planned with:** Buddy

The user's two sentences:

> *"we need to add some unique id to test run files and version it"*
> *"imagine, that same TC can be tested in mutiple workorders based on SW version"*

They are one feature. A campaign qualifies a build; the next build gets its own campaign; the
same ten test cases run in both. Today a test definition binds to exactly one work order
(`api/api/models/planning.py:66`), nothing in this repository models a software version at all
(a grep for `sw_version|software_version|ecu_version|build_version` across `api/` and
`battery-trace-gen/` returns nothing), and a requirement's verification state silently reports
the **newest** run's verdict as if it were the only one
(`api/api/services/queries_requirements.py:147-221`). So `BAT-SYS-PRF-001` passing on one build
and failing on the next reads `failed`, flat, with no way to see the pass.

The file half is smaller than it looks: raw-file versioning shipped on 20 Aug 2026 and is
complete. What is missing is a *writer* that uses it and a *reader* that shows it.

---

## 1. What breaks today

Sixteen call sites. Each one is listed with what it does now and what goes wrong the moment
`BAT-SYS-TC-001` is carried by both `WO-BAT-2026-001` and a second campaign.

### 1.1 The one already hit — the implementation lands in the wrong campaign's folder

`api/api/services/queries_runs.py:1623-1637`:

```python
def latest_run_id_for_definition(db: Database, td_id: str) -> str | None:
    """The newest run carrying this definition, or None when no run carries it.
    ...
    A definition sits on several runs in the model and on exactly
    one in this estate, and the newest is the one a person is working on when
    they upload.
    """
```

Its own docstring names the assumption this feature deletes. Its single caller,
`api/api/routers/test_definitions.py:917-918`, uses the answer to choose the **blob folder** an
uploaded `.py` lands in:

```python
run_id = queries_runs.latest_run_id_for_definition(db, td_id)
key = implementation_blob_key(run_id, filename, digest)
```

With two campaigns the sort (`first_data_at DESC`) picks whichever campaign recorded most
recently. A person working in the older campaign uploads TC-001's implementation and it is
written into the *other* campaign's run folder, `<root>/<their run>/`. Nothing reports it: the
stored `implementation.blob_path` pointer still resolves, so every read works and only the
folder lies. §4 removes the function.

### 1.2 Definition ↔ work order — the binding itself

| Site | Now | Breaks as |
|---|---|---|
| `api/api/models/planning.py:66` | `TestDefinitionRow.work_order_id: str \| None` | A definition can name one campaign. It cannot express the feature at all. |
| `api/api/models/planning.py:397` | `PushedDefinition.work_order_id: str \| None = None` | The seed cannot *send* two campaigns for one definition. |
| `api/api/planning_sync.py:430-438` | `_mirror_definitions` writes the scalar | Second push overwrites the first campaign's binding. |
| `api/api/services/queries_runs.py:1819` | `get_work_order_detail` → `find({"work_order_id": wo_id})` | TC-001 appears on one campaign's page and is invisible on the other's. |
| `api/api/services/queries_runs.py:1761` | `list_work_orders` → `_count_by(db, "test_definitions", "work_order_id", wo_ids)` | `definition_count` credits one campaign only. (`_count_by` already `$unwind`s an array field, `:1777-1796` — it survives the field becoming a list unchanged.) |
| `api/api/services/queries_runs.py:1595` | `test_definition_facets` → `{"$addToSet": "$work_order_id"}` | The filter popover lists one work order per definition. |
| `api/api/services/queries_runs.py:1489-1496` | `orphan_clause` → `{"work_order_id": {"$nin": known}}` | Scalar membership. |
| `api/api/services/queries_runs.py:1499-1524` | `_derived_definitions` → `"orphaned": row.get("work_order_id") not in linked` | Same. |
| `api/api/services/queries_runs.py:1540` | `_definition_matches` → `row.get("work_order_id") not in work_order` | The `?work_order=` filter misses a definition carried by that campaign but *stored* under another. |
| `api/api/services/queries_runs.py:1651-1668` | `get_test_definition_detail` → one `work_order` block, `orphaned = work_order is None`, and `runs` = **every** run carrying the td | A person on TD-001 sees both campaigns' runs in one undifferentiated list. |
| `api/api/services/queries_runs.py:940, 957` | Home summary orphan count and attention rows, via `orphan_clause` | Same clause. |
| `api/api/db.py:64` | `definitions.create_index([("work_order_id", ASCENDING)])` | Index on a field that is about to become a list. |

### 1.3 The destructive one

`api/api/services/queries_runs.py:1834-1839`, `delete_work_order`:

> *"The definitions go with it: a definition whose work order is gone reads `orphaned` on every
> screen, which is a state to repair rather than one to create."*

Deleting `WO-BAT-2026-001` deletes `BAT-SYS-TC-001..010` — **including from the second campaign,
which is untouched and still needs them.** This is the only site in §1 that destroys data rather
than misreporting it.

### 1.4 Ingest — a trace can be filed under the wrong campaign

`api/api/planning_sync.py:603-621` (the link backfill) and `:694-700` (`_resolve_claims`) both
resolve a run's work order **from the definition's single `work_order_id`**:

```python
work_order_id = (mirror or {}).get("work_order_id")
if work_order_id:
    return work_order_id, definition_id, f"definition {definition_id}"
```

A trace from the second campaign that claims `test.definition=BAT-SYS-TC-001` and nothing else
is linked to the *first* campaign's work order, tagged `embedded`, and reads `complete` on
screen. This is the ingest-time twin of §1.1 and it is worse, because it mislinks the evidence
rather than a convenience copy of a `.py`.

Our traces do not hit it today (`battery-trace-gen/seed/planning_payload.py:111-122` states
`work_order_id` on every link and no definition), but the rung exists and a bench that ticks a
definition will take it.

### 1.5 Verification state — the reason the feature is worth building

`api/api/services/queries_requirements.py:147-157`:

```python
def _newest_verdict_of_td(fold: dict, td_id: str) -> tuple[dict | None, dict | None]:
    """The newest run of `td_id` that carries a verdict, and that verdict.

    A test case re-run after a fix is judged on its latest attempt, not on
    its first (§5.3).
    """
```

"Re-run after a fix" and "run against a different build" are indistinguishable to this function.
`_state_fold` (`:173-221`) then folds one value for the whole requirement. §6 has the fix.

### 1.6 Everything else

- **Frontend:** `frontend/components/screens/definitions/definitions-columns.tsx:54-61`
  (single-value cell), `definition-detail-screen.tsx:102-196` (one crumb, one `MetaCell`, the
  orphan banner text at `:141-143`), `definitions-filters-popover.tsx:71-74`,
  `definitions-active-pills.ts:23`.
- **Fixtures and seed:** `api/seed/fixtures.py:132,141,291`, `api/seed/filler.py:266`,
  `api/mock_planning/fixture.json` (7 rows), `api/mock_planning/demo_admin.py:278-289`,
  `api/tests/factories_planning.py:72,81,93,104`.
- **`dev-planning/run-a-definition/spec.md`** survives unchanged: its Run button acts on an
  explicit `(definition, run)` pair, never on a guessed run. It is the one place that already
  does the right thing.

---

## 2. Where the software version lives

### 2.1 The position

**Two fields, one name, no precedence rule between them.**

- **`test_runs.sw_version: str | None`** — the build the system under test was actually running
  when these bytes were recorded. This is the **only** value any verdict, rollup or verification
  state reads.
- **`work_orders.sw_version: str | None`** — the build this campaign plans to qualify. A plan
  field. No derived state reads it.

### 2.2 Why not one of them

**Not the work order alone.** The evidence is the trace. A campaign that says "we qualify 1.5"
and a bench that actually recorded 1.4.3 disagree, and the truth is the bench's. Reading a
verdict's build off the plan would put an assertion nobody measured into an ASPICE evidence
chain. It also breaks the moment one campaign spans a hotfix, which is the normal case.

**Not the run alone.** Then a campaign has no build until a trace lands: the work-order page for
"qualify 1.5" reads blank before its first run, `planned_runs` means nothing, and you cannot
*plan* a campaign for a build not yet recorded — which is what a work order is for.

**Not "both with the run overriding."** That framing makes them one field stored twice and forces
a resolution rule. They are two different claims: *intent* and *evidence*. Nothing resolves them,
so nothing can get the resolution wrong. A disagreement between them is visible on the work-order
page, which already lists its runs — no flag, no validation, no refusal. (Standing rule: no
defensive branch for data the operator owns.)

### 2.3 The field

```
sw_version: str | None = None
```

- **Type `str`.** Every neighbouring version field in this estate is a free string:
  `bench_sw: str | None` (`api/api/models/runs.py:222`), `revision: str | None`
  (`api/api/models/requirements.py:50`), `tool_version: str` (`api/api/models/results.py:77`).
  A semver type would refuse `1.5.0-rc3+b1147` and `P-1147/2026-09`, which are shapes an OEM
  ships. No parsing, no comparison, no ordering — the value is an opaque label.
- **Not required.** Null means *nobody stated it*, never *version zero*. This is what makes §7 a
  no-op deploy.
- **Name.** `sw_version` sits beside `bench_sw`, which names the *bench's* software. On the wire
  the two are visibly a pair: `test.bench_sw` and `test.sw_version` in
  `<common_properties>`. `bench_sw` is the equipment; `sw_version` is the item under test.

### 2.4 The ingest chain

One entry in each of two existing tables in `tm-connector/connector/identity.py`:

- `HEADER_RUN_FIELDS` (`:80-90`) gains `"test.sw_version": "sw_version"`.
- `DECLARED_FIELDS` (`:60-74`) gains `"sw_version"`.
- Classification: **`CONTEXT_FIELDS`** (`:107`), beside `bench_sw` — *"free-text context …
  declared wins, typed by the person who knows"* (`:27-28`). The build is asserted by whoever
  flashed the bench; the bytes cannot prove it. `ASSERTED_FIELDS` is
  `LINKAGE_FIELDS + CONTEXT_FIELDS` (`:116`), so the foreign-record guard covers the new field
  with no new rule.

`battery-trace-gen/bus/mf4.py:99` gains `"sw_version"` in its `keys` tuple, and
`battery-trace-gen/scenarios/_identity.json`'s `test` block gains the key.

### 2.5 The four existing runs and the one work order

They carry no such field, so they read `sw_version: null`. A null bucket folds exactly as
today's single bucket does, so **deploying this changes no screen and no derived value.** §7
says what to do afterwards.

---

## 3. The definition ↔ work order relationship

### 3.1 The shape

**The definition carries a list. `work_order_id` retires; `work_order_ids: list[str]` replaces
it.** Multikey-indexed, defaulted empty.

Existing (`api/api/models/planning.py:64-77`):

```python
    td_id: str = Field(validation_alias="_id")
    title: str
    work_order_id: str | None
```

becomes:

```python
    td_id: str = Field(validation_alias="_id")
    title: str
    work_order_ids: list[str] = Field(default_factory=list)
```

and `TestDefinitionDetail.work_order: DefinitionWorkOrder | None` (`:219`) becomes
`work_orders: list[DefinitionWorkOrder]`. `DefinitionWorkOrder` itself is unchanged.

### 3.2 Why not the other two

**Not "the link lives on the run."** It deletes the most code and is wrong: a work order is a
*plan*. Under that model a campaign has no definitions until a trace lands, `definition_count`
reads 0 for every fresh campaign, `planned_runs` has no owner, and the work-order page cannot
state its own scope. The join `(run.work_order_id, run.definition_ids)` answers *what was
tested*, never *what is planned*.

**Not a join collection.** `work_order_definitions` with `_id = "<wo>|<td>"` is the right answer
the day the pair carries data of its own. Today it carries none (§3.4 keeps `planned_runs` on the
definition), so the collection's documents would hold nothing but their own two foreign keys —
that is an index, not an entity. It costs a new collection, a new mirror path in `planning_sync`,
and a lookup in seven readers. §9 OQ7 names the trigger that would force it.

**Why a hard retire rather than a derived scalar.** `primary_definition`
(`api/api/models/runs.py:103-116`) keeps `definition_id` as the first element of
`definition_ids`, and the same trick would keep `work_order_id` alive for the four frontend
sites. It is rejected: "the first work order of a definition" is a meaningless fact, whereas "the
definition a run was planned for" at least reads as something. `definition_id` was preserved
because `tm-connector` and the OpenAPI snapshot are external readers of it; `work_order_id` on a
definition has no reader outside this repository. Keeping it would be a parallel concept with no
caller.

### 3.3 What each reader becomes

| Site | Becomes |
|---|---|
| `queries_runs.py:1496` `orphan_clause` | `{"work_order_ids": {"$nin" if orphaned else "$in": known}}` — **the operators need no change.** On a multikey field `$nin` means "no element is in the list" and `$in` means "some element is", which is exactly the two questions. A missing field and an empty array both sit outside. |
| `queries_runs.py:1521` `_derived_definitions` | `"orphaned": not (set(row.get("work_order_ids") or []) & linked)` |
| `queries_runs.py:1540` `_definition_matches` | `if work_order and not (set(row.get("work_order_ids") or []) & set(work_order)): return False` |
| `queries_runs.py:1595` facets | `{"$addToSet": "$work_order_ids"}` + the same `$reduce`/`$setUnion` stage already written beside it for `covers_req_ids` (`:1602-1609`) — copy that stage, do not invent one. |
| `queries_runs.py:1761` `list_work_orders` | `_count_by(db, "test_definitions", "work_order_ids", wo_ids)` — **unchanged otherwise**, because `_count_by` already `$unwind`s (`:1777-1796`). |
| `queries_runs.py:1819` `get_work_order_detail` | `find({"work_order_ids": wo_id})` — multikey equality matches an element. One character shorter than the change looks. |
| `queries_runs.py:1651-1668` `get_test_definition_detail` | `work_orders` = `find({"_id": {"$in": work_order_ids}})`; `orphaned` = that list is empty; **`runs` gains a grouping** — see §3.5. |
| `queries_runs.py:1834` `delete_work_order` | Pulls the id from each definition's list and deletes only the definitions left with an empty list. A definition another campaign still names survives. §9 OQ6. |
| `planning_sync.py:432` `_mirror_definitions` | `"work_order_ids": row.get("work_order_ids") or []` |
| `planning_sync.py:611-621`, `:694-700` | A definition no longer names *the* work order, so these two rungs **retire**. A run's work order comes from its own claim (`test.work_order`) or from an explicit `links[]` row, and from nowhere else. This deletes §1.4 outright rather than disambiguating it. |
| `api/api/db.py:64` | `definitions.create_index([("work_order_ids", ASCENDING)])` — multikey, same line. |
| `models/planning.py:397` `PushedDefinition` | `work_order_ids: list[str] = Field(default_factory=list)`. **No shorthand for the old scalar.** `PushedDefinition` is `extra="allow"`, so a stale payload's `work_order_id` rides into `raw` and the definition reads orphaned — loudly, on the Home attention panel. There is no third-party producer to protect: the in-cluster `Planning Sync Mock` is unreachable from a workstation and our seed posts directly (CLAUDE.md § "Seeding the Test Manager"), so every producer is in this repo and changes in the same commit. |
| Frontend (4 files, §1.6) | The work-order cell renders a list; the detail screen renders one crumb per campaign and one `MetaCell` listing them; the orphan banner's two-branch text (`definition-detail-screen.tsx:141-143`) collapses to the "names no work order" branch, because "names one the mirror does not hold" is now "names none the mirror holds" and reads the same. |

### 3.4 `orphaned` — what it means afterwards

**It does not retire, and its words do not change.** Today: *"names no work order, or names one
the mirror does not hold"* (`queries_runs.py:1492-1494`). Afterwards: *"names no mirrored work
order"* — the list is empty, or no id in it is mirrored. On screen it means what it always meant:
**this test case sits in no campaign.** The `$nin`/`$in` clause carries the new meaning without
an operator change (§3.3, row 1), the `?orphaned=` tri-state is untouched, the Home attention
count is untouched, and `delete_work_order`'s docstring stays true for a definition that was in
one campaign only.

### 3.5 `planned_runs`, and the definition's run list

`planned_runs` stays a scalar on the definition and is **read per work order**: "this many runs
are planned in *each* campaign that carries this test case."

That is not a new rule — it is the rule the one screen that matters already implements.
`get_work_order_detail` counts a definition's actual runs from *that campaign's* runs only
(`queries_runs.py:1813-1816`), so its plan-versus-actual is already per-campaign and needs **no
change**.

The definitions **list** row is the approximation: `actual_runs` there counts every run carrying
the definition across all campaigns (`:1510`), so `status` can read `on_plan` when one campaign
has run twice and another not at all. Accepted, recorded as §9 OQ1.

`TestDefinitionDetail.runs` (`models/planning.py:220`) currently mixes both campaigns' runs into
one list with nothing distinguishing them. `WorkOrderRun` (`:102-117`) carries no
`work_order_id`, so the frontend cannot even group them client-side. **`WorkOrderRun` gains
`work_order_id: str | None` and `sw_version: str | None`**, both defaulted, and the definition
detail groups its runs by campaign. This is the smallest change that makes the shared definition
legible.

---

## 4. The implementation `.py` per (TC, SW version)

### 4.1 One implementation per definition. It does not fork by build.

A test case is one pass criterion for one requirement. `BAT-SYS-TC-001` asserts
`i_dc_chg <= I_current_Chr_Max`; that assertion does not change because the DUT's build changed.
If it did, the test case itself changed — and that is a **TC version** move, which BL-33/BL-34
already model as `(R@v, TC@w)`. Forking the `.py` by build would make the TC version and the DUT
build two axes of one thing, and a verdict could not say which one moved.

The estate already answers the interesting case. When the implementation is rewritten, an older
verdict cites the old digest, and `_state_fold` catches it
(`api/api/services/queries_requirements.py:196-199`):

```python
implementation = definition.get("implementation") or {}
impl_sha = implementation.get("sha256")
pinned = impl_sha is None or impl_sha == block.get("implementation_sha256")
```

`pinned == False` → `any_stale_pass` → `exercised` + `evidence_stale: true`. That is precisely
"we changed the test; the old build's evidence predates it; re-run it." A per-build
implementation would duplicate this machine with a second, disagreeing answer.

### 4.2 The blob key stops naming a run

Current (`api/api/services/file_writes.py:144-166`):

```python
def implementation_blob_key(run_id: str | None, filename: str, digest: str) -> str:
    ...
    workspace = os.environ.get(WORKSPACE_VARIABLE, "").strip().strip("/")
    root = blob_root()
    prefix = f"{workspace}/{root}" if workspace else root
    run = _safe_segment(run_id or "", UNASSIGNED_RUN)
    name = _safe_segment(filename, "implementation.py")
    return f"{prefix}/{run}/{digest[:8]}-{name}"
```

becomes `implementation_blob_key(td_id: str, filename: str, digest: str)`, writing
`<workspace>/test-manager/implementations/<td_id>/<digest8>-<name>` — the sibling of
`requirements_blob_key`, which already files a definition's artefacts under
`<workspace>/test-manager/requirements/<td_id>/` (`file_writes.py:129-141`).

**This is a revert.** `dev-planning/tm-multi-definition-runs/spec.md:426` shows the signature was
`implementation_blob_key(td_id, filename, digest)` before `ad77ab2` moved it into the run folder.
The reason for the move — *"a reader of one run's folder finds the recording and the module that
judges it together"* — was a convenience for a person browsing blob in QuixLab, and it becomes a
lie the moment two campaigns share the definition (§1.1). Nothing globs the run folder: the
stored `implementation.blob_path` pointer is what every read follows
(`routers/test_definitions.py:994-999`), the Run button of `dev-planning/run-a-definition/` opens
that pointer, and `ingest_sweep` watches `test-manager/dropbox` and not the run folders
(`api/api/ingest_sweep.py:63-71`).

`latest_run_id_for_definition` (`queries_runs.py:1623-1637`) is then **deleted**, with its one
caller (`routers/test_definitions.py:917`). One function, one call site, one whole defect class.

`UNASSIGNED_RUN` (`file_writes.py:60`) is still read by the run-scoped writers and by
`mf4-to-blob/main.py:84`, so it stays.

### 4.3 What happens to the ten already uploaded

Nothing. Their `implementation.blob_path` pointers still resolve, and the download route follows
the pointer. The **next** upload of each lands in the new place. No blob migration, no
backfill, no dual-read.

---

## 5. Files: identity and version

### 5.1 What already exists

All of it. A file document carries `version: int = 1` (*"the first upload is version 1, and a
stored document without the field is version 1 too"*, `api/api/models/files.py:98-100`),
`supersedes: str | None` (`:114-116`), and a `version_group` naming the chain
(`api/api/routers/files.py:718-725`):

```python
def _version_group(file_doc: dict) -> str:
    """Name the chain one file belongs to.

    A document without `version_group` is the root of its own chain. Every
    file registered before 20 Aug 2026 carries no value, and each one is a
    root.
    """
    return file_doc.get("version_group") or file_doc["_id"]
```

`POST /files/{file_id}/versions` (`files.py:758-883`) appends to the chain: it resolves the chain
from any member, refuses a non-active head, mints `version + 1` under the unique
`(version_group, version)` index (`api/api/db.py:115-119`), retries a lost race, inherits the run
when the body names none, and — the load-bearing part for a pipeline —

> *"A body with the checksum of the newest version replays: the route answers **200** with that
> version and writes nothing, so a retry after a dropped answer mints no phantom version."*
> (`files.py:776-779`)

`GET /files/{file_id}/versions` (`:886-911`) serves the whole chain, oldest first, deleted
versions included.

**So the stable id the user asks for already has a name: `version_group`.** It is the root file's
id, every version carries it, and it survives re-uploads of the same logical trace.

### 5.2 What is actually missing — three things, none of them a new concept

**(a) The ingestion path never mints a version.** `tm-connector` registers through `POST /files`
only. The files collection's idempotency key is `(run_id, checksum_sha256)`, unique and partial
on `status: "registered"` (`api/api/db.py:91-95`), so re-posting *identical* bytes for a run
folds into the one document — but a **corrected** trace for the same run has different bytes and
therefore becomes a *second sibling document*, not version 2 of the first. The run then shows two
files and nothing says one supersedes the other.

The fix is a decision in the connector, not a route in the API. `mf4-to-blob` writes
`<root>/<run_id>/<filename>` and the run key now leads the MF4 filename (`c0c0d4f`), so
`(run_id, filename)` is the logical key of a trace. **When the run already holds an active
registered file with the same `filename`, the connector posts to
`POST /files/{that file_id}/versions`; otherwise to `POST /files`.** Zero new API code. The
replay rule quoted above makes a redelivery of identical bytes a 200 that writes nothing, so the
change is idempotent by construction.

**(b) `version_group` is not on the wire.** `FileBody` exposes `version` (`models/files.py:100`)
and `FileDetail` exposes `supersedes` (`:116`); neither exposes the chain id. A list cannot say
"these five rows are one trace at v1..v5" without it. **One new response field:**

```python
    # The chain this file belongs to. A document without the stored key is the
    # root of its own chain (`routers/files.py:_version_group`).
    version_group: str
```

on `FileBody`, filled by the existing `_version_group` rule at read time. No stored field, no
migration.

**(c) Nothing surfaces it.** The files table and the run-detail files panel show neither the
version nor the chain. A `v2 of 3` cell linking to `GET /files/{file_id}/versions` is the whole
UI.

### 5.3 What this is *not*

It is not a new id, not a new collection, and not a per-run version counter. A version chain
belongs to a *file*, and a file already belongs to a run; a chain that spanned runs would
contradict `POST /files/{file_id}/versions`'s own rule that *"a version of a run's file belongs
to that run"* (`models/files.py:192`).

---

## 6. What it does to Covered ≠ Tested

### 6.1 Today's answer, traced

`_state_fold` (`api/api/services/queries_requirements.py:173-221`) folds **one** value per
requirement. For each covering definition it takes `_newest_verdict_of_td`, which walks that
definition's runs newest-first (`first_data_at DESC`, `:110-124`) and returns the first run
carrying a verdict. With TC-001 passing on the older build and failing on the newer:

- `_newest_verdict_of_td("BAT-SYS-TC-001")` returns the **newer** run and its `fail` verdict;
- `any_fail = True`;
- `{"verification_state": "failed", "evidence_stale": False, "tested_at": None}` (`:211-212`).

`BAT-SYS-PRF-001` reads **`failed`**, and the older build's pass is not merely deprioritised — it
is unreachable. `covering_run_ids` lists both runs, but no field says which build either belongs
to.

### 6.2 The change: the build partitions the evidence, it does not flag it

**`_state_fold` runs once per distinct `sw_version` among the covering runs, over that version's
runs only.** Three consequences:

1. **A new derived field on the requirement:** `verification_state_by_sw: dict[str, str]` — one
   entry per build the covering runs hold, keyed by the build label, valued with the existing
   `VerificationState` literal (`api/api/models/requirements.py:18`). A run with no
   `sw_version` folds under the `null` key, which is where all four existing runs sit, which is
   why §7 is a no-op deploy.
2. **The scalar `verification_state` stays, and names the build it is about.** It is required by
   `RequirementRow` (`:53`), bucketed by `RequirementViewCounts` (`:64-72`) and filtered by
   `GET /requirements?state=`. It is computed for **one** build, and a second required field
   **`verification_sw_version: str | None`** says which. Never a union, never a silent pick.
3. **Which build the scalar is about** is chosen in one of two ways:
   - `GET /requirements?sw_version=<label>` — stated by the caller; every derived field folds
     over that build's runs only.
   - No parameter — the newest build, where "newest" is *the `sw_version` of the newest covering
     run by `first_data_at`*. That reproduces today's behaviour exactly when every run shares one
     build, so the deploy changes nothing, and it is the right default: a requirement is verified
     against the build you are shipping, and an old build's failure is history.

   Guessing newest is what broke §6.1 — but it is only wrong when the answer is *unlabelled*.
   Labelled by `verification_sw_version`, it is a statement a person can check and override.

`RequirementEvidence` (`api/api/models/requirements.py:95-110`) gains **`sw_version: str | None`**
beside `run_id`, so the detail's evidence table shows every build's row at once — which is the
screen the user is actually asking for.

**`Verdict` gains nothing** (`api/api/models/results.py:84-98`). `processed_results.run_id`
already names the run and the run names the build. A copy on the verdict could disagree with the
run it came from, and there is no third party to break the tie.

### 6.3 How it composes with BL-33 and BL-19

A `tested` claim needs three pins, and they are of different kinds:

| # | Pin | Owner | Failure mode |
|---|---|---|---|
| 1 | A **confirmed** verifies-link at `(R@v, TC@w)` | BL-33 (`dev-planning/review-page/`) | link goes **suspect** → evidence is *doubtful* |
| 2 | A pass produced by TC at exactly version `w` | BL-19 / BL-34 — today approximated by `implementation_sha256 == definition.implementation.sha256` (`queries_requirements.py:196-199`) | `evidence_stale: true` → evidence is *out of date* |
| 3 | That pass produced from a run whose `sw_version` is the one asserted | **this spec** | evidence is *about a different thing* |

1 and 2 are **staleness**: the evidence is still about this build, it has just stopped being
trustworthy, and the estate already models that as one boolean (`evidence_stale`,
`models/requirements.py:54`). 3 is **not** staleness — a 1.4 pass is perfectly valid evidence,
about 1.4. That is exactly why it becomes a *partition* of the fold and not a third boolean.

**BL-33's link preimage is untouched.** `link_id = link_type|from_id|to_id` stays: a verifies-link
joins a requirement to a test case, and neither of those is a build. The build qualifies the
*run* that produced the pass, which sits on the other side of the link. Adding `sw_version` to
the preimage would mint a new link per build and make every campaign's links suspect on day one.

`verified_by` stays derived from `covers_req_ids` (BP5 / D1) and is untouched by any of this: a
test case verifies a requirement in every build, and `_fold_inputs` (`:95-108`) needs no change.

---

## 7. Migration

The environment holds 1 work order, 10 definitions, 4 runs, 5 files and live lake rows in
`battery_data_v1` partitioned `platform/work_order/run_id`.

| Artefact | On deploy | Afterwards |
|---|---|---|
| **1 work order** (`WO-BAT-2026-001`) | Gains nothing. `sw_version` absent → reads null. | `python -m seed all` re-posts `POST /planning/sync`; `_mirror_work_orders` (`planning_sync.py:352-363`) writes whatever the seed states. §9 OQ3 on the value. |
| **10 definitions** | Read `orphaned: true` until the seed runs — they hold `work_order_id` and no `work_order_ids`. | The re-seed writes `work_order_ids: ["WO-BAT-2026-001"]`. `_write_mirror` uses `$set` (`planning_sync.py:306-316`), so the dead `work_order_id` key lingers on the document. It is inert — no reader remains. **No cleanup script.** |
| **4 runs** (`TAS-1001..1004`) | Gain nothing. `sw_version` absent → reads null, folds under the null bucket, every screen identical. | `PATCH /test-runs/{id}` with the new `RunPatchRequest.sw_version`, one call each, `manual`-tagged. **Do not re-ingest**: regenerating the MF4s changes their sha256 and the decoder dedups on it, so a re-ingest means new route timestamps and a second decode of the same recording for a field a PATCH writes in one line. |
| **5 files** | Untouched. `version_group` on the wire is computed at read time by the existing `_version_group` rule (`files.py:718-725`), which answers a document's own id when the key is absent. Zero writes to the collection. | The next re-upload of a trace goes through `POST /files/{id}/versions` (§5.2a) and becomes v2. |
| **Lake rows** | **Untouched. The partition spec does not change.** | — |

### 7.1 The lake: why `sw_version` is not a partition level

`HIVE_COLUMNS` is `platform,work_order,run_id,~channel_name,~sender_node,~frame_name,~signal`
(`quix.yaml:76`), and its own description states the cost:

> *"Changing it needs a NEW LAKE_TABLE and a new CONSUMER_GROUP — the sink validates an existing
> table's partition spec at setup() and refuses a mismatch."*

That is a **re-sink**, not a migration: a new table, a bumped `CONSUMER_GROUP`, and
`AUTO_OFFSET_RESET=earliest` replaying every stored batch. It buys nothing here. `run_id` is
already the finest session key, one run has exactly one `sw_version`, and the Test Manager holds
the run → `sw_version` map. "Every row recorded on build X" resolves run ids in Mongo first and
then reads those partitions — the same two-step `TM_LAKE_SESSION_PARTITIONS` already assumes
(`quix.yaml:240-242`).

The second partition level is also safe: `work_order` comes from
`metadata.get("work_order") or declared.get("work_order_id")`
(`mf4-decoder/main.py:835-839`), and a **run** still belongs to exactly one work order. Only a
*definition* becomes multi-valued, and no partition level names a definition — `test_definition`
left that tree already (`quix.yaml:80`).

### 7.2 Order of operations

1. Deploy `api/` (models, queries, routes) and `tm-connector`. Every screen reads as before.
2. `python -m seed all` from `battery-trace-gen/` — rewrites the work order and the ten
   definitions with the new shapes and re-uploads the ten implementations into their new blob
   folders.
3. `PATCH` the four runs with their `sw_version`, if one is chosen (§9 OQ3).
4. The second campaign is a normal seed: a second `work_orders[]` entry with its own
   `sw_version`, the same ten `test_definitions[]` with both ids in `work_order_ids`, and new
   traces whose HD comments carry `test.work_order` and `test.sw_version`.

---

## 8. Files touched

### `api/` — models
- `api/api/models/planning.py` — `TestDefinitionRow.work_order_ids`; `TestDefinitionDetail.work_orders`; `PushedDefinition.work_order_ids`; `PushedWorkOrder.sw_version`; `WorkOrderRow.sw_version`; `WorkOrderDetail.sw_version`; `WorkOrderRun.work_order_id` + `.sw_version`.
- `api/api/models/runs.py` — `RunListItem.sw_version`; `RunUpsertRequest.sw_version`; `RunPatchRequest.sw_version`; `RunFacets.sw_versions`.
- `api/api/models/requirements.py` — `RequirementRow.verification_state_by_sw` + `.verification_sw_version`; `RequirementEvidence.sw_version`.
- `api/api/models/files.py` — `FileBody.version_group`.

### `api/` — services and routers
- `api/api/services/queries_runs.py` — `orphan_clause`, `_derived_definitions`, `_definition_matches`, `test_definition_facets`, `get_test_definition_detail`, `list_work_orders`, `get_work_order_detail`, `delete_work_order`; **delete** `latest_run_id_for_definition`.
- `api/api/services/queries_requirements.py` — `_fold_inputs` buckets runs by `sw_version`; `_state_fold` runs per bucket; `_project` emits the map, the scalar and `verification_sw_version`.
- `api/api/services/file_writes.py` — `implementation_blob_key(td_id, …)` and an `IMPLEMENTATION_FOLDER` constant beside `REQUIREMENTS_FOLDER`.
- `api/api/planning_sync.py` — `_mirror_definitions` writes the list; `_mirror_work_orders` writes `sw_version`; **delete** the definition→work-order rungs at `:603-621` and `:694-700`.
- `api/api/routers/test_definitions.py` — the implementation upload drops the run lookup.
- `api/api/routers/requirements.py` — the `sw_version` query parameter.
- `api/api/routers/files.py` — nothing; `_version_group` is already the rule the new wire field uses.
- `api/api/db.py` — `test_definitions.work_order_ids` index; `test_runs.sw_version` index.
- `api/docs/openapi.v1.json` — regenerate (`api/scripts/snapshot.sh`). Already red under **BL-25**.
- `api/seed/fixtures.py`, `api/seed/filler.py`, `api/seed/seed_demo.py`, `api/mock_planning/fixture.json`, `api/mock_planning/demo_admin.py`, `api/tests/factories_planning.py` — the new shapes.

### `tm-connector/`
- `connector/identity.py` — `HEADER_RUN_FIELDS["test.sw_version"]`, `DECLARED_FIELDS`, `CONTEXT_FIELDS`.
- The file-registration path — choose `POST /files/{id}/versions` over `POST /files` on `(run_id, filename)` (§5.2a).

### `battery-trace-gen/`
- `bus/mf4.py` — `_test_props` keys tuple.
- `scenarios/_identity.json` — `test.sw_version`.
- `seed/planning_payload.py` — `work_orders()` states `sw_version`; `test_definitions()` states `work_order_ids`.

### `frontend/`
- `components/screens/definitions/definitions-columns.tsx`, `definition-detail-screen.tsx`, `definitions-filters-popover.tsx`, `definitions-active-pills.ts` — multi-value work order.
- The run detail / runs table — the `sw_version` cell and filter.
- The requirement detail — the per-build state strip and the `sw_version` column on the evidence table.
- The files table and the run-detail files panel — the `v2 of 3` cell.

### `dev-planning/`
- `backlog.json` — new items; **BL-19** and **BL-33** gain notes pointing here.

### Not touched
`quix.yaml` (no `HIVE_COLUMNS`, `LAKE_TABLE` or `CONSUMER_GROUP` change), `mf4-decoder/`,
`mf4-to-blob/`, the lake table.

---

## 9. Open questions

**OQ1 — `planned_runs` per campaign or in total?**
*Recommended: per campaign.* The work-order detail already counts actual runs per campaign
(`queries_runs.py:1813-1816`) and needs no change. Accept that the definitions **list** row's
`status` is a cross-campaign approximation that can read `on_plan` when one campaign has over-run
and another has no data; fix it when **BL-28** gives the work order its own scope.

**OQ2 — is `work_orders.sw_version` required?**
*Recommended: no, nullable.* Required would refuse the existing work order and every campaign
created before a build number is known, and it would force an invented value in §7.

**OQ3 — what `sw_version` do `WO-BAT-2026-001` and `TAS-1001..1004` get?**
*Recommended: null, for now.* The four traces were produced by a generator that states no DUT
build, and there is no such number anywhere in `battery-trace-gen/` to read one from
(`bench_sw: "battery-trace-gen 0.1.0"` is the *generator's* version, not the battery
controller's). The person creating the second campaign picks both labels then, and PATCHes the
four. Any label used in this document is illustration, not a value to write.

**OQ4 — does the requirement's scalar `verification_state` default to the newest build, or refuse
to answer without one?**
*Recommended: the newest, always accompanied by `verification_sw_version`.* Refusing would break
`RequirementViewCounts` and `GET /requirements?state=`, both of which need one value per row.
A labelled default is checkable; an unlabelled one is what §6.1 is.

**OQ5 — does the definition detail's run list group by campaign?**
*Recommended: yes*, which is why `WorkOrderRun` gains `work_order_id` and `sw_version` (§3.5).
Without it the shared definition's most important screen is an undifferentiated list.

**OQ6 — what does `delete_work_order` do to a shared definition?**
*Recommended: pull the work-order id from every definition's `work_order_ids`, and delete only
the definitions left with an empty list.* Never delete a definition another campaign still names.
The existing 409 `work_order_has_runs` guard is unchanged.

**OQ7 — when does `work_order_ids` become a join collection?**
*Recommended: the first time the pair carries data of its own* — a per-campaign `planned_runs`, a
per-campaign implementation, or a per-campaign definition status. Until then the list is the
whole truth and a collection would store nothing but two foreign keys.

**OQ8 — does `GET /requirements?sw_version=` narrow `view_counts` too?**
*Recommended: yes.* The counts are computed over the already-projected rows
(`queries_requirements._view_counts`, `:253-264`), so they follow the fold for free, and a header
count that disagreed with the table under it would be a bug on its face.

**OQ9 — does BL-33's confirmed-link preimage gain `sw_version`?**
*Recommended: no.* §6.3. A link joins a requirement to a test case; a build qualifies a run.

**OQ10 — does `tm-connector` need to *refuse* a version post when the run's existing file has a
different `source_system` or format?**
*Recommended: no.* The pipeline guarantees one producer per run, and `POST /files/{id}/versions`
already refuses a non-active head and a duplicate checksum. A further check would be a validation
layer defending against input the contract says never arrives.

---

## 10. References

- `CLAUDE.md` § "Seeding the Test Manager" — the work order / test run / test definition hierarchy the user defined, 2026-09-22.
- `CLAUDE.md` § "Requirements workflow (ASPICE SYS.2 — the Miro board)" — Covered ≠ Tested, the suspect-link rule, BP5.
- `dev-planning/requirement-status-from-runs/spec.md` §4.3, §4.6, §5.3 — the projection this spec partitions.
- `dev-planning/authoring-controls/spec.md` §6, §12 — `item_version` / `content_sha256` / `no_op_mint`, shipped on requirements.
- `dev-planning/review-page/spec.md` — BL-33's link model.
- `dev-planning/run-a-definition/spec.md` — the verdict writer. Unaffected; §1.6.
- `dev-planning/tm-multi-definition-runs/spec.md:426`, `architecture.md:237` — the pre-`ad77ab2` `implementation_blob_key(td_id, …)` signature §4.2 reverts to.
- Backlog: **BL-19**, **BL-24**, **BL-25**, **BL-28**, **BL-33**, **BL-34**, **BL-39**, **BL-47**.

---

## Appendix A — shapes before and after

### A test definition (`test_definitions`, wire view of `TestDefinitionDetail`)

Before:
```json
{
  "td_id": "BAT-SYS-TC-001",
  "title": "DC charging current held at or below I_current_Chr_Max",
  "work_order_id": "WO-BAT-2026-001",
  "work_order": { "wo_id": "WO-BAT-2026-001", "title": "Battery DC system qualification — BATTERY_DC_V1", "project": "Porsche Taycan", "status": "active" },
  "planned_runs": 1,
  "actual_runs": 1,
  "status": "on_plan",
  "orphaned": false,
  "covers_req_ids": ["BAT-SYS-PRF-001"],
  "runs": [ { "run_id": "TAS-1001", "definition_ids": ["BAT-SYS-TC-001"], "rig_id": "battery-sim-01", "..." : "..." } ],
  "implementation": { "blob_path": "blob://<ws>/jama_ui/TAS-1001/1f3c9ab0-BAT-SYS-TC-001.py", "sha256": "1f3c9ab0…", "...": "..." }
}
```

After:
```json
{
  "td_id": "BAT-SYS-TC-001",
  "title": "DC charging current held at or below I_current_Chr_Max",
  "work_order_ids": ["WO-BAT-2026-001", "WO-BAT-2026-002"],
  "work_orders": [
    { "wo_id": "WO-BAT-2026-001", "title": "Battery DC qualification — build A", "project": "Porsche Taycan", "status": "closed" },
    { "wo_id": "WO-BAT-2026-002", "title": "Battery DC qualification — build B", "project": "Porsche Taycan", "status": "active" }
  ],
  "planned_runs": 1,
  "actual_runs": 2,
  "status": "on_plan",
  "orphaned": false,
  "covers_req_ids": ["BAT-SYS-PRF-001"],
  "runs": [
    { "run_id": "TAS-2001", "work_order_id": "WO-BAT-2026-002", "sw_version": "<build B>", "definition_ids": ["BAT-SYS-TC-001"], "...": "..." },
    { "run_id": "TAS-1001", "work_order_id": "WO-BAT-2026-001", "sw_version": "<build A>", "definition_ids": ["BAT-SYS-TC-001"], "...": "..." }
  ],
  "implementation": { "blob_path": "blob://<ws>/test-manager/implementations/BAT-SYS-TC-001/1f3c9ab0-BAT-SYS-TC-001.py", "sha256": "1f3c9ab0…", "...": "..." }
}
```

Changed: `work_order_id` → `work_order_ids`; `work_order` → `work_orders`; each run row carries
its campaign and its build; the implementation key no longer names a run. `planned_runs` now
reads *per campaign*.

### A test run (`test_runs`, wire view of `RunDetail`)

Before:
```json
{
  "run_id": "TAS-1001",
  "work_order_id": "WO-BAT-2026-001",
  "definition_ids": ["BAT-SYS-TC-001", "BAT-SYS-TC-002", "BAT-SYS-TC-003"],
  "rig_id": "battery-sim-01",
  "bench_sw": "battery-trace-gen 0.1.0",
  "lake_table": "battery_data_v1",
  "status": "complete"
}
```

After:
```json
{
  "run_id": "TAS-1001",
  "work_order_id": "WO-BAT-2026-001",
  "definition_ids": ["BAT-SYS-TC-001", "BAT-SYS-TC-002", "BAT-SYS-TC-003"],
  "rig_id": "battery-sim-01",
  "bench_sw": "battery-trace-gen 0.1.0",
  "sw_version": "<build A>",
  "lake_table": "battery_data_v1",
  "status": "complete"
}
```

One added field, defaulted null. `bench_sw` is the bench's software; `sw_version` is the system
under test's. The four existing runs read `"sw_version": null` on deploy.

### A work order (`work_orders`, wire view of `WorkOrderDetail`)

Before:
```json
{
  "wo_id": "WO-BAT-2026-001",
  "title": "Battery DC system qualification — BATTERY_DC_V1",
  "project": "Porsche Taycan",
  "status": "active",
  "requestor": "ludvik@quix.io",
  "definitions": [ { "td_id": "BAT-SYS-TC-001", "planned_runs": 1, "actual_runs": 1, "status": "on_plan" } ],
  "runs": [ { "run_id": "TAS-1001", "...": "..." } ]
}
```

After:
```json
{
  "wo_id": "WO-BAT-2026-001",
  "title": "Battery DC system qualification — BATTERY_DC_V1",
  "project": "Porsche Taycan",
  "status": "active",
  "sw_version": "<build A>",
  "requestor": "ludvik@quix.io",
  "definitions": [ { "td_id": "BAT-SYS-TC-001", "planned_runs": 1, "actual_runs": 1, "status": "on_plan" } ],
  "runs": [ { "run_id": "TAS-1001", "work_order_id": "WO-BAT-2026-001", "sw_version": "<build A>", "...": "..." } ]
}
```

One added field on the campaign (its *intent*), plus the two fields `WorkOrderRun` gains. The
`definitions[]` rollup is unchanged — it was already computed per campaign.

---

## Appendix B — the worked answer

> **TC-001 passes on build A and fails on build B. What does `BAT-SYS-PRF-001` read?**

**Today:** `verification_state: "failed"`, `tested_at: null`, `covering_run_ids: ["TAS-2001",
"TAS-1001"]`. `_newest_verdict_of_td` returns the newer run's `fail`, `any_fail` short-circuits
at `queries_requirements.py:211`, and the build-A pass is unreachable from the API.

**After:**

```json
{
  "req_id": "BAT-SYS-PRF-001",
  "verification_state": "failed",
  "verification_sw_version": "<build B>",
  "verification_state_by_sw": { "<build A>": "tested", "<build B>": "failed" },
  "evidence_stale": false,
  "verified_by": ["BAT-SYS-TC-001"],
  "covering_run_ids": ["TAS-2001", "TAS-1001"],
  "tested_at": null,
  "evidence": [
    { "run_id": "TAS-2001", "sw_version": "<build B>", "definition_id": "BAT-SYS-TC-001", "outcome": "fail", "current": true,  "...": "..." },
    { "run_id": "TAS-1001", "sw_version": "<build A>", "definition_id": "BAT-SYS-TC-001", "outcome": "pass", "current": true,  "...": "..." }
  ]
}
```

and `GET /requirements/BAT-SYS-PRF-001?sw_version=<build A>` reads:

```json
{
  "req_id": "BAT-SYS-PRF-001",
  "verification_state": "tested",
  "verification_sw_version": "<build A>",
  "verification_state_by_sw": { "<build A>": "tested", "<build B>": "failed" },
  "tested_at": "<the build-A verdict's produced_at>",
  "covering_run_ids": ["TAS-1001"]
}
```

The headline scalar still reads `failed`, and that is correct: the build being shipped fails this
requirement. What changes is that **"failed" becomes sayable as "failed *on build B*"**, the
build-A pass is first-class evidence rather than an invisible row, and `verified_by` is still
derived from `covers_req_ids` and never authored.
