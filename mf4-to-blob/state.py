"""In-process progress registry.

Single-replica only: if Quix scales mf4-to-blob beyond one replica, the
browser polling /progress/{id} can hit a different replica that has no
state for that upload. Acceptable for v1 (per spec §6.3).
"""

from __future__ import annotations

from threading import Lock
from typing import Any, Optional

_uploads: dict[str, dict[str, Any]] = {}
_lock = Lock()


def init(upload_id: str, filename: str, total_bytes: int) -> None:
    with _lock:
        _uploads[upload_id] = {
            "status": "uploading",
            "filename": filename,
            "bytes_received": 0,
            "total_bytes": total_bytes,
            "percent": 0,
        }


def update_bytes(upload_id: str, bytes_received: int) -> None:
    with _lock:
        info = _uploads.get(upload_id)
        if not info:
            return
        info["bytes_received"] = bytes_received
        total = info.get("total_bytes") or 0
        info["percent"] = min(99, round(bytes_received / total * 100)) if total else 0


def set_status(upload_id: str, status: str, **fields: Any) -> None:
    with _lock:
        info = _uploads.setdefault(upload_id, {})
        info["status"] = status
        info.update(fields)
        if status == "done":
            info["percent"] = 100


def get(upload_id: str) -> Optional[dict[str, Any]]:
    with _lock:
        info = _uploads.get(upload_id)
        return dict(info) if info else None


def pop_if_terminal(upload_id: str) -> None:
    """Drop terminal records on read so the dict doesn't grow forever."""
    with _lock:
        info = _uploads.get(upload_id)
        if info and info.get("status") in ("done", "error"):
            _uploads.pop(upload_id, None)
