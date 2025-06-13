import asyncio
import json
import logging
import os
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

import geojson as geojson_module
import gpxpy
import pytz
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
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from coverage_api import router as coverage_api_router
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
from driving_routes import router as driving_routes_router
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
from trips import router as trips_router
from update_geo_points import update_geo_points
from utils import (
    calculate_circular_average_hour,
    calculate_distance,
    cleanup_session,
    validate_location_osm,
)
from visits import init_collections
from visits import router as visits_router

load_dotenv()


logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Every Street")
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

app.include_router(pages_router)
app.include_router(trips_router)
app.include_router(visits_router)
app.include_router(tasks_api_router)
app.include_router(export_api_router)
app.include_router(coverage_api_router)
app.include_router(driving_routes_router)

CLIENT_ID = os.getenv("CLIENT_ID", "")
CLIENT_SECRET = os.getenv("CLIENT_SECRET", "")
REDIRECT_URI = os.getenv("REDIRECT_URI", "")
AUTH_CODE = os.getenv("AUTHORIZATION_CODE", "")
AUTHORIZED_DEVICES = [d for d in os.getenv("AUTHORIZED_DEVICES", "").split(",") if d]
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
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        """Send message to all connected clients."""
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                disconnected.append(connection)

        # Clean up disconnected clients
        for conn in disconnected:
            if conn in self.active_connections:
                self.active_connections.remove(conn)


manager = ConnectionManager()


class ProcessTripOptions(BaseModel):
    map_match: bool = True
    validate_only: bool = False
    geocode_only: bool = False


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
                detail=(
                    f"Invalid GPS JSON for trip {trip.get('transactionId', 'unknown')}"
                ),
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
                dateutil_parser.isoparse(etime_str) if etime_str else stime_parsed
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
    options: ProcessTripOptions,
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

        if options.validate_only:
            await processor.validate()
            processing_status = processor.get_processing_status()
            return {
                "status": "success",
                "processing_status": processing_status,
                "is_valid": processing_status["state"] == TripState.VALIDATED.value,
            }
        if options.geocode_only:
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
                "geocoded": processing_status["state"] == TripState.GEOCODED.value,
                "saved_id": saved_id,
            }
        await processor.process(do_map_match=options.map_match)
        saved_id = await processor.save(map_match_result=options.map_match)
        processing_status = processor.get_processing_status()

        return {
            "status": "success",
            "processing_status": processing_status,
            "completed": processing_status["state"] == TripState.COMPLETED.value,
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
                            if (
                                trip_dict.get("gps") is not None
                            ):  # Only process if GPS data is valid
                                await process_and_store_trip(
                                    trip_dict,
                                    source="upload_geojson",
                                )
                                success_count += 1
                                valid_trip_count_for_file += 1
                            else:
                                logger.warning(
                                    f"Skipping trip with transactionId {trip_dict.get('transactionId', 'N/A')} "
                                    f"from GeoJSON file {filename} due to invalid or missing GPS data after validation."
                                )
                        if valid_trip_count_for_file == 0 and trips_to_process:
                            logger.warning(
                                f"GeoJSON file {filename} contained trips, but none had valid GPS data after processing."
                            )
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
            filename = file.filename.lower() if file.filename else "unknown_file"
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
                                        if coords[i] != coords[i - 1]:
                                            unique_gpx_coords.append(coords[i])

                                if len(unique_gpx_coords) == 1:
                                    standardized_gpx_gps = {
                                        "type": "Point",
                                        "coordinates": unique_gpx_coords[0],
                                    }
                                elif len(unique_gpx_coords) >= 2:
                                    standardized_gpx_gps = {
                                        "type": "LineString",
                                        "coordinates": unique_gpx_coords,
                                    }
                                else:  # No valid unique points
                                    logger.warning(
                                        f"GPX segment for {filename} produced no valid unique coordinates."
                                    )

                            if standardized_gpx_gps:
                                trip_dict["gps"] = standardized_gpx_gps
                                # Calculate distance based on the final unique coordinates
                                trip_dict["distance"] = calculate_distance(
                                    standardized_gpx_gps.get("coordinates", [])
                                )

                                await process_and_store_trip(
                                    trip_dict,
                                    source="upload_gpx",
                                )
                                count += 1
                            else:
                                logger.warning(
                                    f"Skipping GPX track/segment in {filename} due to no valid GPS data after standardization."
                                )

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
                    if trips:  # trips is a list of trip_dicts from process_geojson_trip
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
                            logger.warning(
                                f"GeoJSON file {filename} in /api/upload contained trips, but none had valid GPS after processing."
                            )
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
        # Build query with new timezone-aware helper
        query = await build_query_from_request(request)

        # Ensure caller provided at least a date range; with the new helper the
        # range lives under $expr instead of startTime, so we just verify that
        # either query contains a $expr date filter or the request actually
        # included start_date / end_date parameters.
        if "$expr" not in query and (
            request.query_params.get("start_date") is None
            or request.query_params.get("end_date") is None
        ):
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
            return [{"hour": h, "count": c} for h, c in sorted(hourly_data.items())]

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


@app.get("/api/driver-behavior")
async def driver_behavior_analytics(request: Request):
    """Aggregate driving behavior statistics within optional date range filters.

    Accepts the same `start_date` and `end_date` query parameters used by other API endpoints.
    If no filters are provided, all trips are considered (back-compat)."""

    # Build the Mongo query using the shared helper so filters stay consistent app-wide
    try:
        query = await build_query_from_request(request)
    except Exception as e:
        logger.exception("Failed to build query for driver behavior analytics: %s", e)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    trips = await trips_collection.find(query).to_list(length=None)
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
    avg_speed = speeds_sum / num_trips_with_speed if num_trips_with_speed > 0 else 0.0

    max_speeds = [get_field(t, "maxSpeed", default=0.0) for t in trips]
    max_speed = max(max_speeds) if max_speeds else 0.0

    hard_braking = sum(
        get_field(t, "hardBrakingCounts", "hardBrakingCount", default=0) for t in trips
    )
    hard_accel = sum(
        get_field(t, "hardAccelerationCounts", "hardAccelerationCount", default=0)
        for t in trips
    )
    idling = sum(
        get_field(t, "totalIdleDuration", default=0.0) for t in trips
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

    combined = {
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

    # Ensure all datetime objects are JSON serializable (convert to ISO strings)
    return JSONResponse(content=convert_datetimes_to_isoformat(combined))


def convert_datetimes_to_isoformat(item: Any) -> Any:
    """Recursively convert datetime objects in a dictionary or list to ISO format strings."""
    if isinstance(item, dict):
        return {k: convert_datetimes_to_isoformat(v) for k, v in item.items()}
    if isinstance(item, list):
        return [convert_datetimes_to_isoformat(elem) for elem in item]
    if isinstance(item, datetime):
        return item.isoformat()
    return item


@app.websocket("/ws/trips")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    last_sequence = 0

    try:
        while True:
            # Check for updates ~4× per second for near-real-time push
            active_trip = await get_active_trip(since_sequence=last_sequence)

            if active_trip:
                # Serialize the trip data properly
                serialized_trip = SerializationHelper.serialize_document(active_trip)
                last_sequence = active_trip.get("sequence", last_sequence)

                await websocket.send_json(
                    {"type": "trip_update", "trip": serialized_trip}
                )

            await asyncio.sleep(0.25)

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket)


@app.get("/api/driving-insights")
async def get_driving_insights(request: Request):
    """Get aggregated driving insights."""
    try:
        query = await build_query_from_request(request)

        pipeline = [
            {"$match": query},
            {
                "$group": {
                    "_id": None,
                    "total_trips": {"$sum": 1},
                    "total_distance": {
                        "$sum": {
                            "$ifNull": [
                                "$distance",
                                0,
                            ],
                        },
                    },
                    "total_fuel_consumed": {
                        "$sum": {
                            "$ifNull": [
                                "$fuelConsumed",
                                0,
                            ],
                        },
                    },
                    "max_speed": {
                        "$max": {
                            "$ifNull": [
                                "$maxSpeed",
                                0,
                            ],
                        },
                    },
                    "total_idle_duration": {
                        "$sum": {
                            "$ifNull": [
                                "$totalIdleDuration",
                                0,
                            ],
                        },
                    },
                    "longest_trip_distance": {
                        "$max": {
                            "$ifNull": [
                                "$distance",
                                0,
                            ],
                        },
                    },
                },
            },
        ]

        trips_result = await aggregate_with_retry(trips_collection, pipeline)

        # Top destinations (up to 5) with basic stats
        pipeline_top_destinations = [
            {"$match": query},
            {
                "$addFields": {
                    "duration_seconds": {
                        "$cond": {
                            "if": {
                                "$and": [
                                    {"$ifNull": ["$startTime", None]},
                                    {"$ifNull": ["$endTime", None]},
                                    {"$lt": ["$startTime", "$endTime"]},
                                ]
                            },
                            "then": {
                                "$divide": [
                                    {"$subtract": ["$endTime", "$startTime"]},
                                    1000,
                                ]
                            },
                            "else": 0.0,
                        }
                    }
                }
            },
            {
                "$group": {
                    "_id": "$destination",
                    "visits": {"$sum": 1},
                    "distance": {"$sum": {"$ifNull": ["$distance", 0]}},
                    "total_duration": {"$sum": "$duration_seconds"},
                    "last_visit": {"$max": "$endTime"},
                    "isCustomPlace": {"$first": "$isCustomPlace"},
                }
            },
            {"$sort": {"visits": -1}},
            {"$limit": 5},
        ]

        trips_top = await aggregate_with_retry(trips_collection, pipeline_top_destinations)

        combined = {
            "total_trips": 0,
            "total_distance": 0.0,
            "total_fuel_consumed": 0.0,
            "max_speed": 0.0,
            "total_idle_duration": 0,
            "longest_trip_distance": 0.0,
            "most_visited": {},
            "top_destinations": [],
        }

        if trips_result and trips_result[0]:
            r = trips_result[0]
            combined["total_trips"] = r.get("total_trips", 0)
            combined["total_distance"] = r.get("total_distance", 0)
            combined["total_fuel_consumed"] = r.get("total_fuel_consumed", 0)
            combined["max_speed"] = r.get("max_speed", 0)
            combined["total_idle_duration"] = r.get("total_idle_duration", 0)
            combined["longest_trip_distance"] = r.get(
                "longest_trip_distance",
                0,
            )

        if trips_top:
            # The first entry is also the "most visited" location
            best = trips_top[0]
            combined["most_visited"] = {
                "_id": best["_id"],
                "count": best["visits"],
                "isCustomPlace": best.get("isCustomPlace", False),
            }

            # Add formatted top destinations list
            combined["top_destinations"] = [
                {
                    "location": (
                        d["_id"].get("formatted_address")
                        if isinstance(d["_id"], dict)
                        else (d["_id"].get("name") if isinstance(d["_id"], dict) else str(d["_id"]))
                    ),
                    "visits": d.get("visits", 0),
                    "distance": round(d.get("distance", 0.0), 2),
                    "duration_seconds": round(d.get("total_duration", 0.0), 0),
                    "lastVisit": d.get("last_visit"),
                    "isCustomPlace": d.get("isCustomPlace", False),
                }
                for d in trips_top
            ]

        return JSONResponse(content=convert_datetimes_to_isoformat(combined))
    except Exception as e:
        logger.exception(
            "Error in get_driving_insights: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/metrics")
async def get_metrics(request: Request):
    """Get trip metrics and statistics using database aggregation."""
    try:
        query = await build_query_from_request(request)
        target_timezone_str = "America/Chicago"
        target_tz = pytz.timezone(target_timezone_str)

        pipeline = [
            {"$match": query},
            {
                "$addFields": {
                    "numericDistance": {
                        "$ifNull": [
                            {"$toDouble": "$distance"},
                            0.0,
                        ],
                    },
                    "numericMaxSpeed": {
                        "$ifNull": [
                            {"$toDouble": "$maxSpeed"},
                            0.0,
                        ],
                    },
                    "duration_seconds": {
                        "$cond": {
                            "if": {
                                "$and": [
                                    {
                                        "$ifNull": [
                                            "$startTime",
                                            None,
                                        ],
                                    },
                                    {
                                        "$ifNull": [
                                            "$endTime",
                                            None,
                                        ],
                                    },
                                    {
                                        "$lt": [
                                            "$startTime",
                                            "$endTime",
                                        ],
                                    },
                                ],
                            },
                            "then": {
                                "$divide": [
                                    {
                                        "$subtract": [
                                            "$endTime",
                                            "$startTime",
                                        ],
                                    },
                                    1000,
                                ],
                            },
                            "else": 0.0,
                        },
                    },
                    "startHourUTC": {
                        "$hour": {
                            "date": "$startTime",
                            "timezone": "UTC",
                        },
                    },
                },
            },
            {
                "$group": {
                    "_id": None,
                    "total_trips": {"$sum": 1},
                    "total_distance": {"$sum": "$numericDistance"},
                    "max_speed": {"$max": "$numericMaxSpeed"},
                    "total_duration_seconds": {"$sum": "$duration_seconds"},
                    "start_hours_utc": {"$push": "$startHourUTC"},
                },
            },
            {
                "$project": {
                    "_id": 0,
                    "total_trips": 1,
                    "total_distance": {
                        "$ifNull": [
                            "$total_distance",
                            0.0,
                        ],
                    },
                    "max_speed": {
                        "$ifNull": [
                            "$max_speed",
                            0.0,
                        ],
                    },
                    "total_duration_seconds": {
                        "$ifNull": [
                            "$total_duration_seconds",
                            0.0,
                        ],
                    },
                    "start_hours_utc": {
                        "$ifNull": [
                            "$start_hours_utc",
                            [],
                        ],
                    },
                    "avg_distance": {
                        "$cond": {
                            "if": {
                                "$gt": [
                                    "$total_trips",
                                    0,
                                ],
                            },
                            "then": {
                                "$divide": [
                                    "$total_distance",
                                    "$total_trips",
                                ],
                            },
                            "else": 0.0,
                        },
                    },
                    "avg_speed": {
                        "$cond": {
                            "if": {
                                "$gt": [
                                    "$total_duration_seconds",
                                    0,
                                ],
                            },
                            "then": {
                                "$divide": [
                                    "$total_distance",
                                    {
                                        "$divide": [
                                            "$total_duration_seconds",
                                            3600.0,
                                        ],
                                    },
                                ],
                            },
                            "else": 0.0,
                        },
                    },
                },
            },
        ]

        results = await aggregate_with_retry(trips_collection, pipeline)

        if not results:
            empty_data = {
                "total_trips": 0,
                "total_distance": "0.00",
                "avg_distance": "0.00",
                "avg_start_time": "00:00 AM",
                "avg_driving_time": "00:00",
                "avg_speed": "0.00",
                "max_speed": "0.00",
            }
            return JSONResponse(content=empty_data)

        metrics = results[0]
        total_trips = metrics.get("total_trips", 0)

        start_hours_utc_list = metrics.get("start_hours_utc", [])
        avg_start_time_str = "00:00 AM"
        if start_hours_utc_list:
            avg_hour_utc_float = calculate_circular_average_hour(
                start_hours_utc_list,
            )

            base_date = datetime.now(timezone.utc).replace(
                hour=0,
                minute=0,
                second=0,
                microsecond=0,
            )
            avg_utc_dt = base_date + timedelta(hours=avg_hour_utc_float)

            avg_local_dt = avg_utc_dt.astimezone(target_tz)

            local_hour = avg_local_dt.hour
            local_minute = avg_local_dt.minute

            am_pm = "AM" if local_hour < 12 else "PM"
            display_hour = local_hour % 12
            if display_hour == 0:
                display_hour = 12

            avg_start_time_str = f"{display_hour:02d}:{local_minute:02d} {am_pm}"

        avg_driving_time_str = "00:00"
        if total_trips > 0:
            total_duration_seconds = metrics.get("total_duration_seconds", 0.0)
            avg_duration_seconds = total_duration_seconds / total_trips
            avg_driving_h = int(avg_duration_seconds // 3600)
            avg_driving_m = int((avg_duration_seconds % 3600) // 60)
            avg_driving_time_str = f"{avg_driving_h:02d}:{avg_driving_m:02d}"

        response_content = {
            "total_trips": total_trips,
            "total_distance": f"{round(metrics.get('total_distance', 0.0), 2)}",
            "avg_distance": f"{round(metrics.get('avg_distance', 0.0), 2)}",
            "avg_start_time": avg_start_time_str,
            "avg_driving_time": avg_driving_time_str,
            "avg_speed": f"{round(metrics.get('avg_speed', 0.0), 2)}",
            "max_speed": f"{round(metrics.get('max_speed', 0.0), 2)}",
            "total_duration_seconds": round(metrics.get("total_duration_seconds", 0.0), 0),
        }

        return JSONResponse(content=response_content)

    except Exception as e:
        logger.exception("Error in get_metrics: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
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
