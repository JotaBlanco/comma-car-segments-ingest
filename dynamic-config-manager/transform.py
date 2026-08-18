"""Pure transformation logic for turning an incoming config payload into a
Kafka message (key, value) pair. Kept free of any Kafka/FastAPI dependency
so it can be unit tested in isolation.
"""
import uuid
from datetime import datetime, timezone


def build_config_event(payload: dict, event_id: str | None = None, received_at: str | None = None) -> tuple[str, dict]:
    """Build the (key, value) pair to publish to the config-updates topic.

    - key: the config identifier from the payload (``config_id`` or ``id``),
      or a generated UUID if neither is present.
    - value: the original payload plus a generated ``event_id`` and
      ``received_at`` ISO-8601 UTC timestamp.
    """
    if event_id is None:
        event_id = str(uuid.uuid4())
    if received_at is None:
        received_at = datetime.now(timezone.utc).isoformat()

    key = payload.get("config_id") or payload.get("id") or str(uuid.uuid4())

    value = {**payload, "event_id": event_id, "received_at": received_at}
    return key, value
