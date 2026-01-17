import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from db.models import Trip
from db.schemas import DateRangeModel
from trip_service import ProcessingOptions, TripService

# Setup
logger = logging.getLogger(__name__)
router = APIRouter()

# Initialize TripService
trip_service = TripService()


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

    trip_dict = trip.model_dump()

    source = trip_dict.get("source") or getattr(trip, "source", None) or "unknown"

    processing_options = ProcessingOptions(
        validate=True,
        geocode=True,
        map_match=options.map_match,
        validate_only=options.validate_only,
        geocode_only=options.geocode_only,
    )

    return await trip_service.process_single_trip(trip_dict, processing_options, source)


@router.get("/api/trips/{trip_id}/status")
async def get_trip_status(trip_id: str):
    """Get detailed processing status for a trip."""
    trip = await Trip.find_one(Trip.transactionId == trip_id)

    if not trip:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trip not found",
        )

    try:
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
            "geocoded_at": getattr(trip, "geocoded_at", None),
            "matched_at": getattr(trip, "matched_at", None),
            "last_processed": getattr(trip, "lastUpdate", None),
        }

    except Exception as e:
        logger.exception("Error getting trip status for %s", trip_id)
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

    trips = await Trip.find(query).to_list()

    if not trips:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No trips found matching criteria",
        )

    try:
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
            "Error in map_match_trips endpoint",
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

    try:
        # Unset matched fields
        # Using Beanie update_many

        # Beanie's `find(query).update(update_query)`
        update_result = Trip.find({"$expr": range_expr}).update_many(
            {"$unset": {"matchedGps": "", "matchStatus": "", "matched_at": ""}},
        )
        update_result = await update_result

        total_deleted_count = int(getattr(update_result, "modified_count", 0) or 0)

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
            "Error in remap_matched_trips",
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error re-matching trips: {e}",
        )
