import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse

from date_utils import normalize_calendar_date
from db import (
    build_calendar_date_expr,
    build_query_from_request,
    db_manager,
    delete_many_with_retry,
    delete_one_with_retry,
    find_with_retry,
    serialize_datetime,
)
from geometry_service import GeometryService
from models import DateRangeModel

# Setup
logger = logging.getLogger(__name__)
router = APIRouter()

# Collections
matched_trips_collection = db_manager.db["matched_trips"]


@router.get("/api/matched_trips")
async def get_matched_trips(request: Request):
    """Get map-matched trips as GeoJSON."""
    try:
        query = await build_query_from_request(request)
        query["invalid"] = {"$ne": True}

        matched = await find_with_retry(
            matched_trips_collection, query, sort=[("startTime", -1)]
        )
        features = []

        for trip in matched:
            try:
                geometry_dict = GeometryService.parse_geojson(trip.get("matchedGps"))
                if geometry_dict is None:
                    raise ValueError("Invalid matchedGps geometry")
                feature = GeometryService.feature_from_geometry(
                    geometry_dict,
                    properties={
                        "transactionId": trip["transactionId"],
                        "imei": trip.get("imei", ""),
                        "startTime": serialize_datetime(
                            trip.get("startTime"),
                        )
                        or "",
                        "endTime": serialize_datetime(
                            trip.get("endTime"),
                        )
                        or "",
                        "distance": trip.get("distance", 0),
                        "timeZone": trip.get("timeZone", "UTC"),
                        "destination": trip.get("destination", "N/A"),
                        "startLocation": trip.get("startLocation", "N/A"),
                        "maxSpeed": float(trip.get("maxSpeed", 0)),
                        "averageSpeed": (
                            float(
                                trip.get(
                                    "averageSpeed",
                                    0,
                                ),
                            )
                            if trip.get("averageSpeed") is not None
                            else None
                        ),
                        "hardBrakingCount": trip.get("hardBrakingCount", 0),
                        "hardAccelerationCount": trip.get(
                            "hardAccelerationCount",
                            0,
                        ),
                        "totalIdleDurationFormatted": trip.get(
                            "totalIdleDurationFormatted",
                            None,
                        ),
                        "source": trip.get("source", "unknown"),
                    },
                )
                features.append(feature)
            except Exception as e:
                logger.exception(
                    "Error processing matched trip %s: %s",
                    trip.get("transactionId"),
                    str(e),
                )
                continue

        return JSONResponse(content=GeometryService.feature_collection(features))
    except Exception as e:
        logger.exception(
            "Error in get_matched_trips: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/matched_trips/delete")
async def delete_matched_trips(
    data: DateRangeModel,
):
    """Delete matched trips within a date range."""
    try:
        start_iso = normalize_calendar_date(data.start_date)
        end_iso = normalize_calendar_date(data.end_date)
        interval_days = data.interval_days

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
        if interval_days > 0:
            chunk_size = max(1, interval_days)
            current_start = datetime.strptime(start_iso, "%Y-%m-%d").date()
            final_end = datetime.strptime(end_iso, "%Y-%m-%d").date()

            while current_start <= final_end:
                current_end = min(
                    current_start + timedelta(days=chunk_size - 1),
                    final_end,
                )
                chunk_expr = build_calendar_date_expr(
                    current_start.isoformat(),
                    current_end.isoformat(),
                )
                if chunk_expr:
                    result = await delete_many_with_retry(
                        matched_trips_collection,
                        {"$expr": chunk_expr},
                    )
                    total_deleted_count += result.deleted_count
                current_start = current_end + timedelta(days=1)
        else:
            result = await delete_many_with_retry(
                matched_trips_collection,
                {"$expr": range_expr},
            )
            total_deleted_count = result.deleted_count

        return {
            "status": "success",
            "deleted_count": total_deleted_count,
        }
    except Exception as e:
        logger.exception(
            "Error in delete_matched_trips: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error deleting matched trips: {e}",
        )


@router.delete("/api/matched_trips/{trip_id}")
async def delete_matched_trip(trip_id: str):
    """Delete a single matched trip by ID."""
    try:
        result = await delete_one_with_retry(
            matched_trips_collection,
            {
                "$or": [
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ],
            },
        )
        if result.deleted_count:
            return {
                "status": "success",
                "message": "Deleted matched trip",
            }

        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trip not found",
        )
    except Exception as e:
        logger.exception(
            "Error deleting matched trip %s: %s",
            trip_id,
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/trips_in_bounds")
async def get_trips_in_bounds(
    min_lat: float = Query(
        ...,
        description="Minimum latitude of the bounding box",
    ),
    min_lon: float = Query(
        ...,
        description="Minimum longitude of the bounding box",
    ),
    max_lat: float = Query(
        ...,
        description="Maximum latitude of the bounding box",
    ),
    max_lon: float = Query(
        ...,
        description="Maximum longitude of the bounding box",
    ),
):
    """Get raw trip coordinates (from trips collection) within a given bounding box.

    Uses a spatial query for efficiency.
    """
    try:
        if not GeometryService.validate_bounding_box(
            min_lat,
            min_lon,
            max_lat,
            max_lon,
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid bounding box coordinates (lat must be -90 to 90, lon -180 to 180).",
            )

        bounding_box_geometry = GeometryService.bounding_box_polygon(
            min_lat,
            min_lon,
            max_lat,
            max_lon,
        )
        if bounding_box_geometry is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid bounding box coordinates (lat must be -90 to 90, lon -180 to 180).",
            )

        query = {
            "matchedGps": {
                "$geoIntersects": {
                    "$geometry": bounding_box_geometry,
                },
            },
            "invalid": {"$ne": True},
        }

        projection = {
            "_id": 0,
            "matchedGps.coordinates": 1,
            "transactionId": 1,
        }

        cursor = matched_trips_collection.find(query, projection)

        trip_features = []
        async for trip_doc in cursor:
            if trip_doc.get("matchedGps") and trip_doc["matchedGps"].get("coordinates"):
                coords = trip_doc["matchedGps"]["coordinates"]
                geometry = GeometryService.geometry_from_coordinate_pairs(
                    coords,
                    allow_point=False,
                    dedupe=False,
                    validate=False,
                )
                if geometry is not None:
                    feature = GeometryService.feature_from_geometry(
                        geometry,
                        properties={
                            "transactionId": trip_doc.get("transactionId", "N/A")
                        },
                    )
                    trip_features.append(feature)
                else:
                    logger.warning(
                        "Skipping matched trip %s in bounds query due to invalid/insufficient coordinates.",
                        trip_doc.get("transactionId", "N/A"),
                    )

        logger.info(
            "Found %d matched trip segments within bounds.",
            len(trip_features),
        )
        return JSONResponse(content=GeometryService.feature_collection(trip_features))

    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.exception(
            "Error in get_trips_in_bounds: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve trips within bounds: {str(e)}",
        )
