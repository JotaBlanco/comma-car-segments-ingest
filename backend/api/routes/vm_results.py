"""V-model results, coverage matrix and the traceability chain.

Backward traceability always reads ``vm_baselines.req_links`` - the index frozen at baseline
creation - never an ad-hoc scan of test specifications at request time. Forward traceability
reads ``covers_req_ids`` / ``tc_id`` / ``run_id`` off the documents themselves. Empty
relationships are returned as empty arrays, never omitted, so the UI can say "none" in words
rather than rendering a blank region.
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from pymongo.database import Database

from ..auth import read_permission
from ..models import PaginatedResponse
from ..models_vmodel_chain import ResultQuery, TestResult
from ..mongo import get_mongo

router = APIRouter()

RETIRED_STATUSES = {"Obsolete", "Rejected"}

# Worst-case wins when several runs verdict the same (requirement, test case) pair: one FAIL
# is a failure however many runs passed. INCONCLUSIVE never outranks a real measurement.
VERDICT_PRECEDENCE = ("FAIL", "PASS", "INCONCLUSIVE", "NOT_RUN")


class CoverageCell(BaseModel):
    """One (requirement, test case) cell of the coverage matrix."""

    tc_id: str
    verdict: str
    run_count: int = 0


class CoverageRow(BaseModel):
    """One requirement row of the coverage matrix."""

    req_id: str
    title: str = ""
    status: str = ""
    retired: bool = Field(False, description="status is Obsolete or Rejected")
    verification_tag: str = ""
    covered: bool = False
    verdict: str = "NOT_RUN"
    cells: list[CoverageCell] = Field(default_factory=list)


class CoverageMatrix(BaseModel):
    """The coverage payload: rows of requirements, columns of test cases, verdict cells."""

    baseline_id: str
    requirements_version: str
    counts: dict[str, int]
    coverage_pct: float
    test_case_ids: list[str] = Field(default_factory=list)
    rows: list[CoverageRow] = Field(default_factory=list)


class ChainNode(BaseModel):
    """One item in the V-chain, in the minimal shape the chain bar and the lists need."""

    kind: str
    key: str
    id: str
    title: str = ""
    extra: dict[str, Any] = Field(default_factory=dict)


class ChainResponse(BaseModel):
    """The whole chain around one item, both directions, in one call."""

    focus: ChainNode
    requirements: list[ChainNode] = Field(default_factory=list)
    test_specs: list[ChainNode] = Field(default_factory=list)
    test_impls: list[ChainNode] = Field(default_factory=list)
    runs: list[ChainNode] = Field(default_factory=list)
    results: list[ChainNode] = Field(default_factory=list)


@router.get(
    "/results",
    response_model=PaginatedResponse[TestResult],
    response_model_by_alias=False,
)
def list_results(
    query_params: ResultQuery = Depends(),
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> PaginatedResponse[TestResult]:
    """List verdicts. One document per (run, test case, trace)."""
    query: dict[str, Any] = {}
    if query_params.run_id:
        query["run_id"] = query_params.run_id
    if query_params.tc_id:
        query["tc_id"] = query_params.tc_id
    if query_params.req_id:
        query["req_ids"] = query_params.req_id
    if query_params.status:
        query["status"] = query_params.status.value
    if query_params.trace_key:
        query["trace_key"] = query_params.trace_key
    if query_params.baseline:
        query["baseline_id"] = query_params.baseline

    total = mongo.vm_results.count_documents(query)
    skip = (query_params.page - 1) * query_params.page_size
    cursor = (
        mongo.vm_results.find(query)
        .sort([("run_id", 1), ("tc_id", 1)])
        .skip(skip)
        .limit(query_params.page_size)
    )
    return PaginatedResponse.create(
        items=[TestResult(**doc) for doc in cursor],
        total=total,
        page=query_params.page,
        page_size=query_params.page_size,
    )


@router.get("/results/{result_id:path}", response_model=TestResult, response_model_by_alias=False)
def get_result(
    result_id: str,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> TestResult:
    """Get one verdict in full, including its reason and notes."""
    doc = mongo.vm_results.find_one({"_id": result_id})
    if doc is None:
        raise HTTPException(status_code=404, detail=f"Result '{result_id}' not found")
    return TestResult(**doc)


def _aggregate_verdict(verdicts: list[str]) -> str:
    """Reduce several verdicts for one cell to one, worst case first."""
    for candidate in VERDICT_PRECEDENCE:
        if candidate in verdicts:
            return candidate
    return "NOT_RUN"


@router.get("/coverage", response_model=CoverageMatrix)
def get_coverage(
    baseline: str | None = Query(None, description="Baseline to report on; default the first"),
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> CoverageMatrix:
    """The coverage matrix for one baseline.

    Rows are every requirement in the pinned register - including ``Obsolete`` and
    ``Rejected`` ones, which read as both retired *and* uncovered rather than being hidden.
    Coverage itself comes from the baseline's frozen ``req_links``; the verdict in each cell
    comes from ``vm_results``.
    """
    document = (
        mongo.vm_baselines.find_one({"_id": baseline})
        if baseline
        else mongo.vm_baselines.find_one({}, sort=[("_id", 1)])
    )
    if document is None:
        raise HTTPException(status_code=404, detail=f"Baseline '{baseline or 'any'}' not found")

    baseline_id = str(document["_id"])
    requirements_version = str(document["requirements_version"])
    req_links: dict[str, list[str]] = document.get("req_links", {})

    cell_verdicts: dict[tuple[str, str], list[str]] = {}
    cell_runs: dict[tuple[str, str], set[str]] = {}
    for result in mongo.vm_results.find({}, {"req_ids": 1, "tc_id": 1, "status": 1, "run_id": 1}):
        for req_id in result.get("req_ids") or []:
            key = (str(req_id), str(result["tc_id"]))
            cell_verdicts.setdefault(key, []).append(str(result["status"]))
            cell_runs.setdefault(key, set()).add(str(result["run_id"]))

    rows: list[CoverageRow] = []
    tallies = {"PASS": 0, "FAIL": 0, "INCONCLUSIVE": 0, "NOT_RUN": 0}
    for doc in mongo.vm_requirements.find({"artifact_version": requirements_version}).sort(
        "req_id", 1
    ):
        req_id = str(doc["req_id"])
        tc_ids = req_links.get(req_id, [])
        cells = [
            CoverageCell(
                tc_id=tc_id,
                verdict=_aggregate_verdict(cell_verdicts.get((req_id, tc_id), [])),
                run_count=len(cell_runs.get((req_id, tc_id), set())),
            )
            for tc_id in tc_ids
        ]
        verdict = _aggregate_verdict([cell.verdict for cell in cells])
        tallies[verdict] = tallies.get(verdict, 0) + 1
        status = str(doc.get("status", ""))
        rows.append(
            CoverageRow(
                req_id=req_id,
                title=str(doc.get("title", "")),
                status=status,
                retired=status in RETIRED_STATUSES,
                verification_tag=str(doc.get("verification_tag", "")),
                covered=bool(tc_ids),
                verdict=verdict,
                cells=cells,
            )
        )

    covered = sum(1 for row in rows if row.covered)
    counts = {
        "requirements": len(rows),
        "covered": covered,
        "passed": tallies["PASS"],
        "failed": tallies["FAIL"],
        "inconclusive": tallies["INCONCLUSIVE"],
        "not_run": tallies["NOT_RUN"],
        "retired": sum(1 for row in rows if row.retired),
    }
    return CoverageMatrix(
        baseline_id=baseline_id,
        requirements_version=requirements_version,
        counts=counts,
        coverage_pct=round(100.0 * covered / len(rows), 1) if rows else 0.0,
        test_case_ids=sorted({tc for tc_ids in req_links.values() for tc in tc_ids}),
        rows=rows,
    )


def _requirement_nodes(mongo: Database[dict[str, Any]], req_ids: list[str]) -> list[ChainNode]:
    """Requirement stubs for the chain, newest artifact version of each id."""
    nodes = []
    for req_id in sorted(set(req_ids)):
        matches = sorted(
            mongo.vm_requirements.find({"req_id": req_id}),
            key=lambda item: item["artifact_version"],
        )
        if matches:
            doc = matches[-1]
            nodes.append(
                ChainNode(
                    kind="requirement",
                    key=str(doc["_id"]),
                    id=req_id,
                    title=str(doc.get("title", "")),
                    extra={
                        "status": doc.get("status"),
                        "verification_tag": doc.get("verification_tag"),
                    },
                )
            )
    return nodes


def _spec_nodes(mongo: Database[dict[str, Any]], tc_ids: list[str]) -> list[ChainNode]:
    """Test specification stubs for the chain."""
    nodes = []
    for doc in mongo.vm_test_specs.find({"tc_id": {"$in": sorted(set(tc_ids))}}).sort("tc_id", 1):
        nodes.append(
            ChainNode(
                kind="test-spec",
                key=str(doc["_id"]),
                id=str(doc["tc_id"]),
                title=str(doc.get("title") or doc.get("objective") or ""),
                extra={"covers_req_ids": doc.get("covers_req_ids", [])},
            )
        )
    return nodes


def _impl_nodes(mongo: Database[dict[str, Any]], tc_ids: list[str]) -> list[ChainNode]:
    """Implementation stubs for the chain, matched through the covering test case."""
    query = {"tc_id": {"$in": sorted(set(tc_ids))}}
    return [
        ChainNode(
            kind="test-impl",
            key=str(doc["_id"]),
            id=str(doc["impl_id"]),
            title=str((doc.get("check_spec") or {}).get("title", "")),
            extra={"tc_id": doc.get("tc_id"), "entrypoint": doc.get("entrypoint")},
        )
        for doc in mongo.vm_test_impls.find(query, {"source": 0}).sort("impl_id", 1)
    ]


def _result_nodes(mongo: Database[dict[str, Any]], query: dict[str, Any]) -> list[ChainNode]:
    """Verdict stubs plus the run stubs they imply, capped so a chain call stays small."""
    return [
        ChainNode(
            kind="result",
            key=str(doc["_id"]),
            id=str(doc["_id"]),
            title=str(doc.get("title", "")),
            extra={
                "verdict": doc.get("status"),
                "run_id": doc.get("run_id"),
                "tc_id": doc.get("tc_id"),
                "measured": doc.get("measured"),
                "bound": doc.get("bound"),
                "unit": doc.get("unit"),
            },
        )
        for doc in mongo.vm_results.find(query).sort([("run_id", 1), ("tc_id", 1)]).limit(400)
    ]


@router.get("/trace/{item_kind}/{key:path}", response_model=ChainResponse)
def get_chain(
    item_kind: str,
    key: str,
    mongo: Database[dict[str, Any]] = Depends(get_mongo),
    _: None = Depends(read_permission),
) -> ChainResponse:
    """The V-chain around one item, in both directions, in a single call.

    ``item_kind`` is one of ``requirement``, ``test-spec``, ``test-impl``, ``run``,
    ``result``. ``key`` is that item's id, with or without an ``@version`` suffix.
    """
    bare = key.split("@", 1)[0]
    baseline = mongo.vm_baselines.find_one({}, sort=[("_id", 1)])
    req_links: dict[str, list[str]] = baseline.get("req_links", {}) if baseline else {}

    if item_kind == "requirement":
        req_ids, tc_ids = [bare], req_links.get(bare, [])
    elif item_kind == "test-spec":
        spec = mongo.vm_test_specs.find_one({"tc_id": bare}) or mongo.vm_test_specs.find_one(
            {"_id": key}
        )
        if spec is None:
            raise HTTPException(status_code=404, detail=f"Test specification '{key}' not found")
        req_ids, tc_ids = list(spec.get("covers_req_ids") or []), [str(spec["tc_id"])]
    elif item_kind == "test-impl":
        impl = mongo.vm_test_impls.find_one(
            {"$or": [{"_id": key}, {"impl_id": bare}, {"tc_id": bare}]}, {"source": 0}
        )
        if impl is None:
            raise HTTPException(status_code=404, detail=f"Test implementation '{key}' not found")
        tc_ids = [str(impl.get("tc_id") or impl["impl_id"])]
        req_ids = [str(impl["requirement_id"])] if impl.get("requirement_id") else []
    elif item_kind in ("run", "result"):
        query = {"run_id": bare} if item_kind == "run" else {"_id": key}
        docs = list(mongo.vm_results.find(query, {"tc_id": 1, "req_ids": 1}))
        if not docs:
            raise HTTPException(status_code=404, detail=f"No results for {item_kind} '{key}'")
        tc_ids = [str(doc["tc_id"]) for doc in docs]
        req_ids = [req for doc in docs for req in doc.get("req_ids") or []]
    else:
        raise HTTPException(status_code=400, detail=f"Unknown item kind '{item_kind}'")

    if item_kind == "run":
        result_query: dict[str, Any] = {"run_id": bare}
    elif item_kind == "result":
        result_query = {"_id": key}
    else:
        result_query = {"tc_id": {"$in": sorted(set(tc_ids))}}

    results = _result_nodes(mongo, result_query) if tc_ids else []
    run_ids = sorted({str(node.extra.get("run_id")) for node in results if node.extra.get("run_id")})

    return ChainResponse(
        focus=ChainNode(kind=item_kind, key=key, id=bare),
        requirements=_requirement_nodes(mongo, req_ids),
        test_specs=_spec_nodes(mongo, tc_ids),
        test_impls=_impl_nodes(mongo, tc_ids),
        runs=[
            ChainNode(
                kind="run",
                key=run_id,
                id=run_id,
                extra={"baseline_id": str(baseline["_id"]) if baseline else None},
            )
            for run_id in run_ids
        ],
        results=results,
    )
