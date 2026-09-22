"""Mock planning system (BE-PLAN §6).

The demo mocks the source system, never the mechanism. This app stands in for
the planning system. The backend runs a real sync pass against it, and the
demo toggle flips the switch below.

The app keeps its cast in memory and loads it from `fixture.json` on startup.
The seed READS that same file (`seed/fixtures.py`), so the run to work-order
linkage stays defined in one place and the two casts can never disagree.

The switch starts off, because the demo starts amber. While the switch is off
every `/api/v1/*` route answers 503 and `/health` still answers 200: an offline
planning system is still a running container.

**This app also PUSHES.** Arrows point into the Test Manager, so the registry
must not fetch from planning. The worker below polls the registry for the runs
still waiting for a work order, decides which of its own work orders they
fulfill, and posts the catalog and those links to `POST /planning/sync`. The
matching lives here because planning owns that decision. The registry's
outbound fetch still answers the `/api/v1` reads until it retires.

This app stands in for ANOTHER GROUP'S system, so it imports nothing from
`api.*` or `seed`. It talks to the registry over HTTP, like the real one would.

This file is UTF-8. The cast carries "°C" and "Åkesson".
"""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel

log = logging.getLogger("mock_planning")

FIXTURE_PATH = Path(__file__).with_name("fixture.json")

# The demo starts amber. A restarted mock must not serve work orders again on
# its own, so the switch always comes back off.
STARTS_ONLINE = False

OFFLINE_DETAIL = "planning system offline"

# The registry this pushes to. The same two names every other component reads.
# The value states the whole prefix, `http://host/api/v1`, and every outbound
# path here is bare. `tm-connector` reads the name the same way.
# **Unset means no push at all**, which is what keeps the test suite and a bare
# `uvicorn mock_planning.main:app` from opening a socket to anything.
TM_URL_VAR = "TM_API_URL"
TM_TOKEN_VAR = "TM_API_TOKEN"

# The push period, in seconds. A test sets it to milliseconds.
INTERVAL_VAR = "PLANNING_PUSH_INTERVAL_SECONDS"
DEFAULT_INTERVAL_SECONDS = 30.0

# The registry's word for a run that has no work order yet. The orphan state
# this whole worker exists to clear.
WAITING_STATUS = "awaiting_work_order"

PUSH_PAGE_SIZE = 200
REQUEST_TIMEOUT_SECONDS = 10.0

# The test seam. Tests set a mock transport here, so no unit test opens a
# socket — the same pattern as `api.quix_identity.TRANSPORT`.
TRANSPORT: httpx.AsyncBaseTransport | None = None

_state: dict[str, Any] = {
    "online": STARTS_ONLINE,
    "work_orders": [],
    "test_definitions": [],
}

# Set to run a pass now instead of at the next tick. The demo beat must not
# wait 30 seconds for the toggle it just flipped.
#
# The lifespan builds it, and it must: an `asyncio.Event` binds to the first
# event loop that waits on it and refuses every other one. Tests run one app
# per TestClient, so a module-level instance would raise "bound to a different
# event loop" in the second test that ever pushed.
_wake: asyncio.Event | None = None


def reset_state() -> dict[str, Any]:
    """Reload the cast from the fixture and put the switch back off.

    Returns the counts, so the seed script can check what it just loaded.
    """
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    _state["work_orders"] = payload.get("work_orders", [])
    _state["test_definitions"] = payload.get("test_definitions", [])
    _state["online"] = STARTS_ONLINE
    return {
        "online": _state["online"],
        "work_orders": len(_state["work_orders"]),
        "test_definitions": len(_state["test_definitions"]),
    }


def _kick() -> None:
    """Ask the worker for a pass now. Safe when no worker is running.

    Both routes that change what this system would say call it. A reset lands
    the switch OFF, so the pass it wakes finds nothing to do — and the fresh
    cast then rides the very first push after the toggle goes on.
    """
    if _wake is not None:
        _wake.set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the cast on startup and run the push worker for the app's lifetime.

    Tests share this one module-level app. Reloading on startup gives every
    test its own switch, its own cast and its own wake-up event.
    """
    global _wake

    reset_state()
    _wake = asyncio.Event()
    worker = asyncio.create_task(_push_worker())
    try:
        yield
    finally:
        worker.cancel()
        with suppress(asyncio.CancelledError):
            await worker


app = FastAPI(title="Mock Planning System", lifespan=lifespan)


def require_online() -> None:
    """Refuse a planning read while the switch is off.

    The backend sync reads this 503 as "nothing to sync", not as an error.
    """
    if not _state["online"]:
        raise HTTPException(status_code=503, detail=OFFLINE_DETAIL)


planning = APIRouter(prefix="/api/v1", dependencies=[Depends(require_online)])
admin = APIRouter(prefix="/admin")


class StateBody(BaseModel):
    online: bool
    # False = flip silently; the caller runs its own pass (24 Aug 2026): the
    # registry's trigger and toggle wake planning QUIETLY so the adoption
    # happens in - and is narrated by - their own pass, never a racing worker
    # kick. Direct-edited until 25 Aug 2026, when a mirror sync silently
    # reverted it; fixup-carried since.
    wake: bool = True


@app.get("/health")
def health() -> dict:
    """Answer the compose healthcheck. This route ignores the switch."""
    return {"status": "ok"}


@planning.get("/work-orders")
def list_work_orders() -> dict:
    items = _state["work_orders"]
    return {"items": items, "total": len(items)}


@planning.get("/work-orders/{work_order_id}")
def read_work_order(work_order_id: str) -> dict:
    for work_order in _state["work_orders"]:
        if work_order["id"] == work_order_id:
            return work_order
    raise HTTPException(status_code=404, detail="work order not found")


@planning.get("/test-definitions")
def list_test_definitions() -> dict:
    """Serve the definitions.

    Each one carries `work_order_id`, `planned_runs` and `run_ids`. The
    backfill reads `run_ids` to find the runs that wait for a work order.
    """
    items = without_planned_runs(_state["test_definitions"])
    return {"items": items, "total": len(items)}


@admin.get("/state")
def read_state() -> dict:
    return {"online": _state["online"]}


@admin.post("/state")
async def write_state(body: StateBody) -> dict:
    """Flip the switch. The demo toggle calls this route.

    Async so the wake-up lands on the event loop the worker waits on. Coming
    online pushes at once; going offline needs no wake, because the worker's
    first act is to check the switch.
    """
    _state["online"] = body.online
    if body.online and body.wake:
        _kick()
    return {"online": _state["online"]}


@admin.post("/reset")
async def reset() -> dict:
    """Reload the cast. The seed script calls this after rewriting the fixture.

    The worker is woken because the cast just changed. A reset lands the switch
    off, so that pass finds nothing to do, and the fresh cast rides the first
    push after the toggle comes back on.
    """
    result = reset_state()
    _kick()
    return result


app.include_router(planning)
app.include_router(admin)

# Demo overlay (scripts/sync.config.json): planning learns plans and work orders
# at runtime, and serves its last push. See mock_planning/demo_admin.py.
from mock_planning.demo_admin import adopt_orphan_claims, demo, record_push, without_planned_runs  # noqa: E402

app.include_router(demo)


# --- The push to the registry -------------------------------------------------


def decide_links(
    runs: list[dict], work_orders: list[dict], definitions: list[dict]
) -> list[dict]:
    """Decide which work order each waiting run fulfills. Planning's own call.

    This is why the matching moved here: planning owns the decision of which
    runs fulfill its work orders, and the registry owns nothing of the sort.

    Two rules, and neither invents anything.

    * **The run's own claim.** The bench states a `definition_id` or a
      `work_order_id`. Planning honours it only when its own catalog holds that
      row, and a definition claim carries its work order along with it. A
      waiting run has no work order by definition, so the claim that matters
      here is usually the one the registry could NOT resolve and remembers as
      `claimed_work_order_id` / `claimed_definition_id` — without those this
      rule was latent for exactly the bench-generated ids it exists to match.
    * **The plan.** A definition names the runs it planned, so a waiting run in
      its `run_ids` gets that definition and its work order.

    A claim wins over the plan, because it names what the bench actually ran.
    A run that neither rule justifies gets NO link and stays amber, which is a
    normal state and never an error.
    """
    known_orders = {row["id"] for row in work_orders if row.get("id")}
    # A definition is usable only when its work order is one we are sending, or
    # the registry would refuse the link anyway.
    definition_orders = {
        row["id"]: row["work_order_id"]
        for row in definitions
        if row.get("id") and row.get("work_order_id") in known_orders
    }

    links: dict[str, dict] = {}
    for run in runs:
        run_id = run.get("run_id")
        claimed = _link_from_claim(run, known_orders, definition_orders)
        if run_id and claimed is not None:
            links[run_id] = {"run_id": run_id, **claimed}

    waiting = {run.get("run_id") for run in runs}
    for definition in definitions:
        work_order_id = definition_orders.get(definition.get("id"))
        if work_order_id is None:
            continue
        for run_id in definition.get("run_ids") or []:
            if run_id not in waiting or run_id in links:
                continue
            links[run_id] = {
                "run_id": run_id,
                "work_order_id": work_order_id,
                "definition_id": definition["id"],
            }

    return list(links.values())


def _link_from_claim(
    run: dict, known_orders: set[str], definition_orders: dict[str, str]
) -> dict | None:
    """Read one run's embedded claim. Return the link it justifies, or None.

    A definition claim is the richer of the two: it names the definition AND,
    through the catalog, the work order that definition belongs to. So both
    definition forms are read before either work-order form.

    Within each pair the RESOLVED field comes first — the registry already
    vouched for it against its mirror — and the remembered claim second.
    """
    for definition_id in (run.get("definition_id"), run.get("claimed_definition_id")):
        if definition_id in definition_orders:
            return {
                "work_order_id": definition_orders[definition_id],
                "definition_id": definition_id,
            }

    for work_order_id in (run.get("work_order_id"), run.get("claimed_work_order_id")):
        if work_order_id in known_orders:
            return {"work_order_id": work_order_id, "definition_id": None}

    return None


async def push_once() -> dict:
    """Run one push pass. Never raise, whatever the registry does.

    Fail-soft is the whole contract with the registry: a planning system that
    cannot reach it has not changed its plan, so the switch stays where it is
    and the next tick tries again. While the switch is off nothing is called at
    all — an offline planning system makes no requests either.
    """
    if not _state["online"]:
        return {"pushed": False, "reason": OFFLINE_DETAIL}

    base_url = os.environ.get(TM_URL_VAR, "").strip()
    if not base_url:
        return {"pushed": False, "reason": f"{TM_URL_VAR} is not set"}

    work_orders = list(_state["work_orders"])
    definitions = without_planned_runs(_state["test_definitions"])
    adopted_before = set(_state.get("adopted_pairs", []))
    try:
        async with _registry_client(base_url) as client:
            runs = await _waiting_runs(client)
            work_orders, definitions = adopt_orphan_claims(runs, work_orders, definitions)
            links = decide_links(runs, work_orders, definitions)
            counts = await _post_catalog(client, work_orders, definitions, links)
    except (httpx.HTTPError, ValueError) as error:
        log.warning("planning push failed: the registry answered %r", error)
        return {"pushed": False, "reason": str(error)}

    log.info(
        "planning push: %d waiting runs, %d links posted, %s",
        len(runs),
        len(links),
        counts,
    )
    # What THIS pass adopted, so a triggered sync can narrate it. The
    # cumulative list stays in state for the demo console. Direct-edited until
    # 25 Aug 2026, when a mirror sync silently reverted it; fixup-carried since.
    adopted_now = sorted(set(_state.get("adopted_pairs", [])) - adopted_before)
    return {
        "pushed": True,
        "runs": len(runs),
        "links": len(links),
        "adopted": adopted_now,
        "counts": counts,
    }


def _registry_client(base_url: str) -> httpx.AsyncClient:
    """A client for the registry, carrying the bearer every write needs.

    `TM_API_URL` carries the whole registry prefix, `/api/v1` included. Every
    path below is bare, so nothing here appends the prefix a second time. This
    is how `tm-connector` reads the same name.
    """
    token = os.environ.get(TM_TOKEN_VAR, "").strip()
    return httpx.AsyncClient(
        base_url=base_url.rstrip("/"),
        headers={"Authorization": f"Bearer {token}"} if token else {},
        timeout=REQUEST_TIMEOUT_SECONDS,
        transport=TRANSPORT,
    )


async def _waiting_runs(client: httpx.AsyncClient) -> list[dict]:
    """Every run still waiting for a work order — the orphans, page by page.

    A run that no rule justifies stays in this list for ever, so the pass must
    read past the first page or those runs would hide the ones behind them.
    """
    runs: list[dict] = []
    page = 1
    while True:
        response = await client.get(
            "/test-runs",
            params={"status": WAITING_STATUS, "page": page, "page_size": PUSH_PAGE_SIZE},
        )
        response.raise_for_status()
        body = response.json()
        runs.extend(body.get("items") or [])
        if page >= (body.get("total_pages") or 0):
            return runs
        page += 1


async def _post_catalog(
    client: httpx.AsyncClient,
    work_orders: list[dict],
    definitions: list[dict],
    links: list[dict],
) -> dict:
    """Hand the registry the catalog and the links. It decides what to keep."""
    response = await client.post(
        "/planning/sync",
        json={
            "work_orders": work_orders,
            "test_definitions": definitions,
            "links": links,
        },
    )
    response.raise_for_status()
    return response.json()


def push_interval_seconds() -> float:
    """The push period. A missing or nonsense value reads as the default."""
    try:
        seconds = float(os.environ.get(INTERVAL_VAR, "").strip())
    except ValueError:
        return DEFAULT_INTERVAL_SECONDS
    return seconds if seconds > 0 else DEFAULT_INTERVAL_SECONDS


async def _push_worker() -> None:
    """Push on a timer, and whenever `_kick` asks. Never let the app die.

    `push_once` already swallows every way the registry can fail. This catch is
    the belt for the ways it cannot: a bug here must not take the mock's own
    `/api/v1` routes down with it.
    """
    wake = _wake or asyncio.Event()
    while True:
        try:
            record_push(await push_once())
        except Exception:
            log.exception("the planning push pass failed")
        with suppress(TimeoutError):
            await asyncio.wait_for(wake.wait(), timeout=push_interval_seconds())
        wake.clear()
