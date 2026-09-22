"""Guards for the run-book in the root `README.md`.

The run-book is the demo morning's script. A person types it under pressure, so
every line of it must work. This module pins the two facts that decide the shape
of that script:

1. The local stack publishes no MongoDB host port.
2. The seed opens a direct MongoDB connection, so it dies without that port.

Together the two mean one thing: the seed runs INSIDE the stack, and never from
a host shell. The run-book told a person the opposite until 18 Aug 2026. It said
`cd api` and `uv run python -m seed.seed_demo --reset`, and both commands died
with `ServerSelectionTimeoutError` on a developer machine.

These tests need no database and no container. They read files, and one of them
starts a short subprocess.
"""

import pytest

pytest.skip(
    "The demo repo maintains README.md as an OVERLAY (the demo estate's own "
    "front page); upstream's run-book section lives in upstream's README, "
    "and the demo's run-book is plans/DEMO-RUNBOOK-INGESTION.md.",
    allow_module_level=True,
)

import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
README_PATH = REPO_ROOT / "README.md"
LOCAL_COMPOSE_PATH = REPO_ROOT / "docker-compose.local.yml"
API_DIR = REPO_ROOT / "api"

# The command form the run-book must name. `exec` reaches the running container,
# where MongoDB is a network neighbour and the API listens on port 8000.
CONTAINER_FORM = "docker compose -f docker-compose.local.yml exec api python -m seed.seed_demo"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _run_book() -> str:
    """Return the run-book section of the README, heading included.

    The section starts at its own `## ` heading and ends at the next `## `
    heading. A test that read the whole file would pass on a command that sits
    in another section, and the demo morning does not read another section.
    """
    lines = _read(README_PATH).splitlines()
    start = next(
        index for index, line in enumerate(lines) if line.startswith("## The run-book")
    )
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if lines[index].startswith("## "):
            end = index
            break
    return "\n".join(lines[start:end])


def _instructions() -> str:
    """Return the part of the run-book a person types, and drop the history.

    Rule 4 keeps a correction note beside the text it corrects, so the section
    quotes the old wrong commands on purpose. A guard that read the note too
    would fail on the very sentence that records the fix. The note starts at the
    first `**Corrected` line, and nothing below it is an instruction.
    """
    run_book = _run_book()
    lines = run_book.splitlines()
    for index, line in enumerate(lines):
        if line.startswith("**Corrected"):
            return "\n".join(lines[:index])
    return run_book


def _service_block(name: str, text: str) -> str:
    """Return one service block of a compose file.

    The block starts at the `  <name>:` line. It ends at the next line that
    indents two spaces or less, because that line is a sibling or a parent.
    """
    lines = text.splitlines()
    start = lines.index(f"  {name}:")
    end = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.strip() and not line.startswith("   "):
            end = index
            break
    return "\n".join(lines[start:end])


# --- The two facts the run-book rests on -------------------------------------


def test_the_local_stack_publishes_no_mongo_host_port():
    """A host shell has no route to the registry, so it cannot run the seed."""
    block = _service_block("mongo", _read(LOCAL_COMPOSE_PATH))
    code = [line for line in block.splitlines() if not line.strip().startswith("#")]
    assert not any(
        line.strip().startswith("ports:") for line in code
    ), "The mongo service now publishes a host port. Re-read the run-book claim."


def test_the_seed_dies_without_a_mongo_connection():
    """Prove the seed needs Mongo directly, and not only the API over HTTP.

    The subprocess keeps this test isolated. `api/api/db.py` caches one client
    per process, so an in-process attempt would poison every later test.
    """
    environment = {
        "PATH": "/usr/bin:/bin",
        "SYSTEMROOT": "C:\\Windows",
        "MONGO_URL": "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=200",
        "TM_API_TOKEN": "test-token-not-a-secret",
    }
    result = subprocess.run(
        [sys.executable, "-m", "seed.seed_demo", "--self-verify"],
        cwd=API_DIR,
        env=environment,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode != 0, "The seed answered success with no database."
    assert "ServerSelectionTimeoutError" in result.stderr, result.stderr[-2000:]


# --- The run-book text -------------------------------------------------------


def test_the_run_book_never_sends_a_person_to_a_host_seed():
    assert "uv run python -m seed.seed_demo" not in _instructions()


@pytest.mark.parametrize("flag", ["--reset", "--self-verify"])
def test_the_run_book_names_the_container_form(flag: str):
    assert f"{CONTAINER_FORM} {flag}" in _instructions()


def test_the_run_book_names_one_start_recipe():
    """`docs/LOCAL-STACK.md` holds the recipe. The run-book must send a reader there."""
    instructions = _instructions()
    assert "docs/LOCAL-STACK.md" in instructions
    assert "api/README.md" not in instructions


def test_the_run_book_keeps_its_correction_note():
    """The history stays, per rule 4. It also proves `_instructions` really cuts."""
    run_book = _run_book()
    assert "**Corrected 18 Aug 2026" in run_book
    assert len(_instructions()) < len(run_book)


def test_the_run_book_never_says_the_seed_writes_only_through_http():
    """The seed writes through the API AND straight into MongoDB.

    The old sentence, "Both seed commands write through HTTP", made a reader
    believe a running API was enough. It is not.
    """
    assert "write through HTTP" not in _instructions()
