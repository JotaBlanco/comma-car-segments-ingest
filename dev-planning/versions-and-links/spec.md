# File versions for humans, and the link store that records both ends' versions

**Status:** Draft
**Project:** comma-car-segments-ingest
**Branch / HEAD:** `jama-ui-dev` @ `5feae2f`
**Created:** 2026-09-24
**Planned with:** Buddy

The user's sentence, verbatim:

> *"now the test files will be distinquished by work order, but there can be more files for one
> work order, e.g. you need to rerun the test due to some issue. So this files needs to have hash
> but for human, just made v1 ...v3 .. vn. also we need that links database somewhere, there must
> be also this versions involved"*

Three asks, and they are **not** one feature — that is the first finding.

| Ask | Where it lands | Depends on |
|---|---|---|
| A re-run's trace becomes **v2**, not a second unrelated file | §1–§3, the ingest path | nothing |
| The **link store**, with the version of every end | §4–§5, a new collection | **BL-34's TC half** (hard) |
| "there must be also this versions involved" | §6 — and the answer is that the **file** version does *not* touch the link | — |

The file half ships alone. The link half cannot, and §8 says why.

---

## 1. What a file version means here

### 1.1 The user's case is a re-run

*"you need to rerun the test due to some issue."* The bench executes `BAT-SYS-TC-001` again
under run `TAS-1001`, the plant produces a corrected recording, and a second
`TAS-1001_T1_charge_thermal.mf4` is uploaded. Today that becomes a **second, unrelated file
document**: different bytes ⇒ different checksum ⇒ the `(run_id, checksum_sha256)` idempotency
key (`api/api/db.py:91-95`) does not match, so `register_file_document` mints a fresh
`f-<uuid>` and the run's Files tab shows two rows with nothing saying one replaced the other.

### 1.2 The identity of "the same logical file" is `(run_id, filename)`

**Chosen: a file is the same logical file as another when it names the same `run_id` and the
same `filename`, and both are `status: "registered"`, `lifecycle: "active"`.**

Three facts make this hold in this estate and not by wishful thinking:

1. **The filename carries the run key and the scenario, and nothing else.**
   `battery-trace-gen/scenario.py:113` — `f"{run_key}_{self.path.stem}.mf4"` — so T1's trace is
   `TAS-1001_T1_charge_thermal.mf4` on every regeneration. No timestamp, no digest, no counter.
   A re-run produces the same name by construction.
2. **The blob collision suffix never reaches the filename.** `mf4-to-blob` defaults
   `collision_policy=suffix` (`mf4-to-blob/main.py:63`) and
   `blob.resolve_blob_path` returns `f"{folder}/{stem}-{suffix}{ext}"` with
   `uuid.uuid4().hex[:8]` (`mf4-to-blob/blob.py:100-101`). That suffix lands on the **blob
   path only**: `state.init(upload_id, req.filename, req.size)` stores the *original* name and
   the metadata message carries it (`main.py:251, :287, :414`), the decoder reads
   `filename = metadata.get("filename")` (`mf4-decoder/main.py:733`) and puts it on the marker
   (`marker.py:54`), and the connector reads it back off the marker
   (`tm-connector/connector/connector.py:155`) into the `POST /files` body
   (`bodies.py:136`). So the **stored filename is stable across re-uploads while the stored
   object is not** — which is exactly the pair a version chain needs: a stable label over
   distinct bytes.
3. **A run is already the finest session key we have.** It belongs to exactly one work order
   (`test_runs.work_order_id`), and `dev-planning/tc-across-sw-versions/spec.md:449-452` states
   the rule a chain must not break: *"a version of a run's file belongs to that run"*
   (`api/api/models/files.py:192`).

### 1.3 Why not the two alternatives

**Not `(work_order, definition, run)`.** A definition is about to become multi-valued on the
work-order axis (`dev-planning/tc-across-sw-versions/spec.md` §3.1,
`work_order_ids: list[str]`), and a run carries `definition_ids: list[str]` — several
definitions per trace. A key built from a set is not a key. Worse, the work order is derivable
from the run, so naming it in the identity stores the same fact twice and invites the two copies
to disagree after a `PATCH /test-runs/{id}`.

**Not an operator-stated identity** (a `version_group` or `supersedes` field on the upload form).
The person re-running a test states nothing new — they upload the same test's output again. Asking
them to name the chain moves a decision the data already answers onto a human who will sometimes
get it wrong, and creates a second way to be wrong (naming the *other* trace's chain) that the
derived rule cannot produce. The human path that *does* need an explicit statement already exists
and stays: `POST /files/{file_id}/versions` (§3.4).

### 1.4 What happens when a genuinely different trace is uploaded to the same run

Two cases, and only one of them is interesting.

- **A different trace with a different name** — `TAS-1001_T2_discharge_sweep.mf4` posted under
  `TAS-1001`. The filename differs, so the lookup finds no head and the file is the **root of its
  own chain**. The run shows two traces, each at v1. This is the common case and it is correct.
- **A different trace under the same name** — someone renames T2's output to
  `TAS-1001_T1_charge_thermal.mf4` and uploads it to `TAS-1001`. It becomes **v2 of T1's chain.**

That second outcome is accepted, not guarded. The operator stated two things — this run, this
filename — and the registry believes both. Detecting "these bytes are a different experiment"
means comparing signal inventories or time windows and refusing on a threshold, which is a
data-validation layer defending against input the operator owns. The standing rule refuses that.
The recovery is ordinary and already built: `PATCH /files/{file_id}` re-links a file to another
run, and `DELETE /files/{file_id}` is a soft delete that keeps every byte
(`api/api/routers/files.py:477-515`).

---

## 2. v1…vn for humans, sha256 for machines

### 2.1 The version number is not new and is not computed here

Every field the label needs already exists and has since 20 Aug 2026:

| Fact | Where |
|---|---|
| `version: int = 1`, *"the first upload is version 1, and a stored document without the field is version 1 too"* | `api/api/models/files.py:98-100` |
| `supersedes: str \| None` — the previous version's file id | `api/api/models/files.py:114-116` |
| The chain id | `api/api/routers/files.py:718-725` — `_version_group(file_doc)` returns `file_doc.get("version_group") or file_doc["_id"]`; *"A document without `version_group` is the root of its own chain."* |
| The chain query | `api/api/routers/files.py:728-730` — `_group_query` |
| Uniqueness of `(chain, number)`, and the race settlement | `api/api/db.py:115-119`, partial on `{"version_group": {"$exists": True}}` |
| The whole chain, oldest first, deleted versions included | `GET /files/{file_id}/versions`, `api/api/routers/files.py:886-911` |

**Nothing in this spec computes a version number.** §3 makes a second writer reach the machinery
that already computes it.

### 2.2 The sha256 stays the identity that matters

The version is a **label over a chain**; the digest is what every machine reads. Concretely, and
unchanged by this spec:

- The registry's idempotency key is `(run_id, checksum_sha256)` (`api/api/db.py:91-95`).
- The decoder's decode-once key is the sha256 of the **content**
  (`mf4-decoder/idempotency.py:12-19`).
- A verdict pins the implementation by digest, never by version
  (`api/api/models/results.py:96-98`).
- A reviewer's decision pins `implementation.sha256` (`dev-planning/review-page/spec.md` §5.2).

`v3` is never an argument to a query. It is a word on a screen.

### 2.3 On the wire: one field

`FileBody` already exposes `version` (`api/api/models/files.py:100`) and `FileDetail` exposes
`supersedes` (`:114-116`). Neither exposes the chain id, so a list cannot say *these rows are one
trace*. **One added response field**, already proposed by the sibling spec
(`dev-planning/tc-across-sw-versions/spec.md` §5.2b) and adopted here unchanged:

```python
    # The chain this file belongs to. A document without the stored key is the
    # root of its own chain (`routers/files.py:_version_group`).
    version_group: str
```

**Filled by a before-validator on `FileBody`, not by any query.** The model already carries this
exact pattern one file over — `WorkOrderRun._primary_definition`
(`api/api/models/planning.py:113-116`) derives `definition_id` from `definition_ids` in a
`@model_validator(mode="before")`. The file version of it reads `data.get("version_group") or
data.get("_id")`, which is `_version_group`'s rule verbatim. No stored field, no migration, and —
the reason it matters — **no change to any of the projections that return raw Mongo documents**
(`register_file_version` returns `doc`, `list_file_versions` returns raw rows,
`queries_signals.get_file_detail` builds its own).

**`vN of M` does not go on the wire.** `M` is a per-chain count, and a `/files` page can split a
chain across page boundaries, so serving it costs one extra bounded `$group` per page. The cell
renders `v3` from `version` and links to `GET /files/{file_id}/versions` for the rest. §9 OQ3
holds the upgrade if the user wants "of 3" in the table.

### 2.4 What a person sees

| Surface | Cell |
|---|---|
| `/files` table | a `Version` column: `v1`, `v2`, `v3`. Every version is its own row (§9 OQ4). For `version > 1` the cell links to the versions drawer. |
| Run detail → Files panel | the same column. All of a run's versions are on one screen here, so the chain reads top to bottom without a drawer. |
| File detail | `Version 3`, `Supersedes f-…` (already modelled, `FileDetail.supersedes`), and a **Versions** list from `GET /files/{file_id}/versions`. |

Frontend files: the files table columns, the run-detail files panel, the file detail panel. No new
component — the estate's `ToneBadge` / column-hiding pattern carries it.

---

## 3. The re-upload path

### 3.1 The registry decides, at registration

**Chosen: `register_file_document` joins a chain. `POST /files` is unchanged on the wire, the
connector is unchanged, and `mf4-to-blob` and `mf4-decoder` are unchanged.**

The rule, stated once, placed **after** the existing replay lookup and **after** the quarantine
order computes `status` (`api/api/routers/files.py:1226-1244`):

> When the computed status is `registered`, look for the newest active registered file on the
> same `run_id` with the same `filename`. If one exists, the new document joins its chain:
> `version_group = _version_group(head)`, `version = _version_of(head) + 1`,
> `supersedes = head["_id"]` — the same three keys `POST /files/{file_id}/versions` already
> passes through `extra` (`api/api/routers/files.py:844-848`). If none exists, the document is
> the root of its own chain and nothing is written that is not written today.

The lookup carries its own filters (`status: "registered"`, `lifecycle` active, sorted by
`version` descending — `_latest_version`'s query, `files.py:738-745`), so a deleted or archived
head is simply not found and the new file starts fresh. That is one query, not a branch.

A lost race re-raises `DuplicateKeyError` on the `(version_group, version)` index; `_is_version_race`
already tells that index from the checksum index (`files.py:748-755`) and `VERSION_RETRIES = 5`
already bounds the retry (`:712-715`). The version route's loop is the model; the registration path
gets the same loop, not a second policy.

### 3.2 Why not the connector

`dev-planning/tc-across-sw-versions/spec.md` §5.2(a) put this decision in `tm-connector`:
*"When the run already holds an active registered file with the same `filename`, the connector
posts to `POST /files/{that file_id}/versions`; otherwise to `POST /files`. Zero new API code."*
**This spec overrides that paragraph.** Four reasons, in order of weight:

1. **The race produces two roots.** Two `file_complete` markers for one run and filename arriving
   together both GET "no head", both `POST /files`, and two independent chains are born — silently,
   because neither call fails. Registry-side, the unique `(version_group, version)` index makes the
   loser's insert fail and the retry reads the winner. The index that already exists is the only
   thing that settles this, and only the registry is behind it.
2. **"Zero new API code" is not zero code.** `Registry` has `_post` and three POST methods and no
   GET at all (`tm-connector/connector/registry.py:88-146`). The connector would gain a GET
   method, a route dependency, two extra round-trips per file, and its own share of the retry
   budget (`_post`'s six-attempt backoff) for a call whose failure mode is "silently start a new
   chain".
3. **The journal would claim a person did it.** `POST /files/{file_id}/versions` writes
   `file.version_registered` with `Source.MANUAL` because *"A person uploaded it, so the source
   is `manual`"* (`files.py:867-882`), and `FileVersionRegisterRequest.actor` is required for the
   same reason (`models/files.py:182-193`). A pipeline write down that route puts a false claim in
   the audit trail. (It does **not** poison `field_sources`: `register_file_document` stamps every
   embedded field `Source.EMBEDDED` regardless of route, `files.py:1281-1287`. The lie is confined
   to the journal — which is still the one place it must not be.)
4. **File identity is already the registry's, in one function.** `(run, checksum)` replay,
   `storage_ref` replay, the quarantine order and the never-drop rule all live in
   `register_file_document` (`files.py:1191-1337`), which is *"The one registration path … a second
   path would let them disagree about quarantine, the journal or the rollups."* `(run, filename)`
   is the same kind of fact and belongs in the same function.

**Not MF4 Import.** `mf4-to-blob` never talks to the Test Manager API — it writes blob and
produces `mf4_metadata`. It has no run registry to consult and would have to grow one.

### 3.3 Identical bytes re-uploaded

Two independent guards fire, and the outer one fires first.

1. **The decoder skips the file entirely.** Its dedup key is `sha256:<hex>` of the content
   (`mf4-decoder/idempotency.py:12-19`), and a marked file never re-enters `process()`. So **no
   `file_complete` marker is produced, the connector is never called, and no file document and no
   journal entry are written.** Nothing changes in the Test Manager.
2. If the marker were produced anyway (a replayed delivery, which the decoder tolerates by design
   — *"Producing it twice is harmless … the registry identifies a file by (run, checksum) and
   answers the second one as a replay"*, `mf4-decoder/main.py:1021-1025`), the registry's
   `_existing_registered` replay lookup (`files.py:1043-1058`) returns the stored document with
   200 and writes nothing. It runs **before** §3.1's chain lookup, so identical bytes can never
   mint a phantom v2.

**What the person sees:** the upload succeeds, a new object appears in blob under a
uuid-suffixed name, and the Files tab does not change. That is a real and confusing gap, and this
spec does not close it — closing it means the decoder reporting a skip, which is a pipeline
change with its own blast radius. §9 OQ5 records it with a recommendation.

CLAUDE.md's standing workaround is unchanged and still correct: *"change the route timestamp to
re-ingest."*

### 3.4 `POST /files/{file_id}/versions` stays, unchanged

It is the **human** path: a person who has a corrected file in hand and wants it filed under a
named chain. It keeps its required `actor`, its `manual` journal tag, its `note`, its non-active
head refusal and its checksum replay. §3.1 does not replace it and does not call it — both reach
`register_file_document`, which is the point.

---

## 4. The link store

### 4.1 What a link is, and what it is not — the D1 line

Two claims about the same pair, and conflating them is the Miro board's defect **D1**:

| Claim | Where it lives | Who states it |
|---|---|---|
| *"`BAT-SYS-TC-001` covers `BAT-SYS-PRF-001`"* | `test_definitions.covers_req_ids` — authored, mirrored by planning. `verified_by` is its read-time inverse and is **never stored** (`api/api/services/queries_requirements.py:101-108`). | the test case's author |
| *"a named person, at a named moment, judged that `BAT-SYS-TC-001` **at version w** verifies `BAT-SYS-PRF-001` **at version v**"* | the new collection | a reviewer |

The first makes a requirement **covered**. The second is a signature, and it is what makes
**tested** reachable (BL-19). The new collection records the **second only**. It is never read to
compute `verified_by`, never written by planning, and never written by a machine.

### 4.2 There is no create route. Confirming creates the document.

**Chosen: the *existence* of a `verifies` link is derived from `covers_req_ids`; only its
*confirmation* is stored.**

`GET /links` projects one row per `(req_id, td_id)` pair that `covers_req_ids` names, and
left-joins the stored confirmations onto them. A pair nobody has confirmed is a row with
`confirmed_at: null`. A pair that loses `covers_req_ids` on the next planning push simply stops
being projected, and its orphaned confirmation is never read again — no cascade, no cleanup, no
compensating write.

This is a deliberate departure from the brief's four-route shape (create / confirm / list /
delete), and it is the whole D1 defence in one design move: **if a link could be created, the set
of links would be a second, authored statement of coverage that could disagree with
`covers_req_ids`** — which is exactly the field the board forbids authoring. Deriving the set and
storing only the signature makes disagreement unrepresentable.

A future link type whose existence nothing derives (`derives_from` between two requirements, say)
needs a create route on the day it is introduced, and not before. `link_type` is in the id
preimage precisely so that day costs a value, not a migration.

### 4.3 The collection and the document

**Collection: `traceability_links`.** Not `links` — `PushedLink` and `planning_sync._write_link`
(`api/api/planning_sync.py:539`) already own that word for a *run → work-order* claim written onto
the `test_runs` document, and two unrelated things called "link" in one codebase is how a reader
gets it wrong.

**The id rule, per BL-33 and the board:**

```
_id = link_id = f"{link_type}|{from_id}|{to_id}"
             = "verifies|BAT-SYS-PRF-001|BAT-SYS-TC-001"
```

**No version in the preimage.** A link is the pair, once, for all time; the versions it was
confirmed at are fields. Putting a version in the id would mint a new link on every edit of either
end, and "is this link confirmed?" would become "is *any* of these links confirmed?", which is not
a question with an answer. It also survives BL-66 untouched: a build number qualifies a *run*, not
a specification, so `sw_version` is not in the preimage either
(`dev-planning/tc-across-sw-versions/spec.md` §6.3, OQ9 — agreed).

The direction is **requirement → test definition**, matching the board's `verifies` arrow and
`dev-planning/review-page/spec.md:458`'s illustration
(`verifies|BAT-SYS-SAF-002|BAT-SYS-TC-003`).

```jsonc
{
  "_id": "verifies|BAT-SYS-PRF-001|BAT-SYS-TC-001",
  "link_type": "verifies",
  "from_kind": "requirement",      // the id's preimage, split out so a query
  "from_id":   "BAT-SYS-PRF-001",  // never parses the _id string
  "to_kind":   "test_definition",
  "to_id":     "BAT-SYS-TC-001",

  // THE CONFIRMED PAIR. Written by the confirm act, never by a mirror pass,
  // never recomputed. These are a PIN — a historical fact — not a cache of a
  // current value, which is why they cannot drift.
  "confirmed_from_version": 1,            // R@v  — requirements.item_version
  "confirmed_from_normative_sha256": "…", // what suspicion compares (§5)
  "confirmed_to_version": 1,              // TC@w — test_definitions.item_version
  "confirmed_to_normative_sha256": "…",
  "confirmed_by": "ludvik@quix.io",
  "confirmed_at": "2026-09-24T11:04:00Z",
  "comment": "Charging-current ceiling and the TC's assertion agree."
}
```

**Why both the version pair and the hash pair are stored.** They answer different questions, and
neither derives the other:

- The **version pair** `(R@v, TC@w)` is what a person reads and what BL-19's *"a pass pinned to
  TC version `w`"* compares against. It moves on any `content_sha256` change, including `title`
  and `rationale`.
- The **hash pair** is what decides suspicion, per CLAUDE.md § "Requirements workflow": *"A link
  goes suspect on a `normative_sha256` change only."*

A title edit bumps `item_version` and moves neither hash. Under a version-only rule that link goes
suspect, which contradicts the stated rule outright. Under a hash-only rule, `GET /links` cannot
say *"confirmed at R@1, now R@3"*. Four fields, two jobs, no redundancy.

**Nothing derived is stored.** `suspect`, `from_current_version`, `to_current_version` and
`stale_version` are computed on every read (§5), the same discipline `verification_state`,
`evidence_stale` and `reviewed_stale` already follow.

### 4.4 Indexes

**None beyond `_id`.** Every read is one of two shapes:

- *the links of a requirement / a definition / a page of either* — the caller already holds
  `covers_req_ids`, builds the candidate `link_id`s and does `find({"_id": {"$in": [...]}})`,
  which is the `_id` index;
- *every suspect link, for the review queue* — a full scan of a collection bounded above by the
  coverage matrix (10 rows today, one per confirmed pair), joined against the two ends the queue
  already reads.

An index on `from_id` or `to_id` would serve no query that the `_id` `$in` does not serve more
cheaply. Adding one now is a cache for a reader that does not exist.

### 4.5 Routes

All under `api/api/routers/links.py` (new), registered in `main.py`'s router tuple.

```
GET    /api/v1/links?req_id=&td_id=&state=&page=&page_size=
GET    /api/v1/links/{link_id}
POST   /api/v1/links/{link_id}/confirm     { from_version, to_version, comment?, note? }
DELETE /api/v1/links/{link_id}             { actor, note? }
```

`state` ∈ `unconfirmed | confirmed | suspect`, computed by §5 and used by the review queue's
`Links` quick view (`dev-planning/review-page/spec.md` §8).

`POST /review/links/{link_id}/confirm` in `review-page/spec.md` §11 and this route are **the same
act**. It lives here, under `/links`, and the review router calls it or redirects to it; the
review spec's §9 already frames confirmation as *"its own single-signature act, not folded into
accept/reject"*, which is satisfied either way. §9 OQ7 names the choice.

**Refusals, in the estate's style:**

| Code | HTTP | When |
|---|---|---|
| `link_not_found` | 404 | no `covers_req_ids` entry names this pair, so the resource does not exist. This is the coverage check, expressed as the absence of a derived resource rather than as a validation branch on a body. |
| `identity_unavailable` | 401 | the token does not resolve to a person. A confirmation is a signature; `review-page/spec.md` §7's `require_person` is the dependency, reused, not re-specified. |
| `stale_parent` | 409 | `from_version` or `to_version` in the body does not equal the end's current `item_version`. Same code and same meaning as `RequirementPatchRequest.parent_version` (`api/api/models/requirements.py:162-176`): you confirm the pair you read, or you read again. |
| `link_not_confirmed` | 409 | `DELETE` on a link carrying no confirmation. There is no document and nothing to withdraw. |

**A re-confirm at unchanged hashes is a 200 that writes nothing** — no document update, no journal
entry — mirroring `POST /files/{file_id}/versions`'s replay rule (`files.py:776-779`). It is not a
refusal: a reviewer clicking Confirm twice has made no mistake. `no_op_mint` is deliberately **not**
reused here; it names a refusal on an authoring write, and this is an idempotent signature.

`DELETE` **removes the document.** No soft-delete flag: the journal holds the history
(`link.unconfirmed` names who withdrew and why), and a `confirmed_at: null` tombstone would be a
second representation of "unconfirmed" that `GET /links` already produces for a pair with no
document at all.

### 4.6 Journal

`api/api/routers/journal.py`'s `_ENTITIES` (`:67-75`) gains one row:

```python
    "link": ("traceability_links", "Link", "link_not_found"),
```

`_require_entity` does `find_one({"_id": entity_id})`, so a journal entry against a never-confirmed
link 404s — correct, because nothing has happened to it.

| Event | Source | Note |
|---|---|---|
| `link.confirmed` | `Source.MANUAL` | `"Confirmed BAT-SYS-PRF-001@1 verifies BAT-SYS-TC-001@1."` |
| `link.reconfirmed` | `Source.MANUAL` | `"Re-confirmed at BAT-SYS-PRF-001@3 (was @1). The requirement text changed."` |
| `link.unconfirmed` | `Source.MANUAL` | `"Confirmation withdrawn. <note>"` |

Written through `add_event` (`api/api/provenance.py`), `add_event` **before** the row update, the
ordering `review-page/spec.md` §11 states and `test_definitions.py` already follows: *"a decision
must never be recoverable without a trace."*

### 4.7 The test definition's version and normative projection — BL-34's TC half

**The requirement half already shipped.** `RequirementDetail.item_version` and `.content_sha256`
are live (`api/api/models/requirements.py:127-130`), minted by `content_sha256`/`normative_sha256`
over `CONTENT_FIELDS` / `NORMATIVE_FIELDS` (`api/api/services/queries_requirements.py:36-60`)
through the shared `_canonical_sha256` helper (`:68-71`). **`test_definitions` carries none of the
three** — confirmed by `dev-planning/run-a-definition/spec.md:356-361`, which writes the verdict's
`definition_version` as `None` for exactly this reason.

This spec states what the TC's three values are made of. The machinery is
`_canonical_sha256`, reused, not rewritten.

```python
# api/api/services/queries_definitions.py (or beside the definitions router)

TD_CONTENT_FIELDS = ("title", "covers_req_ids", "planned_runs", "implementation_sha256")
TD_NORMATIVE_FIELDS = ("implementation_sha256",)
```

- **`implementation_sha256` is the TC's normative content.** A test case's meaning is what it
  asserts, and the only registry-held artefact that states the assertion is the `.py`
  (`DefinitionImplementation.sha256`, `api/api/models/planning.py:198-205`). The pass criteria
  live in `battery-trace-gen/specs/battery-dc-test-specs.json`, outside the registry; when they
  become a field, they join this tuple and nothing else changes.
- **`covers_req_ids` mints a version but is NOT normative.** It is the link's own preimage-adjacent
  data: hashing it into the TC's normative digest would make **the link suspect itself** the moment
  it was created, and would make a link about `BAT-SYS-PRF-001` go suspect because the TC also
  started covering `BAT-SYS-SAF-003`. Excluded, with the same shape of argument that excludes
  `status` from a requirement's normative hash.
- **`work_order_ids` is in neither tuple.** Campaign membership is scheduling, not content. Under
  BL-66 a second campaign adopting `BAT-SYS-TC-001` must mint no version and suspect no link —
  the test case did not change.
- **`title` is in CONTENT, not NORMATIVE**, mirroring the requirement rule exactly.

Three "does the implementation digest already drive something?" objections, answered together —
they are three **different people's signatures going stale**, not one fact counted three times:

| Machine | Compares | Says |
|---|---|---|
| `evidence_stale` (`queries_requirements.py:196-199`) | the *verdict's* pinned digest vs current | this pass was produced by an older version of the test |
| `reviewed_stale` (`review-page/spec.md` §5.2) | the *review decision's* pinned digest vs current | nobody has reviewed the code as it stands |
| link **suspect** (§5) | the *confirmation's* pinned digest vs current | nobody has confirmed that the test, as it stands, verifies this requirement |

---

## 5. Suspicion

### 5.1 The rule

```
suspect = confirmed_at is not None
          and (requirement.normative_sha256 != confirmed_from_normative_sha256
               or definition.normative_sha256 != confirmed_to_normative_sha256)
```

Derived on every read of `GET /links`, the requirement detail, the definition detail and the review
queue. Never stored. `review-page/spec.md` §8's *"every link with `suspect: true`"* reads this
computed field; that spec's own §5.3 already commits to derived-not-stored staleness, so there is
no contradiction to resolve.

### 5.2 What suspects, precisely

Requirement side — `NORMATIVE_FIELDS` (`queries_requirements.py:54-60`), unchanged:

| Field | Suspects? |
|---|---|
| `text` | **yes** |
| `measurand` | **yes** |
| `system_states` | **yes** |
| `verification_method` | **yes** |
| `verification_criteria` | **yes** |
| attachment refs (`figure_refs`) | **yes** — CLAUDE.md names them; they are not in the shipped tuple, so §9 OQ2 |
| `title` | no |
| `rationale` | no |
| `status` (Draft → Ready for Review → Reviewed) | no — *"Draft → Reviewed suspects nothing"* |
| `chapter`, `revision`, `source`, `related_reqs` | no |

Test-definition side — `TD_NORMATIVE_FIELDS` (§4.7):

| Field | Suspects? |
|---|---|
| a new `implementation` upload (digest changes) | **yes** |
| `covers_req_ids` | no — see §4.7 |
| `title`, `planned_runs`, `work_order_ids` | no |
| `review.state`, `custom_properties`, `manual_requirements_files` | no |

**Neither side's `item_version` suspects anything on its own.** A version bump with both hashes
unmoved leaves the link confirmed and `stale_version: true` — surfaced as *"confirmed at R@1 (now
R@3, no normative change)"*, which is information, not work.

### 5.3 What clears it

**One act: a re-confirmation.** `POST /links/{link_id}/confirm` writes the new version pair and the
new hash pair; the derived `suspect` then reads false because the stored pins match the ends again.
Nothing else clears it — not a review accept on either end, not a new verdict, not time.

Reverting the edit clears it too, incidentally and correctly: the same normative bytes produce the
same digest, so the pins match again without a write. That is a property of hashing, not a rule,
and it needs no code.

LK8 — *a generator may not confirm its own output* — applies, and belongs to
`review-page/spec.md` §9, which already states it and names the actor comparison. Not re-specified
here.

---

## 6. Where the file version enters the link model

### 6.1 The answer: nowhere on the link

**A link joins two specifications. A file is evidence. They are on opposite sides of the act of
testing, and the link model must not reach across.**

- A `verifies` link says *this test case is the right way to verify this requirement.* Both ends
  are documents a person authored and a person reviewed. Neither is a measurement.
- A trace is what came off the bench when someone executed that test case. It is an input to a
  verdict, not a party to a judgment about specifications.

Putting a file version on the link inverts the meaning of *suspect*. A re-run is the case where
**nothing about either specification changed** — that is the entire point of re-running. If the
trace version were in the confirmed pair, every re-run would suspect every link the test case
touches, and a reviewer's queue would fill with items whose two ends are byte-identical to what
they already signed. Suspicion would come to mean "something happened", which is a notification,
not a signature.

### 6.2 The file version is already in the evidence chain, with zero new fields

It rides on the **verdict's provenance**, where it has ridden since before this spec:

```
provenance.input_file_ids: list[str]      api/api/models/results.py:79
```

and the runner fills it with *"the run's registered file ids"*
(`dev-planning/run-a-definition/spec.md:334`, and `:342-345` — a verdict that names none arrives
permanently `provenance_status: "flagged"`).

**A file document *is* one version.** Each version has its own `f-<uuid>`, its own checksum, its
own journal and its own download (`files.py:766-771`), and `version_group` names the chain they
share. So `input_file_ids: ["f-9c2e…"]` already pins the exact bytes the verdict read, to the
version, by id. Nothing is added to `Verdict`, to `Provenance`, or to the link.

This is the same argument `tc-across-sw-versions/spec.md` §6.2 made for `sw_version` and won:
*"`Verdict` gains nothing. `processed_results.run_id` already names the run and the run names the
build. A copy on the verdict could disagree with the run it came from."*

### 6.3 The concrete question, answered

> **A test is re-run and produces v2 of its trace. Does that change any link, any suspicion, or
> only the evidence?**

**Only the evidence.** Step by step, with real ids:

| # | What happens | What moves |
|---|---|---|
| 1 | The corrected `TAS-1001_T1_charge_thermal.mf4` is uploaded to `TAS-1001`. | A new file document, `version: 2`, `supersedes` the v1 id, same `version_group`. The v1 document is untouched. |
| 2 | The decoder decodes it; rows land in `battery_data_v1` under the same `platform/work_order/run_id` partition. | Lake rows. No partition change (`quix.yaml:76` untouched). |
| 3 | The Run button re-evaluates `BAT-SYS-TC-001` against `TAS-1001`. | A **new version** of the `processed_results` document at `result_key = "verdict/BAT-SYS-TC-001"` — the collection is already a version chain per `(run_id, result_key)` (`api/api/db.py:157-159`). Its `provenance.input_file_ids` names the **v2** file id. |
| 4 | `_state_fold` reads the newest verdict per `(run, definition)` (`queries_requirements.py:126-137`). | `BAT-SYS-PRF-001`'s `verification_state` follows the new outcome. |
| 5 | `verifies\|BAT-SYS-PRF-001\|BAT-SYS-TC-001` | **Nothing.** No field changes. `suspect` is still false. `confirmed_from_version` and `confirmed_to_version` still read 1. |

The v1 verdict is not deleted and is not wrong — it is a true statement about v1 of the trace, and
`provenance.input_file_ids` is what lets a reader years later see which bytes it meant. That is the
whole reason the version chain is worth having, and it needs no link field to deliver it.

### 6.4 The one case that feels like a counterexample, and is not

*"We re-ran it because the first trace was garbage. Surely the old pass should stop counting?"*

It already does, by a mechanism that predates this spec: `_newest_verdict_of_td` takes the newest
run carrying a verdict (`queries_requirements.py:147-157`), and within a run the fold takes the
newest verdict **version** (`:126-137`). The v1 pass is history the moment the v2 verdict lands.
A link field would not have improved that outcome; it would have added a suspicion nobody needed
to clear.

---

## 7. Covered ≠ Tested, restated with versions

Real ids, one requirement, one test case, one run, one trace. Each row names every version in
play.

**The starting state (today's estate, plus BL-34's TC half and §4's collection):**

| Artefact | Id | Version |
|---|---|---|
| Requirement | `BAT-SYS-PRF-001` | `item_version: 1`, `normative_sha256: R1` |
| Test definition | `BAT-SYS-TC-001` | `item_version: 1`, `normative_sha256: W1` (= its implementation digest) |
| Run | `TAS-1001` | `sw_version: null` (BL-66; null today) |
| Trace | `TAS-1001_T1_charge_thermal.mf4` | `version: 1`, file id `f-a1…` |

| Step | Act | Requirement reads |
|---|---|---|
| 1 | `BAT-SYS-TC-001.covers_req_ids = ["BAT-SYS-PRF-001"]` is mirrored. `verified_by` derives (`queries_requirements.py:101-108`). | **`covered`** — and no link document exists yet. Coverage never needed one. |
| 2 | `TAS-1001.definition_ids` carries `BAT-SYS-TC-001`; the trace is registered and decoded. | still `covered` — a run without a verdict is not evidence. |
| 3 | The Run button writes the verdict: `outcome: "pass"`, `implementation_sha256: W1`, `definition_version: 1`, `provenance.input_file_ids: ["f-a1…"]`. | **`exercised`** — there is a pass, and nobody has confirmed the link. |
| 4 | A reviewer confirms: `POST /links/verifies\|BAT-SYS-PRF-001\|BAT-SYS-TC-001/confirm` with `from_version: 1, to_version: 1`. The document stores `(R@1, W@1)` and `(R1, W1)`. | **`tested`** — the three pins hold: a confirmed link, not suspect; a pass whose `definition_version` (1) equals `confirmed_to_version` (1); and the run's `sw_version` is the one being asserted (null = null). |
| 5 | Someone edits the requirement's **`title`**. `item_version` → 2. `normative_sha256` stays `R1`. | still **`tested`**. The link is **not suspect**. `GET /links` says *confirmed at R@1, now R@2, no normative change.* |
| 6 | Someone edits the requirement's **`text`**. `item_version` → 3, `normative_sha256` → `R3`, `normative_changed_at` stamps. | **`exercised`**, not `tested`. The link is **suspect**: `R3 ≠ R1`. `evidence_stale: true` by the shipped rule (`provenance.produced_at` vs `normative_changed_at`). The pass still exists and is still shown — it is about the old text. |
| 7 | The reviewer re-confirms at `from_version: 3`. The document stores `(R@3, W@1)` and `(R3, W1)`. | Link no longer suspect. `verification_state` back to **`tested`** — the pass's `definition_version` (1) still equals `confirmed_to_version` (1); the requirement side moved, the test case side did not. |
| 8 | The trace is **re-run**: file v2, a new verdict version citing `f-b7…`, outcome `pass`. | still **`tested`**. §6.3: no link field moves, nothing goes suspect. |
| 9 | A new `.py` is uploaded for `BAT-SYS-TC-001`. `implementation.sha256` → `W2`, so `item_version` → 2 and `normative_sha256` → `W2`. | **`exercised`**. Three machines fire at once and each says its own thing: the link is **suspect** (`W2 ≠ W1`); `evidence_stale: true`, because the newest verdict still pins `W1` (`queries_requirements.py:196-199`); and the definition's `review` goes `reviewed_stale`. The requirement is not tested by a test nobody has run in its current form. |
| 10 | Re-run under the new implementation, then re-confirm at `to_version: 2`. | **`tested`** again, at `(R@3, W@2)`, evidenced by trace v2 and the verdict that cites it. |

**The rule, in one line:** `tested` = a **confirmed** link that is **not suspect**, **and** a pass
whose `definition_version` equals the link's `confirmed_to_version`, **and** (BL-66) a run whose
`sw_version` is the one being asserted. `covered` needs only `covers_req_ids`. The gap between
them is steps 4, 7 and 10 — three signatures, and no amount of passing tests produces one.

---

## 8. What must land first

| # | Item | Blocked on | Ships what |
|---|---|---|---|
| 1 | **§3.1 — the chain rule in `register_file_document`** | nothing | a re-run's trace becomes v2 |
| 2 | **§2.3 — `FileBody.version_group` + the before-validator** | nothing (parallel with 1) | the chain id on the wire |
| 3 | **§2.4 — the `Version` cell and the versions drawer** | 2 | what the user actually asked to see |
| 4 | **BL-34's TC half — §4.7** | nothing technically; it is the **hard prerequisite** for everything below | `test_definitions.item_version`, `content_sha256`, `normative_sha256`, minted by `_mirror_definitions` (`planning_sync.py:430-438`) and by the implementation upload route |
| 5 | **§4 — `traceability_links`, the four routes, the journal row** | 4 | the link store |
| 6 | **§5 — suspicion, derived** | 5 | a suspect link |
| 7 | `review-page/spec.md` Phase 2 — suspect links in the queue | 6 | the reviewer sees them |
| 8 | **BL-19's `tested` rule in `_state_fold`** | 5, 6, and BL-11's verdict writer | §7 step 4 |

**Items 1–3 are wholly independent of 4–8.** The file half can ship this week and touches no
requirement, no definition and no fold.

**Why BL-34's TC half is the hard one.** A link document has four confirmed-pair fields and two of
them read `test_definitions.item_version` and `test_definitions.normative_sha256`. Neither exists.
Without them a confirmation can pin the requirement end and only guess at the test-case end, which
is worse than not confirming: BL-19's *"a pass pinned to TC version `w`"* has no `w`, and
`run-a-definition/spec.md:356-361` already writes the verdict's `definition_version` as null for
exactly this reason. Building §4 first would ship a half-pinned signature, and a half-pinned
signature reads on screen exactly like a whole one.

**Also on the way, and cheap:** `api/docs/openapi.v1.json` is already red under **BL-25**; every
model change above lands in the same regeneration (`api/scripts/snapshot.sh`).

---

## 9. Open questions

**OQ1 — is `(run_id, filename)` the identity, or should an operator be able to override it?**
*Recommended: `(run_id, filename)`, no override.* §1.2's three facts make it true in this estate
today, and §1.4 shows the failure mode is recoverable with routes that already exist. An override
adds a second way to be wrong that the derived rule cannot produce. Revisit only if a producer
lands that stamps a timestamp into the filename — which would break the key outright, not weaken
it, and would be visible immediately as "every re-run is a new v1".

**OQ2 — `figure_refs` is named as normative by CLAUDE.md but is not in the shipped
`NORMATIVE_FIELDS`.**
CLAUDE.md § "Requirements workflow" lists *"attachment refs"* among the fields that suspect a
link; `queries_requirements.py:54-60` holds five fields and `figure_refs` is not one of them.
*Recommended: add it.* A requirement whose figure changed may well be verified differently, and
the tuple is one line. This is a pre-existing divergence between the board and the code, surfaced
by this spec rather than caused by it.

**OQ3 — does `vN of M` need `version_count` on the wire?**
*Recommended: not now.* The `Version` cell shows `v3`; the chain is one click away in the versions
drawer; the run-detail files panel shows every version of that run's traces on one screen, which is
the surface the user described. If the global `/files` table turns out to need "of 3", it is one
bounded `$group` per page over the page's `version_group` values — the shape `_count_by`
(`queries_runs.py:1777-1796`) already uses. Cheap to add later, not free to add now.

**OQ4 — does the default `/files` table list every version, or only chain heads?**
*Recommended: every version, each as its own row.* `GET /files/{file_id}/versions` already commits
to this for the chain read — *"**Every lifecycle shows.** A deleted version stays in the list,
because the history is the audit trail of the file and a gap in it would hide a step"*
(`files.py:892-899`) — and a table that silently hides rows is how a person loses a file. A
`latest only` quick view is a filter, and filters belong to whoever asks for one.

**OQ5 — what does a person see when they re-upload identical bytes?**
*Recommended: leave the pipeline alone, and say it in the UI copy.* The decoder's content-sha256
dedup (`mf4-decoder/idempotency.py:12-19`) is load-bearing — it is what stopped 5 copies of a
route landing in the lake — and making it report a skip means a new message shape through two
services. The upload form's help text should say that re-uploading unchanged bytes changes
nothing, and CLAUDE.md's *"change the route timestamp to re-ingest"* stays the operator's answer.

**OQ6 — does a run's `file_count` count versions?**
*Recommended: yes, unchanged.* A run whose trace was uploaded three times reads `file_count: 3`
because it holds three file documents, and `apply_file_rollup` counts documents
(`files.py:1336`). Changing it means the rollup learning about chains, and a run page that hid the
older versions would hide the audit trail the chain exists to keep. The `Version` column explains
the number in the same table.

**OQ7 — does confirm live at `POST /links/{id}/confirm` or `POST /review/links/{id}/confirm`?**
*Recommended: `/links/{id}/confirm` is the route; the review screen calls it.*
`review-page/spec.md` §11 declares the review-namespaced path, but that spec's own §3 puts the
link entity out of its scope and §9 blocks it on BL-33. One act, one route, in the router that
owns the collection. The review spec's §11 line becomes a reference rather than a declaration —
a one-line edit to that spec when this one is accepted.

**OQ8 — does the file version belong anywhere on the link?**
*Recommended: no.* §6. It is already pinned, to the exact version, by
`provenance.input_file_ids` on the verdict, and putting it on the link would make every re-run
suspect links whose two ends nobody touched.

**OQ9 — what `link_type` values exist on day one?**
*Recommended: `verifies` only.* It is the one the board's BP5 and BL-19 need and the one
`covers_req_ids` derives. `satisfies`, `derives_from` and `refines` are real ASPICE link types and
each needs its own answer to "what derives the set?" — which is the question §4.2 turns on. One
value, a preimage that takes more.

**OQ10 — should `POST /links/{id}/confirm` refuse a caller who is the implementation's
`uploaded_by` (LK8)?**
*Recommended: yes, and it is `review-page/spec.md`'s rule, not this spec's.* That spec §7 already
specifies the actor comparison and the `self_review_refused` code, and §9 already extends it to
link confirmation. Implementing it here means calling that check, not restating it.

---

## 10. References

- `CLAUDE.md` § "Requirements workflow (ASPICE SYS.2 — the Miro board)" — Covered ≠ Tested, the
  `normative_sha256` suspicion rule, BP5 / D1, the refusal vocabulary.
- `CLAUDE.md` § "Ingestion pipeline" — the run-id ladder, the `file_complete` marker, the
  decoder's sha256 dedup.
- `dev-planning/tc-across-sw-versions/spec.md` §5 (the file chain, `FileBody.version_group`), §6.3
  (why `sw_version` is not in the link preimage). **§5.2(a) is overridden by §3.2 of this spec.**
- `dev-planning/review-page/spec.md` §5.3 (derived staleness), §7 (`require_person`,
  `identity_unavailable`, LK8), §9 (link confirmation as its own signature), §11 (routes, journal).
- `dev-planning/authoring-controls/spec.md` §6, §12 — `item_version`, `content_sha256`,
  `stale_parent`, `no_op_mint`, shipped on requirements.
- `dev-planning/requirement-status-from-runs/spec.md` §4.6, §5.3 — `normative_sha256`,
  `evidence_stale`, the `_state_fold` this feature gates.
- `dev-planning/run-a-definition/spec.md` §5.1-§5.2 — the verdict body,
  `provenance.input_file_ids`, `definition_version: None` and why.
- `dev-planning/test-results-page/spec.md` §2.2 — the verdict document, `definition_version`,
  `criterion`.
- Code: `api/api/routers/files.py:718-911, 1043-1337`, `api/api/db.py:91-119`,
  `api/api/models/files.py:98-116, 182-193`, `api/api/services/queries_requirements.py:36-60,
  68-108, 126-137, 196-199`, `api/api/models/requirements.py:124-130`,
  `api/api/models/planning.py:113-116, 184-205`, `api/api/routers/journal.py:67-75`,
  `api/api/planning_sync.py:430-438, 539`, `tm-connector/connector/registry.py:88-146`,
  `tm-connector/connector/connector.py:155, 203`, `mf4-to-blob/blob.py:75-101`,
  `mf4-to-blob/main.py:63, 251`, `mf4-decoder/main.py:733, 1021-1025`,
  `mf4-decoder/idempotency.py:12-19`, `battery-trace-gen/scenario.py:113`.
- Backlog: **BL-19**, **BL-25**, **BL-32**, **BL-33**, **BL-34**, **BL-36**, **BL-66**, **BL-68**.

---

## Appendix A — sanity print

### A.1 The link document, every field populated

`BAT-SYS-PRF-001` ↔ `BAT-SYS-TC-001`, confirmed after the requirement's text was edited once
(§7 step 7): the requirement is at `item_version 3`, the test case still at `1`. Both digests are
illustrative full-length 64-hex values.

```json
{
  "_id": "verifies|BAT-SYS-PRF-001|BAT-SYS-TC-001",
  "link_type": "verifies",
  "from_kind": "requirement",
  "from_id": "BAT-SYS-PRF-001",
  "to_kind": "test_definition",
  "to_id": "BAT-SYS-TC-001",
  "confirmed_from_version": 3,
  "confirmed_from_normative_sha256": "b41d0e7a9c6f2853e1d4a07b5c9f3e82d610ab74c3f5e920d8b1467af03c2e59",
  "confirmed_to_version": 1,
  "confirmed_to_normative_sha256": "1f3c9ab0d5e84726c0b93a15fd7e6248ca03b91d5f82e470a6cd19b3f84e2057",
  "confirmed_by": "ludvik@quix.io",
  "confirmed_at": "2026-09-24T11:04:00Z",
  "comment": "The 300 A ceiling and the TC's i_dc_chg assertion agree after the text edit."
}
```

`confirmed_to_normative_sha256` equals `test_definitions.implementation.sha256` at confirmation
time, because §4.7's `TD_NORMATIVE_FIELDS` is that one field today.

And the same link as `GET /links/verifies|BAT-SYS-PRF-001|BAT-SYS-TC-001` answers it, with the
derived block:

```json
{
  "link_id": "verifies|BAT-SYS-PRF-001|BAT-SYS-TC-001",
  "link_type": "verifies",
  "from_id": "BAT-SYS-PRF-001",
  "from_title": "DC charging current limit",
  "to_id": "BAT-SYS-TC-001",
  "to_title": "DC charging current held at or below I_current_Chr_Max",

  "confirmed_from_version": 3,
  "confirmed_to_version": 1,
  "confirmed_by": "ludvik@quix.io",
  "confirmed_at": "2026-09-24T11:04:00Z",

  "from_current_version": 3,
  "to_current_version": 1,
  "suspect": false,
  "stale_version": false,
  "state": "confirmed"
}
```

The four derived values at the bottom are computed on this read and stored nowhere. After a
`title`-only edit of the requirement they read `from_current_version: 4`, `suspect: false`,
`stale_version: true`, `state: "confirmed"`. After a `text` edit they read `suspect: true`,
`state: "suspect"`.

### A.2 The file list for a run whose trace was uploaded three times

`TAS-1001`, one logical trace, three versions. All three rows share one `version_group` — the
v1 document's own id, per `_version_group`'s root rule.

```
Filename                          Version  Status      Registered           Checksum    Size
TAS-1001_T1_charge_thermal.mf4    v3       registered  2026-09-24 14:02     8c1fa903…   41.2 MB
TAS-1001_T1_charge_thermal.mf4    v2       registered  2026-09-23 09:41     2b775e10…   41.2 MB
TAS-1001_T1_charge_thermal.mf4    v1       registered  2026-09-22 16:18     1f3c9ab0…   41.1 MB
```

| Row | `file_id` | `version` | `version_group` | `supersedes` | blob object |
|---|---|---|---|---|---|
| v3 | `f-c9d2…` | 3 | `f-a1b4…` | `f-b7e8…` | `<ws>/jama_ui/TAS-1001/TAS-1001_T1_charge_thermal-4f0a91c3.mf4` |
| v2 | `f-b7e8…` | 2 | `f-a1b4…` | `f-a1b4…` | `<ws>/jama_ui/TAS-1001/TAS-1001_T1_charge_thermal-9e2d7b05.mf4` |
| v1 | `f-a1b4…` | 1 | `f-a1b4…` | `null` | `<ws>/jama_ui/TAS-1001/TAS-1001_T1_charge_thermal.mf4` |

Three things this table is showing on purpose:

1. **The filename is identical on all three rows and the blob object is not.** That is §1.2's
   collision-suffix finding: `mf4-to-blob` suffixes the *object*, the message carries the original
   *name*, and the chain keys on the name.
2. **v1's `version_group` is its own id.** Nothing is stored on it; `_version_group` answers
   `file_doc["_id"]` for a document with no key, which is how the four traces already in the
   estate become roots without a migration.
3. **The run reads `file_count: 3`** (OQ6). One trace, three documents, three rows, and the
   `Version` column is what stops that number reading as three different recordings.
