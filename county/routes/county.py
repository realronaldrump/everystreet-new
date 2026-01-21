from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, BackgroundTasks

from core.api import api_route
from county.services.county_service import CountyService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/counties", tags=["counties"])


@router.get("/topology", response_model=dict[str, Any])
@api_route(logger)
async def get_county_topology(projection: str | None = None) -> dict[str, Any]:
    """Return county TopoJSON data stored in MongoDB."""
    return await CountyService.get_county_topology(projection)


@router.get("/visited", response_model=dict[str, Any])
@api_route(logger)
async def get_visited_counties() -> dict[str, Any]:
    """Return cached list of visited county FIPS codes with visit dates."""
    return await CountyService.get_visited_counties()


@router.post("/recalculate", response_model=dict[str, Any])
@api_route(logger)
async def recalculate_visited_counties(
    background_tasks: BackgroundTasks,
) -> dict[str, Any]:
    """Trigger recalculation of visited counties in the background."""
    return await CountyService.recalculate_visited_counties(background_tasks)


@router.get("/cache-status", response_model=dict[str, Any])
@api_route(logger)
async def get_cache_status() -> dict[str, Any]:
    """Return status metadata about the county cache."""
    return await CountyService.get_cache_status()
