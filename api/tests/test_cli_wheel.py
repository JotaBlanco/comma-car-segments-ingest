"""`GET /cli/<wheel>` — the API serves its own command line.

The `tm` command line lived inside the API image and nowhere else, so a Volvo
engineer could not get it. This route ends that: the image builds the wheel
(`api/Dockerfile`) and streams it, so one `pip install` line against the
deployment they already use installs `tm`.

The route is OPEN, beside `/health`, `/ready` and `/metrics`. `pip` presents no
bearer token, so a route behind the token gate can never be installed from. It
opens nothing new: the wheel holds `cli/__init__.py` and `cli/tm.py`, the same
two files the image already carries, and no secret, no credential and no
customer data.

These tests hold four things:

1. The route serves the bytes, with the right filename and the right type.
2. It needs no token.
3. A process with no wheel answers 404 `wheel_not_found`, and never 500. That
   is what every developer machine sees, because nobody builds a wheel to run
   the API locally.
4. The served name still matches `pyproject.toml`, so a version bump cannot
   leave `pip` reading a name the wheel does not carry.
"""

import pathlib
import tomllib

from api import main

WHEEL_BYTES = b"PK\x03\x04 not a real wheel, but the route never opens it"

PYPROJECT = pathlib.Path(__file__).parent.parent / "pyproject.toml"


def _serve_from(monkeypatch, directory: pathlib.Path) -> None:
    """Point the route at `directory`. The handler reads the module global."""
    monkeypatch.setattr(main, "CLI_WHEEL_DIR", directory)


def test_the_wheel_streams_with_its_filename_and_type(bare_client, monkeypatch, tmp_path):
    (tmp_path / main.CLI_WHEEL_NAME).write_bytes(WHEEL_BYTES)
    _serve_from(monkeypatch, tmp_path)

    response = bare_client.get(f"/cli/{main.CLI_WHEEL_NAME}")

    assert response.status_code == 200
    assert response.content == WHEEL_BYTES
    assert response.headers["content-type"] == "application/octet-stream"
    # `pip` reads the name off the URL, and a browser reads it off this header.
    # Both must state the wheel name exactly.
    assert main.CLI_WHEEL_NAME in response.headers["content-disposition"]
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["content-length"] == str(len(WHEEL_BYTES))


def test_the_route_needs_no_token(bare_client, monkeypatch, tmp_path):
    """`bare_client` sends no Authorization header. `pip` cannot send one."""
    (tmp_path / main.CLI_WHEEL_NAME).write_bytes(WHEEL_BYTES)
    _serve_from(monkeypatch, tmp_path)

    assert bare_client.get(f"/cli/{main.CLI_WHEEL_NAME}").status_code == 200
    # The gate that must not move: an /api/v1 route still refuses the same
    # client.
    assert bare_client.get("/api/v1/test-runs").status_code == 401


def test_a_missing_wheel_answers_404_with_the_stated_code(
    bare_client, monkeypatch, tmp_path
):
    _serve_from(monkeypatch, tmp_path)  # An empty directory. No wheel was built.

    response = bare_client.get(f"/cli/{main.CLI_WHEEL_NAME}")

    assert response.status_code == 404
    body = response.json()
    assert body["code"] == "wheel_not_found"
    assert body["errors"] == []
    assert main.CLI_WHEEL_NAME in body["detail"]


def test_an_unknown_path_under_cli_answers_404(bare_client):
    """The route is one literal path, so no name can walk out of the directory."""
    assert bare_client.get("/cli/../api/main.py").status_code == 404
    assert bare_client.get("/cli/anything-else.whl").status_code == 404


def test_the_served_name_matches_the_project(bare_client):
    """A version bump must not leave `pip` reading a stale name.

    `pip` refuses a wheel whose metadata states a name other than the one on
    the URL. `CLI_WHEEL_NAME` and the install line in the OpenAPI description
    both state that name, so this test reads the source of truth.
    """
    project = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"]
    distribution = project["name"].replace("-", "_")
    expected = f"{distribution}-{project['version']}-py3-none-any.whl"

    assert main.CLI_WHEEL_NAME == expected


def test_the_install_line_is_in_the_open_document(bare_client):
    """A person who opens `/docs` finds the one line they must run."""
    description = bare_client.get("/openapi.json").json()["info"]["description"]

    assert f"/cli/{main.CLI_WHEEL_NAME}" in description
    assert "pip install" in description
