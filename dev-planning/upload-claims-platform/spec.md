# MF4 Import — declare the platform at upload

**Status:** Draft
**Project:** comma-car-segments-ingest
**Created:** 2026-09-25
**Planned with:** Buddy
**Branch / env:** `jama-ui-dev` / `testrigorg-commacarsegmentsingest-jamaui`
**Supersedes:** `dev-planning/upload-claims-project/spec.md` (renamed — that spec was built on
the wrong premise; the field is the lake's `platform`, not the Test Manager's `project`)
**Backlog:** no row yet — proposed text in §12
**Scope:** `mf4-to-blob` (2 static files, 1 python file) and `mf4-decoder` (2 lines). No
change to the sink, the connector, the registry, the lake schema, the partition spec or
the four existing lake rows.

---

## 0. Summary

> *"imagine you are uploading traces for Porsche Taycan and Porsche Macan, cannot be stored
> under same project in lake"* — the user, 2026-09-25

The MF4 Import page cannot say which vehicle platform a recording is from. It does not
need to say it twice or invent a new concept: **`platform` is already a top-level Hive
partition column and already the DCM `target_key` that picks the CAN database.** It is
simply unfed. Today one deployment-wide environment variable answers for every file:

- `mf4-decoder/main.py:1131` — `str(value.get("platform") or DBC_PLATFORM or UNKNOWN)`.
  The metadata message is *allowed* to carry a platform. Nothing sends one, so
  `DBC_PLATFORM=Porsche_Taycan` always wins.
- Consequence: a Macan trace uploaded today is **decoded with the Taycan DBC** and filed
  under `platform=Porsche_Taycan/`. The wrong-DBC half is the severe one — it is not a
  mis-filed row, it is wrong signal values.

This spec adds one claim field to the import page. It rides on the metadata message as a
flat `platform` key and does two things at once: **picks the right DBC, and names the right
lake partition.** No new column, no new table, no re-sink, no migration.

### Why this was contested

Two earlier rounds of this spec argued against a `project` input, because
`work_orders.project` is a campaign's programme name, a run only ever inherits it
(`queries_runs.py:140-143`), and an upload-typed copy would be a second authored statement
of one fact. **That reasoning was correct and is now moot** — the user's requirement is
about the lake partition and the DBC, which is `platform`, a different field that no one
authors today at all. `work_orders.project` is untouched by this spec; §9 says what happens
when the two disagree (nothing).

---

## 1. Goals

- A person uploading a Macan trace and a Taycan trace in one selection gets each decoded
  with its own DBC and filed under its own `platform=` partition.
- The field prefills from the recording's own header, so the correct answer is the default
  and nobody has to know it.
- `DBC_PLATFORM` keeps working, unchanged, for an upload that declares nothing.
- No lake schema change, no re-partition, no re-sink, no trace regeneration.

## 2. Non-goals

- The Test Manager's `work_orders.project` — untouched.
- A `platform` field on a run, in `RunUpsertRequest`, or in the connector's
  `DECLARED_FIELDS`. The registry has no such field and does not need one.
- Whether an upload may create a missing work order. **Deferred** — a separate, smaller
  question, unrelated to this one now that `project` is out of scope. See §11.
- Seeding DBCs. §8 states the prerequisite; it is an operator step, not code.

---

## 3. The name of the field: **Platform**, not Project

The user said "project". The field they want is the lake's `platform`. Labelling the input
*Project* would collide head-on with `work_orders.project`, which is a real, visible,
different field — it is a column on the work-orders list
(`frontend/.../work-orders-screen.tsx:188`), a filter and a facet
(`api/api/routers/work_orders.py:42, :69-77`). Two controls named Project meaning two
different things is the confusion this spec exists to end.

So: **label `Platform`**, with one line of helper text that names both of its jobs, because
neither is guessable:

> *Which vehicle platform this recording is from. It chooses the CAN database the file is
> decoded with, and it is the lake's top-level folder.*

---

## 4. Design — the hops, in order

```
browser form          declared.platform=Porsche_Macan
   |                  (claim-editor.js, prefilled from the file's own HD comment)
   v
mf4-to-blob           collect_declared  -> shape-checked against _TM_ID
   |                  build_payload     -> flat "platform" key + the declared bag
   v
mf4_metadata          {"platform": "Porsche_Macan", "declared": {..., "platform": ...}}
   |
   v
mf4-decoder           main.py:1131  F_DCM_KEY = value.get("platform") or DBC_PLATFORM
   |                  -> DCM lookup type=dbc target_key=Porsche_Macan   [ALREADY WORKS]
   |                  process()     provenance_fields["platform"] = the declared value
   v
samples batches       file_scalars["platform"] = "Porsche_Macan"
   |
   v
mf4-datalake-sink     expand.py:171  platform = value.get("platform")     [NO CHANGE]
                      -> platform=Porsche_Macan/work_order=.../run_id=.../
```

### 4.1 The hop that matters most — the flat key

`mf4-decoder/main.py:1131` reads **`value.get("platform")`** — a top-level key on the
metadata message. It does **not** read `value["declared"]["platform"]`, and it cannot: the
`F_DCM_KEY` column is computed by an `sdf.apply` in the module body, before `process()` and
before the file is downloaded.

So `build_payload` must write the flat key, exactly as it already does for the work order
(`mf4-to-blob/metadata.py:256-258`, and the docstring at `:224-228` that sets the
precedent):

> The claim also rides in a second, flat spelling — `work_order` — because that is the
> LAKE's partition column name, and the decoder copies it onto every batch. One fact, two
> spellings, both written here so the two readers cannot drift apart.

`platform` is the same shape of fact — a lake partition column name — and gets the same
treatment. It stays in the `declared` bag too (no code removes it, and
`tm-connector/connector/identity.py::clean_declared` drops it silently because it is not in
`DECLARED_FIELDS`).

**Change:** in `build_payload`'s return dict (`metadata.py:243-259`), beside
`"work_order": declared.get("work_order_id")`, add `"platform": declared.get("platform")`.
One line, plus one paragraph in the docstring stating that the DECODER reads it before the
file is opened, which is the whole reason it cannot come from the header.

### 4.2 Shape check — the one place the no-new-checks rule yields

`platform` becomes **a Hive partition directory** (`platform=<value>/`) **and a DCM
`target_key`**. That is path-shaped on both counts, which is exactly the criterion
`mf4-to-blob/metadata.py:44-51` already states for the three ids it checks:

> These three become lake partition directories or a registry id, which is why their shape
> is checked HERE, at the only door a caller can reach.

`platform` is a fourth. **Add `"platform": _TM_ID` to `_DECLARED_PATTERNS`
(`metadata.py:47-51`).** `_TM_ID` (`:39`) is `\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z`, which
accepts `Porsche_Taycan` and `Porsche_Macan` and refuses a separator, a dot-dot or
whitespace.

This is a deliberate exception to the standing "no new shape checks" rule, and it is the
same exception the existing three already are. It is **not** a validation layer: it is one
regex on the one door, refusing a value that would otherwise create a directory named
`../..`. Nothing else is added — no diagnostics, no rate limit, no second check downstream.

### 4.3 The decoder — the lake column must agree with the DBC

The DCM lookup already uses the declared platform (§4.1). The lake column does not:
`provenance_fields = build_provenance(header_properties)` (`main.py:804`) reads
`platform` out of the MF4 header (`mf4-decoder/provenance.py:42-48`). Left alone, a
declared Macan would be **decoded with the Macan DBC and filed under the header's
platform** — the exact class of silent two-answers-for-one-fact disagreement that
`mf4-decoder/identity.py`'s module docstring exists to prevent.

**Change:** in `process()`, immediately after `main.py:804`, let the message's platform win:

```python
# The DCM lookup already committed to this value (:1131) before the file was
# opened, so the partition must name the same platform the DBC came from.
if declared_platform := str(metadata.get("platform") or "").strip():
    provenance_fields["platform"] = declared_platform
```

Note the reason is **not** "the operator outranks the file". It is "the decode already
used it". The sink's own preference — *"`platform` prefers what the FILE says"*
(`mf4-datalake-sink/main.py:116-120`) — is about the work-order fallback and stays true.

### 4.4 `DBC_PLATFORM` keeps its job

Unchanged, and its comment (`main.py:72-76`) stays accurate: it is the target key *"when
the metadata message does not carry one"*. Every existing upload path — the API's ingest
sweep, a re-drop into the watched prefix, a curl — declares nothing and behaves exactly as
today. Do not remove it; it is the whole reason a single-platform deployment needs no form
filled in.

---

## 5. Prefill — and the asymmetry that makes this work

**The traces already state it.** `battery-trace-gen/bus/mf4.py:152-153` writes a
**top-level** `platform` entry into `<common_properties>` (from
`scenarios/_identity.json:2`), and `mf4-decoder/provenance.py:42-43` reads that same key.
There is no `test.` prefix and there must not be one — a second spelling of a key the file
already carries.

**The browser can read it; the decoder cannot.** `mdf-header.js` parses
`<common_properties>` client-side, before a byte is uploaded. The decoder cannot: *"The
platform is written in the MF4 header, which cannot be read until the file has been
downloaded and opened — by which time the lookup has already run"* (`main.py:73-75`). That
asymmetry is the mechanism: **the browser reads the header the decoder cannot reach, and
carries the answer forward on the metadata message.**

**Changes:**
- `mf4-to-blob/static/mdf-header.js:28-33` — `CLAIM_KEYS` gains `'platform': 'platform'`.
  No `test.` prefix. The comment above it ("The four the import form owns") becomes five.
- `battery-trace-gen/scenarios/_identity.json` — **no change.** It already carries
  `"platform": "Porsche_Taycan"` at `:2` and it already reaches the HD comment. **No trace
  regeneration is needed for this feature.** (A re-upload of the four traces still needs new
  bytes because the decoder dedups on sha256 — `mf4-decoder/idempotency.py:12-19` — but that
  is a property of re-uploading, not a cost of this change.)

### 5.1 An untouched platform prefill IS sent — the one deliberate break

Every other claim field obeys the rule from `dev-planning/import-prefill-from-trace/`: a
prefilled field the operator did not touch **states nothing on the wire**, because the
recording is readable downstream and silence lets the ladder resolve it.

**`platform` must break that rule.** The decoder cannot read the recording in time, so
silence means `DBC_PLATFORM` — and the failure fires exactly when the user does the right
thing by trusting a correct prefill. A Macan trace showing `Porsche_Macan` in the form and
decoded with the Taycan DBC because nobody retyped it is the worst outcome available.

**Change:** `claim-editor.js` — the `platform` entry carries `alwaysSend: true`, and
`declaredQuery` (`:226-236`) reads:

```js
const value = (claim.dirty || field.alwaysSend) ? claim.value.trim() : '';
```

One condition. The `typed` / `from the recording` chip and the revert control keep working
unchanged, so the summary line still tells the truth about where the value came from.

---

## 6. `claim-editor.js` — the concrete entry

```js
const CLAIM_FIELDS = [
    { name: 'run_id',        label: 'Run id',     headerKey: 'run_key',    placeholder: 'TAS-1001' },
    { name: 'work_order_id', label: 'Work order', headerKey: 'work_order', placeholder: 'WO-2026-0851' },
    { name: 'platform',      label: 'Platform',   headerKey: 'platform',   placeholder: 'Porsche_Taycan', alwaysSend: true },
    { name: 'rig_id',        label: 'Rig',        headerKey: 'rig',        placeholder: 'RIG-04' },
    { name: 'vehicle',       label: 'Vehicle',    headerKey: 'vehicle',    placeholder: 'VIN, …' },
];

const BULK_FIELDS = ['work_order_id', 'platform', 'rig_id', 'vehicle'];
```

- **Position:** after the work order, before the rig. The run id stays first (it is the one
  that differs per file, `:18-19`); platform sits with the other campaign-scoped facts.
- **`BULK_FIELDS`: yes.** One bench session records one platform, so *"Use this work order,
  rig and vehicle for every file"* becomes *"…work order, platform, rig and vehicle…"*
  (`:141`). The `run_id` exclusion is untouched — *"copying it across a selection is
  precisely how four traces end up in one run"* (`:27-29`).
- **The mixed Taycan+Macan selection** is exactly why the per-file editor exists and why
  bulk is a button and not a shared card: the user picks four Macans, clicks bulk on one,
  then corrects the two Taycans individually.
- `CLAIM_NOTE` (`:32-36`) gains one sentence: the platform is sent whether or not it is
  retyped, because the decoder cannot read it out of the file.

---

## 7. Work breakdown

| # | What | Files | Owner |
|---|---|---|---|
| 1 | The flat `platform` key on the metadata message | `mf4-to-blob/metadata.py` — `build_payload` return dict (`:243-259`) + docstring (`:224-236`) | ArchDev |
| 2 | Shape check | `mf4-to-blob/metadata.py:47-51` — one `_DECLARED_PATTERNS` entry + the comment at `:44-46` ("These three" → "These four") | ArchDev |
| 3 | Read the header key | `mf4-to-blob/static/mdf-header.js:27-33` | ArchDev |
| 4 | The field, the bulk set, the always-send rule, the note, the bulk button label | `mf4-to-blob/static/claim-editor.js:20-36, :141, :226-236` | ArchDev + FrontEndEsthetic on the label/helper wording |
| 5 | The lake column agrees with the DBC | `mf4-decoder/main.py` — after `:804` | ArchDev |
| 6 | Seed `Porsche_Macan.dbc` (only when a second platform actually arrives) | `dcm-seed-dbc/dbc/`, `dcm-seed-dbc/app.yaml:19-20` | operator (the user) |

**Verification (red-first).** A test on `build_payload` asserting the flat `platform` key
carries the declared value, and one on `collect_declared` asserting `declared.platform=../x`
raises. Both red today. The decoder change is covered by feeding `process()` a metadata dict
with `platform` set and a header stating a different one, asserting the batch's
`file_scalars["platform"]` is the declared one.

---

## 8. Operational prerequisite — one DBC per platform, or the file decodes to nothing

`dcm-seed-dbc` files one configuration per `.dbc` in its `dbc/` directory, with
`metadata.target_key` = **the file's basename** (`dcm-seed-dbc/main.py:76, :108`;
`README.md:21-26`). So `platform=Porsche_Macan` needs `dcm-seed-dbc/dbc/Porsche_Macan.dbc`,
named exactly, listed in `DBC_NAMES` (`app.yaml:19-20`), and carrying no `VAL_` tables.

**If it is missing, trace the path honestly — this is a quiet failure:**

1. The DCM lookup misses. `fallback="default"` and the field `default=None` mean it lands
   as `None` rather than raising (`main.py:1133-1137`, `:600-603`).
2. `_decode_can_bus_logging` logs one WARNING — *"No DCM database resolved for this file —
   nothing can be decoded. Check that a 'dbc' configuration exists for its platform."*
   (`main.py:604-610`) — and returns `(None, [])`.
3. `decoded is None`, so **no decoded signals are emitted and the raw `CAN_DataFrame.*`
   channels are never emitted either** (`main.py:912-921`). The file produces **zero sample
   batches**.
4. A `file_complete` marker is still produced, with **no `decode_error`** — the load
   returned cleanly, it just returned nothing. The file registers in the Test Manager with
   an empty signal inventory.
5. **`mark_decoded` still runs** (`main.py:1056`), and its comment says why:
   *"`total_msgs == 0` is marked too — decoded-but-produced-nothing (no DBC, no decodable
   channel) is a completed decode."*

**So the file is permanently marked decoded.** Recovery needs the DBC seeded **and** new
bytes — the sha256 dedup skips an identical re-upload, so the route timestamp must change.
The batch is not "dropped"; it is never produced. Nothing turns red anywhere except one
WARNING line in the decoder log.

**This is a pre-existing failure mode, not one this spec introduces** — it fires today for
any platform without a DBC. But this spec makes a second platform *possible*, so it makes
this reachable. It belongs in the runbook, and it is the reason §7 item 6 says *seed the
DBC before the first upload of a new platform*, not after.

---

## 9. `work_orders.project` vs a declared platform — can they disagree?

Yes, and it costs nothing. The sink reads the work order's `$.project` **only** when the
batch's platform is `UNKNOWN`:

```python
platform = value.get("platform") or UNKNOWN
if platform == UNKNOWN:
    platform = value.get(F_WORK_ORDER_PLATFORM) or UNKNOWN   # expand.py:171-173
```

A declared platform makes the batch's value never `UNKNOWN`, so the fallback never fires and
there is no tie to break. The two fields are consulted in strict sequence, not compared. A
work order titled `project: EX90` holding a trace declared `Porsche_Macan` files the rows
under `platform=Porsche_Macan/` and shows `EX90` on the work-orders list, and both are
true statements about different things: one is the fleet the bytes came off, the other is
the programme the campaign is billed to. **No change, no warning, no reconciliation.**

## 10. The four existing lake rows

Under `platform=Porsche_Taycan/work_order=WO-2026-PT-001/run_id=TAS-100x/`. **Correct, and
untouched.** `platform` is already a partition column (`HIVE_COLUMNS` =
`platform,work_order,run_id,~channel_name,~sender_node,~frame_name,~signal`,
`mf4-datalake-sink/main.py:96-97`), the four traces state `Porsche_Taycan` in their own
header, and this spec changes only *which channel* supplies that value — not its name, its
type or its position. **No migration, no `TABLE_NAME` bump, no new `CONSUMER_GROUP`, no
re-sink.** (`main.py:122-124` is the rule that would have applied had the partition spec
moved. It does not move.)

## 11. Deferred

**Does an upload create a missing work order?** Out of scope here and now genuinely
separate: it was only entangled with this because the previous spec round routed `project`
through the work order. The standing facts, for whoever picks it up: `create_work_order`
(`api/api/services/queries_runs.py:1852`) is the only `work_orders` insert; the
`New work order` dialog on `/work-orders` already takes id + title + project; and the
claim-closing regression is being fixed in parallel from
`api/tests/test_work_order_closes_claims.py`.

## 12. Risks and open questions

- **Risk: a typo in the Platform field silently mis-files a file and picks no DBC.** The
  outcome is §8's quiet failure. Mitigation is the prefill — the correct value is already
  in the box — plus `_TM_ID`, which catches a path-shaped mistake but not a spelling one. A
  dropdown of seeded platforms would catch it, and would require `mf4-to-blob` to read DCM,
  which it does not do today. Not proposed. **OQ1.**
- **Risk: `alwaysSend` on one field of five is a rule with an exception.** The mitigation is
  the `CLAIM_NOTE` sentence (§6) and the comment at the `declaredQuery` condition. Anyone
  editing that function must see why one field is different.
- **OQ1:** should the Platform input be a free-text box (proposed) or a picker fed by the
  seeded DBC list? The picker is correct and costs `mf4-to-blob` a DCM read it has never
  had.
- **OQ2:** when a second platform arrives, does it want its own `battery-trace-gen`
  scenario set, or is the Macan case only ever real traces? Affects nothing in this spec;
  affects whether `_identity.json` grows a second identity.

## 13. Proposed backlog row

```json
{
  "id": "BL-74",
  "status": "to do",
  "title": "MF4 Import cannot declare a platform, so every upload gets DBC_PLATFORM's DBC and partition",
  "notes": "user 2026-09-25: 'imagine you are uploading traces for Porsche Taycan and Porsche Macan, cannot be stored under same project in lake'. SPEC DONE (dev-planning/upload-claims-platform/spec.md) - not built. Not the TM's work_orders.project; the field is the lake's `platform`, already a hive partition column AND the DCM target_key for the DBC lookup, and simply unfed: mf4-decoder/main.py:1131 reads value.get('platform') or DBC_PLATFORM, and nothing sends one, so a Macan trace is decoded with the TAYCAN DBC (wrong values, not just a wrong folder). Fix: claim-editor.js gains a Platform field prefilled from the recording's existing top-level `platform` HD property (mdf-header.js CLAIM_KEYS, no test. prefix - the traces already carry it, no regeneration), and mf4-to-blob/metadata.py::build_payload writes a FLAT `platform` key beside the existing flat `work_order` - the decoder reads the top-level key in an sdf.apply before the file is downloaded, never the declared bag. One deliberate break from the prefill rule: platform is sent even untouched, because the decoder cannot read the header in time and silence means DBC_PLATFORM. One new _DECLARED_PATTERNS entry (_TM_ID) - platform is path-shaped on two counts. Decoder: one statement after main.py:804 so provenance_fields['platform'] matches the DBC that was actually used. NO lake change - platform is already a partition column, the four existing rows are correct, no re-sink. Prerequisite: each platform needs dcm-seed-dbc/dbc/<PLATFORM>.dbc seeded BEFORE its first upload; a miss produces zero batches, no decode_error, and mark_decoded still fires (main.py:1056), so recovery needs the DBC plus new bytes."
}
```

## 14. References

- `dev-planning/import-prefill-from-trace/spec.md` — the claim editor this extends, and the
  prefill rule §5.1 deliberately breaks for one field.
- `dev-planning/upload-claims-project/spec.md` — superseded; kept as a stub pointing here.
- `CLAUDE.md` — the ingestion pipeline diagram, the DBC-from-DCM rule, `BL-01`.
- `dcm-seed-dbc/README.md:21-29` — the `target_key` = basename contract.
