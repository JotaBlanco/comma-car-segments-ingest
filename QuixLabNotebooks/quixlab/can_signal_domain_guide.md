## What this data actually is

This is a raw **CAN bus trace** captured from a **Ford F-150 Lightning (Mk1)** electric truck, recorded via a comma.ai comma device (the `commaCarSegments` dataset format — hence `route`, `segment`, `device` columns). A CAN bus is the truck's internal nervous system: dozens of Electronic Control Units (ECUs) broadcast small binary messages ("frames") continuously, and every module on the bus listens for the ones it cares about. There is no central database — this trace is literally a wiretap on that traffic.

## The hierarchy, and why it exists

```
Platform (vehicle model)
 └─ Bus / channel (physical wire harness segment)
     └─ ECU / sender_node (the control unit broadcasting)
         └─ Frame (a specific message ID, sent at a fixed rate)
             └─ Signal (one physical quantity packed into that frame)
```

- **Bus (`channel_name`)**: e.g. `powertrain_hs_can1`, `camera_ipma_hs_can3`, `radar_object_hs_can2`. Ford splits its network into multiple physical buses by function/bandwidth — powertrain-critical traffic doesn't share a wire with camera/radar data. A gateway module (`GWM`) bridges buses so signals like vehicle speed can cross from the powertrain bus onto others.
- **ECU (`sender_node`)**: the physical module that owns and transmits a frame — e.g. `ABS_ESC` (anti-lock brake/stability control), `PCM_HEV` (powertrain control, hybrid/EV variant), `IPMA_ADAS` (camera-based driver assist), `ECM_Diesel` (engine control — legacy naming inherited from the ICE F-150 platform, even though this is a Lightning; ECUs are often shared/rebadged across the physical and EV F-150 lines).
- **Frame (`frame_name`, `frame_id`)**: one CAN message ID, e.g. `Accel_Data_FD1`, `DesiredTorqBrk`. Each frame is broadcast on a fixed schedule (every 10-100ms typically) regardless of whether the underlying value changed — this is why `n_frame_occurrences` and `n_rows` scale together per frame.
- **Signal**: one physical value bit-packed inside a frame's payload — e.g. `VehLong2_A_Actl` (longitudinal acceleration) lives inside the `Accel_Data_FD1` frame sent by `GWM`. A single frame typically carries 5-30 related signals sharing one transmission slot for bandwidth efficiency.

**Why this matters for analysis:** grouping by `sender_node` tells you *which subsystem* produced a value; grouping by `frame_name` tells you *which signals are physically co-transmitted* (and therefore time-aligned/synchronous with each other, since they arrive in the same packet); the `channel_name` tells you the bus's latency/priority class.

## How to read Ford signal names

Ford (and most OEM) CAN signal names follow a rough grammar: `<Subject><Qualifier>_<Type>_<Verb/Suffix>`.

| Fragment | Meaning | Example |
|---|---|---|
| `Veh` | Vehicle-level (whole-vehicle dynamics, not a single wheel) | `VehLong2_A_Actl` |
| `Whl{Fl,Fr,Rl,Rr}` | Individual wheel (Front-Left, Front-Right, Rear-Left, Rear-Right) | `WhlFl_W_Meas` |
| `_A_` | Acceleration | `VehLat2_A_Actl` |
| `_W_` | Angular rate / wheel speed | `WhlFl_W_Meas` |
| `_U_` | Voltage (electrical) | `BattTrac_U_Actl` |
| `_D_` | Discrete/enumerated state | `PtIgnSwtch_D_Stat` |
| `_Actl` | Actual/measured value (as opposed to a target/estimate) | |
| `_Meas` | Directly measured (sensor reading) | |
| `_Est` | Estimated (derived/model-based, not directly sensed) | |
| `_Stat` | Status / state enum | |
| `_Cmd` / `_Req` | Command or request (an ECU asking another to do something) | |
| `_No_Cnt` | Rolling message counter (increments every transmission — used to detect dropped frames) | |
| `_No_Cs` | Checksum (integrity check, not a physical quantity — safe to ignore for analysis) | |
| `_Qf` | Quality Flag (signals validity/confidence of the accompanying value, e.g. `0`=invalid...`3`=valid) | |

**Practical implication:** roughly a third of "signals" in this trace are counters, checksums, or quality flags, not physical measurements. `signal_taxonomy`'s `signal_role` column filters these out from the physical-quantity signals so you don't accidentally chart a checksum as if it were sensor data.

## Why traffic volume differs so much by domain

Safety-critical, high-bandwidth-need domains transmit fastest: wheel speed/ABS and vehicle dynamics frames typically broadcast every 10-20ms because stability control and traction control need near-real-time input. ADAS/camera frames (`IPMA_ADAS`) run slower (~20-50ms) since object tracking tolerates more latency than brake control. Body/comfort signals (locks, HVAC) may update only on state change or every few hundred ms — nobody needs door-lock status at 100Hz. `bus_traffic_by_domain` makes this hierarchy of urgency visible directly from message-rate data, without needing the manufacturer's DBC file.

## Caveats on the domain/role classification

The `domain` and `signal_role` labels in `signal_taxonomy` are **heuristic**, derived from regex pattern-matching on signal/frame names — Ford does not publish a decoded DBC for this trace, so there's no ground-truth mapping. Treat "Other/Unclassified" and ambiguous cases (e.g. a signal that's arguably both Powertrain and Battery) as approximate. If precision matters for a specific signal, cross-check it against comma.ai's [opendbc](https://github.com/commaai/opendbc) project, which has partially reverse-engineered Ford CAN definitions.