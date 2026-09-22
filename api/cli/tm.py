"""`tm` — the Test Manager command line (FR-DM-107).

The workbook asks for the same metadata through three interfaces: the UI, the
API and a CLI. The UI and the API ship. This module is the third one, and it
is a thin client over the API the other two already use. It runs no query of
its own, so the second acceptance clause — "the same metadata structure is
delivered across all interfaces" — holds by construction. `--output json`
prints the API body unchanged.

Five commands: `runs`, `run`, `files`, `signals` and `search`. Each one maps
to one documented route in `api/docs/openapi.v1.json`.

`tm runs --group-by project` reads the grouped route instead, so the third
interface answers the FR-DM-108 clause "grouped data is reflected
consistently in UI, API, and CLI". It still runs no query of its own.

`--output` picks the shape (FR-DM-095): `table` for a person, `json` for a
script, `csv` for a spreadsheet. Every shape walks the same column tuple, and
`csv` keeps the rules of the server export (`api/api/services/exports.py`), so
a row of `tm runs --output csv` reads like the same row of the export route.

**The token never rides the command line.** A command line lands in the shell
history and in the process list, so this module reads `TM_API_TOKEN` from the
environment, and it asks at a terminal when the variable is empty. It never
prints the token, and it never writes the token into a URL.

Every expected failure prints one line and returns 1. A missing address, a
refused token and an unreachable API each name the fix. No stack trace.
"""

import argparse
import contextlib
import csv
import getpass
import io
import json
import os
import sys

import httpx

API_URL_VAR = "TM_API_URL"
API_TOKEN_VAR = "TM_API_TOKEN"

# Every route lives under this prefix. A deployment states `TM_API_URL` both
# ways — `http://tm-api` in `app.yaml`, `http://api:8000/api/v1` in compose —
# so the address reader accepts both and appends the prefix exactly once.
PATH_PREFIX = "/api/v1"

TIMEOUT_SECONDS = 30.0

# A test replaces this with an `httpx.MockTransport`, so no test opens a
# socket — the same pattern as `api.quix_identity.TRANSPORT`.
TRANSPORT: httpx.BaseTransport | None = None


class CliError(Exception):
    """An expected failure. `main` prints it and returns 1."""


class ListCommand:
    """One list route, its filters and the columns the table shows.

    `group_by` names the fixed fields the route can group by, or nothing when
    the route serves no grouped answer. A grouped call reads `<path>/groups`
    and prints the group value and the run count (contract §2c, FR-DM-108).

    A route that takes fixed names also takes `custom:<property key>`, so the
    command line offers exactly what the route offers.
    """

    def __init__(
        self,
        path: str,
        filters: tuple[str, ...],
        columns: tuple[str, ...],
        group_by: tuple[str, ...] = (),
    ):
        self.path = path
        self.filters = filters
        self.columns = columns
        self.group_by = group_by


# The grouped answer names the group and counts its runs, so two columns
# say everything. The API sorts them, biggest group first.
GROUP_COLUMNS = ("value", "count")

# Contract §2c: the prefix that names a custom property as the grouping
# criterion. It must stay the same spelling the API reads
# (`api.models.runs.CUSTOM_GROUP_PREFIX`), so `tm` and the route take one set
# of values. The API owns the key rules; this checks the shape only, so a typed
# `custom:` with nothing after it fails here instead of over the network.
CUSTOM_GROUP_PREFIX = "custom:"


def _group_by_value(names: tuple[str, ...]):
    """Read a `--group-by` value: a fixed name, or `custom:<property key>`.

    `choices` cannot express the second half, because the key is whatever a
    person typed into the run metadata dialog. This keeps the same refusal
    message shape argparse gives for `choices`.
    """

    def parse(value: str) -> str:
        if value in names:
            return value
        if value.startswith(CUSTOM_GROUP_PREFIX) and value[len(CUSTOM_GROUP_PREFIX) :].strip():
            return value
        raise argparse.ArgumentTypeError(
            f"invalid choice: {value!r} (choose from "
            + ", ".join(repr(name) for name in names)
            + f", or {CUSTOM_GROUP_PREFIX}<property key>)"
        )

    return parse

# The fourth acceptance clause of FR-DM-111 reads "query functionality is
# consistent across all interfaces". So each tuple below names every filter its
# route takes, in the route's own order, and it drops nothing. Read the route's
# parameter list in `api/docs/openapi.v1.json` before you edit a tuple.
#
# `page`, `page_size`, `sort` and `order` are not filters. `_params` adds the
# two page keys to every list command.
#
# A boolean filter — `unlinked`, `missing_unit` — takes the word on the command
# line: `tm files --unlinked true`. The value rides to the API as a string and
# the API reads it as a boolean, so no filter needs a shape of its own.
LIST_COMMANDS = {
    "runs": ListCommand(
        "/test-runs",
        (
            "status",
            "rig",
            "project",
            "test_cell",
            "definition",
            "work_order",
            "signal",
            "source",
            "q",
        ),
        ("run_id", "status", "project", "rig_id", "file_count", "signal_count"),
        group_by=("project", "test_cell", "rig"),
    ),
    "files": ListCommand(
        "/files",
        ("status", "source_system", "lifecycle", "run", "unlinked", "invalid", "source", "q"),
        ("file_id", "filename", "run_id", "source_system", "format", "status"),
    ),
    "signals": ListCommand(
        "/signals",
        ("unit", "missing_unit", "rig", "rate", "dtype", "source_system", "source", "q"),
        ("name", "unit", "dtype", "typical_rate_hz", "run_count"),
    ),
}

SEARCH_COLUMNS = ("id", "sub", "status")


# --- the address and the token -------------------------------------------------


def read_base_url(given: str | None) -> str:
    """Return the API root, prefix included. Raise when the address is unusable."""
    url = (given or os.environ.get(API_URL_VAR, "")).strip().rstrip("/")
    if not url:
        raise CliError(
            f"no API address. Set {API_URL_VAR}, or pass --api-url "
            f"(for example --api-url http://localhost:8000)."
        )
    if not url.startswith(("http://", "https://")):
        raise CliError(
            f"the API address must start with http:// or https://. {API_URL_VAR} holds {url!r}."
        )
    return url.removesuffix(PATH_PREFIX) + PATH_PREFIX


def read_token() -> str:
    """Read the bearer token from the environment, or ask for it at a terminal.

    There is no `--token` option on purpose. See the module docstring.
    """
    token = os.environ.get(API_TOKEN_VAR, "").strip()
    if not token and sys.stdin.isatty():
        token = getpass.getpass(f"{API_TOKEN_VAR}: ").strip()
    if not token:
        raise CliError(f"no token. Set {API_TOKEN_VAR} in the environment.")
    return token


# --- the one call --------------------------------------------------------------


def fetch(base_url: str, token: str, path: str, params: dict) -> dict:
    """Read one route and return its JSON body."""
    try:
        with httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=TIMEOUT_SECONDS,
            transport=TRANSPORT,
        ) as client:
            response = client.get(path, params=params)
    except httpx.HTTPError as error:
        # The message names the address and the variable, never the token.
        raise CliError(
            f"the API at {base_url} did not answer ({type(error).__name__}). "
            f"Check {API_URL_VAR}, and check that the API runs."
        ) from None

    if response.status_code == 401:
        raise CliError(
            f"the API refused the token. Set a valid {API_TOKEN_VAR} in the environment."
        )
    if response.status_code == 404:
        raise CliError(f"the API has nothing at {path}. Check the identifier you gave.")
    if response.status_code >= 400:
        raise CliError(f"the API answered {response.status_code}: {_detail(response)}")

    try:
        return response.json()
    except ValueError:
        raise CliError(
            f"the API at {base_url} answered no JSON. Check that {API_URL_VAR} "
            f"names the API and not a proxy."
        ) from None


def _detail(response: httpx.Response) -> str:
    """Read the contract error body, and fall back to the raw text."""
    try:
        body = response.json()
    except ValueError:
        return response.text.strip()[:200] or "no body"
    if isinstance(body, dict) and body.get("detail"):
        return str(body["detail"])
    return response.text.strip()[:200]


# --- the table and the CSV -----------------------------------------------------


def _cell(value, absent: str = "-") -> str:
    """Render one value as one field. `absent` is what an empty value prints.

    A table prints a dash, so a person sees the hole. A CSV field stays empty,
    because that glyph must never reach a spreadsheet — the server export
    states the same rule (`api.services.exports._text`).
    """
    if value is None:
        return absent
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, list):
        return ", ".join(str(item) for item in value)
    return str(value)


def _table(rows: list[list[str]]) -> list[str]:
    """Lay out rows in columns. The first row is the header."""
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    return ["  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip() for row in rows]


def _csv(rows: list[list[str]]) -> str:
    """Write the rows as CSV, the way the server export writes them.

    `csv` from the standard library owns the escaping, so a field that carries
    a comma, a quote or a line break travels exactly as it travels out of
    `api.services.exports._csv_bytes`: RFC 4180 quoting, an inner quote
    doubled, and an empty field left empty.

    The one difference is the line ending, and the stream forces it. That
    module writes bytes, so it states `\\r\\n` itself. This one writes text to
    standard output, and a text stream on Windows turns a written `\\r\\n` into
    `\\r\\r\\n`. So each row ends with `\\n` here and the stream adds the ending
    of the platform: `\\r\\n` in a redirected file on Windows, `\\n` elsewhere.
    """
    out = io.StringIO()
    csv.writer(out, lineterminator="\n").writerows(rows)
    # `main` prints the answer, and that print writes the last ending.
    return out.getvalue().removesuffix("\n")


def render_page(body: dict, columns: tuple[str, ...], output: str = "table") -> str:
    items = body.get("items") or []
    if not items and output != "csv":
        return "no matches"
    absent = "" if output == "csv" else "-"
    rows = [list(columns)] + [[_cell(item.get(name), absent) for name in columns] for item in items]
    if output == "csv":
        # The header row travels even when nothing matched, so a script that
        # reads the file always finds the columns. The count line stays out: it
        # is a sentence for a person, and a CSV file holds rows only.
        return _csv(rows)
    lines = _table(rows)
    lines.append(f"\n{len(items)} of {body.get('total', len(items))}")
    return "\n".join(lines)


def render_search(body: dict, output: str = "table") -> str:
    groups = [group for group in (body.get("groups") or []) if group.get("items")]
    if output == "csv":
        # A search answers one table per type, and one file holds one table.
        # The type becomes the first column, so every hit still fits one file.
        return _csv(
            [["type", *SEARCH_COLUMNS]]
            + [
                [group.get("type", "?")] + [_cell(item.get(name), "") for name in SEARCH_COLUMNS]
                for group in groups
                for item in group["items"]
            ]
        )
    if not groups:
        return "no matches"
    blocks = []
    for group in groups:
        items = group["items"]
        rows = [list(SEARCH_COLUMNS)] + [
            [_cell(item.get(name)) for name in SEARCH_COLUMNS] for item in items
        ]
        blocks.append(f"{group.get('type', '?')} ({len(items)})\n" + "\n".join(_table(rows)))
    return "\n\n".join(blocks)


def render_detail(body: dict, output: str = "table") -> str:
    if not body:
        return "no matches"
    if output == "csv":
        # The field names ride across the top and the run rides under them, so
        # one run out of `tm run` reads like one row out of `tm runs`.
        return _csv([list(body), [_cell(value, "") for value in body.values()]])
    return "\n".join(_table([[name, _cell(value)] for name, value in body.items()]))


# --- the parser ----------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument(
        "--api-url",
        default=argparse.SUPPRESS,
        help=f"The API address. It defaults to {API_URL_VAR}.",
    )
    shared.add_argument(
        "--output",
        choices=("table", "json", "csv"),
        default=argparse.SUPPRESS,
        help="table for a person, json for a script, csv for a spreadsheet. Default: table.",
    )

    parser = argparse.ArgumentParser(
        prog="tm",
        parents=[shared],
        description=(
            "Read Test Manager metadata from the command line. The token comes from "
            f"{API_TOKEN_VAR}, never from an option."
        ),
    )
    # `parents` shares one action object between the main parser and every
    # subparser, so a default set here would also become the subparser's
    # default and would overwrite a value the user gave before the subcommand.
    # Both options therefore suppress their default, and `run_command` reads
    # the fallback with `getattr`.
    commands = parser.add_subparsers(dest="command", required=True)

    for name, spec in LIST_COMMANDS.items():
        sub = commands.add_parser(name, parents=[shared], help=f"List {name} and their metadata.")
        for filter_name in spec.filters:
            sub.add_argument(f"--{filter_name.replace('_', '-')}", help="Filter the list.")
        if spec.group_by:
            sub.add_argument(
                "--group-by",
                type=_group_by_value(spec.group_by),
                metavar="{" + ",".join(spec.group_by) + f",{CUSTOM_GROUP_PREFIX}<key>" + "}",
                help=(
                    "Count the rows by one field instead of listing them. "
                    f"{CUSTOM_GROUP_PREFIX}<key> counts by a custom property."
                ),
            )
        sub.add_argument("--page", type=int, help="The page number. It starts at 1.")
        sub.add_argument("--page-size", type=int, help="How many rows one page holds.")

    run = commands.add_parser("run", parents=[shared], help="Show the metadata of one test run.")
    run.add_argument("run_id", help="The run identifier, for example TAS-88214.")

    search = commands.add_parser(
        "search", parents=[shared], help="Search runs, files and signals with one word."
    )
    search.add_argument("query", help="The word to search for.")

    return parser


def _params(args: argparse.Namespace, spec: ListCommand) -> dict:
    names = spec.filters + ("page", "page_size")
    if spec.group_by:
        names += ("group_by",)
    return {name: getattr(args, name) for name in names if getattr(args, name, None) is not None}


def run_command(args: argparse.Namespace) -> str:
    output = getattr(args, "output", "table")
    base_url = read_base_url(getattr(args, "api_url", None))
    token = read_token()

    if args.command in LIST_COMMANDS:
        spec = LIST_COMMANDS[args.command]
        params = _params(args, spec)
        # `--group-by` switches the route, and every filter rides along, so
        # the counts belong to the same rows the plain list would print.
        grouped = "group_by" in params
        path = f"{spec.path}/groups" if grouped else spec.path
        body = fetch(base_url, token, path, params)
        # One column tuple, three shapes. A grouped call hands the grouped
        # columns to the same renderer, so `--output csv` groups too.
        rendered = render_page(body, GROUP_COLUMNS if grouped else spec.columns, output)
    elif args.command == "run":
        body = fetch(base_url, token, f"/test-runs/{args.run_id}", {})
        rendered = render_detail(body, output)
    else:
        body = fetch(base_url, token, "/search", {"q": args.query})
        rendered = render_search(body, output)

    # `json` prints the API body unchanged. That is the proof of the second
    # acceptance clause: the CLI adds no shape of its own.
    return json.dumps(body, indent=2) if output == "json" else rendered


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    # The server export writes UTF-8, and a redirected standard output on
    # Windows takes the ANSI code page instead, so a signal name outside that
    # page would raise. Ask for UTF-8. A stream that cannot change keeps what
    # it has.
    with contextlib.suppress(AttributeError, ValueError):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(run_command(args))
    except CliError as error:
        print(f"tm: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
