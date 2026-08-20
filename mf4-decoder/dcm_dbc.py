"""Turn a DCM `can-database/1` document into a .dbc file on disk.

WHY A FILE AT ALL
`MDF.extract_bus_logging` takes `database_files` as paths and dispatches its
parser on the suffix (`asammdf.blocks.utils.load_can_database`), so an in-memory
database is not accepted. `provenance.build_signal_frame_map` then reads the same
paths a second time to recover each signal's frame and transmitting ECU. Writing
the document out as .dbc therefore lets the existing decode path stay exactly as
it is - the only thing that changes is where the database came from.

WHY THE RE-PARSE CHECK
`from_json` rebuilds a cantools Database without revalidating layout, and
`as_dbc_string` will happily emit it. cantools' *reader* is stricter than its
writer, and asammdf re-reads the file we write, so a document that round-trips in
memory can still fail at decode time:

    MAZDA_CX5        "The signal NEW_SIGNAL_4 does not fit in message HVAC."
    HYUNDAI_IONIQ_5  "The signals SCC_ObjSta and ZEROS_10 are overlapping in
                      message SCC_CONTROL."

Both come from opendbc databases that canmatrix accepted and cantools would not.
So the file is parsed back before it is handed on, and if that fails the offending
signals are dropped and it is tried again. A database missing two signals still
decodes the other 500; a database that fails to load decodes nothing.

Dropped signals are logged individually. They are never dropped silently: a
signal that vanished without a line in the log is indistinguishable from one the
recording never contained.
"""

from __future__ import annotations

import logging

import cantools
from cantools.database.can import Database

from dbc_json import from_json

logger = logging.getLogger(__name__)


def _drop_signal(db: Database, message_name: str, signal_names: set[str]) -> int:
    """Remove named signals from one message. Returns how many were removed."""
    removed = 0
    for message in db.messages:
        if message.name != message_name:
            continue
        keep = [s for s in message.signals if s.name not in signal_names]
        removed = len(message.signals) - len(keep)
        message.signals.clear()
        message.signals.extend(keep)
    return removed


def _offenders(error_text: str) -> tuple[str | None, set[str]]:
    """Pull the message and signal names out of a cantools reader error.

    Handles the two shapes seen from the opendbc set:
      "The signal X does not fit in message M."
      "The signals X and Y are overlapping in message M."
    Returns (message_name, signals). An unrecognised error yields (None, set()),
    which the caller treats as unrepairable rather than guessing.
    """
    # cantools wraps the reader message: UnsupportedDatabaseFormatError stringifies
    # as `DBC: "The signal X does not fit in message M."`. Unwrap that first, or
    # the prefix makes the head fail every startswith below and the repair never
    # runs - which is how this returned unrepairable for MAZDA_CX5 on the first try.
    text = error_text.strip()
    if ":" in text and '"' in text:
        inner = text[text.index('"') + 1 :]
        text = inner[: inner.rindex('"')] if '"' in inner else inner
    text = text.strip().rstrip(".")
    if " in message " not in text:
        return None, set()
    head, _, message = text.rpartition(" in message ")
    message = message.strip().strip('"')

    if head.startswith("The signal ") and head.endswith(" does not fit"):
        signal = head[len("The signal ") : -len(" does not fit")]
        return message, {signal.strip()}

    if head.startswith("The signals ") and head.endswith(" are overlapping"):
        names = head[len("The signals ") : -len(" are overlapping")]
        # "X and Y" - drop the second, keeping the one declared first, which is
        # the same tie-break cantools' own frame-id collision handling uses.
        parts = [p.strip() for p in names.split(" and ") if p.strip()]
        return message, set(parts[1:]) or set(parts)

    return None, set()


def materialise(doc: dict, target_path, *, max_repairs: int = 20) -> tuple[object, int]:
    """Write `doc` out as a .dbc at `target_path`.

    Returns ``(path, dropped)`` - the path written and how many signals had to be
    dropped to make the file loadable. Raises if it cannot be made loadable at
    all, because a caller that got a path back has to be able to trust it.
    """
    db = from_json(doc)
    dropped = 0

    for _ in range(max_repairs):
        text = db.as_dbc_string()
        try:
            cantools.database.load_string(text, "dbc")
        except Exception as exc:
            message, signals = _offenders(str(exc))
            if not message or not signals:
                raise
            removed = _drop_signal(db, message, signals)
            if not removed:
                # The error names something we cannot find, so retrying would
                # loop forever on the same text.
                raise
            dropped += removed
            for name in sorted(signals):
                logger.warning(
                    "Dropped signal %s from message %s: cantools will not read it back (%s)",
                    name,
                    message,
                    str(exc).strip(),
                )
            continue

        target_path.write_text(text, encoding="utf-8")
        logger.info(
            "Materialised DCM database at %s: %d frames, %d signals, %d dropped",
            target_path,
            len(db.messages),
            sum(len(m.signals) for m in db.messages),
            dropped,
        )
        return target_path, dropped

    raise RuntimeError(
        f"Could not make the DCM database loadable after {max_repairs} repairs "
        f"({dropped} signals dropped)"
    )
