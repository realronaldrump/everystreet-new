import logging

from fastapi import APIRouter, Body, HTTPException, status
from pydantic import BaseModel

from core.api import api_route
from db.models import Trip
from db.schemas import DateRangeModel
from map_matching.schemas import MapMatchJobRequest
from map_matching.service import MapMatchingJobService
from trips.services.trip_batch_service import ProcessingOptions, TripService

# Setup
logger = logging.getLogger(__name__)
router = APIRouter()

# Initialize TripService
trip_service = TripService()
map_matching_service = MapMatchingJobService()


class ProcessTripOptions(BaseModel):
    map_match: bool = True
    validate_only: bool = False
    geocode_only: bool = False


# API Endpoints
@router.post("/api/process_trip/{trip_id}", response_model=dict[str, object])
@api_route(logger)
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
        map_match=False,
        validate_only=options.validate_only,
        geocode_only=options.geocode_only,
    )

    response = await trip_service.process_single_trip(
        trip_dict,
        processing_options,
        source,
    )

    if options.map_match and not options.validate_only and not options.geocode_only:
        job = await map_matching_service.enqueue_job(
            MapMatchJobRequest(mode="trip_id", trip_id=trip_id),
            source="api",
        )
        response["map_match_job"] = job

    return response


@router.get("/api/trips/{trip_id}/status", response_model=dict[str, object])
@api_route(logger)
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


@router.post("/api/map_match_trips", response_model=dict[str, object])
@api_route(logger)
async def map_match_trips_endpoint(
    trip_id: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    data: DateRangeModel | None = Body(default=None),
):
    """Map match trips within a date range or a specific trip."""
    interval_days = 0
    if data:
        if not start_date and data.start_date:
            start_date = data.start_date
        if not end_date and data.end_date:
            end_date = data.end_date
        interval_days = data.interval_days or 0
    start_date = start_date or None
    end_date = end_date or None
    if not trip_id and not (start_date and end_date) and interval_days <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Either trip_id or date range is required",
        )

    try:
        if trip_id:
            job = await map_matching_service.enqueue_job(
                MapMatchJobRequest(mode="trip_id", trip_id=trip_id),
                source="api",
            )
        else:
            job = await map_matching_service.enqueue_job(
                MapMatchJobRequest(
                    mode="date_range",
                    start_date=start_date,
                    end_date=end_date,
                    interval_days=interval_days,
                    unmatched_only=True,
                ),
                source="api",
            )

        return {
            "status": "queued",
            "job_id": job.get("job_id"),
            "message": "Map matching job queued",
        }

    except Exception as e:
        logger.exception(
            "Error in map_match_trips endpoint",
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/matched_trips/remap", response_model=dict[str, object])
@api_route(logger)
async def remap_matched_trips(
    data: DateRangeModel | None = None,
):
    """Remap matched trips, optionally within a date range."""
    if not data:
        data = DateRangeModel(
            start_date="",
            end_date="",
            interval_days=0,
        )
    try:
        job = await map_matching_service.enqueue_job(
            MapMatchJobRequest(
                mode="date_range",
                start_date=data.start_date or None,
                end_date=data.end_date or None,
                interval_days=data.interval_days,
                unmatched_only=False,
                rematch=True,
            ),
            source="api",
        )
        return {
            "status": "queued",
            "job_id": job.get("job_id"),
            "message": "Rematch job queued",
        }
    except Exception as e:
        logger.exception("Error in remap_matched_trips")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error re-matching trips: {e}",
        )
