"""Pure transformation logic for turning an incoming test-data upload payload
into a Kafka message (key, value) pair."""
import uuid


def build_upload_message(payload: dict) -> tuple[str, dict]:
    """Build the (key, value) pair to publish to the test-data-uploads topic.

    - key: a meaningful identifier from the payload (``test_run_id`` or
      ``id``), or a generated UUID if neither is present.
    - value: the original payload, unmodified.
    """
    key = payload.get("test_run_id") or payload.get("id") or str(uuid.uuid4())
    return key, payload
