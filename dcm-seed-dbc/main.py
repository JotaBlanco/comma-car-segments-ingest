"""Seed the Dynamic Configuration Manager with the CAN databases, as JSON.

Runs as a Job: it seeds once and exits. DCM holds configuration too large for a
Kafka message - the config-updates topic carries only an event and consumers
fetch the content separately through QuixConfigurationService.

WHY A JOB AND NOT A MANUAL UPLOAD
DCM's content store is a deployment decision, and the default (`mongo`) keeps the
content inside the Mongo document. The config-updates topic outlives that store
and the SDK rebuilds versions from topic events with no liveness check, so a
wiped store leaves consumers resolving versions whose content is gone. Recovery
has to be reproducible, which means the seed lives in git rather than in
somebody's browser history.

WHY JSON AND NOT THE .dbc BLOB
Stored as a structured document the database is inspectable in the Configurations
UI, addressable with JSONPath, and readable through `json_field` without a
decoder round-trip. `dbc_json` (taken unchanged from mf4-replay on main, so both
sides serialise identically) writes everything cantools needs, and `from_json`
rebuilds a real cantools Database - bit extraction stays in cantools rather than
being reimplemented.

IDEMPOTENT
`POST /api/v1/configurations` with `replace: true` creates the configuration or
adds a version to it, so re-running is safe. The config id DCM assigns is
`sha1(f"{type}-{target_key}")`, which is the same id rlog-to-mf4 stamps into the
MF4 header on main as `dcm.config_id` - that is what lets a decoder resolve the
database for a file it has never seen.

READ-ONLY ELSEWHERE: this writes to DCM and nothing else. No topic is consumed
or produced, which is why the app declares no InputTopic.
"""

from __future__ import annotations

import hashlib
import logging
import os
import sys

import requests

from dbc_json import load_dbc_file, to_json

logging.basicConfig(
    level=os.getenv("LOGLEVEL", "INFO"),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("dcm-seed-dbc")

HERE = os.path.dirname(os.path.abspath(__file__))
DBC_DIR = os.path.join(HERE, "dbc")

# Cluster-internal service name of the DCM deployment. Not public: the API is
# only reachable from inside the environment, which is the reason this runs as a
# deployment rather than from a workstation.
CONFIG_API_URL = os.environ["CONFIG_API_URL"].rstrip("/")
DCM_TYPE = os.environ["DCM_TYPE"]
DBC_NAMES = [n.strip() for n in os.environ["DBC_NAMES"].split(",") if n.strip()]
PLATFORM = os.environ["PLATFORM"]
REPLACE = os.getenv("REPLACE", "true").strip().lower() in ("1", "true", "yes")
TIMEOUT_S = int(os.getenv("REQUEST_TIMEOUT_S", "120"))


def config_id_for(dcm_type: str, target_key: str) -> str:
    """The id DCM derives for a (type, target_key) pair.

    Logged so it can be matched against the `dcm.config_id` property that
    rlog-to-mf4 writes into an MF4 header.
    """
    return hashlib.sha1(f"{dcm_type}-{target_key}".encode()).hexdigest()


def seed_one(session: requests.Session, name: str) -> dict:
    """Serialise one .dbc and POST it as a DCM configuration document."""
    path = os.path.join(DBC_DIR, f"{name}.dbc")
    if not os.path.exists(path):
        raise FileNotFoundError(f"{path} is not bundled in this app")

    with open(path, "rb") as fh:
        dbc_sha256 = hashlib.sha256(fh.read()).hexdigest()

    db = load_dbc_file(path)
    doc = to_json(
        db,
        platform=PLATFORM,
        source={
            "dbc_name": name,
            "dbc_sha256": dbc_sha256,
            "origin": "opendbc (MIT)",
            "seeded_by": "dcm-seed-dbc",
        },
    )

    frames = len(db.messages)
    signals = sum(len(m.signals) for m in db.messages)
    logger.info(
        "%s: %d frames, %d signals, dbc sha256 %s",
        name,
        frames,
        signals,
        dbc_sha256[:12],
    )

    response = session.post(
        f"{CONFIG_API_URL}/api/v1/configurations",
        json={
            "metadata": {"type": DCM_TYPE, "target_key": name},
            "content": doc,
            "replace": REPLACE,
        },
        timeout=TIMEOUT_S,
    )
    # The body carries why it was rejected; a bare status code does not.
    if response.status_code >= 400:
        raise RuntimeError(
            f"DCM rejected {name}: {response.status_code} {response.text[:500]}"
        )

    data = (response.json() or {}).get("data") or {}
    logger.info(
        "seeded %s as type=%s target_key=%s -> id %s (expected %s) version %s",
        name,
        DCM_TYPE,
        name,
        data.get("id"),
        config_id_for(DCM_TYPE, name),
        data.get("version"),
    )
    return {"name": name, "frames": frames, "signals": signals, "id": data.get("id")}


def main() -> int:
    logger.info(
        "seeding %d database(s) into %s as type=%s platform=%s replace=%s",
        len(DBC_NAMES),
        CONFIG_API_URL,
        DCM_TYPE,
        PLATFORM,
        REPLACE,
    )

    session = requests.Session()
    seeded, failed = [], []
    for name in DBC_NAMES:
        try:
            seeded.append(seed_one(session, name))
        except Exception:
            # Keep going: one unparseable database should not block the others,
            # and the Job's exit code still reports that something failed.
            logger.exception("failed to seed %s", name)
            failed.append(name)

    print("\n=== DCM seed summary ===")
    for row in seeded:
        print(
            f"  {row['name']:28s} {row['frames']:4d} frames "
            f"{row['signals']:5d} signals  id={row['id']}"
        )
    for name in failed:
        print(f"  {name:28s} FAILED")
    print(f"  {len(seeded)} seeded, {len(failed)} failed")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
