"""The ingestion trigger (FR-DM-003).

The row names two triggers, a cron and a file watcher, and the product had
neither. The old `ingestion-service` was deleted and nothing replaced its poll,
so a file entered the pipeline only when the Test Bench posted it by hand.

One loop serves both triggers:

* **the cron half** — the loop wakes on a timer, every
  ``INGEST_SWEEP_INTERVAL_SECONDS`` seconds;
* **the file-watcher half** — each pass lists the watch prefix in blob storage
  and finds the objects the last pass did not see.

Each new object goes to **mf4-import** by HTTP POST. The sweep never writes the
registry itself. A file that skips the pipeline gets no signals and no lake
rows, so it would show on the screen as an empty run for ever.

**``MF4_IMPORT_URL`` is the one switch.** An empty URL means the loop never
starts. ``quix.yaml`` points it at ``http://mf4-import/upload/direct`` now, so
the trigger is ON, and a person blanks that one value to turn it off.

**The sweep watches a hand-drop folder, never the folder mf4-import writes.**
``TM_WATCH_PREFIX`` is ``test-manager/dropbox``, beside mf4-import's own
``mf4-uploads/``. ``is_enabled`` refuses a prefix that overlaps the write
folder, because the sweep would otherwise post its own result for ever.

**A restart forgets what the sweep posted.** ``_posted`` lives in memory only,
so the first pass after a restart posts every file the drop folder still holds.
mf4-import accepts each one and writes a second copy, and mf4-decoder then
drops it on the content hash, so the registry gains no second run.

No scheduler library runs this. `api/mock_planning/main.py` already proves the
pattern: a background task on the application lifespan, and `asyncio` for the
rest.

**The POST shape is read, not guessed.** `mf4-import` takes the object bytes as
the request body and the file name in the ``filename`` query parameter
(`test-manager-demo` ``origin/dev:mf4-import/main.py:110-115``). ``size`` is
optional there, and this module sends none. ``MF4_IMPORT_URL`` names the whole
URL, so an operator who meets a new route points the variable at it.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import PurePosixPath
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# The whole mf4-import upload URL. Unset means the trigger stays OFF.
IMPORT_URL_VAR = "MF4_IMPORT_URL"

# Seconds between two passes.
INTERVAL_VAR = "INGEST_SWEEP_INTERVAL_SECONDS"
DEFAULT_INTERVAL_SECONDS = 300.0

# The blob prefix the sweep watches, under the workspace folder.
PREFIX_VAR = "TM_WATCH_PREFIX"
DEFAULT_WATCH_FOLDER = "test-manager/dropbox"

# The folder mf4-import writes every object it accepts into. Its deployment
# sets `blob_prefix`, and the code default and the demo descriptor both name
# this folder (test-manager-demo `mf4-import/main.py`, `quix.yaml`). mf4-import
# writes it at the bucket root, with no workspace folder in front.
IMPORT_WRITE_FOLDER = "mf4-uploads"

# The sweep posts measurement files and nothing else.
WATCHED_SUFFIX = ".mf4"

# One object may be large, so the post takes longer than an API call.
POST_TIMEOUT_SECONDS = 300.0

# The keys the sweep already handed to mf4-import. It makes a second pass over
# the same object do nothing, so a pass is safe to run twice.
_posted: set[str] = set()

# Two passes must never overlap. Both would list the same prefix, and both
# would post the same object. The second pass waits for the first.
#
# The lock binds to the loop that first takes it, and a test starts a new loop
# per test. So the lock is built on demand, per loop. `api/mock_planning`
# builds its wake-up event in the lifespan for the same reason.
_lock: asyncio.Lock | None = None
_lock_loop: Any = None


def _pass_lock() -> asyncio.Lock:
    """Return the lock of the running loop, and build it the first time."""
    global _lock, _lock_loop
    loop = asyncio.get_running_loop()
    if _lock is None or _lock_loop is not loop:
        _lock = asyncio.Lock()
        _lock_loop = loop
    return _lock


Lister = Callable[[str], list[str]]
Poster = Callable[[str], Awaitable[bool]]


# --- the settings -------------------------------------------------------------------


def import_url() -> str:
    """Return the mf4-import URL. An empty answer means the trigger is off."""
    return os.environ.get(IMPORT_URL_VAR, "").strip()


def interval_seconds() -> float:
    """Return the seconds between two passes. A nonsense value reads as the default."""
    try:
        seconds = float(os.environ.get(INTERVAL_VAR, "").strip())
    except ValueError:
        return DEFAULT_INTERVAL_SECONDS
    return seconds if seconds > 0 else DEFAULT_INTERVAL_SECONDS


def watch_prefix() -> str:
    """Return the blob prefix the sweep watches, under the workspace folder.

    SAG reads the first folder under the bucket as the workspace, so the prefix
    carries it. `ingest.store.default_blob_prefix` builds the landing prefix the
    same way.
    """
    chosen = os.environ.get(PREFIX_VAR, "").strip().strip("/")
    if chosen:
        return chosen
    from ingest.store import WORKSPACE_VARIABLE

    workspace = os.environ.get(WORKSPACE_VARIABLE, "").strip().strip("/")
    return f"{workspace}/{DEFAULT_WATCH_FOLDER}" if workspace else DEFAULT_WATCH_FOLDER


def _overlaps(one: str, other: str) -> bool:
    """Say whether one prefix holds the other, or is the other."""
    return one == other or one.startswith(f"{other}/") or other.startswith(f"{one}/")


def _forbidden_prefixes() -> list[str]:
    """Return the prefixes the sweep must never watch.

    `mf4-uploads` is the trap. mf4-import writes every object it accepts there,
    and its collision policy gives the object a new name. So a sweep over that
    folder would post its own result, and the next pass would find a new name
    again. mf4-import writes the folder at the bucket root, and this deployment
    stamps the workspace on its own prefixes, so both shapes are forbidden.

    The landing prefix is forbidden as well. The pipeline registers what it
    writes there, so a sweep over it would post a file the registry holds.
    """
    from ingest.store import WORKSPACE_VARIABLE, default_blob_prefix

    forbidden = [IMPORT_WRITE_FOLDER, default_blob_prefix()]
    workspace = os.environ.get(WORKSPACE_VARIABLE, "").strip().strip("/")
    if workspace:
        forbidden.append(f"{workspace}/{IMPORT_WRITE_FOLDER}")
    return forbidden


def is_enabled() -> bool:
    """Say whether the trigger may start.

    Two conditions, and both must hold.

    1. `MF4_IMPORT_URL` names a URL. Unset is the default, so the trigger is off
       until somebody turns it on.
    2. The watch prefix sits OUTSIDE every prefix `_forbidden_prefixes` names.
    """
    if not import_url():
        return False
    prefix = watch_prefix()
    for forbidden in _forbidden_prefixes():
        if _overlaps(prefix, forbidden):
            logger.error(
                "%s is %s, and the pipeline writes into %s. The sweep would post "
                "its own result for ever, so it stays off. Point %s at another "
                "prefix.",
                PREFIX_VAR,
                prefix,
                forbidden,
                PREFIX_VAR,
            )
            return False
    return True


# --- the real blob and HTTP legs ----------------------------------------------------


def _build_store() -> Any:
    """Build the blob store. The import stays here, as the peer legs do it."""
    from ingest.store import build_store

    store, _ = build_store()
    return store


def _list_keys(prefix: str) -> list[str]:
    """List the objects under the watch prefix. This call blocks."""
    return _build_store().list_keys(prefix)


def _read_bytes(key: str) -> bytes | None:
    """Read one whole object. This call blocks.

    A demo file fits in memory. A production sweep would stream instead.
    """
    return _build_store().read_bytes(key)


async def _post(key: str) -> bool:
    """Hand one object to mf4-import. Answer whether the pipeline holds it now."""
    payload = await asyncio.to_thread(_read_bytes, key)
    if payload is None:
        logger.warning("the sweep found %s and then could not read it", key)
        return False
    async with httpx.AsyncClient(timeout=POST_TIMEOUT_SECONDS) as client:
        response = await client.post(
            import_url(),
            params={"filename": PurePosixPath(key).name},
            content=payload,
            headers={"Content-Type": "application/octet-stream"},
        )
    # 409 means mf4-import already holds this file. That is a success for the
    # sweep: the pipeline has the object, so no later pass must post it again.
    if response.status_code == 409:
        logger.info("mf4-import already holds %s", key)
        return True
    if response.status_code >= 400:
        # The status only. A body may repeat a header the request carried.
        logger.warning("mf4-import refused %s with status %s", key, response.status_code)
        return False
    logger.info("the sweep sent %s to mf4-import", key)
    return True


# --- one pass -----------------------------------------------------------------------


async def sweep_once(lister: Lister | None = None, poster: Poster | None = None) -> list[str]:
    """Run one pass. Return the keys this pass handed to mf4-import.

    The lock makes two passes serial, and `_posted` makes the second pass find
    nothing new. So a caller may run this twice with no second upload.

    A key that fails stays out of `_posted`, so the next pass tries it again.
    """
    list_keys = lister or _list_keys
    post = poster or _post
    async with _pass_lock():
        prefix = watch_prefix()
        keys = await asyncio.to_thread(list_keys, prefix)
        fresh = [key for key in keys if key.lower().endswith(WATCHED_SUFFIX) and key not in _posted]
        sent: list[str] = []
        for key in fresh:
            if await post(key):
                _posted.add(key)
                sent.append(key)
        return sent


def forget_everything() -> None:
    """Drop what the sweep remembers. A test calls it between passes."""
    _posted.clear()


# --- the loop -----------------------------------------------------------------------


async def run_forever() -> None:
    """Sweep on a timer, for the life of the application.

    A failing pass must never kill the loop. `sweep_once` already answers a
    refused post, and this catch holds every other way a pass can fail: a blob
    store that will not build, a prefix that does not exist, a bug here. The
    loop logs it and waits for the next tick.
    """
    while True:
        try:
            await sweep_once()
        except Exception:
            logger.exception("the ingestion sweep pass failed")
        await asyncio.sleep(interval_seconds())


def start() -> asyncio.Task | None:
    """Start the loop, or answer None when the trigger is off."""
    if not is_enabled():
        logger.info("%s is not set, so the ingestion sweep stays off", IMPORT_URL_VAR)
        return None
    logger.info(
        "the ingestion sweep watches %s every %s seconds",
        watch_prefix(),
        interval_seconds(),
    )
    return asyncio.create_task(run_forever())
