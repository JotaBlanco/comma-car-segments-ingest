"""Test harness for tm-connector.

Follows the producer-estate conventions (`tests/conftest.py` at the repo root):
cloud-only dependencies are stubbed in sys.modules BEFORE any import, and every
test starts from a scrubbed environment so ambient shell values never reach an
assertion.

Two deliberate choices:

* `quixstreams` is stubbed, because only `main.py` touches it and the wiring
  test asserts on what it was handed. No test constructs a real Application.
* `quixportal` is NOT stubbed. It is POISONED: importing its storage module
  raises. This service must never hold blob credentials, so an accidental
  import has to fail loudly rather than pass under a friendly double.

The fake registry validates every body with the REAL mirrored pydantic models
(`api/api/models/*`), so an extra key, a placeholder actor or an out-of-enum
`source_system` answers 422 here exactly as it would in production.
"""

import os
import sys
import types
from datetime import UTC, datetime

import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(TESTS_DIR)
REPO_ROOT = os.path.dirname(APP_DIR)
API_DIR = os.path.join(REPO_ROOT, "api")

for path in (APP_DIR, API_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

# Every env name tm-connector reads. Scrubbed before each test, so the modules
# that read the environment at call time see the documented defaults.
CONNECTOR_ENV = (
    "metadata_input",
    "batch_input",
    "TM_API_URL",
    "TM_API_TOKEN",
    "TM_ACTOR",
    "TM_HTTP_TIMEOUT_SECONDS",
    "TM_RETRY_MAX_BACKOFF_SECONDS",
    "TM_RETRY_MAX_ATTEMPTS",
    "TM_RUN_KEY_PATTERN",
    "TM_STALL_SECONDS",
    "TM_STATUS_PORT",
    "LOGLEVEL",
    "Quix__Workspace__Id",
    "Quix__BlobStorage__Connection__Json",
)


def _install_quixstreams_stub() -> None:
    """A recording double for the pieces `main.py` uses."""
    if "quixstreams" in sys.modules:
        return

    class StubDataFrame:
        def __init__(self, topic):
            self.topic = topic
            self.updates = []

        def update(self, func):
            self.updates.append(func)
            return self

    class StubTopic:
        def __init__(self, name, **kwargs):
            self.name = name
            self.kwargs = kwargs

    class StubApplication:
        instances: list["StubApplication"] = []

        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.topics: list[StubTopic] = []
            self.dataframes: list[StubDataFrame] = []
            self.run_calls = 0
            StubApplication.instances.append(self)

        def topic(self, name, **kwargs):
            topic = StubTopic(name, **kwargs)
            self.topics.append(topic)
            return topic

        def dataframe(self, topic=None, **kwargs):
            frame = StubDataFrame(topic)
            self.dataframes.append(frame)
            return frame

        def run(self):
            self.run_calls += 1

    module = types.ModuleType("quixstreams")
    module.Application = StubApplication
    sys.modules["quixstreams"] = module


def _poison_quixportal() -> None:
    """`import quixportal.storage` must fail. This service holds no blob credentials."""
    if "quixportal" in sys.modules:
        return

    class _Poisoned(types.ModuleType):
        def __getattr__(self, name):
            raise AssertionError(
                "tm-connector must never touch blob storage — it reads Kafka and calls HTTP"
            )

    quixportal = _Poisoned("quixportal")
    sys.modules["quixportal"] = quixportal


_install_quixstreams_stub()
_poison_quixportal()


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """No ambient TM_*/Quix__* value ever reaches a test."""
    for name in CONNECTOR_ENV:
        monkeypatch.delenv(name, raising=False)


# --- message builders ---------------------------------------------------------------

UPLOAD_ID = "TAS-90001_road_capture_20260820_1042-7a9622106da0"
FILE_NAME = "TAS-90001_road_capture_20260820_1042.mf4"
BLOB_PATH = "mf4-uploads/2026/08/20/TAS-90001_road_capture_20260820_1042-3f9c1a22.mf4"
SHA256 = "9f2b" + "0" * 60

DECLARED = {
    "run_id": "TAS-90001",
    "rig_id": "RIG-01",
    "work_order_id": "WO-2026-0853",
    "definition_id": "TD-RLD-301",
}

HEADER_PROPERTIES = {
    "test.run_key": "TAS-90001",
    "test.rig": "RIG-01",
    "test.started_at": "2026-08-20T10:42:07Z",
    "test.ended_at": "2026-08-20T10:43:37Z",
    "test.source_system": "TAS",
    "platform": "HONDA_CIVIC",
    "dbc.name": "civic.dbc",
}

FILE_BLOCK = {
    "sha256": SHA256,
    "size_bytes": 184320,
    "blob_path": BLOB_PATH,
    "format": "MDF 4.10",
    "checksum_state": "verified",
}


def metadata_message(**overrides) -> dict:
    """One `mf4_metadata` payload."""
    message = {
        "id": UPLOAD_ID,
        "filename": FILE_NAME,
        "blob_path": BLOB_PATH,
        "blob_url": None,
        "size_bytes": 184320,
        "content_type": "application/x-mdf",
        "sha256": SHA256,
        "uploaded_at": "2026-08-20T10:42:07.412Z",
        "uploader_ip": "10.42.0.19",
        "source": "mf4-to-blob",
        "declared": dict(DECLARED),
    }
    message.update(overrides)
    return message


def samples_message(
    signal="ENGINE_RPM",
    seq=0,
    n=2,
    unit="rpm",
    text=False,
    start_ms=1787222527412,
    step_ms=50,
    **overrides,
) -> dict:
    """One `kind:"samples"` batch."""
    timestamps = [start_ms + index * step_ms for index in range(n)]
    values = [None] * n if text else [812.5 + index for index in range(n)]
    texts = [f"S{index}" for index in range(n)] if text else [None] * n
    message = {
        "kind": "samples",
        "run_id": DECLARED["run_id"],
        "file_name": FILE_NAME,
        "upload_id": UPLOAD_ID,
        "signal": signal,
        "unit": unit,
        "channel_name": "unknown",
        "frame_name": "ENGINE_DATA",
        "sender_node": "PCM",
        "ts_ms": timestamps,
        "value": values,
        "value_text": texts,
        "batch": {"seq": seq, "last": False},
        "file": dict(FILE_BLOCK),
        "declared": dict(DECLARED),
        "header_properties": dict(HEADER_PROPERTIES),
    }
    message.update(overrides)
    return message


# `complete_message(inventory=...)` left unset omits the key, which is what a
# decoder that never learned to report its inventory looks like on the wire.
# Passing a list — `[]` included — states one.
OMITTED = object()


def complete_message(
    seq=1,
    signal_count=1,
    sample_count=2,
    decode_error=None,
    time_start_ms=1787222527412,
    time_end_ms=1787222617412,
    inventory=OMITTED,
    samples_suppressed=None,
    **overrides,
) -> dict:
    """The terminal `kind:"file_complete"` marker."""
    batch = {
        "seq": seq,
        "last": True,
        "signal_count": signal_count,
        "sample_count": sample_count,
        "time_start_ms": time_start_ms,
        "time_end_ms": time_end_ms,
        "decode_error": decode_error,
        "samples_suppressed": samples_suppressed,
    }
    if inventory is not OMITTED:
        batch["inventory"] = inventory
    message = {
        "kind": "file_complete",
        "run_id": DECLARED["run_id"],
        "file_name": FILE_NAME,
        "upload_id": UPLOAD_ID,
        "batch": batch,
        "file": dict(FILE_BLOCK),
        "declared": dict(DECLARED),
        "header_properties": dict(HEADER_PROPERTIES),
    }
    message.update(overrides)
    return message


# --- wiring -------------------------------------------------------------------------


@pytest.fixture
def clock():
    """A clock the test moves by hand, so no assertion waits on real time."""

    class Clock:
        def __init__(self):
            self.now = datetime(2026, 8, 20, 10, 45, tzinfo=UTC)

        def __call__(self):
            return self.now

        def advance(self, seconds):
            from datetime import timedelta

            self.now += timedelta(seconds=seconds)

    return Clock()


@pytest.fixture
def api():
    """The fake Test Manager API, validating with the real mirrored models."""
    from tests.fake_registry import FakeApi

    return FakeApi()


@pytest.fixture
def config():
    from connector.config import Config

    return Config(api_url="http://tm/api/v1", api_token="t0ken", retry_max_attempts=3)


@pytest.fixture
def registry(api, config):
    from connector.registry import Registry

    return Registry(
        base_url=config.api_url,
        token=config.api_token,
        max_attempts=config.retry_max_attempts,
        max_backoff=config.retry_max_backoff_seconds,
        sleep=lambda _seconds: None,
        client=api.client(config.api_url),
    )


@pytest.fixture
def connector(registry, config, clock):
    from connector.connector import Connector

    return Connector(registry, config, clock=clock)


@pytest.fixture
def no_dressing(monkeypatch):
    """Switch demo dressing off for a test that is about something else.

    A law about the UNKNOWN sentinel must assert the sentinel, not depend on
    the sha1 dice happening to leave that particular run id honest — otherwise
    a changed pool or rate flips it and the failure points at the wrong thing.
    """
    from connector import dressing

    monkeypatch.setattr(dressing, "dress_run_body", lambda body: body)
