"""Version-to-version diff of an artifact set (page 1's upload panel).

Because versions are immutable folders, a diff is a pure comparison of two
committed sets - no history table, no audit log to keep in sync.
"""

import artifact_store
from settings import SET_ITEM_SCHEMAS


def diff_versions(set_name: str, from_version: str | None, to_version: str) -> dict:
    """``added`` / ``changed`` / ``removed`` id lists, with per-field diffs."""
    _, id_field = SET_ITEM_SCHEMAS[set_name]
    new_items = artifact_store.read_items(set_name, to_version)
    old_items = (
        artifact_store.read_items(set_name, from_version) if from_version else {}
    )

    added = sorted(set(new_items) - set(old_items))
    removed = sorted(set(old_items) - set(new_items))
    changed = []
    for item_id in sorted(set(old_items) & set(new_items)):
        fields = _field_diff(old_items[item_id], new_items[item_id])
        if fields:
            changed.append({"id": item_id, "fields": fields})

    return {
        "set": set_name,
        "from_version": from_version,
        "to_version": to_version,
        "id_field": id_field,
        "added": added,
        "removed": removed,
        "changed": changed,
        "unchanged_count": len(set(old_items) & set(new_items)) - len(changed),
    }


def _field_diff(old: dict, new: dict) -> dict:
    diff = {}
    for field in sorted(set(old) | set(new)):
        if old.get(field) != new.get(field):
            diff[field] = {"from": old.get(field), "to": new.get(field)}
    return diff
