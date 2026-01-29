"""API routes for trip CRUD operations."""

import logging

from fastapi import APIRouter, HTTPException, Request, status

from core.api import api_route
from trips.models import TripUpdateRequest
from trips.services import TripCrudService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/trips/{trip_id}", tags=["Trips API"])
@api_route(logger)
async def get_single_trip(trip_id: str):
    """Get a single trip by its transaction ID."""
    trip = await TripCrudService.get_trip(trip_id)
    if not trip:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trip not found",
        )
    return {
        "status": "success",
        "trip": trip,  # FastAPI auto-serializes Beanie models
    }


@router.delete("/api/trips/{trip_id}", tags=["Trips API"])
@api_route(logger)
async def delete_trip(trip_id: str):
    """Delete a trip by its transaction ID."""
    try:
        return await TripCrudService.delete_trip(trip_id)
    except ValueError as e:
        if "not found" in str(e).lower():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.delete("/api/matched_trips/{trip_id}", tags=["Trips API"])
@api_route(logger)
async def unmatch_trip(trip_id: str):
    """Clear matched GPS data for a trip."""
    try:
        return await TripCrudService.unmatch_trip(trip_id)
    except ValueError as e:
        if "not found" in str(e).lower():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.put("/api/trips/{trip_id}", tags=["Trips API"])
@api_route(logger)
async def update_trip(trip_id: str, update_data: TripUpdateRequest):
    """Update a trip's details, such as its geometry or properties."""
    try:
        return await TripCrudService.update_trip(
            trip_id,
            geometry_data=update_data.geometry,
            properties_data=update_data.properties,
        )
    except ValueError as e:
        if "not found" in str(e).lower():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
        if "invalid json" in str(e).lower():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/trips/bulk_delete", tags=["Trips API"])
@api_route(logger)
async def bulk_delete_trips(request: Request):
    """Bulk delete trips by their transaction IDs."""
    body = await request.json()
    trip_ids = body.get("trip_ids", [])

    try:
        return await TripCrudService.bulk_delete_trips(trip_ids)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post("/api/matched_trips/bulk_unmatch", tags=["Trips API"])
@api_route(logger)
async def bulk_unmatch_trips(request: Request):
    """Bulk clear matched GPS data for trips."""
    body = await request.json()
    trip_ids = body.get("trip_ids", [])

    try:
        return await TripCrudService.bulk_unmatch_trips(trip_ids)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.post("/api/trips/{trip_id}/restore", tags=["Trips API"])
@api_route(logger)
async def restore_trip(trip_id: str):
    """Restore an invalid trip."""
    try:
        return await TripCrudService.restore_trip(trip_id)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.delete("/api/trips/{trip_id}/permanent", tags=["Trips API"])
@api_route(logger)
async def permanent_delete_trip(trip_id: str):
    """Permanently delete a trip and its matched data."""
    # Re-use existing delete logic but explicitly for this purpose
    return await delete_trip(trip_id)
