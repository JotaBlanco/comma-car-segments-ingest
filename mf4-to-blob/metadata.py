"""Build the Kafka metadata payload (spec §7.2).

Since the Test Manager integration the message carries a second block: the
`declared` bag, everything the uploader states about the file this app never
opens. It is the first rung of the run-key ladder every downstream reader
climbs (`mf4-decoder/identity.py`, `tm-connector/connector/identity.py`), and
the only identity channel that exists before a byte is written.
"""

from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

# Characters kept verbatim in the filename part of an upload id. Everything
# else collapses to "_" so the id stays safe as a blob path segment, a Kafka
# message key and an Iceberg column value.
_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]+")

# Keep the filename part bounded so the whole id stays comfortably short.
_MAX_STEM_LEN = 64

# Length of the hex digest suffix taken from the sha256.
_HASH_LEN = 12

# Every query parameter under this prefix is collected verbatim and forwarded.
DECLARED_PREFIX = "declared."

MAX_DECLARED_KEYS = 32
MAX_DECLARED_KEY_LEN = 64
MAX_DECLARED_VALUE_LEN = 256

# A Test Manager id becomes a lake partition directory (`run_id=<value>/`), a
# blob path segment and a Kafka key, so it is path-safe by construction: no
# separator, no dot-dot, no whitespace.
_TM_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")

# The declared keys this app validates rather than merely carrying. Everything
# else rides through untouched - mf4-to-blob cannot know the registry's whole
# vocabulary, and tm-connector drops what the registry does not know
# (`connector/identity.py::DECLARED_FIELDS`). These four become lake partition
# directories or a registry id, which is why their shape is checked HERE, at the
# only door a caller can reach. `platform` is both at once: the lake's top-level
# directory and the DCM target_key the decoder resolves the CAN database with.
_DECLARED_PATTERNS = {
    "run_id": _TM_ID,
    "work_order_id": _TM_ID,
    "rig_id": _TM_ID,
    "platform": _TM_ID,
}

# The claim a producer can write into the filename, so an upload needs no form
# filled in: `<field>` -> the prefix its token carries.
#
# The name is split on "_" and each token matched WHOLE, rather than searched
# with a regex. Every id here contains hyphens (`WO-2026-0851`), and so does a
# comma route (`0000000e--053ec37492`), so a pattern that treats "-" as a
# delimiter slices `WO-2026-0851` down to `WO-2026` — a work order that exists
# nowhere, claimed silently. A whole token cannot be half an id.
_FILENAME_CLAIM = {
    "work_order_id": "WO-",
}

# The fields copied onto the STORED OBJECT as `x-ms-meta-<name>`, so the car is
# legible from the blob alone. The run id is already the object's folder and the
# work order is one hop away in the Test Manager, so neither needs repeating
# here.
#
# Azure takes a metadata NAME that is a valid C# identifier and a VALUE that is
# header-safe ASCII.
OBJECT_METADATA_FIELDS = ("vehicle",)


def object_metadata(
    declared: Optional[dict[str, str]],
    stated: dict[str, str] | None = None,
) -> dict[str, str]:
    """What rides on the stored object beside its bytes.

    `stated` is what the RECORDING says about itself - the import page reads it
    out of the file's HD comment and sends it whether or not anyone typed
    anything, so an upload nobody edited still carries the car. It is not a
    claim and never enters the `declared` bag; where a claim was made, it wins.
    """
    source = {**(stated or {}), **(declared or {})}
    return {
        field: value
        for field in OBJECT_METADATA_FIELDS
        if (value := str(source.get(field) or "").strip())
    }


def make_upload_id(filename: str, minted_at: Optional[datetime] = None) -> str:
    """Mint the pipeline-wide unique key for one uploaded file.

    Format::

        <safe_stem>-<hash12>

    where

    * ``safe_stem``  the upload's filename with any directory component and
      the extension stripped, every character outside ``[A-Za-z0-9._-]``
      replaced by ``_``, truncated to 64 characters (``"upload"`` if nothing
      survives). This keeps the human-readable filename in the key so a lake
      row can be eyeballed back to its source file.
    * ``hash12``  the first 12 hex characters of
      ``sha256(f"{filename}\x00{minted_at_iso}")`` where ``minted_at_iso`` is
      the UTC mint time to microsecond resolution. This is the "hash generated
      from filename and time" that makes the key unique across re-uploads of
      an identically named file.

    Example: ``"Recording 001.mf4"`` uploaded at
    ``2026-08-19T10:22:33.123456+00:00`` yields
    ``Recording_001-7a9622106da0``.

    The value is minted once per upload (at SAS-mint time) and then stays
    fixed for that upload: it is the ``uploadId`` handed to the browser, the
    Kafka message key, the ``id`` field on the ``mf4_metadata`` message and,
    downstream, the ``upload_id`` Iceberg column.
    """
    minted_at = minted_at or datetime.now(timezone.utc)
    stem = _safe_stem(filename)
    digest = hashlib.sha256(
        f"{filename}\x00{minted_at.isoformat()}".encode("utf-8")
    ).hexdigest()[:_HASH_LEN]
    return f"{stem}-{digest}"


def _safe_stem(filename: str) -> str:
    """Filename without directories/extension, reduced to safe characters."""
    base = os.path.basename(filename or "").strip()
    stem = os.path.splitext(base)[0]
    stem = _UNSAFE_CHARS.sub("_", stem).strip("._-")
    return stem[:_MAX_STEM_LEN] or "upload"


def collect_declared(query_params) -> dict[str, str]:
    """Collect every `declared.*` query parameter into a bag, prefix stripped.

    Values are carried, not interpreted — except the ids that become a lake
    partition directory or a registry id, whose shape is checked here because
    this is the only door a caller reaches. A repeated parameter keeps the last
    value; a bare `declared.` is dropped, because it could only make an empty key.

    Raises:
        ValueError: a cap was exceeded or an id is malformed; the caller answers 400.
    """
    items = (
        query_params.multi_items()
        if hasattr(query_params, "multi_items")
        else query_params.items()
    )
    bag = {
        name[len(DECLARED_PREFIX):]: value
        for name, value in items
        if name.startswith(DECLARED_PREFIX) and len(name) > len(DECLARED_PREFIX)
    }
    if len(bag) > MAX_DECLARED_KEYS:
        raise ValueError(f"at most {MAX_DECLARED_KEYS} declared.* parameters")
    for key, value in bag.items():
        # Messages name the constraint; they never echo the caller's key or
        # value back into a response.
        if len(key) > MAX_DECLARED_KEY_LEN:
            raise ValueError(f"declared.* key longer than {MAX_DECLARED_KEY_LEN} characters")
        if len(value) > MAX_DECLARED_VALUE_LEN:
            raise ValueError(f"declared.* value longer than {MAX_DECLARED_VALUE_LEN} characters")
        pattern = _DECLARED_PATTERNS.get(key)
        if pattern and not pattern.match(value):
            raise ValueError(f"declared.{key} must match {pattern.pattern}")
    return bag


def claim_from_filename(filename: str) -> dict[str, str]:
    """The work order a producer wrote into the name.

    A generated recording can carry its own claim, so an upload needs no form
    filled in::

        HYUNDAI_IONIQ_WO-2026-0851_0000000e--053ec37492_20.mf4

    The RUN id is deliberately not read here. A filename-derived run id written
    into ``declared`` would outrank the file's own header, and the header is a
    measured property of the bytes while a name is the weakest claim there is.
    The ladder's filename rung stays where it belongs — below the header, in
    ``resolve_run_key`` — and ``TM_RUN_KEY_PATTERN`` drives it.
    """
    stem = os.path.splitext(os.path.basename(filename or ""))[0]
    tokens = stem.split("_")
    found = {}
    for field, prefix in _FILENAME_CLAIM.items():
        for token in tokens:
            if token.startswith(prefix) and len(token) > len(prefix) and _TM_ID.match(token):
                found[field] = token
                break
    return found


def build_payload(
    *,
    upload_id: str,
    filename: str,
    blob_path: str,
    size_bytes: int,
    sha256_hex: Optional[str],
    content_type: Optional[str],
    blob_url: Optional[str],
    uploader_ip: Optional[str],
    declared: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """Assemble the ``mf4_metadata`` message.

    ``upload_id`` is the unique key minted by :func:`make_upload_id` and is
    published as the ``id`` field — that field is what mf4-decoder reads and
    forwards to the lake.

    ``declared`` is nested under its own key rather than flattened, so a
    caller-supplied name can never collide with a field this app owns; it is
    always an object, ``{}`` when nothing arrived. tm-connector reads that bag
    verbatim, which is why the registry's own field names are used inside it
    (``work_order_id``, not ``work_order``).

    A claim that names a lake partition column also rides in a second, flat
    spelling — ``work_order`` and ``platform`` — because that is the LAKE's
    name for it, and the decoder copies it onto every batch. One fact, two
    spellings, both written here so the two readers cannot drift apart.

    ``platform`` has a second reader that makes the flat spelling mandatory: the
    decoder picks the CAN database with it, in an ``sdf.apply`` that runs before
    the file is downloaded (``mf4-decoder/main.py``, ``F_DCM_KEY``). That reader
    sees the top-level key only, never the ``declared`` bag, and it cannot open
    the recording to ask it instead.

    ``vehicle`` and ``rig_id`` get NO second spelling: they partition nothing,
    so the lake column keeps the bag's own name and the decoder reads them
    straight off the bag (``mf4-decoder/identity.py::CLAIMED_COLUMNS``).
    ``vehicle`` alone among them is not shape-checked — a car is named by whoever states
    it, not by a pattern.

    **A caller's claim always wins.** The filename is consulted only for a field
    the uploader left blank: a person who typed a work order on the import page
    meant it, and a name is only ever the fallback.
    """
    declared = dict(declared or {})
    for field, value in claim_from_filename(filename).items():
        declared.setdefault(field, value)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"
    return {
        "id": upload_id,
        "filename": filename,
        "blob_path": blob_path,
        "blob_url": blob_url,
        "size_bytes": int(size_bytes),
        "content_type": content_type or "application/x-mdf",
        "sha256": sha256_hex,
        "uploaded_at": now,
        "uploader_ip": uploader_ip,
        "source": "mf4-to-blob",
        "declared": declared,
        # The lake's spelling of the same claims. `run_id` is absent on purpose:
        # nothing here can resolve it, and a key holding None would read as a
        # stated null rather than as the question the decoder answers.
        "work_order": declared.get("work_order_id"),
        "platform": declared.get("platform"),
    }
