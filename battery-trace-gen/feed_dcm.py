"""Post BATTERY_DC_V1 and the battery test-spec set to DCM.

    CONFIG_API_URL=http://config-api-svc python feed_dcm.py

The DBC half is what the ``dcm-seed-dbc`` Job already does, in the same serialisation
(``dbc_json.to_json``) and under the same ``(type, target_key)`` pair, so running this
from a workstation and running the Job in the environment produce the same document.
Use the Job where one is deployed:

    DCM_TYPE=dbc DBC_NAMES=BATTERY_DC_V1 PLATFORM=BATTERY_DC_V1 REPLACE=true

The test-spec half has no Job. It follows the type-suffix convention of
``dev-planning/dcm-requirements-source/spec.md`` section 4.4; the ``-test-specs`` ingest
handler does not exist on this branch, so the document is stored and read back but not
yet turned into a register.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests

from bus import dbc as battery_dbc

REPO_ROOT = Path(__file__).resolve().parents[1]
SPECS_PATH = Path(__file__).resolve().parent / "specs" / "battery-dc-test-specs.json"

TEST_SPECS_TYPE = "battery-test-specs"
TEST_SPECS_TARGET_KEY = "battery-dc"
VMODEL_CATEGORY = "vmodel"

sys.path.insert(0, str(REPO_ROOT / "dcm-seed-dbc"))
from dbc_json import to_json  # noqa: E402


def post(
    session: requests.Session,
    base_url: str,
    metadata: dict[str, str],
    content: object,
) -> str:
    response = session.post(
        f"{base_url}/api/v1/configurations",
        json={"metadata": metadata, "content": content, "replace": True},
        timeout=120,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"DCM rejected {metadata['type']}/{metadata['target_key']}: "
            f"{response.status_code} {response.text[:500]}"
        )
    return str((response.json() or {}).get("data", {}).get("id", ""))


def main() -> None:
    base_url = os.environ["CONFIG_API_URL"].rstrip("/")
    dbc = battery_dbc.load()

    document = to_json(
        dbc.database,
        platform=battery_dbc.DBC_NAME,
        source={
            "dbc_name": battery_dbc.DBC_NAME,
            "dbc_sha256": dbc.sha256,
            "origin": "hand-authored (comma-car-segments-ingest)",
            "seeded_by": "battery-trace-gen/feed_dcm.py",
        },
    )

    with requests.Session() as session:
        dbc_id = post(
            session,
            base_url,
            {"type": battery_dbc.DCM_TYPE, "target_key": battery_dbc.DCM_TARGET_KEY},
            document,
        )
        print(
            f"dbc: {document['counts']} sha256 {dbc.sha256[:12]} "
            f"config_id {dbc.config_id} id {dbc_id}"
        )

        specs = json.loads(SPECS_PATH.read_text(encoding="utf-8"))
        specs_id = post(
            session,
            base_url,
            {
                "type": TEST_SPECS_TYPE,
                "target_key": TEST_SPECS_TARGET_KEY,
                "category": VMODEL_CATEGORY,
            },
            specs,
        )
        print(
            f"test-specs: {specs['item_count']} items "
            f"sha256 {specs['set_canonical_sha256'][:12]} id {specs_id}"
        )


if __name__ == "__main__":
    main()
