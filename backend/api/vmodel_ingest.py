"""Ingestion of canonical requirement artifact sets into MongoDB.Where the data physically lives:

* ``vm_artifact_sets`` - one document per immutable artifact version (the version registry,
  the canonical sha256, the item ids).
* ``vm_requirements``  - the queryable projection: one document per requirement per
  artifact version. This is what the Requirements page reads.
* ``vm_baselines``     - the immutable pins plus the materialised ``req_links`` reverse
  traceability index.
* Blob storage (quixportal) - the raw uploaded bytes of an artifact, written by the upload
  route only. Seeded versions point at the committed fixture path instead; see
  ``vmodel_fixtures/README.md``.

Uploaded versions are never rewritten in place. Re-ingesting an identical item set returns
the existing version instead of minting a duplicate (idempotency is keyed on the canonical
sha256 of the item set).

The seed path is the one exception, and it is deliberate: it pins a fixed
``forced_version`` and rewrites that version from the committed fixtures on every call, so
editing a fixture and restarting actually refreshes the stored documents instead of leaving
stale ones behind. See :func:`replace_items` for the write primitive both paths use.

``vm_artifact_sets`` is keyed on ``{kind}:{version}``, not on the bare version. Versions are
numbered per kind, so four kinds all publish a ``v0001`` and a bare-version key made them
overwrite each other.
"""

import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any

from pymongo.collection import Collection
from pymongo.database import Database
from pymongo.operations import ReplaceOne

from .models_vmodel import (
    CHAPTER_BY_PREFIX,
    ArtifactKind,
    Baseline,
    BaselineCounts,
    RequirementStatus,
)
from .utils import now

logger = logging.getLogger(__name__)

FIXTURES_DIR = Path(__file__).parent / "vmodel_fixtures"
REQUIREMENTS_FIXTURE = FIXTURES_DIR / "requirements" / "acc-system-requirements.json"
FIGURES_DIR = FIXTURES_DIR / "figures"


REQ_ID_PATTERN = re.compile(r"^ACC-SYS-(FUN|PRF|SAF)-[0-9]{3}$")
VERSION_PATTERN = re.compile(r"^v[0-9]{4}$")

# The 17 keys carried by every item of the canonical export. ``last_change`` is not one of
# them - the export does not emit it - so it is optional on the model and stays null.
REQUIRED_ITEM_KEYS = (
    "id",
    "title",
    "chapter",
    "text",
    "ears_pattern",
    "system_states",
    "rationale",
    "source",
    "verification_tag",
    "verification_method",
    "measurand",
    "status",
    "revision",
    "figure_refs",
    "related_reqs",
    "verified_by",
)


class IngestError(ValueError):
    """Raised when a document cannot be ingested. Routes map this to HTTP 400."""


def artifact_set_key(kind: ArtifactKind, artifact_version: str) -> str:
    """``vm_artifact_sets`` primary key: ``{kind}:{version}``.

    Version numbers are allocated per kind, so ``v0001`` is not unique on its own - every
    kind has one. Keying the registry on the bare version made each kind's document
    overwrite the previous kind's, which silently destroyed the sha256 idempotency guard.
    """
    return f"{kind.value}:{artifact_version}"


def replace_items(
    collection: Collection[dict[str, Any]],
    docs: list[dict[str, Any]],
    scope: dict[str, Any],
) -> int:
    """Make ``scope`` in ``collection`` contain exactly ``docs``, and nothing else.

    Every ``_id`` here is derived from the content being ingested (``{item_id}@{version}``),
    so a plain ``insert_many`` fails with E11000 the second time it runs. Upserting instead
    means re-running is safe *and* refreshes documents whose fixture content changed;
    pruning afterwards means an item deleted from the fixture actually disappears rather
    than lingering at a version it is no longer part of.

    ``scope`` bounds the prune - ``{"artifact_version": v}`` for versioned collections,
    ``{}`` for the ones the seed owns outright. Returns the number of documents written.
    """
    if docs:
        collection.bulk_write(
            [ReplaceOne({"_id": doc["_id"]}, doc, upsert=True) for doc in docs],
            ordered=False,
        )
    collection.delete_many({**scope, "_id": {"$nin": [doc["_id"] for doc in docs]}})
    return len(docs)


def canonical_bytes(payload: Any) -> bytes:
    """Serialise ``payload`` deterministically: sorted keys, no insignificant whitespace.

    This is a stable canonicalisation, not a certified RFC 8785 (JCS) implementation. The
    document's own ``set_canonical_sha256`` is stored alongside as
    ``declared_canonical_sha256`` so the acc_project value stays visible and comparable.
    """
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def canonical_sha256(payload: Any) -> str:
    """sha256 hex digest of the canonical serialisation of ``payload``."""
    return hashlib.sha256(canonical_bytes(payload)).hexdigest()


def figure_catalogue() -> dict[str, dict[str, str]]:
    """Map figure id -> {filename, title}, derived from the committed figure filenames."""
    catalogue: dict[str, dict[str, str]] = {}
    if not FIGURES_DIR.exists():
        return catalogue

    for path in sorted(FIGURES_DIR.glob("*.svg")):
        figure_id, _, slug = path.stem.partition("-")
        title = slug.replace("-", " ").capitalize() if slug else figure_id
        catalogue[figure_id] = {"filename": path.name, "title": title}
    return catalogue


def figure_path(figure_id: str) -> Path | None:
    """Filesystem path of a figure fixture, or None when the id is unknown."""
    entry = figure_catalogue().get(figure_id)
    if entry is None:
        return None
    return FIGURES_DIR / entry["filename"]


def _validate_item(item: dict[str, Any], seen_ids: set[str]) -> None:
    """Validate one raw requirement item. Mirrors acc_project tools/accreqs/validate.py."""
    missing = [key for key in REQUIRED_ITEM_KEYS if key not in item]
    if missing:
        raise IngestError(f"Requirement item is missing keys: {', '.join(missing)}")

    req_id = str(item["id"])
    if not REQ_ID_PATTERN.match(req_id):
        raise IngestError(f"Requirement id '{req_id}' does not match ACC-SYS-(FUN|PRF|SAF)-nnn")

    if req_id in seen_ids:
        raise IngestError(f"Requirement id '{req_id}' appears more than once in the set")

    prefix = req_id.split("-")[2]
    expected_chapter = CHAPTER_BY_PREFIX[prefix]
    if item["chapter"] != expected_chapter:
        raise IngestError(
            f"{req_id}: chapter '{item['chapter']}' disagrees with the id prefix "
            f"'{prefix}' (expected '{expected_chapter}')"
        )

    try:
        RequirementStatus(item["status"])
    except ValueError as exc:
        allowed = ", ".join(status.value for status in RequirementStatus)
        raise IngestError(f"{req_id}: status '{item['status']}' is not one of {allowed}") from exc

    if req_id in (item.get("related_reqs") or []):
        raise IngestError(f"{req_id}: related_reqs must not contain the requirement's own id")


def _requirement_doc(item: dict[str, Any], artifact_version: str) -> dict[str, Any]:
    """Build the Mongo document for one requirement at one artifact version."""
    req_id = str(item["id"])
    return {
        "_id": f"{req_id}@{artifact_version}",
        "req_id": req_id,
        "artifact_version": artifact_version,
        "chapter": item["chapter"],
        "title": item["title"],
        "text": item["text"],
        "ears_pattern": item["ears_pattern"],
        "system_states": list(item.get("system_states") or []),
        "rationale": item["rationale"],
        "source": list(item.get("source") or []),
        "verification_tag": item["verification_tag"],
        "verification_method": item["verification_method"],
        "measurand": [dict(entry) for entry in item.get("measurand") or []],
        "status": item["status"],
        "revision": item["revision"],
        "figure_refs": list(item.get("figure_refs") or []),
        "related_reqs": list(item.get("related_reqs") or []),
        "verified_by": list(item.get("verified_by") or []),
        "last_change": item.get("last_change"),
        "schema_version": item.get("schema_version", "1.0.0"),
        "canonical_sha256": canonical_sha256(item),
    }


def parse_requirements_document(payload: Any) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Split a canonical requirements document into (items, document metadata).

    Accepts either the full artifact-set document (``{"set": "requirements", "items": [...]}``)
    or a bare list of items.
    """
    if isinstance(payload, list):
        items = payload
        meta: dict[str, Any] = {}
    elif isinstance(payload, dict):
        raw_items = payload.get("items")
        if not isinstance(raw_items, list):
            raise IngestError("Document has no 'items' array")
        declared_set = payload.get("set")
        if declared_set not in (None, "requirements"):
            raise IngestError(f"Document declares set '{declared_set}', expected 'requirements'")
        items = raw_items
        meta = {
            "declared_canonical_sha256": payload.get("set_canonical_sha256"),
            "source_version": payload.get("version"),
            "document_revision": payload.get("document_revision"),
            "created_by": payload.get("created_by"),
        }
    else:
        raise IngestError("Document must be a JSON object or a JSON array of requirements")

    if not items:
        raise IngestError("Document contains no requirements")

    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise IngestError("Every entry of 'items' must be a JSON object")
        _validate_item(item, seen)
        seen.add(str(item["id"]))

    return items, meta


def allocate_version(mongo: Database[dict[str, Any]], kind: ArtifactKind) -> str:
    """Allocate the next artifact version for ``kind``. Never accepted from a client.

    Reads the ``artifact_version`` field rather than the ``_id``: the ``_id`` is scoped by
    kind, the version number is not.
    """
    highest = 0
    for doc in mongo.vm_artifact_sets.find({"kind": kind.value}, {"artifact_version": 1}):
        version_id = str(doc.get("artifact_version", ""))
        if VERSION_PATTERN.match(version_id):
            highest = max(highest, int(version_id[1:]))
    return f"v{highest + 1:04d}"


def find_existing_set(
    mongo: Database[dict[str, Any]], kind: ArtifactKind, sha: str
) -> dict[str, Any] | None:
    """Return the artifact set with this canonical sha, if one is already stored."""
    return mongo.vm_artifact_sets.find_one({"kind": kind.value, "canonical_sha256": sha})


def ingest_requirements_set(
    mongo: Database[dict[str, Any]],
    payload: Any,
    source_label: str | None = None,
    created_by: str | None = None,
    blob_path: str | None = None,
    forced_version: str | None = None,
) -> tuple[dict[str, Any], bool]:
    """Ingest a requirements document as an artifact version.

    Returns ``(artifact_set_document, created)``.

    Two modes, both idempotent:

    * ``forced_version`` given (the fixture seed) - that version is written in place from
      the payload every time. Re-running refreshes changed fixture content and prunes items
      that are no longer in the set. ``created`` reports whether this was the first write.
    * ``forced_version`` omitted (the upload route) - an identical item set returns the
      existing version untouched, otherwise a fresh version is allocated. Uploaded versions
      are never rewritten in place.
    """
    items, meta = parse_requirements_document(payload)
    sha = canonical_sha256(items)
    existing = find_existing_set(mongo, ArtifactKind.REQUIREMENTS, sha)

    if forced_version is None:
        if existing:
            return existing, False
        artifact_version = allocate_version(mongo, ArtifactKind.REQUIREMENTS)
    else:
        artifact_version = forced_version

    key = artifact_set_key(ArtifactKind.REQUIREMENTS, artifact_version)
    already_stored = mongo.vm_artifact_sets.find_one({"_id": key}) is not None

    docs = [_requirement_doc(item, artifact_version) for item in items]
    item_ids = sorted(doc["req_id"] for doc in docs)

    artifact_set = {
        "_id": key,
        "artifact_version": artifact_version,
        "kind": ArtifactKind.REQUIREMENTS.value,
        "item_count": len(item_ids),
        "item_ids": item_ids,
        "canonical_sha256": sha,
        "declared_canonical_sha256": meta.get("declared_canonical_sha256"),
        "created_utc": now(),
        "created_by": created_by or meta.get("created_by"),
        "source_label": source_label,
        "source_version": meta.get("source_version"),
        "document_revision": meta.get("document_revision"),
        "blob_path": blob_path,
    }

    replace_items(mongo.vm_requirements, docs, {"artifact_version": artifact_version})
    mongo.vm_artifact_sets.replace_one({"_id": key}, artifact_set, upsert=True)
    logger.info(
        "%s requirements artifact %s: %d items (sha %s)",
        "Refreshed" if already_stored else "Ingested",
        artifact_version,
        len(docs),
        sha[:12],
    )
    return artifact_set, not already_stored


def publish_baseline(
    mongo: Database[dict[str, Any]],
    baseline_id: str,
    label: str,
    versions: dict[str, str | None],
    counts: BaselineCounts,
    req_links: dict[str, list[str]],
    set_hashes: dict[str, str] | None = None,
    notes: str | None = None,
) -> dict[str, Any]:
    """Publish a baseline: one pinned version per artifact kind plus the frozen reverse index.

    A baseline is immutable once a run pins it. The *seeded* baseline is deterministic - it is
    derived entirely from the committed fixtures - so re-seeding replaces it rather than
    accumulating near-duplicates. Nothing else rewrites a baseline.
    """
    coverage = (
        counts.covered_requirements / counts.requirements if counts.requirements else 0.0
    )
    baseline = Baseline(
        _id=baseline_id,
        label=label,
        requirements_version=str(versions["requirements"]),
        test_specs_version=versions.get("test_specs"),
        test_impl_version=versions.get("test_impl"),
        signal_catalog_version=versions.get("signal_catalog"),
        set_hashes=set_hashes or {},
        counts=counts,
        baseline_coverage_static=round(coverage, 4),
        req_links=req_links,
        notes=notes,
    )
    document = baseline.model_dump(by_alias=True)
    mongo.vm_baselines.replace_one({"_id": baseline_id}, document, upsert=True)
    logger.info(
        "Published baseline %s: %d/%d requirements covered (%.1f%%)",
        baseline_id,
        counts.covered_requirements,
        counts.requirements,
        coverage * 100,
    )
    return document
