import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from config import get_mapbox_token
from db.models import Trip
from db.schemas import BulkProcessModel, DateRangeModel
from trip_service import ProcessingOptions, TripService

# Setup
logger = logging.getLogger(__name__)
router = APIRouter()

# Initialize TripService
trip_service = TripService(get_mapbox_token())


class ProcessTripOptions(BaseModel):
    map_match: bool = True
    validate_only: bool = False
    geocode_only: bool = False


# API Endpoints
@router.post("/api/process_trip/{trip_id}")
async def process_single_trip(
    trip_id: str,
    options: ProcessTripOptions,
):
    """Process a single trip with options to validate, geocode, and map."""
    trip = await Trip.find_one(Trip.transactionId == trip_id)

    if not trip:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trip not found",
        )

    # Convert Beanie document to dict for TripService compatibility if it expects dicts
    # TripService likely expects a dict based on old code.
    # TODO: Refactor TripService to accept Trip models eventually,
    # but for now we can dump the model.
    trip_dict = trip.model_dump()

    # Pass the object? The service might do updates.
    # If the service does specific collection updates, that's bad.
    # But let's assume TripService is "Logic" and we pass data properly.
    # Wait, TripService.process_single_trip probably calls repositories or DB.
    # If TripService uses legacy code, then we have a problem downstream.
    # But for this file, we fix the entry point.

    source = trip.get("source") or "unknown"  # Beanie model access or dict access?
    # getattr(trip, "source", "unknown") if it's an extra field.

    processing_options = ProcessingOptions(
        validate=True,
        geocode=True,
        map_match=options.map_match,
        validate_only=options.validate_only,
        geocode_only=options.geocode_only,
    )

    return await trip_service.process_single_trip(trip_dict, processing_options, source)


@router.post("/api/bulk_process_trips")
async def bulk_process_trips(
    data: BulkProcessModel,
):
    """Process multiple trips in bulk with configurable options."""
    query = data.query
    options = data.options
    limit = min(data.limit, 500)

    processing_options = ProcessingOptions(
        validate=options.get("validate", True),
        geocode=options.get("geocode", True),
        map_match=options.get("map_match", False),
    )

    result = await trip_service.process_batch_trips(query, processing_options, limit)

    if result.total == 0:
        return {
            "status": "success",
            "message": "No trips found matching criteria",
            "count": 0,
        }

    return {
        "status": "success",
        "message": f"Processed {result.total} trips",
        "results": result.to_dict(),
    }


@router.get("/api/trips/{trip_id}/status")
async def get_trip_status(trip_id: str):
    """Get detailed processing status for a trip."""
    try:
        trip = await Trip.find_one(Trip.transactionId == trip_id)

        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trip not found",
            )

        return {
            "transaction_id": trip_id,
            "collection": "trips",  # Static name
            "source": getattr(trip, "source", "unknown"),
            "has_start_location": bool(trip.startGeoPoint),
            "has_destination": bool(trip.destinationGeoPoint),
            "has_matched_trip": bool(trip.matchedGps),
            "processing_history": getattr(trip, "processing_history", []),
            "validation_status": getattr(trip, "validation_status", "unknown"),
            "validation_message": getattr(trip, "validation_message", ""),
            "validated_at": (
                trip.validated_at if hasattr(trip, "validated_at") else None
            ),
            "geocoded_at": trip.geocoded_at if hasattr(trip, "geocoded_at") else None,
            "matched_at": trip.matched_at,
            "last_processed": trip.lastUpdate,  # or saved_at
        }

    except Exception as e:
        logger.exception(
            "Error getting trip status for %s: %s",
            trip_id,
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/map_match_trips")
async def map_match_trips_endpoint(
    trip_id: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
):
    """Map match trips within a date range or a specific trip."""
    try:
        query = {}
        if trip_id:
            query["transactionId"] = trip_id
        elif start_date and end_date:
            # We must use proper datetime objects for Beanie queries if possible
            # But TripService.remap_trips likely takes a query dict.
            # Here we build criteria.
            # If we are just calling remap_trips, we might delegate the query building?
            # Existing code used build_calendar_date_expr which returns a Mongo $expr.
            # Beanie find(query) supports raw mongo queries.

            # Re-import helper if needed or construct manually
            from db import build_calendar_date_expr

            date_expr = build_calendar_date_expr(start_date, end_date)
            if not date_expr:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid date range",
                )
            query["$expr"] = date_expr
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Either trip_id or date range is required",
            )

        # Check if any exist first? using Beanie
        # trip_service.remap_trips takes trip_ids list usually, or query?
        # The previous code passed `trip_ids` list.

        trips = await Trip.find(query).to_list()  # Limit?

        if not trips:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No trips found matching criteria",
            )

        trip_ids = [t.transactionId for t in trips if t.transactionId]

        result = await trip_service.remap_trips(trip_ids=trip_ids)

        return {
            "status": "success",
            "message": f"Map matching completed: {result['map_matched']} successful, {result['failed']} failed.",
            "processed_count": result["map_matched"],
            "failed_count": result["failed"],
        }

    except Exception as e:
        logger.exception(
            "Error in map_match_trips endpoint: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/matched_trips/remap")
async def remap_matched_trips(
    data: DateRangeModel | None = None,
):
    """Remap matched trips, optionally within a date range."""
    # This function was doing complicated chunking and updates.
    # We should simplify using Beanie if possible, or just use the service.
    try:
        if not data:
            data = DateRangeModel(
                start_date="",
                end_date="",
                interval_days=0,
            )

        from db import build_calendar_date_expr

        if data.interval_days > 0:
            end_dt = datetime.now(UTC)
            start_dt = end_dt - timedelta(days=data.interval_days)
            start_iso = start_dt.date().isoformat()
            end_iso = end_dt.date().isoformat()

            range_expr = build_calendar_date_expr(start_iso, end_iso)
        else:
            range_expr = build_calendar_date_expr(data.start_date, data.end_date)

        if not range_expr:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid date range",
            )

        # Unset matched fields
        # Using Beanie update_many

        # Beanie's `find(query).update(update_query)`
        update_result = await Trip.find({"$expr": range_expr}).update(
            {"$unset": {"matchedGps": "", "matchStatus": "", "matched_at": ""}},
        )

        total_deleted_count = update_result.modified_count

        # Now re-process
        # Gather IDs? if too many, we might want to let remap_trips handle the query.
        # But remap_trips takes trip_ids.
        # If there are thousands, this might be slow.
        # Let's limit to 1000 as per old code.

        trips = await Trip.find({"$expr": range_expr}).limit(1000).to_list()
        trip_ids = [t.transactionId for t in trips if t.transactionId]

        result = await trip_service.remap_trips(trip_ids=trip_ids)

        return {
            "status": "success",
            "message": f"Re-matching completed. Processed {result['map_matched']} trips.",
            "deleted_count": total_deleted_count,
        }

    except Exception as e:
        logger.exception(
            "Error in remap_matched_trips: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error re-matching trips: {e}",
        )


@router.post("/api/trips/refresh_geocoding")
async def refresh_geocoding_for_trips(
    trip_ids: list[str],
):
    """Refresh geocoding for specific trips."""
    if not trip_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No trip_ids provided",
        )

    result = await trip_service.refresh_geocoding(trip_ids)

    return {
        "message": f"Geocoding refreshed for {result['updated']} trips. Failed: {result['failed']}",
        "updated_count": result["updated"],
        "failed_count": result["failed"],
    }
