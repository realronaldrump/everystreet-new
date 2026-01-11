import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from config import get_mapbox_token
from date_utils import normalize_calendar_date
from db import (
    build_calendar_date_expr,
    db_manager,
    find_with_retry,
    get_trip_by_id,
    serialize_datetime,
    update_many_with_retry,
)
from models import BulkProcessModel, DateRangeModel
from trip_service import ProcessingOptions, TripService

# Setup
logger = logging.getLogger(__name__)
router = APIRouter()

# Collections
trips_collection = db_manager.get_collection("trips")


# Initialize TripService
trip_service = TripService(get_mapbox_token())


# Pydantic Models specific to this module
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
    """Process a single trip with options to validate, geocode, and map.

    match.
    """
    trip = await trip_service.get_trip_by_id(trip_id)

    if not trip:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trip not found",
        )

    source = trip.get("source", "unknown")
    processing_options = ProcessingOptions(
        validate=True,
        geocode=True,
        map_match=options.map_match,
        validate_only=options.validate_only,
        geocode_only=options.geocode_only,
    )

    return await trip_service.process_single_trip(trip, processing_options, source)


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
        trip = await get_trip_by_id(trip_id, trips_collection)

        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trip not found",
            )

        status_info = {
            "transaction_id": trip_id,
            "collection": trips_collection.name,
            "source": trip.get("source", "unknown"),
            "has_start_location": bool(trip.get("startLocation")),
            "has_destination": bool(trip.get("destination")),
            "has_matched_trip": bool(trip.get("matchedGps")),
            "processing_history": trip.get("processing_history", []),
            "validation_status": trip.get("validation_status", "unknown"),
            "validation_message": trip.get("validation_message", ""),
            "validated_at": serialize_datetime(
                trip.get("validated_at"),
            ),
            "geocoded_at": serialize_datetime(
                trip.get("geocoded_at"),
            ),
            "matched_at": serialize_datetime(
                trip.get("matched_at"),
            ),
            "last_processed": serialize_datetime(
                trip.get("saved_at"),
            ),
        }

        return status_info

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
    """Map match trips within a date range or a specific trip.

    Args:
        trip_id: Optional specific trip ID to match
        start_date: Optional start of date range
        end_date: Optional end of date range
    """
    try:
        query = {}
        if trip_id:
            query["transactionId"] = trip_id
        elif start_date and end_date:
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

        trips = await collection.find_one(trips_collection, query)

        if not trips:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No trips found matching criteria",
            )

        trip_ids = [
            trip.get("transactionId") for trip in trips if trip.get("transactionId")
        ]
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
    try:
        if not data:
            data = DateRangeModel(
                start_date="",
                end_date="",
                interval_days=0,
            )

        if data.interval_days > 0:
            end_dt = datetime.now(UTC)
            start_dt = end_dt - timedelta(days=data.interval_days)
            start_iso = start_dt.date().isoformat()
            end_iso = end_dt.date().isoformat()
        else:
            start_iso = normalize_calendar_date(data.start_date)
            end_iso = normalize_calendar_date(data.end_date)

            if not start_iso or not end_iso:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid date range",
                )

        range_expr = build_calendar_date_expr(start_iso, end_iso)
        if not range_expr:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid date range",
            )

        total_deleted_count = 0

        if data.interval_days > 0:
            chunk_size = max(1, data.interval_days)
            current_start = datetime.strptime(start_iso, "%Y-%m-%d").date()
            final_end = datetime.strptime(end_iso, "%Y-%m-%d").date()

            while current_start <= final_end:
                chunk_end = min(
                    current_start + timedelta(days=chunk_size - 1),
                    final_end,
                )
                chunk_expr = build_calendar_date_expr(
                    current_start.isoformat(),
                    chunk_end.isoformat(),
                )
                if chunk_expr:
                    # Unset matched fields instead of deleting documents
                    result = await collection.update_many(
                        trips_collection,
                        {"$expr": chunk_expr},
                        {
                            "$unset": {
                                "matchedGps": "",
                                "matchStatus": "",
                                "matched_at": "",
                            }
                        },
                    )
                    total_deleted_count += result.modified_count
                current_start = chunk_end + timedelta(days=1)
        else:
            # Unset matched fields instead of deleting documents
            update_result = await collection.update_many(
                trips_collection,
                {"$expr": range_expr},
                {"$unset": {"matchedGps": "", "matchStatus": "", "matched_at": ""}},
            )
            total_deleted_count = update_result.modified_count

        result = await trip_service.remap_trips(
            query={"$expr": range_expr},
            limit=1000,
        )

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
