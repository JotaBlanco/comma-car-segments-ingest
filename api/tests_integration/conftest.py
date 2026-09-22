# Stack-level integration harness: the REAL compose stack, not TestClient.
#
# The in-process suite (tests/) cannot see a wrong Dockerfile, a broken
# compose service or a cross-container network problem — the 17 Aug review
# smoke found exactly those. This harness automates that smoke: build the
# images, start mongo + api + mock-planning, and let the tests talk to the
# stack the way the demo does — over HTTP, with the seed run inside the
# container per the run-book.
#
# Not collected by a plain `pytest` run (`testpaths = ["tests"]`). Run it on
# purpose, with Docker up:
#
#     uv run pytest tests_integration -q
#
# One stack per session. The project name is random, so a run never collides
# with a developer's own `docker compose up`, and teardown removes the stack
# and its volume.

import os
import shutil
import socket
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

TEST_TOKEN = "integration-token-not-a-secret"

# The api service requires the lake variables at compose time. The values are
# dummies, and no test here calls a statistics route. The seed runs with the
# lake variables cleared (see `Stack.seed`) so it takes the graceful no-lake
# path instead of dialling a dead URL. A statistics route would answer 503
# `lake_unavailable` on this stack, which is the honest answer.
_COMPOSE_ENV = {
    "TM_MONGO_USER": "tm-integration",
    "TM_MONGO_PASSWORD": "tm-integration-local-only",
    "TM_API_TOKEN": TEST_TOKEN,
    "Quix__Lakehouse__Query__Url": "http://localhost:1",
    "Quix__Lakehouse__Query__AuthToken": "dummy-not-a-secret",
}

_STARTUP_TIMEOUT_SECONDS = 180.0
_HTTP_TIMEOUT_SECONDS = 30.0


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _docker_is_up() -> bool:
    if shutil.which("docker") is None:
        return False
    probe = subprocess.run(
        ["docker", "info"], capture_output=True, text=True, timeout=30, check=False
    )
    return probe.returncode == 0


@dataclass
class Stack:
    """One running compose stack, and the ways the tests talk to it."""

    project: str
    api_url: str
    mock_url: str
    token: str
    env: dict

    def compose(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["docker", "compose", "-p", self.project, *args],
            cwd=REPO_ROOT,
            env={**os.environ, **self.env},
            capture_output=True,
            text=True,
            timeout=600,
            check=check,
        )

    def seed(self, *args: str) -> subprocess.CompletedProcess:
        """Run the seed inside the api container, the run-book's way.

        The lake variables are cleared so the seed takes its no-lake path —
        the stack's dummy URL would otherwise crash the inventory half
        (STATUS.md, open item 7).
        """
        return self.compose(
            "exec",
            "-T",
            "-e",
            "Quix__Lakehouse__Query__Url=",
            "-e",
            "Quix__Lakehouse__Query__AuthToken=",
            "api",
            "python",
            "-m",
            "seed.seed_demo",
            *args,
            check=False,
        )

    def client(self) -> httpx.Client:
        return httpx.Client(
            base_url=f"{self.api_url}/api/v1",
            headers={"Authorization": f"Bearer {self.token}"},
            timeout=_HTTP_TIMEOUT_SECONDS,
        )


def _wait_until_ready(stack: Stack) -> None:
    """Poll until the API answers through Mongo. Containers start unordered."""
    deadline = time.monotonic() + _STARTUP_TIMEOUT_SECONDS
    last_error = "no answer yet"
    with stack.client() as client:
        while time.monotonic() < deadline:
            try:
                if client.get("/home/summary").status_code == 200:
                    return
                last_error = "not 200 yet"
            except httpx.HTTPError as exc:
                last_error = str(exc)
            time.sleep(2)
    raise RuntimeError(f"the stack never became ready: {last_error}")


@pytest.fixture(scope="session")
def stack():
    """Build and start the whole stack once; always tear it down with its volume."""
    if not _docker_is_up():
        pytest.skip("Docker is not available, and this suite exists to use it")

    api_port, mock_port = _free_port(), _free_port()
    instance = Stack(
        project=f"tm-int-{uuid.uuid4().hex[:8]}",
        api_url=f"http://localhost:{api_port}",
        mock_url=f"http://localhost:{mock_port}",
        token=TEST_TOKEN,
        env={**_COMPOSE_ENV, "TM_API_PORT": str(api_port), "TM_MOCK_PORT": str(mock_port)},
    )

    try:
        instance.compose("up", "-d", "--build")
        _wait_until_ready(instance)
        yield instance
    finally:
        instance.compose("down", "-v", check=False)


@pytest.fixture(scope="session")
def seeded_stack(stack):
    """The stack with the demo cast in it, seeded inside the container.

    Session-scoped on purpose: one seed, many reads — the demo's own shape.
    A test that flips state must put the stage back to amber before it ends.
    """
    result = stack.seed("--reset")
    assert result.returncode == 0, f"the in-container seed failed:\n{result.stderr}"
    return stack
