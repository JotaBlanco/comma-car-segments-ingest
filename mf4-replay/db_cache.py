"""Cache of compiled CAN databases, keyed by DCM configuration version.

QuixConfigurationService fetches and caches the config *content* for us. What it
cannot cache is the expensive part: turning that JSON into a cantools Database
(331 frames / 2150 signals). That compile happens once per config version here.
"""

from __future__ import annotations

import logging
from typing import Any

from cantools.database.can import Database

from dbc_json import from_json

logger = logging.getLogger(__name__)


class DatabaseCache:
    def __init__(self, max_entries: int = 4):
        self._max = max_entries
        self._by_version: dict[Any, Database] = {}

    def get(self, version: Any, doc: dict) -> Database:
        """Return the compiled database for a config version, compiling on miss."""
        db = self._by_version.get(version)
        if db is not None:
            return db

        db = from_json(doc)
        # A handful of versions is plenty; this only grows when the DBC changes.
        if len(self._by_version) >= self._max:
            oldest = next(iter(self._by_version))
            self._by_version.pop(oldest, None)
            logger.info("database cache full, evicted version %s", oldest)
        self._by_version[version] = db
        logger.info(
            "compiled CAN database for config version %s: %d frames, %d signals",
            version,
            len(db.messages),
            sum(len(m.signals) for m in db.messages),
        )
        return db

    @property
    def versions(self) -> list:
        return list(self._by_version)
