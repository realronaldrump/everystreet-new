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
from datetime import datetime, timedelta, timezone
from math import ceil
from typing import List, Optional

# Third-party imports
import bson
import geojson as geojson_module
import gpxpy
import pytz
from bson import ObjectId
from dateutil import parser as dateutil_parser
from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from gridfs.errors import NoFile  # <-- Add this for error handling
from motor.motor_asyncio import AsyncIOMotorGridFSBucket  # <-- Add this

# Local module imports
from bouncie_trip_fetcher import fetch_bouncie_trips_in_range
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
    handle_bouncie_webhook,
    initialize_db,
)
from models import (
    BackgroundTasksConfigModel,
    BulkProcessModel,
    CollectionModel,
    DateRangeModel,
    LocationModel,
    TaskRunModel,
    TripUpdateModel,
    ValidateLocationModel,
)
from osm_utils import generate_geojson_osm
from tasks import (
    TASK_METADATA,
    TaskStatus,
    get_all_task_metadata,
    get_task_config,
    manual_run_task,
    update_task_schedule,
)
from trip_processor import TripProcessor, TripState
from update_geo_points import update_geo_points
from utils import calculate_distance, cleanup_session, validate_location_osm
from visits import init_collections
from visits import router as visits_router

# Load environment variables
load_dotenv()

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Initialize FastAPI app and mount static/template directories
app = FastAPI(title="Street Coverage Tracker")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Include routers
app.include_router(visits_router)

# Environment variables
CLIENT_ID = os.getenv("CLIENT_ID", "")
CLIENT_SECRET = os.getenv("CLIENT_SECRET", "")
REDIRECT_URI = os.getenv("REDIRECT_URI", "")
AUTH_CODE = os.getenv("AUTHORIZATION_CODE", "")
AUTHORIZED_DEVICES = [d for d in os.getenv("AUTHORIZED_DEVICES", "").split(",") if d]
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"

# Database collections - using db_manager to access the database
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

# Initialize live tracking module
initialize_db(live_trips_collection, archived_live_trips_collection)

# Initialize visits module
init_collections(places_collection, trips_collection)  # <-- Updated call


# Note: Pydantic models have been moved to models.py


# --- Coverage Calculation Orchestration ---


async def process_and_store_trip(trip: dict, source: str = "upload") -> None:
    """Process and store a trip using TripProcessor.

    Args:
        trip: Trip data dictionary
        source: The source of the trip ('upload', 'upload_gpx', 'upload_geojson')
    """
    try:
        # Set the source correctly when initializing the processor
        processor = TripProcessor(mapbox_token=MAPBOX_ACCESS_TOKEN, source=source)
        processor.set_trip_data(trip)

        # Ensure we have GPS data
        gps_data = trip.get("gps")
        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
                processor.processed_data["gps"] = gps_data
            except json.JSONDecodeError:
                logger.warning(
                    "Invalid GPS data for trip %s", trip.get("transactionId", "unknown")
                )
                return

        # Extract and geocode the locations
        await processor.process(do_map_match=False)
        # The save method now uses the source attribute to save to trips_collection
        await processor.save()

    except bson.errors.DuplicateKeyError:
        logger.warning("Duplicate trip ID %s; skipping.", trip.get("transactionId"))
    except Exception:
        logger.exception("process_and_store_trip error")
        raise


async def process_geojson_trip(geojson_data: dict) -> Optional[List[dict]]:
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
                "transaction_id", f"geojson-{int(datetime.now().timestamp())}"
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
                    "gps": json.dumps(trip_geo),
                    "distance": dist_miles,
                    "imei": "UPLOADED",
                    "source": "upload_geojson",  # <-- Set source
                }
            )
        return trips
    except Exception:
        logger.exception("Error in process_geojson_trip")
        return None


# MIDDLEWARE
@app.middleware("http")
async def add_header(request: Request, call_next):
    """Add cache control headers to all responses."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# BASIC PAGES
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


@app.get("/driving-insights", response_class=HTMLResponse)
async def driving_insights_page(request: Request):
    """Render driving insights page."""
    return templates.TemplateResponse("driving_insights.html", {"request": request})


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


@app.get("/coverage-management", response_class=HTMLResponse)
async def coverage_management_page(request: Request):
    """Render coverage management page."""
    return templates.TemplateResponse("coverage_management.html", {"request": request})


@app.get("/database-management")
async def database_management_page(request: Request):
    """Render database management page with statistics."""
    try:
        db_stats = await db_manager.db.command("dbStats")
        storage_used_mb = round(db_stats["dataSize"] / (1024 * 1024), 2)
        storage_limit_mb = 512  # Example free-tier limit
        storage_usage_percent = round((storage_used_mb / storage_limit_mb) * 100, 2)
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
                    "size_mb": round(stats["size"] / (1024 * 1024), 2),
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
        logger.exception("Error loading database management page: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.get("/app-settings", response_class=HTMLResponse)
async def app_settings_page(request: Request):
    """Render app settings page."""
    return templates.TemplateResponse("app_settings.html", {"request": request})


# UNDRIVEN STREETS API ENDPOINT
@app.post("/api/undriven_streets")
async def get_undriven_streets(location: LocationModel):
    """Get undriven streets for a specific location.

    Args:
        location: Location dictionary with display_name, osm_id, etc.

    Returns:
        GeoJSON with undriven streets features
    """
    location_name = "UNKNOWN"  # Default for logging
    try:
        location_name = location.display_name
        logger.info("Request received for undriven streets for '%s'.", location_name)

        # Find the coverage metadata for this location
        coverage_metadata = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
        )

        if not coverage_metadata:
            # Log the warning, FastAPI handles the response
            logger.warning(
                "No coverage metadata found for location: '%s'. Raising 404.",
                location_name,
            )
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No coverage data found for location: {location_name}",
            )

        # Query for undriven streets in this location
        query = {
            "properties.location": location_name,
            "properties.driven": False,
        }

        # Check count first for efficiency
        count = await count_documents_with_retry(streets_collection, query)
        logger.info(
            "Found %d undriven street documents for '%s'.", count, location_name
        )

        if count == 0:
            return JSONResponse(content={"type": "FeatureCollection", "features": []})

        # Fetch and structure features if count > 0
        features = []
        cursor = streets_collection.find(query)

        # Process cursor in batches
        async for street_batch in batch_cursor(cursor):
            for street_doc in street_batch:
                # Basic validation before adding
                if "geometry" in street_doc and "properties" in street_doc:
                    features.append(street_doc)

        # Use JSONResponse with bson.json_util for proper ObjectId serialization
        content_to_return = {"type": "FeatureCollection", "features": features}
        return JSONResponse(content=json.loads(bson.json_util.dumps(content_to_return)))

    except HTTPException as http_exc:
        # Log only the warning, FastAPI handles the response
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


# BACKGROUND TASKS CONFIG / CONTROL
@app.get("/api/background_tasks/config")
async def get_background_tasks_config():
    """Get the current configuration of background tasks."""
    try:
        config = await get_task_config()
        task_metadata = await get_all_task_metadata()

        # Ensure all tasks are properly represented
        for task_id, task_def in task_metadata.items():
            if task_id not in config["tasks"]:
                config["tasks"][task_id] = {}

            task_config = config["tasks"][task_id]
            task_config["display_name"] = task_def["display_name"]
            task_config["description"] = task_def["description"]
            task_config["priority"] = task_def["priority"].name
            task_config["status"] = task_config.get("status", "IDLE")
            task_config["interval_minutes"] = task_config.get(
                "interval_minutes", task_def["default_interval_minutes"]
            )

            # Format timestamp fields
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
                        if isinstance(task_config[ts_field], str)
                        else task_config[ts_field].isoformat()
                    )

        # Return the enhanced config
        return config
    except Exception as e:
        logger.exception("Error getting task configuration: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/background_tasks/config")
async def update_background_tasks_config(
    data: BackgroundTasksConfigModel,
):
    """Update the configuration of background tasks."""
    try:
        result = await update_task_schedule(data.dict(exclude_unset=True))

        if result["status"] == "error":
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result["message"],
            )

        return {"status": "success", "message": "Configuration updated"}

    except Exception as e:
        logger.exception("Error updating task configuration: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/background_tasks/pause")
async def pause_background_tasks(minutes: int = 30):
    """Pause all background tasks for a specified duration."""
    try:
        # Just set the global disabled flag
        await update_task_schedule({"globalDisable": True})

        return {
            "status": "success",
            "message": f"Background tasks paused for {minutes} minutes",
        }
    except Exception as e:
        logger.exception("Error pausing tasks: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/background_tasks/resume")
async def resume_background_tasks():
    """Resume all paused background tasks."""
    try:
        await update_task_schedule({"globalDisable": False})
        return {"status": "success", "message": "Background tasks resumed"}
    except Exception as e:
        logger.exception("Error resuming tasks: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/background_tasks/stop_all")
async def stop_all_background_tasks():
    """Stop all currently running background tasks."""
    try:
        # In Celery, we don't have a direct "stop all" but we can disable them
        await update_task_schedule({"globalDisable": True})
        return {"status": "success", "message": "All background tasks stopped"}
    except Exception as e:
        logger.exception("Error stopping all tasks: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/background_tasks/enable")
async def enable_all_background_tasks():
    """Enable all background tasks."""
    try:
        # No need to retrieve config as we're just setting all tasks to enabled
        tasks_update = {}

        for task_id in TASK_METADATA:
            tasks_update[task_id] = {"enabled": True}

        await update_task_schedule({"tasks": tasks_update})
        return {"status": "success", "message": "All background tasks enabled"}
    except Exception as e:
        logger.exception("Error enabling all tasks: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/background_tasks/disable")
async def disable_all_background_tasks():
    """Disable all background tasks."""
    try:
        # No need to retrieve config as we're just setting all tasks to disabled
        tasks_update = {}

        for task_id in TASK_METADATA:
            tasks_update[task_id] = {"enabled": False}

        await update_task_schedule({"tasks": tasks_update})
        return {"status": "success", "message": "All background tasks disabled"}
    except Exception as e:
        logger.exception("Error disabling all tasks: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/background_tasks/manual_run")
async def manually_run_tasks(data: TaskRunModel):
    """Manually trigger execution of specified tasks."""
    try:
        tasks_to_run = data.tasks

        if not tasks_to_run:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No tasks specified to run",
            )

        if "ALL" in tasks_to_run:
            result = await manual_run_task("ALL")
            if result["status"] == "success":
                return result
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result["message"],
            )
        else:
            results = []
            for task_id in tasks_to_run:
                if task_id in TASK_METADATA:
                    result = await manual_run_task(task_id)
                    results.append(
                        {
                            "task": task_id,
                            "success": result["status"] == "success",
                            "message": result["message"],
                            "task_id": result.get("task_id"),
                        }
                    )
                else:
                    results.append(
                        {
                            "task": task_id,
                            "success": False,
                            "message": "Unknown task",
                        }
                    )

            return {
                "status": "success",
                "message": f"Triggered {len(results)} tasks",
                "results": results,
            }

    except Exception as e:
        logger.exception("Error in manually_run_tasks: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


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

        # Get recent history
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
                "interval_minutes", task_def["default_interval_minutes"]
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
        logger.exception("Error getting task details for %s: %s", task_id, str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.get("/api/background_tasks/history")
async def get_task_history(page: int = 1, limit: int = 10):
    """Get paginated task execution history."""
    try:
        total_count = await count_documents_with_retry(task_history_collection, {})
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
            # Use SerializationHelper instead of serialize_datetime
            entry["timestamp"] = SerializationHelper.serialize_datetime(
                entry.get("timestamp")
            )
            if "runtime" in entry:
                entry["runtime"] = float(entry["runtime"]) if entry["runtime"] else None
            history.append(entry)

        return {
            "history": history,
            "total": total_count,
            "page": page,
            "limit": limit,
            "total_pages": ceil(total_count / limit),
        }
    except Exception as e:
        logger.exception("Error fetching task history: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
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
        logger.exception("Error clearing task history: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/background_tasks/reset")
async def reset_task_states():
    """Reset any stuck 'RUNNING' tasks to 'FAILED' state with safeguards."""
    try:
        now = datetime.now(timezone.utc)
        stuck_threshold = timedelta(
            hours=2
        )  # Consider tasks running over 2 hours as stuck
        reset_count = 0
        skipped_count = 0

        # Get current task configuration
        config = await get_task_config()
        tasks_config = config.get("tasks", {})

        # Identify actually stuck tasks
        updates = {}
        for task_id, task_info in tasks_config.items():
            if task_info.get("status") != TaskStatus.RUNNING.value:
                continue

            start_time = task_info.get("start_time")
            if not start_time:
                # No start time but status is RUNNING, consider it stuck
                updates[f"tasks.{task_id}.status"] = TaskStatus.FAILED.value
                updates[f"tasks.{task_id}.last_error"] = (
                    "Task reset: status was RUNNING but no start_time found"
                )
                updates[f"tasks.{task_id}.end_time"] = now
                reset_count += 1
                continue

            # Ensure start_time has timezone info
            if isinstance(start_time, str):
                try:
                    start_time = datetime.fromisoformat(
                        start_time.replace("Z", "+00:00")
                    )
                except ValueError:
                    start_time = datetime.strptime(start_time, "%Y-%m-%dT%H:%M:%S.%f")

            if start_time.tzinfo is None:
                start_time = start_time.replace(tzinfo=timezone.utc)

            # Check if task has been running too long
            runtime = now - start_time
            if runtime > stuck_threshold:
                # Task has been running too long, consider it stuck
                updates[f"tasks.{task_id}.status"] = TaskStatus.FAILED.value
                updates[f"tasks.{task_id}.last_error"] = (
                    f"Task reset: running for {runtime.total_seconds() / 3600:.2f} hours"
                )
                updates[f"tasks.{task_id}.end_time"] = now
                reset_count += 1
            else:
                # Task is running but not considered stuck yet
                logger.info(
                    "Task %s is running for %.2f minutes, not considered stuck",
                    task_id,
                    runtime.total_seconds() / 60,
                )
                skipped_count += 1

        # Also check for any history entries stuck in RUNNING state
        history_result = await update_many_with_retry(
            task_history_collection,
            {
                "status": TaskStatus.RUNNING.value,
                "start_time": {"$lt": now - stuck_threshold},
            },
            {
                "$set": {
                    "status": TaskStatus.FAILED.value,
                    "error": "Task reset: task history entry stuck in RUNNING state",
                    "end_time": now,
                }
            },
        )

        # Apply updates to task configuration
        if updates:
            await task_config_collection.update_one(
                {"_id": "global_background_task_config"}, {"$set": updates}
            )

        return {
            "status": "success",
            "message": f"Reset {reset_count} stuck tasks, skipped {skipped_count} running tasks",
            "reset_count": reset_count,
            "skipped_count": skipped_count,
            "history_reset_count": (
                history_result.modified_count if history_result else 0
            ),
        }
    except Exception as e:
        logger.exception("Error resetting task states: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.get("/api/background_tasks/sse")
async def background_tasks_sse(request: Request):
    """Provides server-sent events for real-time task status updates."""

    async def event_generator():
        try:
            while True:
                # Check if client disconnected
                if await request.is_disconnected():
                    logger.info("SSE client disconnected")
                    break

                # Get latest task config
                config = await get_task_config()

                # Format task status updates
                updates = {}
                for task_id, task_config in config.get("tasks", {}).items():
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

                # Send formatted update
                yield f"data: {json.dumps(updates)}\n\n"

                # Wait before checking again
                await asyncio.sleep(2)
        except asyncio.CancelledError:
            # Handle disconnection
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


# EDIT TRIPS ENDPOINTS
@app.get("/api/edit_trips")
async def get_edit_trips(
    request: Request, trip_type: str = Query(..., description="Type of trips to edit")
):
    """Get trips for editing."""
    try:
        if trip_type not in ["trips", "matched_trips"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid trip type"
            )

        query = await build_query_from_request(request)
        collection = (
            trips_collection if trip_type == "trips" else matched_trips_collection
        )

        trips = await find_with_retry(collection, query)
        # Use SerializationHelper instead of serialize_trip
        serialized_trips = [SerializationHelper.serialize_trip(trip) for trip in trips]

        return {"status": "success", "trips": serialized_trips}

    except Exception as e:
        logger.exception("Error fetching trips for editing: %s", str(e))
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

        # Get appropriate collection
        collection = (
            matched_trips_collection
            if trip_type == "matched_trips"
            else trips_collection
        )

        # Find trip in primary collection
        trip = await find_one_with_retry(
            collection,
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]},
        )

        # If not found, try the other collection (only matched_trips if primary was trips)
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

        # Prepare update fields
        update_fields = {"updatedAt": datetime.now(timezone.utc)}

        # Handle geometry update
        if geometry and isinstance(geometry, dict):
            gps_data = {"type": "LineString", "coordinates": geometry["coordinates"]}
            update_fields["geometry"] = geometry
            update_fields["gps"] = json.dumps(gps_data)

        # Handle properties update
        if props:
            # Parse datetime fields
            for field in ["startTime", "endTime"]:
                if field in props and isinstance(props[field], str):
                    try:
                        props[field] = dateutil_parser.isoparse(props[field])
                    except ValueError:
                        pass

            # Parse numeric fields
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

            # Update properties
            if "properties" in trip:
                updated_props = {**trip["properties"], **props}
                update_fields["properties"] = updated_props
            else:
                update_fields.update(props)

        # Perform update
        result = await update_one_with_retry(
            collection, {"_id": trip["_id"]}, {"$set": update_fields}
        )

        if not result.modified_count:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="No changes made"
            )

        return {"message": "Trip updated"}

    except Exception as e:
        logger.exception("Error updating trip %s: %s", trip_id, str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# STREET COVERAGE / COMPUTATIONS
@app.post("/api/street_coverage")
async def get_street_coverage(location: LocationModel):
    """Calculate street coverage for a location."""
    try:
        task_id = str(uuid.uuid4())
        asyncio.create_task(process_coverage_calculation(location.dict(), task_id))
        return {"task_id": task_id, "status": "processing"}
    except Exception as e:
        logger.exception("Error in street coverage calculation: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.get("/api/street_coverage/{task_id}")
async def get_coverage_status(task_id: str):
    """Get status of a coverage calculation task."""
    progress = await find_one_with_retry(progress_collection, {"_id": task_id})
    if not progress:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Task not found"
        )
    if progress.get("stage") == "error":
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=progress.get("error", "Unknown error"),
        )
    if progress.get("stage") == "complete":
        return progress.get("result")
    return {
        "stage": progress.get("stage", "unknown"),
        "progress": progress.get("progress", 0),
        "message": progress.get("message", ""),
    }


@app.post("/api/street_coverage/incremental")
async def get_incremental_street_coverage(location: LocationModel):
    """Update street coverage incrementally, processing only new trips since
    last update."""
    try:
        task_id = str(uuid.uuid4())
        asyncio.create_task(
            process_incremental_coverage_calculation(location.dict(), task_id)
        )
        return {"task_id": task_id, "status": "processing"}
    except Exception as e:
        logger.exception("Error in incremental street coverage calculation: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# TRIPS (REGULAR, UPLOADED)
@app.get("/api/trips")
async def get_trips(request: Request):
    """Get all trips as GeoJSON."""
    try:
        query = await build_query_from_request(request)

        # Fetch trips only from the main trips collection
        all_trips = await find_with_retry(trips_collection, query)
        features = []

        # Create a TripProcessor instance for formatting
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

                # Parse datetime fields
                if isinstance(st, str):
                    st = dateutil_parser.isoparse(st)
                if isinstance(et, str):
                    et = dateutil_parser.isoparse(et)
                if st.tzinfo is None:
                    st = st.replace(tzinfo=timezone.utc)
                if et.tzinfo is None:
                    et = et.replace(tzinfo=timezone.utc)

                # Parse GPS data
                geom = trip.get("gps")
                if isinstance(geom, str):
                    geom = geojson_module.loads(geom)

                # Create properties
                props = {
                    "transactionId": trip.get("transactionId", "??"),
                    "imei": trip.get("imei", "UPLOAD"),
                    "startTime": st.astimezone(timezone.utc).isoformat(),
                    "endTime": et.astimezone(timezone.utc).isoformat(),
                    "distance": float(trip.get("distance", 0)),
                    "timeZone": trip.get("timeZone", "America/Chicago"),
                    "maxSpeed": float(trip.get("maxSpeed", 0)),
                    "startLocation": trip.get("startLocation", "N/A"),
                    "destination": trip.get("destination", "N/A"),
                    "totalIdleDuration": trip.get("totalIdleDuration", 0),
                    "totalIdleDurationFormatted": processor.format_idle_time(
                        trip.get("totalIdleDuration", 0)
                    ),
                    "fuelConsumed": float(trip.get("fuelConsumed", 0)),
                    "source": trip.get("source", "unknown"),  # <-- Use source field
                    "hardBrakingCount": trip.get("hardBrakingCount"),
                    "hardAccelerationCount": trip.get("hardAccelerationCount"),
                    "startOdometer": trip.get("startOdometer"),
                    "endOdometer": trip.get("endOdometer"),
                    "averageSpeed": trip.get("averageSpeed"),
                }

                # Create GeoJSON feature
                feature = geojson_module.Feature(geometry=geom, properties=props)
                features.append(feature)
            except Exception as e:
                logger.exception(
                    "Error processing trip for transactionId: %s - %s",
                    trip.get("transactionId"),
                    str(e),
                )
                continue

        # Create FeatureCollection
        fc = geojson_module.FeatureCollection(features)
        return JSONResponse(content=fc)
    except Exception as e:
        logger.exception("Error in /api/trips endpoint: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve trips",
        )


@app.get("/api/driving-insights")
async def get_driving_insights(request: Request):
    """Get aggregated driving insights."""
    try:
        query = await build_query_from_request(request)

        # Pipeline for aggregation
        pipeline = [
            {"$match": query},
            {
                "$group": {
                    "_id": None,
                    "total_trips": {"$sum": 1},
                    "total_distance": {"$sum": {"$ifNull": ["$distance", 0]}},
                    "total_fuel_consumed": {"$sum": {"$ifNull": ["$fuelConsumed", 0]}},
                    "max_speed": {"$max": {"$ifNull": ["$maxSpeed", 0]}},
                    "total_idle_duration": {
                        "$sum": {"$ifNull": ["$totalIdleDuration", 0]}
                    },
                    "longest_trip_distance": {"$max": {"$ifNull": ["$distance", 0]}},
                }
            },
        ]

        # Query only the trips collection
        trips_result = await aggregate_with_retry(trips_collection, pipeline)

        # Pipeline for most visited destinations
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

        trips_mv = await aggregate_with_retry(trips_collection, pipeline_most_visited)

        # Combine results
        combined = {
            "total_trips": 0,
            "total_distance": 0.0,
            "total_fuel_consumed": 0.0,
            "max_speed": 0.0,
            "total_idle_duration": 0,
            "longest_trip_distance": 0.0,
            "most_visited": {},
        }

        # Process basic stats
        if trips_result and trips_result[0]:
            r = trips_result[0]
            combined["total_trips"] = r.get("total_trips", 0)
            combined["total_distance"] = r.get("total_distance", 0)
            combined["total_fuel_consumed"] = r.get("total_fuel_consumed", 0)
            combined["max_speed"] = r.get("max_speed", 0)
            combined["total_idle_duration"] = r.get("total_idle_duration", 0)
            combined["longest_trip_distance"] = r.get("longest_trip_distance", 0)

        # Process most visited
        if trips_mv and trips_mv[0]:
            best = trips_mv[0]
            combined["most_visited"] = {
                "_id": best["_id"],
                "count": best["count"],
                "isCustomPlace": best.get("isCustomPlace", False),
            }

        return JSONResponse(content=combined)
    except Exception as e:
        logger.exception("Error in get_driving_insights: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.get("/api/metrics")
async def get_metrics(request: Request):
    """Get trip metrics and statistics."""
    try:
        query = await build_query_from_request(request)

        trips_data = await find_with_retry(trips_collection, query)
        total_trips = len(trips_data)

        if not total_trips:
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

        # Calculate metrics
        total_distance = sum(t.get("distance", 0) for t in trips_data)
        avg_distance_val = (total_distance / total_trips) if total_trips > 0 else 0.0

        # Process start times
        start_times = []
        for t in trips_data:
            st = t.get("startTime")
            if isinstance(st, str):
                st = dateutil_parser.isoparse(st)
            if st and st.tzinfo is None:
                st = st.replace(tzinfo=timezone.utc)
            local_st = st.astimezone(pytz.timezone("America/Chicago")) if st else None
            if local_st:
                start_times.append(local_st.hour + local_st.minute / 60.0)

        avg_start_time_val = sum(start_times) / len(start_times) if start_times else 0
        hour = int(avg_start_time_val)
        minute = int((avg_start_time_val - hour) * 60)
        am_pm = "AM" if hour < 12 else "PM"
        if hour == 0:
            hour = 12
        elif hour > 12:
            hour -= 12

        # Calculate driving times
        driving_times = []
        for t in trips_data:
            s = t.get("startTime")
            e = t.get("endTime")
            if isinstance(s, str):
                s = dateutil_parser.isoparse(s)
            if isinstance(e, str):
                e = dateutil_parser.isoparse(e)
            if s and e and s < e:
                driving_times.append((e - s).total_seconds() / 60.0)

        avg_driving_minutes = (
            sum(driving_times) / len(driving_times) if driving_times else 0
        )
        avg_driving_h = int(avg_driving_minutes // 60)
        avg_driving_m = int(avg_driving_minutes % 60)

        total_driving_hours = sum(driving_times) / 60.0 if driving_times else 0
        avg_speed_val = (
            total_distance / total_driving_hours if total_driving_hours else 0
        )

        max_speed_val = max((t.get("maxSpeed", 0) for t in trips_data), default=0)

        # Return formatted metrics
        return JSONResponse(
            content={
                "total_trips": total_trips,
                "total_distance": f"{round(total_distance, 2)}",
                "avg_distance": f"{round(avg_distance_val, 2)}",
                "avg_start_time": f"{hour:02d}:{minute:02d} {am_pm}",
                "avg_driving_time": f"{avg_driving_h:02d}:{avg_driving_m:02d}",
                "avg_speed": f"{round(avg_speed_val, 2)}",
                "max_speed": f"{round(max_speed_val, 2)}",
            }
        )
    except Exception as e:
        logger.exception("Error in get_metrics: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/fetch_trips")
async def api_fetch_trips():
    """Fetch recent trips from Bouncie API."""
    try:
        # Find the most recent trip in the database
        last_trip = await find_one_with_retry(
            trips_collection,
            {"source": "bouncie"},
            sort=[("endTime", -1)],  # Filter by source
        )
        start_date = (
            last_trip["endTime"]
            if last_trip and last_trip.get("endTime")
            else datetime.now(timezone.utc)
            - timedelta(days=7)  # get last 7 days as backup if no recent trip
        )
        end_date = datetime.now(timezone.utc)
        logger.info("Fetching trips from %s to %s", start_date, end_date)
        # fetch_bouncie_trips_in_range will now save with source='bouncie'
        await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=False)
        return {"status": "success", "message": "New trips fetched & stored."}
    except Exception as e:
        logger.exception("Error fetching trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/fetch_trips_range")
async def api_fetch_trips_range(data: DateRangeModel):
    """Fetch trips from Bouncie API within a specific date range."""
    try:
        start_date = parse_query_date(data.start_date)
        end_date = parse_query_date(data.end_date, end_of_day=True)
        if not start_date or not end_date:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid date range."
            )
        # fetch_bouncie_trips_in_range will now save with source='bouncie'
        await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=False)
        return {"status": "success", "message": "Trips fetched & stored."}

    except Exception as e:
        logger.exception("Error fetching trips in range: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/fetch_trips_last_hour")
async def api_fetch_trips_last_hour():
    """Fetch trips from the last hour and perform map matching."""
    try:
        now_utc = datetime.now(timezone.utc)
        start_date = now_utc - timedelta(hours=1)
        # fetch_bouncie_trips_in_range will now save with source='bouncie'
        await fetch_bouncie_trips_in_range(start_date, now_utc, do_map_match=True)
        return {"status": "success", "message": "Hourly trip fetch completed."}
    except Exception as e:
        logger.exception("Error fetching trips from last hour: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# PROCESS TRIPS
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
        # Get the trip from the main collection
        trip = await get_trip_by_id(trip_id, trips_collection)

        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found"
            )

        # Determine source from the trip document itself
        source = trip.get("source", "unknown")  # Default if source field is missing

        # Create the processor with the correct source
        processor = TripProcessor(
            mapbox_token=MAPBOX_ACCESS_TOKEN,
            source=source,
        )
        processor.set_trip_data(trip)

        # Process based on options
        if validate_only:
            await processor.validate()
            processing_status = processor.get_processing_status()
            return {
                "status": "success",
                "processing_status": processing_status,
                "is_valid": processing_status["state"] == TripState.VALIDATED.value,
            }
        if geocode_only:
            await processor.validate()
            if processor.state == TripState.VALIDATED:
                await processor.process_basic()
                if processor.state == TripState.PROCESSED:
                    await processor.geocode()

            # Save and return status
            saved_id = await processor.save()
            processing_status = processor.get_processing_status()
            return {
                "status": "success",
                "processing_status": processing_status,
                "geocoded": processing_status["state"] == TripState.GEOCODED.value,
                "saved_id": saved_id,
            }
        # Full processing
        await processor.process(do_map_match=map_match)
        saved_id = await processor.save(map_match_result=map_match)
        processing_status = processor.get_processing_status()

        return {
            "status": "success",
            "processing_status": processing_status,
            "completed": processing_status["state"] == TripState.COMPLETED.value,
            "saved_id": saved_id,
        }

    except Exception as e:
        logger.exception("Error processing trip %s: %s", trip_id, str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/bulk_process_trips")
async def bulk_process_trips(data: BulkProcessModel):
    """Process multiple trips in bulk with configurable options."""
    try:
        query = data.query
        options = data.options
        limit = min(data.limit, 500)  # Cap at 500 for safety

        # Parse options
        do_validate = options.get("validate", True)
        do_geocode = options.get("geocode", True)
        do_map_match = options.get("map_match", False)

        # Always use trips_collection
        collection = trips_collection

        # Fetch trips
        trips = await find_with_retry(collection, query, limit=limit)

        if not trips:
            return {
                "status": "success",
                "message": "No trips found matching criteria",
                "count": 0,
            }

        # Process trips
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
                # Determine source from the trip document
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=MAPBOX_ACCESS_TOKEN,
                    source=source,
                )
                processor.set_trip_data(trip)

                # Run the appropriate processing steps based on options
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

                # Save the changes
                saved_id = await processor.save(map_match_result=do_map_match)
                if not saved_id:
                    results["failed"] += 1
            except Exception as e:
                logger.error(
                    "Error processing trip %s: %s", trip.get("transactionId"), str(e)
                )
                results["failed"] += 1

        return {
            "status": "success",
            "message": f"Processed {len(trips)} trips",
            "results": results,
        }
    except Exception as e:
        logger.exception("Error in bulk_process_trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# New endpoint to get trip processing status
@app.get("/api/trips/{trip_id}/status")
async def get_trip_status(trip_id: str):
    """Get detailed processing status for a trip."""
    try:
        # Get trip from the main collection
        trip = await get_trip_by_id(trip_id, trips_collection)

        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found"
            )

        # Create status summary
        status_info = {
            "transaction_id": trip_id,
            "collection": trips_collection.name,  # Always trips collection now
            "source": trip.get("source", "unknown"),  # Add source info
            "has_start_location": bool(trip.get("startLocation")),
            "has_destination": bool(trip.get("destination")),
            "has_matched_trip": await matched_trips_collection.find_one(
                {"transactionId": trip_id}
            )
            is not None,
            "processing_history": trip.get("processing_history", []),
            "validation_status": trip.get("validation_status", "unknown"),
            "validation_message": trip.get("validation_message", ""),
            # Use SerializationHelper for all datetime fields
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
        logger.exception("Error getting trip status for %s: %s", trip_id, str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# EXPORT ENDPOINTS
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
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.get("/export/gpx")
async def export_gpx(request: Request):
    """Export trips as GPX."""
    try:
        query = await build_query_from_request(request)
        trips = await find_with_retry(trips_collection, query)

        if not trips:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="No trips found."
            )

        return await export_gpx_response(trips, "trips")
    except Exception as e:
        logger.exception("Error exporting GPX: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# VALIDATION / OSM DATA
@app.post("/api/validate_location")
async def validate_location(data: ValidateLocationModel):
    """Validate a location using OpenStreetMap."""
    # Access data using dot notation from the model instance
    validated = await validate_location_osm(data.location, data.locationType)
    return validated


@app.post("/api/generate_geojson")
async def generate_geojson_endpoint(
    location: LocationModel, streets_only: bool = False
):
    """Generate GeoJSON for a location using the imported function."""
    # Now calls the imported function
    geojson_data, err = await generate_geojson_osm(location.dict(), streets_only)
    if geojson_data:
        return geojson_data
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST, detail=err or "Unknown error"
    )


# MAP MATCHING ENDPOINTS
@app.post("/api/map_match_trips")
async def map_match_trips_endpoint(
    trip_id: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
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
            query["startTime"] = {"$gte": parsed_start, "$lte": parsed_end}
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

        # Use the TripProcessor for map matching
        processed_count = 0
        failed_count = 0
        for trip in trips_list:
            try:
                # Determine source from trip data
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=MAPBOX_ACCESS_TOKEN, source=source
                )
                processor.set_trip_data(trip)
                await processor.process(do_map_match=True)
                result = await processor.save(map_match_result=True)

                if result:
                    processed_count += 1
                else:
                    failed_count += 1
                    logger.warning(
                        "Failed to save matched trip %s", trip.get("transactionId")
                    )
            except Exception as e:
                failed_count += 1
                logger.error(
                    "Error processing trip %s: %s", trip.get("transactionId"), str(e)
                )

        return {
            "status": "success",
            "message": f"Map matching completed: {processed_count} successful, {failed_count} failed.",
            "processed_count": processed_count,
            "failed_count": failed_count,
        }

    except Exception as e:
        logger.exception("Error in map_match_trips endpoint: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
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
                    mgps if isinstance(mgps, dict) else geojson_module.loads(mgps)
                )
                feature = geojson_module.Feature(
                    geometry=geometry_dict,
                    properties={
                        "transactionId": trip["transactionId"],
                        "imei": trip.get("imei", ""),
                        # Use SerializationHelper instead of serialize_datetime
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
                        # Add speed metrics for consistent display in popups
                        "maxSpeed": float(trip.get("maxSpeed", 0)),
                        "averageSpeed": (
                            float(trip.get("averageSpeed", 0))
                            if trip.get("averageSpeed") is not None
                            else None
                        ),
                        # Add any other relevant metrics that should be displayed consistently
                        "hardBrakingCount": trip.get("hardBrakingCount", 0),
                        "hardAccelerationCount": trip.get("hardAccelerationCount", 0),
                        "totalIdleDurationFormatted": trip.get(
                            "totalIdleDurationFormatted", None
                        ),
                        "source": trip.get("source", "unknown"),  # Add source
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
        logger.exception("Error in get_matched_trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/matched_trips/delete")
async def delete_matched_trips(data: DateRangeModel):
    """Delete matched trips within a date range."""
    try:
        start_date = parse_query_date(data.start_date)
        end_date = parse_query_date(data.end_date, end_of_day=True)
        interval_days = data.interval_days

        if not start_date or not end_date:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid date range"
            )

        total_deleted_count = 0
        if interval_days > 0:
            current_start = start_date
            while current_start < end_date:
                current_end = min(
                    current_start + timedelta(days=interval_days), end_date
                )
                result = await delete_many_with_retry(
                    matched_trips_collection,
                    {"startTime": {"$gte": current_start, "$lt": current_end}},
                )
                total_deleted_count += result.deleted_count
                current_start = current_end
        else:
            result = await delete_many_with_retry(
                matched_trips_collection,
                {"startTime": {"$gte": start_date, "$lte": end_date}},
            )
            total_deleted_count = result.deleted_count

        return {"status": "success", "deleted_count": total_deleted_count}
    except Exception as e:
        logger.exception("Error in delete_matched_trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error deleting matched trips: {e}",
        )


@app.post("/api/matched_trips/remap")
async def remap_matched_trips(data: Optional[DateRangeModel] = None):
    """Remap matched trips, optionally within a date range."""
    try:
        # If no data provided, create default model
        if not data:
            data = DateRangeModel(start_date="", end_date="", interval_days=0)

        if data.interval_days > 0:
            start_date = datetime.now(timezone.utc) - timedelta(days=data.interval_days)
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
            {"startTime": {"$gte": start_date, "$lte": end_date}},
        )

        trips_list = await find_with_retry(
            trips_collection, {"startTime": {"$gte": start_date, "$lte": end_date}}
        )

        processed_count = 0
        for trip in trips_list:
            try:
                # Determine source from trip data
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=MAPBOX_ACCESS_TOKEN, source=source
                )
                processor.set_trip_data(trip)
                await processor.process(do_map_match=True)
                await processor.save(map_match_result=True)
                processed_count += 1
            except Exception as e:
                logger.error(
                    "Error remapping trip %s: %s", trip.get("transactionId"), str(e)
                )

        return {
            "status": "success",
            "message": f"Re-matching completed. Processed {processed_count} trips.",
        }

    except Exception as e:
        logger.exception("Error in remap_matched_trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error re-matching trips: {e}",
        )


@app.get("/api/export/trip/{trip_id}")
async def export_single_trip(
    trip_id: str, fmt: str = Query("geojson", description="Export format")
):
    """Export a single trip by ID."""
    try:
        t = await find_one_with_retry(trips_collection, {"transactionId": trip_id})

        if not t:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found"
            )

        start_date = t.get("startTime")
        date_str = start_date.strftime("%Y%m%d") if start_date else "unknown_date"
        filename_base = f"trip_{trip_id}_{date_str}"

        return await create_export_response([t], fmt, filename_base)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    except Exception as e:
        logger.exception("Error exporting trip %s: %s", trip_id, str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.delete("/api/matched_trips/{trip_id}")
async def delete_matched_trip(trip_id: str):
    """Delete a single matched trip by ID."""
    try:
        result = await delete_one_with_retry(
            matched_trips_collection,
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]},
        )
        if result.deleted_count:
            return {"status": "success", "message": "Deleted matched trip"}

        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found"
        )
    except Exception as e:
        logger.exception("Error deleting matched trip %s: %s", trip_id, str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# COMBINED EXPORT ENDPOINTS
@app.get("/api/export/all_trips")
async def export_all_trips(fmt: str = Query("geojson", description="Export format")):
    """Export all trips in various formats."""
    try:
        # Fetch all trips from the single collection
        all_trips = await find_with_retry(trips_collection, {})

        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename_base = f"all_trips_{current_time}"

        if fmt == "json":
            return JSONResponse(
                content=json.loads(json.dumps(all_trips, default=default_serializer))
            )

        return await create_export_response(all_trips, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.exception("Error exporting all trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.get("/api/export/trips")
async def export_trips_within_range(
    request: Request, fmt: str = Query("geojson", description="Export format")
):
    """Export trips within a date range."""
    try:
        query = await build_query_from_request(request)

        # Check if date range is valid by checking if query has startTime filter
        if "startTime" not in query:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or missing date range",
            )

        # Use the utility functions from db.py, querying only trips_collection
        all_trips = await find_with_retry(trips_collection, query)

        # Create filename from date range
        date_range = extract_date_range_string(query)
        filename_base = f"trips_{date_range}"

        return await create_export_response(all_trips, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    except Exception as e:
        logger.exception("Error exporting trips within range: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.get("/api/export/matched_trips")
async def export_matched_trips_within_range(
    request: Request, fmt: str = Query("geojson", description="Export format")
):
    """Export matched trips within a date range."""
    try:
        query = await build_query_from_request(request)

        # Check if date range is valid by checking if query has startTime filter
        if "startTime" not in query:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or missing date range",
            )

        matched = await find_with_retry(matched_trips_collection, query)

        # Create filename from date range
        date_range = extract_date_range_string(query)
        filename_base = f"matched_trips_{date_range}"

        return await create_export_response(matched, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.exception("Error exporting matched trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.get("/api/export/streets")
async def export_streets(
    location: str = Query(..., description="Location data in JSON format"),
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

        # Use imported function
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
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.exception("Error exporting streets data: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.get("/api/export/boundary")
async def export_boundary(
    location: str = Query(..., description="Location data in JSON format"),
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

        # Use imported function
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
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    except Exception as e:
        logger.exception("Error exporting boundary data: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# PREPROCESS_STREETS / STREET SEGMENT
@app.post("/api/preprocess_streets")
async def preprocess_streets_route(location_data: LocationModel):
    """Preprocess streets data for a validated location received in the request
    body.

    Args:
        location_data: Validated location data matching LocationModel.
    """
    display_name = None  # Initialize display_name
    try:
        # The incoming location_data IS the validated location object
        validated_location_dict = location_data.dict()
        display_name = validated_location_dict.get("display_name")

        if not display_name:  # Basic check
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location data provided (missing display_name).",
            )

        # Check if already processing (using display_name as key)
        existing = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
        )
        if existing and existing.get("status") == "processing":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This area is already being processed",
            )

        # Update metadata, marking as processing
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": display_name},
            {
                "$set": {
                    "location": validated_location_dict,  # Store the validated object
                    "status": "processing",
                    "last_error": None,  # Clear previous errors
                    "last_updated": datetime.now(timezone.utc),
                    # Reset stats - process_area will update these later
                    "total_length": 0,
                    "driven_length": 0,
                    "coverage_percentage": 0,
                    "total_segments": 0,
                }
            },
            upsert=True,  # Create if not exists
        )

        # Start background task with the validated data
        task_id = str(uuid.uuid4())
        asyncio.create_task(process_area(validated_location_dict, task_id))
        return {"status": "success", "task_id": task_id}

    except Exception as e:  # Catch other potential errors
        logger.exception(
            "Error in preprocess_streets_route for %s: %s", display_name, e
        )
        # Attempt to mark status as error if possible
        try:
            if display_name:  # Check if display_name was set
                await coverage_metadata_collection.update_one(
                    {"location.display_name": display_name},
                    {"$set": {"status": "error", "last_error": str(e)}},
                )
        except Exception as db_err:
            logger.error(
                "Failed to update error status for %s: %s", display_name, db_err
            )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.get("/api/street_segment/{segment_id}")
async def get_street_segment_details(segment_id: str):
    """Get details for a specific street segment."""
    try:
        segment = await find_one_with_retry(
            streets_collection, {"properties.segment_id": segment_id}, {"_id": 0}
        )
        if not segment:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Segment not found"
            )
        return segment
    except Exception as e:
        logger.exception("Error fetching segment details: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# LAST TRIP POINT
@app.get("/api/last_trip_point")
async def get_last_trip_point():
    """Get coordinates of the last point in the most recent trip."""
    try:
        most_recent = await find_one_with_retry(
            trips_collection, {}, sort=[("endTime", -1)]
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
        logger.exception("Error get_last_trip_point: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve last trip point",
        )


# SINGLE TRIP GET/DELETE
@app.get("/api/trips/{trip_id}")
async def get_single_trip(trip_id: str):
    """Get a single trip by ID."""
    try:
        # Use get_trip_by_id targeting trips_collection
        trip = await get_trip_by_id(trip_id, trips_collection)

        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found"
            )

        return {"status": "success", "trip": SerializationHelper.serialize_trip(trip)}
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
        # Use get_trip_by_id targeting trips_collection
        trip = await get_trip_by_id(trip_id, trips_collection)

        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found"
            )

        # Delete the trip from the trips collection
        result = await delete_one_with_retry(
            trips_collection, {"transactionId": trip_id}
        )

        # Also delete from matched_trips if it exists there
        matched_delete_result = await delete_one_with_retry(
            matched_trips_collection, {"transactionId": trip_id}
        )

        if result.deleted_count == 1:
            return {
                "status": "success",
                "message": "Trip deleted successfully",
                "deleted_trips": result.deleted_count,
                "deleted_matched_trips": (
                    matched_delete_result.deleted_count if matched_delete_result else 0
                ),
            }

        # If deletion from trips_collection failed for some reason
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
        # Only query the trips collection
        earliest_trip = await find_one_with_retry(
            trips_collection, {}, sort=[("startTime", 1)]
        )

        if not earliest_trip or not earliest_trip.get("startTime"):
            now = datetime.now(timezone.utc)
            return {"first_trip_date": now.isoformat()}

        earliest_trip_date = earliest_trip["startTime"]
        if earliest_trip_date.tzinfo is None:
            earliest_trip_date = earliest_trip_date.replace(tzinfo=timezone.utc)

        return {
            "first_trip_date": SerializationHelper.serialize_datetime(
                earliest_trip_date
            )
        }
    except Exception as e:
        logger.exception("get_first_trip_date error: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# GPX / GEOJSON UPLOAD
@app.post("/api/upload_gpx")
async def upload_gpx_endpoint(files: List[UploadFile] = File(...)):
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

                            # Convert points to format expected by TripProcessor
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

                            # Use TripProcessor's classmethod to process the coordinates
                            # Set source to 'upload_gpx'
                            trip_data = await TripProcessor.process_from_coordinates(
                                coord_data,
                                start_time=st,
                                end_time=en,
                                transaction_id=f"GPX-{st.strftime('%Y%m%d%H%M%S')}-{filename}",
                                imei="UPLOADED",
                                source="upload_gpx",  # <-- Set source
                                mapbox_token=MAPBOX_ACCESS_TOKEN,
                            )

                            # Create a processor to save the trip data to trips_collection
                            processor = TripProcessor(
                                mapbox_token=MAPBOX_ACCESS_TOKEN,
                                source="upload_gpx",  # <-- Set source
                            )
                            processor.set_trip_data(trip_data)
                            await (
                                processor.save()
                            )  # save() method now handles saving to trips_collection
                            success_count += 1
                except Exception as gpx_err:
                    logger.error("Error processing GPX file %s: %s", filename, gpx_err)
                    continue  # Skip to next file

            elif filename.endswith(".geojson"):
                try:
                    data_geojson = json.loads(content)
                    trips_to_process = await process_geojson_trip(
                        data_geojson
                    )  # This now sets source='upload_geojson'
                    if trips_to_process:
                        for trip_dict in trips_to_process:
                            # Use process_and_store_trip which now takes source
                            await process_and_store_trip(
                                trip_dict, source="upload_geojson"
                            )
                            success_count += 1
                except json.JSONDecodeError:
                    logger.warning("Invalid GeoJSON: %s", filename)
                    continue
                except Exception as geojson_err:
                    logger.error(
                        "Error processing GeoJSON file %s: %s", filename, geojson_err
                    )
                    continue  # Skip to next file
            else:
                logger.warning("Skipping unhandled file extension: %s", filename)

        return {"status": "success", "message": f"{success_count} trips uploaded."}
    except Exception as e:
        logger.exception("Error upload_gpx: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/upload")
async def upload_files(files: List[UploadFile] = File(...)):
    """Upload GPX or GeoJSON files and process them into the trips
    collection."""
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
                            coords = [[p.longitude, p.latitude] for p in seg.points]
                            times = [p.time for p in seg.points if p.time]
                            if not times:
                                continue
                            st = min(times)
                            en = max(times)
                            trip_dict = {
                                "transactionId": f"GPX-{st.strftime('%Y%m%d%H%M%S')}-{filename}",  # Use more descriptive ID
                                "startTime": st,
                                "endTime": en,
                                "gps": json.dumps(
                                    {"type": "LineString", "coordinates": coords}
                                ),
                                "imei": "UPLOADED",
                                "distance": calculate_distance(coords),
                                "source": "upload_gpx",  # <-- Set source
                            }
                            # Use process_and_store_trip which now takes source
                            await process_and_store_trip(trip_dict, source="upload_gpx")
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
                    trips = await process_geojson_trip(
                        data_geojson
                    )  # This now sets source='upload_geojson'
                    if trips:
                        for t in trips:
                            # Use process_and_store_trip which now takes source
                            await process_and_store_trip(t, source="upload_geojson")
                            count += 1
                except json.JSONDecodeError:
                    logger.warning("Invalid geojson: %s", filename)
                    continue
                except Exception as geojson_err:
                    logger.error(
                        "Error processing GeoJSON file %s in /api/upload: %s",
                        filename,
                        geojson_err,
                    )
                    continue

        return {"status": "success", "message": f"Processed {count} trips"}
    except Exception as e:
        logger.exception("Error uploading files: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# TRIP ANALYTICS
@app.get("/api/trip-analytics")
async def get_trip_analytics(request: Request):
    """Get analytics on trips over time."""
    try:
        query = await build_query_from_request(request)

        # Check if date range is valid by checking if query has startTime filter
        if "startTime" not in query:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Missing date range"
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
                    daily_data[date_key] = {"distance": 0, "count": 0}
                daily_data[date_key]["distance"] += r["totalDistance"]
                daily_data[date_key]["count"] += r["tripCount"]
            return [
                {"date": d, "distance": v["distance"], "count": v["count"]}
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
            content={"daily_distances": daily_list, "time_distribution": hourly_list}
        )

    except Exception as e:
        logger.exception("Error trip analytics: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# GEOPOINT UPDATES / REGEOCODING
@app.post("/update_geo_points")
async def update_geo_points_route(collection_name: str):
    """Update geo points for all trips in a collection."""
    # Only allow 'trips' now
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
        logger.exception("Error in update_geo_points_route: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error updating GeoPoints: {e}",
        )


@app.post("/api/regeocode_all_trips")
async def regeocode_all_trips():
    """Regeocode all trips in the database."""
    try:
        # Only process the trips collection
        collection = trips_collection
        trips_list = await find_with_retry(collection, {})
        for trip in trips_list:
            try:
                # Determine source from trip data
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
                continue  # Continue with the next trip

        return {"message": "All trips re-geocoded successfully."}
    except Exception as e:
        logger.exception("Error in regeocode_all_trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error re-geocoding trips: {e}",
        )


@app.post("/api/trips/refresh_geocoding")
async def refresh_geocoding_for_trips(trip_ids: List[str]):
    """Refresh geocoding for specific trips."""
    if not trip_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="No trip_ids provided"
        )

    updated_count = 0
    failed_count = 0
    for trip_id in trip_ids:
        try:
            trip = await find_one_with_retry(
                trips_collection, {"transactionId": trip_id}
            )
            if trip:
                # Determine source from trip data
                source = trip.get("source", "unknown")
                processor = TripProcessor(
                    mapbox_token=MAPBOX_ACCESS_TOKEN, source=source
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
                logger.warning("Trip not found for geocoding refresh: %s", trip_id)
                failed_count += 1
        except Exception as e:
            logger.error("Error refreshing geocoding for trip %s: %s", trip_id, str(e))
            failed_count += 1

    return {
        "message": f"Geocoding refreshed for {updated_count} trips. Failed: {failed_count}",
        "updated_count": updated_count,
        "failed_count": failed_count,
    }


# REAL-TIME / BOUNCIE WEBHOOK
@app.post("/webhook/bouncie")
async def bouncie_webhook(request: Request):
    """Handle Bouncie webhook data."""
    data = await request.json()
    return await handle_bouncie_webhook(data)


@app.get("/api/active_trip")
async def active_trip_endpoint():
    """Get the currently active trip, if any."""
    try:
        logger.info("Fetching active trip data")
        active_trip = await get_active_trip()

        if not active_trip:
            logger.info("No active trip found")
            return {
                "status": "success",
                "has_active_trip": False,
                "message": "No active trip",
                "server_time": datetime.now(timezone.utc).isoformat(),
            }

        logger.info(
            "Returning active trip: %s", active_trip.get("transactionId", "unknown")
        )
        return {
            "status": "success",
            "has_active_trip": True,
            "trip": active_trip,
            "server_time": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as e:
        error_id = str(uuid.uuid4())
        logger.exception("Error in get_active_trip endpoint [%s]: %s", error_id, str(e))
        return {
            "status": "error",
            "has_active_trip": False,
            "message": f"Error retrieving active trip: {str(e)}",
            "error_id": error_id,
            "server_time": datetime.now(timezone.utc).isoformat(),
        }


@app.get("/api/trip_updates")
async def trip_updates_endpoint(last_sequence: int = Query(0, ge=0)):
    """Get trip updates since a specific sequence number.

    Args:
        last_sequence: Only return updates newer than this sequence

    Returns:
        Dict: Contains status, has_update flag, and trip data if available
    """
    try:
        logger.info("Fetching trip updates since sequence %d", last_sequence)

        # Check if database connection is healthy
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
            logger.info("No trip updates found since sequence %d", last_sequence)

        # Add server timestamp to response
        updates["server_time"] = datetime.now(timezone.utc).isoformat()
        return updates

    except Exception as e:
        error_id = str(uuid.uuid4())
        logger.exception("Error in trip_updates endpoint [%s]: %s", error_id, str(e))

        # Categorize errors
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


# DATABASE MANAGEMENT ENDPOINTS


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
        logger.exception("Error clearing collection: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# COVERAGE AREA MANAGEMENT
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
                    "total_length": area.get("total_length", 0),
                    "driven_length": area.get("driven_length", 0),
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
        logger.error("Error fetching coverage areas: %s", str(e))
        return {"success": False, "error": str(e)}


@app.post("/api/coverage_areas/delete")
async def delete_coverage_area(location: LocationModel):
    """Delete a coverage area."""
    try:
        display_name = location.display_name
        if not display_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid location display name",
            )

        delete_result = await delete_one_with_retry(
            coverage_metadata_collection, {"location.display_name": display_name}
        )

        await delete_many_with_retry(
            streets_collection, {"properties.location": display_name}
        )

        if delete_result.deleted_count == 0:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Coverage area not found",
            )

        return {"status": "success", "message": "Coverage area deleted successfully"}

    except Exception as e:
        logger.exception("Error deleting coverage area: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.post("/api/coverage_areas/cancel")
async def cancel_coverage_area(location: LocationModel):
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

        return {"status": "success", "message": "Coverage area processing canceled"}

    except Exception as e:
        logger.exception("Error canceling coverage area: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@app.get("/api/database/storage-info")
async def get_storage_info():
    """Get database storage usage information."""
    try:
        # Use the check_quota method which is already designed to be reliable
        used_mb, limit_mb = await db_manager.check_quota()

        if used_mb is None or limit_mb is None:
            # Fallback values if we couldn't get the data
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
        logger.exception("Error getting storage info: %s", str(e))
        # Return a sensible fallback value rather than raising an error
        return {"used_mb": 0, "limit_mb": 512, "usage_percent": 0, "error": str(e)}


@app.get("/api/coverage_areas/{location_id}")
async def get_coverage_area_details(location_id: str):
    """Get detailed information about a coverage area, fetching GeoJSON from
    GridFS."""
    try:
        # Find the coverage data (existing logic is fine)
        coverage_doc = None
        try:
            coverage_doc = await find_one_with_retry(
                coverage_metadata_collection, {"_id": ObjectId(location_id)}
            )
        except Exception:
            coverage_doc = await find_one_with_retry(
                coverage_metadata_collection, {"location.display_name": location_id}
            )

        if not coverage_doc:
            logger.error("Coverage area not found for id: %s", location_id)
            # Return success=False for consistency with other error paths
            raise HTTPException(
                status_code=404, detail="Coverage area not found"
            )  # More standard

        # Extract basic info (existing logic is fine)
        location_name = coverage_doc.get("location", {}).get("display_name", "Unknown")
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
        needs_reprocessing = True  # Default to true unless GridFS data is loaded
        gridfs_id = coverage_doc.get(
            "streets_geojson_gridfs_id"
        )  # Get the GridFS ID field

        if gridfs_id:
            try:
                # Get GridFS bucket instance (can be done here or globally)
                fs = AsyncIOMotorGridFSBucket(db_manager.db)
                # Open download stream by ID
                gridfs_stream = await fs.open_download_stream(gridfs_id)
                # Read the data
                geojson_data_bytes = await gridfs_stream.read()
                # Deserialize
                streets_geojson = json.loads(geojson_data_bytes.decode("utf-8"))
                # Validate basic structure
                if isinstance(streets_geojson, dict) and isinstance(
                    streets_geojson.get("features"), list
                ):
                    total_streets = len(streets_geojson.get("features", []))
                    needs_reprocessing = False  # Successfully loaded
                    logger.info(
                        "Successfully loaded GeoJSON from GridFS for %s", location_name
                    )
                else:
                    logger.error(
                        "Invalid GeoJSON structure loaded from GridFS for %s (ID: %s)",
                        location_name,
                        gridfs_id,
                    )
                    streets_geojson = {}  # Reset on invalid structure
            except NoFile:
                logger.error(
                    "GridFS file not found for ID %s (Location: %s)",
                    gridfs_id,
                    location_name,
                )
                # Keep streets_geojson empty, needs_reprocessing remains True
            except Exception as gridfs_err:
                logger.error(
                    "Error reading GeoJSON from GridFS ID %s for %s: %s",
                    gridfs_id,
                    location_name,
                    gridfs_err,
                )
                # Keep streets_geojson empty, needs_reprocessing remains True
        else:
            logger.warning(
                "No streets_geojson_gridfs_id found for location: %s", location_name
            )
            # Keep streets_geojson empty, needs_reprocessing remains True

        # Get street types (existing logic is fine, but might run unnecessarily if GeoJSON failed)
        street_types = coverage_doc.get("street_types", [])
        if not street_types and not needs_reprocessing:  # Only compute if we have data
            street_types = collect_street_type_stats(
                streets_geojson.get("features", [])
            )

        # Construct the final result
        result = {
            "success": True,
            "coverage": {
                "location_name": location_name,
                "location": location_obj,
                "total_length": total_length,
                "driven_length": driven_length,
                "coverage_percentage": coverage_percentage,
                "last_updated": last_updated,
                "total_streets": total_streets,  # Updated based on loaded data
                "streets_geojson": streets_geojson,  # Contains loaded data or {}
                "street_types": street_types,
                "status": status,
                "has_error": status == "error",
                "error_message": last_error if status == "error" else None,
                "needs_reprocessing": needs_reprocessing,  # Indicates if GeoJSON is missing/failed
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
            detail=f"Internal server error fetching coverage details: {str(e)}",
        )


@app.get("/api/export/advanced")
async def export_advanced(
    request: Request,
    include_trips: bool = Query(
        True, description="Include regular trips (now all trips)"
    ),
    include_matched_trips: bool = Query(True, description="Include map-matched trips"),
    include_basic_info: bool = Query(True, description="Include basic trip info"),
    include_locations: bool = Query(True, description="Include location info"),
    include_telemetry: bool = Query(True, description="Include telemetry data"),
    include_geometry: bool = Query(True, description="Include geometry data"),
    include_meta: bool = Query(True, description="Include metadata"),
    include_custom: bool = Query(True, description="Include custom fields"),
    include_gps_in_csv: bool = Query(False, description="Include GPS in CSV export"),
    flatten_location_fields: bool = Query(
        True, description="Flatten location fields in CSV"
    ),
    fmt: str = Query("json", description="Export format"),
):
    """Advanced configurable export for trips data.

    Allows fine-grained control over data sources, fields to include, date
    range, and export format.
    """
    try:
        # Get date filtering
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")

        # Prepare date filter if dates provided
        date_filter = None
        if start_date_str and end_date_str:
            start_date = parse_query_date(start_date_str)
            end_date = parse_query_date(end_date_str, end_of_day=True)
            if start_date and end_date:
                date_filter = {"startTime": {"$gte": start_date, "$lte": end_date}}

        # Fetch trips based on selected data sources
        trips = []

        # Get trips from the main trips collection
        if include_trips:
            query = date_filter or {}
            regular_trips = await find_with_retry(trips_collection, query)

            # Process each trip based on field preferences
            for trip in regular_trips:
                # Use imported function
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
                    # Use the source field from the document
                    processed_trip["trip_type"] = trip.get("source", "unknown")
                    trips.append(processed_trip)

        # Get trips from map-matched trips collection
        if include_matched_trips:
            query = date_filter or {}
            matched_trips = await find_with_retry(matched_trips_collection, query)

            # Process each matched trip based on field preferences
            for trip in matched_trips:
                # Use imported function
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

        # Format timestamp for filename
        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename_base = f"trips_export_{current_time}"

        # If CSV format is requested, build the CSV data
        if fmt == "csv":
            # Use imported function
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

        # If JSON format is requested, return JSON data directly
        if fmt == "json":
            return JSONResponse(
                content=json.loads(json.dumps(trips, default=default_serializer))
            )

        # For other formats (GeoJSON, GPX, Shapefile), use the existing export response creator
        return await create_export_response(
            trips,
            fmt,
            filename_base,
            include_gps_in_csv=include_gps_in_csv,
            flatten_location_fields=flatten_location_fields,
        )
    except ValueError as e:
        logger.error("Export error: %s", str(e))
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    except Exception as e:
        logger.error("Error in advanced export: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Export failed: {str(e)}",
        )


# APPLICATION LIFECYCLE
@app.on_event("startup")
async def startup_event():
    """Initialize database indexes and components on application startup."""
    try:
        # Initialize database with all required collections and indexes
        await init_database()  # Comprehensive database initialization
        logger.info("Database initialized successfully.")

        # Initialize TripProcessor settings
        # This is just a dummy initialization to pre-load the module
        TripProcessor(mapbox_token=MAPBOX_ACCESS_TOKEN)
        logger.info("TripProcessor initialized.")

        # Additional initialization
        used_mb, limit_mb = await db_manager.check_quota()
        if not db_manager.quota_exceeded:
            logger.info("Application startup completed successfully")
        else:
            logger.warning(
                "Application started in limited mode due to exceeded storage quota (%.2f MB / %d MB)",
                used_mb,
                limit_mb,
            )
    except Exception as e:
        logger.exception("Failed to initialize database indexes: %s", str(e))
        raise  # Crash the application; we can't continue without indexes.


@app.on_event("shutdown")
async def shutdown_event():
    """Clean up resources when shutting down."""
    # Close database connections to free memory
    await db_manager.cleanup_connections()

    # Clean up HTTP sessions
    await cleanup_session()

    logger.info("Application shutdown completed successfully")


# ERROR HANDLERS
@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    """Handle 404 Not Found errors."""
    return JSONResponse(
        status_code=status.HTTP_404_NOT_FOUND, content={"error": "Endpoint not found"}
    )


@app.exception_handler(500)
async def internal_error_handler(request: Request, exc):
    """Handle 500 Internal Server Error errors."""
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"error": "Internal server error"},
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run("app:app", host="0.0.0.0", port=port, log_level="info", reload=True)
