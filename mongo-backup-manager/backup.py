"""Logic for exporting a MongoDB collection to a JSON string."""
from bson import json_util


def export_collection_to_json(collection) -> str:
    """Read every document in the collection and serialize it to a JSON
    array string. Uses bson.json_util so BSON-specific types (ObjectId,
    datetime, ...) round-trip cleanly."""
    docs = list(collection.find())
    return json_util.dumps(docs, indent=2)
