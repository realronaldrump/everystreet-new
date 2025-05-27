import asyncio
import json
import logging
import os
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Set

import geojson as geojson_module
import gpxpy
import httpx
import numpy as np
from dateutil import parser as dateutil_parser
from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sklearn.cluster import KMeans

from coverage_api import router as coverage_api_router  # This is key
from db import (
    SerializationHelper,
    aggregate_with_retry,
    build_query_from_request,
    db_manager,
    delete_many_with_retry,
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    get_trip_by_id,
    init_database,
    parse_query_date,
)
from export_api import router as export_api_router
from live_tracking import get_active_trip, get_trip_updates
from live_tracking import initialize_db as initialize_live_tracking_db
from models import (
    ActiveTripResponseUnion,
    ActiveTripSuccessResponse,
    BulkProcessModel,
    CollectionModel,
    DateRangeModel,
    LocationModel,
    NoActiveTripResponse,
    ValidateLocationModel,
)
from osm_utils import generate_geojson_osm
from pages import router as pages_router
from tasks import process_webhook_event_task
from tasks_api import router as tasks_api_router
from trip_processor import TripProcessor, TripState
from update_geo_points import update_geo_points
from utils import calculate_distance, cleanup_session, haversine, validate_location_osm
from visits import init_collections
from visits import router as visits_router

# Removed export_helpers imports that were specific to export endpoints
# from export_helpers import (
#     create_csv_export, # Moved to export_api.py
#     create_export_response, # Moved to export_api.py
#     default_serializer, # Moved to export_api.py
#     extract_date_range_string, # Moved to export_api.py
#     get_location_filename, # Moved to export_api.py
#     process_trip_for_export, # Moved to export_api.py
# )


load_dotenv()


logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Street Coverage Tracker")
app.mount(
    "/static",
    StaticFiles(directory="static"),
    name="static",
)
templates = Jinja2Templates(directory="templates")

origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(visits_router)
app.include_router(pages_router)
app.include_router(tasks_api_router)
app.include_router(export_api_router)  # Router for export endpoints
app.include_router(coverage_api_router)  # Router for coverage endpoints

CLIENT_ID = os.getenv("CLIENT_ID", "")
CLIENT_SECRET = os.getenv("CLIENT_SECRET", "")
REDIRECT_URI = os.getenv("REDIRECT_URI", "")
AUTH_CODE = os.getenv("AUTHORIZATION_CODE", "")
AUTHORIZED_DEVICES = [
    d for d in os.getenv("AUTHORIZED_DEVICES", "").split(",") if d
]
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"

trips_collection = db_manager.db["trips"]
matched_trips_collection = db_manager.db["matched_trips"]
places_collection = db_manager.db["places"]
streets_collection = db_manager.db["streets"]

live_trips_collection = db_manager.db["live_trips"]
archived_live_trips_collection = db_manager.db["archived_live_trips"]


class ConnectionManager:
    """Keeps track of all connected clients and broadcasts JSON payloads."""

    def __init__(self) -> None:
        self.active: Set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self.active.discard(ws)

    async def broadcast_json(self, data: dict) -> None:
        living = set()
        for ws in self.active:
            try:
                await ws.send_json(data)
                living.add(ws)
            except WebSocketDisconnect:
                pass
        self.active = living


manager = ConnectionManager()


async def process_and_store_trip(trip: dict, source: str = "upload") -> None:
    """Process and store a trip using TripProcessor.

    Args:
        trip: Trip data dictionary
        source: The source of the trip ('upload', 'upload_gpx', 'upload_geojson')

    """
    gps_data = trip.get("gps")
    if isinstance(gps_data, str):
        try:
            gps_data = json.loads(gps_data)
            trip["gps"] = gps_data
        except json.JSONDecodeError as e:
            logger.warning(
                "Invalid GPS data for trip %s",
                trip.get("transactionId", "unknown"),
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid GPS JSON for trip {
                    trip.get('transactionId', 'unknown')
                }",
            ) from e

    processor = TripProcessor(
        mapbox_token=MAPBOX_ACCESS_TOKEN,
        source=source,
    )
    processor.set_trip_data(trip)
    await processor.process(do_map_match=False)
    await processor.save()


async def process_geojson_trip(
    geojson_data: dict,
) -> list[dict] | None:
    """Process GeoJSON trip data into trip dictionaries.

    Args:
        geojson_data: GeoJSON data with trip features

    Returns:
        List of trip dictionaries, or None if processing failed

    """
    try:
        feats = geojson_data.get("features", [])
        trips = []
        for f in feats:
            props = f.get("properties", {})
            geom = f.get("geometry", {})
            stime_str = props.get("start_time")
            etime_str = props.get("end_time")
            tid = props.get(
                "transaction_id",
                f"geojson-{int(datetime.now().timestamp())}",
            )
            stime_parsed = (
                dateutil_parser.isoparse(stime_str)
                if stime_str
                else datetime.now(timezone.utc)
            )
            etime_parsed = (
                dateutil_parser.isoparse(etime_str)
                if etime_str
                else stime_parsed
            )
            trip_geo = {
                "type": geom.get("type"),
                "coordinates": geom.get("coordinates"),
            }
            dist_miles = calculate_distance(geom.get("coordinates", []))
            trips.append(
                {
                    "transactionId": tid,
                    "startTime": stime_parsed,
                    "endTime": etime_parsed,
                    "gps": trip_geo,
                    "distance": dist_miles,
                    "imei": "UPLOADED",
                    "source": "upload_geojson",
                },
            )
        return trips
    except Exception:
        logger.exception("Error in process_geojson_trip")
        return None


@app.post("/api/process_trip/{trip_id}")
async def process_single_trip(
    trip_id: str,
    validate_only: bool = False,
    geocode_only: bool = False,
    map_match: bool = True,
):
    """Process a single trip with options to validate, geocode, and map
    match.
    """
    try:
        trip = await get_trip_by_id(trip_id, trips_collection)

        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trip not found",
            )

        source = trip.get("source", "unknown")

        processor = TripProcessor(
            mapbox_token=MAPBOX_ACCESS_TOKEN,
            source=source,
        )
        processor.set_trip_data(trip)

        if validate_only:
            await processor.validate()
            processing_status = processor.get_processing_status()
            return {
                "status": "success",
                "processing_status": processing_status,
                "is_valid": processing_status["state"]
                == TripState.VALIDATED.value,
            }
        if geocode_only:
            await processor.validate()
            if processor.state == TripState.VALIDATED:
                await processor.process_basic()
                if processor.state == TripState.PROCESSED:
                    await processor.geocode()

            saved_id = await processor.save()
            processing_status = processor.get_processing_status()
            return {
                "status": "success",
                "processing_status": processing_status,
                "geocoded": processing_status["state"]
                == TripState.GEOCODED.value,
                "saved_id": saved_id,
            }
        await processor.process(do_map_match=map_match)
        saved_id = await processor.save(map_match_result=map_match)
        processing_status = processor.get_processing_status()

        return {
            "status": "success",
            "processing_status": processing_status,
            "completed": processing_status["state"]
            == TripState.COMPLETED.value,
            "saved_id": saved_id,
        }

    except Exception as e:
        logger.exception(
            "Error processing trip %s: %s",
            trip_id,
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/bulk_process_trips")
async def bulk_process_trips(
    data: BulkProcessModel,
):
    """Process multiple trips in bulk with configurable options."""
    try:
        query = data.query
        options = data.options
        limit = min(data.limit, 500)

        do_validate = options.get("validate", True)
        do_geocode = options.get("geocode", True)
        do_map_match = options.get("map_match", False)

        collection = trips_collection

        trips = await find_with_retry(collection, query, limit=limit)

        if not trips:
            return {
                "status": "success",
                "message": "No trips found matching criteria",
                "count": 0,
            }

        results = {
            "total": len(trips),
            "validated": 0,
            "geocoded": 0,
            "map_matched": 0,
            "failed": 0,
            "skipped": 0,
        }

        for trip in trips:
            try:
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=MAPBOX_ACCESS_TOKEN,
                    source=source,
                )
                processor.set_trip_data(trip)

                if do_validate:
                    await processor.validate()
                    if processor.state == TripState.VALIDATED:
                        results["validated"] += 1
                    else:
                        results["failed"] += 1
                        continue

                if do_geocode and processor.state == TripState.VALIDATED:
                    await processor.process_basic()
                    if processor.state == TripState.PROCESSED:
                        await processor.geocode()
                        if processor.state == TripState.GEOCODED:
                            results["geocoded"] += 1
                        else:
                            results["failed"] += 1
                            continue
                    else:
                        results["failed"] += 1
                        continue

                if do_map_match and processor.state == TripState.GEOCODED:
                    await processor.map_match()
                    if processor.state == TripState.MAP_MATCHED:
                        results["map_matched"] += 1
                    else:
                        results["failed"] += 1
                        continue

                saved_id = await processor.save(map_match_result=do_map_match)
                if not saved_id:
                    results["failed"] += 1
            except Exception as e:
                logger.error(
                    "Error processing trip %s: %s",
                    trip.get("transactionId"),
                    str(e),
                )
                results["failed"] += 1

        return {
            "status": "success",
            "message": f"Processed {len(trips)} trips",
            "results": results,
        }
    except Exception as e:
        logger.exception(
            "Error in bulk_process_trips: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/trips/{trip_id}/status")
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


@app.post("/api/validate_location")
async def validate_location(
    data: ValidateLocationModel,
):
    """Validate a location using OpenStreetMap."""
    validated = await validate_location_osm(data.location, data.locationType)
    return validated


@app.post("/api/generate_geojson")
async def generate_geojson_endpoint(
    location: LocationModel,
    streets_only: bool = False,
):
    """Generate GeoJSON for a location using the imported function."""
    geojson_data, err = await generate_geojson_osm(
        location.dict(),
        streets_only,
    )
    if geojson_data:
        return geojson_data
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=err or "Unknown error",
    )


@app.post("/api/map_match_trips")
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

        processed_count = 0
        failed_count = 0
        for trip in trips_list:
            try:
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=MAPBOX_ACCESS_TOKEN,
                    source=source,
                )
                processor.set_trip_data(trip)
                await processor.process(do_map_match=True)
                result = await processor.save(map_match_result=True)

                if result:
                    processed_count += 1
                else:
                    failed_count += 1
                    logger.warning(
                        "Failed to save matched trip %s",
                        trip.get("transactionId"),
                    )
            except Exception as e:
                failed_count += 1
                logger.error(
                    "Error processing trip %s: %s",
                    trip.get("transactionId"),
                    str(e),
                )

        return {
            "status": "success",
            "message": f"Map matching completed: {processed_count} successful, {failed_count} failed.",
            "processed_count": processed_count,
            "failed_count": failed_count,
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


@app.get("/api/matched_trips")
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
                    mgps
                    if isinstance(mgps, dict)
                    else geojson_module.loads(mgps)
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


@app.post("/api/matched_trips/delete")
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


@app.post("/api/matched_trips/remap")
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

        processed_count = 0
        for trip in trips_list:
            try:
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=MAPBOX_ACCESS_TOKEN,
                    source=source,
                )
                processor.set_trip_data(trip)
                await processor.process(do_map_match=True)
                await processor.save(map_match_result=True)
                processed_count += 1
            except Exception as e:
                logger.error(
                    "Error remapping trip %s: %s",
                    trip.get("transactionId"),
                    str(e),
                )

        return {
            "status": "success",
            "message": f"Re-matching completed. Processed {processed_count} trips.",
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


# --- START: Endpoints moved to export_api.py ---
# @app.get("/api/export/trip/{trip_id}") ...
# @app.delete("/api/matched_trips/{trip_id}") ... # This was not an export endpoint, should remain or be moved elsewhere if not fitting. It's a matched_trip specific delete.
# @app.get("/api/export/all_trips") ...
# @app.get("/api/export/trips") ...
# @app.get("/api/export/matched_trips") ...
# @app.get("/api/export/streets") ...
# @app.get("/api/export/boundary") ...
# @app.post("/api/export/coverage-route") ...
# @app.get("/api/export/advanced") ...
# --- END: Endpoints moved to export_api.py ---


@app.delete("/api/matched_trips/{trip_id}")
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


@app.get("/api/last_trip_point")
async def get_last_trip_point():
    """Get coordinates of the last point in the most recent trip."""
    try:
        most_recent = await find_one_with_retry(
            trips_collection,
            {},
            sort=[("endTime", -1)],
        )

        if not most_recent:
            return {"lastPoint": None}

        gps_data = most_recent["gps"]
        if isinstance(gps_data, str):
            gps_data = geojson_module.loads(gps_data)

        if "coordinates" not in gps_data or not gps_data["coordinates"]:
            return {"lastPoint": None}

        return {"lastPoint": gps_data["coordinates"][-1]}
    except Exception as e:
        logger.exception(
            "Error get_last_trip_point: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve last trip point",
        )


@app.get("/api/trips/{trip_id}")
async def get_single_trip(trip_id: str):
    """Get a single trip by ID."""
    try:
        trip = await get_trip_by_id(trip_id, trips_collection)

        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trip not found",
            )

        return {
            "status": "success",
            "trip": SerializationHelper.serialize_trip(trip),
        }
    except Exception as e:
        logger.exception("get_single_trip error: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error",
        )


@app.delete("/api/trips/{trip_id}")
async def delete_trip(trip_id: str):
    """Delete a trip by ID."""
    try:
        trip = await get_trip_by_id(trip_id, trips_collection)

        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trip not found",
            )

        result = await delete_one_with_retry(
            trips_collection,
            {"transactionId": trip_id},
        )

        matched_delete_result = await delete_one_with_retry(
            matched_trips_collection,
            {"transactionId": trip_id},
        )

        if result.deleted_count == 1:
            return {
                "status": "success",
                "message": "Trip deleted successfully",
                "deleted_trips": result.deleted_count,
                "deleted_matched_trips": (
                    matched_delete_result.deleted_count
                    if matched_delete_result
                    else 0
                ),
            }

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete trip from primary collection",
        )

    except Exception as e:
        logger.exception("Error deleting trip: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error",
        )


@app.get("/api/first_trip_date")
async def get_first_trip_date():
    """Get the date of the earliest trip in the database."""
    try:
        earliest_trip = await find_one_with_retry(
            trips_collection,
            {},
            sort=[("startTime", 1)],
        )

        if not earliest_trip or not earliest_trip.get("startTime"):
            now = datetime.now(timezone.utc)
            return {"first_trip_date": now.isoformat()}

        earliest_trip_date = earliest_trip["startTime"]
        if earliest_trip_date.tzinfo is None:
            earliest_trip_date = earliest_trip_date.replace(
                tzinfo=timezone.utc,
            )

        return {
            "first_trip_date": SerializationHelper.serialize_datetime(
                earliest_trip_date,
            ),
        }
    except Exception as e:
        logger.exception(
            "get_first_trip_date error: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/upload_gpx")
async def upload_gpx_endpoint(
    files: list[UploadFile] = File(...),
):
    """Upload GPX or GeoJSON files and process them into the trips
    collection.
    """
    try:
        if not files:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No files found for upload",
            )

        success_count = 0
        for f in files:
            filename = f.filename.lower() if f.filename else "unknown_file"
            content = await f.read()

            if filename.endswith(".gpx"):
                try:
                    gpx_obj = gpxpy.parse(content)
                    for track in gpx_obj.tracks:
                        for seg in track.segments:
                            if len(seg.points) < 2:
                                continue

                            times = [p.time for p in seg.points if p.time]
                            if not times:
                                continue
                            st = min(times)
                            en = max(times)

                            coord_data = []
                            for point in seg.points:
                                if point.time:
                                    coord_data.append(
                                        {
                                            "timestamp": point.time,
                                            "lat": point.latitude,
                                            "lon": point.longitude,
                                        },
                                    )

                            trip_data = await TripProcessor.process_from_coordinates(
                                coord_data,
                                start_time=st,
                                end_time=en,
                                transaction_id=f"GPX-{st.strftime('%Y%m%d%H%M%S')}-{filename}",
                                imei="UPLOADED",
                                source="upload_gpx",
                                mapbox_token=MAPBOX_ACCESS_TOKEN,
                            )

                            processor = TripProcessor(
                                mapbox_token=MAPBOX_ACCESS_TOKEN,
                                source="upload_gpx",
                            )
                            processor.set_trip_data(trip_data)
                            await processor.save()
                            success_count += 1
                except Exception as gpx_err:
                    logger.error(
                        "Error processing GPX file %s: %s",
                        filename,
                        gpx_err,
                    )
                    continue

            elif filename.endswith(".geojson"):
                try:
                    data_geojson = json.loads(content)
                    trips_to_process = await process_geojson_trip(data_geojson)
                    if trips_to_process:
                        valid_trip_count_for_file = 0
                        for trip_dict in trips_to_process:
                            # process_geojson_trip now returns 'gps' as validated GeoJSON or None.
                            # process_and_store_trip will pass this to TripProcessor.
                            if trip_dict.get("gps") is not None: # Only process if GPS data is valid
                                await process_and_store_trip(
                                    trip_dict,
                                    source="upload_geojson",
                                )
                                success_count += 1
                                valid_trip_count_for_file +=1
                            else:
                                logger.warning(
                                    f"Skipping trip with transactionId {trip_dict.get('transactionId', 'N/A')} "
                                    f"from GeoJSON file {filename} due to invalid or missing GPS data after validation."
                                )
                        if valid_trip_count_for_file == 0 and trips_to_process:
                             logger.warning(f"GeoJSON file {filename} contained trips, but none had valid GPS data after processing.")
                except json.JSONDecodeError:
                    logger.warning(
                        "Invalid GeoJSON: %s",
                        filename,
                    )
                    continue
                except Exception as geojson_err:
                    logger.error(
                        "Error processing GeoJSON file %s: %s",
                        filename,
                        geojson_err,
                    )
                    continue
            else:
                logger.warning(
                    "Skipping unhandled file extension: %s",
                    filename,
                )

        return {
            "status": "success",
            "message": f"{success_count} trips uploaded.",
        }
    except Exception as e:
        logger.exception("Error upload_gpx: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/upload")
async def upload_files(
    files: list[UploadFile] = File(...),
):
    """Upload GPX or GeoJSON files and process them into the trips
    collection.
    """
    try:
        count = 0
        for file in files:
            filename = (
                file.filename.lower() if file.filename else "unknown_file"
            )
            content_data = await file.read()

            if filename.endswith(".gpx"):
                try:
                    gpx_obj = gpxpy.parse(content_data)
                    for track in gpx_obj.tracks:
                        for seg in track.segments:
                            if not seg.points or len(seg.points) < 2:
                                continue
                            coords = [
                                [
                                    p.longitude,
                                    p.latitude,
                                ]
                                for p in seg.points
                            ]
                            times = [p.time for p in seg.points if p.time]
                            if not times:
                                continue
                            st = min(times)
                            en = max(times)
                            trip_dict = {
                                "transactionId": f"GPX-{st.strftime('%Y%m%d%H%M%S')}-{filename}",
                                "startTime": st,
                                "endTime": en,
                                "gps": {
                                    "type": "LineString",
                                    "coordinates": coords,
                                },
                                "imei": "UPLOADED",
                                # "distance": calculate_distance(coords), # Will be recalculated by TripProcessor
                                "source": "upload_gpx",
                            }
                            
                            # Standardize GPS for GPX upload
                            standardized_gpx_gps = None
                            if coords:
                                # Deduplicate and determine Point/LineString
                                unique_gpx_coords = []
                                if coords:
                                    unique_gpx_coords.append(coords[0])
                                    for i in range(1, len(coords)):
                                        if coords[i] != coords[i-1]:
                                            unique_gpx_coords.append(coords[i])
                                
                                if len(unique_gpx_coords) == 1:
                                    standardized_gpx_gps = {
                                        "type": "Point",
                                        "coordinates": unique_gpx_coords[0]
                                    }
                                elif len(unique_gpx_coords) >= 2:
                                    standardized_gpx_gps = {
                                        "type": "LineString",
                                        "coordinates": unique_gpx_coords
                                    }
                                else: # No valid unique points
                                    logger.warning(f"GPX segment for {filename} produced no valid unique coordinates.")
                            
                            if standardized_gpx_gps:
                                trip_dict["gps"] = standardized_gpx_gps
                                # Calculate distance based on the final unique coordinates
                                trip_dict["distance"] = calculate_distance(standardized_gpx_gps.get("coordinates", []))

                                await process_and_store_trip(
                                    trip_dict,
                                    source="upload_gpx",
                                )
                                count += 1
                            else:
                                logger.warning(f"Skipping GPX track/segment in {filename} due to no valid GPS data after standardization.")
                                
                except Exception as gpx_err:
                    logger.error(
                        "Error processing GPX file %s in /api/upload: %s",
                        filename,
                        gpx_err,
                    )
                    continue

            elif filename.endswith(".geojson"):
                try:
                    data_geojson = json.loads(content_data)
                    trips = await process_geojson_trip(data_geojson)
                    if trips: # trips is a list of trip_dicts from process_geojson_trip
                        processed_one_from_file = False
                        for t in trips:
                            # t['gps'] is already a validated GeoJSON dict or None
                            if t.get("gps") is not None: 
                                await process_and_store_trip(
                                    t,
                                    source="upload_geojson",
                                )
                                count += 1
                                processed_one_from_file = True
                            else:
                                logger.warning(
                                    f"Skipping trip with transactionId {t.get('transactionId', 'N/A')} "
                                    f"from GeoJSON file {filename} in /api/upload due to invalid/missing GPS after validation."
                                )
                        if not processed_one_from_file and trips:
                            logger.warning(f"GeoJSON file {filename} in /api/upload contained trips, but none had valid GPS after processing.")
                except json.JSONDecodeError:
                    logger.warning(
                        "Invalid geojson: %s",
                        filename,
                    )
                    continue
                except Exception as geojson_err:
                    logger.error(
                        "Error processing GeoJSON file %s in /api/upload: %s",
                        filename,
                        geojson_err,
                    )
                    continue

        return {
            "status": "success",
            "message": f"Processed {count} trips",
        }
    except Exception as e:
        logger.exception("Error uploading files: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/trip-analytics")
async def get_trip_analytics(request: Request):
    """Get analytics on trips over time."""
    try:
        query = await build_query_from_request(request)

        if "startTime" not in query:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing date range",
            )

        pipeline = [
            {"$match": query},
            {
                "$group": {
                    "_id": {
                        "date": {
                            "$dateToString": {
                                "format": "%Y-%m-%d",
                                "date": "$startTime",
                            },
                        },
                        "hour": {"$hour": "$startTime"},
                    },
                    "totalDistance": {"$sum": "$distance"},
                    "tripCount": {"$sum": 1},
                },
            },
        ]

        results = await aggregate_with_retry(trips_collection, pipeline)

        def organize_daily_data(res):
            daily_data = {}
            for r in res:
                date_key = r["_id"]["date"]
                if date_key not in daily_data:
                    daily_data[date_key] = {
                        "distance": 0,
                        "count": 0,
                    }
                daily_data[date_key]["distance"] += r["totalDistance"]
                daily_data[date_key]["count"] += r["tripCount"]
            return [
                {
                    "date": d,
                    "distance": v["distance"],
                    "count": v["count"],
                }
                for d, v in sorted(daily_data.items())
            ]

        def organize_hourly_data(res):
            hourly_data = {}
            for r in res:
                hr = r["_id"]["hour"]
                if hr not in hourly_data:
                    hourly_data[hr] = 0
                hourly_data[hr] += r["tripCount"]
            return [
                {"hour": h, "count": c} for h, c in sorted(hourly_data.items())
            ]

        daily_list = organize_daily_data(results)
        hourly_list = organize_hourly_data(results)

        return JSONResponse(
            content={
                "daily_distances": daily_list,
                "time_distribution": hourly_list,
            },
        )

    except Exception as e:
        logger.exception("Error trip analytics: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/update_geo_points")
async def update_geo_points_route(
    collection_name: str,
):
    """Update geo points for all trips in a collection."""
    if collection_name != "trips":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid collection name. Only 'trips' is supported.",
        )

    collection = trips_collection

    try:
        await update_geo_points(collection)
        return {"message": f"GeoPoints updated for {collection_name}"}
    except Exception as e:
        logger.exception(
            "Error in update_geo_points_route: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error updating GeoPoints: {e}",
        )


@app.post("/api/regeocode_all_trips")
async def regeocode_all_trips():
    """Regeocode all trips in the database."""
    try:
        collection = trips_collection
        trips_list = await find_with_retry(collection, {})
        for trip in trips_list:
            try:
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=MAPBOX_ACCESS_TOKEN,
                    source=source,
                )
                processor.set_trip_data(trip)
                await processor.validate()
                if processor.state == TripState.VALIDATED:
                    await processor.process_basic()
                    if processor.state == TripState.PROCESSED:
                        await processor.geocode()
                        await processor.save()
            except Exception as trip_err:
                logger.error(
                    "Error regeocoding trip %s: %s",
                    trip.get("transactionId", "unknown"),
                    trip_err,
                )
                continue

        return {"message": "All trips re-geocoded successfully."}
    except Exception as e:
        logger.exception(
            "Error in regeocode_all_trips: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error re-geocoding trips: {e}",
        )


@app.post("/api/trips/refresh_geocoding")
async def refresh_geocoding_for_trips(
    trip_ids: list[str],
):
    """Refresh geocoding for specific trips."""
    if not trip_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No trip_ids provided",
        )

    updated_count = 0
    failed_count = 0
    for trip_id in trip_ids:
        try:
            trip = await find_one_with_retry(
                trips_collection,
                {"transactionId": trip_id},
            )
            if trip:
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=MAPBOX_ACCESS_TOKEN,
                    source=source,
                )
                processor.set_trip_data(trip)
                await processor.validate()
                if processor.state == TripState.VALIDATED:
                    await processor.process_basic()
                    if processor.state == TripState.PROCESSED:
                        await processor.geocode()
                        if processor.state == TripState.GEOCODED:
                            await processor.save()
                            updated_count += 1
                        else:
                            failed_count += 1
                    else:
                        failed_count += 1
                else:
                    failed_count += 1
            else:
                logger.warning(
                    "Trip not found for geocoding refresh: %s",
                    trip_id,
                )
                failed_count += 1
        except Exception as e:
            logger.error(
                "Error refreshing geocoding for trip %s: %s",
                trip_id,
                str(e),
            )
            failed_count += 1

    return {
        "message": f"Geocoding refreshed for {updated_count} trips. Failed: {failed_count}",
        "updated_count": updated_count,
        "failed_count": failed_count,
    }


@app.post("/webhook/bouncie")
async def bouncie_webhook(request: Request):
    """Receives webhook events from Bouncie, acknowledges immediately,
    and schedules background processing via Celery.
    """
    try:
        raw_body = await request.body()
        try:
            data = json.loads(raw_body)
        except json.JSONDecodeError:
            logger.error(
                "Failed to parse JSON from Bouncie webhook request body.",
            )
            return JSONResponse(
                content={
                    "status": "error",
                    "message": "Invalid JSON body",
                },
                status_code=400,
            )

        event_type = data.get("eventType")
        transaction_id = data.get("transactionId")

        if not event_type:
            logger.warning(
                "Webhook received with missing eventType. Acknowledging but not queuing. Body: %s",
                raw_body[:500],
            )
            return JSONResponse(
                content={"status": "acknowledged_invalid_event"},
                status_code=200,
            )

        logger.info(
            "Webhook received: Type=%s, TransactionID=%s. Scheduling for background processing.",
            event_type,
            transaction_id or "N/A",
        )

        try:
            process_webhook_event_task.delay(data)
            logger.debug(
                "Successfully scheduled task for webhook event: Type=%s, TxID=%s",
                event_type,
                transaction_id or "N/A",
            )
        except Exception as celery_err:
            error_id = str(uuid.uuid4())
            logger.exception(
                "Failed to schedule Celery task for webhook [%s]: Type=%s, TxID=%s, Error: %s",
                error_id,
                event_type,
                transaction_id or "N/A",
                celery_err,
            )
            return JSONResponse(
                content={
                    "status": "error",
                    "message": "Failed to schedule background task",
                    "error_id": error_id,
                },
                status_code=500,
            )

        return JSONResponse(
            content={"status": "acknowledged"},
            status_code=202,
        )

    except Exception as e:
        error_id = str(uuid.uuid4())
        logger.exception(
            "Critical error handling webhook request before queuing [%s]: %s",
            error_id,
            e,
        )
        return JSONResponse(
            content={
                "status": "error",
                "message": "Internal server error",
                "error_id": error_id,
            },
            status_code=500,
        )


@app.get(
    "/api/active_trip",
    response_model=ActiveTripResponseUnion,
    summary="Get Currently Active Trip",
    description="Retrieves the latest active trip, optionally filtering if it's newer than a given sequence number.",
)
async def active_trip_endpoint():
    """Get the currently active trip, if any."""
    try:
        logger.info("Fetching active trip data")
        active_trip_doc = await get_active_trip()

        if not active_trip_doc:
            logger.info("No active trip found (or not newer than sequence)")
            return NoActiveTripResponse(server_time=datetime.now(timezone.utc))

        logger.info(
            "Returning active trip: %s",
            active_trip_doc.get("transactionId", "unknown"),
        )
        return ActiveTripSuccessResponse(
            trip=active_trip_doc,
            server_time=datetime.now(timezone.utc),
        )

    except Exception as e:
        error_id = str(uuid.uuid4())
        logger.exception(
            "Internal error fetching active trip [%s]: %s",
            error_id,
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "message": "An internal error occurred while retrieving the active trip.",
                "error_id": error_id,
            },
        )


@app.get("/api/trip_updates")
async def trip_updates_endpoint(last_sequence: int = Query(0, ge=0)):
    """Get trip updates since a specific sequence number.

    Args:
        last_sequence: Only return updates newer than this sequence

    Returns:
        Dict: Contains status, has_update flag, and trip data if available

    """
    try:
        logger.info(
            "Fetching trip updates since sequence %d",
            last_sequence,
        )

        if not db_manager._connection_healthy:  # type: ignore
            logger.error("Database connection is unhealthy")
            return JSONResponse(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                content={
                    "status": "error",
                    "has_update": False,
                    "message": "Database connection error",
                    "error_code": "DB_CONNECTION_ERROR",
                    "server_time": datetime.now(timezone.utc).isoformat(),
                },
            )

        updates = await get_trip_updates(last_sequence)

        if updates.get("has_update"):
            logger.info(
                "Returning trip update with sequence %d",
                updates.get("trip", {}).get("sequence", 0),
            )
        else:
            logger.info(
                "No trip updates found since sequence %d",
                last_sequence,
            )

        updates["server_time"] = datetime.now(timezone.utc).isoformat()
        return updates

    except Exception as e:
        error_id = str(uuid.uuid4())
        logger.exception(
            "Error in trip_updates endpoint [%s]: %s",
            error_id,
            str(e),
        )

        error_message = str(e)
        error_code = "INTERNAL_ERROR"
        status_code_val = status.HTTP_500_INTERNAL_SERVER_ERROR

        if (
            "Cannot connect to database" in error_message
            or "ServerSelectionTimeoutError" in error_message
        ):
            error_code = "DB_CONNECTION_ERROR"
            status_code_val = status.HTTP_503_SERVICE_UNAVAILABLE
        elif "Memory" in error_message:  # type: ignore
            error_code = "MEMORY_ERROR"

        return JSONResponse(
            status_code=status_code_val,
            content={
                "status": "error",
                "has_update": False,
                "message": f"Error retrieving trip updates: {error_message}",
                "error_id": error_id,
                "error_code": error_code,
                "server_time": datetime.now(timezone.utc).isoformat(),
            },
        )


@app.post("/api/database/clear-collection")
async def clear_collection(data: CollectionModel):
    """Clear all documents from a collection."""
    try:
        name = data.collection
        if not name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing 'collection' field",
            )

        result = await delete_many_with_retry(db_manager.db[name], {})

        return {
            "message": f"Successfully cleared collection {name}",
            "deleted_count": result.deleted_count,
        }

    except Exception as e:
        logger.exception(
            "Error clearing collection: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/database/storage-info")
async def get_storage_info():
    """Get database storage usage information."""
    try:
        used_mb, limit_mb = await db_manager.check_quota()

        if used_mb is None or limit_mb is None:
            used_mb = 0
            limit_mb = 512
            storage_usage_percent = 0
        else:
            storage_usage_percent = round((used_mb / limit_mb) * 100, 2)

        return {
            "used_mb": used_mb,
            "limit_mb": limit_mb,
            "usage_percent": storage_usage_percent,
        }
    except Exception as e:
        logger.exception(
            "Error getting storage info: %s",
            str(e),
        )
        return {
            "used_mb": 0,
            "limit_mb": 512,
            "usage_percent": 0,
            "error": str(e),
        }


async def _get_mapbox_optimization_route(
    start_lon: float,
    start_lat: float,
    end_points: list[tuple] = None,
) -> dict[str, Any]:
    """Calls Mapbox Optimization API v1 to get an optimized route for multiple
    points.
    """
    mapbox_token = MAPBOX_ACCESS_TOKEN
    if not mapbox_token:
        logger.error("Mapbox API token not configured.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Mapbox API token not configured.",
        )

    if not end_points:
        logger.error("No end points provided for optimization route.")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No end points provided for optimization route.",
        )

    if (
        len(end_points) > 11
    ):  # Mapbox Optimization API v1 limit (start + 11 waypoints = 12 total)
        logger.warning(
            "Too many end points for Mapbox Optimization API v1 (max 11 destinations + start). Limiting to first 11.",
        )
        end_points = end_points[:11]

    coords = [f"{start_lon},{start_lat}"]
    for lon, lat in end_points:
        coords.append(f"{lon},{lat}")
    coords_str = ";".join(coords)

    url = f"https://api.mapbox.com/optimized-trips/v1/mapbox/driving/{coords_str}"
    params = {
        "access_token": mapbox_token,
        "geometries": "geojson",
        "steps": "false",  # Changed to string "false" as per Mapbox docs
        "overview": "full",
        "source": "first",  # Keep start point fixed
        # "destination": "last", # Can be 'any' or 'last'
        # "roundtrip": "false" # Default is false
    }

    async with httpx.AsyncClient() as client:
        response = await client.get(url, params=params)

        if response.status_code != 200:
            logger.error(
                "Mapbox Optimization API error: %s - %s",
                response.status_code,
                response.text,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Mapbox Optimization API error: {response.status_code} - {response.text}",
            )

        data = response.json()
        if data.get("code") != "Ok" or not data.get("trips"):
            logger.error(
                "Mapbox Optimization API returned no valid trips: %s",
                data,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Mapbox Optimization API returned no valid trips: {data.get('message', 'Unknown reason')}",
            )

        trip = data["trips"][
            0
        ]  # API returns 0 or 1 trip; prior check ensures 'trips' is not empty.
        geometry = trip.get("geometry", {})
        duration = trip.get("duration", 0)
        distance = trip.get("distance", 0)

        return {
            "geometry": geometry,
            "duration": duration,
            "distance": distance,
            "waypoints": trip.get(
                "waypoints", []
            ),  # Return waypoints to see the optimized order
        }


@app.post("/api/driving-navigation/next-route")
async def get_next_driving_route(
    request: Request,
):
    """Calculates the route from the user's current position to the
    start of the nearest undriven street segment in the specified area using Mapbox
    Optimization API v1.

    Accepts a JSON payload with:
    - location: The target area location model
    - current_position: Optional current position {lat, lon} (falls back to live
    tracking if not provided)
    """
    try:
        data = await request.json()
        if "location" not in data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Target location data is required",
            )

        location = LocationModel(**data["location"])
        location_name = location.display_name

        if not location_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Location display name is required.",
            )

        current_position = data.get("current_position")

    except (
        ValueError,
        TypeError,
        json.JSONDecodeError,
    ) as e:  # Added JSONDecodeError
        logger.error("Error parsing request data for next-route: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid request format: {e!s}",
        )

    current_lat: float
    current_lon: float
    location_source: str

    try:
        if (
            current_position
            and isinstance(current_position, dict)
            and "lat" in current_position
            and "lon" in current_position
        ):
            current_lat = float(current_position["lat"])
            current_lon = float(current_position["lon"])
            location_source = "client-provided"

            logger.info(
                "Using client-provided location: Lat=%s, Lon=%s",
                current_lat,
                current_lon,
            )

        else:
            logger.info(
                "No position provided in request, falling back to live tracking data",
            )
            active_trip_data = (
                await get_active_trip()
            )  # This returns a dict or None

            if (
                active_trip_data  # Check if not None
                and isinstance(active_trip_data, dict)  # Ensure it's a dict
                and active_trip_data.get("coordinates")
                and len(active_trip_data["coordinates"]) > 0
            ):
                latest_coord_point = active_trip_data["coordinates"][-1]
                current_lat = latest_coord_point["lat"]
                current_lon = latest_coord_point["lon"]
                location_source = "live-tracking"
                logger.info(
                    "Using live tracking location: Lat=%s, Lon=%s",
                    current_lat,
                    current_lon,
                )
            else:
                logger.info(
                    "Live tracking unavailable, falling back to last trip end location",
                )
                last_trip = await find_one_with_retry(
                    trips_collection,
                    {},
                    sort=[("endTime", -1)],
                )

                if not last_trip:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Current position not provided, live location unavailable, and no previous trips found.",
                    )

                try:
                    # Ensure gps is a dict, not a string
                    gps_data = last_trip.get("gps")
                    if isinstance(gps_data, str):
                        gps_data = geojson_module.loads(
                            gps_data
                        )  # Or json.loads if it's just JSON string

                    geom = last_trip.get("geometry") or gps_data

                    if (
                        geom
                        and geom.get("type") == "LineString"
                        and len(geom.get("coordinates", [])) > 0
                    ):
                        last_coord = geom["coordinates"][-1]
                        current_lon = float(last_coord[0])
                        current_lat = float(last_coord[1])
                        location_source = "last-trip-end"
                        logger.info(
                            "Using last trip end location: Lat=%s, Lon=%s (Trip ID: %s)",
                            current_lat,
                            current_lon,
                            last_trip.get(
                                "transactionId",
                                "N/A",
                            ),
                        )
                    else:
                        raise ValueError(
                            "Invalid or empty geometry/gps in last trip",
                        )
                except (
                    json.JSONDecodeError,
                    ValueError,
                    TypeError,
                    IndexError,
                ) as e:
                    logger.error(
                        "Failed to extract end location from last trip %s: %s",
                        last_trip.get("transactionId", "N/A"),
                        e,
                    )
                    raise HTTPException(
                        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                        detail="Failed to determine starting location from last trip.",
                    )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            "Error getting position for next-route: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not determine current position: {e}",
        )

    try:
        undriven_streets_cursor = streets_collection.find(
            {
                "properties.location": location_name,
                "properties.driven": False,
                "properties.undriveable": {
                    "$ne": True
                },  # Also exclude undriveable
                "geometry.coordinates": {
                    "$exists": True,
                    "$not": {"$size": 0},
                },
            },
            {
                "geometry.coordinates": 1,
                "properties.segment_id": 1,
                "properties.street_name": 1,
                "_id": 0,
                "geometry.type": 1,
            },
        )
        undriven_streets = await undriven_streets_cursor.to_list(length=None)

        if not undriven_streets:
            return JSONResponse(
                content={
                    "status": "completed",
                    "message": f"No undriven streets found in {location_name}.",
                    "route_geometry": None,
                    "target_street": None,
                },
            )
        logger.info(
            "Found %d undriven segments in %s. Starting optimization with Mapbox API v1.",
            len(undriven_streets),
            location_name,
        )

    except Exception as e:
        logger.error(
            "Error fetching undriven streets for %s (next-route): %s",
            location_name,
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error fetching undriven streets: {e}",
        )

    try:
        # Prepare end_points for Mapbox Optimization API
        # These are the start nodes of the undriven streets
        end_points_with_street_info = []
        for street in undriven_streets:
            geometry = street.get("geometry", {})
            if geometry.get("type") == "LineString" and geometry.get(
                "coordinates",
            ):
                start_node = geometry["coordinates"][0]  # lon, lat
                if (
                    isinstance(start_node, (list, tuple))
                    and len(start_node) >= 2
                ):
                    end_points_with_street_info.append(
                        {
                            "coord": (
                                float(start_node[0]),
                                float(start_node[1]),
                            ),
                            "street_info": street.get("properties", {}),
                        }
                    )

        if not end_points_with_street_info:
            return JSONResponse(
                content={
                    "status": "completed",  # Or error, depending on interpretation
                    "message": f"No valid undriven streets with coordinates found in {location_name} for routing.",
                    "route_geometry": None,
                    "target_street": None,
                },
            )

        # Sort potential target streets by Haversine distance from current location to their start node
        # This helps in picking the "nearest" ones if we need to limit for the Optimization API
        current_pos_tuple = (current_lon, current_lat)
        end_points_with_street_info.sort(
            key=lambda p: haversine(
                current_pos_tuple[0],
                current_pos_tuple[1],
                p["coord"][0],
                p["coord"][1],
            )
        )

        # Select up to 11 (Mapbox limit) closest street start points
        # The Optimization API takes start_lon, start_lat and a list of destination points
        destinations_for_api = [
            p["coord"] for p in end_points_with_street_info[:11]
        ]

        optimization_result = await _get_mapbox_optimization_route(
            current_lon,
            current_lat,
            end_points=destinations_for_api,
        )

        route_geometry = optimization_result["geometry"]
        route_duration_seconds = optimization_result["duration"]
        route_distance_meters = optimization_result["distance"]

        # Determine the actual target street based on the optimized route's first waypoint
        # The waypoints returned by Mapbox are in the optimized order.
        # Waypoint 0 is the start. Waypoint 1 is the first destination.
        optimized_waypoints = optimization_result.get("waypoints", [])
        target_street_info = None

        if len(optimized_waypoints) > 1:
            # The first destination in the optimized route
            first_optimized_destination_waypoint = optimized_waypoints[1]
            # Find which of our original streets corresponds to this optimized first stop
            # The 'waypoint_index' in Mapbox response refers to the index in the *input* coordinates array (after start).
            # So, if destinations_for_api was [A, B, C], and Mapbox says waypoint_index 0 for the first stop, it means A.
            original_destination_index = (
                first_optimized_destination_waypoint.get("waypoint_index")
            )
            if (
                original_destination_index is not None
                and original_destination_index
                < len(end_points_with_street_info)
            ):
                target_street_info = end_points_with_street_info[
                    original_destination_index
                ]["street_info"]

        return JSONResponse(
            content={
                "status": "success",
                "message": "Route calculated using Mapbox Optimization API v1.",
                "route_geometry": route_geometry,
                "target_street": target_street_info,  # This is properties of the target street
                "route_duration_seconds": route_duration_seconds,
                "route_distance_meters": route_distance_meters,
                "location_source": location_source,
            },
        )

    except HTTPException as http_exc:  # Re-raise HTTPExceptions from _get_mapbox_optimization_route
        raise http_exc
    except Exception as e:
        logger.error(
            "Error calculating next-route: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to calculate route: {e}",
        )


async def _get_mapbox_directions_route(
    start_lon: float,
    start_lat: float,
    end_lon: float,
    end_lat: float,
) -> dict[str, Any]:
    """Calls Mapbox Directions API to get a route between two points."""
    mapbox_token = MAPBOX_ACCESS_TOKEN
    if not mapbox_token:
        logger.error("Mapbox API token not configured.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Mapbox API token not configured.",
        )

    coords_str = f"{start_lon},{start_lat};{end_lon},{end_lat}"
    directions_url = (
        f"https://api.mapbox.com/directions/v5/mapbox/driving/{coords_str}"
    )
    params = {
        "access_token": mapbox_token,
        "geometries": "geojson",
        "overview": "full",
        "steps": "false",  # String "false"
    }

    async with httpx.AsyncClient() as client:
        response = await client.get(directions_url, params=params)

        if response.status_code != 200:
            logger.error(
                "Mapbox Directions API error: %s - %s",
                response.status_code,
                response.text,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Mapbox Directions API error: {response.status_code} - {response.text}",
            )

        route_data = response.json()
        if not route_data.get("routes") or len(route_data["routes"]) == 0:
            logger.warning(
                "Mapbox API returned no routes for %s,%s -> %s,%s. Response: %s",
                start_lon,
                start_lat,
                end_lon,
                end_lat,
                route_data,
            )
            # Consider what to do if no route is found. For now, raising an error.
            # Depending on use case, might return a default/empty route.
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,  # Or 500 if it's unexpected
                detail=f"No route found by Mapbox Directions API. Message: {route_data.get('message', 'Unknown reason')}",
            )

        route = route_data["routes"][0]
        geometry = route["geometry"]
        duration = route.get("duration", 0)
        distance = route.get("distance", 0)

        logger.debug(
            "Mapbox Route Received: Duration=%.1fs, Distance=%.1fm",
            duration,
            distance,
        )
        return {
            "geometry": geometry,
            "duration": duration,
            "distance": distance,
        }


async def _cluster_segments(
    segments: list[dict],
    max_points_per_cluster: int = 11,  # Max destinations for Mapbox Optimization API v1 (excluding start)
) -> list[list[dict]]:
    """Cluster segments into groups based on geographic proximity."""
    if not segments:
        return []
    if len(segments) <= max_points_per_cluster:
        return [segments]

    # Use start_node for clustering
    coords = np.array(
        [
            (
                seg["start_node"][0],  # lon
                seg["start_node"][1],  # lat
            )
            for seg in segments
            if seg.get("start_node")  # Ensure start_node exists
        ],
    )

    if coords.shape[0] == 0:  # No valid segments with start_nodes
        return []

    # Determine number of clusters
    # Ensure n_clusters is not more than number of samples
    n_clusters = min(
        max(1, coords.shape[0] // max_points_per_cluster), coords.shape[0]
    )

    try:
        kmeans = KMeans(
            n_clusters=n_clusters, random_state=0, n_init="auto"
        ).fit(coords)
    except ValueError as e:  # Handle cases like n_samples < n_clusters
        logger.warning(
            f"KMeans clustering failed: {e}. Falling back to simpler clustering or single cluster."
        )
        if coords.shape[0] <= max_points_per_cluster:
            return [segments]  # Put all in one if few segments
        # Simple fallback: chunk them
        return [
            segments[i : i + max_points_per_cluster]
            for i in range(0, len(segments), max_points_per_cluster)
        ]

    labels = kmeans.labels_

    clusters_dict = defaultdict(list)
    # Map original segments (which have more info) to clusters
    valid_segment_idx = 0
    for i, seg in enumerate(segments):
        if seg.get(
            "start_node"
        ):  # Only cluster segments that were used in coords
            clusters_dict[labels[valid_segment_idx]].append(seg)
            valid_segment_idx += 1
        # else: # Segments without start_node could be handled separately or ignored for clustering
        # logger.warning(f"Segment {seg.get('id', 'Unknown')} skipped in clustering due to missing start_node.")

    # Convert dict of clusters to list of clusters
    clusters = [
        cluster_list for cluster_list in clusters_dict.values() if cluster_list
    ]

    # Further split large clusters if any cluster is still too big (shouldn't happen with good n_clusters)
    final_clusters = []
    for cluster in clusters:
        if len(cluster) > max_points_per_cluster:
            for i in range(0, len(cluster), max_points_per_cluster):
                final_clusters.append(cluster[i : i + max_points_per_cluster])
        elif cluster:  # Ensure cluster is not empty
            final_clusters.append(cluster)

    return final_clusters


async def _optimize_route_for_clusters(
    start_point: tuple[float, float],  # lon, lat
    clusters: list[
        list[dict]
    ],  # list of clusters, each cluster is list of segment dicts
) -> dict[str, Any]:
    """Optimize route for multiple clusters, connecting them with directions."""
    if not clusters:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No clusters provided for route optimization.",
        )

    total_duration = 0.0
    total_distance = 0.0
    all_geometries = []  # List of GeoJSON geometry objects
    current_lon, current_lat = start_point

    for i, cluster_segments in enumerate(clusters):
        if not cluster_segments:
            continue

        # End points for this cluster are the start_nodes of its segments
        cluster_destinations = [
            seg["start_node"]
            for seg in cluster_segments
            if seg.get("start_node")
        ]

        if not cluster_destinations:  # Skip cluster if no valid destinations
            logger.warning(f"Cluster {i} has no valid destinations, skipping.")
            continue

        try:
            # Optimize within the cluster (or to the cluster from current point)
            # The first point in cluster_destinations will be the "entry" to the cluster
            # The API handles optimizing the order of cluster_destinations
            cluster_opt_result = await _get_mapbox_optimization_route(
                current_lon,
                current_lat,
                end_points=cluster_destinations,  # List of (lon, lat) tuples
            )

            if cluster_opt_result and cluster_opt_result.get("geometry"):
                all_geometries.append(cluster_opt_result["geometry"])
                total_duration += cluster_opt_result.get("duration", 0)
                total_distance += cluster_opt_result.get("distance", 0)

                # Update current_lon, current_lat to the end of this optimized cluster segment
                # The last coordinate of the *geometry* of the optimized trip for the cluster
                if cluster_opt_result["geometry"].get("coordinates"):
                    last_coord_in_cluster_route = cluster_opt_result[
                        "geometry"
                    ]["coordinates"][-1]
                    current_lon, current_lat = (
                        last_coord_in_cluster_route[0],
                        last_coord_in_cluster_route[1],
                    )
                else:  # Should not happen if geometry is valid
                    logger.warning(
                        f"Optimized route for cluster {i} has no coordinates."
                    )
                    # Fallback: use the last point of the *last waypoint* in the optimized order
                    optimized_waypoints = cluster_opt_result.get(
                        "waypoints", []
                    )
                    if optimized_waypoints:
                        last_waypoint_in_cluster = optimized_waypoints[-1]
                        # waypoint location is [lon, lat]
                        current_lon, current_lat = (
                            last_waypoint_in_cluster.get(
                                "location", [current_lon, current_lat]
                            )
                        )

            # If not the last cluster, get directions to the start of the next cluster
            if i < len(clusters) - 1:
                next_cluster_segments = clusters[i + 1]
                if next_cluster_segments and next_cluster_segments[0].get(
                    "start_node"
                ):
                    next_cluster_start_lon, next_cluster_start_lat = (
                        next_cluster_segments[0]["start_node"]
                    )

                    try:
                        connection_result = await _get_mapbox_directions_route(
                            current_lon,
                            current_lat,
                            next_cluster_start_lon,
                            next_cluster_start_lat,
                        )
                        if connection_result and connection_result.get(
                            "geometry"
                        ):
                            all_geometries.append(
                                connection_result["geometry"]
                            )
                            total_duration += connection_result.get(
                                "duration", 0
                            )
                            total_distance += connection_result.get(
                                "distance", 0
                            )
                            # Update current point to the start of the next cluster (where directions ended)
                            current_lon, current_lat = (
                                next_cluster_start_lon,
                                next_cluster_start_lat,
                            )
                    except HTTPException as e_dir:
                        logger.warning(
                            f"Could not get directions between cluster {i} and {i + 1}: {e_dir.detail}"
                        )
                        # Decide how to handle: skip connection, or stop? For now, just log and continue.
                        # The current_lon, current_lat will remain at end of cluster i.

            await asyncio.sleep(0.2)  # Rate limiting for Mapbox APIs

        except HTTPException as e_opt:
            logger.warning(
                f"Optimization for cluster {i} failed: {e_opt.detail}. Skipping cluster."
            )
            # If one cluster optimization fails, we might want to try to route to the next one from current_lon, current_lat
            continue  # Skip to next cluster

    combined_geometry = {
        "type": "GeometryCollection",
        "geometries": all_geometries,
    }

    return {
        "geometry": combined_geometry,
        "duration": total_duration,
        "distance": total_distance,
    }


@app.post("/api/driving-navigation/coverage-route")
async def get_coverage_driving_route(
    request: Request,
):
    """Calculates an optimized route to cover multiple undriven street segments."""
    try:
        data = await request.json()
        if "location" not in data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Target location data is required",
            )

        location = LocationModel(**data["location"])
        location_name = location.display_name

        if not location_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Location display name is required.",
            )

        current_position_data = data.get("current_position")

    except (ValueError, TypeError, json.JSONDecodeError) as e:
        logger.error("Error parsing request data for coverage-route: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid request format: {e!s}",
        )

    current_lat: float
    current_lon: float
    location_source: str
    start_point: tuple[float, float]  # lon, lat

    try:  # Determine start_point (current_lon, current_lat)
        if (
            current_position_data
            and isinstance(current_position_data, dict)
            and "lat" in current_position_data
            and "lon" in current_position_data
        ):
            current_lat = float(current_position_data["lat"])
            current_lon = float(current_position_data["lon"])
            location_source = "client-provided"
        else:
            active_trip_data = await get_active_trip()
            if (
                active_trip_data
                and isinstance(active_trip_data, dict)
                and active_trip_data.get("coordinates")
                and len(active_trip_data["coordinates"]) > 0
            ):
                latest_coord = active_trip_data["coordinates"][-1]
                current_lat, current_lon = (
                    latest_coord["lat"],
                    latest_coord["lon"],
                )
                location_source = "live-tracking"
            else:
                last_trip = await find_one_with_retry(
                    trips_collection, {}, sort=[("endTime", -1)]
                )
                if not last_trip:
                    raise HTTPException(
                        status_code=404,
                        detail="Cannot determine start: No current_position, live tracking, or previous trips.",
                    )

                gps_data = last_trip.get("gps")
                if isinstance(gps_data, str):
                    gps_data = geojson_module.loads(gps_data)
                geom = last_trip.get("geometry") or gps_data

                if (
                    geom
                    and geom.get("type") == "LineString"
                    and len(geom.get("coordinates", [])) > 0
                ):
                    last_coord_pair = geom["coordinates"][-1]
                    current_lon, current_lat = (
                        float(last_coord_pair[0]),
                        float(last_coord_pair[1]),
                    )
                    location_source = "last-trip-end"
                else:
                    raise ValueError(
                        "Invalid geometry in last trip for start point."
                    )

        start_point = (current_lon, current_lat)
        logger.info(
            f"Coverage Route: Start point set to ({current_lon}, {current_lat}) via {location_source}"
        )

    except Exception as e:
        logger.error(
            "Coverage Route: Error getting start position: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Could not determine current position: {e}",
        )

    try:  # Fetch and prepare undriven streets
        undriven_streets_cursor = streets_collection.find(
            {
                "properties.location": location_name,
                "properties.driven": False,
                "properties.undriveable": {"$ne": True},
                "geometry.coordinates": {
                    "$exists": True,
                    "$not": {"$size": 0},
                },
            },
            {
                "geometry": 1,
                "properties.segment_id": 1,
                "properties.street_name": 1,
                "_id": 0,
            },
        )
        undriven_streets_list = await undriven_streets_cursor.to_list(
            length=None
        )

        if not undriven_streets_list:
            return JSONResponse(
                content={
                    "status": "completed",
                    "message": f"No undriven streets in {location_name}.",
                }
            )

        valid_segments = []
        for street_doc in undriven_streets_list:
            geom = street_doc.get("geometry")
            props = street_doc.get("properties", {})
            if (
                geom
                and geom.get("type") == "LineString"
                and len(geom.get("coordinates", [])) >= 1
            ):  # Need at least one point for start_node
                coords = geom["coordinates"]
                try:
                    start_node_lonlat = (
                        float(coords[0][0]),
                        float(coords[0][1]),
                    )
                    # end_node_lonlat might not be needed if Mapbox optimizes to visit the segment start
                    # end_node_lonlat = (float(coords[-1][0]), float(coords[-1][1])) if len(coords) > 1 else start_node_lonlat
                    valid_segments.append(
                        {
                            "id": props.get("segment_id", str(uuid.uuid4())),
                            "name": props.get("street_name"),
                            "geometry": geom,
                            "start_node": start_node_lonlat,  # (lon, lat)
                            # "end_node": end_node_lonlat
                        }
                    )
                except (TypeError, ValueError, IndexError) as e_coord:
                    logger.warning(
                        f"Skipping segment {props.get('segment_id')} due to coordinate error: {e_coord}"
                    )

        if not valid_segments:
            return JSONResponse(
                content={
                    "status": "error",
                    "message": f"No processable undriven streets in {location_name}.",
                }
            )

        logger.info(
            f"Coverage Route: Processing {len(valid_segments)} valid undriven segments for {location_name}."
        )

    except Exception as e:
        logger.error(
            f"Coverage Route: Error fetching/processing streets for {location_name}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=500, detail=f"Error preparing segments: {e}"
        )

    try:  # Cluster and optimize
        # Max 11 destinations for Mapbox Optimization API v1
        clusters = await _cluster_segments(
            valid_segments, max_points_per_cluster=11
        )
        if not clusters:
            return JSONResponse(
                content={
                    "status": "error",
                    "message": "Failed to cluster segments.",
                }
            )

        logger.info(
            f"Coverage Route: Clustered {len(valid_segments)} segments into {len(clusters)} clusters."
        )

        optimization_result = await _optimize_route_for_clusters(
            start_point, clusters
        )

        segments_covered = sum(len(c) for c in clusters)
        message = f"Coverage route for {segments_covered} segments in {len(clusters)} clusters."

        logger.info(
            f"Coverage Route: Generated route for {location_name}. Segments: {segments_covered}, Duration: {optimization_result['duration']:.1f}s, Distance: {optimization_result['distance']:.1f}m"
        )
        return JSONResponse(
            content={
                "status": "success",
                "message": message,
                "route_geometry": optimization_result["geometry"],
                "total_duration_seconds": optimization_result["duration"],
                "total_distance_meters": optimization_result["distance"],
                "location_source": location_source,
            }
        )

    except HTTPException as http_exc:  # Propagate HTTPExceptions from helpers
        raise http_exc
    except Exception as e:
        logger.error(
            f"Coverage Route: Error generating optimized route: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=500, detail=f"Failed to generate coverage route: {e}"
        )


@app.on_event("startup")
async def startup_event():
    """Initialize database indexes and components on application startup."""
    try:
        await init_database()  # This already creates many indexes
        logger.info("Core database initialized successfully (indexes, etc.).")

        initialize_live_tracking_db(
            live_trips_collection,
            archived_live_trips_collection,
        )
        logger.info("Live tracking DB collections initialized.")

        init_collections(places_collection, trips_collection)
        logger.info("Visits collections initialized.")

        TripProcessor(
            mapbox_token=MAPBOX_ACCESS_TOKEN
        )  # Initializes the class, not an instance for immediate use
        logger.info("TripProcessor class initialized (available for use).")

        used_mb, limit_mb = await db_manager.check_quota()
        if not db_manager.quota_exceeded:
            logger.info("Application startup completed successfully.")
        else:
            logger.warning(
                "Application started in limited mode due to exceeded storage quota (%.2f MB / %d MB)",
                (
                    used_mb if used_mb is not None else -1.0
                ),  # Ensure float for formatting
                (limit_mb if limit_mb is not None else -1),
            )

    except Exception as e:
        logger.critical(
            "CRITICAL: Failed to initialize application during startup: %s",
            str(e),
            exc_info=True,
        )
        raise


@app.on_event("shutdown")
async def shutdown_event():
    """Clean up resources when shutting down."""
    await db_manager.cleanup_connections()
    await cleanup_session()
    logger.info("Application shutdown completed successfully")


@app.exception_handler(404)
async def not_found_handler(request: Request, exc: HTTPException):
    """Handle 404 Not Found errors."""
    logger.warning(f"404 Not Found: {request.url}. Detail: {exc.detail}")
    return JSONResponse(
        status_code=status.HTTP_404_NOT_FOUND,
        content={"error": "Endpoint not found", "detail": exc.detail},
    )


@app.exception_handler(500)
async def internal_error_handler(request: Request, exc: Exception):
    """Handle 500 Internal Server Error errors."""
    error_id = str(uuid.uuid4())
    logger.error(
        f"Internal Server Error (ID: {error_id}): Request {request.method} {request.url} failed. Exception: {exc}",
        exc_info=True,
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": "Internal server error",
            "error_id": error_id,
            "detail": str(exc),
        },
    )


@app.get("/api/trips_in_bounds")
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
            if trip_doc.get("matchedGps") and trip_doc["matchedGps"].get(
                "coordinates"
            ):
                coords = trip_doc["matchedGps"]["coordinates"]
                if isinstance(coords, list) and len(coords) >= 2:
                    feature = geojson_module.Feature(
                        geometry=geojson_module.LineString(coords),
                        properties={
                            "transactionId": trip_doc.get(
                                "transactionId", "N/A"
                            )
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


@app.get(
    "/driver-behavior",
    response_class=HTMLResponse,
)
async def driver_behavior_page(request: Request):
    return templates.TemplateResponse(
        "driver_behavior.html",
        {"request": request},
    )


@app.get("/api/driver-behavior")
async def driver_behavior_analytics():
    trips = await trips_collection.find({}).to_list(length=None)
    if not trips:
        return {
            "totalTrips": 0,
            "totalDistance": 0,
            "avgSpeed": 0,
            "maxSpeed": 0,
            "hardBrakingCounts": 0,
            "hardAccelerationCounts": 0,
            "totalIdlingTime": 0,
            "fuelConsumed": 0,
            "weekly": [],
            "monthly": [],
        }

    def get_field(trip, *names, default=0):
        for n in names:
            v = trip.get(n)
            if v is not None:
                try:
                    return float(v) if "." in str(v) else int(v)
                except (ValueError, TypeError):
                    continue
        return default

    total_trips = len(trips)
    total_distance = sum(get_field(t, "distance", default=0.0) for t in trips)

    speeds_sum = sum(
        get_field(t, "avgSpeed", "averageSpeed", default=0.0)
        for t in trips
        if t.get("avgSpeed") is not None or t.get("averageSpeed") is not None
    )
    num_trips_with_speed = sum(
        1
        for t in trips
        if t.get("avgSpeed") is not None or t.get("averageSpeed") is not None
    )
    avg_speed = (
        speeds_sum / num_trips_with_speed if num_trips_with_speed > 0 else 0.0
    )

    max_speeds = [get_field(t, "maxSpeed", default=0.0) for t in trips]
    max_speed = max(max_speeds) if max_speeds else 0.0

    hard_braking = sum(
        get_field(t, "hardBrakingCounts", "hardBrakingCount", default=0)
        for t in trips
    )
    hard_accel = sum(
        get_field(
            t, "hardAccelerationCounts", "hardAccelerationCount", default=0
        )
        for t in trips
    )
    idling = sum(
        get_field(t, "totalIdlingTime", "totalIdleDuration", default=0.0)
        for t in trips
    )
    fuel = sum(get_field(t, "fuelConsumed", default=0.0) for t in trips)

    weekly = defaultdict(
        lambda: {
            "trips": 0,
            "distance": 0.0,
            "hardBraking": 0,
            "hardAccel": 0,
        },
    )
    monthly = defaultdict(
        lambda: {
            "trips": 0,
            "distance": 0.0,
            "hardBraking": 0,
            "hardAccel": 0,
        },
    )

    for t in trips:
        start_time_raw = t.get("startTime")
        if not start_time_raw:
            continue

        start_dt: datetime | None = None
        if isinstance(start_time_raw, datetime):
            start_dt = start_time_raw
        elif isinstance(start_time_raw, str):
            try:
                start_dt = dateutil_parser.isoparse(start_time_raw)
            except ValueError:
                logger.warning(
                    f"Could not parse startTime '{start_time_raw}' for trip {t.get('transactionId')}"
                )
                continue
        else:
            logger.warning(
                f"Unexpected startTime type '{type(start_time_raw)}' for trip {t.get('transactionId')}"
            )
            continue

        if not start_dt:
            continue

        if start_dt.tzinfo is None:
            start_dt = start_dt.replace(tzinfo=timezone.utc)

        year, week, _ = start_dt.isocalendar()
        month_val = start_dt.month

        wkey = f"{year}-W{week:02d}"
        mkey = f"{year}-{month_val:02d}"

        weekly[wkey]["trips"] += 1
        weekly[wkey]["distance"] += get_field(t, "distance", default=0.0)
        weekly[wkey]["hardBraking"] += get_field(
            t, "hardBrakingCounts", "hardBrakingCount", default=0
        )
        weekly[wkey]["hardAccel"] += get_field(
            t, "hardAccelerationCounts", "hardAccelerationCount", default=0
        )

        monthly[mkey]["trips"] += 1
        monthly[mkey]["distance"] += get_field(t, "distance", default=0.0)
        monthly[mkey]["hardBraking"] += get_field(
            t, "hardBrakingCounts", "hardBrakingCount", default=0
        )
        monthly[mkey]["hardAccel"] += get_field(
            t, "hardAccelerationCounts", "hardAccelerationCount", default=0
        )

    weekly_trend = [{"week": k, **v} for k, v in sorted(weekly.items())]
    monthly_trend = [{"month": k, **v} for k, v in sorted(monthly.items())]

    return {
        "totalTrips": total_trips,
        "totalDistance": round(total_distance, 2),
        "avgSpeed": round(avg_speed, 2),
        "maxSpeed": round(max_speed, 2),
        "hardBrakingCounts": hard_braking,
        "hardAccelerationCounts": hard_accel,
        "totalIdlingTime": round(idling, 2),
        "fuelConsumed": round(fuel, 2),
        "weekly": weekly_trend,
        "monthly": monthly_trend,
    }


@app.websocket("/ws/trips")
async def ws_trip_updates(websocket: WebSocket) -> None:
    """Pushes the same structure returned by /api/trip_updates via WebSocket."""
    await manager.connect(websocket)
    client_info = (
        f"{websocket.client.host}:{websocket.client.port}"
        if websocket.client
        else "UnknownClient"
    )
    logger.info(f"WebSocket client {client_info} connected to /ws/trips.")

    last_seq = 0
    try:
        while True:
            try:
                updates = await get_trip_updates(last_seq)

                if (
                    updates
                    and updates.get("has_update")
                    and updates.get("trip")
                ):
                    trip_data = updates.get("trip")
                    current_sequence = (
                        trip_data.get("sequence")
                        if isinstance(trip_data, dict)
                        else None
                    )

                    if current_sequence is not None:
                        if "server_time" in updates and isinstance(
                            updates["server_time"], datetime
                        ):
                            updates["server_time"] = updates[
                                "server_time"
                            ].isoformat()
                        if (
                            isinstance(trip_data, dict)
                            and "timestamp" in trip_data
                            and isinstance(trip_data["timestamp"], datetime)
                        ):
                            trip_data["timestamp"] = trip_data[
                                "timestamp"
                            ].isoformat()

                        await websocket.send_json(updates)
                        last_seq = current_sequence
                    else:
                        logger.warning(
                            f"WebSocket {client_info}: Trip update for txId "
                            f"{trip_data.get('transactionId') if isinstance(trip_data, dict) else 'N/A'} "
                            f"is missing sequence. Current last_seq: {last_seq}. Update: {updates}"
                        )
                elif updates and updates.get("status") == "error":
                    logger.error(
                        f"WebSocket {client_info}: get_trip_updates returned error: "
                        f"{updates.get('message')}. Update: {updates}"
                    )

            except WebSocketDisconnect:
                logger.info(
                    f"WebSocket {client_info}: Client disconnected during inner loop processing (WebSocketDisconnect)."
                )
                raise
            except Exception as e:
                logger.error(
                    f"WebSocket {client_info}: Error in WebSocket /ws/trips processing loop: {e!s}",
                    exc_info=True,
                )
                try:
                    await websocket.close(
                        code=status.WS_1011_INTERNAL_ERROR,
                        reason="Internal server error during update processing.",
                    )
                except Exception:
                    pass
                break

            await asyncio.sleep(0.1)

    except WebSocketDisconnect:
        logger.info(
            f"WebSocket {client_info}: Client disconnected (handled by outer try/except)."
        )
    except Exception as e:
        logger.error(
            f"WebSocket {client_info}: Unhandled exception in WebSocket /ws/trips handler: {e!s}",
            exc_info=True,
        )
        try:
            await websocket.close(
                code=status.WS_1011_INTERNAL_ERROR,
                reason="Unhandled server error in WebSocket handler.",
            )
        except Exception:
            pass
    finally:
        manager.disconnect(websocket)
        logger.info(
            f"WebSocket {client_info}: Connection closed and resources cleaned up for /ws/trips."
        )


@app.post("/api/mapbox/directions")
async def get_mapbox_directions(request: Request):
    """Proxy endpoint for Mapbox Directions API to avoid CORS issues and hide API keys."""
    try:
        data = await request.json()
        start_lon = data.get("start_lon")
        start_lat = data.get("start_lat")
        end_lon = data.get("end_lon")
        end_lat = data.get("end_lat")

        if None in [start_lon, start_lat, end_lon, end_lat]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing required coordinates (start_lon, start_lat, end_lon, end_lat)",
            )

        route_details = await _get_mapbox_directions_route(
            float(start_lon), float(start_lat), float(end_lon), float(end_lat)
        )
        return JSONResponse(content=route_details)

    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error("Error getting Mapbox directions: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get Mapbox directions: {str(e)}",
        )


@app.post("/api/driving-navigation/simple-route")
async def get_simple_driving_route(
    request: Request,
):
    """Simple driving navigation endpoint that finds nearby undriven streets
    and calculates basic routes without complex optimization.
    """
    try:
        data = await request.json()
        if "location" not in data:
            raise HTTPException(
                status_code=400, detail="Target location data is required"
            )

        location_model = LocationModel(**data["location"])
        location_name = location_model.display_name
        if not location_name:
            raise HTTPException(
                status_code=400, detail="Location display name is required."
            )

        user_loc_data = data.get("user_location")
        if (
            not user_loc_data
            or "lat" not in user_loc_data
            or "lon" not in user_loc_data
        ):
            raise HTTPException(
                status_code=400, detail="User location {lat, lon} is required"
            )

        user_lat, user_lon = (
            float(user_loc_data["lat"]),
            float(user_loc_data["lon"]),
        )
        limit = int(data.get("limit", 10))

    except (ValueError, TypeError, json.JSONDecodeError) as e:
        raise HTTPException(
            status_code=400, detail=f"Invalid request format: {e}"
        )

    try:
        undriven_streets_cursor = streets_collection.find(
            {
                "properties.location": location_name,
                "properties.driven": False,
                "properties.undriveable": {"$ne": True},
                "geometry.coordinates": {
                    "$exists": True,
                    "$not": {"$size": 0},
                },
            },
            {"geometry": 1, "properties": 1, "_id": 0},
        )
        undriven_streets = await undriven_streets_cursor.to_list(length=None)

        if not undriven_streets:
            return JSONResponse(
                content={
                    "status": "success",
                    "message": f"No undriven streets in {location_name}.",
                    "streets": [],
                }
            )

        streets_with_distance = []
        for street_doc in undriven_streets:
            geom = street_doc.get("geometry", {})
            if geom.get("type") == "LineString" and geom.get("coordinates"):
                coords = geom["coordinates"]
                if coords and len(coords[0]) >= 2:
                    street_start_lon, street_start_lat = (
                        float(coords[0][0]),
                        float(coords[0][1]),
                    )
                    distance = haversine(
                        user_lon,
                        user_lat,
                        street_start_lon,
                        street_start_lat,
                        unit="miles",
                    )
                    streets_with_distance.append(
                        {
                            "street_properties": street_doc.get(
                                "properties", {}
                            ),
                            "street_geometry": geom,
                            "distance_to_start_miles": distance,
                            "start_coords_lonlat": (
                                street_start_lon,
                                street_start_lat,
                            ),
                        }
                    )

        streets_with_distance.sort(key=lambda x: x["distance_to_start_miles"])
        nearby_streets_data = streets_with_distance[:limit]

        return JSONResponse(
            content={
                "status": "success",
                "message": f"Found {len(nearby_streets_data)} nearby undriven streets.",
                "streets": [
                    {
                        "properties": s_data["street_properties"],
                        "geometry": s_data["street_geometry"],
                        "distance_to_start_miles": round(
                            s_data["distance_to_start_miles"], 2
                        ),
                        "start_coords_lonlat": s_data["start_coords_lonlat"],
                    }
                    for s_data in nearby_streets_data
                ],
                "user_location": {"lat": user_lat, "lon": user_lon},
            }
        )

    except Exception as e:
        logger.error(
            "Error finding nearby streets (simple-route): %s", e, exc_info=True
        )
        raise HTTPException(
            status_code=500, detail=f"Failed to find nearby streets: {e}"
        )


@app.post("/api/driving-navigation/optimized-route")
async def get_optimized_multi_street_route(
    request: Request,
):
    """Create an optimized route visiting multiple undriven streets efficiently."""
    try:
        data = await request.json()
        if "location" not in data:
            raise HTTPException(
                status_code=400, detail="Target location data is required"
            )

        location_model = LocationModel(**data["location"])
        location_name = location_model.display_name
        if not location_name:
            raise HTTPException(
                status_code=400, detail="Location display name is required."
            )

        user_loc_data = data.get("user_location")
        if (
            not user_loc_data
            or "lat" not in user_loc_data
            or "lon" not in user_loc_data
        ):
            raise HTTPException(
                status_code=400, detail="User location {lat, lon} is required"
            )

        user_lat, user_lon = (
            float(user_loc_data["lat"]),
            float(user_loc_data["lon"]),
        )
        max_streets_to_optimize = min(int(data.get("max_streets", 5)), 11)
        max_distance_miles = float(data.get("max_distance_miles", 2.0))

    except (ValueError, TypeError, json.JSONDecodeError) as e:
        raise HTTPException(
            status_code=400, detail=f"Invalid request format: {e}"
        )

    try:
        undriven_streets_cursor = streets_collection.find(
            {
                "properties.location": location_name,
                "properties.driven": False,
                "properties.undriveable": {"$ne": True},
                "geometry.coordinates": {
                    "$exists": True,
                    "$not": {"$size": 0},
                },
            },
            {"geometry": 1, "properties": 1, "_id": 0},
        )
        all_undriven_streets = await undriven_streets_cursor.to_list(
            length=None
        )

        if not all_undriven_streets:
            return JSONResponse(
                content={
                    "status": "no_streets",
                    "message": f"No undriven streets in {location_name}.",
                }
            )

        streets_in_radius = []
        for street_doc in all_undriven_streets:
            geom = street_doc.get("geometry", {})
            if geom.get("type") == "LineString" and geom.get("coordinates"):
                coords = geom["coordinates"]
                if coords and len(coords[0]) >= 2:
                    street_start_lon, street_start_lat = (
                        float(coords[0][0]),
                        float(coords[0][1]),
                    )
                    distance = haversine(
                        user_lon,
                        user_lat,
                        street_start_lon,
                        street_start_lat,
                        unit="miles",
                    )
                    if distance <= max_distance_miles:
                        streets_in_radius.append(
                            {
                                "properties": street_doc.get("properties", {}),
                                "geometry": geom,
                                "distance_to_start_miles": distance,
                                "start_coords_lonlat": (
                                    street_start_lon,
                                    street_start_lat,
                                ),
                            }
                        )

        if not streets_in_radius:
            return JSONResponse(
                content={
                    "status": "no_streets_in_radius",
                    "message": f"No undriven streets within {max_distance_miles} miles.",
                }
            )

        streets_in_radius.sort(key=lambda x: x["distance_to_start_miles"])
        selected_streets_for_route = streets_in_radius[
            :max_streets_to_optimize
        ]

        destination_points = [
            s_data["start_coords_lonlat"]
            for s_data in selected_streets_for_route
        ]

        if not destination_points:
            return JSONResponse(
                content={
                    "status": "error",
                    "message": "No destination points from selected streets.",
                }
            )

        optimized_route_data = await _get_mapbox_optimization_route(
            user_lon, user_lat, end_points=destination_points
        )

        ordered_streets_info = []
        if "waypoints" in optimized_route_data:
            for wp in optimized_route_data["waypoints"]:
                if wp.get("waypoint_index") is not None and wp[
                    "waypoint_index"
                ] < len(selected_streets_for_route):
                    original_street_data = selected_streets_for_route[
                        wp["waypoint_index"]
                    ]
                    ordered_streets_info.append(
                        {
                            "properties": original_street_data["properties"],
                            "geometry": original_street_data["geometry"],
                            "distance_to_start_miles": round(
                                original_street_data[
                                    "distance_to_start_miles"
                                ],
                                2,
                            ),
                            "optimized_order_location": wp.get("location"),
                        }
                    )

        return JSONResponse(
            content={
                "status": "success",
                "message": f"Optimized route for {len(ordered_streets_info)} streets.",
                "route_geometry": optimized_route_data.get("geometry"),
                "route_duration_seconds": optimized_route_data.get("duration"),
                "route_distance_meters": optimized_route_data.get("distance"),
                "streets_in_optimized_order": ordered_streets_info,
                "user_location": {"lat": user_lat, "lon": user_lon},
            }
        )

    except HTTPException as http_exc:
        raise http_exc
    except Exception as e:
        logger.error(
            "Error creating optimized multi-street route: %s", e, exc_info=True
        )
        raise HTTPException(
            status_code=500, detail=f"Failed to create optimized route: {e}"
        )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=port,
        log_level="info",
        reload=True,
    )
