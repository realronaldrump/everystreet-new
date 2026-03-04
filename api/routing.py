"""Routing endpoints backed by the active routing provider."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core.api import api_route
from core.exceptions import ExternalServiceException
from core.http.valhalla import ValhallaClient as _DefaultValhallaClient
from core.mapping.factory import get_router

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/routing", tags=["routing"])
ValhallaClient = _DefaultValhallaClient


class RouteRequest(BaseModel):
    origin: list[float] = Field(..., min_length=2, max_length=2)
    destination: list[float] = Field(..., min_length=2, max_length=2)


class EtaRequest(BaseModel):
    waypoints: list[tuple[float, float]] = Field(..., min_length=2)


async def _get_routing_client() -> Any:
    if ValhallaClient is not _DefaultValhallaClient:
        return ValhallaClient()
    return await get_router()


def _validated_lon_lat(raw: list[float] | tuple[float, float], *, name: str) -> tuple[float, float]:
    try:
        lon = float(raw[0])
        lat = float(raw[1])
    except (IndexError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail=f"{name} must be a [lon, lat] coordinate pair.",
        ) from exc

    if not -180.0 <= lon <= 180.0:
        raise HTTPException(
            status_code=422,
            detail=f"{name} longitude must be between -180 and 180.",
        )
    if not -90.0 <= lat <= 90.0:
        raise HTTPException(
            status_code=422,
            detail=f"{name} latitude must be between -90 and 90.",
        )
    return (lon, lat)


def _translate_route_error(exc: ExternalServiceException) -> HTTPException | None:
    status_code = exc.details.get("status")
    if status_code == 400:
        return HTTPException(
            status_code=422,
            detail=(
                "Invalid routing coordinates. Ensure waypoints are [longitude, latitude] "
                "pairs within valid ranges."
            ),
        )
    return None


@router.post("/route")
@api_route(logger)
async def route_endpoint(payload: RouteRequest) -> dict[str, Any]:
    origin = _validated_lon_lat(payload.origin, name="origin")
    destination = _validated_lon_lat(payload.destination, name="destination")
    if origin == destination:
        raise HTTPException(
            status_code=422,
            detail="origin and destination must be different points.",
        )
    client = await _get_routing_client()
    try:
        result = await client.route([origin, destination])
    except ExternalServiceException as exc:
        translated = _translate_route_error(exc)
        if translated:
            raise translated from exc
        raise

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
    waypoints = [
        _validated_lon_lat(point, name=f"waypoints[{idx}]")
        for idx, point in enumerate(payload.waypoints)
    ]

    if len(set(waypoints)) < 2:
        raise HTTPException(
            status_code=422,
            detail="At least two distinct waypoints are required.",
        )

    client = await _get_routing_client()
    try:
        result = await client.route(waypoints)
    except ExternalServiceException as exc:
        translated = _translate_route_error(exc)
        if translated:
            raise translated from exc
        raise
    return {"duration": result.get("duration_seconds", 0)}
