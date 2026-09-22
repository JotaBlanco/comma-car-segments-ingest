"""Seed the Test Manager. Run from `battery-trace-gen/`.

    python -m seed render            # write out/seed/ and out/impl/, post nothing
    python -m seed catalog           # POST the work order + 10 definitions, no links
    python -m seed impl              # POST the 10 implementations
    python -m seed links             # POST the same catalog + the 10 links
    python -m seed all               # catalog, impl, links, in that order

The order of operations is the spec's, and the traces sit between `impl` and
`links`: upload the four MF4s through MF4 Import after `impl`, so the header
claims resolve against a mirror that already holds the definitions, then run
`links` to have planning confirm them. `links` is idempotent — a re-post of the
same links answers `links_unchanged`.

`render` posts nothing and needs no credential, so the payload and the modules
can be read before anything reaches the environment.

Two variables are required for every posting command: `TM_API_URL` (the
registry's public base) and `TM_API_TOKEN` (the same static bearer every other
`/api/v1` client presents).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from seed import implementations, planning_payload, push, sources

OUT_DIR = Path(__file__).resolve().parents[1] / "out" / "seed"


def _render() -> None:
    """Write the push bodies and the ten modules, and post nothing."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, body in (
        ("planning-catalog.json", planning_payload.catalog_body()),
        ("planning-full.json", planning_payload.full_body()),
    ):
        path = OUT_DIR / name
        path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
        print(f"{path}  {len(body['test_definitions'])} definitions  {len(body['links'])} links")
    for tc_id, path in implementations.write_all().items():
        print(f"{tc_id}  {path}")


def _catalog() -> None:
    report = push.planning_sync(planning_payload.catalog_body())
    print(json.dumps(report, indent=2))


def _impl() -> None:
    for tc_id, answer in implementations.upload_all().items():
        print(f"{tc_id}  {answer['sha256']}  {answer['size_bytes']} bytes  {answer['blob_path']}")


def _links() -> None:
    report = push.planning_sync(planning_payload.full_body())
    print(json.dumps(report, indent=2))


def _all() -> None:
    _catalog()
    _impl()
    _links()


COMMANDS = {
    "render": _render,
    "catalog": _catalog,
    "impl": _impl,
    "links": _links,
    "all": _all,
}


def _sanity() -> None:
    """The table the seed echoes: which run answers which definition, and how."""
    verdicts = sources.verdicts()
    runs = sources.run_of_definition()
    print(f"{'definition':<16} {'run':<10} {'expected':<9} requirement")
    for tc_id in sorted(verdicts):
        row = verdicts[tc_id]
        print(f"{tc_id:<16} {runs[tc_id]:<10} {row['expected']:<9} {row['req_id']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=sorted(COMMANDS))
    arguments = parser.parse_args()
    try:
        COMMANDS[arguments.command]()
    except (push.NotConfigured, sources.MissingInput) as error:
        raise SystemExit(str(error)) from error
    _sanity()


if __name__ == "__main__":
    sys.exit(main())
