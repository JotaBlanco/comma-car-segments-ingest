"""Identifier schemes and minting (spec 0.5).

Human-readable ids live in normal indexed fields, never in Mongo ``_id``
(decision D3): ``crud.py`` used to coerce every by-id path parameter through
``ObjectId()``, which breaks the moment an id looks like ``ACC-SYS-PRF-020``.
"""

import re
from datetime import datetime, timezone

REQ_ID_RE = re.compile(r"^ACC-SYS-(FUN|PRF|SAF)-[0-9]{3}$")
TC_ID_RE = re.compile(r"^ACC-SYS-TC-[0-9]{3}$")
MNEMONIC_RE = re.compile(r"^TC-(FUN|PRF|SAF)-[0-9]{3}-[0-9]{2}$")
VERSION_RE = re.compile(r"^v[0-9]{4}$")
BASELINE_ID_RE = re.compile(r"^BL-[0-9]{4}$")
DEVICE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,31}$")
TRACE_KEY_RE = re.compile(r"^TRC-[a-z0-9._-]{3,32}-[0-9a-f]{12}$")
TEST_RUN_ID_RE = re.compile(r"^TR-[0-9]{8}-[0-9]{3}$")
REPORT_REVISION_RE = re.compile(r"^rev[0-9]{2}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
CONFIG_ID_RE = re.compile(r"^CFG-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
CRITERION_ID_RE = re.compile(r"^C[0-9]{1,2}$")

# id prefix -> chapter, enforced as a cross-field rule at the door (spec 10.4).
CHAPTER_BY_PREFIX = {
    "FUN": "Functional-HMI",
    "PRF": "Performance",
    "SAF": "Safety-Fault-Handling",
}


def req_prefix(req_id: str) -> str | None:
    match = REQ_ID_RE.match(req_id)
    return match.group(1) if match else None


def next_version(existing: list[str]) -> str:
    """Monotonic ``v0001`` .. ``v9999`` per artifact set."""
    numbers = [int(v[1:]) for v in existing if VERSION_RE.match(v)]
    nxt = (max(numbers) + 1) if numbers else 1
    if nxt > 9999:
        raise ValueError("artifact-set version space exhausted (v9999)")
    return f"v{nxt:04d}"


def next_baseline_id(existing: list[str]) -> str:
    numbers = [int(b[3:]) for b in existing if BASELINE_ID_RE.match(b)]
    nxt = (max(numbers) + 1) if numbers else 1
    if nxt > 9999:
        raise ValueError("baseline id space exhausted (BL-9999)")
    return f"BL-{nxt:04d}"


def next_test_run_id(existing_today: list[str], day: str | None = None) -> str:
    """``TR-<YYYYMMDD>-<NNN>``, a daily sequence."""
    day = day or datetime.now(timezone.utc).strftime("%Y%m%d")
    prefix = f"TR-{day}-"
    numbers = [
        int(run_id[len(prefix) :])
        for run_id in existing_today
        if run_id.startswith(prefix) and run_id[len(prefix) :].isdigit()
    ]
    nxt = (max(numbers) + 1) if numbers else 1
    if nxt > 999:
        raise ValueError(f"test-run id space exhausted for {day}")
    return f"{prefix}{nxt:03d}"


def next_report_revision(existing: list[str]) -> str:
    numbers = [int(rev[3:]) for rev in existing if REPORT_REVISION_RE.match(rev)]
    nxt = (max(numbers) + 1) if numbers else 1
    if nxt > 99:
        raise ValueError("report revision space exhausted (rev99)")
    return f"rev{nxt:02d}"


def mint_trace_key(device_id: str, content_sha256: str) -> str:
    """Content-addressed trace key (spec 4.3).

    ``device_id`` is part of the key so the same bytes attributed to two
    devices are two traces; 12 hex of the content hash makes re-upload of
    identical bytes idempotent.
    """
    if not DEVICE_ID_RE.match(device_id):
        raise ValueError(
            f"device_id {device_id!r} must match {DEVICE_ID_RE.pattern} to stay path-safe"
        )
    if not SHA256_RE.match(content_sha256):
        raise ValueError("content_sha256 must be 64 lowercase hex characters")
    return f"TRC-{device_id}-{content_sha256[:12]}"


def utc_now_iso() -> str:
    """ISO-8601 UTC with a trailing ``Z``, the form every schema expects."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
