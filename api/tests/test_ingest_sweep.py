"""The ingestion trigger (FR-DM-003).

The row names two triggers, a cron and a file watcher, and the product had
neither. One loop serves both: it wakes on a timer and it lists a blob prefix.

These tests hold five rules:

1. The trigger is OFF by default, so it can never surprise the demo.
2. A pass finds the new objects and posts each one to mf4-import.
3. A pass is safe to run twice. The second pass posts nothing again.
4. Two passes never overlap.
5. A failing pass never kills the loop.

The suite runs no `pytest-asyncio`. It drives a coroutine with `asyncio.run`,
as `api/tests/test_mock_planning_push.py` does.
"""

import asyncio

import pytest

from api import ingest_sweep


@pytest.fixture(autouse=True)
def clean_sweep(monkeypatch):
    """Give every test its own memory and its own environment."""
    for name in (
        ingest_sweep.IMPORT_URL_VAR,
        ingest_sweep.INTERVAL_VAR,
        ingest_sweep.PREFIX_VAR,
        "Quix__Workspace__Id",
    ):
        monkeypatch.delenv(name, raising=False)
    ingest_sweep.forget_everything()
    yield
    ingest_sweep.forget_everything()


class Recorder:
    """A fake mf4-import. It records what the sweep posts."""

    def __init__(self, refuse: set[str] | None = None) -> None:
        self.posted: list[str] = []
        self.refuse = refuse or set()

    async def __call__(self, key: str) -> bool:
        self.posted.append(key)
        return key not in self.refuse


def lister_of(*keys: str):
    """Build a fake blob listing."""

    def listing(prefix: str) -> list[str]:
        return list(keys)

    return listing


def sweep(lister, poster) -> list[str]:
    """Run one pass on its own loop."""
    return asyncio.run(ingest_sweep.sweep_once(lister=lister, poster=poster))


# --- 1. the trigger is off by default -----------------------------------------


def test_the_trigger_is_off_when_no_import_url_is_set():
    """An empty MF4_IMPORT_URL never sweeps. It is the one switch a person flips."""
    assert ingest_sweep.import_url() == ""
    assert ingest_sweep.is_enabled() is False


def test_start_creates_no_task_while_the_trigger_is_off():
    async def drive():
        return ingest_sweep.start()

    assert asyncio.run(drive()) is None


def test_the_default_interval_is_five_minutes(monkeypatch):
    assert ingest_sweep.interval_seconds() == ingest_sweep.DEFAULT_INTERVAL_SECONDS
    assert ingest_sweep.DEFAULT_INTERVAL_SECONDS == 300.0

    monkeypatch.setenv(ingest_sweep.INTERVAL_VAR, "12")
    assert ingest_sweep.interval_seconds() == 12.0

    # A nonsense value must not stop the loop, and it must not busy-wait.
    monkeypatch.setenv(ingest_sweep.INTERVAL_VAR, "soon")
    assert ingest_sweep.interval_seconds() == ingest_sweep.DEFAULT_INTERVAL_SECONDS
    monkeypatch.setenv(ingest_sweep.INTERVAL_VAR, "0")
    assert ingest_sweep.interval_seconds() == ingest_sweep.DEFAULT_INTERVAL_SECONDS


def test_the_watch_prefix_carries_the_workspace_folder(monkeypatch):
    """SAG reads the first folder under the bucket as the workspace."""
    assert ingest_sweep.watch_prefix() == ingest_sweep.DEFAULT_WATCH_FOLDER

    monkeypatch.setenv("Quix__Workspace__Id", "ws-1")
    assert ingest_sweep.watch_prefix() == f"ws-1/{ingest_sweep.DEFAULT_WATCH_FOLDER}"

    monkeypatch.setenv(ingest_sweep.PREFIX_VAR, "/ws-1/elsewhere/")
    assert ingest_sweep.watch_prefix() == "ws-1/elsewhere"


def test_the_trigger_refuses_the_folder_mf4_import_writes(monkeypatch, caplog):
    """mf4-import writes every object it accepts into `mf4-uploads/`.

    A sweep that watched that folder would post its own result. mf4-import
    would store it under a new name, the next pass would find that name, and
    the loop would never stop. The trigger stays off instead, and it says why.

    The old guard compared the watch prefix with OUR landing prefix, so this
    prefix passed it.
    """
    monkeypatch.setenv(ingest_sweep.IMPORT_URL_VAR, "http://mf4-import/upload/direct")
    monkeypatch.setenv("Quix__Workspace__Id", "ws-1")
    monkeypatch.setenv(ingest_sweep.PREFIX_VAR, ingest_sweep.IMPORT_WRITE_FOLDER)

    with caplog.at_level("ERROR", logger="api.ingest_sweep"):
        enabled = ingest_sweep.is_enabled()

    assert enabled is False
    assert "for ever" in caplog.text


def test_the_trigger_refuses_the_import_folder_under_the_workspace(monkeypatch):
    """The same folder, stamped with the workspace, is the same trap."""
    monkeypatch.setenv(ingest_sweep.IMPORT_URL_VAR, "http://mf4-import/upload/direct")
    monkeypatch.setenv("Quix__Workspace__Id", "ws-1")
    monkeypatch.setenv(
        ingest_sweep.PREFIX_VAR, f"ws-1/{ingest_sweep.IMPORT_WRITE_FOLDER}/2026"
    )

    assert ingest_sweep.is_enabled() is False


def test_the_trigger_refuses_the_landing_prefix(monkeypatch):
    """The pipeline registers what it writes to the landing prefix.

    A sweep over that prefix would post a file the registry already holds.
    """
    from ingest.store import default_blob_prefix

    monkeypatch.setenv(ingest_sweep.IMPORT_URL_VAR, "http://mf4-import/upload/direct")
    monkeypatch.setenv(ingest_sweep.PREFIX_VAR, default_blob_prefix())

    assert ingest_sweep.is_enabled() is False


def test_the_trigger_turns_on_with_a_url_and_its_own_prefix(monkeypatch):
    monkeypatch.setenv(ingest_sweep.IMPORT_URL_VAR, "http://mf4-import/upload/direct")

    assert ingest_sweep.is_enabled() is True


# --- 2. a pass posts every new object -----------------------------------------


def test_a_pass_posts_every_new_measurement_file():
    poster = Recorder()

    sent = sweep(lister_of("drop/a.mf4", "drop/b.mf4"), poster)

    assert sent == ["drop/a.mf4", "drop/b.mf4"]
    assert poster.posted == ["drop/a.mf4", "drop/b.mf4"]


def test_a_pass_skips_an_object_that_is_not_a_measurement_file():
    poster = Recorder()

    sent = sweep(lister_of("drop/notes.txt", "drop/a.MF4"), poster)

    assert sent == ["drop/a.MF4"]


def test_a_refused_object_returns_on_the_next_pass():
    """A refused post must not be forgotten, or the file never enters at all."""
    poster = Recorder(refuse={"drop/a.mf4"})
    lister = lister_of("drop/a.mf4")

    sweep(lister, poster)
    sweep(lister, poster)

    assert poster.posted == ["drop/a.mf4", "drop/a.mf4"]


# --- 3. a pass is safe to run twice -------------------------------------------


def test_a_second_pass_posts_the_same_object_no_second_time():
    poster = Recorder()
    lister = lister_of("drop/a.mf4")

    first = sweep(lister, poster)
    second = sweep(lister, poster)

    assert first == ["drop/a.mf4"]
    assert second == []
    assert poster.posted == ["drop/a.mf4"]


def test_two_passes_started_together_post_each_object_one_time():
    poster = Recorder()
    lister = lister_of("drop/a.mf4", "drop/b.mf4")

    async def drive():
        return await asyncio.gather(
            ingest_sweep.sweep_once(lister=lister, poster=poster),
            ingest_sweep.sweep_once(lister=lister, poster=poster),
        )

    results = asyncio.run(drive())

    assert sorted(key for batch in results for key in batch) == ["drop/a.mf4", "drop/b.mf4"]
    assert poster.posted == ["drop/a.mf4", "drop/b.mf4"]


# --- 4. two passes never overlap ----------------------------------------------


def test_two_passes_never_overlap():
    """One pass finishes before the next one starts.

    Both passes would otherwise list the same prefix and post the same object.
    The trace holds one whole pass, then the next.
    """
    trace: list[str] = []

    async def slow_poster(key: str) -> bool:
        trace.append(f"start {key}")
        await asyncio.sleep(0)
        trace.append(f"end {key}")
        return True

    async def one_pass(key: str) -> None:
        await ingest_sweep.sweep_once(lister=lister_of(key), poster=slow_poster)
        trace.append("pass out")

    async def drive():
        await asyncio.gather(one_pass("drop/a.mf4"), one_pass("drop/b.mf4"))

    asyncio.run(drive())

    assert trace == [
        "start drop/a.mf4",
        "end drop/a.mf4",
        "pass out",
        "start drop/b.mf4",
        "end drop/b.mf4",
        "pass out",
    ]


# --- 5. a failing pass never kills the loop -----------------------------------


def test_a_failing_pass_does_not_kill_the_loop(monkeypatch, caplog):
    """The blob store may refuse, or the prefix may not exist. The loop lives on."""
    passes: list[int] = []

    async def failing_then_working() -> list[str]:
        passes.append(len(passes))
        if len(passes) == 1:
            raise RuntimeError("the blob store refused the listing")
        return []

    monkeypatch.setenv(ingest_sweep.INTERVAL_VAR, "0.001")
    monkeypatch.setattr(ingest_sweep, "sweep_once", failing_then_working)

    async def drive():
        worker = asyncio.create_task(ingest_sweep.run_forever())
        while len(passes) < 3:
            await asyncio.sleep(0.005)
        worker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await worker

    with caplog.at_level("ERROR", logger="api.ingest_sweep"):
        asyncio.run(drive())

    assert len(passes) >= 3
    assert "the ingestion sweep pass failed" in caplog.text


# --- the lifespan runs the loop -----------------------------------------------


def test_the_api_lifespan_starts_and_stops_the_sweep(monkeypatch):
    """The trigger rides the application lifespan, as the planning mock does."""
    from fastapi.testclient import TestClient

    from api.main import create_app

    started: list[str] = []

    async def never_ending() -> None:
        started.append("running")
        await asyncio.Event().wait()

    monkeypatch.setenv(ingest_sweep.IMPORT_URL_VAR, "http://mf4-import/upload/direct")
    monkeypatch.setattr(ingest_sweep, "run_forever", never_ending)

    with TestClient(create_app()) as client:
        assert client.get("/health").status_code == 200

    assert started == ["running"]


def test_the_api_lifespan_starts_no_sweep_while_the_trigger_is_off(monkeypatch):
    from fastapi.testclient import TestClient

    from api.main import create_app

    started: list[str] = []

    async def never_ending() -> None:
        started.append("running")
        await asyncio.Event().wait()

    monkeypatch.setattr(ingest_sweep, "run_forever", never_ending)

    with TestClient(create_app()) as client:
        assert client.get("/health").status_code == 200

    assert started == []


# --- the blob store can list --------------------------------------------------


def test_a_local_store_lists_every_file_under_the_prefix(tmp_path):
    """The developer store answers the same shape the blob store answers."""
    from ingest.store import LocalStore

    (tmp_path / "drop" / "deep").mkdir(parents=True)
    (tmp_path / "drop" / "a.mf4").write_bytes(b"a")
    (tmp_path / "drop" / "deep" / "b.mf4").write_bytes(b"b")
    (tmp_path / "elsewhere.mf4").write_bytes(b"c")

    assert LocalStore(tmp_path).list_keys("drop") == ["drop/a.mf4", "drop/deep/b.mf4"]


def test_a_local_store_answers_an_empty_list_for_an_absent_prefix(tmp_path):
    """A watch folder nobody wrote to yet is normal, so it must not raise."""
    from ingest.store import LocalStore

    assert LocalStore(tmp_path).list_keys("nothing-here") == []


def test_a_blob_store_answers_an_empty_list_for_an_absent_prefix():
    from ingest.store import BlobStore

    class MissingFilesystem:
        def find(self, prefix):
            raise FileNotFoundError(prefix)

    assert BlobStore(MissingFilesystem()).list_keys("drop") == []


def test_a_blob_store_lists_sorted_keys_without_a_leading_slash():
    from ingest.store import BlobStore

    class Filesystem:
        def find(self, prefix):
            return ["/drop/b.mf4", "drop/a.mf4"]

    assert BlobStore(Filesystem()).list_keys("drop") == ["drop/a.mf4", "drop/b.mf4"]
