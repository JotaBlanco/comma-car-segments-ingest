"""The terminal `file_complete` message, built in one place.

This is the message that puts a file in the Test Manager. tm-connector finalizes
on it — it upserts the run, registers the file with the whole `inventory` list as
that file's signal catalogue, and writes the ingestion timeline. Nothing else on
the output topic reaches `POST /files`.

It is a pure function, separate from the produce call, for one reason: the
registry's request models are `extra="forbid"`, so a key invented here is a 422
that costs the whole file's catalogue — and a 422 looks exactly like a file
nobody ever uploaded. `tests/test_marker_contract.py` feeds what this returns to
tm-connector's real readers and then to the registry's real models, which is the
only check that actually proves the shape.
"""

from __future__ import annotations

KIND_FILE_COMPLETE = "file_complete"

# What the registry's `checksum_state` may say. mf4-to-blob hashed the bytes on
# the way in; the decoder reads the object back and takes no second digest, so
# there is nothing here that could honestly say two digests agree.
CHECKSUM_UNVERIFIED = "unverified"

# The format this estate registers every file as (`SourceSystem`/`format` on
# `FileRegisterRequest`).
FORMAT = "MF4"


def build_marker(
    *,
    metadata: dict,
    filename: str,
    upload_id: str | None,
    declared: dict,
    header_properties: dict,
    inventory_rows: list[dict],
    time_start_ms: int | None,
    time_end_ms: int | None,
    unknown: str,
    decode_error: str | None = None,
    samples_suppressed: str | None = None,
) -> dict:
    """One `file_complete` payload.

    `declared` is the bag the decoder RESOLVED, not the one the upload carried:
    it holds the run id every reader downstream takes from rung 1 of its own
    ladder (see identity.py). `header_properties` rides here and not on every
    batch, because the connector opens it only when finalizing.
    """
    return {
        "kind": KIND_FILE_COMPLETE,
        "upload_id": upload_id or unknown,
        "file_name": filename,
        "declared": declared,
        "header_properties": header_properties,
        "file": {
            "sha256": metadata.get("sha256"),
            "checksum_state": CHECKSUM_UNVERIFIED,
            "format": FORMAT,
            "size_bytes": int(metadata.get("size_bytes") or 0),
            "blob_path": metadata.get("blob_path"),
        },
        "batch": {
            "inventory": inventory_rows,
            "time_start_ms": time_start_ms,
            "time_end_ms": time_end_ms,
            "decode_error": decode_error,
            "samples_suppressed": samples_suppressed,
        },
    }
