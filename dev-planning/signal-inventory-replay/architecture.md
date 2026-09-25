# Signal inventory on a replay — architecture

A file registered from a decode that produced no channel used to keep an empty
signal inventory for ever: the re-decode that found the channels replayed on
`(run, checksum)` and its inventory was dropped on the floor. `POST /files`
now fills an empty inventory from a replay, and only an empty one.

Input: the user's report of 2026-09-25, "SEEMS SIGNAL PANES DO NOT WOPRK NOW",
diagnosed against the live registry in `testrigorg-commacarsegmentsingest-jamaui`.

## What went wrong

`GET /api/v1/signals` answered `total: 0`, all four runs read `signal_count: 0`,
and all four files read `status: "registered"`, `quarantine_reason: null`. So
this was **not** the permanent-quarantine trap that
`tm-connector/connector/connector.py:1-23` red-flags — the files were accepted.
The lake holds 249 signals per run, so the data existed; only the registry's
inventory was missing.

Signals have no route of their own. They ride inside the `POST /files` body as
`"signals": inventory.signal_rows()` (`tm-connector/connector/bodies.py:153`),
accumulated from the sample batches and finalised on the terminal
`file_complete` marker. The registry writes them in one place, inside the
`status == "registered"` branch of `register_file_document`.

The replay guard returns before that branch:

```
replay = _existing_registered(...) or _existing_quarantined(...)
if replay is not None:
    return replay, False          # returns here
...
if status == "registered":
    queries_signals.upsert_file_signals(db, doc, body.signals)   # never reached
```

The connector's own log holds the timeline:

* `09:05:18` `POST /files` -> **201 Created**. The `Porsche_Taycan` DBC was
  absent from DCM, so the decode produced no channel, the body carried
  `signals: []`, and `upsert_file_signals` returned early on `if not signals`.
  The file document was minted with `signal_count: 0`.
* `09:18:00` `POST /files` -> **200 OK**. The DBC was restored, the file was
  re-decoded, and the body carried all 249 signals. `_existing_registered`
  matched on `(checksum, run_id)` and the inventory was thrown away.

The guard is right to exist — it is what makes a Kafka redelivery idempotent.
What it could not tell apart is *"same bytes, same empty result"* from *"same
bytes, now with a real inventory"*.

## The fix

`api/api/routers/files.py::_fill_empty_inventory`, called at the one replay
return in `register_file_document`. Two conditions, one call; the register path
is otherwise untouched.

```python
if not signals or file_doc.get("status") != "registered":
    return file_doc
if db["file_signals"].find_one({"file_id": file_doc["_id"]}, {"_id": 1}) is not None:
    return file_doc
```

The emptiness test reads `file_signals`, not the file's stored `signal_count`.
That collection is what `run_facts` counts and what the file detail lists, so
the hole is defined by the rows that are missing rather than by a derived
number that could itself be stale. `(file_id, name)` is a unique index
(`api/api/db.py:141`), so the probe is an index-prefix lookup — one cheap read
added to a replay.

What each case does after the fix:

| Case | Behaviour |
|---|---|
| True duplicate delivery (same body, inventory already stored) | Identical to before: 200, the stored document, no write. The second condition short-circuits on the first stored row. |
| Replay filling an empty inventory | Writes `file_signals` + the catalogue via `upsert_file_signals`, sets the file's own `signal_count`, re-runs the run rollup, answers 200. |
| Replay with a conflicting inventory | Identical to before: 200, the stored document, nothing written. |
| First registration | Untouched. The guard does not fire. |
| Replay of a **quarantined** file | Untouched. The status test refuses it, so the quarantine rules keep feeding neither inventory nor catalogue. |
| `check_replay=False` (`POST /files/{id}/versions`) | Untouched. No replay lookup runs, so no fill runs. |

### A conflicting inventory is left alone — deliberately

A replay carrying a *different, non-empty* inventory for a file that already
holds one is a **conflict, not a hole**. Two decodes of the same bytes
disagreeing about what those bytes contain is a fact worth seeing; silently
replacing the stored inventory would hide it, and it would reopen the door the
replay guard exists to close — a redelivery that keeps rewriting history. The
stored inventory stays, and
`test_a_replay_with_different_metadata_returns_the_stored_body`
(`api/tests/test_files_idempotency.py:232`) still pins that.

### `signal_count` — both of them

Two documents carry a count, and the fill corrects both:

* **The file's own `signal_count`** is written by `update_one` in the fill,
  `len({signal.name for signal in signals})` — the same expression the
  registration uses (`files.py:1273`), because the inventory keys on
  `(file_id, name)` and a repeated name stores one row. Without this write the
  file detail would serve a 249-row `signals` list under a badge reading 0:
  `get_file_detail` (`api/api/services/queries_signals.py:193-212`) returns the
  stored document beside the live rows.
* **The run's `signal_count`** comes from `apply_file_rollup`
  (`api/api/services/queries_runs.py:1396`), which the fill calls after the
  rows are stored. The rollup takes no signal names of its own: `run_facts`
  (`queries_runs.py:686`) counts the distinct `file_signals` names of the run,
  so the fill needs only to have written the rows first. `apply_file_rollup`
  does **not** run on the replay path otherwise — the early return is above
  it — which is why the fill calls it rather than relying on the register path.

The returned document is `{**file_doc, "signal_count": count, ...}`, so the 200
body agrees with what was just stored.

### Deliberately not done

* **No journal entry.** The fill completes a registration that was already
  journalled; a second `file.registered` event would double the arrival story
  on the file detail's timeline.
* **No new route, no new field, no migration, no backfill.** The four stuck
  files are recovered operationally — see below.
* **No change to the replay identity, the quarantine rules, or
  `upsert_file_signals`'s write precedence.** A manual unit on a catalogue row
  still outranks a file's unit on the fill, exactly as on a registration.

## File inventory

| File | Change |
|---|---|
| `api/api/routers/files.py` | New `_fill_empty_inventory` above `register_file_document`; the replay return calls it; the `POST /files` docstring no longer claims a replay always writes nothing. |
| `dev-planning/signal-inventory-replay/architecture.md` | This document. |

Nothing else was touched. `tm-connector/` is correct — it sent the inventory
and the registry dropped it.

## How it sits with its neighbours

* **Upstream**: `mf4-decoder` emits samples plus one `file_complete` marker;
  `tm-connector` accumulates the inventory across the samples and posts it with
  the marker (`tm-connector/connector/bodies.py:153`). The producer needs no
  change and gets no new contract.
* **Downstream**: `GET /signals` (the catalogue), `GET /files/{id}` (the file
  detail's `signals` block) and `GET /test-runs/{id}/signals` all read
  `file_signals` or the `signals` catalogue that `upsert_file_signals` feeds.
  Filling the inventory is what lights all three panes.
* **The run read model** is untouched: `run_facts` stays the one answer to "how
  many signals does this run hold", derived from the rows, so the fill cannot
  make a stored number and a served number disagree.

## Recovering the four stuck files

The four battery traces (runs `TAS-1001`…`TAS-1004`) are at zero signals and
the fix alone does not repair them: nothing will re-`POST` on its own, because
the decoder's dedup state says those sha256s are already done
(`mf4-decoder/idempotency.py:84,146`). **Nothing below was run.** It is written
to be executed by hand, in order, against
`testrigorg-commacarsegmentsingest-jamaui`.

### Recommended — with the fix deployed

1. Deploy the API carrying `_fill_empty_inventory`.
2. Set `FORCE_REDECODE=true` on the `mf4-decoder` deployment and let it
   restart. Confirm the boot line "FORCE_REDECODE=true: the decode-once filter
   is bypassed".
3. Re-upload the four traces through MF4 Import. The bytes may be identical —
   the dedup identity is `sha256:<digest>` and `FORCE_REDECODE` bypasses it, so
   no route-timestamp change is needed.
4. On each `file_complete` marker the connector posts the full 249-signal
   inventory. `_existing_registered` matches, the file has no inventory, and
   the fill writes it. Verify: `GET /api/v1/signals` returns a non-zero
   `total`, each run reads `signal_count: 249`, each file detail lists its
   signals.
5. Set `FORCE_REDECODE` back to `false` and restart the decoder. Left true, it
   makes every replayed `mf4_metadata` message add another full copy of its
   file to the lake.

**Cost of steps 2-3:** the re-decode writes a second full copy of each trace's
rows into `battery_data_v1`. That is the duplication the decode-once filter
exists to prevent, and any implementation that aggregates over a run will see
each sample twice. Either drop the four runs' lake partitions
(`platform/work_order/run_id`) before step 3, or accept the duplicate rows
knowingly.

### Fallback — if the fix is *not* deployed

Same as above, with one extra step before step 3: hard-delete the four file
documents, so the re-decode registers fresh instead of replaying.

```js
// mongo-explorer / mongosh, against the Test Manager database
db.files.find(
  { run_id: { $in: ["TAS-1001", "TAS-1002", "TAS-1003", "TAS-1004"] } },
  { _id: 1, filename: 1, checksum_sha256: 1, signal_count: 1 }
)                                   // confirm signal_count is 0 on all four
db.file_signals.deleteMany({ file_id: { $in: [/* the four _ids */] } })
db.files.deleteMany({ _id: { $in: [/* the four _ids */] } })
```

`DELETE /api/v1/files/{id}` is **not** a substitute: it is a soft delete that
writes `lifecycle: "deleted"` and leaves the document, so `_existing_registered`
still matches it and the replay still swallows the inventory. After the hard
delete the runs' stored `file_count` is stale until the next registration
re-derives it — step 4 does that.
