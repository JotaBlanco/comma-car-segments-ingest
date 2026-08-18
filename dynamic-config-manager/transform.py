"""Building a real Quix Dynamic Configuration event from a posted parameter set.

The previous version produced ``{**payload, event_id, received_at}``, which is not
the Quix DCM event shape, so ``QuixConfigurationService`` / ``join_lookup`` could
never work against the topic. The canonical shape is::

    {
      "id": "<event id>",
      "event": "created",
      "contentUrl": "<url or null>",
      "metadata": {
        "type": "plant-config",
        "target_key": "<device or target>",
        "valid_from": "<ISO-8601>",
        "category": "<category>",
        "version": <integer>,
        "created_at": "<ISO-8601>",
        "sha256sum": "<hex>"
      }
    }

The flat ``config_id`` / ``config_version`` / ``params`` fields are carried
alongside, because a **run pins one ``(config_id, config_version)``** and resolves
it once at evaluation start - config selection here is per run, not per message, so
a per-message lookup join is the wrong primitive rather than a missing one. The
topic still carries the real event shape, so adding per-message enrichment later
needs no topic migration.

``config_hash12`` is ``sha256(canonical(params))[:12]``, the same rule the plant
uses for the hash it embeds in every MF4. That equality is the only cross-version
provenance check the data allows (spec 5.5), so the hash is computed here and never
guessed.
"""

import hashlib
import json
import uuid
from datetime import datetime, timezone


def canonical_bytes(obj) -> bytes:
    """RFC 8785-style JCS: sorted keys, no spaces, UTF-8, no NaN/Inf."""
    return json.dumps(
        obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def canonical_sha256(obj) -> str:
    return hashlib.sha256(canonical_bytes(obj)).hexdigest()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_config_event(
    config_id: str,
    config_version: int,
    params: dict,
    target_key: str | None = None,
    category: str = "plant-config",
    content_url: str | None = None,
    valid_from: str | None = None,
    event: str = "created",
    event_id: str | None = None,
    created_at: str | None = None,
) -> tuple[str, dict]:
    """Return the ``(key, value)`` pair for the ``config-events`` topic.

    The key is ``target_key`` (defaulting to ``config_id``) because that is what a
    DCM consumer keys on; the value carries both the DCM envelope and the flat
    registry fields the ``parameter_sets`` collection needs.
    """
    digest = canonical_sha256(params)
    created = created_at or utc_now_iso()
    key = target_key or config_id
    value = {
        "id": event_id or str(uuid.uuid4()),
        "event": event,
        "contentUrl": content_url,
        "metadata": {
            "type": "plant-config",
            "target_key": key,
            "valid_from": valid_from or created,
            "category": category,
            "version": int(config_version),
            "created_at": created,
            "sha256sum": digest,
        },
        "config_id": config_id,
        "config_version": int(config_version),
        "params": params,
        "canonical_sha256": digest,
        "config_hash12": digest[:12],
    }
    return key, value
