"""Artifact-set version browsing and diffing.

Read endpoints only. A version folder is immutable, so these are pure blob reads
addressed by a path segment - no query, no cache-invalidation problem, and no way
to serve two versions of the same artifact in one response.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

import artifact_store
import blob_storage
import deps
import diff_service
import paths
import schema_registry
from settings import SET_FOLDERS

router = APIRouter(prefix="/artifact-sets", tags=["artifacts"])


def _known_set(set_name: str) -> str:
    if set_name not in SET_FOLDERS:
        raise HTTPException(
            status_code=404,
            detail=f"unknown artifact set {set_name!r}; known: {sorted(SET_FOLDERS)}",
        )
    return set_name


@router.get("")
def list_sets() -> dict:
    deps.require_blob()
    return {
        set_name: {
            "folder": paths.set_root(set_name),
            "versions": artifact_store.list_versions(set_name),
            "latest": artifact_store.latest_version(set_name),
        }
        for set_name in sorted(SET_FOLDERS)
    }


@router.get("/{set_name}/versions")
def list_versions(set_name: str) -> dict:
    deps.require_blob()
    _known_set(set_name)
    versions = artifact_store.list_versions(set_name)
    return {"set": set_name, "versions": versions, "latest": versions[-1] if versions else None}


@router.get("/{set_name}/versions/{version}/manifest")
def get_manifest(set_name: str, version: str, include_items: bool = False) -> dict:
    deps.require_blob()
    _known_set(set_name)
    manifest = artifact_store.read_manifest(set_name, version)
    if not include_items:
        manifest = {key: value for key, value in manifest.items() if key != "items"}
    return manifest


@router.get("/{set_name}/versions/{version}/items")
def get_items(set_name: str, version: str) -> dict:
    deps.require_blob()
    _known_set(set_name)
    return {"set": set_name, "version": version,
            "items": artifact_store.read_items(set_name, version)}


@router.get("/{set_name}/diff")
def get_diff(
    set_name: str,
    to_version: str = Query(...),
    from_version: str | None = Query(None),
) -> dict:
    """Diff two committed versions, or a version against its parent."""
    deps.require_blob()
    _known_set(set_name)
    if from_version is None:
        manifest = artifact_store.read_manifest(set_name, to_version)
        from_version = manifest.get("parent_version")
    return diff_service.diff_versions(set_name, from_version, to_version)


@router.get("/{set_name}/versions/{version}/figures/{filename}")
def get_figure(set_name: str, version: str, filename: str) -> Response:
    """Serve a figure extracted from a ``.reqifz`` upload as inline SVG."""
    deps.require_blob()
    _known_set(set_name)
    blob = blob_storage.read_bytes(paths.figure(set_name, version, filename))
    return Response(content=blob, media_type="image/svg+xml")


@router.get("/{set_name}/versions/{version}/source/{filename}")
def get_source_file(set_name: str, version: str, filename: str) -> Response:
    """Serve an immutable source artifact (original upload, figure, receipt).

    The frontend never receives a blob credential or a direct blob URL.
    """
    deps.require_blob()
    _known_set(set_name)
    blob = artifact_store.read_source_file(set_name, version, filename)
    media_type = (
        "image/svg+xml" if filename.lower().endswith(".svg") else "application/octet-stream"
    )
    return Response(content=blob, media_type=media_type)


schemas_router = APIRouter(prefix="/schemas", tags=["artifacts"])


@schemas_router.get("")
def list_schemas() -> dict:
    """The published door validators, with the hash each manifest records."""
    return {
        name: {
            "sha256": schema_registry.schema_sha256(name),
            "blob_path": paths.published_schema(name),
        }
        for name in schema_registry.schema_names()
    }


@schemas_router.get("/{name}")
def get_schema(name: str) -> Response:
    try:
        body = schema_registry.raw_bytes(name)
    except schema_registry.SchemaNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return Response(content=body, media_type="application/schema+json")


@schemas_router.post("/publish")
def publish(_: None = Depends(deps.require_blob)) -> dict:
    """Copy the validators to blob so an old manifest stays re-checkable."""
    return {"written": artifact_store.publish_schemas()}
