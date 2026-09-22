"""Sort parameter machinery for the four list endpoints.

Contract §2.3: two params per list endpoint. ``sort`` is a per-endpoint enum
of wire field names; ``order`` is ``asc`` or ``desc``. Unknown values raise
422 ``validation_error`` (never a silent fallback), matching the contract
error shape with a ``["query", "sort"|"order"]`` loc.

Kept out of ``models/common.py`` because that file is frozen after the base
(BE-lead-only). Each list router imports its dependency from here.
"""

from typing import Annotated

from fastapi import Query
from pymongo import ASCENDING, DESCENDING


class ResolvedSort:
    """Resolved (field, direction) with a Mongo-friendly translator."""

    def __init__(self, key: str, order: str, mongo_field: str):
        self.key = key
        self.order = order
        self.mongo_field = mongo_field

    @property
    def direction(self) -> int:
        return ASCENDING if self.order == "asc" else DESCENDING

    def as_mongo(self, tiebreak_field: str = "_id") -> list[tuple[str, int]]:
        """Sort spec with a deterministic ``_id asc`` tiebreak appended.

        A tiebreak keeps pagination correct when the primary sort key ties.
        The tiebreak is dropped when the primary field is already ``_id``.
        """
        spec = [(self.mongo_field, self.direction)]
        if self.mongo_field != tiebreak_field:
            spec.append((tiebreak_field, ASCENDING))
        return spec


class QuerySortError(Exception):
    """422 for a bad ``sort`` / ``order`` query param on a list endpoint.

    Serialized by ``api/errors.py`` into the standard error envelope with
    ``code="validation_error"`` and a populated ``errors`` list whose
    ``loc`` is ``["query", param]`` — matching the shape FastAPI's own
    422 handler produces for typed params.
    """

    def __init__(self, param: str, value: str | None, allowed: str):
        self.param = param
        self.value = value
        self.allowed = allowed
        super().__init__(f"{param}: must be one of {allowed}")


def sort_params(
    *,
    whitelist: tuple[str, ...],
    default_key: str,
    default_directions: dict[str, str],
    field_map: dict[str, str] | None = None,
):
    """Build a FastAPI dependency that resolves ``sort`` + ``order``.

    ``whitelist``: allowed sort keys (wire field names).
    ``default_key``: the sort key applied when the caller sends none.
    ``default_directions``: per-key default order (``asc`` | ``desc``).
    ``field_map``: optional wire-key -> Mongo-field mapping. Default is
    identity; the signals endpoint maps ``name`` -> ``_id``.
    """
    field_map = field_map or {}

    def dependency(
        sort: Annotated[str | None, Query()] = None,
        order: Annotated[str | None, Query()] = None,
    ) -> ResolvedSort:
        if sort is not None and sort not in whitelist:
            raise QuerySortError("sort", sort, ", ".join(whitelist))
        if order is not None and order not in ("asc", "desc"):
            raise QuerySortError("order", order, "asc, desc")
        key = sort if sort is not None else default_key
        resolved_order = order if order is not None else default_directions[key]
        mongo_field = field_map.get(key, key)
        return ResolvedSort(key=key, order=resolved_order, mongo_field=mongo_field)

    return dependency


def reject_sort_params(
    sort: Annotated[str | None, Query()] = None,
    order: Annotated[str | None, Query()] = None,
) -> None:
    """Reject any ``sort`` or ``order`` on endpoints that carry no sort.

    Contract §2.3 (decision box 2, closed): ``/work-orders`` has no sort
    params; sending either → 422 ``validation_error``. The ``light
    treatment`` on work-orders means no sort even by mistake.
    """
    if sort is not None:
        raise QuerySortError("sort", sort, "not accepted for this endpoint")
    if order is not None:
        raise QuerySortError("order", order, "not accepted for this endpoint")
