# Signal fixture — `acc_signals.csv.gz`

The decoded CAN signals the three implemented test cases are evaluated over, at their
native rasters. **Nothing here is hand-authored and nothing may be hand-edited** —
regenerate instead:

```
# from the measurements the lake was ingested from (workstation, needs asammdf + numpy)
python backend/api/vm_eval/fixtures/build_acc_signals.py --from-mf4 C:/repos/acc_project

# from the lakehouse itself (run inside a Quix deployment; the Query API is not
# reachable from a workstation)
python backend/api/vm_eval/fixtures/build_acc_signals.py --from-lake
```

## What it is for

`api/vm_eval/signals.py` reads the lakehouse Query API when `Quix__Lakehouse__Query__Url`
is set and falls back to this file otherwise. That is not a mock: it is the same signal
series, so the verdicts and the plots are identical either way. It exists because local
development has no lakehouse at all, and a Test Report that renders empty is worse than one
that renders from a committed copy of the same bytes.

## Provenance

`--from-mf4` reads `acc_project/Data/**`, which is the source the MF4 Import → MF4 Decoder →
MF4 DataLake Sink pipeline ingested into `mf4_signals_v4`. One file per test case, the
variant named in that test case's `recommended_scenario`:

| tc_id | route | measurement | scenario |
|---|---|---|---|
| `ACC-SYS-TC-011` | `00011` | `follow_steady_timegap__tau08__80c3cb927293.mf4` | `follow_steady_timegap/tau08` |
| `ACC-SYS-TC-014` | `00014` | `lead_brake_ccrb_4mps2__v130__d3c693ca7316.mf4` | `lead_brake_ccrb_4mps2/v130` |
| `ACC-SYS-TC-016` | `00016` | `cruise_set_speed_max__base__122c536c8f4d.mf4` | `cruise_set_speed_max/base` |

All three live under `platform=SKODA_OCTAVIA`, `device=a0001` in the lake.

## Schema

```
segment,signal,ts_ms,value
```

`segment` is the `tc_id`, a plain column in the lake. `platform` / `device` / `route` are
Hive partitions, constant per segment, and are held in `api/vm_eval/catalog.py` rather than
repeated on 32 812 rows. Values carry six decimals with trailing zeros trimmed: the
tightest figure the report prints is a 2 s moving average read to four decimals, and a
per-sample rounding error of 5e-7 cannot move that average by more than 5e-7.

`--from-lake` deduplicates on `(signal, ts_ms)` while reading. Every sample is in the lake
five times over under distinct `upload_id`s; without the dedup every sample count is five
times too large and every moving average is computed over repeated samples.

## Contents

Generated 2026-08-19 from `--from-mf4`. 32 812 rows, 110 366 bytes,
sha256 `ce1945d56a640ecb6ffebd59451e195d332652afeeab01714dcb2d72bd961033`.

| segment | signal | samples | raster |
|---|---|---|---|
| `ACC-SYS-TC-011` | `ACC_Status` | 601 | 10 Hz |
| `ACC-SYS-TC-011` | `ACC_TimeGapSet_s` | 601 | 10 Hz |
| `ACC-SYS-TC-011` | `Trgt_Dist_m` | 3001 | 50 Hz |
| `ACC-SYS-TC-011` | `Trgt_Valid_Flg` | 3001 | 50 Hz |
| `ACC-SYS-TC-011` | `VehSpd_Kph` | 6001 | 100 Hz |
| `ACC-SYS-TC-014` | `ACC_Status` | 401 | 10 Hz |
| `ACC-SYS-TC-014` | `BrkReq_mps2` | 4001 | 100 Hz |
| `ACC-SYS-TC-014` | `DrvBrkPedal_Pct` | 4001 | 100 Hz |
| `ACC-SYS-TC-014` | `VehAccel_mps2` | 4001 | 100 Hz |
| `ACC-SYS-TC-016` | `ACC_SetSpd_Kph` | 601 | 10 Hz |
| `ACC-SYS-TC-016` | `ACC_Status` | 601 | 10 Hz |
| `ACC-SYS-TC-016` | `VehSpd_Kph` | 6001 | 100 Hz |

The mixed rasters are why `criteria.Frame.build` forward-fills: a 10 Hz `ACC_Status`
pivoted onto the 100 Hz union index is NULL in nine rows out of ten, and a state mask
computed over that collapses into single-sample runs that no `min_duration_s` survives.
