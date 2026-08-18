"""Pure transformation logic for turning an incoming test-data upload payload
into a Kafka message (key, value) pair."""
import uuid
from datetime import datetime, timezone


def build_upload_message(payload: dict, now: datetime | None = None) -> tuple[str, dict]:
    """Build the (key, value) pair to publish to the test-data-uploads topic.

    - key: a meaningful identifier from the payload (``test_run_id`` or
      ``id``), or a generated UUID if neither is present.
    - value: the original payload plus a server-set ``received_at`` field
      (UTC ISO-8601 timestamp). This is always overwritten server-side, even
      if the caller's payload already has a ``received_at`` field, so the
      Lakehouse sink has a reliable timestamp column to partition on.
    """
    key = payload.get("test_run_id") or payload.get("id") or str(uuid.uuid4())
    received_at = (now or datetime.now(timezone.utc)).isoformat()
    value = {**payload, "received_at": received_at}
    return key, value
