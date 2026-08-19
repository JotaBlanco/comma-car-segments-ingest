# MF4 ingest pipeline

Port of the MF4 upload -> blob -> lakehouse chain from the source sandbox repo,
plus two added features:

* a unique key minted per upload that survives every hop and lands as a
  queryable Iceberg column;
* CAN bus-logging decode in `mf4-decoder`, using the DBC embedded in the MF4
  itself, so the lake gets named signals instead of raw frame fields.

## Shape

```
browser
  |  Azure backend      (upload_mode "sas"):
  |    POST /upload/sas       (mint key + SAS URL)
  |    PUT  -> Azure Blob     (bytes never touch the app)
  |    POST /upload/complete  (verify size, produce metadata)
  |  Any other backend  (upload_mode "direct"):
  |    POST /upload/direct    (mint key, stream body -> blob, produce metadata)
  v
mf4-to-blob  --[topic mf4_metadata]-->  mf4-decoder  --[topic mf4-to-msg]-->  mf4-datalake-sink
     |                                       |                                      |
  blob write                       asammdf decode; CAN bus                  QuixTSDataLakeSink
  (blob_prefix)                    logging decoded via the                    -> Iceberg table
                                   embedded DBC; per-channel batches             (TABLE_NAME)
```

Three deployments in `quix.yaml`: `MF4 Import` (mf4-to-blob), `MF4 Decoder`
(mf4-decoder), `MF4 DataLake Sink` (mf4-datalake-sink). Two topics:
`mf4_metadata`, `mf4-to-msg`.

## Upload paths

Two paths into blob storage. Which one the browser uses is decided by the
server and reported by `GET /config` as `upload_mode`; the browser never
guesses.

| | `sas` | `direct` |
| --- | --- | --- |
| Backends | Azure only | Azure, S3, S3Compatible, Minio, Gcp, Local |
| Bytes through the app | no | yes (streamed) |
| Endpoints | `/upload/sas` + `/upload/complete` | `/upload/direct` |
| `sha256` on `mf4_metadata` | `null` | hex digest |

`direct` exists because SAS is an Azure-specific construct: this workspace's
backend is `S3Compatible`, so `/upload/sas` could only ever answer HTTP 501
(`sas.py::extract_azure_credentials`). Rather than hand-roll a presigned-PUT
equivalent per provider, the direct path reuses the fsspec filesystem that
`blob.py` already builds from the auto-injected
`Quix__BlobStorage__Connection__Json` — the same object `mf4-decoder` reads
blobs with. No bucket/endpoint/key variables are introduced anywhere.

**Provider detection** — `blob.get_provider()` reads
`quixportal.storage.config.load_config_from_env().provider` once and caches
it. `main.py::_resolve_upload_mode` maps `Azure -> sas`, anything else (and an
unreadable config) `-> direct`. The `upload_mode` deployment variable
(`auto` by default) can pin a path for debugging; `sas` on a non-Azure backend
is then the only way to still see the 501.

**Direct request shape** —
`POST /upload/direct?filename=<name>&size=<bytes>` with the raw file as the
body (`application/octet-stream`, no multipart envelope). The handler mints
`upload_id` via `metadata.make_upload_id` — once, before the first byte is
written — resolves the blob path, then pumps `request.stream()` chunk-by-chunk
into `blob.open_writer()`, hashing as it goes. Peak memory is one fsspec block,
not one file. The fsspec writer is synchronous and its flushes are network
calls, so every `write`/`close` is dispatched through `anyio.to_thread` to keep
the event loop free for concurrent uploads and `/progress` polls. `state.py` is
updated per chunk exactly as before. After the last chunk: size check against
the client-declared `size`, `metadata.build_payload(...)` (with the streamed
`sha256`), one `mf4_metadata` message keyed by `upload_id`, then status `done`.
Any failure removes the partial blob via `blob.safe_remove`.

**Frontend** — `static/index.html` awaits `/config` before the first upload and
branches in `startUpload`: `startSasUpload` (unchanged) or `startDirectUpload`,
which uses `XMLHttpRequest` because `fetch` exposes no upload-progress event.
The Azure SDK import became dynamic, so a non-Azure workspace never contacts
the CDN.

## The unique key

**Format** — `<safe_stem>-<hash12>`

* `safe_stem` — uploaded filename, directories and extension stripped, every
  character outside `[A-Za-z0-9._-]` replaced with `_`, truncated to 64 chars
  (`upload` if nothing survives). Keeps the key human-readable so a lake row can
  be eyeballed back to its source file.
* `hash12` — first 12 hex chars of
  `sha256(f"{filename}\x00{minted_at.isoformat()}")`, where `minted_at` is UTC
  with microsecond resolution. This is the "hash from filename and time" that
  makes re-uploads of an identically named file distinct.

Worked example: `Recording 001.mf4` uploaded at `2026-08-19T10:22:33.123456+00:00`
-> `Recording_001-7a9622106da0`.

**Minted once**, in `mf4-to-blob/metadata.py::make_upload_id`, called from
`main.py::upload_sas` (SAS path) or `main.py::upload_direct` (direct path),
where it replaces the previous `uuid.uuid4()`. Minting before the bytes move —
not at completion time — means one value serves as the browser's `uploadId`,
the in-process progress-registry key, the Kafka message key and the metadata
`id`: a single identity for the whole upload, whichever path it took.

**Field name at each hop** (deliberately kept as the source repo had it on
`mf4_metadata`):

| Hop | Field |
| --- | --- |
| `mf4_metadata` message | `id` |
| `mf4-to-msg` message | `upload_id` |
| Iceberg column | `upload_id` |

`id` is retained on `mf4_metadata` because that field already existed and other
consumers may read it. Downstream the name is `upload_id` — `id` is ambiguous as
a column name in a wide time-series table, and `upload_id` matches the internal
variable name already used throughout the code.

## Where the key flows in code

* `mf4-to-blob/metadata.py::make_upload_id` — mints it; docstring is the format
  spec.
* `mf4-to-blob/main.py::upload_sas` — `upload_id = metadata.make_upload_id(...)`.
* `mf4-to-blob/main.py::upload_complete` — passes it to `build_payload`, which
  emits it as `id`; also used as the Kafka message key.
* `mf4-to-blob/main.py::upload_direct` — mints and consumes it in one request:
  progress key, `build_payload` argument and Kafka key, all the same value.
  Both paths publish through `main.py::_produce_metadata`, so the message is
  built and keyed identically.
* `mf4-decoder/main.py::process` — `upload_id = metadata.get("id")`; warns if
  absent rather than dropping the file.
* `mf4-decoder/main.py::_emit_signals` — the shared per-signal loop used by
  both the decoded-CAN pass and the ordinary-channel pass; takes `upload_id`
  and hands it to `_emit_channel` unchanged, so decoded signals carry the key
  exactly like raw channels do.
* `mf4-decoder/main.py::_emit_channel` — threaded through **both** emit paths:
  the vectorized numeric fast path and the object/bytes fallback used by
  string/bytes channels. Missing either would silently drop the key for one
  class of channel.
* `mf4-decoder/main.py::_produce_batch` — writes `upload_id` into every batch.
* `mf4-datalake-sink/main.py::_expand_columnar` — repeated onto every expanded
  row alongside `file_name`, `channel`, `unit`.

## Iceberg columns

`file_name`, `upload_id`, `channel`, `unit`, `ts_ms`, `value`, `value_text`
(plus the year/month/day/hour Hive partitions derived from
`TIMESTAMP_COLUMN=ts_ms`).

`value` is always a float or null; `value_text` is always a string or null.
The split is per **channel**, decided from the samples' numpy dtype in
`mf4-decoder/main.py::_is_numeric_dtype`, and every emitted record carries both
keys with one of them null. Numeric signals fill `value`; string/bytes channels
and CAN signals resolved through a DBC `VAL_` value table (which decode to
`'D'`, `'P'`, `'R'`, ...) fill `value_text`. One shared `value` column made
PyArrow infer `double` from a file's leading rows and raise `ArrowInvalid` on
the first string.

`HIVE_COLUMNS` is `upload_id`. It was previously `channel`, which put exactly
one signal in each parquet file and so hid the mixed-type `value` problem, but a
608-signal file then flushed 657 files at a time. One partition per upload
trades that for unbounded partition cardinality over time; `channel` remains a
normal queryable column.

## CAN bus-logging decode

A CAN bus-logging MF4 does not contain signals. It contains **raw frames**: one
channel group whose channels are `CAN_DataFrame` plus its members
(`CAN_DataFrame.ID`, `.DLC`, `.DataBytes`, `.BusChannel`, ...). The reference
sample (`20.mf4`, MDF 4.10, asammdf 8.8) is exactly this: one group,
`acq_name='CAN'`, 230,219 cycles, 11 channels, all frame plumbing — plus one
attachment, `hyundai_kia_generic.dbc` (95,188 bytes, mime `application/x-dbc`).
Walking those channels the ordinary way puts frame plumbing in the signals
table, which is why the decoder now branches.

### Detection

`_is_can_bus_logging_group(group)` marks a channel group as raw CAN frames if
**either** test passes:

1. **MDF4 metadata** — `channel_group.flags & CG_BUS_EVENT` and
   `channel_group.acq_source.bus_type == BUS_TYPE_CAN`. This is the same test
   asammdf applies in `MDF4._extract_can_logging`; groups that fail it are the
   ones asammdf refuses to decode. The two constants are copied into
   `main.py` rather than imported — `asammdf.blocks.v4_constants` is internal
   and has moved between majors.
2. **Channel names** — the group exposes `CAN_DataFrame` or a
   `CAN_DataFrame.<field>` member.

Test 2 is what actually decides whether emitting the group would put frame
fields on the wire, and files in the wild do not always set the MDF4 flags.
`acq_name` (usually `"CAN"`) is logged but never a trigger on its own: it is
free text, and nothing stops an ordinary measurement from using the same
string.

### Attachment selection

`_find_dbc_attachments` returns **every** attachment whose mime contains `dbc`
(writers are inconsistent; the sample uses `application/x-dbc`) **or** whose
file name ends in `.dbc`. All matches are passed to asammdf, not just the
first — a recording may embed one database per bus, and `extract_bus_logging`
takes a list. Each is mapped to bus channel `0`, meaning "any bus channel":
the embedded database is by definition the one that describes this file.

### Extraction and decode

```
mdf.extract_attachment(index=i)      -> (bytes, name, md5)
write bytes to <tmpdir>/embedded_<i>.dbc
mdf.extract_bus_logging(database_files={"CAN": [(path, 0), ...]})
```

Two non-obvious constraints, both discovered the hard way:

* **The DBC must be a real file on disk.** `extract_bus_logging` calls `Path()`
  on each database entry, so a `BytesIO` is rejected with `TypeError`.
* **The file must end in `.dbc`.** `asammdf.blocks.utils.load_can_database`
  dispatches its parser on `path.suffix`. The temp file is therefore named by
  attachment index (`embedded_0.dbc`), not by the attachment's own file name,
  which is arbitrary writer-controlled text and is used only for logging.

The temp directory is created with `tempfile.mkdtemp` and removed with
`shutil.rmtree` in `process()`'s `finally`, alongside the decoded `MDF.close()`
and the existing `.mf4` unlink.

On the sample this yields **608 signals across 59 message groups in ~0.2 s** —
`ACC_ObjDist`, `ACC_ObjRelSpd`, `AEB_Status`, `Brake_Pedal_Pos`,
`CR_Yrs_Yr` (`deg/s`), and so on.

### Emission

Decoded signals go through the **same** `_emit_signals` -> `_emit_channel` ->
`_produce_batch` path as ordinary channels, so batching, NaN scrubbing, the
numeric fast path and `upload_id` are all shared. Signal names repeat across
CAN message groups, so the existing first-occurrence-bare /
`"<name>#g<group_index>"` rule does the disambiguation; `seen_names` is shared
across the decoded and raw passes for one file so the two can never collide.

Masters of decoded groups are **not** emitted. A decoded group's master is just
the frame timestamp, which already rides on every batch as `ts_ms`; emitting 59
`t#gN` channels would add ~230k junk rows per file. Masters of ordinary
(non-bus) groups are still emitted, unchanged.

### Decoded-signals-only policy

Raw `CAN_DataFrame.*` fields are **never** written to the signals table. If a
bus-logging file yields no decodable signals — no embedded `.dbc`, an
unparseable database, `extract_bus_logging` raising, or a DBC that matches none
of the frames — the decoder logs a warning naming the dropped channel and frame
counts and produces nothing for that group. It does not crash, and it does not
drop silently.

A file can mix both kinds: bus-logging groups are decoded, and any ordinary
groups in the same file are still emitted verbatim. Files with no bus-logging
group at all take exactly the path they took before this change.

### `DBC_SOURCE`

`DBC_SOURCE=embedded` (default) uses the DBC inside the MF4.
`DBC_SOURCE=none` disables decoding entirely — bus-logging files then produce
nothing, per the policy above. Anything else logs a warning and is treated as
`embedded`. External DBC fetching is deliberately **not** implemented; the knob
exists so it can be added later without changing today's behaviour.

`canmatrix` is listed explicitly in `mf4-decoder/requirements.txt`. It is
already a hard `install_requires` of `asammdf` and its DBC reader needs no
extras (only arxml/xls do), but pinning it explicitly means a future asammdf
that drops the dependency cannot silently break decoding at deploy time.

### Message volume

For the sample file, ~608 signals x ~3.9k samples each is on the order of
2.3-2.4M records — comparable to the 2.53M the raw path emitted (11 channels x
230,219). At the deployed `BATCH_RECORDS=5000` that is roughly 700-1,200 Kafka
messages; at the code default of 100 it would be ~24,000. The fan-out is a
change in *shape* (many narrow streams instead of 11 wide ones), not a
step change in volume.

## Notes

* Decoding happens in `mf4-decoder`, not in the sink. The blob is already open
  in asammdf there and `extract_bus_logging` costs ~0.2 s; pushing 230k raw
  frames through Kafka to decode downstream would be far more traffic. The sink
  stays a thin writer over already-decoded per-channel batches.
* `mf4-to-blob` keeps upload progress in process memory (`state.py`), so it is
  single-replica only. Scaling it past `replicas: 1` breaks `/progress/{id}`.
* `mf4-datalake-sink/requirements.txt` pins QuixStreams to an unreleased branch
  (`quixlakesink-fix-v3`). Kept deliberately; see the risk note in the handover.
* The sink validates its config at boot: `_positive_int` rejects a non-positive
  `COMMIT_INTERVAL` / `BATCH_SIZE` / `MAX_WRITE_WORKERS`, and `TABLE_NAME` must
  match `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`. Both fail the deployment immediately
  rather than minutes into a run at the first catalog PUT. `SORT_COLUMN` is
  forwarded to `QuixTSDataLakeSink` only if `inspect.signature` shows the
  installed QuixStreams accepts the kwarg, so moving the pin cannot break boot.
* Catalog wiring: the URL is read from `Quix__Lakehouse__Catalog__Url` with
  `CATALOG_URL` as a legacy fallback; the auth token is read **only** from
  `Quix__Lakehouse__Catalog__AuthToken`, which is the sole name the platform
  injects it under.
