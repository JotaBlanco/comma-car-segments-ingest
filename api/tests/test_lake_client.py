# The QuixLake client and the SQL it sends (ticket B-08).
#
# No test here reaches the network. httpx.MockTransport answers every call.

import httpx
import pytest

from api.services import lake, queries_stats

NAME = "HV_Batt_Cell_Temp_Max"

EXPECTED_SQL = (
    "SELECT run_id, min(value) AS min, max(value) AS max, "
    "avg(value) AS mean, stddev(value) AS std, "
    "sqrt(avg(value * value)) AS rms, "
    "quantile_cont(value, 0.5) AS p50, quantile_cont(value, 0.95) AS p95, "
    "quantile_cont(value, 0.99) AS p99 "
    "FROM test_signal_samples "
    "WHERE signal = 'HV_Batt_Cell_Temp_Max' "
    "GROUP BY run_id"
)

# Contract #7 asks the mirror question: one row per signal of one run. Before
# 2026-08-17 no test spelled this statement out, so the columns could swap and
# every test stayed green.
EXPECTED_RUN_SQL = (
    "SELECT signal, min(value) AS min, max(value) AS max, "
    "avg(value) AS mean, stddev(value) AS std, "
    "sqrt(avg(value * value)) AS rms, "
    "quantile_cont(value, 0.5) AS p50, quantile_cont(value, 0.95) AS p95, "
    "quantile_cont(value, 0.99) AS p99 "
    "FROM test_signal_samples "
    "WHERE run_id = 'TAS-88214' "
    "GROUP BY signal"
)

CSV_BODY = (
    "run_id,min,max,mean,std\n"
    "TAS-88214,18.2,47.9,33.4,6.21\n"
    "TAS-88190,19.1,44.0,31.8,5.4\n"
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Clear the lake variables, so a developer's environment cannot leak in."""
    for name in (
        "TM_LAKE_TABLE",
        "Quix__Lakehouse__Query__Url",
        "QUIX_LAKE_URL",
        "Quix__Lakehouse__Query__AuthToken",
        "Quix__Sdk__Token",
        "API_AUTH_TOKEN",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def lake_env(monkeypatch):
    """Point the client at a fake lake. The transport still answers the call."""
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", "http://lake.test/")
    monkeypatch.setenv("Quix__Sdk__Token", "token-not-a-secret")


def _transport(handler) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def _record(seen: list, body: str = CSV_BODY, status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, text=body, headers={"Content-Type": "text/csv"})

    return _transport(handler)


def test_the_sql_names_the_table_and_filters_the_partition_column():
    assert queries_stats.signal_stats_sql(NAME) == EXPECTED_SQL


def test_the_run_sql_groups_by_signal_and_filters_the_run_partition():
    assert queries_stats.run_stats_sql("TAS-88214") == EXPECTED_RUN_SQL


def test_the_two_statements_swap_the_group_and_the_filter_column():
    # #16 groups by run_id and filters signal. #7 does the mirror. A swap
    # returns rows for the wrong question, and the two endpoints then disagree.
    assert queries_stats.signal_stats_sql(NAME).startswith("SELECT run_id,")
    assert "WHERE signal = " in queries_stats.signal_stats_sql(NAME)
    assert queries_stats.run_stats_sql("TAS-88214").startswith("SELECT signal,")
    assert "WHERE run_id = " in queries_stats.run_stats_sql("TAS-88214")


def test_a_quote_in_the_signal_name_doubles_and_never_breaks_the_literal():
    sql = queries_stats.signal_stats_sql("Rig'A")

    assert "WHERE signal = 'Rig''A' " in sql


def test_a_quote_in_the_run_id_doubles_and_never_breaks_the_literal():
    # A run id is caller data too. It reaches the literal by the same route.
    sql = queries_stats.run_stats_sql("TAS-1' OR '1'='1")

    assert "WHERE run_id = 'TAS-1'' OR ''1''=''1' " in sql


def test_the_run_sql_also_takes_the_table_name_from_the_environment(monkeypatch):
    monkeypatch.setenv("TM_LAKE_TABLE", "mdf_file_test")

    assert "FROM mdf_file_test " in queries_stats.run_stats_sql("TAS-88214")


def test_the_table_name_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("TM_LAKE_TABLE", "mdf_file_test")

    assert "FROM mdf_file_test " in queries_stats.signal_stats_sql(NAME)


def test_the_client_posts_the_raw_sql_as_the_request_body(lake_env):
    seen: list[httpx.Request] = []

    lake.query(EXPECTED_SQL, transport=_record(seen))

    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == "http://lake.test/query?union_by_name=true"
    assert request.headers["Authorization"] == "Bearer token-not-a-secret"
    assert request.headers["Content-Type"] == "text/plain"
    assert request.content.decode() == EXPECTED_SQL


def test_the_client_parses_the_csv_rows(lake_env):
    rows = lake.query(EXPECTED_SQL, transport=_record([]))

    assert rows == [
        {"run_id": "TAS-88214", "min": "18.2", "max": "47.9", "mean": "33.4", "std": "6.21"},
        {"run_id": "TAS-88190", "min": "19.1", "max": "44.0", "mean": "31.8", "std": "5.4"},
    ]


def test_an_empty_result_parses_as_no_rows(lake_env):
    assert lake.query("SELECT 1", transport=_record([], body="run_id,min\n")) == []


def test_a_missing_url_raises_before_any_call():
    with pytest.raises(lake.LakeError, match="Quix__Lakehouse__Query__Url"):
        lake.query("SELECT 1")


def test_a_missing_token_raises_before_any_call(monkeypatch):
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", "http://lake.test")

    with pytest.raises(lake.LakeError, match="Quix__Lakehouse__Query__AuthToken"):
        lake.query("SELECT 1")


def test_the_client_accepts_the_portal_fallback_variable_names(monkeypatch):
    monkeypatch.setenv("QUIX_LAKE_URL", "http://other.test")
    monkeypatch.setenv("Quix__Sdk__Token", "second-token")
    seen: list[httpx.Request] = []

    lake.query("SELECT 1", transport=_record(seen))

    assert str(seen[0].url).startswith("http://other.test/query")
    assert seen[0].headers["Authorization"] == "Bearer second-token"


# --- The token order. See plans/reviews/LAKE-AND-MF4-EVIDENCE.md section 2 and section 4. ---


def test_the_bind_token_wins_over_the_sdk_token(monkeypatch):
    """The bind writes Quix__Lakehouse__Query__AuthToken. That name comes first."""
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", "http://lake.test")
    monkeypatch.setenv("Quix__Lakehouse__Query__AuthToken", "bind-token")
    monkeypatch.setenv("Quix__Sdk__Token", "sdk-token")
    seen: list[httpx.Request] = []

    lake.query("SELECT 1", transport=_record(seen))

    assert seen[0].headers["Authorization"] == "Bearer bind-token"


def test_the_sdk_token_answers_when_the_bind_token_is_absent(monkeypatch):
    """The Portal injects Quix__Sdk__Token into every workspace deployment."""
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", "http://lake.test")
    monkeypatch.setenv("Quix__Sdk__Token", "sdk-token")
    seen: list[httpx.Request] = []

    lake.query("SELECT 1", transport=_record(seen))

    assert seen[0].headers["Authorization"] == "Bearer sdk-token"


def test_the_client_never_sends_api_auth_token(monkeypatch):
    """API_AUTH_TOKEN authenticates and carries no user identity.

    The lake read gate then filters the parquet set to the caller's own workspaces and
    matches nothing. The query answers 200 with zero rows, and nothing reports an error.
    A silent empty statistics screen is worse than a 403, so the client must refuse.
    """
    monkeypatch.setenv("Quix__Lakehouse__Query__Url", "http://lake.test")
    monkeypatch.setenv("API_AUTH_TOKEN", "identity-free-shared-secret")
    seen: list[httpx.Request] = []

    with pytest.raises(lake.LakeError, match="Quix__Lakehouse__Query__AuthToken"):
        lake.query("SELECT 1", transport=_record(seen))

    assert seen == [], "the client must not open a call with an identity-free token"
    assert "API_AUTH_TOKEN" not in lake._TOKEN_VARS


def test_the_path_is_query_at_the_root_and_never_api_query(lake_env):
    """The Query engine serves POST /query at the root.

    /api/query belongs to the lakehouse UI, an nginx proxy that strips the prefix.
    The Portal injects a Query host into Quix__Lakehouse__Query__Url, never a UI host.
    """
    seen: list[httpx.Request] = []

    lake.query("SELECT 1", transport=_record(seen))

    assert seen[0].url.path == "/query"


def test_the_client_asks_for_csv_and_never_for_the_arrow_stream(lake_env):
    """The lake answers Arrow when Accept names the Arrow stream.

    This client parses CSV. httpx sends `Accept: */*` by default, which lands on
    CSV by luck. The header states the type the parser reads.
    """
    seen: list[httpx.Request] = []

    lake.query("SELECT 1", transport=_record(seen))

    assert seen[0].headers["Accept"] == "text/csv"
    assert "arrow" not in seen[0].headers["Accept"].lower()


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_token_is_not_reported_as_a_lake_that_is_down(lake_env, status):
    """The lake refuses a bad token with 403, and 401 when no header arrives.

    Both used to raise the same LakeError, and the endpoint then told the
    operator the lake did not answer. The operator would hunt the host and the
    credential is the fault. The refusal now carries its own class.
    """
    body = '{"message": "Access Forbidden"}'

    with pytest.raises(lake.LakeAuthError) as raised:
        lake.query("SELECT 1", transport=_record([], body=body, status=status))

    message = str(raised.value)
    assert lake.TOKEN_VAR in message
    assert "token-not-a-secret" not in message
    assert "lake.test" not in message


def test_a_refused_token_is_still_a_lake_error_for_every_old_caller(lake_env):
    """LakeAuthError inherits LakeError, so no caller loses its handler."""
    with pytest.raises(lake.LakeError):
        lake.query("SELECT 1", transport=_record([], body="no", status=403))


def test_an_error_status_raises_and_carries_the_server_text(lake_env):
    transport = _record([], body="Binder Error: no such table", status=500)

    with pytest.raises(lake.LakeError, match="Binder Error"):
        lake.query("SELECT 1", transport=transport)


def test_a_streamed_error_trailer_raises_and_never_returns_partial_rows(lake_env):
    body = "run_id,min\nTAS-88214,18.2\n# ERROR: connection reset\n"

    with pytest.raises(lake.LakeError, match="connection reset"):
        lake.query("SELECT 1", transport=_record([], body=body))


@pytest.mark.parametrize(
    "error",
    [
        httpx.ConnectError("connection refused"),
        httpx.ReadTimeout("timed out"),
        httpx.ConnectTimeout("timed out"),
        httpx.RemoteProtocolError("server closed the connection"),
    ],
    ids=["refused", "read-timeout", "connect-timeout", "protocol"],
)
def test_a_transport_failure_raises_lake_error_and_never_escapes(lake_env, error):
    """A lake that is down is the common failure, not a lake that answers 500.

    httpx raises its own error there. It used to escape the client, and the
    endpoint then reported 500 internal_error for a dependency that was merely
    down. It is a LakeError now, so the endpoint answers 503.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        raise error

    with pytest.raises(lake.LakeError) as raised:
        lake.query("SELECT 1", transport=_transport(handler))

    # The message names the failure class only. It carries no host and no token.
    assert "token-not-a-secret" not in str(raised.value)
    assert "lake.test" not in str(raised.value)


def test_a_body_that_is_not_csv_returns_no_rows_and_never_raises(lake_env):
    """A 200 with a junk body is rare, because a proxy sends a 5xx status.

    The reader must still invent nothing. It reports zero rows.
    """
    rows = lake.query("SELECT 1", transport=_record([], body="<html>not csv</html>"))

    assert rows == []


def test_a_row_shorter_than_the_header_leaves_the_missing_field_empty(lake_env):
    body = "run_id,min,max,mean,std\nTAS-88214,18.2\n"

    rows = lake.query("SELECT 1", transport=_record([], body=body))

    assert rows == [
        {"run_id": "TAS-88214", "min": "18.2", "max": None, "mean": None, "std": None}
    ]


def test_is_configured_reports_the_url(monkeypatch):
    monkeypatch.delenv("Quix__Lakehouse__Query__Url", raising=False)
    monkeypatch.delenv("QUIX_LAKE_URL", raising=False)
    assert lake.is_configured() is False

    monkeypatch.setenv("Quix__Lakehouse__Query__Url", "http://lake.test")
    assert lake.is_configured() is True


# --- a 4xx is the statement's fault; a 5xx is the lake's (finding 17) ---


@pytest.mark.parametrize("status", [400, 404, 409, 422])
def test_a_4xx_raises_a_query_error_and_carries_the_server_text(lake_env, status):
    """The lake read the statement and refused it.

    A typo used to raise the same LakeError a dead host raises, and the
    endpoint then answered 503 and named the lake URL. The caller hunted a
    healthy service while its own SQL held the fault.
    """
    body = "Binder Error: Referenced column 'tmiestamp' not found"

    with pytest.raises(lake.LakeQueryError) as raised:
        lake.query("SELECT 1", transport=_record([], body=body, status=status))

    assert "tmiestamp" in str(raised.value)


def test_a_query_error_is_still_a_lake_error_for_every_old_caller(lake_env):
    """LakeQueryError inherits LakeError, so no caller loses its handler."""
    with pytest.raises(lake.LakeError):
        lake.query("SELECT 1", transport=_record([], body="no", status=400))


@pytest.mark.parametrize("status", [500, 502, 503])
def test_a_5xx_stays_a_plain_lake_error(lake_env, status):
    # A server fault IS the lake. Only the 4xx class changed.
    transport = _record([], body="bad gateway", status=status)

    with pytest.raises(lake.LakeError) as raised:
        lake.query("SELECT 1", transport=transport)

    assert not isinstance(raised.value, lake.LakeQueryError)


@pytest.mark.parametrize("status", [401, 403])
def test_a_refusal_is_an_auth_error_and_never_a_query_error(lake_env, status):
    # 401/403 is a credential. It must not read as the caller's typo.
    with pytest.raises(lake.LakeAuthError) as raised:
        lake.query("SELECT 1", transport=_record([], body="no", status=status))

    assert not isinstance(raised.value, lake.LakeQueryError)
