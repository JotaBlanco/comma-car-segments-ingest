# MF4 Import — prefill the Test Manager claim from the recording

**Status:** Draft
**Project:** comma-car-segments-ingest
**Created:** 2026-09-24
**Planned with:** Buddy
**Branch / env:** `jama-ui-dev` / `testrigorg-commacarsegmentsingest-jamaui`
**Backlog:** no row yet — proposed text in §11.2
**Scope:** browser page only. No change to the precedence ladder, the decoder, the
connector, the sink or the Test Manager API.

---

## 0. Summary

The MF4 Import page asks a person to type a work order, a run id, a rig and a vehicle
that the recording **already states about itself** in its MDF4 HD comment. On
2026-09-24 four battery traces were uploaded with that form filled in by hand, and the
typed values — which outrank the file by design — overwrote the correct ones. An empty
form would have been right.

This feature makes the correct answer the **default**: the page reads the file's own
`test.*` header properties in the browser before any upload and shows them in the claim
fields, per file. A field the user does not touch is **not sent**, so the recording
remains the source and the ladder resolves it exactly as it does for a blank form today.
A field the user edits rides as `declared.*` and wins, which is the existing behaviour
and the user's stated rule: *"prefill with trace data, on retyping by user it wins."*

---

## 1. What actually went wrong

No code swaps a field. The path `form → declared.<name> → mf4_metadata.declared →
mf4-decoder CLAIMED_COLUMNS → lake column` was traced end to end and every field stays in
its own lane. `project` on a run is a separate lineage — it is read off the run's
work-order mirror (`api/api/services/queries_runs.py:142-143`), never off the rig.

The values are wrong because **a typed claim beats the recording, by design**
(`mf4-to-blob/metadata.py:226-231`, "A caller's claim always wins"), and the form was
filled in with a work order, a rig and a vehicle that disagree with the traces:

| Claim | The trace states (`battery-trace-gen/scenarios/_identity.json:8-15`) | What was typed → what landed in `battery_data_v1` |
|---|---|---|
| work order | `WO-BAT-2026-001` | `WO-2026-PT-001` |
| rig | `battery-sim-01` | `0225` |
| vehicle | `WP0ZZZY1ZMSA10042` | `Taycan` |
| platform | `Porsche_Taycan` (header, not the form) | `Porsche_Taycan` — correct |

The fix is not to the ladder. The ladder is right. The fix is to stop the form being a
blank invitation to invent.

---

## 2. Goals

- Every claim field arrives **prefilled from the selected file's own HD comment**, before
  any byte is uploaded.
- Each file in a multi-file selection carries **its own** claim, because each states its
  own `test.run_key`.
- A prefilled field that the user does not touch **states nothing on the wire** — the
  recording stays the source of the fact.
- A field the user edits is sent as `declared.<name>` and wins, exactly as today.
- The page never guesses. A recording that states nothing leaves the field blank.

## 3. Non-goals

- No change to `mf4-to-blob/metadata.py`, `mf4-decoder/identity.py`,
  `tm-connector/connector/identity.py`, the sink or the API. The shape checks at
  `metadata.py:39,47-51` stay exactly as they are and no new one is added.
- No client-side validation of what the user types. The server is the door
  (`main.py:196-199`, `:363-367`) and its 400 already surfaces in the file row
  (`index.html:507-511`).
- No prefill from the **filename**. Two server-side rungs already read the filename
  (`metadata.py:166-188` for `WO-`, `identity.py:109-116` for `TAS-\d+`); a third copy in
  the browser could disagree with them.
- No correction of the four already-uploaded runs as part of this build. §9 states the
  options and their cost; the user decides.
- No new field on the form. The four inputs stay four.

---

## 4. Decision 1 — the header is read in the browser, from two ranged slices

**Chosen: (a) client-side parse of `File.slice()` reads. Rejected: (b) a server
`POST /inspect` endpoint.**

### 4.1 Why

- On an Azure workspace the browser PUTs straight to blob storage and **the server never
  holds the bytes** (`main.py:1-31`). An inspect endpoint would need the browser to read
  the ranges anyway and then post them back — the same parse, plus a round trip.
- The page already owns the `File` object on both paths (`index.html:524`, `:560`).
- A prefill that needs the network is a prefill that is late. The read must finish
  between "file dropped" and "user looks at the card".

### 4.2 The layout the reader depends on

ASAM MDF 4.x, fixed by the standard:

| Offset | Bytes | Meaning |
|---|---|---|
| `0x00` | 64 | ID block (`MDF     ` or `UnFinMF `) |
| `0x40` | 4 | `##HD` — block id |
| `0x44` | 4 | reserved |
| `0x48` | 8 | `block_len`, uint64 LE |
| `0x50` | 8 | `links_nr`, uint64 LE — 6 for an HD block |
| `0x58` | 48 | the six links, int64 LE: `dg_first`, `fh_first`, `ch_first`, `at_first`, `ev_first`, **`md_comment`** |
| `0x80` | 8 | `md_comment` — the absolute file offset of the `##MD` block |

At `md_comment`: the same 24-byte block header (`##MD`, reserved, `block_len`,
`links_nr`=0), then `block_len - 24` bytes of UTF-8 XML, NUL-terminated and padded to an
8-byte boundary.

The XML is the `<HDcomment>` the generator writes
(`battery-trace-gen/bus/mf4.py:73-85`), whose `<common_properties>` block carries
`<e name="test.rig">battery-sim-01</e>` and friends
(`battery-trace-gen/bus/mf4.py:88-109`).

### 4.3 The read

Two ranged reads, no branch between them:

1. `await file.slice(0, 136).arrayBuffer()` — 136 bytes. Confirm `##HD` at byte 64;
   read `links_nr` at 80 and `md_comment` at 128.
2. `await file.slice(md, md + 24 + MAX_COMMENT_BYTES).arrayBuffer()` with
   `MAX_COMMENT_BYTES = 1 << 20`. `Blob.slice` clamps past EOF, so a short file needs no
   length check. Read `block_len` out of the same buffer, decode
   `bytes[24 … min(block_len, 24 + MAX_COMMENT_BYTES))` as UTF-8, cut at the first NUL,
   hand to `DOMParser`.

**The "comment is 2 GB into the file" risk is answered by the read model, not by a
guard.** `Blob.slice()` returns a lazy reference and `arrayBuffer()` reads only that
range — cost is O(range), not O(offset). A 2 GB MF4 whose `##MD` sits at the very end
costs 136 bytes plus at most 1 MiB. Nothing streams the file.

### 4.4 The parse, mirroring the decoder

`readHeaderClaims` walks the parsed document exactly as
`mf4-decoder/provenance.py:68-108` walks it, so the browser and the decoder cannot read
one file two ways:

- match on the **local** tag name, so a namespaced `<HDcomment>` parses
  (`provenance.py:55-65`);
- walk the whole `common_properties` subtree, not only its direct children
  (`provenance.py:95-100`);
- **first occurrence wins** on a repeated `name` (`provenance.py:101-103`).

It returns the four values the form owns, and nothing else:

| Header key | Form field | `declared.*` name it would ride as |
|---|---|---|
| `test.run_key` | Run id | `declared.run_id` |
| `test.work_order` | Work order | `declared.work_order_id` |
| `test.rig` | Rig | `declared.rig_id` |
| `test.vehicle` | Vehicle | `declared.vehicle` |

The mapping is the decoder's and the connector's, unchanged:
`mf4-decoder/identity.py:59,63,71-74` and
`tm-connector/connector/identity.py:84-94,132-133`.

### 4.5 When the header cannot be read

`##HD` missing, `links_nr < 6`, `md_comment == 0`, the XML unparseable, no
`common_properties`, or the read itself rejecting (the user moved the file after picking
it) — all land in **one** outcome: `entry.header = {}`, the fields stay blank, the row
says *"this recording states no Test Manager claim"*. Never a guess, never a filename
fallback, never an error dialog: an MF4 with no `test.*` block is an ordinary upload, not
a fault. That is the same posture `provenance.py:68-74` takes.

### 4.6 No new dependency

No JS MDF library is pulled in. The reader is ~70 lines of `DataView` reads plus the
browser's own `DOMParser`, against a layout fixed by the ASAM standard. A CDN dependency
here would be strictly worse than the one the page already tolerates: `@azure/storage-blob`
is imported dynamically and only on the SAS path (`index.html:234-242`), so a blocked CDN
is survivable today; a prefill library loaded on every page view would not be.

---

## 5. Decision 2 — claims move into the file row, one card per file

**Chosen: per-file claim editor inside each file row. The single shared card at
`index.html:201-221` is removed.**

### 5.1 Why

One card cannot state four run ids. The traces prove it: `TAS-1001`…`TAS-1004`, four
files, four runs (`battery-trace-gen/out/manifest.json`). The asymmetry the brief names
is real and it drives the shape:

- `run_id` — **differs per file, always.** It must live on the row.
- `work_order_id`, `rig_id`, `vehicle` — **usually agree**, and are usually already in
  the header, so in the common case the operator types none of them.

The shared card existed to spare repeated typing. Once the recording's values are
visible in every row, the common case is **zero typing**, and the thing the shared card
saved stops being worth the lie it enables.

### 5.2 The row

Collapsed (default):

```
 TAS-1001_T1_charge_thermal.mf4                        364 KB   ×
 from the recording · TAS-1001 · WO-BAT-2026-001 · battery-sim-01
                                                            Edit
 ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

- The summary line lists only the claims the header actually stated, in the order run,
  work order, rig, vehicle.
- A file whose header states nothing shows *"this recording states no Test Manager
  claim"* and its editor is **expanded on arrival** — there is nothing to summarise, and
  that is exactly the case where a claim may need typing.
- `Edit` toggles the four-input grid for that file only.

### 5.3 Bulk claiming

Inside an expanded editor, one link: **"Use this work order, rig and vehicle for every
file"**. It copies those three values into every other entry and marks them edited (they
were typed — by this control).

**Run id is deliberately not copied.** The other three describe the campaign; the run id
identifies *this* recording. Copying it across a selection is precisely how four traces
end up in one run.

### 5.4 Staleness is gone by construction

Today the card persists across add/remove, so values picked up for file A can ride on
file B. With the claim living on the entry, a removed file takes its claim with it and an
added file brings its own. Nothing can transfer but the explicit bulk control above.

---

## 6. Decision 3 — dirty-tracking: an untouched prefill is not a claim

**Chosen: a field rides as `declared.<name>` only if the user typed in it.**

### 6.1 The rule

| Field state | Chip | On the wire |
|---|---|---|
| prefilled, untouched | `from the recording` (muted) | **nothing** |
| typed (any `input` event) | `typed` (accent) + `↺` revert | `&declared.<name>=<value>` |
| typed then cleared | `typed`, empty | **nothing** — see §6.3 |
| blank, untouched (header stated none) | none | nothing |

Dirty is set by the `input` event, unconditionally — no comparison against the prefill.
Retyping the identical string still counts, because the user's rule is about the *act* of
typing, and a comparison would be a branch earning nothing.

`↺` restores the header value and clears dirty. Without it there is no way back from a
stray keystroke to "the recording answers this", and a mistyped character would convert a
field permanently — which is the whole defect, in miniature.

### 6.2 Why not just send the prefill

Sending an untouched prefill would be **very nearly harmless** — the value equals the
header's, so `resolve_work_order` (`mf4-decoder/identity.py:151-176`) and `resolve_claims`
(`:179-196`) land on the same answer either way, and the registry tags every
ingestion-resolved field `embedded` whatever the body says
(`api/api/services/queries_runs.py:151-160` — "the pipeline states the id; it never
states the authority"), so no source tag would be falsified downstream. That is worth
saying plainly: **the provenance lie is confined to `mf4_metadata.declared` on the wire
and to the connector's conflict note; it is not recorded in the Test Manager.**

It is still the wrong default, for three reasons that survive that finding:

1. **A declared bag is a claim, and a claim has a blast radius.** A declared `run_id`
   that names a different run than the resolved one makes the connector refuse the whole
   record's assertions (`tm-connector/connector/identity.py:336-354`). A bag that states
   only what a person actually asserted can never trip it.
2. **`declared` is forwarded verbatim by everything downstream** and is the first rung of
   every ladder. Filling it with facts nobody stated makes the one channel that means
   "an operator decided this" stop meaning anything.
3. The user's rule is literally *on retyping by user it wins*. Not-retyped is therefore
   not a user claim.

### 6.3 Clearing a field is not a claim either

There is no wire spelling for "the recording is wrong and the answer is nothing":
`declared.run_id=` is a malformed claim the server refuses (`metadata.py:130-163`, and
the existing note at `index.html:452-455`). So a cleared field sends nothing and the
recording's value stands. The copy says so (§7).

### 6.4 Two consequences, both accepted, both status-quo

- **Blob folder.** `_run_folder` (`main.py:140-155`) uses `declared.run_id`, then the
  `TAS-\d+` filename rung. With an untouched prefill it falls to the filename rung —
  which these four traces satisfy (`TAS-1001_T1_charge_thermal.mf4`). A recording with
  neither a declared run nor a matching filename lands under `unassigned/`, exactly as a
  blank form does today. No regression; not fixed here (see OQ1).
- **`x-ms-meta-vehicle`.** `object_metadata` (`metadata.py:75-82`) stamps the vehicle on
  the stored object only from `declared`. An untouched prefill leaves it unstamped —
  again, exactly what a blank form does today. If the user wants the car legible from the
  blob for every upload, that belongs in the decoder or a later step, not in a faked
  declaration (OQ1).

---

## 7. Decision 4 — the copy

`— optional` (`index.html:202`) and *"Blank is a real answer"* (`:217-220`) both become
misleading the moment the fields arrive filled. Replacement, on the row's editor:

> **Test Manager claim** — *read from the recording*
>
> These values come from the file's own header. Change one only if it is wrong: what you
> type is sent as your claim and outranks the recording. Clearing a field is not a claim
> — the recording's value is used. A field the recording does not state stays blank, and
> a blank field is resolved from the file when it is decoded.

Summary line prefix when the header stated something: `from the recording ·`.
Summary line when it stated nothing: `this recording states no Test Manager claim`.

The HTML comment at `index.html:186-200` is rewritten in the same edit: its sentence
*"Everything is OPTIONAL: an upload that claims nothing still registers"* stays true, but
*"A claim typed here BEATS one written into the filename"* now needs the second half —
it also beats the one written into the header, which is the entire point of the page.
(Project rule: a comment that outlives the code it described is a defect.)

---

## 8. Work breakdown

### 8.1 `mf4-to-blob/static/mdf-header.js` — NEW (~70 lines) · ArchDev

Exports one function:

```js
export async function readHeaderClaims(file)  // -> {run_key?, work_order?, rig?, vehicle?}
```

Implements §4.3 and §4.4. Returns `{}` for every unreadable case (§4.5) — one `try`, no
per-case handling. Module-level constants: the four `test.*` keys, `MAX_COMMENT_BYTES`.

**Verify before writing the parser:** dump the first 136 bytes of
`battery-trace-gen/out/TAS-1001_T1_charge_thermal.mf4` and confirm `##HD` at `0x40`, a
`links_nr` of 6 at `0x50` and a non-zero `md_comment` at `0x80`, then confirm `##MD` at
that offset. The generator writes through asammdf (`bus/mf4.py:178-186,205`), which
follows the standard, but the offsets in §4.2 are the load-bearing part of this spec and
one hexdump settles them.

### 8.2 `mf4-to-blob/main.py` — 3 lines · ArchDev

The page stops being one file, so the module must be servable. There is no static mount
today (`main.py:158-161` reads `static/index.html` by hand):

```python
from fastapi.staticfiles import StaticFiles
app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")
```

The page imports `/static/mdf-header.js` — **absolute**, because the document is served
at `/` and a relative specifier would resolve to `/mdf-header.js`. `GET /` keeps reading
the HTML by hand; it is not moved under the mount.

No other Python change. `metadata.py` is untouched and `tests/test_import_claim.py` stays
green.

### 8.3 `mf4-to-blob/static/index.html` — the page · ArchDev + FrontEndEsthetic

1. **Delete** the shared fieldset (`:201-221`) and rewrite the comment above it
   (`:186-200`).
2. **`addFiles` (`:289-308`)** — each entry gains `header: null`, `claims: {run_id: {value, dirty}, …}`
   and `expanded: false`. After pushing, kick off `readHeaderClaims(f)` per entry; on
   resolve set `entry.header`, seed each `claims[*].value` from it, set
   `expanded = isEmpty(entry.header)`, re-render. The reads are independent — fire them
   all, do not queue.
3. **`render` (`:318-380`) — rewritten to update in place.** This is the one real hazard:
   `render()` is called on every progress event and currently rebuilds
   `fileList.innerHTML` wholesale, which would destroy a half-typed input and its focus
   several times a second during an upload. The new shape:
   - create a row node once per entry and keep it on `entry.row`;
   - remove rows whose entry is gone;
   - on each call update only the mutable bits — status text, row class, fill width,
     presence of the remove button.
   Net effect is roughly the same line count; it is a rewrite of one function, not a new
   layer.
4. **The claim editor** — built once per entry inside its row. Four inputs, each with its
   chip and its `↺`; `oninput` sets `dirty = true` and repaints the chip; `↺` restores
   `entry.header[...]` and clears `dirty`. The bulk link of §5.3.
5. **`declaredQuery` (`:447-471`) → `declaredQuery(entry)`** — same output shape, same
   leading `&`, same "empty contributes nothing" rule, now reading
   `entry.claims[name].dirty && value` instead of the DOM. Its existing comment about an
   empty value staying off the wire survives verbatim; the "read at SEND time" paragraph
   is rewritten, because the claim is now read off the entry and a late edit still
   travels (the entry is live).
6. **Call sites** — `startDirectUpload` (`:480-481`) and `startSasUpload` (`:535`) pass
   their entry. Both already run per file, so nothing else moves.
7. **Styling** — the `.claim*` rules (`:138-178`) are light-themed against a dark page
   (`#374151` labels on `#1c1f26`); moving into the row is the moment to fix that.
   Chips, the `↺` and the collapsed summary line are FrontEndEsthetic's.

### 8.4 Documentation · DocuGuy

`mf4-to-blob/README.md` if it describes the claim card; the backlog row of §11.2. The
project CLAUDE.md's ingestion section needs no edit — the ladder it documents does not
change.

---

## 9. Decision 5 — the four runs already in the estate

The lake holds, for all four runs, `work_order=WO-2026-PT-001` (a **partition**
directory), `rig_id=0225` and `vehicle=Taycan` (plain columns inside the parquet —
`mf4-datalake-sink/expand.py:174,177-178`; partition tree
`platform,work_order,run_id` per `docker-compose.local.yml:293`).

**The two halves have completely different costs, and the registry half is cheap.**

### 9.1 The registry — correctable in place, today, no re-upload

`PATCH /test-runs/{run_id}` exists (`api/api/routers/test_runs.py:274`). A `manual` write
outranks `embedded` (`api/api/provenance.py:41-49`), so the rig and the work order on
`TAS-1001`…`TAS-1004` can simply be corrected. The vehicle is a **file**-level fact, not
a run field (`tm-connector/connector/identity.py:30-33,132-133`), so it is corrected on
the file document.

Worth checking first: `WO-2026-PT-001` is not in the planning mirror (only
`WO-BAT-2026-001` was seeded, `battery-trace-gen/seed/planning_payload.py:25`), so
`_resolve_claims` (`api/api/services/queries_runs.py:117-144`) will have left it
unresolved — the four runs are probably sitting amber with `claimed_work_order_id` set
and no `work_order_id`. `GET /test-runs` answers it in one call.

### 9.2 The lake — needs new bytes. There is no cheap path.

Three things are true at once:

1. The lake is append-only; nothing in this repo rewrites a partition.
2. The decoder dedups on the **sha256 of the content** for direct uploads, and this
   workspace is S3Compatible so every upload is direct
   (`mf4-decoder/idempotency.py:12-35`). Re-uploading the same four files is a no-op.
3. **A decoder consumer-group rotation does not help and actively hurts.** It abandons
   the dedup state (`idempotency.py:53-57`) and replays every `mf4_metadata` message ever
   produced — including the four carrying the *wrong* `declared` bag. It would reproduce
   the defect, at the cost of re-decoding the whole backlog.

So correct rows require **new messages carrying new bytes**. The options:

| Option | What it takes | Cost |
|---|---|---|
| **A — regenerate + re-upload** | Change each scenario's `start_time_utc`, regenerate (the route is `{device}--{date}--{time}`, `_identity.json:7`), upload through the new page with nothing typed | The four trace sha256s in `out/manifest.json` move — BL-57 verified them unmoved, so this deliberately breaks that. `test.started_at/ended_at` and the lake `route` column change. Run keys stay `TAS-1001`…`TAS-1004`, so the registry gains a **second file** per run (BL-68/BL-69 territory) |
| **B — A, plus drop the stale partition** | A, then drop `platform=Porsche_Taycan/work_order=WO-2026-PT-001/` | Without it the estate holds `TAS-100x` rows under **two** work orders and a query by run id returns both, with conflicting rig and vehicle. This is the only option that leaves the lake consistent |
| **C — drop `battery_data_v1` entirely and re-ingest** | B with a clean table | Loses every other route in the table. Note it does **not** remove the need for new bytes: the dedup state lives in the decoder's State store, not in the table |
| **D — rewrite the parquet in place** | Hand-edit files + Iceberg metadata outside the pipeline | No tooling here. Named for completeness; not recommended |

**Recommendation: §9.1 now, and B when the prefill ships.** Nothing is deleted as part of
this feature — the user drops lake partitions themselves.

---

## 10. Data & interface contracts

**Nothing on the wire changes shape.** The request is byte-identical to one a human would
produce today by typing exactly what the recording states:

- `POST /upload/direct?filename=…&size=…[&declared.<name>=<value>]*` — unchanged
  (`main.py:344-349`), now carrying only the fields the user edited.
- `POST /upload/sas?declared.<name>=<value>…` — unchanged (`main.py:187`).
- `mf4_metadata.declared` — unchanged shape (`metadata.py:191-250`), a smaller bag in
  practice.
- No new query parameter, no new route, no new topic, no new lake column, no migration.

New internal contract, browser-only:

```js
readHeaderClaims(file) -> Promise<{run_key?: string, work_order?: string,
                                   rig?: string, vehicle?: string}>
```
Keys absent when the header does not state them. `{}` when the header cannot be read.

---

## 11. Risks, constraints, open questions

### 11.1 Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | `render()` rebuilding the list destroys a half-typed input mid-upload | §8.3.3 — rows are built once and updated in place. This is the defect most likely to ship unnoticed: it only bites while an upload is in flight |
| R2 | The HD/MD offsets in §4.2 are wrong for some writer | §8.1 verification step — one hexdump of a real trace before the parser is written. Unreadable ⇒ blank fields, which is the existing behaviour |
| R3 | `md_comment` points far into a large file | Ranged read is O(range) (§4.3). No mitigation needed; stated because it reads like a problem and is not |
| R4 | A header value that `_TM_ID` (`metadata.py:39`) refuses, e.g. a rig with a space, is edited by the user → 400 | Deliberately not guarded. The server is the door and its message already renders in the row (`index.html:507-511`). Adding a client-side shape check would be a second validator to keep in sync |
| R5 | `/static` mount changes the app's URL surface | One mount, one directory that already exists and already contains only the page |
| R6 | The page's dark theme vs. the light `.claim` styles | §8.3.7 |

### 11.2 Proposed backlog row (the caller adds it; Buddy does not edit `backlog.json`)

> `BL-72` | to do | MF4 Import prefills the Test Manager claim from the recording's own
> header; only a retyped field is declared | user 2026-09-24, after four traces were
> uploaded with a hand-typed work order / rig / vehicle that overwrote the correct
> `test.*` claims. SPEC DONE (`dev-planning/import-prefill-from-trace/spec.md`). Browser
> only: one new `static/mdf-header.js`, a `/static` mount, per-file claim cards. Does not
> touch the ladder — §9 lists what it takes to correct the four runs already in the lake

### 11.3 Open questions — these need the user

- **OQ1.** Should an *untouched* prefilled value still ride to the server as a
  non-authoritative hint, so the blob lands in the run's folder (`main.py:140-155`) and
  the vehicle is stamped on the object (`metadata.py:75-82`)? §6.4 says no, and the
  behaviour is identical to today's blank form — but it is the one place where "declared"
  buys something real, and it would cost one query parameter that never enters the
  `declared` bag.
- **OQ2.** Which lake option in §9.2 — and is regenerating the traces (which moves the
  four sha256s BL-57 verified unmoved) acceptable?
- **OQ3.** Are `TAS-1001`…`TAS-1004` currently amber in the Test Manager with
  `claimed_work_order_id = WO-2026-PT-001`? One `GET /test-runs` settles whether §9.1 is a
  PATCH or a re-claim.

---

## 12. Alternatives considered

1. **Server-side `POST /inspect`.** Rejected: on the SAS path the server never sees the
   bytes, so the browser would have to read the ranges and post them anyway — the same
   parse plus a round trip (§4.1).
2. **Prefill from the filename as well as the header.** Rejected: two server-side rungs
   already read the filename (`metadata.py:166-188`, `identity.py:109-116`); a browser
   copy would be a third implementation of the same ladder, free to disagree.
3. **Keep one shared claim card, prefilled only where all selected files agree.**
   Rejected: `run_id` never agrees, so the field that actually needs stating would always
   be the blank one, and the card would be most confident exactly where it is least
   useful.
4. **Send the prefill verbatim; no dirty-tracking.** Rejected in §6.2 — and note the
   honest finding there: the registry would not record the difference, so the objection
   rests on blast radius and on the meaning of the `declared` channel, not on a falsified
   source tag.
5. **A JS MDF4 library.** Rejected: nothing mature exists for MDF4 in the browser, and
   the read is ~70 lines against a standardised layout (§4.6).
6. **Make the header outrank a typed claim** (the narrow reading of "the trace is
   right"). Rejected: it breaks re-upload with a corrected id, contradicts the user's own
   rule, and would have to change `metadata.py`, both `identity.py` files and the
   connector's documented precedence — the ladder is not the bug.

---

## 13. References

- The page: `mf4-to-blob/static/index.html` — card `:201-221`, `declaredQuery`
  `:447-471`, `render` `:318-380`, `addFiles` `:289-308`.
- The door: `mf4-to-blob/main.py:187,344` · `mf4-to-blob/metadata.py:130-163,191-250`.
- The ladder: `mf4-decoder/identity.py:1-43` (the rungs, in prose) ·
  `tm-connector/connector/identity.py:1-46`.
- The header parse to mirror: `mf4-decoder/provenance.py:55-108`.
- Dedup: `mf4-decoder/idempotency.py:12-35,53-57`.
- Lake columns and partitions: `mf4-datalake-sink/expand.py:143-189` ·
  `docker-compose.local.yml:293`.
- Registry precedence and claims: `api/api/provenance.py:41-49` ·
  `api/api/services/queries_runs.py:79,117-144,151-160`.
- What the traces state: `battery-trace-gen/scenarios/_identity.json` ·
  `battery-trace-gen/bus/mf4.py:73-109,152-186` · `battery-trace-gen/out/manifest.json`.
- Related specs: `dev-planning/versions-and-links/spec.md` (BL-68/BL-69 — a re-upload
  under an existing run creates a second file), `dev-planning/tm-multi-definition-runs/spec.md`
  (the `test.*` claim chain end to end).
