# Declare the platform at upload — architecture

**Branch:** `jama-ui-dev` · **Built:** 2026-09-25 · **Spec:** `dev-planning/upload-claims-platform/spec.md`
**Scope:** the `mf4-to-blob` browser page and its payload builder, plus two lines in
`mf4-decoder/main.py`. The sink, the connector, the registry API, the frontend, the lake schema,
the partition spec and the four existing lake rows are untouched.

## What it does

The MF4 Import page gains a fifth claim field, **Platform**, prefilled per file from that
recording's own top-level `platform` HD-comment property. It rides on the `mf4_metadata` message
as a **flat** `platform` key beside the existing flat `work_order`, and it does two jobs at once:
it is the DCM `target_key` the decoder resolves the CAN database with, and it is the lake's
top-level Hive partition directory. Before this change a single deployment variable,
`DBC_PLATFORM`, answered both for every file, so a Macan trace was decoded with the **Taycan
DBC** and filed under `platform=Porsche_Taycan/` — wrong signal values, not merely a wrong
folder. `DBC_PLATFORM` is unchanged and still answers when an upload declares nothing.

## The two channels, and why they had to be reconciled

`platform` reaches the decoder on one channel and leaves it on another. That is the whole of
this design.

```
                                      mf4_metadata
                                 {"platform": "Porsche_Macan",
                                  "declared": {...}}
                                          |
        CHANNEL 1 — the DCM key           |          CHANNEL 2 — the lake column
        main.py, module body              |          main.py, inside process()
        sdf[F_DCM_KEY] = sdf.apply(       |          header_properties = parse_header_properties(mdf)
          value.get("platform")           |          provenance_fields  = build_provenance(...)
          or DBC_PLATFORM or UNKNOWN)     |              -> provenance.py:_PROVENANCE_KEYS
                |                         |                 reads "platform" out of the FILE
          join_lookup(type=dbc,           |                          |
                      on=F_DCM_KEY)       |                  file_scalars["platform"]
                |                         |                          |
          the DBC the file is             |                  platform=<value>/ in the lake
          decoded with                    |
```

Channel 1 runs in an `sdf.apply` in the module body — **before the blob is downloaded**. That is
why the platform cannot come out of the header: at lookup time there is no file. `DBC_PLATFORM`'s
comment (`mf4-decoder/main.py:72-76`) has always said exactly this.

Channel 2 runs inside `process()`, after the file is open, and reads the header.

Feeding channel 1 alone would have produced a file **decoded with the Macan DBC and filed under
the header's platform** — two answers to one question, the failure `mf4-decoder/identity.py`'s
module docstring exists to prevent. So one statement after `build_provenance` lets the message's
platform win:

```python
provenance_fields = build_provenance(header_properties)
if declared_platform := str(metadata.get("platform") or "").strip():
    provenance_fields["platform"] = declared_platform
```

The reason is **not** "the operator outranks the file". It is *the decode already committed to
this value*: the database the signals were decoded with was chosen from it, so the partition has
to name it. The sink's own stated preference — *"`platform` prefers what the FILE says"*
(`mf4-datalake-sink/main.py:116-120`) — is about the work-order fallback and stays true; the sink
is untouched, and `expand.py:168-173` still consults the work order's `$.project` only when the
batch's platform is `unknown`, which a declared platform never is.

Placing the statement before `identity.resolve_identity` (`main.py:823`) is deliberate: that call
mints `<platform>_<route>` as the last rung of the run-key ladder, and a minted run id should
name the platform the file was actually decoded as.

## Why the flat key, not the `declared` bag

Channel 1 sees the message value only, never `value["declared"]["platform"]`. So `build_payload`
writes the flat key, following the precedent its own docstring already set for `work_order`: *one
fact, two spellings, both written in one place so the two readers cannot drift apart*. The value
also stays in the `declared` bag, where `tm-connector/connector/identity.py::clean_declared` drops
it silently — `platform` is not in `DECLARED_FIELDS`, the registry has no such field, and it does
not need one. `work_order` and `platform` are exactly the two flat spellings, and exactly the two
lake partition columns an uploader can state.

## The one break from the prefill rule

`dev-planning/import-prefill-from-trace/` established: a prefilled field the operator did not
touch **states nothing on the wire**. Silence is safe there because every other field is
resolvable downstream from the recording itself.

`platform` cannot be. Silence on this field does not mean "read it off the recording" — it means
`DBC_PLATFORM`, the deployment's one platform. And the failure fires exactly when the user does
the right thing: the form displays `Porsche_Macan`, read correctly out of the file, and the file
is decoded with the Taycan database because nobody retyped a value that was already correct.

So the field carries `alwaysSend: true` and `declaredQuery` reads:

```js
const value = (claim.dirty || field.alwaysSend) ? claim.value.trim() : '';
```

Two consequences worth knowing:

- **The wire cannot tell prefilled from retyped, for this field only.** `declared.platform=` is
  sent either way. The `typed` / `from the recording` chip and the `↺` revert still work and still
  tell the truth in the UI, but the server sees one statement. That is the point: the decoder
  needs the answer, not its provenance.
- **An empty value still sends nothing.** `alwaysSend` is evaluated before the existing
  `if (value)` guard, so a recording whose header states no platform, with nobody typing one,
  sends no `declared.platform` at all and `DBC_PLATFORM` answers exactly as it does today. Every
  pre-existing upload path — the API's ingest sweep, a re-drop into the watched prefix, a curl —
  is bit-identical to before.

## The shape check — the one place the no-new-checks rule yields

`platform` gets a `_DECLARED_PATTERNS` entry (`_TM_ID`, `mf4-to-blob/metadata.py`). This is a
deliberate exception to the standing "no new validation" rule, and it is the same exception the
three existing entries already are: the criterion is stated in the comment above them — a value
that becomes **a lake partition directory or a registry id** has its shape checked at the one
door a caller can reach. `platform` qualifies twice over (partition directory *and* DCM
target_key), and `_TM_ID` refuses a separator, a dot-dot or whitespace — the value that would
otherwise create a directory named `../..`. Nothing else was added: no diagnostics, no second
check downstream, no rate limit.

`_TM_ID` accepts `Porsche_Taycan` and `Porsche_Macan`. It does **not** catch a spelling mistake;
`Porche_Macan` is a well-formed value naming a platform with no DBC. §8 of the spec traces what
that costs and it is unpleasant — see below.

## The failure mode this makes reachable

`dcm-seed-dbc` keys a DBC configuration by the **basename** of the file, so `platform=X` needs
`dcm-seed-dbc/dbc/X.dbc` seeded and listed in `app.yaml`'s `DBC_NAMES` before the first upload of
platform `X`. If it is missing:

1. The DCM lookup misses; `fallback="default"` plus `default=None` land it as `None` rather than
   raising (`mf4-decoder/main.py:1122-1137`).
2. `_decode_can_bus_logging` logs one WARNING and returns `(None, [])`.
3. `decoded is None`, so no decoded signals and no raw `CAN_DataFrame.*` channels are emitted.
   **The file produces zero sample batches.**
4. A `file_complete` marker is still produced, with **no `decode_error`** — the load returned
   cleanly, it just returned nothing. The file registers with an empty signal inventory.
5. `mark_decoded` still runs, and its own comment says why: produced-nothing is a completed
   decode.

The file is therefore **permanently marked decoded**, and recovery needs the DBC seeded *and* new
bytes, because the decoder dedups on sha256. This is pre-existing — it fires today for any
platform without a DBC — and this change neither introduces nor alters a single step of it. What
it does is make a second platform possible, which makes the path reachable. Seed the DBC first.

## File inventory

| File | Change |
|---|---|
| `mf4-to-blob/metadata.py` | `_DECLARED_PATTERNS` gains `"platform": _TM_ID`; `build_payload` returns the flat `"platform"` key; docstrings state why the flat spelling is mandatory. Also corrected a stale docstring claim that `rig_id` is not shape-checked — it is, and has been. |
| `mf4-to-blob/static/mdf-header.js` | `CLAIM_KEYS` gains `'platform': 'platform'` — no `test.` prefix, because that is the key the producer already writes and `provenance.py::_PROVENANCE_KEYS` already reads. |
| `mf4-to-blob/static/claim-editor.js` | The `platform` field (label **Platform**, `alwaysSend: true`), `BULK_FIELDS`, the bulk button label, the `alwaysSend` condition in `declaredQuery`, and the note/comments that stated the now-broken rule. |
| `mf4-decoder/main.py` | One `if` after `build_provenance` so the lake column names the platform the DBC came from. |

**Deliberately untouched:** `mf4-datalake-sink/` (no new column — `platform` is already in
`HIVE_COLUMNS`, so no `TABLE_NAME` bump, no `CONSUMER_GROUP` rotation, no re-sink, no migration),
`tm-connector/`, `api/`, `frontend/`, `battery-trace-gen/` (the generator already writes the
top-level `platform` HD property, so **no trace regeneration**).

## How it sits beside its neighbours

- **`import-prefill-from-trace`** — this extends that claim editor and breaks exactly one of its
  rules, for one field, for a reason that does not generalise. Anyone adding a sixth field should
  assume dirty-tracking unless they can show the value is unreadable downstream in time.
- **`work_orders.project`** — a different field, untouched, and it never competes: the sink reads
  the work order's `$.project` only when the batch's platform is `unknown`, and a declared
  platform is never `unknown`. A campaign billed to programme `EX90` holding a trace declared
  `Porsche_Macan` states two true things about two different subjects.
- **The four existing lake rows** under `platform=Porsche_Taycan/work_order=WO-2026-PT-001/` are
  correct and stay put. Only *which channel supplies the value* changed, never its name, type or
  position in the partition spec.

## Open

- **OQ1 (from the spec, still open):** free-text box or a picker fed by the seeded DBC list? Built
  as free text. The picker is the correct control and would catch the misspelling `_TM_ID` cannot,
  at the cost of giving `mf4-to-blob` a DCM read it has never had.
- The editor's legend still reads *"Test Manager claim"*, which `platform` is not — it is the
  lake's and the DCM's. Wording only; left for FrontEndEsthetic.
