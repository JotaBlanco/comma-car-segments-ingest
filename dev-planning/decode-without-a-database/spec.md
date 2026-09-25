# A decode that resolved no database must not mark the file done

**Status:** Draft
**Project:** comma-car-segments-ingest (`BL-79`)
**Created:** 2026-09-25
**Planned with:** Buddy

## 1. Summary

On 2026-09-25 the `Porsche_Taycan` DBC was absent from DCM. Four traces were
uploaded, the decoder resolved no database, dropped 9 raw CAN frame channels and
180,000 frames per file, produced zero samples — and then marked each file
**decoded**. Nothing failed. The files registered as `status: "registered"`,
`quarantine_reason: null`, `signal_count: 0`; the runs showed `files=1,
signals=0`; the lake table was never created. From every screen it read as a
successful ingest of a file that happened to contain nothing.

The mark is what turns a gap into a trap: the sha256 is in the decode-once
State, so the same bytes can never decode again. Recovery took a restored DBC
**plus** `FORCE_REDECODE=true` on the whole deployment, applied by hand.

This spec makes the decoder state the failure on the terminal marker and
withhold the decode-once mark, so the file lands quarantined (loud, on surfaces
that already exist) and a plain re-upload heals it once the DBC is back. No new
topic, no retry framework, no new screen, no change to `idempotency.py`.

## 2. Goals

- A bus-logging file whose frames produced no signal is **visibly failed**, not
  quietly empty.
- The decode-once mark is **not** written for that file, so the same bytes can
  decode again without a deployment variable.
- The recovery is reachable from the Portal / Test Manager by an operator who
  does not use the API.
- The decode-once guarantee — never a second copy of a file's rows in the lake —
  is not weakened anywhere.
- Zero code in `mf4-to-blob`, `api/`, `frontend/`, the sink, and
  `mf4-decoder/idempotency.py`.

## 3. Non-goals

- A DBC that decodes *badly* (wrong scaling, wrong offsets, plausible-but-wrong
  values). Undetectable here; see §9.
- A partially decodable file (the DBC covers some frame IDs and not others).
  See §6.6.
- A retry framework, a dead-letter topic, a backoff schedule, a per-file attempt
  counter.
- Any change to the decoder's consumer group (`mf4-decoder-v3`,
  `main.py:117-121`) — rotating it abandons the dedup state
  (`idempotency.py:53-57`).
- Any change to the registry's replay guard `_fill_empty_inventory`
  (`api/api/routers/files.py:1194-1226`), shipped at `c630f07`.
- Any change to `mf4-to-blob` or the sink's partitioning.

## 4. User stories

1. **The DBC is gone.** An engineer uploads a trace while no `dbc` configuration
   exists for its platform. Within a minute the Home screen's *Needs attention*
   panel counts one quarantined file and names it; the file's row reads
   `Quarantine reason: no CAN database resolved for platform Porsche_Taycan —
   180000 CAN frame(s) could not be decoded`; the run's Files tab shows the file
   with `0` signals and a quarantined badge; the API pod log carries one
   `QUARANTINE ALERT` line.
2. **The DBC comes back.** The engineer uploads the *same file* again from the
   MF4 Import form. It decodes, registers as a second, clean file document with
   249 signals, and the run's signal panes fill. No deployment variable is
   touched, no redeploy, no API call.
3. **A file with no CAN frames.** An ordinary MF4 with conventional channel
   groups still registers normally and is still marked decoded. Nothing about
   this spec fires.
4. **A replay.** Someone resets the decoder's offsets. Every file that decoded
   successfully — including one healed by story 2 — is skipped. Only files that
   have *never* decoded are re-attempted, and each of those writes zero lake
   rows and registers as a replay of its own existing document.

## 5. Proposed design

One predicate, one withheld mark, one existing field.

```
mf4-decoder/main.py
  _decode_can_bus_logging() ─ also returns WHY it returned no database
  process()                 ─ decode_error = decode_failure(...)      (new, §6.1)
                            ─ _produce_marker(..., decode_error=...)  (existing arg)
                            ─ mark_decoded(...) only if it is safe    (§6.3)

tm-connector   (unchanged)  decode_error → quarantine_reason + conversion_status=failed
api/           (unchanged)  quarantine → alert + Needs attention + Files tab
frontend/      (unchanged)  badge, red reason line, stage panel
```

The whole downstream half is already built and already tested
(`tm-connector/connector/bodies.py:130-163`,
`api/api/routers/files.py:1279-1280, 1359-1364`,
`tm-connector/tests/test_quarantine.py`). The decoder is the only producer that
does not use it. This spec connects one existing producer path to one existing
consumer path.

## 6. The six decisions

### 6.1 "Nothing to decode" vs "could not decode" — the exact condition

The decoder already computes every term. `main.py:876-890`:

```python
bus_groups = _find_can_bus_logging_groups(mdf)          # main.py:876
raw_bus_channels, raw_bus_frames = _bus_group_totals(mdf, bus_groups)   # :885
```

and `main.py:938` already writes the warning on exactly the failing condition —
it just logs instead of stating:

```python
if bus_groups and decoded_signals == 0:      # main.py:938
    logger.warning("Dropping %d raw CAN frame channel(s) / %d frame(s) ...")
```

**The condition, as code.** A new pure module `mf4-decoder/decodability.py`
(pure so it is testable: `main.py` builds an `Application` and reads
`os.environ["input"]` at import, so nothing in it can be imported by a test):

```python
DECODING_OFF = "decoding is switched off (DBC_SOURCE=none)"


def decode_failure(
    *, bus_frames: int, decoded_signals: int, dbc_reason: str | None, platform: str
) -> str | None:
    """The `decode_error` for a file whose CAN frames produced no signal.

    None means the file is fine: either it carries no CAN frames (an ordinary
    MF4, or an empty bus-logging group), or frames went in and signals came
    out. Anything else is a decode that could not run, not a file with nothing
    in it.
    """
    if bus_frames == 0 or decoded_signals > 0 or dbc_reason == DECODING_OFF:
        return None
    if dbc_reason is None:
        return (
            f"the CAN database for platform {platform} decoded 0 of "
            f"{bus_frames} frame(s)"
        )
    return f"{dbc_reason} - {bus_frames} CAN frame(s) could not be decoded"
```

Read the three clauses as the three reasons this is not a failure:

- `bus_frames == 0` — **nothing to decode.** No CAN frames, so zero samples is
  the honest answer. Covers every ordinary MF4 and an empty bus-logging group.
  This is the clause that keeps the fix from firing on legitimate files.
- `decoded_signals > 0` — frames went in, signals came out. Whether they are
  *correct* is out of scope (§6.6).
- `dbc_reason == DECODING_OFF` — `DBC_SOURCE=none` is a deployment stating "do
  not decode CAN". An operator who set it is not surprised by the result, so it
  is a configuration, not a failure. Excluded explicitly rather than by
  accident.

`dbc_reason` is new: `_decode_can_bus_logging` (`main.py:581-650`) currently
returns `(decoded, dbc_paths)` and discards *why* it returned `None` across six
exits (`:597, :610, :615, :621, :633, :638, :650`). It gains a third element,
`None` on success and a short sentence on each failure, so the quarantine reason
names the actual cause instead of a generic one. Its one call site is
`main.py:892`.

Suggested reason strings (short — this becomes a table cell):

| Exit | `dbc_reason` |
|---|---|
| `:597` `DBC_SOURCE=none` | `DECODING_OFF` |
| `:610` no DCM document | `no CAN database resolved for platform <p>` |
| `:615` `materialise` raised | `the DCM document for <p> is not a loadable database` |
| `:621` / `:650` `extract_bus_logging` raised | `extract_bus_logging failed with the <p> database` |
| `:633` no embedded attachment | `the file carries no embedded .dbc attachment` |
| `:638` no attachment extracted | `no embedded CAN database could be extracted` |

### 6.2 What the decoder does — and the replay-storm objection

**Decision: produce the marker with `decode_error`, and do not call
`mark_decoded`.** Both halves; each is useless without the other.

Three candidates and what each costs on the *next* delivery of the same message:

| Candidate | Next delivery | Verdict |
|---|---|---|
| Mark it, record `decode_error` | **Skipped.** The bytes are burnt. Exit = new bytes, or `FORCE_REDECODE=true` on the deployment, which re-decodes *everything* and doubles every other file's lake rows | Visible but not recoverable — the trap in a better coat |
| Do not mark, no `decode_error` | Re-attempted, and silent again | Recoverable but invisible |
| **Do not mark, state `decode_error`** | Re-attempted; writes zero lake rows; registers as a replay of its own document | Chosen |

**The objection: a file that never marks is re-attempted on every replay, and an
unbounded retry against a permanently missing DBC is its own failure mode.**
Four facts bound it.

1. **Nothing replays on its own.** `commit_every=1` (`main.py:120`) commits the
   offset after every metadata message, independent of `mark_decoded`. In normal
   operation an unmarked file is delivered exactly once, like a marked one. The
   re-attempt happens only when a person resets offsets or the State is lost —
   which is precisely the event the decode-once guard exists for, and the guard
   is untouched for every file that *did* decode.
2. **A re-attempt cannot corrupt the lake, because the failed decode wrote
   nothing.** See §6.5. The guarantee the mark protects is "never a second copy
   of a file's rows"; a decode with zero rows has no copy to make a second of.
3. **A re-attempt cannot corrupt the registry either.** The replayed marker
   carries the same `storage_ref` and checksum, so
   `_existing_quarantined(storage_ref, checksum)`
   (`api/api/routers/files.py:1062-1080`) matches the existing document and
   returns `created=False`. No second file document, no second journal burst
   (`connector.py:213-225`), no second `QUARANTINE ALERT`
   (`files.py:1359-1364`, inside the creation branch).
4. **The hole closes itself on the first successful decode.** The decode-once
   identity is `sha256:<hex>` (`idempotency.py:129-131`), i.e. the *content*.
   When the file is re-uploaded and decodes (§6.4), that decode marks
   `sha256:X` — and the original message carries the same `sha256:X`. So a
   later replay of the original, failed delivery is skipped by the mark the
   *healed* delivery wrote. The unmarked window is exactly "these bytes have
   never decoded", and it is closed by success, not by time.

So the residual exposure of a replay storm is: one blob download + one CPU pass
+ one idempotent POST per never-decoded file per replay event. Bounded, costly
at worst, destructive never. The alternative — marking it — is destructive on
the first delivery and that is what happened on 25 Sep.

**`decode_error`, not `samples_suppressed`.** Both fields already ride the
marker (`marker.py:41-42, 68-69`). `samples_suppressed` is deliberately narrative
— the connector logs it and it "never becomes a quarantine reason of our own"
(`connector.py:171-177`) — and narration is exactly what failed here.
`decode_error` is the field that means "the producer states this decode failed"
and it is the one the registry's derivation rules expect: *"A failed conversion
is the producer's to report. The registry holds no decode error of its own, so
it derives no conversion failure"* (`files.py:1160-1161`).

### 6.3 When the mark is still written

`mark_decoded` (`main.py:1061`) becomes conditional on one boolean:

```python
if decode_error is None or total_samples > 0:
    mark_decoded(state, metadata, samples=total_samples)
```

`total_samples > 0` is the mixed-file case: a file with bus-logging groups that
could not decode **and** ordinary channel groups that emitted rows
(`main.py:954-1005` runs after the bus pass). Those rows are in the lake, so a
re-attempt would append a second copy — and the decode-once guarantee wins over
the recovery. Such a file is quarantined and *stays* marked; its exit is a human
decision, not an automatic retry.

Every trace in this estate is pure bus-logging (one group, 9 raw frame channels,
no ordinary group), so the automatic path always applies here. The `>` guard is
what keeps the rule true for a file shape we do not have.

When the mark is withheld, log it at WARNING naming the recovery in one line, so
the pod log is not merely a record of the failure but of what to do. The
existing boot line already teaches the vocabulary (`idempotency.py:111-115`).

`idempotency.py` itself is **not modified**. Withholding a call is not a change
to the module that owns the call.

### 6.4 Recovery, without a deployment variable

**Is `force_redecode=true` on a single message reachable by an operator today?
No.** The flag is read at `idempotency.py:149-151` from the `mf4_metadata`
message, and the only producer of that topic is `mf4-to-blob`
(`mf4-to-blob/main.py:537`), which never sets it. Putting it on a message means
hand-publishing raw JSON to `mf4_metadata`; no screen in this estate does that,
and `mf4-to-blob` is out of scope. So the per-message flag is documented but
unreachable.

**It does not need to become reachable, because §6.2 removes the mark it would
bypass.** The narrow, per-file exit is:

> Restore the DBC in DCM, then upload the same file again from the MF4 Import
> form.

Why that works, end to end:

- `mf4-to-blob` mints a new `upload_id` and, under the default
  `collision_policy=suffix` (`mf4-to-blob/main.py:68`,
  `mf4-to-blob/blob.py:134-135`), a new blob path — so nothing overwrites the
  evidence of the failed attempt.
- The metadata message carries the **same sha256**, so it hits the same
  decode-once scope — which holds no mark, so `needs_decode` returns True
  (`idempotency.py:165-166`) and the file decodes.
- The successful decode marks `sha256:X`, closing the window for both deliveries
  (§6.2 fact 4).
- The marker registers a **new** file document: `_existing_registered` filters on
  `status: "registered"` and the failed attempt is quarantined
  (`files.py:1044-1059`); `_existing_quarantined` keys on `storage_ref` and the
  blob path is new (`files.py:1062-1080`). The partial unique index on
  `(run, checksum)` covers `status: "registered"` only (`api/api/db.py:75-96`),
  so there is no duplicate-key collision. The new document registers clean, with
  the full 249-signal inventory, and the run's signal panes fill.

**The cost, stated plainly:** the run ends up with two file documents and two
blobs for one recording — the quarantined record of the failed attempt and the
good one. The failed attempt is not repairable in place: `_leaves_quarantine`
(`files.py:219-235`) releases only `quarantine_reason == "no run key"`, by
design, and a decode failure is not a link failure. The operator archives or
deletes the quarantined document from the Files screen
(`frontend/components/screens/files/files-batch-bar.tsx`, the lifecycle routes
at `files.py:569+`). See OQ1.

### 6.5 The lake consequence

**A failed decode writes zero lake rows.** This is not an assumption, it is what
the topology does: rows reach the lake only as `kind: "samples"` batches, and
`_emit_signals` is never entered for a file with no decoded signals and no
ordinary groups, so no batch is produced. The terminal marker is explicitly
refused by the sink (`mf4-datalake-sink/expand.py:60-70`,
`is_sample_batch`). That is why the table was never created on 25 Sep — the
observation confirms the code.

So for **this** failure a re-decode appends to an empty set and cannot double
anything. That is what makes the retry safe here, and it is exactly what is
*not* true in general: a re-decode appends, it never replaces, so any decode
that flushed batches before failing has already written rows and a retry writes
them twice. §6.3's `total_samples > 0` guard is the statement of that boundary
inside this feature; §8 R2 names the pre-existing case outside it.

### 6.6 Scope boundary

| Case | What it does today | Shares this fix? |
|---|---|---|
| **No database resolved** (no DCM document) | `_decode_can_bus_logging` returns `None` at `main.py:610`; frames dropped at `:938`; file marked decoded | **Yes — this is the feature** |
| **DCM slow / lookup throws** | `fallback="default"` (`main.py:1127-1131`) turns a fetch failure into `dcm_doc = None` — *indistinguishable* from "no configuration exists" | **Yes**, same path, and it is the strongest argument for a retryable (unmarked) treatment: a transient outage must not burn the bytes |
| **DCM document is not a loadable DBC** | `materialise` raises, caught at `:613-615`, returns `None` | **Yes**, same predicate, its own reason string |
| **`extract_bus_logging` raises** | caught at `:619-621`, returns `None` | **Yes**, same predicate, its own reason string |
| **Database resolved, decodes 0 signals** (wrong DBC for this bus) | `decoded is not None`, `decoded_signals == 0`, warning at `:938`, marked decoded | **Yes.** "Decodes nothing" is not "decodes badly" — it is the same empty result and the same trap, and the predicate costs nothing extra to cover it |
| **Partially decodable** (DBC covers some frame IDs) | `decoded_signals > 0`; the uncovered frames are dropped and the `:938` warning does not even fire | **No.** Registers normally and silently. A known blind spot; §8 OQ2 |
| **DBC decodes badly** (wrong scaling/offset) | Signals produced, inventory full, file registers, lake fills with wrong numbers | **No.** Nothing in this pipeline can detect it |

## 7. Contracts

**No wire change.** `decode_error` is already on the marker
(`mf4-decoder/marker.py:41, 68`) and already read by the connector
(`tm-connector/connector/bodies.py:130-163`). The registry's
`FileRegisterRequest` is `extra="forbid"`, so this matters: the spec adds **no**
key anywhere.

What an already-built path then does with it, for the record:

```
marker.batch.decode_error: "<reason>"
  → bodies.file_body           quarantine_reason = <reason>
                               conversion_status = "failed"
                               stage_error       = <reason>
  → POST /files                status = "quarantined"           files.py:1279-1280
                               signals NOT catalogued           files.py:1365-1366
                               journal "Quarantined: <reason>."  files.py:1349-1358
                               QUARANTINE ALERT log line         files.py:1364
                               counted in the run rollup         files.py:1375
  → GET /summary               needs_attention.quarantined_files  queries_runs.py:951
                               attention_rows.quarantined_files   queries_runs.py:959
```

Internal to the decoder:

- `_decode_can_bus_logging(mdf, target_dir, dcm_doc=None)` returns
  `(decoded, dbc_paths, dbc_reason)` — three elements, one call site
  (`main.py:892`).
- `mf4-decoder/decodability.py` exposes `DECODING_OFF` and `decode_failure(...)`
  as in §6.1.

## 8. Where it surfaces, risks, and open questions

### Visibility — all of it already exists

| Surface | Path | What the operator sees |
|---|---|---|
| Home → Needs attention | `frontend/components/screens/home/needs-attention-panel.tsx:193-212` | A count and the named files, deep-linked |
| Files screen | `frontend/components/screens/files/files-screen.tsx:121` | A `Quarantine reason` column |
| File detail | `frontend/components/screens/files/file-detail-screen.tsx:231-232` | The reason in red under the status |
| File detail → stages | `frontend/components/screens/files/stage-status-panel.tsx:63-76` | `Conversion: failed` + `stage_error` |
| Run → Files tab | `frontend/components/screens/run-detail/files-tab.tsx:112-126` | `0` signals beside a quarantined badge |
| Pod log | `api/api/services/alerts.py:38-55` | `QUARANTINE ALERT file=… reason=…`, a stable prefix a cluster log rule can match |

No new state, no new screen, no new field. The registry has exactly one
"something is wrong with this file" state and this failure belongs in it.

### Risks

- **R1 — the quarantined ghost.** Recovery leaves two file documents and two
  blobs for one recording, and inflates the run's `file_count`. Accepted: it is
  true (two ingestion attempts really happened), it is loud, and the operator can
  archive the failed one. See OQ1.
- **R2 — a partially flushed decode is already unsafe to retry.** The existing
  `except` at `main.py:1063-1084` leaves a file unmarked after a failure that may
  have flushed N batches, so the current retry path can already append a second
  partial copy. Pre-existing, untouched by this spec, and named here because
  §6.3's guard is the first place the repository states the rule. Not fixed here.
- **R3 — quarantine is permanent by design.** `connector.py:1-23` red-flags this
  for the "no run key" case. Here it is intended: nothing about the quarantined
  document can be repaired, because the bytes decoded to nothing. The exit is a
  new decode, not a PATCH.
- **R4 — a mixed file quarantines while its ordinary rows sit in the lake**
  (§6.3). Asymmetric, but the estate has no mixed files and the alternative is
  duplicating rows.
- **R5 — reason strings become table cells.** Keep each under ~120 characters
  and free of stack traces; `quarantine_reason` renders untruncated in a column.

### Open questions — the user decides

- **OQ1.** After a heal, should the quarantined attempt be **archived by hand**
  (chosen default: yes, from the Files screen, zero code) — or should the
  re-upload chain onto it via `POST /files/{id}/versions` so the run shows "v2 of
  2" instead of two files? The second is `BL-68` / `BL-69` and is a real feature,
  not part of this one.
- **OQ2.** Is a *partially* decoded file (some frame IDs covered, some not) worth
  reporting at all — as a `samples_suppressed`-style narration rather than a
  quarantine? It is silent today (§6.6) and out of scope unless asked for.

## 9. Alternatives considered

- **Emit the raw `CAN_DataFrame.*` channels when no DBC resolves,** so the file
  is not empty. Rejected: it violates the decoded-signals-only policy
  (`main.py:938-944`), fills the signals table with frame plumbing, and makes a
  failed decode look like a successful one with odd channel names — a louder
  version of the same lie.
- **Mark it decoded and rely on `force_redecode=true` on the message.**
  Rejected: unreachable today (§6.4) and it keeps the burnt-sha256 trap.
- **Refuse the file before the download when the DCM document is `None`.** The
  lookup does run before `process` (`main.py:1138-1142`), so the saving is real —
  but a file with no CAN frames needs no database, and refusing pre-download
  would fail every ordinary MF4. The condition cannot be evaluated before the
  file is open.
- **A `decode_status` field on the marker, or a quarantine reason taxonomy.**
  Rejected: `decode_error` already carries exactly this meaning through a path
  with tests on it, and a second spelling would let the two disagree.
- **A retry topic / dead-letter service / attempt counter in State.** Rejected by
  the standing rule against defensive machinery, and unnecessary: §6.2 fact 4
  shows the content-hash identity already makes success terminal.
- **Widen `_leaves_quarantine` so a PATCH releases a decode quarantine.**
  Rejected: the route reads no byte, so it can say nothing about whether the file
  now decodes — the same reason it refuses a checksum mismatch
  (`files.py:226-229`).

## 10. References

- `dev-planning/signal-inventory-replay/architecture.md` — the second defect from
  the same incident (an empty inventory frozen for ever), fixed at `c630f07`.
  Its 09:05 / 09:18 timeline is the primary record of what happened.
- `mf4-decoder/idempotency.py:1-58` — why the decode-once store exists, why the
  identity is the content hash, why the consumer group is a constant.
- `tm-connector/connector/connector.py:1-23` — the permanent-quarantine red flag.
- `api/api/services/alerts.py` — FR-DM-004, the one seam a real alert channel
  plugs into.
- `tm-connector/tests/test_quarantine.py:48-107` — the decode-error → quarantine
  path, already green.
- `tests/test_marker_contract.py:122` — the contract test that feeds a marker
  with `decode_error` to the connector's real readers and the registry's real
  models. The new case belongs beside it.
