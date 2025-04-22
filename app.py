"""Main FastAPI application module.

This module contains the main FastAPI application and route definitions for the
street coverage tracking application.
"""

import asyncio
import io
import json
import logging
import os
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from math import ceil
from typing import Any

import bson
import geojson as geojson_module
import gpxpy
import httpx
import numpy as np
import pytz
from bson import ObjectId
from dateutil import parser as dateutil_parser
from dotenv import load_dotenv
from fastapi import (
    Body,
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from gridfs.errors import NoFile
from motor.motor_asyncio import (
    AsyncIOMotorGridFSBucket,
)
from pymongo import GEOSPHERE, IndexModel
from pymongo.errors import OperationFailure
from sklearn.cluster import KMeans

from bouncie_trip_fetcher import (
    fetch_bouncie_trips_in_range,
)
from coverage_tasks import (
    collect_street_type_stats,
    process_area,
    process_coverage_calculation,
    process_incremental_coverage_calculation,
)
from db import (
    SerializationHelper,
    aggregate_with_retry,
    batch_cursor,
    build_query_from_request,
    count_documents_with_retry,
    db_manager,
    delete_many_with_retry,
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    get_trip_by_id,
    init_database,
    parse_query_date,
    update_many_with_retry,
    update_one_with_retry,
)
from export_helpers import (
    create_csv_export,
    create_export_response,
    default_serializer,
    export_geojson_response,
    export_gpx_response,
    extract_date_range_string,
    get_location_filename,
    process_trip_for_export,
)
from live_tracking import (
    get_active_trip,
    get_trip_updates,
)
from live_tracking import (
    initialize_db as initialize_live_tracking_db,
)
from models import (
    ActiveTripResponseUnion,
    ActiveTripSuccessResponse,
    BackgroundTasksConfigModel,
    BulkProcessModel,
    CollectionModel,
    DateRangeModel,
    DeleteCoverageAreaModel,
    LocationModel,
    NoActiveTripResponse,
    TripUpdateModel,
    ValidateLocationModel,
)
from osm_utils import generate_geojson_osm
from tasks import (
    TASK_METADATA,
    TaskPriority,
    TaskStatus,
    get_all_task_metadata,
    get_task_config,
    manual_run_task,
    process_webhook_event_task,
    update_task_schedule,
)
from trip_processor import (
    TripProcessor,
    TripState,
)
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
coverage_metadata_collection = db_manager.db["coverage_metadata"]
live_trips_collection = db_manager.db["live_trips"]
archived_live_trips_collection = db_manager.db["archived_live_trips"]
task_config_collection = db_manager.db["task_config"]
task_history_collection = db_manager.db["task_history"]
progress_collection = db_manager.db["progress_status"]
osm_data_collection = db_manager.db["osm_data"]


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
                    "gps": json.dumps(trip_geo),
                    "distance": dist_miles,
                    "imei": "UPLOADED",
                    "source": "upload_geojson",
                }
            )
        return trips
    except Exception:
        logger.exception("Error in process_geojson_trip")
        return None


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Render main index page."""
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/trips", response_class=HTMLResponse)
async def trips_page(request: Request):
    """Render trips page."""
    return templates.TemplateResponse("trips.html", {"request": request})


@app.get("/edit_trips", response_class=HTMLResponse)
async def edit_trips_page(request: Request):
    """Render trip editing page."""
    return templates.TemplateResponse("edit_trips.html", {"request": request})


@app.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request):
    """Render settings page."""
    return templates.TemplateResponse("settings.html", {"request": request})


@app.get(
    "/driving-insights",
    response_class=HTMLResponse,
)
async def driving_insights_page(request: Request):
    """Render driving insights page."""
    return templates.TemplateResponse(
        "driving_insights.html",
        {"request": request},
    )


@app.get("/visits", response_class=HTMLResponse)
async def visits_page(request: Request):
    """Render visits page."""
    return templates.TemplateResponse("visits.html", {"request": request})


@app.get("/export", response_class=HTMLResponse)
async def export_page(request: Request):
    """Render export page."""
    return templates.TemplateResponse("export.html", {"request": request})


@app.get("/upload", response_class=HTMLResponse)
async def upload_page(request: Request):
    """Render upload page."""
    return templates.TemplateResponse("upload.html", {"request": request})


@app.get(
    "/coverage-management",
    response_class=HTMLResponse,
)
async def coverage_management_page(
    request: Request,
):
    """Render coverage management page."""
    return templates.TemplateResponse(
        "coverage_management.html",
        {"request": request},
    )


@app.get("/database-management")
async def database_management_page(
    request: Request,
):
    """Render database management page with statistics."""
    try:
        db_stats = await db_manager.db.command("dbStats")
        storage_used_mb = round(
            db_stats["dataSize"] / (1024 * 1024),
            2,
        )
        storage_limit_mb = 512
        storage_usage_percent = round(
            (storage_used_mb / storage_limit_mb) * 100,
            2,
        )
        collections_info = []
        collection_names = [
            name
            for name in await db_manager.db.list_collection_names()
            if name != "uploaded_trips"
        ]
        for collection_name in collection_names:
            stats = await db_manager.db.command("collStats", collection_name)
            collections_info.append(
                {
                    "name": collection_name,
                    "document_count": stats["count"],
                    "size_mb": round(
                        stats["size"] / (1024 * 1024),
                        2,
                    ),
                }
            )
        return templates.TemplateResponse(
            "database_management.html",
            {
                "request": request,
                "storage_used_mb": storage_used_mb,
                "storage_limit_mb": storage_limit_mb,
                "storage_usage_percent": storage_usage_percent,
                "collections": collections_info,
            },
        )
    except Exception as e:
        logger.exception(
            "Error loading database management page: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/app-settings", response_class=HTMLResponse)
async def app_settings_page(request: Request):
    """Render app settings page."""
    return templates.TemplateResponse(
        "app_settings.html", {"request": request}
    )


@app.get(
    "/driving-navigation",
    response_class=HTMLResponse,
)
async def driving_navigation_page(
    request: Request,
):
    """Render the driving navigation page."""
    return templates.TemplateResponse(
        "driving_navigation.html",
        {
            "request": request,
            "MAPBOX_ACCESS_TOKEN": MAPBOX_ACCESS_TOKEN,
        },
    )


@app.post("/api/undriven_streets")
async def get_undriven_streets(
    location: LocationModel,
):
    """Get undriven streets for a specific location.

    Args:
        location: Location dictionary with display_name, osm_id, etc.

    Returns:
        GeoJSON with undriven streets features
    """
    location_name = "UNKNOWN"
    try:
        location_name = location.display_name
        logger.info(
            "Request received for undriven streets for '%s'.",
            location_name,
        )

        coverage_metadata = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
        )

        if not coverage_metadata:
            logger.warning(
                "No coverage metadata found for location: '%s'. Raising 404.",
                location_name,
            )
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No coverage data found for location: {location_name}",
            )

        query = {
            "properties.location": location_name,
            "properties.driven": False,
        }

        count = await count_documents_with_retry(streets_collection, query)
        logger.info(
            "Found %d undriven street documents for '%s'.",
            count,
            location_name,
        )

        if count == 0:
            return JSONResponse(
                content={
                    "type": "FeatureCollection",
                    "features": [],
                }
            )

        features = []
        cursor = streets_collection.find(query)

        async for street_batch in batch_cursor(cursor):
            for street_doc in street_batch:
                if "geometry" in street_doc and "properties" in street_doc:
                    features.append(street_doc)

        content_to_return = {
            "type": "FeatureCollection",
            "features": features,
        }
        return JSONResponse(
            content=json.loads(bson.json_util.dumps(content_to_return))
        )

    except HTTPException as http_exc:
        logger.warning(
            "HTTPException occurred for '%s': Status=%s, Detail=%s",
            location_name,
            http_exc.status_code,
            http_exc.detail,
        )
        raise
    except Exception as e:
        logger.error(
            "Unexpected error getting undriven streets for '%s': %s",
            location_name,
            str(e),
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error retrieving undriven streets.",
        )


@app.post("/api/background_tasks/config")
async def update_background_tasks_config(
    data: BackgroundTasksConfigModel,
):
    """Update the configuration of background tasks."""
    try:
        result = await update_task_schedule(data.dict(exclude_unset=True))

        if result.get("status") != "success":
            logger.error(
                "Failed to update task schedule: %r",
                result,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get("message", "Unknown error"),
            )
        return {
            "status": "success",
            "message": "Configuration updated",
        }

    except HTTPException as exc:
        logger.warning(
            "HTTPException in update_background_tasks_config: %s",
            exc,
            exc_info=True,
        )
        raise
    except Exception as e:
        logger.exception(
            "Error updating task configuration: %s",
            e,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/background_tasks/config")
async def get_background_tasks_config():
    """Get the current configuration of background tasks."""
    try:
        config = await get_task_config()
        task_metadata = await get_all_task_metadata()

        for (
            task_id,
            task_def,
        ) in task_metadata.items():
            if task_id not in config.get("tasks", {}):
                config.setdefault("tasks", {})[task_id] = {}

            task_config = config["tasks"][task_id]

            task_config["display_name"] = task_def.get(
                "display_name", "Unknown Task"
            )
            task_config["description"] = task_def.get("description", "")
            task_config["priority"] = task_def.get(
                "priority",
                TaskPriority.MEDIUM.name,
            )

            task_config["status"] = task_config.get("status", "IDLE")
            task_config["interval_minutes"] = task_config.get(
                "interval_minutes",
                task_def.get("default_interval_minutes"),
            )

            last_run = task_config.get("last_run")
            interval = task_config.get("interval_minutes")
            enabled = task_config.get("enabled", True)
            next_run = None
            if enabled and interval and interval > 0 and last_run:
                try:
                    if isinstance(last_run, str):
                        last_run_dt = datetime.fromisoformat(
                            last_run.replace("Z", "+00:00")
                        )
                    else:
                        last_run_dt = last_run
                    if last_run_dt.tzinfo is None:
                        last_run_dt = last_run_dt.replace(tzinfo=timezone)
                    next_run_dt = last_run_dt + timedelta(minutes=interval)
                    next_run = next_run_dt.isoformat()
                except Exception:
                    next_run = None
            task_config["next_run"] = next_run

            for ts_field in [
                "last_run",
                "next_run",
                "start_time",
                "end_time",
                "last_updated",
            ]:
                if ts_field in task_config and task_config[ts_field]:
                    task_config[ts_field] = (
                        task_config[ts_field]
                        if isinstance(
                            task_config[ts_field],
                            str,
                        )
                        else task_config[ts_field].isoformat()
                    )

        return config
    except Exception as e:
        logger.exception(
            "Error getting task configuration: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/background_tasks/pause")
async def pause_background_tasks(
    minutes: int = 30,
):
    """Pause all background tasks for a specified duration."""
    try:
        result = await update_task_schedule(
            {
                "globalDisable": True,
                "pauseMinutes": minutes,
            }
        )
        if result.get("status") != "success":
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get(
                    "message",
                    "Failed to pause tasks",
                ),
            )
        return {
            "status": "success",
            "message": f"Background tasks paused for {minutes} minutes",
        }
    except HTTPException as exc:
        logger.warning(
            "HTTPException in pause_background_tasks: %s", exc, exc_info=True
        )
        raise
    except Exception as e:
        logger.exception("Error pausing tasks: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/background_tasks/resume")
async def resume_background_tasks():
    """Resume all paused background tasks."""
    try:
        await update_task_schedule({"globalDisable": False})
        return {
            "status": "success",
            "message": "Background tasks resumed",
        }
    except Exception as e:
        logger.exception("Error resuming tasks: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/background_tasks/stop")
async def stop_all_background_tasks():
    """Stop all currently running background tasks."""
    try:
        result = await update_task_schedule({"globalDisable": True})
        if result.get("status") != "success":
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get(
                    "message",
                    "Failed to stop tasks",
                ),
            )
        return {
            "status": "success",
            "message": "All background tasks stopped",
        }
    except HTTPException as exc:
        logger.warning(
            "HTTPException in stop_all_background_tasks: %s",
            exc,
            exc_info=True,
        )
        raise
    except Exception as e:
        logger.exception("Error stopping all tasks: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/background_tasks/enable")
async def enable_all_background_tasks():
    """Enable all background tasks."""
    try:
        tasks_update = {tid: {"enabled": True} for tid in TASK_METADATA}
        result = await update_task_schedule({"tasks": tasks_update})
        if result.get("status") != "success":
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get(
                    "message",
                    "Failed to enable tasks",
                ),
            )
        return {
            "status": "success",
            "message": "All background tasks enabled",
        }
    except HTTPException as exc:
        logger.warning(
            "HTTPException in enable_all_background_tasks: %s",
            exc,
            exc_info=True,
        )
        raise
    except Exception as e:
        logger.exception("Error enabling all tasks: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/background_tasks/disable")
async def disable_all_background_tasks():
    """Disable all background tasks."""
    try:
        tasks_update = {tid: {"enabled": False} for tid in TASK_METADATA}
        result = await update_task_schedule({"tasks": tasks_update})
        if result.get("status") != "success":
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get(
                    "message",
                    "Failed to disable tasks",
                ),
            )
        return {
            "status": "success",
            "message": "All background tasks disabled",
        }
    except HTTPException as exc:
        logger.warning(
            "HTTPException in disable_all_background_tasks: %s",
            exc,
            exc_info=True,
        )
        raise
    except Exception as e:
        logger.exception("Error disabling all tasks: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/background_tasks/run")
async def manual_run_tasks(
    tasks_to_run: list[str] = Body(...),
):
    """Manually trigger one or more background tasks."""
    if not tasks_to_run:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No tasks specified to run",
        )
    results = []
    for task_id in tasks_to_run:
        if task_id == "ALL":
            res = await manual_run_task("ALL")
        elif task_id in TASK_METADATA:
            res = await manual_run_task(task_id)
        else:
            res = {
                "status": "error",
                "message": "Unknown task",
            }
        success = res.get("status") == "success"
        results.append(
            {
                "task": task_id,
                "success": success,
                "message": res.get("message"),
                "task_id": res.get("task_id"),
            }
        )
    return {
        "status": "success",
        "results": results,
    }


@app.get("/api/background_tasks/task/{task_id}")
async def get_task_details(task_id: str):
    """Get detailed information about a specific task."""
    try:
        if task_id not in TASK_METADATA:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Task {task_id} not found",
            )

        task_def = TASK_METADATA[task_id]
        config = await get_task_config()
        task_config = config.get("tasks", {}).get(task_id, {})

        history_docs = await find_with_retry(
            task_history_collection,
            {"task_id": task_id},
            sort=[("timestamp", -1)],
            limit=5,
        )

        history = []
        for entry in history_docs:
            entry["_id"] = str(entry["_id"])
            history.append(
                {
                    "timestamp": SerializationHelper.serialize_datetime(
                        entry.get("timestamp")
                    ),
                    "status": entry["status"],
                    "runtime": entry.get("runtime"),
                    "error": entry.get("error"),
                }
            )

        return {
            "id": task_id,
            "display_name": task_def["display_name"],
            "description": task_def["description"],
            "priority": (
                task_def["priority"].name
                if hasattr(task_def["priority"], "name")
                else str(task_def["priority"])
            ),
            "dependencies": task_def["dependencies"],
            "status": task_config.get("status", "IDLE"),
            "enabled": task_config.get("enabled", True),
            "interval_minutes": task_config.get(
                "interval_minutes",
                task_def["default_interval_minutes"],
            ),
            "last_run": SerializationHelper.serialize_datetime(
                task_config.get("last_run")
            ),
            "next_run": SerializationHelper.serialize_datetime(
                task_config.get("next_run")
            ),
            "start_time": SerializationHelper.serialize_datetime(
                task_config.get("start_time")
            ),
            "end_time": SerializationHelper.serialize_datetime(
                task_config.get("end_time")
            ),
            "last_error": task_config.get("last_error"),
            "history": history,
        }

    except Exception as e:
        logger.exception(
            "Error getting task details for %s: %s",
            task_id,
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/background_tasks/history")
async def get_task_history(page: int = 1, limit: int = 10):
    """Get paginated task execution history."""
    try:
        total_count = await count_documents_with_retry(
            task_history_collection, {}
        )
        skip = (page - 1) * limit
        entries = await find_with_retry(
            task_history_collection,
            {},
            sort=[("timestamp", -1)],
            skip=skip,
            limit=limit,
        )

        history = []
        for entry in entries:
            entry["_id"] = str(entry["_id"])
            entry["timestamp"] = SerializationHelper.serialize_datetime(
                entry.get("timestamp")
            )
            if "runtime" in entry:
                entry["runtime"] = (
                    float(entry["runtime"]) if entry["runtime"] else None
                )
            history.append(entry)

        return {
            "history": history,
            "total": total_count,
            "page": page,
            "limit": limit,
            "total_pages": ceil(total_count / limit),
        }
    except Exception as e:
        logger.exception(
            "Error fetching task history: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/background_tasks/history/clear")
async def clear_task_history():
    """Clear all task execution history."""
    try:
        result = await delete_many_with_retry(task_history_collection, {})
        return {
            "status": "success",
            "message": f"Cleared {result.deleted_count} task history entries",
        }
    except Exception as e:
        logger.exception(
            "Error clearing task history: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/background_tasks/reset")
async def reset_task_states():
    """Reset any stuck 'RUNNING' tasks to 'FAILED' state with safeguards."""
    try:
        now = datetime.now(timezone.utc)
        stuck_threshold = timedelta(hours=2)
        reset_count = 0
        skipped_count = 0

        config = await get_task_config()
        tasks_config = config.get("tasks", {})
        updates = {}

        for (
            task_id,
            task_info,
        ) in tasks_config.items():
            if task_info.get("status") != TaskStatus.RUNNING.value:
                continue

            start_time_any = task_info.get("start_time")
            start_time = None

            if isinstance(start_time_any, datetime):
                start_time = start_time_any
            elif isinstance(start_time_any, str):
                try:
                    start_time = datetime.fromisoformat(
                        start_time_any.replace("Z", "+00:00")
                    )
                except ValueError:
                    for fmt in (
                        "%Y-%m-%dT%H:%M:%S.%f%z",
                        "%Y-%m-%dT%H:%M:%S%z",
                        "%Y-%m-%dT%H:%M:%S.%f",
                        "%Y-%m-%dT%H:%M:%S",
                    ):
                        try:
                            start_time = datetime.strptime(
                                start_time_any,
                                fmt,
                            )
                            break
                        except ValueError:
                            continue
                    if not start_time:
                        logger.warning(
                            "Could not parse start_time string '%s' for task %s",
                            start_time_any,
                            task_id,
                        )

            if not start_time:
                updates[f"tasks.{task_id}.status"] = TaskStatus.FAILED.value
                updates[f"tasks.{task_id}.last_error"] = (
                    "Task reset: status RUNNING, invalid/missing start_time"
                )
                updates[f"tasks.{task_id}.end_time"] = now
                reset_count += 1
                logger.warning(
                    "Resetting task %s due to missing/invalid start_time.",
                    task_id,
                )
            else:
                if start_time.tzinfo is None:
                    start_time = start_time.astimezone(timezone.utc)

                runtime = now - start_time
                if runtime > stuck_threshold:
                    updates[f"tasks.{task_id}.status"] = (
                        TaskStatus.FAILED.value
                    )
                    updates[f"tasks.{task_id}.last_error"] = (
                        f"Task reset: ran for > {stuck_threshold}"
                    )
                    updates[f"tasks.{task_id}.end_time"] = now
                    reset_count += 1
                    logger.warning(
                        "Resetting task %s running since %s.",
                        task_id,
                        start_time,
                    )
                else:
                    skipped_count += 1
                    logger.info(
                        "Task %s running for %s, not stuck yet.",
                        task_id,
                        runtime,
                    )

        history_result = await update_many_with_retry(
            task_history_collection,
            {
                "status": TaskStatus.RUNNING.value,
                "start_time": {"$lt": now - stuck_threshold},
            },
            {
                "$set": {
                    "status": TaskStatus.FAILED.value,
                    "error": "Task reset: history entry stuck in RUNNING state",
                    "end_time": now,
                }
            },
        )
        history_reset_count = (
            history_result.modified_count if history_result else 0
        )

        if updates:
            config_update_result = await update_one_with_retry(
                task_config_collection,
                {"_id": "global_background_task_config"},
                {"$set": updates},
            )
            if (
                not config_update_result
                or config_update_result.modified_count == 0
            ):
                logger.warning(
                    "Attempted to reset task states in config, but no document was modified."
                )

        return {
            "status": "success",
            "message": f"Reset {reset_count} stuck tasks, skipped {skipped_count}. Reset {history_reset_count} history entries.",
            "reset_count": reset_count,
            "skipped_count": skipped_count,
            "history_reset_count": history_reset_count,
        }
    except Exception as e:
        logger.exception(
            "Error resetting task states: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/background_tasks/sse")
async def background_tasks_sse(request: Request):
    """Provides server-sent events for real-time task status updates."""

    async def event_generator():
        try:
            while True:
                if await request.is_disconnected():
                    logger.info("SSE client disconnected")
                    break

                config = await get_task_config()

                updates = {}
                for (
                    task_id,
                    task_config,
                ) in config.get("tasks", {}).items():
                    status = task_config.get("status", "IDLE")
                    updates[task_id] = {
                        "status": status,
                        "last_updated": SerializationHelper.serialize_datetime(
                            task_config.get("last_updated")
                        ),
                        "last_run": SerializationHelper.serialize_datetime(
                            task_config.get("last_run")
                        ),
                        "next_run": SerializationHelper.serialize_datetime(
                            task_config.get("next_run")
                        ),
                        "last_error": task_config.get("last_error"),
                    }

                yield f"data: {json.dumps(updates)}\n\n"

                await asyncio.sleep(2)
        except asyncio.CancelledError:
            logger.info("SSE connection closed")
        except Exception as e:
            logger.error("Error in SSE generator: %s", e)
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@app.get("/api/edit_trips")
async def get_edit_trips(
    request: Request,
    trip_type: str = Query(..., description="Type of trips to edit"),
):
    """Get trips for editing."""
    try:
        if trip_type not in [
            "trips",
            "matched_trips",
        ]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid trip type",
            )

        query = await build_query_from_request(request)
        collection = (
            trips_collection
            if trip_type == "trips"
            else matched_trips_collection
        )

        trips = await find_with_retry(collection, query)
        serialized_trips = [
            SerializationHelper.serialize_trip(trip) for trip in trips
        ]

        return {
            "status": "success",
            "trips": serialized_trips,
        }

    except Exception as e:
        logger.exception(
            "Error fetching trips for editing: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error",
        )


@app.put("/api/trips/{trip_id}")
async def update_trip(trip_id: str, data: TripUpdateModel):
    """Update a trip's properties and/or geometry."""
    try:
        trip_type = data.type
        geometry = data.geometry
        props = data.properties

        collection = (
            matched_trips_collection
            if trip_type == "matched_trips"
            else trips_collection
        )

        trip = await find_one_with_retry(
            collection,
            {
                "$or": [
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ]
            },
        )

        if not trip and collection == trips_collection:
            other_collection = matched_trips_collection
            trip = await find_one_with_retry(
                other_collection,
                {
                    "$or": [
                        {"transactionId": trip_id},
                        {"transactionId": str(trip_id)},
                    ]
                },
            )
            if trip:
                collection = other_collection

        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No trip found for {trip_id}",
            )

        update_fields = {"updatedAt": datetime.now(timezone.utc)}

        if geometry and isinstance(geometry, dict):
            gps_data = {
                "type": "LineString",
                "coordinates": geometry["coordinates"],
            }
            update_fields["geometry"] = geometry
            update_fields["gps"] = json.dumps(gps_data)

        if props:
            for field in ["startTime", "endTime"]:
                if field in props and isinstance(props[field], str):
                    try:
                        props[field] = dateutil_parser.isoparse(props[field])
                    except ValueError:
                        pass

            for field in [
                "distance",
                "maxSpeed",
                "totalIdleDuration",
                "fuelConsumed",
            ]:
                if field in props and props[field] is not None:
                    try:
                        props[field] = float(props[field])
                    except ValueError:
                        pass

            if "properties" in trip:
                updated_props = {
                    **trip["properties"],
                    **props,
                }
                update_fields["properties"] = updated_props
            else:
                update_fields.update(props)

        result = await update_one_with_retry(
            collection,
            {"_id": trip["_id"]},
            {"$set": update_fields},
        )

        if not result.modified_count:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No changes made",
            )

        return {"message": "Trip updated"}

    except Exception as e:
        logger.exception(
            "Error updating trip %s: %s",
            trip_id,
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/street_coverage")
async def get_street_coverage(
    location: LocationModel,
):
    """Calculate street coverage for a location."""
    try:
        task_id = str(uuid.uuid4())
        asyncio.create_task(
            process_coverage_calculation(location.dict(), task_id)
        )
        return {
            "task_id": task_id,
            "status": "processing",
        }
    except Exception as e:
        logger.exception(
            "Error in street coverage calculation: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/street_coverage/{task_id}")
async def get_coverage_status(task_id: str):
    """Get status of a coverage calculation task."""
    progress = await find_one_with_retry(progress_collection, {"_id": task_id})
    if not progress:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Task not found",
        )
    if progress.get("stage") == "error":
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=progress.get("error", "Unknown error"),
        )

    return {
        "_id": str(progress.get("_id")),
        "stage": progress.get("stage", "unknown"),
        "progress": progress.get("progress", 0),
        "message": progress.get("message", ""),
        "error": progress.get("error"),
        "result": progress.get("result"),
        "metrics": progress.get("metrics", {}),
        "updated_at": progress.get("updated_at"),
        "location": progress.get("location"),
    }


@app.post("/api/street_coverage/incremental")
async def get_incremental_street_coverage(
    location: LocationModel,
):
    """Update street coverage incrementally, processing only new trips since
    last update."""
    try:
        task_id = str(uuid.uuid4())
        asyncio.create_task(
            process_incremental_coverage_calculation(location.dict(), task_id)
        )
        return {
            "task_id": task_id,
            "status": "processing",
        }
    except Exception as e:
        logger.exception(
            "Error in incremental street coverage calculation: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/trips")
async def get_trips(request: Request):
    """Get all trips as GeoJSON."""
    try:
        query = await build_query_from_request(request)

        all_trips = await find_with_retry(trips_collection, query)
        features = []

        processor = TripProcessor()

        for trip in all_trips:
            try:
                st = trip.get("startTime")
                et = trip.get("endTime")
                if not st or not et:
                    logger.warning(
                        "Skipping trip with missing start/end times: %s",
                        trip.get("transactionId"),
                    )
                    continue

                if isinstance(st, str):
                    st = dateutil_parser.isoparse(st)
                if isinstance(et, str):
                    et = dateutil_parser.isoparse(et)
                if st.tzinfo is None:
                    st = st.astimezone(timezone.utc)
                if et.tzinfo is None:
                    et = et.astimezone(timezone.utc)

                # Calculate duration in seconds
                duration_seconds = (
                    (et - st).total_seconds() if st and et else 0
                )

                geom = trip.get("gps")
                num_points = 0
                if isinstance(geom, str):
                    try:
                        geom_obj = geojson_module.loads(geom)
                        if (
                            geom_obj
                            and "coordinates" in geom_obj
                            and isinstance(geom_obj["coordinates"], list)
                        ):
                            num_points = len(geom_obj["coordinates"])
                        geom = geom_obj  # Use the parsed object
                    except Exception:
                        logger.warning(
                            "Could not parse geometry string for trip %s",
                            trip.get("transactionId"),
                            exc_info=True,
                        )
                        geom = None  # Set geom to None if parsing failed
                elif (
                    isinstance(geom, dict)
                    and "coordinates" in geom
                    and isinstance(geom["coordinates"], list)
                ):
                    num_points = len(geom["coordinates"])
                else:
                    # Handle cases where geom might be None or unexpected type
                    logger.warning(
                        "Unexpected geometry type (%s) or missing coordinates for trip %s. Cannot determine point count.",
                        type(geom).__name__,
                        trip.get("transactionId"),
                    )

                props = {
                    "transactionId": trip.get("transactionId", "??"),
                    "imei": trip.get("imei", "UPLOAD"),
                    "startTime": st.astimezone(timezone.utc).isoformat(),
                    "endTime": et.astimezone(timezone.utc).isoformat(),
                    "duration": duration_seconds,  # Add duration here
                    "distance": float(trip.get("distance", 0)),
                    "timeZone": trip.get(
                        "timeZone",
                        "America/Chicago",
                    ),
                    "maxSpeed": float(trip.get("maxSpeed", 0)),
                    "startLocation": trip.get("startLocation", "N/A"),
                    "destination": trip.get("destination", "N/A"),
                    "totalIdleDuration": trip.get("totalIdleDuration", 0),
                    "totalIdleDurationFormatted": processor.format_idle_time(
                        trip.get("totalIdleDuration", 0)
                    ),
                    "fuelConsumed": float(trip.get("fuelConsumed", 0)),
                    "source": trip.get("source", "unknown"),
                    "hardBrakingCount": trip.get("hardBrakingCount"),
                    "hardAccelerationCount": trip.get("hardAccelerationCount"),
                    "startOdometer": trip.get("startOdometer"),
                    "endOdometer": trip.get("endOdometer"),
                    "averageSpeed": trip.get("averageSpeed"),
                    "pointsRecorded": num_points,  # Use calculated number of points
                }

                # Ensure geom is a valid GeoJSON geometry dict or None before passing to Feature
                valid_geom = (
                    geom
                    if isinstance(geom, dict)
                    and "type" in geom
                    and "coordinates" in geom
                    else None
                )

                feature = geojson_module.Feature(
                    geometry=valid_geom,
                    properties=props,
                )
                features.append(feature)
            except Exception as e:
                logger.exception(
                    "Error processing trip for transactionId: %s - %s",
                    trip.get("transactionId"),
                    str(e),
                )
                continue

        fc = geojson_module.FeatureCollection(features)
        return JSONResponse(content=fc)
    except Exception as e:
        logger.exception(
            "Error in /api/trips endpoint: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve trips",
        )


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
                            ]
                        }
                    },
                    "total_fuel_consumed": {
                        "$sum": {
                            "$ifNull": [
                                "$fuelConsumed",
                                0,
                            ]
                        }
                    },
                    "max_speed": {
                        "$max": {
                            "$ifNull": [
                                "$maxSpeed",
                                0,
                            ]
                        }
                    },
                    "total_idle_duration": {
                        "$sum": {
                            "$ifNull": [
                                "$totalIdleDuration",
                                0,
                            ]
                        }
                    },
                    "longest_trip_distance": {
                        "$max": {
                            "$ifNull": [
                                "$distance",
                                0,
                            ]
                        }
                    },
                }
            },
        ]

        trips_result = await aggregate_with_retry(trips_collection, pipeline)

        pipeline_most_visited = [
            {"$match": query},
            {
                "$group": {
                    "_id": "$destination",
                    "count": {"$sum": 1},
                    "isCustomPlace": {"$first": "$isCustomPlace"},
                }
            },
            {"$sort": {"count": -1}},
            {"$limit": 1},
        ]

        trips_mv = await aggregate_with_retry(
            trips_collection,
            pipeline_most_visited,
        )

        combined = {
            "total_trips": 0,
            "total_distance": 0.0,
            "total_fuel_consumed": 0.0,
            "max_speed": 0.0,
            "total_idle_duration": 0,
            "longest_trip_distance": 0.0,
            "most_visited": {},
        }

        if trips_result and trips_result[0]:
            r = trips_result[0]
            combined["total_trips"] = r.get("total_trips", 0)
            combined["total_distance"] = r.get("total_distance", 0)
            combined["total_fuel_consumed"] = r.get("total_fuel_consumed", 0)
            combined["max_speed"] = r.get("max_speed", 0)
            combined["total_idle_duration"] = r.get("total_idle_duration", 0)
            combined["longest_trip_distance"] = r.get(
                "longest_trip_distance", 0
            )

        if trips_mv and trips_mv[0]:
            best = trips_mv[0]
            combined["most_visited"] = {
                "_id": best["_id"],
                "count": best["count"],
                "isCustomPlace": best.get("isCustomPlace", False),
            }

        return JSONResponse(content=combined)
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
                        ]
                    },
                    "numericMaxSpeed": {
                        "$ifNull": [
                            {"$toDouble": "$maxSpeed"},
                            0.0,
                        ]
                    },
                    "duration_seconds": {
                        "$cond": {
                            "if": {
                                "$and": [
                                    {
                                        "$ifNull": [
                                            "$startTime",
                                            None,
                                        ]
                                    },
                                    {
                                        "$ifNull": [
                                            "$endTime",
                                            None,
                                        ]
                                    },
                                    {
                                        "$lt": [
                                            "$startTime",
                                            "$endTime",
                                        ]
                                    },
                                ]
                            },
                            "then": {
                                "$divide": [
                                    {
                                        "$subtract": [
                                            "$endTime",
                                            "$startTime",
                                        ]
                                    },
                                    1000,
                                ]
                            },
                            "else": 0.0,
                        }
                    },
                    "startHourUTC": {
                        "$hour": {
                            "date": "$startTime",
                            "timezone": "UTC",
                        }
                    },
                }
            },
            {
                "$group": {
                    "_id": None,
                    "total_trips": {"$sum": 1},
                    "total_distance": {"$sum": "$numericDistance"},
                    "max_speed": {"$max": "$numericMaxSpeed"},
                    "total_duration_seconds": {"$sum": "$duration_seconds"},
                    "start_hours_utc": {"$push": "$startHourUTC"},
                }
            },
            {
                "$project": {
                    "_id": 0,
                    "total_trips": 1,
                    "total_distance": {
                        "$ifNull": [
                            "$total_distance",
                            0.0,
                        ]
                    },
                    "max_speed": {
                        "$ifNull": [
                            "$max_speed",
                            0.0,
                        ]
                    },
                    "total_duration_seconds": {
                        "$ifNull": [
                            "$total_duration_seconds",
                            0.0,
                        ]
                    },
                    "start_hours_utc": {
                        "$ifNull": [
                            "$start_hours_utc",
                            [],
                        ]
                    },
                    "avg_distance": {
                        "$cond": {
                            "if": {
                                "$gt": [
                                    "$total_trips",
                                    0,
                                ]
                            },
                            "then": {
                                "$divide": [
                                    "$total_distance",
                                    "$total_trips",
                                ]
                            },
                            "else": 0.0,
                        }
                    },
                    "avg_speed": {
                        "$cond": {
                            "if": {
                                "$gt": [
                                    "$total_duration_seconds",
                                    0,
                                ]
                            },
                            "then": {
                                "$divide": [
                                    "$total_distance",
                                    {
                                        "$divide": [
                                            "$total_duration_seconds",
                                            3600.0,
                                        ]
                                    },
                                ]
                            },
                            "else": 0.0,
                        }
                    },
                }
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
                start_hours_utc_list
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

            avg_start_time_str = (
                f"{display_hour:02d}:{local_minute:02d} {am_pm}"
            )

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
        }

        return JSONResponse(content=response_content)

    except Exception as e:
        logger.exception("Error in get_metrics: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/fetch_trips")
async def api_fetch_trips():
    """Fetch recent trips from Bouncie API."""
    try:
        last_trip = await find_one_with_retry(
            trips_collection,
            {"source": "bouncie"},
            sort=[("endTime", -1)],
        )
        start_date = (
            last_trip["endTime"]
            if last_trip and last_trip.get("endTime")
            else datetime.now(timezone.utc) - timedelta(days=7)
        )
        end_date = datetime.now(timezone.utc)
        logger.info(
            "Fetching trips from %s to %s",
            start_date,
            end_date,
        )
        await fetch_bouncie_trips_in_range(
            start_date,
            end_date,
            do_map_match=False,
        )
        return {
            "status": "success",
            "message": "New trips fetched & stored.",
        }
    except Exception as e:
        logger.exception("Error fetching trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/fetch_trips_range")
async def api_fetch_trips_range(
    data: DateRangeModel,
):
    """Apply a date range filter to retrieve trips from the database.
    This does NOT fetch new trips from Bouncie API.
    """
    try:
        start_date = parse_query_date(data.start_date)
        end_date = parse_query_date(data.end_date, end_of_day=True)
        if not start_date or not end_date:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid date range.",
            )

        logger.info(
            "Date range filter applied: %s to %s",
            start_date,
            end_date,
        )

        return {
            "status": "success",
            "message": "Date range filter applied.",
        }

    except Exception as e:
        logger.exception(
            "Error applying date range filter: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/fetch_trips_last_hour")
async def api_fetch_trips_last_hour():
    """Fetch trips from the last hour and perform map matching."""
    try:
        now_utc = datetime.now(timezone.utc)
        start_date = now_utc - timedelta(hours=1)
        await fetch_bouncie_trips_in_range(
            start_date, now_utc, do_map_match=True
        )
        return {
            "status": "success",
            "message": "Hourly trip fetch completed.",
        }
    except Exception as e:
        logger.exception(
            "Error fetching trips from last hour: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/process_trip/{trip_id}")
async def process_single_trip(
    trip_id: str,
    validate_only: bool = False,
    geocode_only: bool = False,
    map_match: bool = True,
):
    """Process a single trip with options to validate, geocode, and map
    match."""
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
                {"transactionId": trip_id}
            )
            is not None,
            "processing_history": trip.get("processing_history", []),
            "validation_status": trip.get("validation_status", "unknown"),
            "validation_message": trip.get("validation_message", ""),
            "validated_at": SerializationHelper.serialize_datetime(
                trip.get("validated_at")
            ),
            "geocoded_at": SerializationHelper.serialize_datetime(
                trip.get("geocoded_at")
            ),
            "matched_at": SerializationHelper.serialize_datetime(
                trip.get("matched_at")
            ),
            "last_processed": SerializationHelper.serialize_datetime(
                trip.get("saved_at")
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


@app.get("/export/geojson")
async def export_geojson(request: Request):
    """Export trips as GeoJSON."""
    try:
        query = await build_query_from_request(request)
        trips = await find_with_retry(trips_collection, query)

        if not trips:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No trips found for filters.",
            )

        return await export_geojson_response(trips, "all_trips")

    except Exception as e:
        logger.exception("Error exporting GeoJSON: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/export/gpx")
async def export_gpx(request: Request):
    """Export trips as GPX."""
    try:
        query = await build_query_from_request(request)
        trips = await find_with_retry(trips_collection, query)

        if not trips:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No trips found.",
            )

        return await export_gpx_response(trips, "trips")
    except Exception as e:
        logger.exception("Error exporting GPX: %s", str(e))
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
        location.dict(), streets_only
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

        matched = await find_with_retry(matched_trips_collection, query)
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
                            trip.get("startTime")
                        )
                        or "",
                        "endTime": SerializationHelper.serialize_datetime(
                            trip.get("endTime")
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
                                )
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
                        }
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
                    }
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
                days=data.interval_days
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
                }
            },
        )

        trips_list = await find_with_retry(
            trips_collection,
            {
                "startTime": {
                    "$gte": start_date,
                    "$lte": end_date,
                }
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


@app.get("/api/export/trip/{trip_id}")
async def export_single_trip(
    trip_id: str,
    fmt: str = Query("geojson", description="Export format"),
):
    """Export a single trip by ID."""
    try:
        t = await find_one_with_retry(
            trips_collection,
            {"transactionId": trip_id},
        )

        if not t:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trip not found",
            )

        start_date = t.get("startTime")
        date_str = (
            start_date.strftime("%Y%m%d") if start_date else "unknown_date"
        )
        filename_base = f"trip_{trip_id}_{date_str}"

        return await create_export_response([t], fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    except Exception as e:
        logger.exception(
            "Error exporting trip %s: %s",
            trip_id,
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
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
                ]
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


@app.get("/api/export/all_trips")
async def export_all_trips(
    fmt: str = Query("geojson", description="Export format"),
):
    """Export all trips in various formats."""
    try:
        all_trips = await find_with_retry(trips_collection, {})

        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename_base = f"all_trips_{current_time}"

        if fmt == "json":
            return JSONResponse(
                content=json.loads(
                    json.dumps(
                        all_trips,
                        default=default_serializer,
                    )
                )
            )

        return await create_export_response(all_trips, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception(
            "Error exporting all trips: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/export/trips")
async def export_trips_within_range(
    request: Request,
    fmt: str = Query("geojson", description="Export format"),
):
    """Export trips within a date range."""
    try:
        query = await build_query_from_request(request)

        if "startTime" not in query:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or missing date range",
            )

        all_trips = await find_with_retry(trips_collection, query)

        date_range = extract_date_range_string(query)
        filename_base = f"trips_{date_range}"

        return await create_export_response(all_trips, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    except Exception as e:
        logger.exception(
            "Error exporting trips within range: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/export/matched_trips")
async def export_matched_trips_within_range(
    request: Request,
    fmt: str = Query("geojson", description="Export format"),
):
    """Export matched trips within a date range."""
    try:
        query = await build_query_from_request(request)

        if "startTime" not in query:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or missing date range",
            )

        matched = await find_with_retry(matched_trips_collection, query)

        date_range = extract_date_range_string(query)
        filename_base = f"matched_trips_{date_range}"

        return await create_export_response(matched, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception(
            "Error exporting matched trips: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/export/streets")
async def export_streets(
    location: str = Query(
        ...,
        description="Location data in JSON format",
    ),
    fmt: str = Query("geojson", description="Export format"),
):
    """Export streets data for a location."""
    try:
        try:
            loc = json.loads(location)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location JSON",
            )

        data, error = await generate_geojson_osm(loc, streets_only=True)

        if not data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=error or "No data returned from Overpass",
            )

        location_name = get_location_filename(loc)
        filename_base = f"streets_{location_name}"

        return await create_export_response(data, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )
    except Exception as e:
        logger.exception(
            "Error exporting streets data: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/export/boundary")
async def export_boundary(
    location: str = Query(
        ...,
        description="Location data in JSON format",
    ),
    fmt: str = Query("geojson", description="Export format"),
):
    """Export boundary data for a location."""
    try:
        try:
            loc = json.loads(location)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location JSON",
            )

        data, error = await generate_geojson_osm(loc, streets_only=False)

        if not data:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=error or "No boundary data from Overpass",
            )

        location_name = get_location_filename(loc)
        filename_base = f"boundary_{location_name}"

        return await create_export_response(data, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    except Exception as e:
        logger.exception(
            "Error exporting boundary data: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/preprocess_streets")
async def preprocess_streets_route(
    location_data: LocationModel,
):
    """Preprocess streets data for a validated location received in the request
    body.

    Args:
        location_data: Validated location data matching LocationModel.
    """
    display_name = None
    try:
        validated_location_dict = location_data.dict()
        display_name = validated_location_dict.get("display_name")

        if not display_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location data provided (missing display_name).",
            )

        existing = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
        )
        if existing and existing.get("status") == "processing":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This area is already being processed",
            )

        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
            {
                "$set": {
                    "location": validated_location_dict,
                    "status": "processing",
                    "last_error": None,
                    "last_updated": datetime.now(timezone.utc),
                    "total_length": 0,
                    "driven_length": 0,
                    "coverage_percentage": 0,
                    "total_segments": 0,
                }
            },
            upsert=True,
        )

        task_id = str(uuid.uuid4())
        asyncio.create_task(process_area(validated_location_dict, task_id))
        return {
            "status": "success",
            "task_id": task_id,
        }

    except Exception as e:
        logger.exception(
            "Error in preprocess_streets_route for %s: %s",
            display_name,
            e,
        )
        try:
            if display_name:
                await coverage_metadata_collection.update_one(
                    {"location.display_name": display_name},
                    {
                        "$set": {
                            "status": "error",
                            "last_error": str(e),
                        }
                    },
                )
        except Exception as db_err:
            logger.error(
                "Failed to update error status for %s: %s",
                display_name,
                db_err,
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.get("/api/street_segment/{segment_id}")
async def get_street_segment_details(
    segment_id: str,
):
    """Get details for a specific street segment."""
    try:
        segment = await find_one_with_retry(
            streets_collection,
            {"properties.segment_id": segment_id},
            {"_id": 0},
        )
        if not segment:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Segment not found",
            )
        return segment
    except Exception as e:
        logger.exception(
            "Error fetching segment details: %s",
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
                tzinfo=timezone.utc
            )

        return {
            "first_trip_date": SerializationHelper.serialize_datetime(
                earliest_trip_date
            )
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
    collection."""
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
                                        }
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
                        for trip_dict in trips_to_process:
                            await process_and_store_trip(
                                trip_dict,
                                source="upload_geojson",
                            )
                            success_count += 1
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
    collection."""
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
                                "gps": json.dumps(
                                    {
                                        "type": "LineString",
                                        "coordinates": coords,
                                    }
                                ),
                                "imei": "UPLOADED",
                                "distance": calculate_distance(coords),
                                "source": "upload_gpx",
                            }
                            await process_and_store_trip(
                                trip_dict,
                                source="upload_gpx",
                            )
                            count += 1
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
                    if trips:
                        for t in trips:
                            await process_and_store_trip(
                                t,
                                source="upload_geojson",
                            )
                            count += 1
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
                            }
                        },
                        "hour": {"$hour": "$startTime"},
                    },
                    "totalDistance": {"$sum": "$distance"},
                    "tripCount": {"$sum": 1},
                }
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
            }
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
    """
    Receives webhook events from Bouncie, acknowledges immediately,
    and schedules background processing via Celery.
    """
    try:
        raw_body = await request.body()
        try:
            data = json.loads(raw_body)
        except json.JSONDecodeError:
            logger.error(
                "Failed to parse JSON from Bouncie webhook request body."
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

        if not db_manager._connection_healthy:
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
        status_code = status.HTTP_500_INTERNAL_SERVER_ERROR

        if (
            "Cannot connect to database" in error_message
            or "ServerSelectionTimeoutError" in error_message
        ):
            error_code = "DB_CONNECTION_ERROR"
            status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        elif "Memory" in error_message:
            error_code = "MEMORY_ERROR"

        return JSONResponse(
            status_code=status_code,
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


async def _recalculate_coverage_stats(
    location_id: ObjectId,
) -> dict | None:
    """Internal helper to recalculate stats for a coverage area based on
    streets_collection."""
    try:
        coverage_area = await find_one_with_retry(
            coverage_metadata_collection,
            {"_id": location_id},
            {"location.display_name": 1},
        )
        if not coverage_area or not coverage_area.get("location", {}).get(
            "display_name"
        ):
            logger.error(
                "Cannot recalculate stats: Coverage area %s or its display_name not found.",
                location_id,
            )
            return None

        location_name = coverage_area["location"]["display_name"]

        pipeline = [
            {"$match": {"properties.location": location_name}},
            {
                "$group": {
                    "_id": None,
                    "total_segments": {"$sum": 1},
                    "total_length": {"$sum": "$properties.segment_length"},
                    "driveable_length": {
                        "$sum": {
                            "$cond": [
                                {
                                    "$eq": [
                                        "$properties.undriveable",
                                        True,
                                    ]
                                },
                                0,
                                "$properties.segment_length",
                            ]
                        }
                    },
                    "driven_length": {
                        "$sum": {
                            "$cond": [
                                {
                                    "$eq": [
                                        "$properties.driven",
                                        True,
                                    ]
                                },
                                "$properties.segment_length",
                                0,
                            ]
                        }
                    },
                    "street_types_data": {
                        "$push": {
                            "type": "$properties.highway",
                            "length": "$properties.segment_length",
                            "driven": "$properties.driven",
                            "undriveable": "$properties.undriveable",
                        }
                    },
                }
            },
        ]

        results = await aggregate_with_retry(streets_collection, pipeline)

        if not results:
            stats = {
                "total_length": 0.0,
                "driven_length": 0.0,
                "driveable_length": 0.0,
                "coverage_percentage": 0.0,
                "total_segments": 0,
                "street_types": [],
            }
        else:
            agg_result = results[0]
            total_length = agg_result.get("total_length", 0.0) or 0.0
            driven_length = agg_result.get("driven_length", 0.0) or 0.0
            driveable_length = agg_result.get("driveable_length", 0.0) or 0.0
            total_segments = agg_result.get("total_segments", 0) or 0

            coverage_percentage = (
                (driven_length / driveable_length * 100)
                if driveable_length > 0
                else 0.0
            )

            street_types_summary = defaultdict(
                lambda: {
                    "length": 0.0,
                    "covered_length": 0.0,
                    "undriveable_length": 0.0,
                    "total": 0,
                    "covered": 0,
                }
            )
            for item in agg_result.get("street_types_data", []):
                stype = item.get("type", "unknown")
                length = item.get("length", 0.0) or 0.0
                is_driven = item.get("driven", False)
                is_undriveable = item.get("undriveable", False)

                street_types_summary[stype]["length"] += length
                street_types_summary[stype]["total"] += 1

                if is_undriveable:
                    street_types_summary[stype]["undriveable_length"] += length
                elif is_driven:
                    street_types_summary[stype]["covered_length"] += length
                    street_types_summary[stype]["covered"] += 1

            final_street_types = []
            for (
                stype,
                data,
            ) in street_types_summary.items():
                type_driveable_length = (
                    data["length"] - data["undriveable_length"]
                )
                type_coverage_pct = (
                    (data["covered_length"] / type_driveable_length * 100)
                    if type_driveable_length > 0
                    else 0.0
                )
                final_street_types.append(
                    {
                        "type": stype,
                        "length": data["length"],
                        "covered_length": data["covered_length"],
                        "coverage_percentage": type_coverage_pct,
                        "total": data["total"],
                        "covered": data["covered"],
                        "undriveable_length": data["undriveable_length"],
                    }
                )
            final_street_types.sort(
                key=lambda x: x["length"],
                reverse=True,
            )

            stats = {
                "total_length": total_length,
                "driven_length": driven_length,
                "driveable_length": driveable_length,
                "coverage_percentage": coverage_percentage,
                "total_segments": total_segments,
                "street_types": final_street_types,
            }

        update_result = await update_one_with_retry(
            coverage_metadata_collection,
            {"_id": location_id},
            {
                "$set": {
                    **stats,
                    "needs_stats_update": False,
                    "last_stats_update": datetime.now(timezone.utc),
                    "last_modified": datetime.now(timezone.utc),
                }
            },
        )

        if update_result.modified_count == 0:
            logger.warning(
                "Stats recalculated for %s, but metadata document was not modified (maybe no change or error?).",
                location_id,
            )
        else:
            logger.info(
                "Successfully recalculated and updated stats for %s.",
                location_id,
            )

        updated_coverage_area = await find_one_with_retry(
            coverage_metadata_collection,
            {"_id": location_id},
        )
        if updated_coverage_area:
            updated_coverage_area["_id"] = str(updated_coverage_area["_id"])
            return updated_coverage_area
        return {
            **stats,
            "_id": str(location_id),
            "location": coverage_area.get("location", {}),
        }

    except Exception as e:
        logger.error(
            "Error recalculating stats for %s: %s",
            location_id,
            e,
            exc_info=True,
        )
        await update_one_with_retry(
            coverage_metadata_collection,
            {"_id": location_id},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"Stats recalc failed: {e}",
                }
            },
        )
        return None


async def _mark_segment(
    location_id_str: str,
    segment_id: str,
    updates: dict,
    action_name: str,
):
    """Helper function to mark a street segment."""
    if not location_id_str or not segment_id:
        raise HTTPException(
            status_code=400,
            detail="Missing location_id or segment_id",
        )

    try:
        location_id = ObjectId(location_id_str)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Invalid location_id format",
        )

    segment_doc = await find_one_with_retry(
        streets_collection,
        {"properties.segment_id": segment_id},
    )

    if not segment_doc:
        raise HTTPException(
            status_code=404,
            detail="Street segment not found",
        )

    if segment_doc.get("properties", {}).get(
        "location_id"
    ) != location_id_str and segment_doc.get("properties", {}).get(
        "location"
    ) != (
        await find_one_with_retry(
            coverage_metadata_collection,
            {"_id": location_id},
            {"location.display_name": 1},
        )
    ).get(
        "location", {}
    ).get(
        "display_name"
    ):
        logger.warning(
            "Segment %s found but does not belong to location %s. Proceeding anyway.",
            segment_id,
            location_id_str,
        )

    update_payload = {
        f"properties.{key}": value for key, value in updates.items()
    }
    update_payload["properties.manual_override"] = True
    update_payload["properties.last_manual_update"] = datetime.now(
        timezone.utc
    )

    result = await update_one_with_retry(
        streets_collection,
        {"_id": segment_doc["_id"]},
        {"$set": update_payload},
    )

    if result.modified_count == 0:
        logger.info(
            "Segment %s already had the desired state for action '%s'. No DB change made.",
            segment_id,
            action_name,
        )

    await update_one_with_retry(
        coverage_metadata_collection,
        {"_id": location_id},
        {
            "$set": {
                "needs_stats_update": True,
                "last_modified": datetime.now(timezone.utc),
            }
        },
    )

    return {
        "success": True,
        "message": f"Segment marked as {action_name}",
    }


@app.post("/api/street_segments/mark_driven")
async def mark_street_segment_as_driven(
    request: Request,
):
    """Mark a street segment as manually driven."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        segment_id = data.get("segment_id")
        updates = {
            "driven": True,
            "undriveable": False,
            "manually_marked_driven": True,
            "manually_marked_undriven": False,
            "manually_marked_undriveable": False,
            "manually_marked_driveable": False,
        }
        return await _mark_segment(
            location_id,
            segment_id,
            updates,
            "driven",
        )
    except HTTPException as http_exc:
        logger.error(
            "Error marking driven (HTTP %s): %s",
            http_exc.status_code,
            http_exc.detail,
        )
        raise http_exc
    except Exception as e:
        logger.error(
            "Error marking street segment as driven: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/street_segments/mark_undriven")
async def mark_street_segment_as_undriven(
    request: Request,
):
    """Mark a street segment as manually undriven (not driven)."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        segment_id = data.get("segment_id")
        updates = {
            "driven": False,
            "manually_marked_undriven": True,
            "manually_marked_driven": False,
        }
        return await _mark_segment(
            location_id,
            segment_id,
            updates,
            "undriven",
        )
    except HTTPException as http_exc:
        logger.error(
            "Error marking undriven (HTTP %s): %s",
            http_exc.status_code,
            http_exc.detail,
        )
        raise http_exc
    except Exception as e:
        logger.error(
            "Error marking street segment as undriven: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/street_segments/mark_undriveable")
async def mark_street_segment_as_undriveable(
    request: Request,
):
    """Mark a street segment as undriveable (cannot be driven)."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        segment_id = data.get("segment_id")
        updates = {
            "undriveable": True,
            "driven": False,
            "manually_marked_undriveable": True,
            "manually_marked_driveable": False,
            "manually_marked_driven": False,
            "manually_marked_undriven": False,
        }
        return await _mark_segment(
            location_id,
            segment_id,
            updates,
            "undriveable",
        )
    except HTTPException as http_exc:
        logger.error(
            "Error marking undriveable (HTTP %s): %s",
            http_exc.status_code,
            http_exc.detail,
        )
        raise http_exc
    except Exception as e:
        logger.error(
            "Error marking street segment as undriveable: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/street_segments/mark_driveable")
async def mark_street_segment_as_driveable(
    request: Request,
):
    """Mark a street segment as driveable (removing undriveable status)."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        segment_id = data.get("segment_id")
        updates = {
            "undriveable": False,
            "manually_marked_driveable": True,
            "manually_marked_undriveable": False,
        }
        return await _mark_segment(
            location_id,
            segment_id,
            updates,
            "driveable",
        )
    except HTTPException as http_exc:
        logger.error(
            "Error marking driveable (HTTP %s): %s",
            http_exc.status_code,
            http_exc.detail,
        )
        raise http_exc
    except Exception as e:
        logger.error(
            "Error marking street segment as driveable: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/coverage_areas/{location_id}/refresh_stats")
async def refresh_coverage_stats(
    location_id: str,
):
    """Refresh statistics for a coverage area after manual street modifications."""
    logger.info(
        "Received request to refresh stats for location_id: %s",
        location_id,
    )
    try:
        obj_location_id = ObjectId(location_id)
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Invalid location_id format",
        )

    try:
        updated_coverage_data = await _recalculate_coverage_stats(
            obj_location_id
        )

        if updated_coverage_data is None:
            raise HTTPException(
                status_code=500,
                detail="Failed to recalculate statistics",
            )

        serialized_data = json.loads(
            json.dumps(
                {
                    "success": True,
                    "coverage": updated_coverage_data,
                },
                default=lambda obj: (
                    obj.isoformat()
                    if isinstance(obj, datetime)
                    else (str(obj) if isinstance(obj, ObjectId) else None)
                ),
            )
        )

        return JSONResponse(serialized_data)

    except HTTPException as http_exc:
        logger.error(
            "HTTP Error refreshing stats for %s: %s",
            location_id,
            http_exc.detail,
        )
        raise http_exc
    except Exception as e:
        logger.error(
            "Error refreshing coverage stats for %s: %s",
            location_id,
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Internal server error refreshing stats: {str(e)}",
        )


@app.get("/api/coverage_areas")
async def get_coverage_areas():
    """Get all coverage areas."""
    try:
        areas = await find_with_retry(coverage_metadata_collection, {})
        return {
            "success": True,
            "areas": [
                {
                    "_id": str(area["_id"]),
                    "location": area["location"],
                    "total_length": area.get(
                        "total_length_m",
                        area.get("total_length", 0),
                    ),
                    "driven_length": area.get(
                        "driven_length_m",
                        area.get("driven_length", 0),
                    ),
                    "coverage_percentage": area.get("coverage_percentage", 0),
                    "last_updated": area.get("last_updated"),
                    "total_segments": area.get("total_segments", 0),
                    "status": area.get("status", "completed"),
                    "last_error": area.get("last_error"),
                }
                for area in areas
            ],
        }
    except Exception as e:
        logger.error(
            "Error fetching coverage areas: %s",
            str(e),
        )
        return {"success": False, "error": str(e)}


@app.post("/api/coverage_areas/delete")
async def delete_coverage_area(
    location: DeleteCoverageAreaModel,
):
    """Delete a coverage area and all associated data."""
    try:
        display_name = location.display_name
        if not display_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location display name",
            )

        coverage_metadata = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
        )

        if not coverage_metadata:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Coverage area not found",
            )

        if gridfs_id := coverage_metadata.get("streets_geojson_gridfs_id"):
            try:
                fs = AsyncIOMotorGridFSBucket(db_manager.db)
                await fs.delete(gridfs_id)
                logger.info(
                    "Deleted GridFS file %s for %s", gridfs_id, display_name
                )
            except Exception as gridfs_err:
                logger.warning(
                    "Error deleting GridFS file for %s: %s",
                    display_name,
                    gridfs_err,
                )

        try:
            await delete_many_with_retry(
                progress_collection,
                {"location": display_name},
            )
            logger.info("Deleted progress data for %s", display_name)
        except Exception as progress_err:
            logger.warning(
                f"Error deleting progress data for {display_name}: {progress_err}"
            )

        try:
            await delete_many_with_retry(
                osm_data_collection,
                {"location.display_name": display_name},
            )
            logger.info("Deleted cached OSM data for %s", display_name)
        except Exception as osm_err:
            logger.warning(
                f"Error deleting OSM data for {display_name}: {osm_err}"
            )

        await delete_many_with_retry(
            streets_collection,
            {"properties.location": display_name},
        )
        logger.info("Deleted street segments for %s", display_name)

        _ = await delete_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
        )
        logger.info("Deleted coverage metadata for %s", display_name)

        return {
            "status": "success",
            "message": "Coverage area and all associated data deleted successfully",
        }

    except HTTPException:
        logger.warning("HTTPException in delete_coverage_area", exc_info=True)
        raise
    except Exception as e:
        logger.exception(
            "Error deleting coverage area: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@app.post("/api/coverage_areas/cancel")
async def cancel_coverage_area(
    location: DeleteCoverageAreaModel,
):
    """Cancel processing of a coverage area."""
    try:
        display_name = location.display_name
        if not display_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location display name",
            )

        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
            {
                "$set": {
                    "status": "canceled",
                    "last_error": "Task was canceled by user.",
                }
            },
        )

        return {
            "status": "success",
            "message": "Coverage area processing canceled",
        }

    except Exception as e:
        logger.exception(
            "Error canceling coverage area: %s",
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


@app.get("/api/coverage_areas/{location_id}")
async def get_coverage_area_details(
    location_id: str,
):
    """Get detailed information about a coverage area, fetching GeoJSON from
    GridFS."""
    try:
        coverage_doc = None
        try:
            coverage_doc = await find_one_with_retry(
                coverage_metadata_collection,
                {"_id": ObjectId(location_id)},
            )
        except Exception:
            coverage_doc = await find_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": location_id},
            )

        if not coverage_doc:
            logger.error(
                "Coverage area not found for id: %s",
                location_id,
            )
            raise HTTPException(
                status_code=404,
                detail="Coverage area not found",
            )

        location_name = coverage_doc.get("location", {}).get(
            "display_name", "Unknown"
        )
        location_obj = coverage_doc.get("location", {})
        last_updated = SerializationHelper.serialize_datetime(
            coverage_doc.get("last_updated")
        )
        total_length = coverage_doc.get("total_length", 0)
        driven_length = coverage_doc.get("driven_length", 0)
        coverage_percentage = coverage_doc.get("coverage_percentage", 0)
        status = coverage_doc.get("status", "unknown")
        last_error = coverage_doc.get("last_error")

        streets_geojson = {}
        total_streets = 0
        needs_reprocessing = True
        gridfs_id = coverage_doc.get("streets_geojson_gridfs_id")

        if gridfs_id:
            try:
                fs = AsyncIOMotorGridFSBucket(db_manager.db)
                gridfs_stream = await fs.open_download_stream(gridfs_id)
                geojson_data_bytes = await gridfs_stream.read()
                streets_geojson = json.loads(
                    geojson_data_bytes.decode("utf-8")
                )
                if isinstance(streets_geojson, dict) and isinstance(
                    streets_geojson.get("features"),
                    list,
                ):
                    total_streets = len(streets_geojson.get("features", []))
                    needs_reprocessing = False
                    logger.info(
                        "Successfully loaded GeoJSON from GridFS for %s",
                        location_name,
                    )
                else:
                    logger.error(
                        "Invalid GeoJSON structure loaded from GridFS for %s (ID: %s)",
                        location_name,
                        gridfs_id,
                    )
                    streets_geojson = {}
            except NoFile:
                logger.error(
                    "GridFS file not found for ID %s (Location: %s)",
                    gridfs_id,
                    location_name,
                )
            except Exception as gridfs_err:
                logger.error(
                    "Error reading GeoJSON from GridFS ID %s for %s: %s",
                    gridfs_id,
                    location_name,
                    gridfs_err,
                )
        else:
            logger.warning(
                "No streets_geojson_gridfs_id found for location: %s",
                location_name,
            )

        street_types = coverage_doc.get("street_types", [])
        if not street_types and not needs_reprocessing:
            street_types = collect_street_type_stats(
                streets_geojson.get("features", [])
            )

        result = {
            "success": True,
            "coverage": {
                "_id": str(coverage_doc["_id"]),
                "location_name": location_name,
                "location": location_obj,
                "total_length": total_length,
                "driven_length": driven_length,
                "coverage_percentage": coverage_percentage,
                "last_updated": last_updated,
                "total_streets": total_streets,
                "streets_geojson": streets_geojson,
                "street_types": street_types,
                "status": status,
                "has_error": status == "error",
                "error_message": (last_error if status == "error" else None),
                "needs_reprocessing": needs_reprocessing,
            },
        }
        return result

    except Exception as e:
        logger.error(
            "Error fetching coverage area details for %s: %s",
            location_id,
            str(e),
            exc_info=True,
        )

        raise HTTPException(
            status_code=500,
            detail=f"Internal server error fetching coverage details: {
                str(e)
            }",
        )


async def _get_mapbox_optimization_route(
    start_lon: float,
    start_lat: float,
    end_points: list[tuple] = None,
) -> dict[str, Any]:
    """Calls Mapbox Optimization API v1 to get an optimized route for multiple
    points."""
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

    if len(end_points) > 11:
        logger.warning(
            "Too many end points for Mapbox API v1, limiting to first 11."
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
        "steps": "false",
        "overview": "full",
    }

    async with httpx.AsyncClient() as client:
        response = await client.get(url, params=params)

        if response.status_code != 200:
            logger.error(
                "Mapbox API error: %s",
                response.text,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Mapbox API error: {response.text}",
            )

        data = response.json()
        if data.get("code") != "Ok" or not data.get("trips"):
            logger.error(
                "Mapbox API returned no valid trips: %s",
                data,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Mapbox API returned no valid trips.",
            )

        trip = data["trips"][0]
        geometry = trip.get("geometry", {})
        duration = trip.get("duration", 0)
        distance = trip.get("distance", 0)

        return {
            "geometry": geometry,
            "duration": duration,
            "distance": distance,
        }


@app.post("/api/driving-navigation/next-route")
async def get_next_driving_route(
    request: Request,
):
    """
    Calculates the route from the user's current position to the
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

    except (ValueError, TypeError) as e:
        logger.error("Error parsing request data: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid request format: {str(e)}",
        )

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
                "No position provided in request, falling back to live tracking data"
            )
            active_trip_data = await get_active_trip()

            if (
                active_trip_data
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
                    "Live tracking unavailable, falling back to last trip end location"
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
                    geom = last_trip.get("geometry") or geojson_module.loads(
                        last_trip.get("gps", "{}")
                    )
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
                            "Invalid or empty geometry in last trip"
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
            "Error getting position: %s",
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
                "properties.undriveable": {"$ne": True},
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
                }
            )
        logger.info(
            "Found %d undriven segments in %s. Starting optimization with Mapbox API v1.",
            len(undriven_streets),
            location_name,
        )

    except Exception as e:
        logger.error(
            "Error fetching undriven streets for %s: %s",
            location_name,
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error fetching undriven streets: {e}",
        )

    try:
        end_points = []
        for street in undriven_streets:
            geometry = street.get("geometry", {})
            if geometry.get("type") == "LineString" and geometry.get(
                "coordinates"
            ):
                start_node = geometry["coordinates"][0]
                if (
                    isinstance(start_node, (list, tuple))
                    and len(start_node) >= 2
                ):
                    end_points.append(
                        (
                            float(start_node[0]),
                            float(start_node[1]),
                        )
                    )

        if not end_points:
            return JSONResponse(
                content={
                    "status": "completed",
                    "message": f"No valid undriven streets with coordinates found in {location_name}.",
                    "route_geometry": None,
                    "target_street": None,
                }
            )

        optimization_result = await _get_mapbox_optimization_route(
            current_lon,
            current_lat,
            end_points=end_points,
        )

        route_geometry = optimization_result["geometry"]
        route_duration_seconds = optimization_result["duration"]
        route_distance_meters = optimization_result["distance"]

        target_street = (
            undriven_streets[0].get("properties", {})
            if undriven_streets
            else None
        )

        return JSONResponse(
            content={
                "status": "success",
                "message": "Route calculated using Mapbox Optimization API v1.",
                "route_geometry": route_geometry,
                "target_street": target_street,
                "route_duration_seconds": route_duration_seconds,
                "route_distance_meters": route_distance_meters,
                "location_source": location_source,
            }
        )

    except Exception as e:
        logger.error(
            "Error calculating route: %s",
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
        "steps": "false",
    }

    async with httpx.AsyncClient() as client:
        response = await client.get(directions_url, params=params)

        if response.status_code != 200:
            logger.error(
                "Mapbox Directions API error: %s",
                response.text,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Mapbox Directions API error: {response.text}",
            )

        route_data = response.json()
        if not route_data.get("routes") or len(route_data["routes"]) == 0:
            logger.warning(
                "Mapbox API returned no routes for %s,%s -> %s,%s",
                start_lon,
                start_lat,
                end_lon,
                end_lat,
            )
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No route found by Mapbox Directions API.",
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
    max_points_per_cluster: int = 11,
) -> list[list[dict]]:
    """Cluster segments into groups based on geographic proximity."""
    if len(segments) <= max_points_per_cluster:
        return [segments]

    coords = np.array(
        [
            (
                seg["start_node"][0],
                seg["start_node"][1],
            )
            for seg in segments
        ]
    )
    n_clusters = max(1, len(segments) // max_points_per_cluster)
    kmeans = KMeans(n_clusters=n_clusters, random_state=0).fit(coords)
    labels = kmeans.labels_

    clusters = [[] for _ in range(n_clusters)]
    for i, label in enumerate(labels):
        clusters[label].append(segments[i])

    final_clusters = []
    for cluster in clusters:
        if len(cluster) <= max_points_per_cluster:
            final_clusters.append(cluster)
        else:
            for i in range(
                0,
                len(cluster),
                max_points_per_cluster,
            ):
                final_clusters.append(cluster[i : i + max_points_per_cluster])

    return final_clusters


async def _optimize_route_for_clusters(
    start_point: tuple, clusters: list[list[dict]]
) -> dict[str, Any]:
    """Optimize route for multiple clusters, connecting them with directions."""
    if not clusters:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No clusters provided for route optimization.",
        )

    total_duration = 0.0
    total_distance = 0.0
    all_geometries = []
    current_point = start_point

    for i, cluster in enumerate(clusters):
        if not cluster:
            continue

        end_points = [
            (
                seg["start_node"][0],
                seg["start_node"][1],
            )
            for seg in cluster
        ]
        cluster_result = await _get_mapbox_optimization_route(
            current_point[0],
            current_point[1],
            end_points=end_points,
        )

        all_geometries.append(cluster_result["geometry"])
        total_duration += cluster_result["duration"]
        total_distance += cluster_result["distance"]

        if cluster_result["geometry"].get("coordinates"):
            current_point = cluster_result["geometry"]["coordinates"][-1]

        if i < len(clusters) - 1 and clusters[i + 1]:
            next_cluster_first_point = (
                clusters[i + 1][0]["start_node"][0],
                clusters[i + 1][0]["start_node"][1],
            )
            connection_result = await _get_mapbox_directions_route(
                current_point[0],
                current_point[1],
                next_cluster_first_point[0],
                next_cluster_first_point[1],
            )

            all_geometries.append(connection_result["geometry"])
            total_duration += connection_result["duration"]
            total_distance += connection_result["distance"]

            current_point = next_cluster_first_point

        await asyncio.sleep(0.2)

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
    """
    Calculates the route from the user's current position to the
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

    except (ValueError, TypeError) as e:
        logger.error("Error parsing request data: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid request format: {str(e)}",
        )

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
                "No position provided in request, falling back to live tracking data"
            )
            active_trip_data = await get_active_trip()

            if (
                active_trip_data
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
                    "Live tracking unavailable, falling back to last trip end location"
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
                    geom = last_trip.get("geometry") or geojson_module.loads(
                        last_trip.get("gps", "{}")
                    )
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
                            "Invalid or empty geometry in last trip"
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

        start_point = (current_lon, current_lat)

    except Exception as e:
        logger.error(
            "Coverage Route: Error getting position: %s",
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
                    "message": f"No undriven streets found in {location_name} to generate coverage route.",
                    "route_geometry": None,
                    "total_duration_seconds": 0,
                    "total_distance_meters": 0,
                }
            )
        logger.info(
            "Coverage Route: Found %d undriven segments in %s.",
            len(undriven_streets_list),
            location_name,
        )

        valid_segments = []
        for street in undriven_streets_list:
            try:
                geom = street.get("geometry")
                props = street.get("properties", {})
                segment_id = props.get("segment_id", "UNKNOWN")
                if (
                    geom
                    and geom.get("type") == "LineString"
                    and len(geom.get("coordinates", [])) >= 2
                ):
                    coords = geom["coordinates"]
                    start_node = (
                        float(coords[0][0]),
                        float(coords[0][1]),
                    )
                    end_node = (
                        float(coords[-1][0]),
                        float(coords[-1][1]),
                    )
                    valid_segments.append(
                        {
                            "id": segment_id,
                            "name": props.get("street_name"),
                            "geometry": geom,
                            "start_node": start_node,
                            "end_node": end_node,
                        }
                    )
                else:
                    logger.warning(
                        "Coverage Route: Skipping invalid segment %s (type: %s, len: %d)",
                        segment_id,
                        geom.get("type"),
                        len(geom.get("coordinates", [])),
                    )
            except (
                TypeError,
                ValueError,
                IndexError,
            ) as e:
                segment_id = street.get("properties", {}).get(
                    "segment_id", "UNKNOWN"
                )
                logger.warning(
                    "Coverage Route: Error processing segment %s data: %s",
                    segment_id,
                    e,
                )
                continue

        if not valid_segments:
            logger.warning(
                "Coverage Route: No valid undriven segments found in %s after filtering.",
                location_name,
            )
            return JSONResponse(
                content={
                    "status": "error",
                    "message": f"No valid undriven streets could be processed in {location_name}.",
                    "route_geometry": None,
                }
            )

        logger.info(
            "Coverage Route: Processing %d valid segments.",
            len(valid_segments),
        )

    except Exception as e:
        logger.error(
            "Coverage Route: Error fetching/processing undriven streets for %s: %s",
            location_name,
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error preparing segments for coverage route: {e}",
        )

    try:
        clusters = await _cluster_segments(
            valid_segments,
            max_points_per_cluster=11,
        )
        logger.info(
            "Coverage Route: Clustered %d segments into %d clusters for %s.",
            len(valid_segments),
            len(clusters),
            location_name,
        )

        optimization_result = await _optimize_route_for_clusters(
            start_point, clusters
        )

        optimized_route_geometry = optimization_result["geometry"]
        total_duration_seconds = optimization_result["duration"]
        total_distance_meters = optimization_result["distance"]

        segments_covered = sum(len(cluster) for cluster in clusters)
        message = f"Full coverage route generated for {
            segments_covered
        } segments across {len(clusters)} clusters."

        logger.info(
            "Coverage Route: Generated optimized route for %s covering %d segments. Total Duration: %.1fs, Total Distance: %.1fm",
            location_name,
            segments_covered,
            total_duration_seconds,
            total_distance_meters,
        )
        return JSONResponse(
            content={
                "status": "success",
                "message": message,
                "route_geometry": optimized_route_geometry,
                "total_duration_seconds": total_duration_seconds,
                "total_distance_meters": total_distance_meters,
                "location_source": location_source,
            }
        )

    except Exception as e:
        logger.error(
            "Coverage Route: Error generating optimized route: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate optimized coverage route: {e}",
        )


@app.get("/api/export/advanced")
async def export_advanced(
    request: Request,
    include_trips: bool = Query(
        True,
        description="Include regular trips (now all trips)",
    ),
    include_matched_trips: bool = Query(
        True,
        description="Include map-matched trips",
    ),
    include_basic_info: bool = Query(
        True,
        description="Include basic trip info",
    ),
    include_locations: bool = Query(True, description="Include location info"),
    include_telemetry: bool = Query(
        True, description="Include telemetry data"
    ),
    include_geometry: bool = Query(True, description="Include geometry data"),
    include_meta: bool = Query(True, description="Include metadata"),
    include_custom: bool = Query(True, description="Include custom fields"),
    include_gps_in_csv: bool = Query(
        False,
        description="Include GPS in CSV export",
    ),
    flatten_location_fields: bool = Query(
        True,
        description="Flatten location fields in CSV",
    ),
    fmt: str = Query("json", description="Export format"),
):
    """Advanced configurable export for trips data.

    Allows fine-grained control over data sources, fields to include, date
    range, and export format.
    """
    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")

        date_filter = None
        if start_date_str and end_date_str:
            start_date = parse_query_date(start_date_str)
            end_date = parse_query_date(end_date_str, end_of_day=True)
            if start_date and end_date:
                date_filter = {
                    "startTime": {
                        "$gte": start_date,
                        "$lte": end_date,
                    }
                }

        trips = []

        if include_trips:
            query = date_filter or {}
            regular_trips = await find_with_retry(trips_collection, query)

            for trip in regular_trips:
                processed_trip = await process_trip_for_export(
                    trip,
                    include_basic_info,
                    include_locations,
                    include_telemetry,
                    include_geometry,
                    include_meta,
                    include_custom,
                )
                if processed_trip:
                    processed_trip["trip_type"] = trip.get("source", "unknown")
                    trips.append(processed_trip)

        if include_matched_trips:
            query = date_filter or {}
            matched_trips = await find_with_retry(
                matched_trips_collection, query
            )

            for trip in matched_trips:
                processed_trip = await process_trip_for_export(
                    trip,
                    include_basic_info,
                    include_locations,
                    include_telemetry,
                    include_geometry,
                    include_meta,
                    include_custom,
                )
                if processed_trip:
                    processed_trip["trip_type"] = "map_matched"
                    trips.append(processed_trip)

        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename_base = f"trips_export_{current_time}"

        if fmt == "csv":
            csv_data = await create_csv_export(
                trips,
                include_gps_in_csv=include_gps_in_csv,
                flatten_location_fields=flatten_location_fields,
            )
            return StreamingResponse(
                io.StringIO(csv_data),
                media_type="text/csv",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.csv"'
                },
            )

        if fmt == "json":
            return JSONResponse(
                content=json.loads(
                    json.dumps(
                        trips,
                        default=default_serializer,
                    )
                )
            )

        return await create_export_response(
            trips,
            fmt,
            filename_base,
            include_gps_in_csv=include_gps_in_csv,
            flatten_location_fields=flatten_location_fields,
        )
    except ValueError as e:
        logger.error("Export error: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    except Exception as e:
        logger.error("Error in advanced export: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Export failed: {str(e)}",
        )


@app.on_event("startup")
async def startup_event():
    """Initialize database indexes and components on application startup."""
    try:
        await init_database()
        logger.info("Core database initialized successfully (indexes, etc.).")

        initialize_live_tracking_db(
            live_trips_collection,
            archived_live_trips_collection,
        )
        logger.info("Live tracking DB collections initialized.")

        init_collections(places_collection, trips_collection)
        logger.info("Visits collections initialized.")

        TripProcessor(mapbox_token=MAPBOX_ACCESS_TOKEN)
        logger.info("TripProcessor initialized.")

        used_mb, limit_mb = await db_manager.check_quota()
        if not db_manager.quota_exceeded:
            logger.info("Application startup completed successfully.")
        else:
            logger.warning(
                "Application started in limited mode due to exceeded storage quota (%.2f MB / %d MB)",
                (used_mb if used_mb is not None else -1),
                (limit_mb if limit_mb is not None else -1),
            )

        index_name = "matchedGps_2dsphere"
        try:
            indexes = await matched_trips_collection.index_information()
            if index_name not in indexes:
                logger.info(
                    "Creating 2dsphere index on matched_trips_collection.matchedGps..."
                )
                await matched_trips_collection.create_indexes(
                    [
                        IndexModel(
                            [
                                (
                                    "matchedGps",
                                    GEOSPHERE,
                                )
                            ],
                            name=index_name,
                        )
                    ]
                )
                logger.info("Index created successfully.")
            else:
                logger.debug("2dsphere index on matchedGps already exists.")
        except OperationFailure as e:
            logger.warning(
                "OperationFailure during matched_trips index creation: %s",
                e,
            )
            if "GeoJSON LineString must have at least 2 vertices" in str(
                e
            ) or "Can't extract geo keys" in str(e):
                logger.warning(
                    "Index creation on matchedGps skipped due to invalid GeoJSON data in some documents. "
                    "Application will start, but geospatial queries on matched_trips may be slow or fail. "
                    "Consider cleaning up invalid matchedGps data (e.g., LineStrings with identical start/end points)."
                )
            else:
                logger.error(
                    "Unhandled OperationFailure during index creation, re-raising."
                )
                raise
        except Exception as e:
            logger.critical(
                "CRITICAL: Unexpected error during matched_trips index creation: %s",
                str(e),
                exc_info=True,
            )
            raise

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
async def not_found_handler(request: Request, exc):
    """Handle 404 Not Found errors."""
    return JSONResponse(
        status_code=status.HTTP_404_NOT_FOUND,
        content={"error": "Endpoint not found"},
    )


@app.exception_handler(500)
async def internal_error_handler(request: Request, exc):
    """Handle 500 Internal Server Error errors."""
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"error": "Internal server error"},
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
    """Get trip coordinates (from matched_trips) within a given bounding box.

    Uses a spatial query for efficiency.
    """
    try:
        if not (
            -90 <= min_lat <= 90
            and -90 <= max_lat <= 90
            and -180 <= min_lon <= 180
            and -180 <= max_lon <= 180
            and min_lat <= max_lat
            and min_lon <= max_lon
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid bounding box coordinates.",
            )

        bounding_box = [
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
                        "coordinates": [bounding_box],
                    }
                }
            }
        }

        projection = {
            "_id": 0,
            "matchedGps.coordinates": 1,
            "transactionId": 1,
        }

        cursor = matched_trips_collection.find(query, projection)

        trip_coordinates = []
        async for trip in cursor:
            if trip.get("matchedGps") and trip["matchedGps"].get(
                "coordinates"
            ):
                trip_coordinates.append(trip["matchedGps"]["coordinates"])

        logger.info(
            "Found %d trip segments within bounds",
            len(trip_coordinates),
        )
        return JSONResponse(content={"trips": trip_coordinates})

    except Exception as e:
        logger.exception(
            "Error in get_trips_in_bounds: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve trips within bounds",
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
    import collections

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
                return v
        return default

    total_trips = len(trips)
    total_distance = sum(float(get_field(t, "distance")) or 0 for t in trips)
    avg_speed = (
        sum(
            float(get_field(t, "avgSpeed", "averageSpeed")) or 0 for t in trips
        )
        / total_trips
        if total_trips
        else 0
    )
    max_speed = max(float(get_field(t, "maxSpeed")) or 0 for t in trips)
    hard_braking = sum(
        int(
            get_field(
                t,
                "hardBrakingCounts",
                "hardBrakingCount",
            )
        )
        or 0
        for t in trips
    )
    hard_accel = sum(
        int(
            get_field(
                t,
                "hardAccelerationCounts",
                "hardAccelerationCount",
            )
        )
        or 0
        for t in trips
    )
    idling = sum(
        float(
            get_field(
                t,
                "totalIdlingTime",
                "totalIdleDuration",
            )
        )
        or 0
        for t in trips
    )
    fuel = sum(float(get_field(t, "fuelConsumed")) or 0 for t in trips)

    weekly = collections.defaultdict(
        lambda: {
            "trips": 0,
            "distance": 0,
            "hardBraking": 0,
            "hardAccel": 0,
        }
    )
    monthly = collections.defaultdict(
        lambda: {
            "trips": 0,
            "distance": 0,
            "hardBraking": 0,
            "hardAccel": 0,
        }
    )
    for t in trips:
        start = t.get("startTime")
        if not start:
            continue
        if isinstance(start, str):
            try:
                start = datetime.fromisoformat(start.replace("Z", "+00:00"))
            except Exception:
                continue
        week = start.isocalendar()[1]
        year = start.year
        month = start.month
        wkey = f"{year}-W{week:02d}"
        mkey = f"{year}-{month:02d}"
        weekly[wkey]["trips"] += 1
        weekly[wkey]["distance"] += float(get_field(t, "distance") or 0)
        weekly[wkey]["hardBraking"] += int(
            get_field(
                t,
                "hardBrakingCounts",
                "hardBrakingCount",
            )
            or 0
        )
        weekly[wkey]["hardAccel"] += int(
            get_field(
                t,
                "hardAccelerationCounts",
                "hardAccelerationCount",
            )
            or 0
        )
        monthly[mkey]["trips"] += 1
        monthly[mkey]["distance"] += float(get_field(t, "distance") or 0)
        monthly[mkey]["hardBraking"] += int(
            get_field(
                t,
                "hardBrakingCounts",
                "hardBrakingCount",
            )
            or 0
        )
        monthly[mkey]["hardAccel"] += int(
            get_field(
                t,
                "hardAccelerationCounts",
                "hardAccelerationCount",
            )
            or 0
        )

    weekly_trend = [{"week": k, **v} for k, v in sorted(weekly.items())]
    monthly_trend = [{"month": k, **v} for k, v in sorted(monthly.items())]

    return {
        "totalTrips": total_trips,
        "totalDistance": total_distance,
        "avgSpeed": avg_speed,
        "maxSpeed": max_speed,
        "hardBrakingCounts": hard_braking,
        "hardAccelerationCounts": hard_accel,
        "totalIdlingTime": idling,
        "fuelConsumed": fuel,
        "weekly": weekly_trend,
        "monthly": monthly_trend,
    }


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
