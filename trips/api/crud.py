"""API routes for trip CRUD operations."""

import logging

from beanie.operators import In
from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, status

from analytics.services.mobility_insights_service import MobilityInsightsService
from core.api import api_route
from core.trip_map_cache import bump_trip_map_revision
from db.models import CoverageState, Trip
from trips.models import TripInactiveUpdate
from trips.pipeline import TripPipeline
from trips.serialization import TripSerializer
from trips.services import TripCostService
from trips.services.inactive_trip_service import InactiveTripService
from trips.services.trip_map_geometry import apply_trip_map_path_fields
from trips.services.trip_match_mutation_service import (
    HistoricalTripMatchMutationService,
)

logger = logging.getLogger(__name__)
router = APIRouter()
_match_mutations = HistoricalTripMatchMutationService()


async def _get_trip_or_404(trip_id: str) -> Trip:
    trip = await Trip.find_one(Trip.transactionId == trip_id)
    if not trip:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trip not found",
        )
    return trip


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

    result = await CoverageState.get_pymongo_collection().update_many(
        {"driven_by_trip_id": {"$in": trip_ids}},
        {"$set": {"driven_by_trip_id": None}},
    )
    updated_count = int(getattr(result, "modified_count", 0) or 0)

    if updated_count > 0:
        logger.info(
            "Cleared trip references from %s coverage states",
            updated_count,
        )

    return updated_count


@router.get("/api/trips/{trip_id}", tags=["Trips API"])
@api_route(logger)
async def get_single_trip(trip_id: str):
    """Get a single trip by its transaction ID."""
    trip = await _get_trip_or_404(trip_id)
    # Include computed per-trip cost when we have fillup + fuelConsumed data.
    trip_dict = trip.model_dump()
    trip_dict.update(TripSerializer.to_dict(trip_dict))
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


@router.post("/api/trips/{trip_id}/inactive", tags=["Trips API"])
@api_route(logger)
async def set_trip_inactive(
    trip_id: str,
    payload: TripInactiveUpdate,
    background_tasks: BackgroundTasks,
):
    """Mark or unmark a historical trip as inactive throughout the app."""
    trip = await _get_trip_or_404(trip_id)

    update_result = await InactiveTripService.set_inactive_state(
        trip,
        inactive=payload.inactive,
    )
    updated_trip = update_result["trip"]
    changed = bool(update_result.get("changed"))

    if changed:
        await InactiveTripService.sync_mobility_profile(
            updated_trip,
            inactive=payload.inactive,
        )
        recurring_routes = await InactiveTripService.queue_recurring_routes_refresh()
        geo_coverage = await InactiveTripService.queue_geo_coverage_refresh(
            background_tasks,
        )
        coverage = await InactiveTripService.queue_coverage_reprocessing_for_trip(
            updated_trip,
        )
    else:
        recurring_routes = {"status": "unchanged", "job_id": None}
        geo_coverage = {"status": "unchanged", "job_id": None}
        coverage = {"queued": 0, "skipped": 0, "job_ids": []}

    trip_dict = updated_trip.model_dump()
    trip_dict.update(TripSerializer.to_dict(trip_dict))

    state_label = "inactive" if payload.inactive else "active"
    message = (
        f"Trip marked {state_label} and dependent data refresh queued."
        if changed
        else f"Trip is already {state_label}."
    )

    return {
        "status": "success",
        "message": message,
        "trip": trip_dict,
        "changed": changed,
        "cache_entries_deleted": update_result.get("cache_entries_deleted", 0),
        "refresh": {
            "recurring_routes": recurring_routes,
            "geo_coverage": geo_coverage,
            "coverage": coverage,
        },
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
    trip = await _get_trip_or_404(trip_id)

    # Clean up references in other collections before deleting
    coverage_updated = await _cleanup_trip_references([trip.id])
    if trip.id is not None:
        await MobilityInsightsService.remove_trip(trip.id)

    await trip.delete()
    await bump_trip_map_revision()

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
    trip = await _get_trip_or_404(trip_id)
    await _match_mutations.clear_match(trip)
    return {
        "status": "success",
        "message": "Matched data cleared",
        "updated_trips": 1,
    }


@router.post("/api/trips/{trip_id}/rematch", tags=["Trips API"])
@api_route(logger)
async def rematch_trip(trip_id: str):
    """Rematch a single trip, replacing any existing matched data."""
    trip = await _get_trip_or_404(trip_id)
    result = await _match_mutations.rematch_trip(trip)

    if result.outcome == "skipped":
        detail = (
            "Trip has no GPS data to match"
            if result.status == "skipped:no-gps"
            else "Trip GPS data is not suitable for map matching"
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        )

    if result.outcome == "failed":
        if result.status == "error:no-geometry":
            detail = "Map matching returned no geometry"
        elif result.status == "error:sanitization-failed":
            detail = "Matched geometry failed sanitization"
        else:
            detail = f"Map matching failed: {result.message or 'Unknown error'}"
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=detail,
        )

    return {
        "status": "success",
        "message": "Trip rematched successfully",
        "trip_id": trip_id,
        "match_status": trip.matchStatus,
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
    for trip_oid in trip_object_ids:
        if trip_oid is not None:
            await MobilityInsightsService.remove_trip(trip_oid)

    result = await Trip.find(In(Trip.transactionId, trip_ids)).delete()
    if result.deleted_count:
        await bump_trip_map_revision()

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
        await _match_mutations.clear_match(
            trip,
            bump_revision=False,
            sync_mobility=True,
        )

    if trips:
        await bump_trip_map_revision()

    return {
        "status": "success",
        "updated_trips": len(trips),
        "message": f"Cleared matched data for {len(trips)} trips",
    }


@router.post("/api/trips/{trip_id}/restore", tags=["Trips API"])
@api_route(logger)
async def restore_trip(trip_id: str):
    """Restore an invalid trip."""
    trip = await _get_trip_or_404(trip_id)

    trip.invalid = None
    trip.validation_message = None
    trip.validated_at = None
    TripPipeline.sanitize_trip_document_geospatial_fields(trip)
    apply_trip_map_path_fields(trip)
    await trip.save()
    await bump_trip_map_revision()
    return {"status": "success", "message": "Trip allocated as valid."}


@router.delete("/api/trips/{trip_id}/permanent", tags=["Trips API"])
@api_route(logger)
async def permanent_delete_trip(trip_id: str):
    """Permanently delete a trip and its matched data."""
    # Re-use existing delete logic but explicitly for this purpose
    return await delete_trip(trip_id)
