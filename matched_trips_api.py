import logging
from datetime import timedelta

import geojson as geojson_module
from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse

from db import (
    SerializationHelper,
    build_query_from_request,
    db_manager,
    delete_many_with_retry,
    delete_one_with_retry,
    find_with_retry,
    parse_query_date,
)
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

        matched = await find_with_retry(
            matched_trips_collection, query, sort=[("startTime", -1)]
        )
        features = []

        for trip in matched:
            try:
                mgps = trip["matchedGps"]
                geometry_dict = (
                    mgps if isinstance(mgps, dict) else geojson_module.loads(mgps)
                )
                feature = geojson_module.Feature(
                    geometry=geometry_dict,
                    properties={
                        "transactionId": trip["transactionId"],
                        "imei": trip.get("imei", ""),
                        "startTime": SerializationHelper.serialize_datetime(
                            trip.get("startTime"),
                        )
                        or "",
                        "endTime": SerializationHelper.serialize_datetime(
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

        fc = geojson_module.FeatureCollection(features)
        return JSONResponse(content=fc)
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
        start_date = parse_query_date(data.start_date)
        end_date = parse_query_date(data.end_date, end_of_day=True)
        interval_days = data.interval_days

        if not start_date or not end_date:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid date range",
            )

        total_deleted_count = 0
        if interval_days > 0:
            current_start = start_date
            while current_start < end_date:
                current_end = min(
                    current_start + timedelta(days=interval_days),
                    end_date,
                )
                result = await delete_many_with_retry(
                    matched_trips_collection,
                    {
                        "startTime": {
                            "$gte": current_start,
                            "$lt": current_end,
                        },
                    },
                )
                total_deleted_count += result.deleted_count
                current_start = current_end
        else:
            result = await delete_many_with_retry(
                matched_trips_collection,
                {
                    "startTime": {
                        "$gte": start_date,
                        "$lte": end_date,
                    },
                },
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
        if not (
            -90 <= min_lat <= 90
            and -90 <= max_lat <= 90
            and -180 <= min_lon <= 180
            and -180 <= max_lon <= 180
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid bounding box coordinates (lat must be -90 to 90, lon -180 to 180).",
            )

        bounding_box_polygon_coords = [
            [min_lon, min_lat],
            [max_lon, min_lat],
            [max_lon, max_lat],
            [min_lon, max_lat],
            [min_lon, min_lat],
        ]

        query = {
            "matchedGps": {
                "$geoIntersects": {
                    "$geometry": {
                        "type": "Polygon",
                        "coordinates": [bounding_box_polygon_coords],
                    },
                },
            },
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
                if isinstance(coords, list) and len(coords) >= 2:
                    feature = geojson_module.Feature(
                        geometry=geojson_module.LineString(coords),
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

        feature_collection = geojson_module.FeatureCollection(trip_features)
        logger.info(
            "Found %d matched trip segments within bounds.",
            len(trip_features),
        )
        return JSONResponse(content=feature_collection)

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