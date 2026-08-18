"""The device / configuration registry - MongoDB's assigned job (spec 3, 3.4).

``devices`` and ``device_versions`` hold model parameterisation plus the SW and HW
version per ``device_id``. ``parameter_sets`` holds one document per
``(config_id, config_version)``, which is what a run pins.

Why an explicit write endpoint for parameter sets: the registry's intended feed is
the ``config-events`` topic sunk by ``mongo-writer``, but the deployed Dynamic
Config Manager is a 48-line write-only publisher that does not emit Quix DCM
events, and the backend used to consume its topic into a single last-write-wins
in-memory slot that was lost on restart. A run must pin a specific
``(config_id, config_version)``, and a volatile slot cannot serve that. This
endpoint canonicalises and versions the content so a run has something durable to
reference today; the topic path keeps working unchanged once the config manager
emits real events.
"""

from fastapi import APIRouter, Depends, HTTPException

import canonical
import deps
import ids
import mongo_schema
from api_models import DeviceCreate, DeviceVersionCreate, ParameterSetCreate

router = APIRouter(tags=["registry"])


@router.get("/devices")
def list_devices(db=Depends(deps.get_db)) -> dict:
    documents = list(db[mongo_schema.DEVICES].find().sort("device_id", 1))
    return {"count": len(documents), "items": mongo_schema.serialize_all(documents)}


@router.post("/devices", status_code=201)
def create_device(body: DeviceCreate, db=Depends(deps.get_db)) -> dict:
    existing = db[mongo_schema.DEVICES].find_one({"device_id": body.device_id})
    if existing is not None:
        raise HTTPException(status_code=409, detail=f"device {body.device_id} already exists")
    document = {
        **body.model_dump(),
        "current_sw_version": None,
        "current_hw_version": None,
        "created_utc": ids.utc_now_iso(),
    }
    db[mongo_schema.DEVICES].insert_one(dict(document))
    return mongo_schema.serialize(document)


@router.get("/devices/{device_id}")
def get_device(device_id: str, db=Depends(deps.get_db)) -> dict:
    device = db[mongo_schema.DEVICES].find_one({"device_id": device_id})
    if device is None:
        raise HTTPException(status_code=404, detail=f"device {device_id} does not exist")
    versions = list(
        db[mongo_schema.DEVICE_VERSIONS].find({"device_id": device_id}).sort("first_seen_utc", 1)
    )
    return {
        "device": mongo_schema.serialize(device),
        "versions": mongo_schema.serialize_all(versions),
    }


@router.post("/devices/{device_id}/versions", status_code=201)
def create_device_version(
    device_id: str, body: DeviceVersionCreate, db=Depends(deps.get_db)
) -> dict:
    """A device version is the ``(sw_version, hw_version)`` pair; it is immutable."""
    if db[mongo_schema.DEVICES].find_one({"device_id": device_id}) is None:
        raise HTTPException(status_code=404, detail=f"device {device_id} does not exist")
    key = {
        "device_id": device_id,
        "sw_version": body.sw_version,
        "hw_version": body.hw_version,
    }
    if db[mongo_schema.DEVICE_VERSIONS].find_one(key) is not None:
        raise HTTPException(
            status_code=409,
            detail=f"device version {device_id}/{body.sw_version}/{body.hw_version} exists",
        )
    document = {
        **key,
        "plant_spec_ref": body.plant_spec_ref,
        "tool_name": body.tool_name,
        "tool_version": body.tool_version,
        "asammdf_version": body.asammdf_version,
        # Declared extension point for raw-CAN MF4 (spec 0.6): adding a decode
        # stage later needs this field and no table change.
        "dbc_id": body.dbc_id,
        "config_id": body.config_id,
        "config_version": body.config_version,
        "first_seen_utc": ids.utc_now_iso(),
    }
    db[mongo_schema.DEVICE_VERSIONS].insert_one(dict(document))
    if body.make_current:
        db[mongo_schema.DEVICES].update_one(
            {"device_id": device_id},
            {
                "$set": {
                    "current_sw_version": body.sw_version,
                    "current_hw_version": body.hw_version,
                }
            },
        )
    return mongo_schema.serialize(document)


@router.get("/parameter-sets")
def list_parameter_sets(
    config_id: str | None = None, db=Depends(deps.get_db)
) -> dict:
    query = {"config_id": config_id} if config_id else {}
    documents = list(
        db[mongo_schema.PARAMETER_SETS]
        .find(query)
        .sort([("config_id", 1), ("config_version", 1)])
    )
    return {"count": len(documents), "items": mongo_schema.serialize_all(documents)}


@router.post("/parameter-sets", status_code=201)
def create_parameter_set(body: ParameterSetCreate, db=Depends(deps.get_db)) -> dict:
    """Register one immutable ``(config_id, config_version)``.

    ``config_hash12`` is ``sha256(canonical(params))[:12]``, the same rule the
    plant uses for the hash it embeds in every MF4 - which is what makes the
    provenance check at evaluation time possible at all (spec 5.5).
    """
    key = {"config_id": body.config_id, "config_version": body.config_version}
    if db[mongo_schema.PARAMETER_SETS].find_one(key) is not None:
        raise HTTPException(
            status_code=409,
            detail=f"parameter set {body.config_id}@v{body.config_version} already exists",
        )
    canonical_hash = canonical.canonical_sha256(body.params)
    document = {
        **key,
        "target_key": body.target_key or body.config_id,
        "category": body.category,
        "type": "plant-config",
        "content_url": body.content_url,
        "sha256sum": canonical_hash,
        "canonical_sha256": canonical_hash,
        "config_hash12": canonical_hash[:12],
        "created_at": ids.utc_now_iso(),
        "params": body.params,
        "notes": body.notes,
        "source": "api",
    }
    db[mongo_schema.PARAMETER_SETS].insert_one(dict(document))
    return mongo_schema.serialize(document)


@router.get("/parameter-sets/{config_id}/{config_version}")
def get_parameter_set(config_id: str, config_version: int, db=Depends(deps.get_db)) -> dict:
    document = db[mongo_schema.PARAMETER_SETS].find_one(
        {"config_id": config_id, "config_version": config_version}
    )
    if document is None:
        raise HTTPException(
            status_code=404, detail=f"parameter set {config_id}@v{config_version} does not exist"
        )
    return mongo_schema.serialize(document)


@router.get("/parameter-sets/{config_id}/{config_version}/diff/{other_version}")
def diff_parameter_sets(
    config_id: str, config_version: int, other_version: int, db=Depends(deps.get_db)
) -> dict:
    """Parameter diff for the create-run form's "diff against the default set"."""
    left = db[mongo_schema.PARAMETER_SETS].find_one(
        {"config_id": config_id, "config_version": config_version}
    )
    right = db[mongo_schema.PARAMETER_SETS].find_one(
        {"config_id": config_id, "config_version": other_version}
    )
    if left is None or right is None:
        raise HTTPException(status_code=404, detail="one of the parameter set versions is unknown")
    left_params = left.get("params") or {}
    right_params = right.get("params") or {}
    changed = {
        key: {"from": right_params.get(key), "to": left_params.get(key)}
        for key in sorted(set(left_params) | set(right_params))
        if left_params.get(key) != right_params.get(key)
    }
    return {
        "config_id": config_id,
        "from_version": other_version,
        "to_version": config_version,
        "changed": changed,
    }
