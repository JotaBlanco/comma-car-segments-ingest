"""Lakehouse Query API wrapper (SQL over the test-vector tables).

Guarded so the service keeps running with this feature disabled. On the dev
cluster the four ``Quix__Lakehouse__*`` variables are injected only when the
deployment carries ``blobStorage: {bind: true}``; that bind is currently
impossible because the testrig Storage Gateway is unreachable, so the variables
are **declared explicitly** on the deployment instead (the BYOX pattern). If they
are absent, ``is_available()`` is false and the reason names the missing variable
rather than failing at the first query with a null URL.

Query constraints, which callers must respect:

* **no CTEs** - the DuckDB-backed Query API silently returns zero rows for
  ``WITH``, which is worse than an error;
* **no aggregation in SQL** - it risks the 30 s timeout; scan raw and reduce in
  Python (a 40 s trace is about 6 400 rows, so this is cheap);
* **partition-equality filters push down** to an S3 prefix, so always constrain
  ``device_id`` and ``scenario``.
"""

import csv
import io
import logging

import requests

import settings

logger = logging.getLogger(__name__)

TIMEOUT_S = 30
FORBIDDEN_SQL = ("with ",)


class LakehouseUnavailableError(RuntimeError):
    """Raised when a query is attempted without Query API configuration."""


class LakehouseQueryError(RuntimeError):
    """Raised when the Query API rejects or fails a query."""


def is_available() -> bool:
    return bool(settings.lakehouse_query_url()) and bool(settings.lakehouse_query_token())


def unavailable_reason() -> str | None:
    if is_available():
        return None
    missing = []
    if not settings.lakehouse_query_url():
        missing.append("Quix__Lakehouse__Query__Url")
    if not settings.lakehouse_query_token():
        missing.append("Quix__Lakehouse__Query__AuthToken")
    return (
        f"Lakehouse Query API is not configured: {', '.join(missing)} unset. On the dev cluster "
        "these inject only with blobStorage.bind: true; declare them as deployment variables "
        "while the Storage Gateway is down."
    )


def require() -> tuple[str, str]:
    reason = unavailable_reason()
    if reason:
        raise LakehouseUnavailableError(reason)
    return settings.lakehouse_query_url(), settings.lakehouse_query_token()


def query_csv(sql: str) -> str:
    """POST one SQL string as ``text/plain``; the reply is CSV."""
    lowered = sql.lower()
    for forbidden in FORBIDDEN_SQL:
        if forbidden in lowered:
            raise LakehouseQueryError(
                f"query contains {forbidden.strip()!r}: the DuckDB-backed Query API silently "
                "returns zero rows for CTEs. Use a single-level query and reduce in Python."
            )
    url, token = require()
    try:
        response = requests.post(
            f"{url.rstrip('/')}/query",
            data=sql.encode("utf-8"),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
            timeout=TIMEOUT_S,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise LakehouseQueryError(f"lake query failed: {exc}") from exc
    return response.text


def query_rows(sql: str) -> list[dict]:
    """Parse the CSV reply into row dicts; values are left as strings."""
    text = query_csv(sql)
    if not text.strip():
        return []
    return list(csv.DictReader(io.StringIO(text)))


def list_tables() -> list[str]:
    url, token = require()
    try:
        response = requests.get(
            f"{url.rstrip('/')}/tables",
            headers={"Authorization": f"Bearer {token}"},
            timeout=TIMEOUT_S,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise LakehouseQueryError(f"table listing failed: {exc}") from exc
    payload = response.json()
    if isinstance(payload, list):
        return [str(entry) for entry in payload]
    return [str(entry) for entry in payload.get("tables", [])]
