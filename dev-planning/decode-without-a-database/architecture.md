# A decode that resolved no database — architecture

A bus-logging MF4 whose CAN frames produced no signal used to be marked decoded
and registered clean: `status: "registered"`, `quarantine_reason: null`,
`signal_count: 0`. The decoder now states that failure on the terminal
`file_complete` marker and **withholds** the decode-once mark, so the file lands
quarantined on screens that already exist and a plain re-upload heals it once
the database is back.

Spec: `dev-planning/decode-without-a-database/spec.md` (`BL-79`). The incident
timeline is in `dev-planning/signal-inventory-replay/architecture.md` — same
morning, the other half of the same failure.

## What went wrong

The `Porsche_Taycan` DBC was absent from DCM. Per file the decoder logged:

```
WARN  No DCM database resolved for this file - nothing can be decoded.
WARN  Dropping 9 raw CAN frame channel(s) / 180000 frame(s): no decodable signals.
INFO  Marked sha256:b07339fb… decoded (0 samples)
```

Nothing failed. `_decode_can_bus_logging` returned `None`, which the caller
treated as "no signals in this file" rather than "no database for this file";
the marker carried no `decode_error`, so the registry's derivation rule —
*a failed conversion is the producer's to report* (`files.py:1160-1161`) — had
nothing to report. The lake table was never created because zero `samples`
batches were produced.

The **mark** is what turned the gap into a trap. The decode-once identity is
`sha256:<hex>` (`mf4-decoder/idempotency.py:129-131`), so the same bytes could
never decode again; recovery took a restored DBC **plus** `FORCE_REDECODE=true`
on the whole deployment, which re-decodes every other file too and appends a
second copy of each into the lake.

## The two halves

Neither works alone. Stating the failure without withholding the mark is a
visible trap; withholding the mark without stating the failure is a silent one.

### 1. The predicate — `mf4-decoder/decodability.py`

A new pure module, so it is testable: `main.py` builds an `Application` and
reads `os.environ["input"]` at import, so nothing defined there can be imported
by a test.

```python
def decode_failure(*, bus_frames, decoded_signals, dbc_reason, platform) -> str | None:
    if bus_frames == 0 or decoded_signals > 0 or dbc_reason == DECODING_OFF:
        return None
    ...
```

The three clauses are the three reasons an empty result is honest:

| Clause | Meaning |
|---|---|
| `bus_frames == 0` | Nothing to decode. Every ordinary MF4, and an empty bus-logging group. This is the clause that keeps the fix off legitimate files. |
| `decoded_signals > 0` | Frames went in, signals came out. Whether they are *correct* is out of scope. |
| `dbc_reason == DECODING_OFF` | `DBC_SOURCE=none` is a deployment stating "do not decode CAN". Excluded explicitly rather than by accident. |

`dbc_reason` is new. `_decode_can_bus_logging` (`mf4-decoder/main.py:582`)
returned `(decoded, dbc_paths)` and discarded *why* it returned `None` across
seven exits. It now returns a third element: `None` on success, one short
sentence on every path that returns no database, so the quarantine reason names
the cause (`no CAN database resolved for platform Porsche_Taycan`) instead of a
generic one. The reason becomes a table cell, so each is kept under ~120
characters and free of stack traces (`tests/test_decodability.py` pins that).

**One deviation from the spec's §7 signature.** The spec kept
`_decode_can_bus_logging(mdf, target_dir, dcm_doc=None)` and listed a reason
string naming the platform. The function knew no platform, so it gained a
`platform=UNKNOWN` keyword; the caller passes `metadata[F_DCM_KEY]` — the
target key the DCM lookup actually used (`main.py:1175-1176`) — falling back to
the header's platform when `DBC_SOURCE` is not `dcm` and no lookup ran. The
alternative was a reason that says "a platform" without naming one, which is
what user story 1 asks for by name.

### 2. The withheld mark — `mf4-decoder/main.py`

```python
if decode_error is None or total_samples > 0:
    mark_decoded(state, metadata, samples=total_samples)
else:
    logger.warning("NOT marking %s decoded: %s. Restore the database in DCM and …")
```

`total_samples > 0` is the mixed-file case: bus-logging groups that could not
decode **and** ordinary channel groups that emitted rows (`main.py:973-1033`
runs after the bus pass). Those rows are in the lake, a re-decode appends rather
than replaces, so the decode-once guarantee outranks the recovery — such a file
is quarantined and *stays* marked, and its exit is a human decision. Every trace
in this estate is pure bus-logging, so the automatic path always applies here;
the guard is what keeps the rule true for a file shape we do not have.

`idempotency.py` is **not modified**. Withholding a call is not a change to the
module that owns it, and the consumer group stays the hard-coded constant it is
for the reason `idempotency.py:53-57` gives.

## Data flow

```
mf4_metadata ──group_by(sha256)──> needs_decode ──> DCM lookup (dcm_dbc_doc)
                                        │
                                        v
  _decode_can_bus_logging(platform=dcm_target_key)
        -> (decoded | None, dbc_paths, dbc_reason)
                                        │
              decode_failure(bus_frames, decoded_signals, dbc_reason, platform)
                                        │
                     decode_error ──────┴──────> marker.batch.decode_error
                                        │              │
                     mark_decoded WITHHELD            │  (no samples batch is
                     when decode_error and             │   produced at all, so
                     total_samples == 0                │   the lake gets nothing;
                                                       │   the sink refuses the
                                                       v   marker, expand.py:60)
                              tm-connector bodies.file_body
                                quarantine_reason = <reason>
                                conversion_status = "failed"
                                stage_error       = <reason>
                                        │
                                        v
                              POST /files  (api/api/routers/files.py)
                                status = "quarantined"        :1279-1280
                                signals NOT catalogued        :1365-1366
                                journal "Quarantined: …"      :1349-1358
                                QUARANTINE ALERT log line     :1364
                                counted in the run rollup     :1375
                                        │
                                        v
          Home → Needs attention · Files column · red reason line ·
          stage panel (Conversion: failed) · run → Files tab (0 signals)
```

Every surface below `POST /files` already existed and is unchanged. The
registry has exactly one "something is wrong with this file" state and this
failure belongs in it, so the feature adds no field, no status, no screen.

## Why an unmarked file costs nothing

The obvious objection is an unbounded retry against a permanently missing DBC.
Four facts bound it:

1. **Nothing replays on its own.** `commit_every=1` (`main.py:121`) commits the
   offset after every metadata message, independent of `mark_decoded`. An
   unmarked file is delivered exactly once, like a marked one. A re-attempt
   happens only when a person resets offsets or the State is lost.
2. **A re-attempt cannot corrupt the lake**, because the failed decode wrote
   nothing: rows reach the lake only as `kind: "samples"` batches, none was
   produced, and the terminal marker is refused by the sink
   (`mf4-datalake-sink/expand.py:60-70`). That is why the table was never
   created on 25 Sep — the observation confirms the topology.
3. **A re-attempt cannot corrupt the registry.** The replayed marker carries the
   same `storage_ref` and checksum, so `_existing_quarantined`
   (`api/api/routers/files.py:1062-1080`) matches and returns `created=False`:
   no second document, no second journal burst, no second `QUARANTINE ALERT`.
4. **The hole closes on the first successful decode.** The dedup identity is the
   *content* hash, so the healed upload's decode marks `sha256:X` — and the
   original failed delivery carries the same `sha256:X`. The unmarked window
   means exactly "these bytes have never decoded", and it is closed by success,
   not by time.

Residual exposure per replay event: one blob download, one CPU pass and one
idempotent POST per never-decoded file. Bounded, costly at worst, destructive
never — whereas marking it is destructive on the *first* delivery, which is what
happened.

## What each case does now

| File | Behaviour |
|---|---|
| No CAN frames (ordinary MF4) | Unchanged. Registers, marked decoded. `bus_frames == 0`, so the predicate never fires. |
| Bus-logging, database missing / unloadable / `extract_bus_logging` raised | `decode_error` on the marker → quarantined with the cause named; **not** marked, so the same bytes decode again once the database is back. |
| Bus-logging, database resolved, 0 signals decoded (wrong DBC for the bus) | Same. "Decodes nothing" is the same empty result and the same trap. |
| Decodes fine | Unchanged. `decode_error` is `None`, no stage field is stated, the registry derives success from the non-empty inventory, marked decoded. |
| `DBC_SOURCE=none` | Unchanged. A configuration, not a failure: registers, marked decoded. |
| Mixed: bus groups failed, ordinary groups emitted rows | Quarantined **and** marked. The rows are in the lake; a retry would append a second copy. |
| Partially decodable (database covers some frame ids) | Unchanged — silent. See below. |
| A database that decodes *badly* (wrong scaling/offset) | Unchanged — undetectable anywhere in this pipeline. |

## The recorded gap: a partially decoded file stays silent

Decided, not overlooked. A DBC that describes some of a file's frame ids and not
others yields `decoded_signals > 0`, so `decode_failure` returns `None`, the file
registers clean, and the uncovered frames are dropped without even the
`main.py:955-961` warning firing.

It stays out because it is a **different and harder problem**: telling *"this
database describes 8 of the 9 frames in this file"* from *"this file carries a
frame no database ever described"* requires the frame-id set of the file and the
frame-id set of the database, compared. The decoder holds neither today —
`_bus_group_totals` counts frames, not ids, and the marker has no field for a
coverage figure. Reporting it would be a `samples_suppressed`-style narration
(the field exists; `connector.py:171-177` logs it and it never becomes a
quarantine reason), not a quarantine, because a partial decode still produces
real data.

The gap is stated in `mf4-decoder/decodability.py`'s module docstring, which is
where the next reader meets the predicate and asks why it did not fire.

## Recovery, and the ghost it leaves

> Restore the DBC in DCM, then upload the same file again from the MF4 Import
> form.

No deployment variable, no redeploy, no API call. `mf4-to-blob` mints a new
`upload_id` and a new blob path (`collision_policy=suffix`), so the evidence of
the failed attempt survives; the metadata message carries the same sha256, which
holds no mark, so `needs_decode` returns True and the file decodes; the marker
registers a **new** document, because `_existing_registered` filters on
`status: "registered"` and the failed attempt is quarantined, `_existing_quarantined`
keys on the (now different) `storage_ref`, and the partial unique index on
`(run, checksum)` covers `status: "registered"` only (`api/api/db.py:75-96`).

**Cost:** the run ends up with two file documents and two blobs for one
recording, and its `file_count` counts both. The failed attempt is not repairable
in place — `_leaves_quarantine` (`files.py:219-235`) releases only
`quarantine_reason == "no run key"`, and a decode failure is not a link failure.

**The quarantined attempt is archived by hand** from the Files screen. It is
deliberately *not* chained onto the healed file via `POST /files/{id}/versions`:
a file version is `BL-68` / `BL-69`'s subject, with its own `version_group`
semantics and its own logical key `(run_id, filename)`, and pulling it in here
would make this fix a versioning change.

## File inventory

| File | Change |
|---|---|
| `mf4-decoder/decodability.py` | New. `DECODING_OFF` and the `decode_failure` predicate; its docstring records the partial-decode gap. |
| `mf4-decoder/main.py` | `_decode_can_bus_logging` returns `dbc_reason` and takes `platform`; `process` computes `dbc_platform` and `decode_error`, passes `decode_error` to `_produce_marker`, and guards `mark_decoded`. The mark's comment no longer claims "produced-nothing is a completed decode" unconditionally. |
| `tests/test_decodability.py` | New. The predicate's six cases plus the ~120-character reason budget. |
| `tests/test_marker_contract.py` | One case beside the existing decode-failure one: the DBC-miss marker, built by the decoder's own predicate, read by tm-connector's real reader, accepted by the registry's real model as a quarantine. |
| `dev-planning/decode-without-a-database/architecture.md` | This document. |

Nothing else was touched: not `idempotency.py`, not `marker.py`, not
`tm-connector/`, `api/`, `frontend/`, `mf4-datalake-sink/` or `mf4-to-blob/`.

## How it sits with its neighbours

* **`signal-inventory-replay` (`c630f07`)** fixed the other half of the same
  morning: a replay carrying a full inventory for a file registered empty used
  to be dropped. That guard is untouched — and with this change the empty
  registration it repairs mostly stops happening, because the file is
  quarantined instead.
* **`idempotency.py`** keeps its decode-once guarantee for every file that
  actually decoded. The withheld mark narrows the set of marked files; it does
  not weaken the mark's meaning.
* **`tm-connector`** needed nothing: `decode_error` has ridden the marker since
  `marker.py:41` and `bodies.py:130-163` has read it all along, with
  `tm-connector/tests/test_quarantine.py` green on it. The decoder was the only
  producer that never used the field.
* **`BL-68` / `BL-69` (file versions)** own the "two documents for one
  recording" problem this recovery creates. When a re-upload chains onto the
  file it replaces, the ghost goes away with no change here.
