"""Guards for the developer start scripts' default port. This file is UTF-8.

Port 8000 belongs to another server on the build machine. Port 3000 belongs to
Grafana. So no developer command in this repository may default to either one.
`api/README.md` sends the reader to `http://localhost:8010/docs`, and these
scripts must agree with that document.

The port the scripts pick is 8010, which is also the local stack's API host
port, so `docker compose -f docker-compose.local.yml up` and `scripts/dev.ps1`
cannot run at the same time.

`api/seed/seed_demo.py` keeps `http://localhost:8000` on purpose. The run-book
runs the seed INSIDE the api container, where the API really listens on 8000.
Only the HOST port is 8010, so that default is correct and no test here reads it.

These tests read repository files as text. No test here needs a database, a
container or a network.
"""

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "api" / "scripts"

DEV_SCRIPTS = ("dev.ps1", "dev.sh")

# The two host ports another program already holds on the build machine.
TAKEN_HOST_PORTS = ("8000", "3000")

# The port both scripts must pick, and the port `api/README.md` names.
EXPECTED_PORT = "8010"

OVERRIDE_VARIABLE = "TM_API_PORT"


def _read(name: str) -> str:
    path = SCRIPTS_DIR / name
    assert path.is_file(), f"{path} is missing"
    return path.read_text(encoding="utf-8")


def test_both_dev_scripts_exist():
    """A parse that finds nothing would make every rule below pass on nothing."""
    for name in DEV_SCRIPTS:
        assert _read(name).strip(), f"{name} is empty"


@pytest.mark.parametrize("name", DEV_SCRIPTS)
@pytest.mark.parametrize("port", TAKEN_HOST_PORTS)
def test_no_dev_script_names_a_taken_port(name, port):
    """Another server holds 8000 on the build machine, and Grafana holds 3000.

    The search uses a digit boundary, so 8010 never matches 8000 by accident.
    """
    assert not re.search(rf"(?<!\d){port}(?!\d)", _read(name)), (
        f"api/scripts/{name} still names the taken port {port}"
    )


@pytest.mark.parametrize("name", DEV_SCRIPTS)
def test_every_dev_script_defaults_to_the_documented_port(name):
    """`api/README.md` sends the reader to http://localhost:8010/docs."""
    assert re.search(rf"(?<!\d){EXPECTED_PORT}(?!\d)", _read(name)), (
        f"api/scripts/{name} names no default port {EXPECTED_PORT}"
    )


@pytest.mark.parametrize("name", DEV_SCRIPTS)
def test_every_dev_script_still_honours_the_port_override(name):
    """A developer must move the port without editing the script.

    This stops the fix becoming a new hard-coded number.
    """
    assert OVERRIDE_VARIABLE in _read(name), (
        f"api/scripts/{name} reads no {OVERRIDE_VARIABLE}"
    )


def test_the_powershell_script_reads_the_override_from_the_environment():
    """PowerShell reads an environment variable as `$env:NAME`, never as `$NAME`."""
    assert f"$env:{OVERRIDE_VARIABLE}" in _read("dev.ps1")


def test_the_shell_script_defaults_the_override_in_place():
    """`${NAME:-default}` gives the shell script one default and one override."""
    assert f"${{{OVERRIDE_VARIABLE}:-{EXPECTED_PORT}}}" in _read("dev.sh")
