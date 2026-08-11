# CAN ingest backlog

Everything here is **parked until Tomas's work lands**, to avoid a second
`quix.yaml` collision like the one on 2026-08-10. Order within each section is
by value per unit of effort.

Status legend: `[ ]` not started · `[~]` in progress · `[x]` done ·
`[!]` blocked on someone else.

---

## 0. Blocked on Tomas

- [!] **Rebase the four uncommitted files** onto Tomas's branch rather than
  merging. Currently modified in the worktree, not committed:
  `can-lake-sink/flatten.py`, `can-lake-sink/main.py`, `mf4-replay/main.py`,
  `mf4-replay/decode.py` (the `t_rel_ms` rename).
- [!] Two commits are already on `origin/main` but **not synced to the portal**:
  `9fd8116` (`SINK_UNKNOWN_FRAMES` toggle) and `39dbb3a` (`MAX_SEGMENTS=0`).
  Portal `pull` + `sync` still to run.

---

## 1. Time axis — `t_abs_ms` (requested 2026-08-10) — **OWNER: Tomas**

**Goal:** an absolute millisecond column that Grafana can plot directly.

**Producer side is DONE (2026-08-11), uncommitted in the worktree.**
`mf4-replay/main.py` now emits, per envelope:

```python
seg_anchor_ms = int(source_ts_ms)   # captured ONCE per segment, before the loop
"t_rel_ms":      round(t_rel * 1000, 3),
"seg_anchor_ms": seg_anchor_ms,
"t_abs_ms":      int(seg_anchor_ms + round(t_rel * 1000)),
"ts_ms":         unchanged,
```

Decisions taken: anchor stays in **mf4-replay** (not moved back to the
converter — confirmed 2026-08-11); anchor is the broker timestamp of the
segment's single `mf4-metadata` message; `t_abs_ms` is a *presentation* anchor,
not a claim about drive time. Verified: anchor constant across envelopes,
10 ms spacing preserved, 59.99 s segment spans 59.99 s, no double-count.

**Remaining — sink side, 4 lines** (row schema only, does not touch
partitioning, so it should not collide with the virtual-partition-column work):

```python
# flatten.py  SIGNAL_COLUMNS and UNKNOWN_COLUMNS
"t_abs_ms", "seg_anchor_ms",
# flatten.py  base{}
"t_abs_ms":      value.get("t_abs_ms"),
"seg_anchor_ms": value.get("seg_anchor_ms"),
```

Open decision for whoever does it: whether `t_abs_ms` replaces `ts_ms` as the
sink's `timestamp_column` (`can-lake-sink/main.py:69`). `t_abs_ms` is the better
basis — computed from payload fields, so it survives broker timestamp semantics
and re-produces; `ts_ms` does not. Matters more once partitions are derived
from it.

Also uncommitted from the same run: the `t_rel` → `t_rel_ms` rename across
`can-lake-sink/flatten.py`, `can-lake-sink/main.py`, `mf4-replay/decode.py`.

Agreed shape:

| column | meaning |
|---|---|
| `t_rel_ms` | ms from zero, relative to the start of its segment. 0 … ~60000. Done, uncommitted. |
| `t_abs_ms` | **new.** anchor + `t_rel_ms`, absolute ms. |
| `ts_ms` | unchanged, keeps its current name and meaning. |

- [ ] **Decide what "minimum timestamp" anchors to.** This is the one open
  question and it changes the result completely:
  - (a) *per-file* — each MF4's own `mf4-metadata` Kafka timestamp. This is
    exactly what `ts_ms` already computes, so `t_abs_ms` would duplicate it.
  - (b) *global minimum* — one anchor for the whole replay, shared by every
    segment. Simple, but every segment still starts at the same instant.
  - (c) *per `(device, route)`, segment-ordered* — anchor + `segment_index *
    60000 + t_rel_ms`, so a route's segments lay **end to end**.
- [ ] **Recommendation: (c).** The reason plotting is awkward today is not the
  unit, it is that **segments overlap**. All 20 files were announced inside the
  same short replay window, so 20 × 60 s of driving collapses into a ~107 s
  span and every drive is stacked on top of the others. (a) and (b) both keep
  that overlap; only (c) produces a monotonic per-route timeline, which is what
  a Grafana time series needs.
  - Caveat to confirm: segment indices are the rlog segment numbers (34, 45,
    67, 105, 114 …) and are **not contiguous** — the mirror only copied some.
    Multiplying by 60000 leaves real gaps, which is arguably correct (missing
    data should look missing) but must be a conscious choice.
- [ ] Implement in `mf4-replay/main.py` next to the existing payload keys, carry
  through `can-lake-sink/flatten.py` `SIGNAL_COLUMNS` / `UNKNOWN_COLUMNS`.
- [ ] Decide whether `t_abs_ms` or `ts_ms` becomes the sink's
  `timestamp_column` (`can-lake-sink/main.py:69`) — it drives Iceberg pruning.
- [ ] Land **before** `can_signals_v3` registers. Adding a column later is
  cheap; changing the partition/timestamp column afterwards is a migration.

---

## 2. Confirmed bugs from the 2026-08-10 audits

Reports: `scratchpad/audit-sink-vs-samples.md`,
`scratchpad/audit-dcm-vs-samples.md`. Claims below were verified against
released quixstreams 3.25.0, not the local unreleased fork.

- [ ] **Write red-first tests for these three before fixing** (house rule: a
  finding with no red test is plausible, not confirmed).
- [ ] **`fallback="default"` on `QuixConfigurationService`**
  (`mf4-replay/main.py:188`). SDK default is `"error"`, which re-raises inside
  `join()` and kills the app — this is the mechanism behind both DCM-wipe
  crash-loops. `default=None` does *not* cover it. One keyword argument.
- [ ] **`COMMIT_EVERY` counts input messages, not rows.** 2000 envelopes ×
  ~200 rows ≈ 400k dicts per checkpoint in a 2000 MB pod. Most likely OOM
  source. Drop to 100–200, or raise the memory limit.
- [ ] **Declare `input` in the `CAN lake sink` deployment block** and change
  `can-lake-sink/main.py:55` to `os.environ["input"]`. Today it silently falls
  back to a literal, so the pipeline graph draws no edge into the sink.
- [ ] **Pin the quixstreams SHA, not the branch.** `requirements.txt` tracks
  `@task/datalake-column-stats`, whose HEAD moved during the audit. Pin
  `ac385fc`, route through `quixstreams[quixdatalake]` so `pandas<3.0` /
  `pyarrow>=17.0.0` floors come back, bump `quixportal[all]>=2.0.2`.
- [ ] Add `on_client_connect_success` / `on_client_connect_failure`,
  `auto_create_bucket`, `max_workers` to the sink constructor — the portal's
  "Test connection & deploy" flow depends on the callbacks.
- [ ] Set `stats_columns` explicitly (we pinned the branch *for* this and never
  configured it).
- [ ] Reconcile the three disagreeing `HIVE_COLUMNS` sources (`app.yaml`
  default, `quix.yaml` value, the code comment). Deployed layout has **no**
  time partitioning, so the comment about year/month/day is false in
  production. A layout change forces a new table name.

---

## 3. DCM durability

- [ ] **`contentStore: file`** on the DCM deployment. Today the default `mongo`
  store keeps the 0.90 MB DBC *inside* the Mongo document, on ephemeral disk —
  which is why DCM has been wiped twice. `file` puts content in blob; only
  metadata needs re-seeding.
- [ ] **Remove `state: {enabled: true, size: 1}` from the MongoDB deployment**
  or mark it `# EPHEMERAL`. The volume is provisioned and unused
  (`mongodb/init.sh` writes to local `/data/db`), so `quix.yaml` currently
  reads as durable when it is not.
- [ ] **Commit a seeder** so wipe recovery is reproducible instead of a manual
  REST session. `scratchpad/upload_bundle.py` is the working prototype (24
  configs incl. the platform→DBC map). Note `POST /api/v1/configurations` with
  `replace: true` creates *or* versions; `PUT /{id}` only updates and 404s.
- [ ] Replace `json_field(jsonpath="$")` with `bytes_field` and parse once in
  `db_cache`. `$` costs a full unpickle of the 0.90 MB document **per message**.

---

## 4. Schema decisions to make before `can_signals_v3` registers

- [ ] **Drop `channel_name`?** It is 1:1 derived from `channel`, the names are
  a hardcoded Ford-only map, and the digit in the label is off by one from the
  column (`powertrain_hs_can1` is channel 0). With 22 DBCs now covering other
  brands it will be confidently wrong on the first non-Ford platform. Prefer a
  `(platform, channel)` dimension, or source names from the DBC config.
- [ ] Verify the Ford bus mapping itself. Everything that decodes lands on
  channel 2; `powertrain_hs_can1` decodes nothing. The 0/1/2 ↔ openpilot `src`
  mapping is faithfully carried through the code, but *that Ford powertrain is
  src 0* is inherited convention, not something this dataset proves.

---

## 5. Coverage and scale

- [ ] **Raise `can-decoded` retention before the full run.** 5.37 GB today;
  206 segments push ~19.6 GB. Not a capacity limit — a limit on how long the
  sink can be down before data is lost, which just happened. Body must be flat
  (`retentionInBytes` at top level; nested returns 200 and does nothing).
- [ ] **DBC repair pass for the 18 unparseable of 40.** Five syntax patterns
  cover all of them (Honda `CM_ SG_`, Chrysler `SG_ ENGINE_TORQ_MAX`,
  `hyundai_kia_generic` `CM_ 145`, `mazda_2017` digit-leading name,
  `honda_crv_ex_2017_body` 11-bit id). openpilot uses its own C++ parser, not
  cantools. `hyundai_kia_generic` alone unlocks 40 platforms / 14,706 segments.
  Also fix the two nissan DBCs (`Database.nodes` is read-only — construct
  differently, don't assign).
- [ ] **Multi-platform converter.** `rlog-to-mf4` embeds one DBC and one
  `PLATFORM`, stamping every MF4 with the same `DCM_TARGET_KEY`. To use the
  other 21 DBCs it must look up platform per device and pick from the
  `dbc_map` config. Real change, not a variable.
- [ ] **Converter selection bias.** Candidates drain device by device, so the
  first 20 files all came from `0b2c0bec9a28eb0f`. `MAX_SEGMENTS=0` fixes it
  for a full run; round-robin would be needed for a representative sample.
- [ ] **Re-run the HF mirror with a platform filter.** OOM-killed (exit 137) at
  206/230 Ford segments; three devices empty, two truncated. Filtering
  `list_repo_files` by the target platform turns 188k files into a few hundred
  and removes the memory pressure — better than raising the limit.

---

## 6. Open questions

- [ ] **`can_signals` reads 6,929,823 rows vs 31,532,927 measured three days
  earlier**, same ts range and route count. Unexplained. Leading hypothesis:
  the catalog's registered partition spec for that table is
  `platform, device, route, channel, sender_node, frame_name, signal,
  channel_name` — eight columns, the *old* deep layout — most likely because
  `auto_discover=True` inferred it from parquet left under the same prefix from
  an earlier run. If the spec changed, queries resolve a different file set and
  rows could be present in blob but invisible to the table. **Not confirmed.**
  Rule to adopt either way: never reuse a table name over a prefix that still
  holds files from a previous layout.
- [ ] ~765k rows in `can_signals` predate the timestamp fix and sit collapsed
  at `ts_ms = 1785925833288`. That value is also the legitimate first
  timestamp, so they cannot be filtered out — needs a drop and re-sink.
  `/delete` is 403 for the current token.

---

## 7. Skills / docs

- [x] `quix-lakehouse` §2b rewritten (2026-08-10) — split into tables via
  `QuixTSDataLakeSink` vs raw objects via `quixportal.get_filesystem()`. The
  old text forbade the built-in sink, which pushed implementations toward
  hand-rolling their own.
- [ ] Add the DCM rules to `quixstreams-idioms`: why `fallback="default"` is
  mandatory and that `default=` does not substitute for it; never
  `jsonpath="$"` on a large document; config `type` is fixed at build time
  while `target_key` varies per message; DCM durability is a deployment
  decision.
- [ ] Correct the module docstring at `can-lake-sink/main.py:1-26`, which
  defends the sink route against a "sanctioned `/insert`" that the official
  sample never uses.
