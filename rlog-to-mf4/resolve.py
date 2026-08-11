"""Resolve platform and CAN database from the data, not from configuration.

Platform is a property of the recording, so it is looked up rather than
configured. A comma device can be moved between cars - 177 of the 5,146 device
ids in this dataset appear under more than one platform - so device alone is not
a valid key. A route is one drive in one car, so `device/route` always is.

Three tables ship with the app (regenerate with scratchpad/gen_maps.py):

    device_platform.json   device -> platform, unambiguous devices only
    route_platform.json    "device/route" -> platform, for the ambiguous ones
    platform_dbc.json      platform -> {bus: dbc name}, from opendbc

DBC bodies live in dbc/ and are embedded into the MF4 so the file opens
standalone in a viewer. The pipeline itself does not depend on the embed: the
replay resolves the database from DCM using the target_key stamped in the
header.
"""

from __future__ import annotations

import json
import logging
import os

logger = logging.getLogger(__name__)

HERE = os.path.dirname(os.path.abspath(__file__))
DBC_DIR = os.path.join(HERE, "dbc")

# Bus roles that carry the vehicle-state database, in preference order. `pt` is
# the powertrain bus for nearly every brand; Tesla names its main bus `party`
# and comma's own body uses `main`.
PT_ROLES = ("pt", "party", "main")


def _load(name: str) -> dict:
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        logger.warning("%s missing - platform resolution will fail", name)
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


class Resolver:
    """Maps a recording to (platform, dbc name, dbc bytes)."""

    def __init__(self) -> None:
        self.device_platform = _load("device_platform.json")
        self.route_platform = _load("route_platform.json")
        self.platform_dbc = _load("platform_dbc.json")
        self._dbc_cache: dict[str, bytes] = {}
        logger.info(
            "resolver: %d devices, %d disambiguated routes, %d platforms with a DBC",
            len(self.device_platform),
            len(self.route_platform),
            len(self.platform_dbc),
        )

    def platform_for(self, device: str, route: str) -> str | None:
        """Route-level first: it is the only key valid for a device that moved."""
        return self.route_platform.get(f"{device}/{route}") or self.device_platform.get(
            device
        )

    def dbc_name_for(self, platform: str) -> str | None:
        buses = self.platform_dbc.get(platform) or {}
        for role in PT_ROLES:
            if role in buses:
                return buses[role]
        return None

    def dbc_bytes(self, name: str) -> bytes | None:
        """DBC body for embedding. None when the file is not bundled."""
        if name in self._dbc_cache:
            return self._dbc_cache[name]
        path = os.path.join(DBC_DIR, f"{name}.dbc")
        if not os.path.exists(path):
            return None
        with open(path, "rb") as fh:
            data = fh.read()
        self._dbc_cache[name] = data
        return data

    def devices_for_platforms(self, platforms: list[str]) -> list[str]:
        """Every device that ever recorded one of these platforms."""
        wanted = set(platforms)
        devs = {d for d, p in self.device_platform.items() if p in wanted}
        devs |= {
            k.split("/")[0] for k, p in self.route_platform.items() if p in wanted
        }
        return sorted(devs)

    def resolve(self, device: str, route: str):
        """Return (platform, dbc_name, dbc_bytes) or None with a reason logged."""
        platform = self.platform_for(device, route)
        if not platform:
            return None, None, None, "unknown-platform"
        dbc_name = self.dbc_name_for(platform)
        if not dbc_name:
            return platform, None, None, "no-dbc-for-platform"
        body = self.dbc_bytes(dbc_name)
        if body is None:
            return platform, dbc_name, None, "dbc-not-bundled"
        return platform, dbc_name, body, None
