"""Logbook mirror in InfluxDB.

InfluxDB is **write-only** in this application: create/update/delete of a logbook entry
mirror that entry into Influx and nothing ever reads it back - both read paths in
``routes/logbook.py`` query MongoDB. The mirror is therefore optional, and the backend
must boot and serve the full logbook feature with no Influx instance and no
``INFLUXDB_*`` secrets configured.

That is implemented with a null object rather than ``if influx:`` guards at the call
sites: :func:`connect` installs either a live :class:`_Logbook` or a no-op
:class:`_NullLogbook`, and ``routes/logbook.py`` / ``routes/tests.py`` call the same
methods either way. Re-enabling the mirror is then purely configuration - set
``INFLUXDB_USER`` and ``INFLUXDB_PASSWORD``.

When adding a method to :class:`_Logbook`, add it to :class:`LogbookWriter` and to
:class:`_NullLogbook` as well, or the disabled path breaks at that new call site.
"""

import logging
from typing import Protocol

from influxdb import InfluxDBClient

from .models import LogbookEntry
from .settings import InfluxSettings

logger = logging.getLogger(__name__)


class LogbookWriter(Protocol):
    """Method surface every logbook mirror implementation must provide."""

    def write(self, entry: LogbookEntry) -> None: ...

    def delete(self, entry_id: str) -> None: ...


class _Logbook:
    def __init__(self, client: InfluxDBClient, measurement: str):
        self._client = client
        self._measurement = measurement

    def write(self, entry: LogbookEntry) -> None:
        point = {
            "measurement": self._measurement,
            "tags": {
                "id": entry.id,
            },
            "fields": {
                "test_id": entry.test_id,
                "content": entry.content,
                "operator": entry.operator,
                "sensor_ids": ",".join(entry.sensor_ids),
                "created_at": int(entry.created_at.timestamp()),
            },
            "time": int(entry.timestamp.timestamp()),
        }
        self._client.write_points([point], time_precision="s")

    def delete(self, entry_id: str) -> None:
        self._client.delete_series(measurement=self._measurement, tags={"id": entry_id})


class _NullLogbook:
    """No-op mirror, installed when Influx is unconfigured or unreachable at startup.

    Every method is a deliberate no-op: the logbook entry is already durable in
    MongoDB, which is what both read paths serve, so discarding the mirror write
    loses no user-visible data.
    """

    def write(self, entry: LogbookEntry) -> None:
        """Discard the entry - MongoDB already holds it."""

    def delete(self, entry_id: str) -> None:
        """Nothing to delete - no point was ever written."""


class Influx:
    """Small wrapper around the logbook mirror to make it easier to use."""

    def __init__(self, logbook: LogbookWriter):
        self.logbook = logbook


# Defaults to the no-op mirror so ``get_influx()`` is always safe, even if ``connect()``
# was never called (a code path that previously raised NameError).
_influx: Influx = Influx(logbook=_NullLogbook())


def connect(settings: InfluxSettings) -> None:
    """Install the logbook mirror.

    Never raises. A mirror that nothing reads must not be able to abort API startup,
    so both "not configured" and "configured but unreachable" fall back to
    :class:`_NullLogbook`.
    """
    global _influx

    if not settings.enabled:
        _influx = Influx(logbook=_NullLogbook())
        logger.info(
            "InfluxDB logbook mirroring is DISABLED "
            "(INFLUXDB_USER / INFLUXDB_PASSWORD not set); "
            "logbook entries are stored in and served from MongoDB only"
        )
        return

    try:
        client = InfluxDBClient(
            host=settings.host,
            port=settings.port,
            username=settings.user,
            password=settings.password,
            database=settings.database,
        )
        if settings.database not in {db["name"] for db in client.get_list_database()}:
            client.create_database(settings.database)
    except Exception:  # noqa: BLE001 - an optional mirror must never stop the API booting
        _influx = Influx(logbook=_NullLogbook())
        logger.exception(
            "InfluxDB connection to %s:%s failed; continuing with mirroring disabled",
            settings.host,
            settings.port,
        )
        return

    _influx = Influx(logbook=_Logbook(client=client, measurement=settings.measurement))
    logger.info(
        "InfluxDB logbook mirroring is ENABLED (%s:%s, database %s)",
        settings.host,
        settings.port,
        settings.database,
    )


def get_influx() -> Influx:
    return _influx
