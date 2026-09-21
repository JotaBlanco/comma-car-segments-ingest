"""Regenerate ``acc_signals.csv.gz`` - the signal fallback the Test Report renders from.

Two sources, both real, neither hand-authored:

``--from-mf4 <acc_project>``
    Read the three measurements out of ``acc_project/Data/**`` with asammdf. These are the
    same MF4 files the MF4 Import -> Decoder -> DataLake Sink pipeline ingested into
    ``mf4_signals_v4``, so the samples this writes are the samples the lake holds. Needs
    ``asammdf`` and ``numpy`` on the interpreter that runs it (the backend image carries
    neither; this is a workstation tool, exactly like
    ``api/vmodel_fixtures/tools/build_vmodel_fixtures.py``).

``--from-lake``
    Read them back out of the lakehouse Query API instead, using
    ``Quix__Lakehouse__Query__Url`` and ``Quix__Sdk__Token`` from the environment. Run this
    from inside a Quix deployment - the Query API is not reachable from a workstation - to
    replace the file with bytes that came out of the lake itself.

Both modes write the identical schema, so the fixture is interchangeable with a lake read:

    segment,signal,ts_ms,value

``segment`` is the ``tc_id`` (a plain column in the lake); ``platform`` / ``device`` /
``route`` are constant per segment and are held in ``api/vm_eval/catalog.py`` rather than
repeated on 32 000 rows.

Usage::

    python backend/api/vm_eval/fixtures/build_acc_signals.py --from-mf4 C:/repos/acc_project
    python backend/api/vm_eval/fixtures/build_acc_signals.py --from-lake
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "acc_signals.csv.gz"

# Repository root on sys.path so the catalog can be imported for the signal lists and the
# lake partitions - the fixture must never drift from what the evaluator asks for.
BACKEND_ROOT = HERE.parents[2]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from api.vm_eval.catalog import EVALUATORS  # noqa: E402
from api.vm_eval.signals import LAKE_TABLE, build_query  # noqa: E402

#: Which MF4 file under ``acc_project/Data`` carries each test case's measurement. The
#: scenario/variant pair is the one named in each spec's ``recommended_scenario``.
MF4_SOURCES = {
    "ACC-SYS-TC-011": "follow_steady_timegap/follow_steady_timegap__tau08__80c3cb927293.mf4",
    "ACC-SYS-TC-014": "lead_brake_ccrb_4mps2/lead_brake_ccrb_4mps2__v130__d3c693ca7316.mf4",
    "ACC-SYS-TC-016": "cruise_set_speed_max/cruise_set_speed_max__base__122c536c8f4d.mf4",
}


def number(value: float) -> str:
    """Six decimals, trailing zeros trimmed.

    Six is not arbitrary: the tightest figure the report prints is a 2 s moving average
    read to four decimals, and a per-sample rounding error of 5e-7 moves that average by at
    most 5e-7. Full float32 repr would triple the file for digits nothing reads.
    """
    text = f"{value:.6f}".rstrip("0").rstrip(".")
    return text or "0"


def rows_from_mf4(acc_project: Path) -> list[tuple[str, str, int, float]]:
    from asammdf import MDF  # imported lazily: a build-time dependency, not a runtime one

    collected: list[tuple[str, str, int, float]] = []
    for tc_id, evaluator in sorted(EVALUATORS.items()):
        path = acc_project / "Data" / MF4_SOURCES[tc_id]
        if not path.exists():
            raise SystemExit(f"measurement not found: {path}")
        mdf = MDF(path)
        for name in sorted(evaluator.signals):
            signal = mdf.get(name)
            for moment, value in zip(signal.timestamps, signal.samples, strict=True):
                collected.append((evaluator.partition.segment, name, round(float(moment) * 1000.0), float(value)))
        print(f"  {tc_id}: {path.name}")
    return collected


def rows_from_lake() -> list[tuple[str, str, int, float]]:
    import httpx  # imported lazily so --from-mf4 works without it

    base = (os.getenv("Quix__Lakehouse__Query__Url") or "").rstrip("/")
    token = os.getenv("Quix__Sdk__Token") or ""
    if not base:
        raise SystemExit("Quix__Lakehouse__Query__Url is not set; run this inside a deployment")

    collected: list[tuple[str, str, int, float]] = []
    for tc_id, evaluator in sorted(EVALUATORS.items()):
        sql = build_query(evaluator.partition, evaluator.signals)
        with httpx.Client(timeout=120.0) as client:
            response = client.post(
                f"{base}/query",
                content=sql.encode("utf-8"),
                headers={
                    "Content-Type": "text/plain",
                    "Accept": "text/csv",
                    "Authorization": f"Bearer {token}",
                },
            )
        response.raise_for_status()
        seen: set[tuple[str, int]] = set()
        for record in csv.DictReader(response.text.splitlines()):
            raw_value = (record.get("value") or "").strip()
            if not raw_value:
                continue
            key = (str(record["signal"]), int(float(record["ts_ms"])))
            # Every sample is in the lake five times over, under distinct upload_ids.
            if key in seen:
                continue
            seen.add(key)
            collected.append((evaluator.partition.segment, key[0], key[1], float(raw_value)))
        print(f"  {tc_id}: {len(seen)} deduplicated rows from {LAKE_TABLE}")
    return collected


def write(rows: list[tuple[str, str, int, float]]) -> None:
    rows.sort(key=lambda item: (item[0], item[1], item[2]))
    with gzip.open(OUTPUT, "wt", encoding="utf-8", newline="", compresslevel=9) as handle:
        writer = csv.writer(handle)
        writer.writerow(("segment", "signal", "ts_ms", "value"))
        for segment, signal, ts_ms, value in rows:
            writer.writerow((segment, signal, ts_ms, number(value)))

    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    print(f"\n{OUTPUT.name}: {len(rows)} rows, {OUTPUT.stat().st_size} bytes")
    print(f"sha256 {digest}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--from-mf4", type=Path, help="path to a checkout of acc_project")
    group.add_argument("--from-lake", action="store_true", help="read the lakehouse Query API")
    args = parser.parse_args()

    rows = rows_from_lake() if args.from_lake else rows_from_mf4(args.from_mf4)
    if not rows:
        raise SystemExit("no rows collected; refusing to write an empty fixture")
    write(rows)


if __name__ == "__main__":
    main()
