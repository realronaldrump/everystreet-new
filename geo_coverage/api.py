from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Query

from core.api import api_route
from geo_coverage.services.geo_coverage_service import GeoCoverageService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/geo-coverage", tags=["geo-coverage"])


@router.get("/summary", response_model=dict[str, Any])
@api_route(logger)
async def get_geo_coverage_summary() -> dict[str, Any]:
    """Return cross-level county/state/city summary metrics."""
    return await GeoCoverageService.get_summary()


@router.get("/topology", response_model=dict[str, Any])
@api_route(logger)
async def get_geo_coverage_topology(
    level: Literal["county", "state", "city"] = Query(default="county"),
    stateFips: str | None = None,
) -> dict[str, Any]:
    """Return topology/feature data for the requested level."""
    return await GeoCoverageService.get_topology(level=level, state_fips=stateFips)


@router.get("/visits", response_model=dict[str, Any])
@api_route(logger)
async def get_geo_coverage_visits(
    level: Literal["county", "city"] = Query(default="county"),
    stateFips: str | None = None,
) -> dict[str, Any]:
    """Return visit metadata for county/city entities."""
    return await GeoCoverageService.get_visits(level=level, state_fips=stateFips)


@router.get("/cities", response_model=dict[str, Any])
@api_route(logger)
async def get_geo_coverage_cities(
    stateFips: str,
    status: Literal[
        "all",
        "driven",
        "stopped",
        "both",
        "visited",
        "unvisited",
    ] = Query(default="all"),
    q: str | None = None,
    sort: str = Query(default="name"),
    page: int = Query(default=1, ge=1),
    pageSize: int = Query(default=100, ge=1, le=200),
) -> dict[str, Any]:
    """Return paginated city rows for the selected state."""
    return await GeoCoverageService.list_cities(
        state_fips=stateFips,
        status_filter=status,
        q=q,
        sort=sort,
        page=page,
        page_size=pageSize,
    )


@router.post("/recalculate", response_model=dict[str, Any])
@api_route(logger)
async def recalculate_geo_coverage(
    background_tasks: BackgroundTasks,
    mode: Literal["incremental", "full"] | None = Query(default=None),
) -> dict[str, Any]:
    """Trigger unified county/city recalculation in the background."""
    return await GeoCoverageService.recalculate(background_tasks, mode=mode)


@router.get("/cache-status", response_model=dict[str, Any])
@api_route(logger)
async def get_geo_coverage_cache_status() -> dict[str, Any]:
    """Return cache metadata for geo coverage datasets."""
    return await GeoCoverageService.get_cache_status()
