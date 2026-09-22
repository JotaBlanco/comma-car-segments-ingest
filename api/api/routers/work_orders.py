"""Contract #10 and #11. Owner: Lane A. Read-only mirror — no write routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pymongo.database import Database

from api.db import get_db
from api.models.common import Pagination, Source, pagination_params
from api.models.planning import (
    WorkOrderDetail,
    WorkOrderFacets,
    WorkOrderPage,
    WorkOrderStatus,
)
from api.models.sorting import reject_sort_params
from api.services import queries_runs

router = APIRouter(tags=["work-orders"])


@router.get("/work-orders")
def list_work_orders(
    db: Annotated[Database, Depends(get_db)],
    pagination: Annotated[Pagination, Depends(pagination_params())],
    # Decision box 2 (closed): #10 gets no sort/order params. Sending
    # either → 422. Kept as a dependency (not a body validator) so the
    # 422 fires before any Mongo work.
    _reject_sort: Annotated[None, Depends(reject_sort_params)],
    status: Annotated[list[WorkOrderStatus] | None, Query()] = None,
    project: Annotated[list[str] | None, Query()] = None,
    source: Annotated[list[Source] | None, Query()] = None,
    q: str | None = None,
) -> WorkOrderPage:
    """List the mirrored work orders. Every filter is real.

    Multi-value ``status``/``project`` via repeated params (§2.2).
    `definition_count` and `run_count` derive at read time. The header's
    "synced_at" line comes from /planning-sync/status, not this envelope.

    ``source`` answers TR-011. It reads the ``field_sources`` map of the row,
    so a document matches when at least one of its fields carries one of the
    named tags. A document the server never tagged matches no source.
    """
    return queries_runs.list_work_orders(
        db,
        pagination,
        status=status,
        project=project,
        source=[value.value for value in source or []],
        q=q,
    )


# This route must stay ABOVE ``GET /work-orders/{wo_id}``. FastAPI matches
# the routes in declaration order, so a later position would read "facets" as
# a work-order id and answer 404.
@router.get("/work-orders/facets")
def get_work_order_facets(db: Annotated[Database, Depends(get_db)]) -> WorkOrderFacets:
    """The distinct filter values of the whole mirror (contract #10b).

    The screen used to hard-code its project list, so a new mirrored project
    never reached the filter. This route reads every document instead — same
    reasoning as ``GET /signals/facets`` (#14b).
    """
    return queries_runs.work_order_facets(db)


@router.get("/work-orders/{wo_id}")
def get_work_order(
    wo_id: str,
    db: Annotated[Database, Depends(get_db)],
) -> WorkOrderDetail:
    """Serve the whole work-order screen: definitions plus the runs rollup."""
    return queries_runs.get_work_order_detail(db, wo_id)
