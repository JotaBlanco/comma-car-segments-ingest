"""The planning mock's push worker — the inverted arrow's driving end.

Planning polls the registry for the runs still waiting, decides which of its
own work orders they fulfill, and posts the catalog and those links. The
matching is a pure function, so most of this suite needs no HTTP at all; the
worker tests drive it through a mock transport, so no test opens a socket.
"""

import asyncio
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from mock_planning import main as planning_main


def push_now() -> dict:
    """One pass, driven from a sync test. The suite has no async plugin."""
    return asyncio.run(planning_main.push_once())


# `TM_API_URL` as every deployment states it: the whole registry prefix. The
# demo descriptor says `http://test-manager-backend/api/v1`, tm-connector reads
# the same shape, and our compose files match it.
REGISTRY_URL = "http://registry.test/api/v1"

RUN = "TAS-88214"
OTHER_RUN = "TAS-88215"
WORK_ORDER = "WO-2026-0851"
DEFINITION = "TD-BAT-114"

WORK_ORDERS = [{"id": WORK_ORDER, "title": "winter cycle", "project": "EX90"}]
DEFINITIONS = [
    {"id": DEFINITION, "work_order_id": WORK_ORDER, "planned_runs": 4, "run_ids": [RUN]}
]


def _run(run_id: str = RUN, **claims) -> dict:
    """One row as `GET /test-runs?status=awaiting_work_order` serves it."""
    return {"run_id": run_id, "work_order_id": None, "definition_id": None, **claims}


# --- decide_links: the plan ----------------------------------------------------


def test_a_planned_run_gets_its_definitions_work_order() -> None:
    """The demo beat: TD-BAT-114 hands TAS-88214 to WO-2026-0851."""
    links = planning_main.decide_links([_run()], WORK_ORDERS, DEFINITIONS)

    assert links == [
        {"run_id": RUN, "work_order_id": WORK_ORDER, "definition_id": DEFINITION}
    ]


def test_a_run_nobody_planned_gets_no_link() -> None:
    """Never invent a link. An unexplained run stays amber, which is normal."""
    assert planning_main.decide_links([_run(OTHER_RUN)], WORK_ORDERS, DEFINITIONS) == []


def test_a_planned_run_that_is_not_waiting_gets_no_link() -> None:
    """The plan names runs that already have a work order. Those are not ours."""
    assert planning_main.decide_links([], WORK_ORDERS, DEFINITIONS) == []


def test_a_definition_whose_work_order_is_absent_links_nothing() -> None:
    """The registry would refuse a link naming a row we did not send."""
    assert planning_main.decide_links([_run()], [], DEFINITIONS) == []


# --- decide_links: the run's own claim -----------------------------------------


def test_a_definition_claim_carries_its_work_order() -> None:
    runs = [_run(OTHER_RUN, definition_id=DEFINITION)]

    links = planning_main.decide_links(runs, WORK_ORDERS, DEFINITIONS)

    assert links == [
        {"run_id": OTHER_RUN, "work_order_id": WORK_ORDER, "definition_id": DEFINITION}
    ]


def test_a_work_order_claim_links_without_a_definition() -> None:
    runs = [_run(OTHER_RUN, work_order_id=WORK_ORDER)]

    links = planning_main.decide_links(runs, WORK_ORDERS, DEFINITIONS)

    assert links == [
        {"run_id": OTHER_RUN, "work_order_id": WORK_ORDER, "definition_id": None}
    ]


def test_a_claim_naming_nothing_in_the_catalog_is_ignored() -> None:
    runs = [_run(OTHER_RUN, work_order_id="WO-2026-9999", definition_id="TD-XX-000")]

    assert planning_main.decide_links(runs, WORK_ORDERS, DEFINITIONS) == []


def test_the_run_s_own_claim_wins_over_the_plan() -> None:
    """The claim names what the bench actually ran, so it is the finer fact."""
    work_orders = [*WORK_ORDERS, {"id": "WO-2026-0847", "project": "EX90"}]
    definitions = [
        *DEFINITIONS,
        {"id": "TD-EM-201", "work_order_id": "WO-2026-0847", "run_ids": []},
    ]

    links = planning_main.decide_links(
        [_run(definition_id="TD-EM-201")], work_orders, definitions
    )

    assert links == [
        {"run_id": RUN, "work_order_id": "WO-2026-0847", "definition_id": "TD-EM-201"}
    ]


def test_one_run_is_never_linked_twice() -> None:
    """A run claimed AND planned yields exactly one decision."""
    links = planning_main.decide_links(
        [_run(definition_id=DEFINITION)], WORK_ORDERS, DEFINITIONS
    )

    assert len(links) == 1


# --- decide_links: the claim the registry could not resolve --------------------
#
# A waiting run has no work order by definition, so the two link fields above
# are the resolved claims only — the rule was latent for the bench-generated id
# it most needed to match. The registry remembers the unresolved claim, and
# these read it.


def test_a_retained_work_order_claim_is_matched() -> None:
    runs = [_run(OTHER_RUN, claimed_work_order_id=WORK_ORDER)]

    links = planning_main.decide_links(runs, WORK_ORDERS, DEFINITIONS)

    assert links == [
        {"run_id": OTHER_RUN, "work_order_id": WORK_ORDER, "definition_id": None}
    ]


def test_a_retained_definition_claim_carries_its_work_order() -> None:
    runs = [_run(OTHER_RUN, claimed_definition_id=DEFINITION)]

    links = planning_main.decide_links(runs, WORK_ORDERS, DEFINITIONS)

    assert links == [
        {"run_id": OTHER_RUN, "work_order_id": WORK_ORDER, "definition_id": DEFINITION}
    ]


def test_a_retained_claim_naming_nothing_in_the_catalog_is_ignored() -> None:
    runs = [
        _run(
            OTHER_RUN,
            claimed_work_order_id="WO-2026-9999",
            claimed_definition_id="TD-XX-000",
        )
    ]

    assert planning_main.decide_links(runs, WORK_ORDERS, DEFINITIONS) == []


def test_a_resolved_definition_wins_over_a_retained_work_order_claim() -> None:
    """The registry already vouched for the definition. The claim is a guess."""
    work_orders = [*WORK_ORDERS, {"id": "WO-2026-0847", "project": "EX90"}]
    runs = [
        _run(
            OTHER_RUN,
            definition_id=DEFINITION,
            claimed_work_order_id="WO-2026-0847",
        )
    ]

    links = planning_main.decide_links(runs, work_orders, DEFINITIONS)

    assert links == [
        {"run_id": OTHER_RUN, "work_order_id": WORK_ORDER, "definition_id": DEFINITION}
    ]


# --- The push pass -------------------------------------------------------------


class Registry:
    """A stand-in registry. It records every call and answers what it is told."""

    def __init__(self, runs=None, total_pages=1, status=200):
        self.runs = runs if runs is not None else [_run()]
        self.total_pages = total_pages
        self.status = status
        self.calls: list[httpx.Request] = []
        self.pushed: list[dict] = []

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._answer)

    def _answer(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.status >= 400:
            return httpx.Response(self.status, json={"detail": "boom"})
        if request.url.path.endswith("/test-runs"):
            page = int(request.url.params.get("page", 1))
            items = self.runs if page == 1 else []
            return httpx.Response(
                200, json={"items": items, "total_pages": self.total_pages}
            )
        self.pushed.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "work_orders_mirrored": 1,
                "definitions_mirrored": 1,
                "links_applied": 1,
                "links_unchanged": 0,
                "links_rejected": [],
            },
        )


@pytest.fixture
def registry(monkeypatch):
    """A stand-in registry wired into the worker's transport seam."""
    stand_in = Registry()
    monkeypatch.setattr(planning_main, "TRANSPORT", stand_in.transport)
    monkeypatch.setenv(planning_main.TM_URL_VAR, REGISTRY_URL)
    monkeypatch.setenv(planning_main.TM_TOKEN_VAR, "test-token-not-a-secret")
    return stand_in


@pytest.fixture
def online(monkeypatch):
    """Put the switch on without going through the app."""
    monkeypatch.setitem(planning_main._state, "online", True)
    monkeypatch.setitem(planning_main._state, "work_orders", WORK_ORDERS)
    monkeypatch.setitem(planning_main._state, "test_definitions", DEFINITIONS)


def test_a_pass_posts_the_catalog_and_the_links(registry, online) -> None:
    # Pair-only planning (24 Aug 2026): the link comes from the run's CLAIM,
    # and the pushed definitions carry no plan of run ids.
    registry.runs = [_run(claimed_work_order_id=WORK_ORDER, claimed_definition_id=DEFINITION)]
    result = push_now()

    assert result["pushed"] is True
    assert result["runs"] == 1
    assert registry.pushed == [
        {
            "work_orders": WORK_ORDERS,
            "test_definitions": [{**DEFINITIONS[0], "run_ids": []}],
            "links": [
                {"run_id": RUN, "work_order_id": WORK_ORDER, "definition_id": DEFINITION}
            ],
        }
    ]


def test_the_pass_builds_the_url_without_doubling_the_prefix(registry, online) -> None:
    """`TM_API_URL` carries `/api/v1`, so no outbound path may append it again.

    A doubled `/api/v1/api/v1/...` answers 404 on every tick, and the push is
    the demo's only continuous sync. Pin the whole URL, both call sites.
    """
    push_now()

    urls = [str(call.url) for call in registry.calls]

    assert urls[0].startswith(f"{REGISTRY_URL}/test-runs?")
    assert urls[-1] == f"{REGISTRY_URL}/planning/sync"
    for url in urls:
        assert "/api/v1/api/v1" not in url


def test_the_pass_carries_the_bearer_token(registry, online) -> None:
    push_now()

    assert registry.calls[0].headers["authorization"] == "Bearer test-token-not-a-secret"


def test_the_pass_reads_only_the_waiting_runs(registry, online) -> None:
    push_now()

    assert registry.calls[0].url.params["status"] == "awaiting_work_order"


def test_the_pass_reads_every_page(registry, online) -> None:
    """A run no rule justifies stays first in the list for ever."""
    registry.total_pages = 3

    push_now()

    reads = [call for call in registry.calls if call.url.path.endswith("/test-runs")]
    assert [call.url.params["page"] for call in reads] == ["1", "2", "3"]


# --- Fail-soft -----------------------------------------------------------------


def test_an_offline_system_calls_nothing(monkeypatch, registry) -> None:
    """While the switch is off there are no calls at all, not even a read."""
    monkeypatch.setitem(planning_main._state, "online", False)

    result = push_now()

    assert result == {"pushed": False, "reason": planning_main.OFFLINE_DETAIL}
    assert registry.calls == []


def test_no_registry_address_calls_nothing(monkeypatch, registry, online) -> None:
    monkeypatch.delenv(planning_main.TM_URL_VAR)

    result = push_now()

    assert result["pushed"] is False
    assert registry.calls == []


def test_an_unreachable_registry_is_not_an_error(monkeypatch, online) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("the registry is down")

    monkeypatch.setattr(planning_main, "TRANSPORT", httpx.MockTransport(refuse))
    monkeypatch.setenv(planning_main.TM_URL_VAR, REGISTRY_URL)

    result = push_now()

    assert result["pushed"] is False
    assert planning_main._state["online"] is True, "a failed push never flips the switch"


def test_a_registry_error_is_not_an_error(registry, online) -> None:
    registry.status = 500

    result = push_now()

    assert result["pushed"] is False


def test_a_non_json_answer_is_not_an_error(monkeypatch, online) -> None:
    def junk(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>proxy error</html>")

    monkeypatch.setattr(planning_main, "TRANSPORT", httpx.MockTransport(junk))
    monkeypatch.setenv(planning_main.TM_URL_VAR, REGISTRY_URL)

    result = push_now()

    assert result["pushed"] is False


# --- The interval --------------------------------------------------------------


def test_the_interval_defaults_when_unset(monkeypatch) -> None:
    monkeypatch.delenv(planning_main.INTERVAL_VAR, raising=False)

    assert planning_main.push_interval_seconds() == planning_main.DEFAULT_INTERVAL_SECONDS


@pytest.mark.parametrize("value", ["not-a-number", "0", "-5"])
def test_a_nonsense_interval_reads_as_the_default(monkeypatch, value) -> None:
    monkeypatch.setenv(planning_main.INTERVAL_VAR, value)

    assert planning_main.push_interval_seconds() == planning_main.DEFAULT_INTERVAL_SECONDS


def test_a_test_can_set_the_interval_to_milliseconds(monkeypatch) -> None:
    monkeypatch.setenv(planning_main.INTERVAL_VAR, "0.01")

    assert planning_main.push_interval_seconds() == 0.01


# --- The worker, driven through the app ----------------------------------------


def _wait_for_a_push(stand_in: Registry, timeout: float = 5.0) -> bool:
    """Poll until the stand-in registry sees a push, or give up."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if stand_in.pushed:
            return True
        time.sleep(0.01)
    return False


def test_a_flip_to_online_pushes_without_waiting_for_a_tick(monkeypatch) -> None:
    """The demo beat is instant. The tick is an hour away in this test, so the
    push can only have come from the toggle waking the worker."""
    stand_in = Registry()
    # Pair-only planning: only a claimed run links, so the waiting run claims.
    stand_in.runs = [_run(claimed_work_order_id=WORK_ORDER, claimed_definition_id=DEFINITION)]
    monkeypatch.setattr(planning_main, "TRANSPORT", stand_in.transport)
    monkeypatch.setenv(planning_main.TM_URL_VAR, REGISTRY_URL)
    monkeypatch.setenv(planning_main.INTERVAL_VAR, "3600")

    with TestClient(planning_main.app) as client:
        assert not _wait_for_a_push(stand_in, timeout=0.2), "offline pushes nothing"

        client.post("/admin/state", json={"online": True})

        assert _wait_for_a_push(stand_in)

    assert stand_in.pushed[0]["links"][0]["run_id"] == RUN


def test_the_worker_pushes_on_its_timer(monkeypatch) -> None:
    stand_in = Registry()
    monkeypatch.setattr(planning_main, "TRANSPORT", stand_in.transport)
    monkeypatch.setenv(planning_main.TM_URL_VAR, REGISTRY_URL)
    monkeypatch.setenv(planning_main.INTERVAL_VAR, "0.01")

    with TestClient(planning_main.app) as client:
        client.post("/admin/state", json={"online": True})
        assert _wait_for_a_push(stand_in)
        before = len(stand_in.pushed)

        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and len(stand_in.pushed) <= before:
            time.sleep(0.01)

    assert len(stand_in.pushed) > before


def test_a_registry_that_is_down_never_takes_the_app_with_it(monkeypatch) -> None:
    """Fail-soft, proven through the app: the mock keeps answering its own routes."""
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("the registry is down")

    monkeypatch.setattr(planning_main, "TRANSPORT", httpx.MockTransport(refuse))
    monkeypatch.setenv(planning_main.TM_URL_VAR, REGISTRY_URL)
    monkeypatch.setenv(planning_main.INTERVAL_VAR, "0.01")

    with TestClient(planning_main.app) as client:
        client.post("/admin/state", json={"online": True})
        time.sleep(0.2)

        assert client.get("/health").json() == {"status": "ok"}
        assert client.get("/admin/state").json() == {"online": True}
        assert client.get("/api/v1/work-orders").status_code == 200
