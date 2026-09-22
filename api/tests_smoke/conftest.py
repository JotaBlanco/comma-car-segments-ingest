# Post-deploy smoke: a DEPLOYED Test Manager, checked from outside.
#
# Points at any environment. Read-only by default, so it is safe to run
# against a shared workspace at any time; the toggle round-trip is opt-in,
# because it resets the sync state a colleague may be mid-rehearsal with.
#
#     TM_SMOKE_URL=https://... TM_API_TOKEN=... uv run pytest tests_smoke -q
#
# Optional:
#     TM_SMOKE_EXPECT_DEMO=1   also pin the contract's Home example counts
#                              (use right after a fresh seed --reset)
#     TM_SMOKE_TOGGLE=1        also walk the toggle beat — STATE-CHANGING
#
# Not collected by a plain `pytest` run (`testpaths = ["tests"]`). Without
# TM_SMOKE_URL every test skips, so the suite is always safe to invoke.

import os

import httpx
import pytest

_HTTP_TIMEOUT_SECONDS = 30.0


def flag(name: str) -> bool:
    return os.environ.get(name, "").strip() in ("1", "true", "yes")


@pytest.fixture(scope="session")
def smoke_url() -> str:
    url = os.environ.get("TM_SMOKE_URL", "").strip()
    if not url:
        pytest.skip("TM_SMOKE_URL is not set — the smoke needs a deployed environment")
    return url.rstrip("/")


@pytest.fixture(scope="session")
def smoke(smoke_url):
    """A client with the bearer token, rooted at the deployed /api/v1."""
    token = os.environ.get("TM_API_TOKEN", "").strip()
    assert token, "set TM_API_TOKEN next to TM_SMOKE_URL — the API answers nothing without it"
    with httpx.Client(
        base_url=f"{smoke_url}/api/v1",
        headers={"Authorization": f"Bearer {token}"},
        timeout=_HTTP_TIMEOUT_SECONDS,
    ) as client:
        yield client
