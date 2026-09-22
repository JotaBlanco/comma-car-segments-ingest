"""Demo-critical sync pins — OVERLAY file (scripts/sync.config.json keeps it).

These two pins lived in the mirrored test_sync_endpoints.py for six hours on
25 Aug 2026 before a sync wiped them together with the quiet-wake behaviour
they pin — the exact silent-loss class they exist to catch. Demo-owned file
now, so the mirror can never take them again.
"""

from api import planning_sync


def test_the_trigger_never_overrides_a_recorded_on_switch(client, routed_db, planning_offline) -> None:
    """A toggle-on that lands mid-pass — or a mock restarted under a recorded
    ON switch — owns the switch: the trigger's blind restore used to flip
    planning back off, leaving the 30 s worker dead under a Home tile still
    reading on (25 Aug 2026)."""
    planning_sync.record_switch(routed_db, True)  # recorded ON, live OFF

    client.post("/api/v1/planning-sync/trigger")

    assert planning_offline.get("/admin/state").json()["online"] is True


def test_the_trigger_and_toggle_wake_planning_quietly(client, routed_db, planning_offline, monkeypatch) -> None:
    """The wake is {'online': True, 'wake': False} EXACTLY: a woken worker's
    own push once raced the trigger's pass and the strip read "0 links"
    right after a successful adoption (25 Aug 2026). Pinned for BOTH the
    trigger and the toggle — the two callers that wake planning."""
    seen = []
    real_post = planning_offline.post

    def spying_post(url, **kwargs):
        if url == "/admin/state":
            seen.append(kwargs.get("json"))
        return real_post(url, **kwargs)

    monkeypatch.setattr(planning_offline, "post", spying_post)

    client.post("/api/v1/planning-sync/trigger")
    assert {"online": True, "wake": False} in seen, seen

    seen.clear()
    client.post("/api/v1/planning-sync/toggle", json={"online": True})
    assert {"online": True, "wake": False} in seen, seen
    client.post("/api/v1/planning-sync/toggle", json={"online": False})


def test_the_mock_honors_the_quiet_wake(planning_offline, monkeypatch) -> None:
    """The mock half of the same contract: wake:false flips the switch
    WITHOUT the immediate worker kick — the sync-reverted half that made the
    other two pins pass while the behaviour was gone. The kick is spied, not
    the event: the worker shares the test's loop and consumes a set event
    before an assertion can read it."""
    from mock_planning import main as planning_main

    kicks: list[int] = []
    monkeypatch.setattr(planning_main, "_kick", lambda: kicks.append(1))

    planning_offline.post("/admin/state", json={"online": True, "wake": False})
    assert not kicks, "a quiet wake must not kick the worker"

    planning_offline.post("/admin/state", json={"online": True})
    assert kicks, "a plain toggle-on kicks the worker at once"
    planning_offline.post("/admin/state", json={"online": False})
