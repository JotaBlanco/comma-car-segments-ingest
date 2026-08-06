## `can_signals` — Exploratory Notes

**Coverage:** the table currently contains **one captured segment**:
- Platform: `FORD_F_150_LIGHTNING_MK1`
- Device: `0b2c0bec9a28eb0f`
- Route: `00000001--82c7a5f419`
- Segment `105`, ~5 seconds of data (`t_rel` 0 → 4.99s, 500 sequence steps)
- 382,638 rows / 2.81 MB across 3 files

**Shape:** long/tidy — one row per (CAN frame, decoded signal, timestamp). Columns: `ts_ms`, `t_rel`, `seq`, `frame_id`/`frame_hex`/`frame_name`, `sender_node`, `channel_name`, `signal`, `value` (all numeric, already decoded from the vehicle's DBC file — `dbc_sha256` identifies which DBC version was used).

**Breadth:**
- 3 physical CAN channels: `powertrain_hs_can1`, `radar_object_hs_can2`, `camera_ipma_hs_can3`
- 12 sender ECUs, incl. `ABS_ESC`, `GWM` (gateway module), `PCM_HEV`, `PSCM` (steering), `IPMA_ADAS`, `CMR_DSMC`, `ECM_Diesel`
- 204 distinct CAN frames, 1,822 distinct decoded signals

**Busiest traffic:** `DesiredTorqBrk` (ABS_ESC), `ParkAid_Data` / `ACCDATA` (IPMA_ADAS), `VehicleOperatingModes` (PCM_HEV), `Accel_Data_FD1` / `Battery_Traction_1_FD1` (GWM) — these frames fire most often in the 5s window.

**Notebook nodes added:**
| Node | Purpose |
|---|---|
| `can_signals_sample` | Raw sample (50k rows), ordered by `t_rel` — feeds time-series work |
| `signal_catalog` | Every signal with count/min/max/avg/stddev — "what's in here" reference |
| `frame_frequency` | Per-frame row/signal counts — bus traffic breakdown |
| `sender_summary` | Message volume per sending ECU (bar chart) |
| `key_signals_timeseries` | Wheel speed, lateral/longitudinal accel, traction battery voltage over the 5s window (line chart) |

**Things worth digging into next:**
- Sampling rate per signal/frame varies a lot (`WhlFl_W_Meas` ~1500 samples in 5s vs. `GPS_Speed` only 15) — worth profiling per-frame period.
- A separate, much larger table `can_signals_v2` exists (1,830 files vs. 3) with a different partition layout (partitioned by `sender_node`/`frame_name`/`signal` rather than device/route) — likely worth comparing coverage if this single-segment capture isn't enough for the analysis.
- No obvious anomalies from spot checks (battery voltage ~341V steady, wheel speeds ~13-14 rad/s, consistent with a short low-speed test drive).