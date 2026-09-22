"""Work-order mirror models and planning-sync models (Lane A surface)."""

from typing import Literal

from pydantic import ConfigDict, Field, model_validator

from api.models.common import ApiModel, Page, RequestModel, UtcDatetime
from api.models.runs import check_custom_properties

WorkOrderStatus = Literal["active", "closed"]
DefinitionStatus = Literal["on_plan", "awaiting_data"]


class WorkOrderRow(ApiModel):
    # Mirror docs store the planning id in _id. The wire keeps "wo_id".
    wo_id: str = Field(validation_alias="_id")
    title: str
    project: str
    status: WorkOrderStatus
    definition_count: int
    run_count: int
    synced_at: UtcDatetime


class WorkOrderViewCounts(ApiModel):
    """Whole-table, filter-independent quick-view counts for /work-orders."""

    all: int
    active: int
    closed: int


class WorkOrderPage(Page[WorkOrderRow]):
    """/work-orders response envelope. ``view_counts`` optional per §3.6."""

    view_counts: WorkOrderViewCounts | None = None


class WorkOrderFacets(ApiModel):
    """The distinct filter values of the whole mirror (contract #10b).

    Same reasoning as ``SignalFacets`` (#14b): a project list built from one
    page of ``/work-orders`` misses every value outside that page.
    """

    projects: list[str]


class WorkOrderDefinition(ApiModel):
    td_id: str = Field(validation_alias="_id")
    title: str
    planned_runs: int
    actual_runs: int
    status: DefinitionStatus


class TestDefinitionRow(ApiModel):
    """One row of the definition list (TR-001).

    Planning owns `title`, `work_order_id`, `planned_runs` and `synced_at`.
    `actual_runs`, `status` and `orphaned` derive at read time.
    """

    td_id: str = Field(validation_alias="_id")
    title: str
    work_order_id: str | None
    planned_runs: int
    actual_runs: int
    status: DefinitionStatus
    # True when the row names no work order, or names one the mirror does not
    # hold. The workbook asks the screen to flag exactly this row for review.
    orphaned: bool
    synced_at: UtcDatetime


class TestDefinitionPage(Page[TestDefinitionRow]):
    """/test-definitions response envelope.

    It carries no view counts: the Home summary already reports the whole-table
    orphan count, so a second count on this page would say the same thing twice.
    """


class WorkOrderRun(ApiModel):
    run_id: str = Field(validation_alias="_id")
    definition_id: str | None
    rig_id: str
    test_cell: str | None
    first_data_at: UtcDatetime
    file_count: int
    signal_count: int
    status: Literal["complete", "awaiting_work_order", "invalid"]


class DefinitionWorkOrder(ApiModel):
    """The work order a definition belongs to, as the detail screen shows it.

    It is null on an orphan. The mirror stays read-only, so the registry never
    creates a work order to repair the link.
    """

    wo_id: str = Field(validation_alias="_id")
    title: str
    project: str
    status: WorkOrderStatus


def default_render_markdown(name: str) -> bool:
    """Read the markdown default off the document name.

    A `.md` name renders as markdown. Every other name renders as plain text.
    The name is the only signal the registry holds, and a person who names a
    document `acceptance-criteria.md` asks for markdown by that act.

    The POST route, the multipart route and the detail read all call this, so
    one rule sets the default everywhere. A document stored before the flag
    existed carries no key, and the detail read then applies this rule to it.
    """
    return name.strip().lower().endswith(".md")


class RequirementsFile(ApiModel):
    """One requirements document of a test definition.

    Two sources put one here. Planning sends a document with the definition,
    and a person uploads one in the Test Manager. `source` names which, and
    `updated_by` names the person. Planning is never a person, so a planning
    document reads null there.

    A name is unique inside one source, never inside the definition. A person
    may upload a document under the name of a planning document. Both stay
    stored, and the manual one sorts first.

    **A document holds text or bytes, never both.**

    * A TEXT document carries `content` (UTF-8, markdown or plain) and
      `render_markdown`. `storage_ref` is null.
    * A BINARY document carries `storage_ref`, `content_type` and `size_bytes`.
      `content` is the empty string, and `render_markdown` is null: bytes carry
      no markdown, so the screen shows no switch for one. The bytes live in
      blob storage, and `GET .../requirements-files/{name}/download` streams
      them back.

    `content_type` is the type the browser stated at upload. **It is a display
    label only.** No route and no screen reads it to pick a code path that
    touches the bytes.
    """

    name: str
    content: str = ""
    source: Literal["planning", "manual"]
    updated_at: UtcDatetime
    updated_by: str | None
    render_markdown: bool | None = None
    storage_ref: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None


class TestDefinitionDetail(TestDefinitionRow):
    """One definition, with its work order and the runs that carry it.

    It extends the list row, so a field never reads one way on the list and
    another way on the detail. `runs` uses the same row shape the work-order
    detail lists a run in.

    `requirements_files` is a detail-only field. The list row carries no
    document, so a page of 200 rows stays the size it was.
    """

    work_order: DefinitionWorkOrder | None
    runs: list[WorkOrderRun]
    requirements_files: list[RequirementsFile] = Field(default_factory=list)
    # Free key and value pairs a person types, the same map a run carries.
    # They live in their own store beside the mirror, so a sync pass never
    # reaches them. Defaulted, because a definition mirrored before this field
    # existed carries none.
    custom_properties: dict[str, str] = Field(default_factory=dict)


class DefinitionCustomProperties(ApiModel):
    """The manual property map of one definition, as the write route answers it.

    The write route answers the map alone and never the whole detail. The
    detail also carries the runs, and a property edit changes no run.
    """

    custom_properties: dict[str, str]


class DefinitionCustomPropertiesRequest(RequestModel):
    """Body of PATCH /test-definitions/{td_id}/custom-properties.

    The whole map, never a merge. An empty object clears every property. The
    body states no actor: the route reads the verified caller, exactly as the
    two requirements-document routes do.
    """

    custom_properties: dict[str, str]
    note: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _check_custom_properties(cls, data):
        # The checks run before Pydantic coerces the map, so each refusal keeps
        # its own machine code. The run route uses the same checker.
        if isinstance(data, dict) and isinstance(data.get("custom_properties"), dict):
            check_custom_properties(data["custom_properties"])
        return data


class WorkOrderDetail(ApiModel):
    wo_id: str = Field(validation_alias="_id")
    title: str
    project: str
    status: WorkOrderStatus
    requestor: str | None
    department: str | None
    priority: str | None
    created_at_source: UtcDatetime | None
    synced_at: UtcDatetime
    definitions: list[WorkOrderDefinition]
    runs: list[WorkOrderRun]


class SyncResult(ApiModel):
    work_orders: int
    definitions: int
    runs_backfilled: int


class PlanningSyncStatus(ApiModel):
    online: bool
    last_sync_at: UtcDatetime | None
    last_sync_result: SyncResult | None
    work_orders_mirrored: int


class PlanningSyncToggleResponse(PlanningSyncStatus):
    """The toggle answers the status body (contract #20) and nothing more.

    It carried `demo_reset: true` until 20 Aug 2026. The toggle deleted rows
    then. It only stops the sync now, so no answer reports a reset.
    """


class ToggleRequest(RequestModel):
    online: bool


# --- POST /planning/sync — the inbound push (PROPOSED) ---
#
# Planning calls the registry here. The catalog shapes below name exactly the
# fields `planning_sync._mirror_work_orders` and `_mirror_definitions` read, so
# a pushed row and a fetched row mirror identically. They ALLOW extra keys,
# unlike every other request model: the mirror stores the payload verbatim
# under `raw` for audit, and planning owns what else rides along. The envelope
# itself still forbids an unknown key, so a typo in our own shape is a 422.


class PushedWorkOrder(ApiModel):
    """One work order as planning states it."""

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    id: str
    title: str | None = None
    project: str | None = None
    # Not the WorkOrderStatus literal on purpose. The mirror stores whatever
    # planning says, exactly as the outbound fetch did; narrowing it here would
    # refuse a whole push over one row the read models would refuse anyway.
    status: str | None = None
    requestor: str | None = None
    department: str | None = None
    priority: str | None = None
    created_at: UtcDatetime | None = None


class PushedRequirementsFile(RequestModel):
    """One requirements document as planning states it.

    Planning states the name and the text. The registry states the rest: the
    source is always `planning`, and a planning document names no person.

    This shape forbids an unknown key, unlike the definition around it. The
    registry reads both fields, so a typo here loses a document silently.
    """

    name: str
    content: str


class PushedDefinition(ApiModel):
    """One test definition as planning states it.

    `run_ids` is not declared, because the mirror never mapped it. It rides
    along as an extra key into `raw`: planning decides the links now and sends
    them in `links`, so the registry no longer reads the plan to find them.

    `requirements_files` is optional. Planning owns the list it sends, exactly
    as it owns the title, so a push replaces the planning documents of that
    definition. It never reaches a document a person uploaded.
    """

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    id: str
    work_order_id: str | None = None
    title: str | None = None
    planned_runs: int | None = None
    requirements_files: list[PushedRequirementsFile] = Field(default_factory=list)


class PushedLink(RequestModel):
    """One run→work-order decision planning made.

    `definition_id` is optional: planning may know which work order a run
    fulfils without knowing which definition planned it.
    """

    run_id: str
    work_order_id: str
    definition_id: str | None = None


class PlanningPushRequest(RequestModel):
    """Body of POST /planning/sync. Every list is optional.

    An empty body is a legal pass. A planning system with nothing to say still
    says it, and the registry answers with three zeroes.
    """

    work_orders: list[PushedWorkOrder] = Field(default_factory=list)
    test_definitions: list[PushedDefinition] = Field(default_factory=list)
    links: list[PushedLink] = Field(default_factory=list)


class RequirementsFileUpload(RequestModel):
    """Body of POST /test-definitions/{td_id}/requirements-files.

    The caller states the name, the text and how to render it. The server sets
    the source, the moment and the actor, so a caller can never claim to be a
    planning document or another person.

    `render_markdown` is optional. An absent value takes the default off the
    name (:func:`default_render_markdown`).
    """

    name: str
    content: str
    render_markdown: bool | None = None


class RequirementsFileEdit(RequestModel):
    """Body of PATCH /test-definitions/{td_id}/requirements-files/{name}.

    The caller states the new text, and it may state a new `render_markdown`.
    It states **no name**: the name is the identity of the document, and the
    path carries it. A rename is a different operation, and this registry has
    none. The model forbids an extra key, so a body that carries `name`
    answers 422 and nothing moves.

    An absent `render_markdown` keeps the stored flag. An edit of the text
    alone therefore never changes how the screen renders the document.
    """

    content: str
    render_markdown: bool | None = None


class RejectedLink(ApiModel):
    """One link the registry refused, and why."""

    run_id: str
    reason: str


class PlanningPushResponse(ApiModel):
    """What the push changed.

    `links_unchanged` is the idempotency signal: a re-post of the same links
    lands entirely here, and nothing is written or journalled.
    """

    work_orders_mirrored: int
    definitions_mirrored: int
    links_applied: int
    links_unchanged: int
    links_rejected: list[RejectedLink]
