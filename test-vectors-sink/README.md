# test-vectors-sink

Four vector topics into four Iceberg tables, one `Application`, four
dataframe -> `QuixTSDataLakeSink` pairs.

| Topic | Table | Rows per 40 s trace |
|---|---|---|
| `test-vectors-pt-can-100hz` | `acc_pt_can_100hz` | ~4 000 |
| `test-vectors-radar-obj-50hz` | `acc_radar_obj_50hz` | ~2 000 |
| `test-vectors-hmi-10hz` | `acc_hmi_10hz` | ~400 |
| `test-vectors-sim-ref-100hz` | `acc_sim_ref_100hz` | ~4 000 (reference group; never readable by a verdict) |

Fixed layout on all four tables:

- `hive_columns = ["device_id", "scenario"]`
- `timestamp_column = "ts_ms"`
- `s3_prefix = "data-lake/time-series"`, `namespace = "default"`

`trace_key` is a column on every row but is **not** a partition column: it is
per-trace, which is precisely the high-cardinality case that must not partition.
Queries still push down because the trace registry supplies `device_id` and
`scenario` alongside the `trace_key`.

**Changing `hive_columns` is a migration, not a configuration change.** The sink
validates the partition set against catalog metadata and the on-disk Hive paths
at `setup()` and raises. A layout change means a new table name and a re-sink of
every trace.

Requires `blobStorage: {bind: true}` for the blob credentials and the
`Quix__Lakehouse__Catalog__*` variables. If the pinned QuixStreams version
refuses four dataframes in one `Application`, deploy the `lakehouse-sink`
application four times instead with different `input`/`TABLE_NAME`/`HIVE_COLUMNS`
values - same image, same constructor arguments, no code change.
