"""Routing API endpoints for generating optimal routes.

Provides on-demand route generation for covering undriven streets.
"""

import logging
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import Response
from pydantic import BaseModel

from coverage_models.job_status import JobType
from services.job_manager import job_manager
from services.routing_service import generate_gpx, routing_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/areas", tags=["routing"])


class RouteRequest(BaseModel):
    """Request body for route generation."""

    start_lon: float | None = None
    start_lat: float | None = None


@router.post("/{area_id}/route")
async def generate_route(
    area_id: str,
    request: RouteRequest | None = None,
):
    """Generate an optimal route for covering undriven streets.

    Uses a greedy nearest-neighbor algorithm to find a route that
    covers all undriven street segments efficiently.

    Args:
        area_id: Area ID to generate route for
        request: Optional request body with starting point

    Returns:
        Route as GeoJSON with metadata
    """
    try:
        ObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID",
        )

    # Parse start point if provided
    start_point = None
    if request and request.start_lon is not None and request.start_lat is not None:
        start_point = (request.start_lon, request.start_lat)

    # Create job for tracking
    job = await job_manager.create_job(
        job_type=JobType.ROUTE_GENERATION,
        area_id=area_id,
    )

    try:
        result = await routing_service.generate_route(
            area_id=area_id,
            start_point=start_point,
            job_id=str(job.id),
        )

        return {
            "success": True,
            "job_id": str(job.id),
            **result,
        }

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("Route generation failed for area %s: %s", area_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Route generation failed: {str(e)[:200]}",
        )


@router.get("/{area_id}/route/gpx")
async def get_route_gpx(
    area_id: str,
    start_lon: float | None = Query(None),
    start_lat: float | None = Query(None),
):
    """Generate route and return as GPX file for GPS device import.

    Args:
        area_id: Area ID to generate route for
        start_lon: Optional starting longitude
        start_lat: Optional starting latitude

    Returns:
        GPX XML file
    """
    try:
        ObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID",
        )

    # Parse start point if provided
    start_point = None
    if start_lon is not None and start_lat is not None:
        start_point = (start_lon, start_lat)

    try:
        result = await routing_service.generate_route(
            area_id=area_id,
            start_point=start_point,
        )

        if not result.get("route"):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No route generated - all streets may already be driven",
            )

        route_geojson = result["route"]
        area_name = route_geojson.get("properties", {}).get("area_name", "Area")

        gpx_content = generate_gpx(route_geojson, area_name)

        # Return as downloadable GPX file
        filename = f"route_{area_id}.gpx"
        return Response(
            content=gpx_content,
            media_type="application/gpx+xml",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
            },
        )

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("GPX generation failed for area %s: %s", area_id, e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"GPX generation failed: {str(e)[:200]}",
        )


@router.delete("/{area_id}/route/cache")
async def clear_route_cache(area_id: str):
    """Clear cached routing graph for an area.

    Useful after manual overrides or when you want to force
    a fresh graph rebuild.

    Args:
        area_id: Area ID to clear cache for

    Returns:
        Success message
    """
    try:
        ObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID",
        )

    routing_service.invalidate_cache(area_id)

    return {
        "success": True,
        "message": f"Route cache cleared for area {area_id}",
    }
