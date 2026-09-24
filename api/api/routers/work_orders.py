"""Contract #10 and #11. Owner: Lane A. The reads, plus the three writes.

Planning owns the CONTENT of the campaigns it pushes — title, project,
requestor — and no route edits one of those in place. Three writes live here:
a person OPENS a work order the planning system never knew about, CLOSES one
that has finished, or DELETES one no run names.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pymongo.database import Database

from api.auth import journal_actor_or_id, require_token
from api.db import get_db
from api.models.common import Pagination, Source, pagination_params
from api.models.planning import (
    WorkOrderCreateRequest,
    WorkOrderDeletionReport,
    WorkOrderDetail,
    WorkOrderFacets,
    WorkOrderPage,
    WorkOrderStatus,
    WorkOrderStatusRequest,
)
from api.models.sorting import reject_sort_params
from api.quix_identity import Identity
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
    """List the work orders, mirrored or opened here. Every filter is real.

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


@router.post("/work-orders", status_code=201)
def create_work_order(
    body: WorkOrderCreateRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> WorkOrderDetail:
    """Open a work order from the Test Manager. Refuses `wo_exists` (409).

    For a campaign the planning system never knew about — the case a bench
    upload used to leave with nowhere to land. The row is written at `manual`,
    so it is not a planning row and no sync pass owns it.
    """
    return queries_runs.create_work_order(
        db, body, actor=journal_actor_or_id(identity, identity.display_name)
    )


@router.patch("/work-orders/{wo_id}")
def patch_work_order(
    wo_id: str,
    body: WorkOrderStatusRequest,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> WorkOrderDetail:
    """Set the status of a work order: `closed` ends the campaign, `active` reopens it.

    The status is the one field a PATCH moves; the body names it alone and an
    unknown key answers 422. The write is tagged `manual`
    and journalled as `work_order.status`. An unknown id is 404 `wo_not_found`,
    and a status that already reads what the caller asked for writes nothing.
    """
    return queries_runs.set_work_order_status(
        db, wo_id, body.status, actor=journal_actor_or_id(identity, identity.display_name)
    )


@router.delete("/work-orders/{wo_id}")
def delete_work_order(
    wo_id: str,
    db: Annotated[Database, Depends(get_db)],
    identity: Annotated[Identity, Depends(require_token)],
) -> WorkOrderDeletionReport:
    """Delete a work order and the test definitions under it. There is no undo.

    A work order any test run names is refused 409 `work_order_has_runs`, so a
    campaign that holds evidence cannot leave by accident; an unknown id is 404
    `wo_not_found`. `queries_runs.delete_work_order` owns the order.
    """
    # A person pressed Delete, so the actor is the verified caller.
    return queries_runs.delete_work_order(
        db, wo_id, actor=journal_actor_or_id(identity, identity.display_name)
    )
