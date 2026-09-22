"""Generate the four battery MF4 traces and the expected-verdict manifest.

    python generate.py --scenario all
    python generate.py --scenario T1 --out out/

Run it from ``battery-trace-gen/``; the DBC is read from ``dcm-seed-dbc/dbc/`` and the
requirement and parameter sets from ``data/``.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from typing import Any

import manifest
import runner
import scenario as scenarios
from bus import dbc as battery_dbc
from bus import mf4

OUT_DIR = Path(__file__).resolve().parent / "out"

#: The polarity patch is only correct while these are zero — see PLANT_ORIGIN.
PINNED_ZERO = ("R0", "KT1")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario",
        default="all",
        help="trace id (T1..T4) or 'all'",
    )
    parser.add_argument("--out", type=Path, default=OUT_DIR, help="output directory")
    return parser.parse_args()


def _refuse_non_zero(scenario: scenarios.Scenario) -> None:
    for name in PINNED_ZERO:
        if scenario.plant_params[name] != 0.0:
            raise SystemExit(
                f"{scenario.trace_id}: {name} = {scenario.plant_params[name]}, but the "
                f"plant's current-sign patch is only correct while {name} is 0.0. "
                f"See battery-trace-gen/PLANT_ORIGIN."
            )


def _print_summary(document: dict[str, Any]) -> None:
    counts = document["dbc"]["counts"]
    print(
        f"\n{document['dbc']['path']}  "
        f"{counts['frames']} frames / {counts['signals']} signals / "
        f"{counts['nodes']} nodes  sha256 {document['dbc']['sha256'][:12]}"
    )
    print(f"{'trace':<5} {'tc':<14} {'requirement':<16} {'exp':<5} measured")
    for trace in document["traces"]:
        for row in trace["expectations"]:
            measured = "; ".join(
                f"{key}={value:g}" for key, value in row["measured"].items()
            )
            print(
                f"{trace['trace_id']:<5} {row['tc_id']:<14} {row['req_id']:<16} "
                f"{row['expected']:<5} {measured}"
            )
    for trace in document["traces"]:
        print(
            f"{trace['trace_id']}: {trace['file']}  {trace['frame_count']} frames  "
            f"{trace['size_bytes'] / 1e6:.1f} MB  sha256 {trace['sha256'][:12]}"
        )


def main() -> None:
    args = _parse_args()
    identity = scenarios.load_identity()
    dbc = battery_dbc.load()

    selected = [
        scenario
        for scenario in scenarios.load_all()
        if args.scenario == "all" or scenario.trace_id == args.scenario
    ]
    for scenario in selected:
        _refuse_non_zero(scenario)

    args.out.mkdir(parents=True, exist_ok=True)
    runs: list[runner.TraceRun] = []
    stats: dict[str, dict[str, Any]] = {}
    for scenario in selected:
        print(f"{scenario.trace_id}: {scenario.title}")
        run = runner.run(scenario, identity, dbc)
        path = args.out / scenario.output_name
        info = mf4.write(
            path,
            run.log,
            dbc=dbc,
            platform=identity.platform,
            device=identity.device,
            route=scenario.route,
            segment="0",
            bus_channels=f"{identity.bus_channel}={identity.bus_name}",
            start_time_utc=scenario.start_time_utc,
            scenario_id=scenario.trace_id,
            cell_seed=identity.cell_seed,
            # The shared chain (work order, rig, cell, operator, bench) plus
            # what this trace claims for itself (run key, definitions).
            test={**identity.test, **scenario.test},
        )
        stats[scenario.trace_id] = {
            "frame_count": info["frames"],
            "size_bytes": info["size_bytes"],
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        runs.append(run)

    document = manifest.build(runs, identity=identity, dbc=dbc, stats=stats)
    json_path, csv_path = manifest.write(document, args.out)
    _print_summary(document)
    print(f"\n{json_path}\n{csv_path}")


if __name__ == "__main__":
    main()
