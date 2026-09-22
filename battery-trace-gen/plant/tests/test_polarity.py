"""Red-first pin of the plant's current-sign polarity.

Validates spec.md §3.0 ("Defect 0 — current-sign mismatch inside the plant"):
``solve_dc_current`` returns powertrain-sign current (``P < 0`` on discharge
=> ``I < 0``), while ``dc_voltage = ocv - R0*I - v_rc1 - v_rc2`` and both RC
updates assume battery-sign current (discharge positive). PLANT_ORIGIN's
patch negates ``dc_current`` immediately after the solver so the
terminal-voltage formula and both RC updates become correct by construction.

Drives ``plant/main.py`` through ``plant/loader.py``'s headless harness and
asserts, under sustained discharge, ``dc_voltage_v < ocv_v`` and
``dc_current_a > 0``; under sustained charge, the reverse. This must be GREEN
against the patched ``plant/main.py`` shipped here. It is RED against the
pristine ``cae68bd7`` ``main.py`` — see
``dev-planning/battery-can-traces/test-report-round1.md`` for the pinned
RED/GREEN numbers captured from both the pristine plant and the independent
fix in ``quixstreams-tests-polarity``.
"""

from plant import loader

DISCHARGE_POWER_W = -78_000.0  # ~-100 A at the ~780 V, 50 % SOC starting OCV
CHARGE_POWER_W = 78_000.0
SETTLE_TICKS = 60  # 6 s at SAMPLE_TIME=0.1 s, >= 6*TAU1 (TAU1=1 s) for RC1 to settle


def _sustained_payload(requested_power_w: float) -> dict:
    """Drive the plant ``SETTLE_TICKS`` ticks under a constant power setpoint."""
    handle = loader.load(params={}, module_overrides={})
    payloads: list[dict] = []

    def on_tick(_k: int, payload: dict) -> dict:
        payloads.append(payload)
        return {}

    loader.drive(
        handle,
        ticks=SETTLE_TICKS,
        initial_cmd={"requested_power_w": requested_power_w},
        soc_pct=50.0,
        t_batt_c=25.0,
        on_tick=on_tick,
    )
    return payloads[-1]


def test_discharge_pulls_terminal_voltage_below_ocv():
    """Validates spec.md §3.0: sustained discharge sags dc_voltage_v below ocv_v."""
    payload = _sustained_payload(DISCHARGE_POWER_W)
    assert payload["dc_voltage_v"] < payload["ocv_v"], (
        f"dc_voltage_v={payload['dc_voltage_v']} not below ocv_v={payload['ocv_v']}"
    )


def test_discharge_current_is_positive_in_battery_convention():
    """Validates spec.md §3.0/§4: battery sign, discharge => dc_current_a > 0."""
    payload = _sustained_payload(DISCHARGE_POWER_W)
    assert payload["dc_current_a"] > 0, (
        f"dc_current_a={payload['dc_current_a']} not positive"
    )


def test_charge_lifts_terminal_voltage_above_ocv():
    """Validates spec.md §3.0: sustained charge lifts dc_voltage_v above ocv_v."""
    payload = _sustained_payload(CHARGE_POWER_W)
    assert payload["dc_voltage_v"] > payload["ocv_v"], (
        f"dc_voltage_v={payload['dc_voltage_v']} not above ocv_v={payload['ocv_v']}"
    )


def test_charge_current_is_negative_in_battery_convention():
    """Validates spec.md §3.0/§4: battery sign, charge => dc_current_a < 0."""
    payload = _sustained_payload(CHARGE_POWER_W)
    assert payload["dc_current_a"] < 0, (
        f"dc_current_a={payload['dc_current_a']} not negative"
    )
