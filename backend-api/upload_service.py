"""Turning an upload into a committed artifact-set version.

One function per artifact set, all sharing the same seven-step door protocol
(schemas.md 10). The two requirements upload paths - ReqIF and JSON - converge
here: they produce the same canonical items, are hashed by the same function and
are written by the same store, and ``convergence.py`` proves it.
"""

import hashlib
import logging

import artifact_store
import canonical
import ids
import paths
import reqif_parser
import schema_registry
import validation
from artifact_store import ArtifactFile
from settings import (
    SET_ITEM_SCHEMAS,
    SET_MANIFEST_SCHEMAS,
    SET_REQUIREMENTS,
    SET_SIGNAL_CATALOG,
    SET_TEST_SPECS,
    VALIDATOR_VERSION,
)
from validation import Problem, UploadRejected

logger = logging.getLogger(__name__)

MEDIA_TYPE_BY_KIND = {
    "reqif": "application/xml",
    "reqifz": "application/zip",
    "json": "application/json",
    "py": "text/x-python",
    "zip": "application/zip",
}


def detect_requirements_kind(filename: str, data: bytes) -> str:
    """``reqif`` | ``reqifz`` | ``json``, from the extension and a byte sniff."""
    lowered = (filename or "").lower()
    if lowered.endswith(".reqifz") or data[:2] == b"PK":
        return "reqifz"
    if lowered.endswith(".reqif") or data.lstrip()[:1] == b"<":
        return "reqif"
    if lowered.endswith(".json") or data.lstrip()[:1] in (b"{", b"["):
        return "json"
    raise UploadRejected(
        stage="media_type",
        problems=[
            Problem(
                code="unsupported_media_type",
                message=(
                    f"cannot tell what {filename!r} is; accepted uploads are "
                    ".reqif, .reqifz and .json"
                ),
            )
        ],
    )


def _items_from_json(data: bytes, id_field: str) -> list[dict]:
    """Accept a bare list, a ``{items: [...]}`` envelope, or a single item."""
    try:
        parsed = canonical.loads(data)
    except (ValueError, UnicodeDecodeError) as exc:
        raise UploadRejected(
            stage="json_parse",
            problems=[Problem(code="json_parse_error", message=str(exc))],
        ) from exc
    if isinstance(parsed, dict) and isinstance(parsed.get("items"), list):
        return list(parsed["items"])
    if isinstance(parsed, list):
        return list(parsed)
    if isinstance(parsed, dict) and id_field in parsed:
        return [parsed]
    raise UploadRejected(
        stage="json_parse",
        problems=[
            Problem(
                code="unexpected_shape",
                message=(
                    "expected a JSON array of items, an object with an 'items' array, "
                    f"or a single item carrying {id_field!r}"
                ),
            )
        ],
    )


def canonical_requirements(filename: str, data: bytes) -> tuple[list[dict], dict, list[str], dict]:
    """Parse + normalise + validate a requirements upload without storing it.

    Returns ``(items, passthrough, warnings, figures)``. This is the function
    the convergence check calls twice, once per upload path.
    """
    kind = detect_requirements_kind(filename, data)
    figures: dict[str, bytes] = {}
    passthrough: dict = {}
    warnings: list[str] = []

    if kind == "reqifz":
        items, passthrough, warnings, figures = reqif_parser.parse_reqifz(data)
    elif kind == "reqif":
        items, passthrough, warnings = reqif_parser.parse_reqif(data)
    else:
        raw_items = _items_from_json(data, "id")
        # Nothing is converted on the JSON path: the schema mandates the array
        # forms, so a string-shaped measurand is a rejection, not a coercion.
        items = [canonical.normalise_requirement(item) for item in raw_items]
        items.sort(key=lambda item: item.get("id", ""))

    validation.run_door_validation(
        SET_REQUIREMENTS, items, set(figures) if kind == "reqifz" else None
    )
    return items, passthrough, warnings, figures


def ingest_requirements(filename: str, data: bytes, created_by: str, notes: str = "") -> dict:
    """Mint one immutable ``requirements`` version from one upload."""
    kind = detect_requirements_kind(filename, data)
    items, passthrough, warnings, figures = canonical_requirements(filename, data)

    files = _canonical_files(SET_REQUIREMENTS, items, "id")
    files.append(ArtifactFile(f"source/{safe_name(filename)}", data))
    if kind in ("reqif", "reqifz"):
        files.append(
            ArtifactFile("source/reqif-passthrough.json", canonical.stored_bytes(passthrough))
        )
    for name, blob in figures.items():
        files.append(ArtifactFile(f"source/figures/{safe_name(name)}", blob))

    return commit_set_version(
        SET_REQUIREMENTS, items, files, filename, data, kind, created_by, warnings, notes
    )


def ingest_test_specs(filename: str, data: bytes, created_by: str, notes: str = "") -> dict:
    """Mint one immutable ``test_specs`` version. JSON only (spec 4.2)."""
    raw_items = _items_from_json(data, "tc_id")
    items = [canonical.normalise_test_case(item) for item in raw_items]
    items.sort(key=lambda item: item.get("tc_id", ""))
    validation.run_door_validation(SET_TEST_SPECS, items)

    files = _canonical_files(SET_TEST_SPECS, items, "tc_id")
    files.append(ArtifactFile(f"source/{safe_name(filename)}", data))
    return commit_set_version(
        SET_TEST_SPECS, items, files, filename, data, "json", created_by, [], notes
    )


def ingest_signal_catalog(filename: str, data: bytes, created_by: str, notes: str = "") -> dict:
    """Mint one immutable ``signal_catalog`` version. JSON only."""
    items = _items_from_json(data, "signal")
    items.sort(key=lambda item: item.get("signal", ""))
    validation.run_door_validation(SET_SIGNAL_CATALOG, items)

    files = _canonical_files(SET_SIGNAL_CATALOG, items, "signal")
    files.append(ArtifactFile(f"source/{safe_name(filename)}", data))
    return commit_set_version(
        SET_SIGNAL_CATALOG, items, files, filename, data, "json", created_by, [], notes
    )


def _canonical_files(set_name: str, items: list[dict], id_field: str) -> list[ArtifactFile]:
    """The canonical set document plus one file per item, both in stored form."""
    set_document = {"items": items}
    names = {
        SET_REQUIREMENTS: "canonical/requirements.json",
        SET_TEST_SPECS: "canonical/test-cases.json",
        "test_impl": "canonical/test-impl.json",
        SET_SIGNAL_CATALOG: "canonical/signal-catalog.json",
    }
    files = [ArtifactFile(names[set_name], canonical.stored_bytes(set_document))]
    for item in items:
        files.append(
            ArtifactFile(
                f"canonical/items/{item[id_field]}.json", canonical.stored_bytes(item)
            )
        )
    return files


def build_manifest(
    set_name: str,
    version: str,
    parent_version: str | None,
    items: list[dict],
    filename: str,
    data: bytes,
    upload_kind: str,
    created_by: str,
    warnings: list[str],
    notes: str,
) -> dict:
    """The version manifest (spec 3.2), including the schema it was validated against."""
    _, id_field = SET_ITEM_SCHEMAS[set_name]
    item_hashes = [canonical.canonical_sha256(item) for item in items]
    manifest = {
        "schema_version": "1.0.0",
        "set": set_name,
        "version": version,
        "parent_version": parent_version,
        "created_utc": ids.utc_now_iso(),
        "created_by": created_by,
        "source_upload": {
            "filename": safe_name(filename),
            "media_type": MEDIA_TYPE_BY_KIND.get(upload_kind, "application/json"),
            "size_bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "upload_kind": upload_kind,
        },
        "item_count": len(items),
        "item_ids": [item[id_field] for item in items],
        "set_canonical_sha256": canonical.set_canonical_sha256(item_hashes),
        "schema_sha256": schema_registry.schema_sha256(SET_MANIFEST_SCHEMAS[set_name]),
        "validator_version": VALIDATOR_VERSION,
        "warnings": list(warnings),
        "notes": notes,
        "items": items,
    }
    return manifest


def commit_set_version(
    set_name: str,
    items: list[dict],
    files: list[ArtifactFile],
    filename: str,
    data: bytes,
    upload_kind: str,
    created_by: str,
    warnings: list[str],
    notes: str,
) -> dict:
    parent_version = artifact_store.latest_version(set_name)
    version = ids.next_version(artifact_store.list_versions(set_name))
    manifest = build_manifest(
        set_name, version, parent_version, items, filename, data, upload_kind,
        created_by, warnings, notes,
    )

    problems = validation.validate_manifest(set_name, manifest)
    if problems:
        raise UploadRejected(stage="manifest_schema", problems=problems)
    validation.check_manifest_counts(manifest)

    receipt = {
        "uploaded_by": created_by,
        "uploaded_utc": manifest["created_utc"],
        "filename": safe_name(filename),
        "size_bytes": len(data),
        "sha256": manifest["source_upload"]["sha256"],
        "upload_kind": upload_kind,
        "validator_version": VALIDATOR_VERSION,
        "schema_sha256": manifest["schema_sha256"],
        "item_count": len(items),
        "warnings": list(warnings),
    }
    files = [*files, ArtifactFile("source/upload-receipt.json", canonical.stored_bytes(receipt))]

    artifact_store.commit_version(set_name, files, manifest)
    logger.info("Minted %s %s from %s (%d items)", set_name, version, filename, len(items))
    return {
        "set": set_name,
        "version": version,
        "parent_version": parent_version,
        "item_count": len(items),
        "item_ids": manifest["item_ids"],
        "set_canonical_sha256": manifest["set_canonical_sha256"],
        "warnings": list(warnings),
        "manifest_path": paths.manifest(set_name, version),
    }


def safe_name(filename: str) -> str:
    """Strip any directory component from an uploaded file name."""
    cleaned = (filename or "upload").replace("\\", "/").rsplit("/", 1)[-1]
    return cleaned or "upload"
