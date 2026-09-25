"""Did this file's CAN frames actually decode?

Pure, so it can be imported by a test: ``main.py`` builds an ``Application`` and
reads ``os.environ["input"]`` at import, so nothing defined there is testable.

On 2026-09-25 four traces were decoded with no database in DCM: 180,000 frames
each were dropped, zero samples were produced, and every file was marked decoded
and registered clean. This module is the predicate that tells that apart from a
file which simply holds no CAN frames.

What it does NOT catch: a database that covers some frame ids and not others.
``decoded_signals > 0``, so the file registers clean and the uncovered frames
are dropped as silently as they were before. Telling "this database describes 8
of the 9 frames" from "this file carries a frame no database ever described"
needs the frame-id sets of both sides, and neither the decoder nor the marker
holds them - see ``dev-planning/decode-without-a-database/architecture.md``.
"""

from __future__ import annotations

DECODING_OFF = "decoding is switched off (DBC_SOURCE=none)"


def decode_failure(
    *, bus_frames: int, decoded_signals: int, dbc_reason: str | None, platform: str
) -> str | None:
    """The `decode_error` for a file whose CAN frames produced no signal.

    None means the file is fine: either it carries no CAN frames (an ordinary
    MF4, or an empty bus-logging group), or frames went in and signals came
    out. Anything else is a decode that could not run, not a file with nothing
    in it.
    """
    if bus_frames == 0 or decoded_signals > 0 or dbc_reason == DECODING_OFF:
        return None
    if dbc_reason is None:
        return (
            f"the CAN database for platform {platform} decoded 0 of "
            f"{bus_frames} frame(s)"
        )
    return f"{dbc_reason} - {bus_frames} CAN frame(s) could not be decoded"
