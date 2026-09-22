"""The `tm` command line (FR-DM-107).

No test here opens a socket. Every test replaces `tm.TRANSPORT` with an
`httpx.MockTransport`, the same way `test_mock_planning_push.py` drives the
planning worker.
"""

import csv
import io
import json
import pathlib

import httpx
import pytest

from cli import tm

BASE_URL = "http://registry.test"
TOKEN = "cli-token-not-a-secret"

RUN_PAGE = {
    "items": [
        {
            "run_id": "TAS-88214",
            "status": "complete",
            "project": "EX90",
            "rig_id": "RIG-7",
            "file_count": 3,
            "signal_count": 12,
        }
    ],
    "total": 1,
    "page": 1,
    "page_size": 25,
    "total_pages": 1,
    "view_counts": {},
}

FILE_PAGE = {
    "items": [
        {
            "file_id": "F-001",
            "filename": "cycle.mf4",
            "run_id": "TAS-88214",
            "source_system": "INCA",
            "format": "mf4",
            "status": "registered",
        }
    ],
    "total": 1,
}

SIGNAL_PAGE = {
    "items": [
        {
            "name": "EngineSpeed",
            "unit": "rpm",
            "dtype": "float32",
            "typical_rate_hz": 100,
            "run_count": 4,
        }
    ],
    "total": 1,
}

SEARCH_BODY = {
    "query": "rig-7",
    "groups": [
        {
            "type": "runs",
            "items": [{"id": "TAS-88214", "sub": "EX90", "status": "complete", "nav": "/runs"}],
        },
        {"type": "files", "items": []},
    ],
}

RUN_DETAIL = {"run_id": "TAS-88214", "project": "EX90", "invalid": False, "operator": None}

EMPTY_PAGE = {"items": [], "total": 0, "page": 1, "page_size": 25, "total_pages": 0}


class Recorder:
    """A fake API. It records every request and answers one canned body."""

    def __init__(self, body, status: int = 200):
        self.body = body
        self.status = status
        self.requests: list[httpx.Request] = []

    def answer(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, json=self.body)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.answer)


@pytest.fixture
def cli(monkeypatch):
    """Run `tm` against a fake API, and hand back what it printed.

    The caller passes the body the API answers. The call returns the exit
    code, the standard output, the standard error and the recorder.
    """
    monkeypatch.setenv(tm.API_URL_VAR, BASE_URL)
    monkeypatch.setenv(tm.API_TOKEN_VAR, TOKEN)

    def run(argv: list[str], body=None, status: int = 200):
        recorder = Recorder(body, status)
        monkeypatch.setattr(tm, "TRANSPORT", recorder.transport)
        code = tm.main(argv)
        return code, recorder

    return run


def _read(capsys):
    captured = capsys.readouterr()
    return captured.out, captured.err


# --- each command ---------------------------------------------------------------


def test_runs_prints_a_table(cli, capsys) -> None:
    code, recorder = cli(["runs"], RUN_PAGE)
    out, _ = _read(capsys)

    assert code == 0
    assert recorder.requests[0].url.path == "/api/v1/test-runs"
    assert "run_id" in out
    assert "TAS-88214" in out
    assert "1 of 1" in out


def test_files_reads_the_files_route(cli, capsys) -> None:
    code, recorder = cli(["files"], FILE_PAGE)
    out, _ = _read(capsys)

    assert code == 0
    assert recorder.requests[0].url.path == "/api/v1/files"
    assert "cycle.mf4" in out


def test_signals_reads_the_signals_route(cli, capsys) -> None:
    code, recorder = cli(["signals"], SIGNAL_PAGE)
    out, _ = _read(capsys)

    assert code == 0
    assert recorder.requests[0].url.path == "/api/v1/signals"
    assert "EngineSpeed" in out


def test_search_groups_the_hits(cli, capsys) -> None:
    """The ticket's own beat: `tm search "rig-7"` returns the API hits in a table."""
    code, recorder = cli(["search", "rig-7"], SEARCH_BODY)
    out, _ = _read(capsys)

    assert code == 0
    assert recorder.requests[0].url.path == "/api/v1/search"
    assert dict(recorder.requests[0].url.params)["q"] == "rig-7"
    assert "runs (1)" in out
    assert "TAS-88214" in out
    assert "files" not in out, "an empty group prints nothing"


def test_run_shows_one_runs_metadata(cli, capsys) -> None:
    code, recorder = cli(["run", "TAS-88214"], RUN_DETAIL)
    out, _ = _read(capsys)

    assert code == 0
    assert recorder.requests[0].url.path == "/api/v1/test-runs/TAS-88214"
    assert "project" in out
    assert "EX90" in out
    assert "operator" in out and "-" in out, "an unset field reads as a dash"


def test_a_filter_becomes_a_query_parameter(cli) -> None:
    _, recorder = cli(["runs", "--status", "complete", "--page-size", "5"], RUN_PAGE)

    params = dict(recorder.requests[0].url.params)
    assert params["status"] == "complete"
    assert params["page_size"] == "5"


def test_an_unused_filter_sends_no_parameter(cli) -> None:
    _, recorder = cli(["runs"], RUN_PAGE)

    assert dict(recorder.requests[0].url.params) == {}


# --- the machine-readable shape --------------------------------------------------


def test_json_output_is_the_api_body_unchanged(cli, capsys) -> None:
    """The second acceptance clause: the same metadata structure on every interface.

    The CLI adds no shape of its own, so a script reads exactly what the API
    and the UI read.
    """
    code, _ = cli(["--output", "json", "runs"], RUN_PAGE)
    out, _ = _read(capsys)

    assert code == 0
    assert json.loads(out) == RUN_PAGE


def test_the_output_option_works_after_the_subcommand(cli, capsys) -> None:
    code, _ = cli(["search", "rig-7", "--output", "json"], SEARCH_BODY)
    out, _ = _read(capsys)

    assert code == 0
    assert json.loads(out) == SEARCH_BODY


def test_json_output_of_one_run_is_the_api_body_unchanged(cli, capsys) -> None:
    cli(["run", "TAS-88214", "--output", "json"], RUN_DETAIL)
    out, _ = _read(capsys)

    assert json.loads(out) == RUN_DETAIL


# --- an empty result -------------------------------------------------------------


def test_an_empty_page_says_no_matches(cli, capsys) -> None:
    code, _ = cli(["runs"], EMPTY_PAGE)
    out, _ = _read(capsys)

    assert code == 0
    assert out.strip() == "no matches"


def test_an_empty_search_says_no_matches(cli, capsys) -> None:
    code, _ = cli(["search", "nothing"], {"query": "nothing", "groups": []})
    out, _ = _read(capsys)

    assert code == 0
    assert out.strip() == "no matches"


def test_an_empty_page_still_parses_as_json(cli, capsys) -> None:
    cli(["runs", "--output", "json"], EMPTY_PAGE)
    out, _ = _read(capsys)

    assert json.loads(out)["items"] == []


# --- grouping, the third interface (FR-DM-108) ------------------------------------


GROUP_PAGE = {
    "items": [{"value": "EX90", "count": 12}, {"value": None, "count": 3}],
    "total": 2,
    "page": 1,
    "page_size": 20,
    "total_pages": 1,
}


def test_group_by_reads_the_grouped_route(cli, capsys) -> None:
    code, recorder = cli(["runs", "--group-by", "project"], GROUP_PAGE)
    out, _ = _read(capsys)

    assert code == 0
    assert recorder.requests[0].url.path == "/api/v1/test-runs/groups"
    assert dict(recorder.requests[0].url.params) == {"group_by": "project"}
    assert "value" in out and "count" in out
    assert "EX90" in out and "12" in out


def test_a_group_call_carries_every_filter(cli) -> None:
    # The clause is that a grouped answer and a flat answer agree, so the
    # filters must ride along with the group field.
    _, recorder = cli(["runs", "--group-by", "rig", "--status", "invalid"], GROUP_PAGE)

    params = dict(recorder.requests[0].url.params)
    assert params == {"status": "invalid", "group_by": "rig"}


def test_no_group_by_still_reads_the_flat_list(cli, capsys) -> None:
    _, recorder = cli(["runs"], RUN_PAGE)

    assert recorder.requests[0].url.path == "/api/v1/test-runs"


def test_a_group_field_outside_the_whitelist_never_reaches_the_api(capsys) -> None:
    # argparse refuses it, so the CLI names the three fields itself and the
    # API never sees a fourth.
    with pytest.raises(SystemExit):
        tm.main(["runs", "--group-by", "vehicle"])
    _, err = _read(capsys)
    assert "vehicle" in err


def test_the_test_cell_filter_reaches_the_api(cli) -> None:
    _, recorder = cli(["runs", "--test-cell", "TC-2"], RUN_PAGE)

    assert dict(recorder.requests[0].url.params) == {"test_cell": "TC-2"}


def test_grouped_json_output_is_the_api_body_unchanged(cli, capsys) -> None:
    cli(["runs", "--group-by", "project", "--output", "json"], GROUP_PAGE)
    out, _ = _read(capsys)

    assert json.loads(out) == GROUP_PAGE


def test_a_custom_property_group_reaches_the_api_unchanged(cli) -> None:
    # The third interface takes the same values the route takes, so a person
    # groups by their own criterion from the command line too.
    _, recorder = cli(["runs", "--group-by", "custom:rig-owner"], GROUP_PAGE)

    assert recorder.requests[0].url.path == "/api/v1/test-runs/groups"
    assert dict(recorder.requests[0].url.params) == {"group_by": "custom:rig-owner"}


def test_a_custom_property_group_carries_every_filter(cli) -> None:
    _, recorder = cli(
        ["runs", "--group-by", "custom:rig-owner", "--rig", "RIG-04"], GROUP_PAGE
    )

    assert dict(recorder.requests[0].url.params) == {
        "rig": "RIG-04",
        "group_by": "custom:rig-owner",
    }


def test_an_empty_custom_key_never_reaches_the_api(capsys) -> None:
    with pytest.raises(SystemExit):
        tm.main(["runs", "--group-by", "custom:"])
    _, err = _read(capsys)
    assert "custom:" in err


# --- the failures a person meets --------------------------------------------------


def test_a_refused_token_exits_one_with_no_stack_trace(cli, capsys) -> None:
    code, _ = cli(
        ["runs"],
        {"detail": "invalid or missing token", "code": "unauthorized", "errors": []},
        status=401,
    )
    out, err = _read(capsys)

    assert code == 1
    assert "refused the token" in err
    assert tm.API_TOKEN_VAR in err
    assert "Traceback" not in err and "Traceback" not in out


def test_a_missing_token_exits_one(cli, capsys, monkeypatch) -> None:
    """No token in the environment, and no terminal to ask at."""
    monkeypatch.delenv(tm.API_TOKEN_VAR, raising=False)
    monkeypatch.setattr(tm.sys.stdin, "isatty", lambda: False)

    code, _ = cli(["runs"], RUN_PAGE)
    _, err = _read(capsys)

    assert code == 1
    assert f"Set {tm.API_TOKEN_VAR}" in err


def test_a_missing_base_url_explains_itself(cli, capsys, monkeypatch) -> None:
    monkeypatch.delenv(tm.API_URL_VAR, raising=False)

    code, _ = cli(["runs"], RUN_PAGE)
    _, err = _read(capsys)

    assert code == 1
    assert tm.API_URL_VAR in err
    assert "--api-url" in err
    assert "Traceback" not in err


def test_a_base_url_with_no_scheme_explains_itself(cli, capsys) -> None:
    code, _ = cli(["--api-url", "registry.test", "runs"], RUN_PAGE)
    _, err = _read(capsys)

    assert code == 1
    assert "http://" in err
    assert "Traceback" not in err


def test_an_unreachable_api_explains_itself(cli, capsys, monkeypatch) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("the API is down")

    monkeypatch.setenv(tm.API_URL_VAR, BASE_URL)
    monkeypatch.setenv(tm.API_TOKEN_VAR, TOKEN)
    monkeypatch.setattr(tm, "TRANSPORT", httpx.MockTransport(refuse))

    code = tm.main(["runs"])
    _, err = _read(capsys)

    assert code == 1
    assert "did not answer" in err
    assert "Traceback" not in err


def test_an_unknown_run_explains_itself(cli, capsys) -> None:
    code, _ = cli(["run", "NOPE"], {"detail": "not found", "code": "not_found"}, status=404)
    _, err = _read(capsys)

    assert code == 1
    assert "NOPE" in err
    assert "Traceback" not in err


def test_a_non_json_answer_explains_itself(cli, capsys, monkeypatch) -> None:
    def junk(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>proxy error</html>")

    monkeypatch.setenv(tm.API_URL_VAR, BASE_URL)
    monkeypatch.setenv(tm.API_TOKEN_VAR, TOKEN)
    monkeypatch.setattr(tm, "TRANSPORT", httpx.MockTransport(junk))

    code = tm.main(["runs"])
    _, err = _read(capsys)

    assert code == 1
    assert "no JSON" in err


# --- the token never travels in the open -------------------------------------------


def test_no_option_carries_the_token(capsys) -> None:
    """A command line lands in the shell history and in the process list."""
    parser = tm.build_parser()

    assert "--token" not in parser.format_help()
    for name in ("runs", "files", "signals", "run", "search"):
        with pytest.raises(SystemExit):
            parser.parse_args(["--token", "secret", name])

    _, err = _read(capsys)
    assert "error" in err


def test_the_token_rides_the_authorization_header(cli) -> None:
    _, recorder = cli(["runs"], RUN_PAGE)

    request = recorder.requests[0]
    assert request.headers["authorization"] == f"Bearer {TOKEN}"
    assert TOKEN not in str(request.url)


def test_a_refusal_never_prints_the_token(cli, capsys) -> None:
    cli(["runs"], {"detail": "invalid or missing token"}, status=401)
    out, err = _read(capsys)

    assert TOKEN not in out
    assert TOKEN not in err


# --- the address the deployments state ----------------------------------------------


@pytest.mark.parametrize(
    "given",
    ["http://tm-api", "http://tm-api/", "http://tm-api/api/v1", "http://tm-api/api/v1/"],
)
def test_the_prefix_lands_exactly_once(given: str) -> None:
    """`TM_API_URL` reads both ways across the deployments. Both must work."""
    assert tm.read_base_url(given) == "http://tm-api/api/v1"


# --- FR-DM-111 clause 4: the same query on every interface -----------------------

OPENAPI = json.loads(
    (pathlib.Path(__file__).resolve().parents[1] / "docs" / "openapi.v1.json").read_text(
        encoding="utf-8"
    )
)

# A route takes these four, and no one of them narrows a list. `page` and
# `page_size` ride on every list command already. `sort` and `order` order a
# page, they do not filter it.
NOT_A_FILTER = frozenset({"page", "page_size", "sort", "order"})


def route_filters(path: str) -> set[str]:
    """Return every filter parameter one documented list route takes."""
    parameters = OPENAPI["paths"][f"/api/v1{path}"]["get"]["parameters"]
    return {item["name"] for item in parameters} - NOT_A_FILTER


@pytest.mark.parametrize("command", sorted(tm.LIST_COMMANDS))
def test_the_cli_names_every_filter_its_route_takes(command: str) -> None:
    """The fourth acceptance clause: the query is the same on all interfaces.

    The API and the UI carried five signal filters and the CLI carried four, so
    the clause failed. This test fails again the day a route grows a filter and
    `LIST_COMMANDS` keeps the old list.
    """
    spec = tm.LIST_COMMANDS[command]
    assert set(spec.filters) == route_filters(spec.path)


@pytest.mark.parametrize(
    ("argv", "expected"),
    [
        # `69eda20` gave `GET /signals` these two. The CLI took neither.
        (["signals", "--dtype", "float32"], {"dtype": "float32"}),
        (["signals", "--source-system", "INCA"], {"source_system": "INCA"}),
        # `b9d78da` gave the four list routes `source` (TR-011).
        (["signals", "--source", "manual"], {"source": "manual"}),
        (["files", "--source", "embedded"], {"source": "embedded"}),
        (["runs", "--source", "api:planning"], {"source": "api:planning"}),
        # The two boolean filters. The word rides as a string and the API reads it.
        (["signals", "--missing-unit", "true"], {"missing_unit": "true"}),
        (["files", "--unlinked", "true"], {"unlinked": "true"}),
    ],
)
def test_a_new_filter_reaches_the_api_under_its_own_name(cli, argv, expected) -> None:
    """The option name dashes the parameter name, and nothing else changes."""
    _, recorder = cli(argv, EMPTY_PAGE)

    assert dict(recorder.requests[0].url.params) == expected


def test_the_two_signal_filters_ride_together(cli) -> None:
    """The signals screen mounts a Data type filter beside a Source system one.

    A person must be able to ask the same question at the command line.
    """
    _, recorder = cli(["signals", "--dtype", "float32", "--source-system", "INCA"], SIGNAL_PAGE)

    params = dict(recorder.requests[0].url.params)
    assert params == {"dtype": "float32", "source_system": "INCA"}


def test_an_underscore_option_name_is_refused(cli, capsys) -> None:
    """Every filter option dashes its name. `--source_system` is not an option."""
    with pytest.raises(SystemExit):
        tm.build_parser().parse_args(["signals", "--source_system", "INCA"])


# --- FR-DM-095: the output shape follows the command ------------------------------

# The three fields a CSV writer must not break: a comma, a quote and a line
# break inside one value, and a value that is not there at all.
AWKWARD_PAGE = {
    "items": [
        {
            "run_id": "TAS-1",
            "status": 'brake, "wet"',
            "project": "line one\nline two",
            "rig_id": None,
            "file_count": 0,
            "signal_count": 2,
        }
    ],
    "total": 1,
}


def _rows(out: str) -> list[list[str]]:
    """Read the printed CSV back. A quoted line break stays inside its field."""
    return list(csv.reader(io.StringIO(out)))


def test_csv_output_prints_a_header_row_and_the_rows(cli, capsys) -> None:
    code, _ = cli(["runs", "--output", "csv"], RUN_PAGE)
    out, _ = _read(capsys)

    assert code == 0
    assert _rows(out) == [
        ["run_id", "status", "project", "rig_id", "file_count", "signal_count"],
        ["TAS-88214", "complete", "EX90", "RIG-7", "3", "12"],
    ]


def test_the_csv_header_is_the_table_header(cli, capsys) -> None:
    """One column tuple feeds both renderers. Neither may grow a column alone."""
    cli(["files", "--output", "csv"], FILE_PAGE)
    out, _ = _read(capsys)

    assert _rows(out)[0] == list(tm.LIST_COMMANDS["files"].columns)


def test_a_csv_field_survives_a_comma_a_quote_and_a_newline(cli, capsys) -> None:
    cli(["runs", "--output", "csv"], AWKWARD_PAGE)
    out, _ = _read(capsys)

    row = _rows(out)[1]
    assert row[1] == 'brake, "wet"'
    assert row[2] == "line one\nline two"


def test_a_csv_field_with_nothing_in_it_stays_empty(cli, capsys) -> None:
    """The table prints a dash for an empty value. That glyph is not data."""
    cli(["runs", "--output", "csv"], AWKWARD_PAGE)
    out, _ = _read(capsys)

    assert _rows(out)[1][3] == ""
    assert "-" not in _rows(out)[1]


def test_a_zero_stays_a_zero_in_csv(cli, capsys) -> None:
    """`file_count` of 0 is a value, not an absent field."""
    cli(["runs", "--output", "csv"], AWKWARD_PAGE)
    out, _ = _read(capsys)

    assert _rows(out)[1][4] == "0"


def test_an_empty_csv_page_still_prints_the_header(cli, capsys) -> None:
    """A script that reads the file always finds the columns."""
    code, _ = cli(["runs", "--output", "csv"], EMPTY_PAGE)
    out, _ = _read(capsys)

    assert code == 0
    assert _rows(out) == [["run_id", "status", "project", "rig_id", "file_count", "signal_count"]]


def test_csv_carries_no_count_sentence(cli, capsys) -> None:
    """The table ends with `1 of 1`. A CSV file holds rows only."""
    cli(["runs", "--output", "csv"], RUN_PAGE)
    out, _ = _read(capsys)

    assert "1 of 1" not in out
    assert len(_rows(out)) == 2


def test_a_grouped_command_prints_csv(cli, capsys) -> None:
    """A grouped call hands the grouped columns to the same renderer."""
    code, recorder = cli(["runs", "--group-by", "project", "--output", "csv"], GROUP_PAGE)
    out, _ = _read(capsys)

    assert code == 0
    assert recorder.requests[0].url.path == "/api/v1/test-runs/groups"
    assert _rows(out) == [["value", "count"], ["EX90", "12"], ["", "3"]]


def test_one_run_prints_csv_the_shape_of_the_list(cli, capsys) -> None:
    """`tm run` writes the field names across the top, so one run is one row."""
    cli(["run", "TAS-88214", "--output", "csv"], RUN_DETAIL)
    out, _ = _read(capsys)

    assert _rows(out) == [
        ["run_id", "project", "invalid", "operator"],
        ["TAS-88214", "EX90", "no", ""],
    ]


def test_search_csv_names_the_type_in_the_first_column(cli, capsys) -> None:
    """One file holds one table, so the type of the hit becomes a column."""
    cli(["search", "rig-7", "--output", "csv"], SEARCH_BODY)
    out, _ = _read(capsys)

    assert _rows(out) == [
        ["type", "id", "sub", "status"],
        ["runs", "TAS-88214", "EX90", "complete"],
    ]


def test_csv_escapes_the_way_the_server_export_escapes(capsys) -> None:
    """Two exports of the same data must not disagree.

    `api.services.exports` writes the CSV of the three list screens. This walks
    the same values through both writers and compares the text. Only the line
    ending differs, and the comment on `tm._csv` says why.
    """
    from api.services import exports

    values = ['brake, "wet"', "line one\nline two", "", "plain"]
    headers = [f"c{index}" for index in range(len(values))]
    row = dict(zip(headers, values, strict=True))
    columns = tuple(exports.Column(name, lambda doc, key=name: doc[key]) for name in headers)
    server = b"".join(exports._csv_bytes(columns, [row])).decode("utf-8")

    mine = tm._csv([headers, values])

    assert mine == server.replace("\r\n", "\n").removesuffix("\n")


def test_the_table_still_prints_a_dash_for_an_empty_value() -> None:
    """The CSV rule must not leak into the table a person reads."""
    printed = tm.render_page(GROUP_PAGE, tm.GROUP_COLUMNS)

    assert "-" in printed
    assert printed.endswith("2 of 2")


def test_an_unknown_output_shape_is_refused(capsys) -> None:
    with pytest.raises(SystemExit):
        tm.build_parser().parse_args(["runs", "--output", "yaml"])
    _, err = _read(capsys)
    assert "yaml" in err
