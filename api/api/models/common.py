"""Shared model machinery: base models, the source enum, pagination, search.

This file is frozen after the base. Only the BE lead edits it.
It holds two of the three v1.1 switches — see the README section "v1.1 switches".
"""

import math
from datetime import UTC, datetime
from enum import Enum
from typing import Annotated, Literal

from fastapi import Query
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, PlainSerializer


def _iso_z(value: datetime) -> str:
    """Serialize a datetime as ISO-8601 UTC with a Z suffix."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


# Every timestamp on the wire uses this type.
UtcDatetime = Annotated[datetime, PlainSerializer(_iso_z, when_used="json")]


class ApiModel(BaseModel):
    """Base class for every response model."""

    model_config = ConfigDict(populate_by_name=True)


class RequestModel(ApiModel):
    """Base class for every request body model.

    Unknown fields are rejected with 422 (contract v1.1).
    The 422 detail names the field.
    """

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class Source(str, Enum):
    """Every source tag on the wire. One enum, one module."""

    EMBEDDED = "embedded"
    MANUAL = "manual"
    API_PLANNING = "api:planning"
    API_CONFIG = "api:config"
    API_CATALOGUE = "api:catalogue"
    API_POST_PROCESSING = "api:post-processing"


class FieldSource(ApiModel):
    """One entry of a field_sources map."""

    source: Source
    actor: str
    at: UtcDatetime


FieldSources = dict[str, FieldSource]

# The pagination allow-list from the contract. Any other value is a 422.
# 500 holds the largest real run of 261 signals in one page. It still splits the
# 6,412-row signal catalogue into 13 pages, so no caller takes it in one call.
ALLOWED_PAGE_SIZES = (10, 20, 50, 100, 200, 500)


def _check_page_size(value: int) -> int:
    if value not in ALLOWED_PAGE_SIZES:
        raise ValueError(f"must be one of {', '.join(map(str, ALLOWED_PAGE_SIZES))}")
    return value


PageSize = Annotated[
    int,
    AfterValidator(_check_page_size),
    Field(json_schema_extra={"enum": list(ALLOWED_PAGE_SIZES)}),
]


class Pagination:
    """Resolved pagination parameters plus the envelope helper."""

    def __init__(self, page: int, page_size: int):
        self.page = page
        self.page_size = page_size

    def envelope(self, items: list, total: int) -> dict:
        return {
            "items": items,
            "total": total,
            "page": self.page,
            "page_size": self.page_size,
            "total_pages": math.ceil(total / self.page_size) if total else 0,
        }


def pagination_params(default_page_size: PageSize = 20):
    """Build a pagination dependency with the given default page size."""

    def dependency(
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[PageSize, Query()] = default_page_size,
    ) -> Pagination:
        return Pagination(page=page, page_size=page_size)

    return dependency


class Page[T](ApiModel):
    """The contract's pagination envelope."""

    items: list[T]
    total: int
    page: int
    page_size: int
    total_pages: int


class SearchItem(ApiModel):
    id: str
    sub: str
    status: str | None
    nav: dict[str, str]


class SearchGroup(ApiModel):
    type: Literal[
        "test_runs",
        "work_orders",
        "files",
        "signals",
        "test_definitions",
        "processed_results",
    ]
    items: list[SearchItem]


class SearchResponse(ApiModel):
    query: str
    groups: list[SearchGroup]
