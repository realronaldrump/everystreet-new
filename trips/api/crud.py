"""API routes for trip CRUD operations."""

import logging
from datetime import UTC, datetime

from beanie.operators import In
from fastapi import APIRouter, HTTPException, Request, status

from core.api import api_route
from db.models import Trip

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/trips/{trip_id}", tags=["Trips API"])
@api_route(logger)
async def get_single_trip(trip_id: str):
    """Get a single trip by its transaction ID."""
    trip = await Trip.find_one(Trip.transactionId == trip_id)
    if not trip:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trip not found",
        )
    if trip.duration is None and trip.startTime and trip.endTime:
        trip.duration = (trip.endTime - trip.startTime).total_seconds()
    return {
        "status": "success",
        "trip": trip,  # FastAPI auto-serializes Beanie models
    }


@router.delete("/api/trips/{trip_id}", tags=["Trips API"])
@api_route(logger)
async def delete_trip(trip_id: str):
    """Delete a trip by its transaction ID."""
    trip = await Trip.find_one(Trip.transactionId == trip_id)
    if not trip:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found"
        )
    await trip.delete()
    return {
        "status": "success",
        "message": "Trip deleted successfully",
        "deleted_trips": 1,
    }


@router.delete("/api/matched_trips/{trip_id}", tags=["Trips API"])
@api_route(logger)
async def unmatch_trip(trip_id: str):
    """Clear matched GPS data for a trip."""
    trip = await Trip.find_one(Trip.transactionId == trip_id)
    if not trip:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found"
        )
    trip.matchedGps = None
    trip.matchStatus = None
    trip.matched_at = None
    trip.last_modified = datetime.now(UTC)
    await trip.save()
    return {
        "status": "success",
        "message": "Matched data cleared",
        "updated_trips": 1,
    }


@router.post("/api/trips/bulk_delete", tags=["Trips API"])
@api_route(logger)
async def bulk_delete_trips(request: Request):
    """Bulk delete trips by their transaction IDs."""
    body = await request.json()
    trip_ids = body.get("trip_ids", [])

    if not trip_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No trip IDs provided"
        )

    result = await Trip.find(In(Trip.transactionId, trip_ids)).delete()
    return {
        "status": "success",
        "deleted_trips": result.deleted_count,
        "message": f"Deleted {result.deleted_count} trips",
    }


@router.post("/api/matched_trips/bulk_unmatch", tags=["Trips API"])
@api_route(logger)
async def bulk_unmatch_trips(request: Request):
    """Bulk clear matched GPS data for trips."""
    body = await request.json()
    trip_ids = body.get("trip_ids", [])

    if not trip_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No trip IDs provided"
        )

    trips = await Trip.find(In(Trip.transactionId, trip_ids)).to_list()
    for trip in trips:
        trip.matchedGps = None
        trip.matchStatus = None
        trip.matched_at = None
        trip.last_modified = datetime.now(UTC)
        await trip.save()

    return {
        "status": "success",
        "updated_trips": len(trips),
        "message": f"Cleared matched data for {len(trips)} trips",
    }


@router.post("/api/trips/{trip_id}/restore", tags=["Trips API"])
@api_route(logger)
async def restore_trip(trip_id: str):
    """Restore an invalid trip."""
    trip = await Trip.find_one(Trip.transactionId == trip_id)
    if not trip:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found"
        )

    trip.invalid = None
    trip.validation_message = None
    trip.validated_at = None
    await trip.save()
    return {"status": "success", "message": "Trip allocated as valid."}


@router.delete("/api/trips/{trip_id}/permanent", tags=["Trips API"])
@api_route(logger)
async def permanent_delete_trip(trip_id: str):
    """Permanently delete a trip and its matched data."""
    # Re-use existing delete logic but explicitly for this purpose
    return await delete_trip(trip_id)
