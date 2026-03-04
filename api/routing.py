"""Routing endpoints backed by the active routing provider."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core.api import api_route
from core.http.valhalla import ValhallaClient as _DefaultValhallaClient
from core.mapping.factory import get_router

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/routing", tags=["routing"])
ValhallaClient = _DefaultValhallaClient


class RouteRequest(BaseModel):
    origin: list[float] = Field(..., min_length=2, max_length=2)
    destination: list[float] = Field(..., min_length=2, max_length=2)


class EtaRequest(BaseModel):
    waypoints: list[list[float]] = Field(..., min_length=2)


async def _get_routing_client() -> Any:
    if ValhallaClient is not _DefaultValhallaClient:
        return ValhallaClient()
    return await get_router()


@router.post("/route")
@api_route(logger)
async def route_endpoint(payload: RouteRequest) -> dict[str, Any]:
    origin = payload.origin
    destination = payload.destination
    client = await _get_routing_client()
    result = await client.route(
        [(origin[0], origin[1]), (destination[0], destination[1])],
    )

    geometry = result.get("geometry")
    if not geometry:
        raise HTTPException(status_code=404, detail="No route found.")

    return {
        "route": {
            "geometry": geometry,
            "duration": result.get("duration_seconds", 0),
            "distance": result.get("distance_meters", 0),
        },
    }


@router.post("/eta")
@api_route(logger)
async def eta_endpoint(payload: EtaRequest) -> dict[str, Any]:
    client = await _get_routing_client()
    result = await client.route(payload.waypoints)
    return {"duration": result.get("duration_seconds", 0)}
