"""A thin HTTP client for QuixLake.

QuixLake is a remote service (`C:\\Repos\\Quix.DataLake.Timeseries`). It runs
DuckDB inside itself. This module builds no query engine and embeds no DuckDB.
It sends one SQL statement and reads the CSV answer.

The interface: `POST {base}/query?union_by_name=true`, a bearer token, and the
SQL as the raw `text/plain` body. The answer streams CSV.

The path is `/query` at the root. Do not change it to `/api/query`. The Query
engine mounts every route at the root (`quix-ts-datalake-api\\main.py:65-94,:361`).
`/api/query` belongs to the lakehouse UI, an nginx proxy that strips the prefix
(`quix-ts-datalake-ui\\nginx.conf:54-55`). The Portal injects a Query host into
`Quix__Lakehouse__Query__Url`, never a UI host.
"""

import csv
import os

import httpx

# QuixLab uses the same timeout on /query.
TIMEOUT_SECONDS = 120.0

# The name an operator sets. Every message about a missing lake names it.
URL_VAR = "Quix__Lakehouse__Query__Url"

# The name the lakehouse bind writes. Every message about a missing token names it.
TOKEN_VAR = "Quix__Lakehouse__Query__AuthToken"

# The Portal injects these names. The first one that holds a value wins.
_URL_VARS = (URL_VAR, "QUIX_LAKE_URL")

# The token order carries user identity, and the order matters.
#   1. The lakehouse bind writes TOKEN_VAR into the secrets bag. It prefers the bound
#      deployment's own SDK identity token (`LakehouseSinkBindInjector.cs:159,:219`).
#   2. The Portal injects `Quix__Sdk__Token` into every workspace-scoped deployment
#      (`DeploymentService.cs:2180-2183`). Our API is one, so this name always holds.
# `API_AUTH_TOKEN` is absent on purpose. It is the lake service's own shared secret. It
# passes authentication (`auth.py:67-69`) and carries no user identity, so the read gate
# at `duck_db_service.py:169-190` filters the parquet set to nothing. The query then
# answers 200 with zero rows and reports no error. Never add it back.
_TOKEN_VARS = (TOKEN_VAR, "Quix__Sdk__Token")

# The lake streams a trailing CSV comment when a started query then fails.
_ERROR_TRAILER = "# ERROR:"

# The lake answers Arrow when the Accept header asks for the Arrow stream
# (`quix-ts-datalake-api\\main.py:402-405`). It answers CSV otherwise. httpx
# sends `Accept: */*`, which lands on CSV by luck. This client parses CSV, so it
# states the type it parses.
_ACCEPT = "text/csv"

# The lake refuses a caller with 403, not 401. 401 means the header never
# arrived (`quix-ts-datalake-api\\auth.py:58`). 403 means the token reached the
# service and the service rejected it (`auth.py:69`).
_REFUSED = (401, 403)


class LakeError(RuntimeError):
    """The lake is not configured, or it refused the query."""


class LakeAuthError(LakeError):
    """The lake refused our token.

    This is not a lake that is down. The operator fixes a credential, not a
    host, so the two cases must never carry the same message.
    """


class LakeQueryError(LakeError):
    """The lake read the statement and refused it (4xx).

    This is not a lake that is down either. A binder error, an unknown column
    or a bad function call all land here. The caller wrote the fault, so the
    caller must read it — a typo that reports "the lake is unavailable" sends
    a presenter to debug a healthy service.
    """


def _first_env(names: tuple[str, ...]) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def query_url() -> str:
    """Return the QuixLake base URL. Return an empty string when it is unset."""
    return _first_env(_URL_VARS).rstrip("/")


def is_configured() -> bool:
    """Report whether this process can reach a lake."""
    return bool(query_url())


def missing_variable() -> str | None:
    """Name the first lake variable this process does not hold, or None.

    The platform injects both names, so an absent one is a configuration
    state and never a fault of this service. One reader owns the check, so
    the query path, the run-signals read and the readiness report all state
    the same name.
    """
    if not query_url():
        return URL_VAR
    if not _first_env(_TOKEN_VARS):
        return TOKEN_VAR
    return None


def quote(value: str) -> str:
    """Quote one SQL string literal. A single quote doubles."""
    return "'" + value.replace("'", "''") + "'"


def query(sql: str, transport: httpx.BaseTransport | None = None) -> list[dict[str, str]]:
    """Run one SQL statement on the lake and return the CSV rows.

    Every value stays a string. The caller converts the numbers it wants.
    Tests pass a transport, so no unit test opens a socket.
    """
    return list(csv.DictReader(_query_body(sql, transport).splitlines()))


def query_rows(
    sql: str, transport: httpx.BaseTransport | None = None
) -> tuple[list[str], list[list[str]]]:
    """Run one SQL statement and return the header plus the ordered rows.

    DictReader loses the header when a query answers zero rows. Explore must
    still name the columns, so this sibling keeps the header separate. Every
    value stays a string, exactly as query() serves it. A body with no header
    at all answers no columns and no rows.
    """
    lines = _query_body(sql, transport).splitlines()
    reader = csv.reader(lines)
    header = next(reader, None)
    if header is None:
        return [], []
    return header, [list(row) for row in reader]


def _query_body(sql: str, transport: httpx.BaseTransport | None) -> str:
    """POST the SQL and return the checked CSV text. Both readers share this.

    The `# ERROR:` trailer detection is a substring match, so a data value that
    carries the literal would false-positive. Documented and accepted: a
    partial answer must never be served, and the literal is vanishingly rare.
    """
    missing = missing_variable()
    if missing:
        raise LakeError(f"{missing} is not set")
    url = query_url()
    token = _first_env(_TOKEN_VARS)

    try:
        with httpx.Client(transport=transport, timeout=TIMEOUT_SECONDS) as client:
            response = client.post(
                f"{url}/query",
                params={"union_by_name": "true"},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "text/plain",
                    "Accept": _ACCEPT,
                },
                content=sql.encode("utf-8"),
            )
    except httpx.HTTPError as error:
        # A refused connection and a timeout are the common failures. Both must
        # reach the caller as a LakeError, or the API reports a 500 for a
        # dependency that is merely down. The name carries no host and no token.
        raise LakeError(f"QuixLake did not answer: {type(error).__name__}") from error

    body = response.text
    if response.status_code in _REFUSED:
        # The message names the variable an operator changes. It carries no
        # token and no host, and it never repeats the server body: a refusal
        # body states nothing an operator can act on.
        raise LakeAuthError(
            f"QuixLake refused the token ({response.status_code}). "
            f"Check the value of {TOKEN_VAR}."
        )
    if 400 <= response.status_code < 500:
        # The lake parsed the statement and refused it. The statement is the
        # fault, not the lake, so this carries its own class. A 5xx below
        # stays a LakeError, because a server fault IS the lake.
        raise LakeQueryError(f"QuixLake answered {response.status_code}: {body[:500]}")
    if response.status_code >= 400:
        raise LakeError(f"QuixLake answered {response.status_code}: {body[:500]}")
    if _ERROR_TRAILER in body:
        # The rows before the trailer are partial. Never serve a partial answer.
        _, _, message = body.partition(_ERROR_TRAILER)
        raise LakeError(f"QuixLake failed during streaming: {message.strip()[:500]}")
    return body


# --- partition delete ---------------------------------------------------------------
#
# A run's samples live under one hive folder of the lake table. QuixLake deletes a
# folder outright (`quix-ts-datalake-api\\main.py:1616`, `mode=partitions`), which is
# what a run delete needs: no file list, no rewrite, no DuckDB pass. A conditional
# `WHERE run_id = ...` delete would rewrite every parquet file of every partition the
# run touches, and it would leave the folder behind.

# The hive column that names the run. The lake-sink writes
# `platform,work_order,run_id,~channel_name,...`, so the run folder sits three
# levels down and holds every channel beneath it.
RUN_COLUMN = "run_id"

# The catalog caps a combinations answer at 1000 rows and says so with `truncated`.
_COMBINATION_LIMIT = 1000

# QuixLake takes the partition list as ONE comma-joined query parameter, so a value
# holding a comma cannot be addressed. It never happens (these are identifiers), and a
# half-delete would be silent, so the check is explicit.
_PATH_SEPARATOR = ","


class LakePartitionError(LakeError):
    """The run's partitions cannot be named, so nothing may be deleted.

    Separate from a lake that is down: retrying will not help, because the answer
    itself is the problem (a truncated listing, a value this client cannot encode).
    """


def _request(
    method: str,
    path: str,
    params: dict,
    transport: httpx.BaseTransport | None,
) -> httpx.Response:
    """Send one non-query call to the lake and return the checked response.

    `_query_body` owns the `/query` leg and keeps its CSV rules. This is the sibling
    for the JSON legs: the same variables, the same token order, and the same three
    refusal classes, so an operator reads one message whichever leg failed.
    """
    missing = missing_variable()
    if missing:
        raise LakeError(f"{missing} is not set")

    try:
        with httpx.Client(transport=transport, timeout=TIMEOUT_SECONDS) as client:
            response = client.request(
                method,
                f"{query_url()}{path}",
                params=params,
                headers={
                    "Authorization": f"Bearer {_first_env(_TOKEN_VARS)}",
                    "Accept": "application/json",
                },
            )
    except httpx.HTTPError as error:
        raise LakeError(f"QuixLake did not answer: {type(error).__name__}") from error

    if response.status_code in _REFUSED:
        raise LakeAuthError(
            f"QuixLake refused the token ({response.status_code}). "
            f"Check the value of {TOKEN_VAR}."
        )
    return response


def run_partitions(
    table: str, run_id: str, transport: httpx.BaseTransport | None = None
) -> list[str]:
    """Name every partition folder of `table` that belongs to one run.

    One call. `/partition-combinations` answers the table's PHYSICAL partition keys
    in hive order (`partition_keys`) together with the distinct value combinations
    that match the filter, so the folder path is the prefix up to and including
    `run_id`. The levels BELOW it (protocol, and the time folders a table may add)
    are not named: QuixLake removes the folder tree, and the catalog matches a
    partition by the values given, so a prefix deletes every entry beneath it
    (`postgres_catalog_service.py:2530`).

    A table the lake does not hold answers no partitions — a run whose samples never
    arrived is not an error. A truncated answer raises: a partial list deletes part
    of a run and reports success, which is worse than refusing.
    """
    response = _request(
        "GET",
        "/partition-combinations",
        {"table": table, "filter": f"{RUN_COLUMN}:{run_id}", "limit": _COMBINATION_LIMIT},
        transport,
    )
    if response.status_code == 404:
        return []
    if response.status_code >= 400:
        raise LakeError(f"QuixLake answered {response.status_code}: {response.text[:500]}")

    body = response.json()
    columns = [str(name) for name in body.get("partition_keys") or []]
    index = next(
        (i for i, name in enumerate(columns) if name.lower() == RUN_COLUMN), None
    )
    if index is None:
        # The table is not partitioned by run. Deleting a folder would take another
        # run's rows with it, so this client refuses to name one.
        return []
    if body.get("truncated"):
        raise LakePartitionError(
            f"QuixLake listed more than {_COMBINATION_LIMIT} partition combinations "
            f"for run {run_id}; the run cannot be deleted as whole partitions."
        )

    outer = columns[:index]
    run_segment = f"{columns[index]}={run_id}"
    if not outer:
        return [run_segment]

    paths: list[str] = []
    for row in body.get("combinations") or []:
        segments = []
        for name in outer:
            value = row.get(name)
            if value is None:
                # A NULL outer value has no folder this client can name. Skipping it
                # leaves data behind silently, so the whole delete stops instead.
                raise LakePartitionError(
                    f"QuixLake holds run {run_id} under a partition with no {name} "
                    f"value; the run cannot be deleted as whole partitions."
                )
            segments.append(f"{name}={value}")
        segments.append(run_segment)
        path = "/".join(segments)
        if path not in paths:
            paths.append(path)

    unaddressable = [path for path in paths if _PATH_SEPARATOR in path]
    if unaddressable:
        raise LakePartitionError(
            f"A partition value of run {run_id} holds a comma "
            f"({unaddressable[0]}), which QuixLake's partition list cannot carry."
        )
    return paths


def delete_partitions(
    table: str, partitions: list[str], transport: httpx.BaseTransport | None = None
) -> int:
    """Delete whole partition folders of `table`. Return how many QuixLake removed.

    QuixLake removes the folder from storage and the matching entries from the
    catalog manifest, in one synchronous call. An empty list never reaches the wire:
    `mode=partitions` with nothing to delete is a call that can only go wrong.
    """
    if not partitions:
        return 0

    response = _request(
        "DELETE",
        "/delete",
        {
            "table": table,
            "mode": "partitions",
            "partitions": _PATH_SEPARATOR.join(partitions),
        },
        transport,
    )
    if response.status_code >= 400:
        raise LakeError(f"QuixLake answered {response.status_code}: {response.text[:500]}")

    try:
        result = response.json().get("deletion_result") or {}
    except ValueError:
        return len(partitions)
    deleted = result.get("partitions_deleted")
    return int(deleted) if isinstance(deleted, int) else len(partitions)
