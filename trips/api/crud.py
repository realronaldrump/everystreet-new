"""API routes for trip CRUD operations."""

import logging
from datetime import UTC, datetime

from beanie.operators import In
from fastapi import APIRouter, HTTPException, Request, status

from core.api import api_route
from db.models import CoverageState, Trip
from trips.services import TripCostService

logger = logging.getLogger(__name__)
router = APIRouter()


async def _cleanup_trip_references(trip_ids: list) -> int:
    """
    Clean up references to trips in other collections.

    Clears the driven_by_trip_id field in CoverageState documents
    that reference the deleted trips. This preserves the coverage
    status while removing the trip association.

    Args:
        trip_ids: List of Trip ObjectIds to clean up references for

    Returns:
        Number of CoverageState documents updated
    """
    if not trip_ids:
        return 0

    # Find all coverage states that reference these trips
    coverage_states = await CoverageState.find(
        In(CoverageState.driven_by_trip_id, trip_ids),
    ).to_list()

    updated_count = 0
    for state in coverage_states:
        state.driven_by_trip_id = None
        await state.save()
        updated_count += 1

    if updated_count > 0:
        logger.info(f"Cleared trip references from {updated_count} coverage states")

    return updated_count


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

    # Include computed per-trip cost when we have fillup + fuelConsumed data.
    trip_dict = trip.model_dump()
    trip_dict["estimated_cost"] = None
    if trip.imei and trip.fuelConsumed is not None:
        price_map = await TripCostService.get_fillup_price_map({"imei": trip.imei})
        trip_dict["estimated_cost"] = TripCostService.calculate_trip_cost(
            trip_dict,
            price_map,
        )

    return {
        "status": "success",
        "trip": trip_dict,
    }


@router.delete("/api/trips/{trip_id}", tags=["Trips API"])
@api_route(logger)
async def delete_trip(trip_id: str):
    """
    Delete a trip by its transaction ID.

    Also cleans up any references to this trip in other collections,
    such as CoverageState documents that track which trip drove a
    street.
    """
    trip = await Trip.find_one(Trip.transactionId == trip_id)
    if not trip:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trip not found",
        )

    # Clean up references in other collections before deleting
    coverage_updated = await _cleanup_trip_references([trip.id])

    await trip.delete()

    return {
        "status": "success",
        "message": "Trip deleted successfully",
        "deleted_trips": 1,
        "coverage_states_updated": coverage_updated,
    }


@router.delete("/api/matched_trips/{trip_id}", tags=["Trips API"])
@api_route(logger)
async def unmatch_trip(trip_id: str):
    """Clear matched GPS data for a trip."""
    trip = await Trip.find_one(Trip.transactionId == trip_id)
    if not trip:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trip not found",
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
    """
    Bulk delete trips by their transaction IDs.

    Also cleans up any references to these trips in other collections,
    such as CoverageState documents that track which trip drove a
    street.
    """
    body = await request.json()
    trip_ids = body.get("trip_ids", [])

    if not trip_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No trip IDs provided",
        )

    # Get the ObjectIds for the trips before deleting
    trips = await Trip.find(In(Trip.transactionId, trip_ids)).to_list()
    trip_object_ids = [trip.id for trip in trips]

    # Clean up references in other collections before deleting
    coverage_updated = await _cleanup_trip_references(trip_object_ids)

    result = await Trip.find(In(Trip.transactionId, trip_ids)).delete()

    return {
        "status": "success",
        "deleted_trips": result.deleted_count,
        "message": f"Deleted {result.deleted_count} trips",
        "coverage_states_updated": coverage_updated,
    }


@router.post("/api/matched_trips/bulk_unmatch", tags=["Trips API"])
@api_route(logger)
async def bulk_unmatch_trips(request: Request):
    """Bulk clear matched GPS data for trips."""
    body = await request.json()
    trip_ids = body.get("trip_ids", [])

    if not trip_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No trip IDs provided",
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
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trip not found",
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
