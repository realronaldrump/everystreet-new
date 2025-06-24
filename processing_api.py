import logging
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from db import (
    SerializationHelper,
    db_manager,
    delete_many_with_retry,
    find_one_with_retry,
    find_with_retry,
    get_trip_by_id,
    parse_query_date,
)
from models import BulkProcessModel, DateRangeModel
from trip_processor import TripProcessor, TripState
from trip_service import TripService, ProcessingOptions

# Setup
logger = logging.getLogger(__name__)
router = APIRouter()
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

# Collections
trips_collection = db_manager.db["trips"]
matched_trips_collection = db_manager.db["matched_trips"]

# Initialize TripService
trip_service = TripService(MAPBOX_ACCESS_TOKEN)


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
    """Process a single trip with options to validate, geocode, and map
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

    result = await trip_service.process_batch_trips(
        query, processing_options, limit
    )

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
            "has_matched_trip": await matched_trips_collection.find_one(
                {"transactionId": trip_id},
            )
            is not None,
            "processing_history": trip.get("processing_history", []),
            "validation_status": trip.get("validation_status", "unknown"),
            "validation_message": trip.get("validation_message", ""),
            "validated_at": SerializationHelper.serialize_datetime(
                trip.get("validated_at"),
            ),
            "geocoded_at": SerializationHelper.serialize_datetime(
                trip.get("geocoded_at"),
            ),
            "matched_at": SerializationHelper.serialize_datetime(
                trip.get("matched_at"),
            ),
            "last_processed": SerializationHelper.serialize_datetime(
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
            parsed_start = parse_query_date(start_date)
            parsed_end = parse_query_date(end_date, end_of_day=True)
            if not parsed_start or not parsed_end:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid date format",
                )
            query["startTime"] = {
                "$gte": parsed_start,
                "$lte": parsed_end,
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Either trip_id or date range is required",
            )

        trips_list = await find_with_retry(trips_collection, query)

        if not trips_list:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No trips found matching criteria",
            )

        trip_ids = [trip.get("transactionId") for trip in trips_list if trip.get("transactionId")]
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
            start_date = datetime.now(timezone.utc) - timedelta(
                days=data.interval_days,
            )
            end_date = datetime.now(timezone.utc)
        else:
            start_date = parse_query_date(data.start_date)
            end_date = parse_query_date(data.end_date, end_of_day=True)

            if not start_date or not end_date:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid date range",
                )

        await delete_many_with_retry(
            matched_trips_collection,
            {
                "startTime": {
                    "$gte": start_date,
                    "$lte": end_date,
                },
            },
        )

        trips_list = await find_with_retry(
            trips_collection,
            {
                "startTime": {
                    "$gte": start_date,
                    "$lte": end_date,
                },
            },
        )

        query = {
            "startTime": {
                "$gte": start_date,
                "$lte": end_date,
            },
        }
        
        result = await trip_service.remap_trips(query=query, limit=1000)

        return {
            "status": "success",
            "message": f"Re-matching completed. Processed {result['map_matched']} trips.",
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
