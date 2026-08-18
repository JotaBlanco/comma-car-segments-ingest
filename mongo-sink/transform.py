"""Pure transformation logic for turning a consumed Kafka message into a
MongoDB document."""


def message_to_document(key: str | None, value: dict) -> dict:
    """Build the document to insert into MongoDB. Uses the message key as
    the document's ``_id`` when present, so re-processing the same key
    upserts rather than duplicates."""
    doc = dict(value)
    if key is not None:
        doc["_id"] = key
    return doc
