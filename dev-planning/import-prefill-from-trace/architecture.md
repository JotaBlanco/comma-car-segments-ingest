# MF4 Import prefill — architecture

**Branch:** `jama-ui-dev` · **Built:** 2026-09-24 · **Spec:** `dev-planning/import-prefill-from-trace/spec.md`
**Scope:** the `mf4-to-blob` browser page, one static mount and one extra object-metadata
channel. The precedence ladder, the decoder, the connector, the sink and the Test Manager API
are untouched.

## What it does

The MF4 Import page reads each picked recording's own `test.*` HD-comment properties in the
browser — two ranged `File.slice()` reads, no upload, no round trip — and shows them in a claim
editor that lives on that file's row. A field the operator does not touch states **nothing** on
the wire, so the recording remains the source of the fact and `mf4-decoder/identity.py` resolves
it exactly as it does for a blank form. A field the operator types rides as `declared.<name>` and
outranks the recording, which is what the ladder has always done. The four uploads that started
this work were wrong because a person typed over three correct header claims into a blank shared
card; the card is gone and the fields now arrive correct.

## Why this shape

**The header is read in the browser.** On an Azure workspace the browser PUTs straight to blob
storage and the server never holds the bytes, so a `POST /inspect` endpoint would need the
browser to read the ranges and post them back — the same parse plus a round trip. `Blob.slice()`
is a lazy reference and `arrayBuffer()` reads only the range, so a 2 GB file whose `##MD` block
sits at the very end costs 136 bytes plus at most 1 MiB. Nothing streams the file.

**One claim editor per file.** One card cannot state four run ids, and the traces prove it:
`TAS-1001`…`TAS-1004` are four files and four runs. `run_id` differs per file always;
`work_order_id`, `rig_id` and `vehicle` usually agree and are usually already in the header, so
the common case is zero typing. Staleness dies by construction — a removed file takes its claim
with it, and nothing transfers between rows but the explicit bulk control.

**Dirty-tracking, not "send the prefill".** Sending an untouched prefill would land on the same
answer downstream (the registry tags every ingestion-resolved field `embedded` whatever the body
says), but `declared` is the one channel that means *an operator decided this*: a declared
`run_id` naming a different run than the resolved one makes the connector refuse the whole
record's assertions. A bag stating only what a person actually asserted cannot trip it. Dirty is
set by the `input` event unconditionally — no comparison against the prefill, because the user's
rule is about the act of typing. `↺` restores the header value and clears dirty; without it a
stray keystroke would convert a field permanently, which is this page's defect in miniature.

**A cleared field sends nothing.** There is no wire spelling for "the recording is wrong and the
answer is nothing": `declared.run_id=` is a malformed claim the server refuses
(`metadata.py::collect_declared`). The note in the editor says so.

**`render()` updates in place.** This is the load-bearing change. `render()` runs on every
XHR/Azure progress event, several times a second per upload; the old function rebuilt
`fileList.innerHTML` wholesale, which would now destroy a half-typed claim and its focus. Rows
are built once (`buildRow`) and kept on `entry.parts`; `render()` removes rows whose entry is
gone, appends rows for new entries and then calls `updateRow()`, which touches only the row
class, the status text, the fill width, the remove button's `hidden` and the error text. Nothing
an operator can be in the middle of editing is written by the progress path. The claim's own
paint (`paintClaims`) repaints the summary line, the chips, the revert buttons and the editor's
open state, and it **never writes an input's value** — which is why it is safe to call from the
input handler itself, on every keystroke.

**The page is four files.** `index.html` was already past the 500-line ceiling with its style
block and an inline module, and the claim editor roughly doubles the logic; the `/static` mount
the parser needs makes the split free. The document keeps markup and CSS (259 lines),
`upload-page.js` owns the entries, the queue and both upload paths (376), `claim-editor.js` owns
the claim state and its UI (247), `mdf-header.js` owns the reader (96). The dependency runs one
way — `upload-page → claim-editor → mdf-header` — and the seam is the obvious one: the claim
module knows nothing about uploading, the upload module knows nothing about `declared.*` beyond
asking for the two query strings. Module scripts are deferred, so the script tag's position does
not matter. Ownership of the entry object is split the same way: `upload-page` owns
`entry.parts` (status, fill, remove, error), `claim-editor` owns `entry.claims`, `entry.header`
and `entry.claimUi`.

**The object-metadata stamp got its own channel (OQ1).** `x-ms-meta-vehicle` exists because the
car must be legible from the blob alone, and it was stamped from `declared` — which, under
dirty-tracking, is empty for an untouched vehicle. The page therefore sends the recording's own
vehicle as a plain `vehicle=` query parameter, *outside* the `declared.` prefix, so
`collect_declared` never sees it and nothing downstream reads it as a claim.
`metadata.object_metadata(declared, stated)` merges the two with the claim on top. Five lines
total: the parameter on both upload routes, the stash on the SAS path's progress record (the SAS
path decides everything at mint time and `/upload/complete` reads it back), and the merge.

## The layout the reader depends on

ASAM MDF 4.x, fixed by the standard. Verified by hexdump against
`battery-trace-gen/out/TAS-1001_T1_charge_thermal.mf4` before the parser was written (§8.1 of the
spec), values in the right-hand column:

| Offset | Bytes | Meaning | TAS-1001 |
|---|---|---|---|
| `0x00` | 64 | ID block | `MDF     4.10    amdf8.8.` |
| `0x40` | 4 | `##HD` block id | `##HD` ✔ |
| `0x44` | 4 | reserved | `00 00 00 00` |
| `0x48` | 8 | `block_len`, uint64 LE | `0x68` = 104 |
| `0x50` | 8 | `links_nr`, uint64 LE | 6 ✔ |
| `0x58` | 48 | six int64 LE links: `dg_first`, `fh_first`, `ch_first`, `at_first`, `ev_first`, `md_comment` | `0x59840`, `0x59808`, 0, `0x5a230`, 0, `0xa8` |
| `0x80` | 8 | `md_comment` — absolute file offset of the `##MD` block | 168 ✔ |

At `md_comment`, the same 24-byte block header (`##MD`, 4 reserved, uint64 `block_len`, uint64
`links_nr` = 0), then `block_len - 24` bytes of UTF-8 XML, NUL-terminated and padded to an 8-byte
boundary. On TAS-1001: `##MD` at 168, `block_len` `0x888` = 2184, text from 192, first bytes
`<HDcomment>\n<TX>Synthetic battery CAN recording…`, carrying `test.run_key` `TAS-1001`,
`test.work_order` `WO-BAT-2026-001`, `test.rig` `battery-sim-01`, `test.vehicle`
`WP0ZZZY1ZMSA10042`.

`MAX_COMMENT_BYTES` is 1 MiB; `Blob.slice` clamps past EOF, so a short file needs no length
check, and `block_len` is an upper bound on the text because of the padding — the decode stops at
the first NUL.

The parse mirrors `mf4-decoder/provenance.py::parse_header_properties` deliberately, so the
browser and the decoder cannot read one file two ways: match on the **local** tag name (a
namespaced `<HDcomment>` parses), walk the whole `common_properties` subtree rather than its
direct children, **first occurrence wins** on a repeated `name`.

Every failure — `##HD` absent, `md_comment` zero, `##MD` absent, a short or unparseable block,
the read itself rejecting because the user moved the file — lands in one `try` and answers `{}`:
the fields stay blank and the row says *this recording states no Test Manager claim*. An MF4 with
no `test.*` block is an ordinary upload, not a fault, which is the posture `provenance.py` takes.

**Deviation:** the spec also names `links_nr < 6` as a checked case. It is not checked. With
fewer than six links, offset `0x80` lands inside the HD data section and the `##MD` check
immediately below rejects whatever it produces, so the test would earn nothing.

## Data flow

```
file picked / dropped
  └─ addFiles()  initClaims(entry)     entry.claims = 4 × {value:'', dirty:false}, header:null
       ├─ render()                     row built once (entry.parts), claim block built once
       └─ loadHeader(entry)            mdf-header.js — 2 ranged reads, DOMParser
            └─ applyHeader(entry, {run_key?, work_order?, rig?, vehicle?})
                 ├─ claims[*].value = stated   (skipped where the user already typed)
                 ├─ expanded = header states nothing
                 └─ paintClaims()      summary line · chips · ↺ · editor open state

operator types  ──input──▶  claims[name] = {value, dirty:true} ──▶ paintClaims()
operator clicks ↺ ──────▶  claims[name] = {header value, dirty:false}
operator clicks bulk ───▶  every OTHER entry's work_order_id/rig_id/vehicle = source's, dirty:true

Upload selected files
  └─ per entry: declaredQuery(entry)   only dirty AND non-empty fields
                stampQuery(entry)      the recording's vehicle, always
       ├─ direct: POST /upload/direct?filename&size[&declared.*][&vehicle]
       └─ sas:    POST /upload/sas[?declared.*][&vehicle] -> PUT to Azure -> POST /upload/complete

progress event ──▶ render() ──▶ updateRow()   status · class · fill · remove · error
                                              (never an input, never the editor)
```

Server side, unchanged except the stamp: `collect_declared` collects the `declared.` prefix only,
`build_payload` nests it under `declared` plus the lake's flat `work_order` spelling, and
`object_metadata(declared, {"vehicle": …})` decides what `x-ms-meta-*` the stored object carries.

## File inventory

| File | Change | Why |
|---|---|---|
| `mf4-to-blob/static/mdf-header.js` | **new**, 96 lines | `readHeaderClaims(file)` — the two ranged reads and the `common_properties` walk. No dependency; `DataView` plus the browser's `DOMParser` |
| `mf4-to-blob/static/claim-editor.js` | **new**, 247 lines | `entry.claims`, the prefill, the per-file editor, the chips and `↺`, the bulk control, `declaredQuery(entry)` and `stampQuery(entry)`. `CLAIM_FIELDS` maps each `declared.*` name to the header property it is prefilled from — the one place the four names are spelled |
| `mf4-to-blob/static/upload-page.js` | **new**, 376 lines | The page logic, moved out of `index.html`'s inline module: entries, `render()`/`buildRow()`/`updateRow()`, the queue, both upload paths (verbatim) |
| `mf4-to-blob/static/index.html` | rewritten | Shared claim fieldset and its comment deleted; inline module replaced by `<script type="module" src="/static/upload-page.js">`; `.claim*` styles retuned from their light-theme colours to the page's dark palette and extended with the row's summary line, chips, `↺` and bulk link |
| `mf4-to-blob/main.py` | +1 import, +1 mount, +2 query params, 2 call sites | `/static` mount so the page can be three files; `vehicle` query parameter on both upload routes, stashed on the SAS progress record and passed to `object_metadata` |
| `mf4-to-blob/metadata.py` | `object_metadata` gained `stated` | The stamp survives dirty-tracking without faking a declaration. `_DECLARED_PATTERNS`, `_FILENAME_CLAIM`, `collect_declared` and `build_payload` are untouched |

## How it meets the neighbours

- **The ladder** (`mf4-decoder/identity.py`, `tm-connector/connector/identity.py`) is unchanged
  and now receives a smaller `declared` bag in the common case — the shape of the bag, the
  message and the query string are all byte-identical to what a person typing exactly what the
  recording states would produce today.
- **The blob folder.** `_run_folder` uses `declared.run_id`, then the `TAS-\d+` filename rung. An
  untouched prefill falls to the filename rung, which the four traces satisfy; a recording with
  neither lands under `unassigned/`, exactly as a blank form does today. Not a regression, not
  fixed here.
- **`x-ms-meta-vehicle`** is stamped on every upload again, from the recording when nobody typed
  and from the claim when somebody did.
- **The four runs already in the estate** (`WO-2026-PT-001` / `0225` / `Taycan`) are out of scope
  for this build. Spec §9 states the cost: the registry half is a `PATCH /test-runs/{id}`, the
  lake half needs new bytes because the decoder dedups on content sha256, and the stale partition
  `platform=Porsche_Taycan/work_order=WO-2026-PT-001/` has to be dropped by hand.
