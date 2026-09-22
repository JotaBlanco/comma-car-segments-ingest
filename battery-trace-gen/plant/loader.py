"""Drive the vendored plant headlessly, one tick at a time.

``main.py`` builds an ``Application`` only under ``__main__``, so importing it is safe;
the pattern below is the one the plant's own ``tests/conftest.py`` uses — pop ``main``
from ``sys.modules``, import it fresh, and run the real ``run_simulation`` against a
fake producer. Two things are different here:

* ``main.time`` is replaced with a shim whose ``sleep`` is the host's turn. The plant
  produces a payload and then sleeps, so the sleep hook is exactly the boundary between
  tick k and tick k+1 and the whole run is single-threaded and deterministic.
* ``run_simulation`` keeps ``q_act``, ``heat``, ``v_rc1`` and ``v_rc2`` as function
  locals, not module globals, so initial SOC and pack temperature cannot be assigned
  directly. They are primed instead through the two module-level quantities the
  function derives them from — ``Q_MAX`` (``q_act = Q_MAX / 2``) and ``A_THERMAL``
  (``temperature = A_THERMAL * heat`` with ``heat`` starting at 100 kJ) — and both are
  put back inside ``get_producer()``, which the function calls after initialising its
  state and before its first tick. Restoring ``A_THERMAL`` there triggers the plant's
  own documented heat rebase on tick 0, so temperature is continuous and every tick
  runs with the scenario's real thermal mass.
"""

from __future__ import annotations

import importlib
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

PLANT_DIR = Path(__file__).resolve().parent

#: ``run_simulation``'s own starting value for the heat state, in joules.
INITIAL_HEAT_J = 100_000.0

TickCallback = Callable[[int, dict[str, Any]], dict[str, float]]


class _StopSimulation(Exception):
    """Raised from the sleep hook to leave ``run_simulation``'s infinite loop."""


@dataclass(frozen=True)
class PlantHandle:
    module: ModuleType
    dt_s: float
    q_max_as: float
    effective_params: dict[str, float]


class _Topic:
    name = "battery-trace-gen"

    def serialize(self, key: str, value: dict[str, Any]) -> SimpleNamespace:
        return SimpleNamespace(key=key, value=value)


class _Driver:
    """A ``get_producer()``-compatible fake that runs the host's work between ticks."""

    def __init__(
        self,
        module: ModuleType,
        *,
        ticks: int,
        on_tick: TickCallback,
        restore: Callable[[], None],
    ) -> None:
        self._module = module
        self._ticks = ticks
        self._on_tick = on_tick
        self._restore = restore
        self._tick = 0
        self._pending: dict[str, float] = {}
        self.topic = _Topic()

    def get_producer(self) -> _Driver:
        self._restore()
        return self

    def __enter__(self) -> _Driver:
        return self

    def __exit__(self, *exc_info: object) -> bool:
        return False

    def produce(self, topic: str, value: dict[str, Any], key: str) -> None:
        self._pending = self._on_tick(self._tick, value)

    def sleep(self, _seconds: float) -> None:
        self._tick += 1
        if self._tick >= self._ticks:
            raise _StopSimulation
        with self._module.state_lock:
            self._module.cmd.update(self._pending)


def load(params: dict[str, float], module_overrides: dict[str, Any]) -> PlantHandle:
    """Import the plant fresh and apply one scenario's parameter set.

    Writing ``main.params`` directly bypasses the lexicon validation, which only guards
    the wire path; that is how ``MAX_BATTERY_TEMP = 65`` and ``TAU2 = 900`` get in.
    """
    if str(PLANT_DIR) not in sys.path:
        sys.path.insert(0, str(PLANT_DIR))
    sys.modules.pop("main", None)
    module = importlib.import_module("main")

    for name, value in module_overrides.items():
        setattr(module, name, value)

    with module.state_lock:
        module.params.update(params)
        module._recompute_derived()

    return PlantHandle(
        module=module,
        dt_s=module.SAMPLE_TIME,
        q_max_as=module.Q_MAX,
        effective_params={
            name: value
            for name, value in module.params.items()
            if not name.startswith("_")
        },
    )


def drive(
    handle: PlantHandle,
    *,
    ticks: int,
    initial_cmd: dict[str, float],
    soc_pct: float,
    t_batt_c: float,
    on_tick: TickCallback,
) -> None:
    """Run ``ticks`` ticks of the real ``run_simulation``.

    ``on_tick(k, payload)`` receives each published payload and returns the setpoints
    the plant applies on tick k+1 — a deterministic 100 ms actuation delay.
    """
    module = handle.module
    nominal_a_thermal = module.params["A_THERMAL"]

    with module.state_lock:
        module.cmd.update(initial_cmd)
        module.params["A_THERMAL"] = t_batt_c / INITIAL_HEAT_J
        module._recompute_derived()
    module.Q_MAX = 2.0 * (soc_pct / 100.0 * handle.q_max_as)

    def restore() -> None:
        module.Q_MAX = handle.q_max_as
        with module.state_lock:
            module.params["A_THERMAL"] = nominal_a_thermal
            module._recompute_derived()

    driver = _Driver(module, ticks=ticks, on_tick=on_tick, restore=restore)
    module.time = SimpleNamespace(sleep=driver.sleep, monotonic=time.monotonic)

    try:
        module.run_simulation(driver, driver.topic)
    except _StopSimulation:
        return
