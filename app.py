import os
import json
import logging
import asyncio
import io
import uuid
from datetime import datetime, timedelta, timezone
from math import ceil
from typing import List, Dict, Any, Optional
from collections import defaultdict

# Third-party imports
import aiohttp
import geopandas as gpd
import geojson as geojson_module
import gpxpy
import pytz
from bson import ObjectId
import bson
from dateutil import parser as dateutil_parser
from dotenv import load_dotenv
from shapely.geometry import LineString, Polygon, shape
from fastapi import FastAPI, Request, HTTPException, UploadFile, File
from fastapi.templating import Jinja2Templates
from fastapi.responses import JSONResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import google.generativeai as genai

# Local module imports
from update_geo_points import update_geo_points
from utils import (
    validate_location_osm,
    cleanup_session,
    haversine as haversine_util,
)
from trip_processor import TripProcessor, TripState
from bouncie_trip_fetcher import fetch_bouncie_trips_in_range
from preprocess_streets import preprocess_streets as async_preprocess_streets
from tasks import (
    TaskStatus,
    manual_run_task,
    get_task_config,
    update_task_schedule,
    get_all_task_metadata,
    TASK_METADATA,
)


from db import (
    db_manager,
    DatabaseManager,
    SerializationHelper,
    update_many_with_retry,
    find_one_with_retry,
    find_with_retry,
    update_one_with_retry,
    insert_one_with_retry,
    delete_one_with_retry,
    delete_many_with_retry,
    aggregate_with_retry,
    count_documents_with_retry,
    get_trip_from_all_collections,
    parse_query_date,
    build_query_from_request,
    init_database,
)

from export_helpers import (
    create_export_response,
    default_serializer,
    export_geojson_response,
    export_gpx_response,
    extract_date_range_string,
    get_location_filename,
)

from street_coverage_calculation import (
    compute_coverage_for_location,
    compute_incremental_coverage,
)
from live_tracking import (
    initialize_db,
    handle_bouncie_webhook,
    get_active_trip,
    get_trip_updates,
)

load_dotenv()

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Initialize FastAPI app and mount static/template directories
app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Environment variables
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_CODE = os.getenv("AUTHORIZATION_CODE")
AUTHORIZED_DEVICES = [d for d in os.getenv("AUTHORIZED_DEVICES", "").split(",") if d]
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"
OVERPASS_URL = "http://overpass-api.de/api/interpreter"

# Database collections - using db_manager to access the database
trips_collection = db_manager.db["trips"]
matched_trips_collection = db_manager.db["matched_trips"]
uploaded_trips_collection = db_manager.db["uploaded_trips"]
places_collection = db_manager.db["places"]
osm_data_collection = db_manager.db["osm_data"]
streets_collection = db_manager.db["streets"]
coverage_metadata_collection = db_manager.db["coverage_metadata"]
live_trips_collection = db_manager.db["live_trips"]
archived_live_trips_collection = db_manager.db["archived_live_trips"]
task_config_collection = db_manager.db["task_config"]
task_history_collection = db_manager.db["task_history"]
progress_collection = db_manager.db["progress_status"]

# Initialize live tracking module
initialize_db(live_trips_collection, archived_live_trips_collection)


# Custom Place Class


class CustomPlace:
    """
    A utility class for user-defined places.
    """

    def __init__(
        self, name: str, geometry: dict, created_at: Optional[datetime] = None
    ):
        self.name = name
        self.geometry = geometry
        self.created_at = created_at or datetime.now(timezone.utc)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "geometry": self.geometry,
            "created_at": self.created_at.isoformat(),
        }

    @staticmethod
    def from_dict(data: dict) -> "CustomPlace":
        created_raw = data.get("created_at")
        if isinstance(created_raw, str):
            created = datetime.fromisoformat(created_raw)
        elif isinstance(created_raw, datetime):
            created = created_raw
        else:
            created = datetime.now(timezone.utc)
        return CustomPlace(
            name=data["name"], geometry=data["geometry"], created_at=created
        )


# BASIC PAGES


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/trips", response_class=HTMLResponse)
async def trips_page(request: Request):
    return templates.TemplateResponse("trips.html", {"request": request})


@app.get("/edit_trips", response_class=HTMLResponse)
async def edit_trips_page(request: Request):
    return templates.TemplateResponse("edit_trips.html", {"request": request})


@app.get("/settings", response_class=HTMLResponse)
async def settings_page(request: Request):
    return templates.TemplateResponse("settings.html", {"request": request})


@app.get("/driving-insights", response_class=HTMLResponse)
async def driving_insights_page(request: Request):
    return templates.TemplateResponse("driving_insights.html", {"request": request})


@app.get("/visits", response_class=HTMLResponse)
async def visits_page(request: Request):
    return templates.TemplateResponse("visits.html", {"request": request})


@app.get("/export", response_class=HTMLResponse)
async def export_page(request: Request):
    return templates.TemplateResponse("export.html", {"request": request})


@app.get("/upload", response_class=HTMLResponse)
async def upload_page(request: Request):
    return templates.TemplateResponse("upload.html", {"request": request})


@app.get("/coverage-management", response_class=HTMLResponse)
async def coverage_management_page(request: Request):
    return templates.TemplateResponse("coverage_management.html", {"request": request})


@app.get("/database-management")
async def database_management_page(request: Request):
    try:
        db_stats = await db_manager.db.command("dbStats")
        storage_used_mb = round(db_stats["dataSize"] / (1024 * 1024), 2)
        storage_limit_mb = 512  # Example free-tier limit
        storage_usage_percent = round((storage_used_mb / storage_limit_mb) * 100, 2)
        collections_info = []
        for collection_name in await db_manager.db.list_collection_names():
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
        logger.exception("Error loading database management page.")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/app-settings", response_class=HTMLResponse)
async def app_settings_page(request: Request):
    return templates.TemplateResponse("app_settings.html", {"request": request})


# MIDDLEWARE


@app.middleware("http")
async def add_header(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# BACKGROUND TASKS CONFIG / CONTROL


# Updated API endpoints for background tasks in app.py


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
        logger.exception("Error getting task configuration.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/config")
async def update_background_tasks_config(request: Request):
    """Update the configuration of background tasks."""
    try:
        data = await request.json()
        result = await update_task_schedule(data)

        if result["status"] == "error":
            raise HTTPException(status_code=500, detail=result["message"])

        return {"status": "success", "message": "Configuration updated"}
    except Exception as e:
        logger.exception("Error updating task configuration.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/pause")
async def pause_background_tasks(request: Request):
    """Pause all background tasks for a specified duration."""
    try:
        data = await request.json()
        minutes = data.get("minutes", 30)

        # Just set the global disabled flag
        await update_task_schedule({"globalDisable": True})

        return {
            "status": "success",
            "message": f"Background tasks paused for {minutes} minutes",
        }
    except Exception as e:
        logger.exception("Error pausing tasks.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/resume")
async def resume_background_tasks():
    """Resume all paused background tasks."""
    try:
        await update_task_schedule({"globalDisable": False})
        return {"status": "success", "message": "Background tasks resumed"}
    except Exception as e:
        logger.exception("Error resuming tasks.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/stop_all")
async def stop_all_background_tasks():
    """Stop all currently running background tasks."""
    try:
        # In Celery, we don't have a direct "stop all" but we can disable them
        await update_task_schedule({"globalDisable": True})
        return {"status": "success", "message": "All background tasks stopped"}
    except Exception as e:
        logger.exception("Error stopping all tasks.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/enable")
async def enable_all_background_tasks():
    """Enable all background tasks."""
    try:
        # No need to retrieve config as we're just setting all tasks to disabled
        tasks_update = {}

        for task_id in TASK_METADATA:
            tasks_update[task_id] = {"enabled": True}

        await update_task_schedule({"tasks": tasks_update})
        return {"status": "success", "message": "All background tasks enabled"}
    except Exception as e:
        logger.exception("Error enabling all tasks.")
        raise HTTPException(status_code=500, detail=str(e))


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
        logger.exception("Error disabling all tasks.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/manual_run")
async def manually_run_tasks(request: Request):
    """Manually trigger execution of specified tasks."""
    try:
        data = await request.json()
        tasks_to_run = data.get("tasks", [])

        if not tasks_to_run:
            raise HTTPException(status_code=400, detail="No tasks specified to run")

        if "ALL" in tasks_to_run:
            result = await manual_run_task("ALL")
            if result["status"] == "success":
                return result
            else:
                raise HTTPException(status_code=500, detail=result["message"])
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
        logger.exception("Error in manually_run_tasks")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/background_tasks/task/{task_id}")
async def get_task_details(task_id: str):
    """Get detailed information about a specific task."""
    try:
        if task_id not in TASK_METADATA:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")

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
        logger.exception(f"Error getting task details for {task_id}")
        raise HTTPException(status_code=500, detail=str(e))


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
        logger.exception("Error fetching task history.")
        raise HTTPException(status_code=500, detail=str(e))


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
        logger.exception("Error clearing task history.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/reset")
async def reset_task_states():
    """
    Reset any stuck 'RUNNING' tasks to 'FAILED' state with safeguards.
    """
    try:
        now = datetime.now(timezone.utc)
        stuck_threshold = timedelta(hours=2)  # Consider tasks running over 2 hours as stuck
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
                updates[f"tasks.{task_id}.last_error"] = "Task reset: status was RUNNING but no start_time found"
                updates[f"tasks.{task_id}.end_time"] = now
                reset_count += 1
                continue
                
            # Ensure start_time has timezone info
            if start_time.tzinfo is None:
                start_time = start_time.replace(tzinfo=timezone.utc)
                
            # Check if task has been running too long
            runtime = now - start_time
            if runtime > stuck_threshold:
                # Task has been running too long, consider it stuck
                updates[f"tasks.{task_id}.status"] = TaskStatus.FAILED.value
                updates[f"tasks.{task_id}.last_error"] = f"Task reset: running for {runtime.total_seconds()/3600:.2f} hours"
                updates[f"tasks.{task_id}.end_time"] = now
                reset_count += 1
            else:
                # Task is running but not considered stuck yet
                logger.info(f"Task {task_id} is running for {runtime.total_seconds()/60:.2f} minutes, not considered stuck")
                skipped_count += 1

        # Also check for any history entries stuck in RUNNING state
        history_result = await update_many_with_retry(
            task_history_collection,
            {
                "status": TaskStatus.RUNNING.value,
                "start_time": {"$lt": now - stuck_threshold}
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
            "history_reset_count": history_result.modified_count if history_result else 0
        }
    except Exception as e:
        logger.exception("Error resetting task states")
        raise HTTPException(status_code=500, detail=str(e))


# EDIT TRIPS ENDPOINTS


@app.get("/api/edit_trips")
async def get_edit_trips(request: Request):
    try:
        query = await build_query_from_request(request)
        trip_type = request.query_params.get("type")

        if not trip_type or trip_type not in ["trips", "matched_trips"]:
            raise HTTPException(status_code=400, detail="Invalid trip type")

        collection = (
            trips_collection if trip_type == "trips" else matched_trips_collection
        )

        trips = await find_with_retry(collection, query)
        # Use SerializationHelper instead of serialize_trip
        serialized_trips = [SerializationHelper.serialize_trip(trip) for trip in trips]

        return {"status": "success", "trips": serialized_trips}
    except Exception:
        logger.exception("Error fetching trips for editing.")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/background_tasks/sse")
async def background_tasks_sse(request: Request):
    """
    Provides server-sent events for real-time task status updates.
    """
    async def event_generator():
        try:
            while True:
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
            logger.error(f"Error in SSE generator: {e}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )

@app.put("/api/trips/{trip_id}")
async def update_trip(trip_id: str, request: Request):
    try:
        data = await request.json()
        trip_type = data.get("type")
        geometry = data.get("geometry")
        props = data.get("properties", {})

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

        # If not found, try the other collection
        if not trip:
            other_collection = (
                trips_collection
                if trip_type == "matched_trips"
                else matched_trips_collection
            )
            trip = await find_one_with_retry(
                other_collection,
                {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]},
            )
            if trip:
                collection = other_collection

        if not trip:
            raise HTTPException(status_code=404, detail=f"No trip found for {trip_id}")

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
            for field in ["distance", "maxSpeed", "totalIdleDuration", "fuelConsumed"]:
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
            raise HTTPException(status_code=400, detail="No changes made")

        return {"message": "Trip updated"}
    except Exception as e:
        logger.exception("Error updating trip %s", trip_id)
        raise HTTPException(status_code=500, detail=str(e))


# STREET COVERAGE / COMPUTATIONS


@app.post("/api/street_coverage")
async def get_street_coverage(request: Request):
    try:
        data = await request.json()
        location = data.get("location")
        if not location or not isinstance(location, dict):
            raise HTTPException(status_code=400, detail="Invalid location data.")
        task_id = str(uuid.uuid4())
        asyncio.create_task(process_coverage_calculation(location, task_id))
        return {"task_id": task_id, "status": "processing"}
    except Exception as e:
        logger.exception("Error in street coverage calculation.")
        raise HTTPException(status_code=500, detail=str(e))


async def process_coverage_calculation(location: Dict[str, Any], task_id: str):
    """
    Process coverage calculation in the background with proper error handling.
    Updates progress information and handles failures.
    """
    try:
        # Initialize progress tracking
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "initializing",
                    "progress": 0,
                    "message": "Starting coverage calculation...",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )

        # Run the calculation
        result = await compute_coverage_for_location(location, task_id)
        display_name = location.get("display_name", "Unknown")

        if result:
            # Check if streets_data exists
            if not result.get("streets_data") or not result["streets_data"].get(
                "features"
            ):
                logger.error(
                    f"No streets_data in calculation results for {display_name}"
                )

                # Update progress with error
                await progress_collection.update_one(
                    {"_id": task_id},
                    {
                        "$set": {
                            "stage": "error",
                            "progress": 0,
                            "message": "No street data found for location",
                            "updated_at": datetime.now(timezone.utc),
                        }
                    },
                )

                # Update coverage metadata with error status
                await coverage_metadata_collection.update_one(
                    {"location.display_name": display_name},
                    {
                        "$set": {
                            "location": location,
                            "status": "error",
                            "last_error": "No street data found for location",
                            "last_updated": datetime.now(timezone.utc),
                        }
                    },
                    upsert=True,
                )
                return

            # Update coverage metadata
            logger.info(
                f"Saving coverage data for {display_name} with {
                    len(result['streets_data'].get('features', []))
                } street features"
            )

            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "location": location,
                        "total_length": result["total_length"],
                        "driven_length": result["driven_length"],
                        "coverage_percentage": result["coverage_percentage"],
                        "last_updated": datetime.now(timezone.utc),
                        "status": "completed",
                        "streets_data": result["streets_data"],
                        "total_segments": result.get("total_segments", 0),
                        "street_types": result.get("street_types", []),
                    }
                },
                upsert=True,
            )

            # Update progress status
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "complete",
                        "progress": 100,
                        "result": {
                            "total_length": result["total_length"],
                            "driven_length": result["driven_length"],
                            "coverage_percentage": result["coverage_percentage"],
                            "total_segments": result.get("total_segments", 0),
                        },
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )

            logger.info(f"Coverage calculation completed for {display_name}")
        else:
            error_msg = "No result returned from coverage calculation"
            logger.error(f"Coverage calculation error: {error_msg}")

            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "location": location,
                        "status": "error",
                        "last_error": error_msg,
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
                upsert=True,
            )

            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "progress": 0,
                        "message": error_msg,
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
    except Exception as e:
        logger.exception(f"Error in coverage calculation for task {task_id}: {str(e)}")

        try:
            display_name = location.get("display_name", "Unknown")

            # Update coverage metadata with error
            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "location": location,
                        "status": "error",
                        "last_error": str(e),
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
                upsert=True,
            )

            # Update progress with error
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "progress": 0,
                        "message": f"Error: {str(e)}",
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
        except Exception as inner_e:
            logger.exception(
                f"Error updating progress after calculation error: {str(inner_e)}"
            )


@app.get("/api/street_coverage/{task_id}")
async def get_coverage_status(task_id: str):
    progress = await find_one_with_retry(progress_collection, {"_id": task_id})
    if not progress:
        raise HTTPException(status_code=404, detail="Task not found")
    if progress.get("stage") == "error":
        raise HTTPException(
            status_code=500, detail=progress.get("error", "Unknown error")
        )
    if progress.get("stage") == "complete":
        return progress.get("result")
    return {
        "stage": progress.get("stage", "unknown"),
        "progress": progress.get("progress", 0),
        "message": progress.get("message", ""),
    }


@app.post("/api/street_coverage/incremental")
async def get_incremental_street_coverage(request: Request):
    """
    Update street coverage incrementally, processing only new trips since last update.
    """
    try:
        data = await request.json()
        location = data.get("location")
        if not location or not isinstance(location, dict):
            raise HTTPException(status_code=400, detail="Invalid location data.")

        task_id = str(uuid.uuid4())
        asyncio.create_task(process_incremental_coverage_calculation(location, task_id))
        return {"task_id": task_id, "status": "processing"}
    except Exception as e:
        logger.exception("Error in incremental street coverage calculation.")
        raise HTTPException(status_code=500, detail=str(e))


async def process_incremental_coverage_calculation(
    location: Dict[str, Any], task_id: str
):
    """
    Process incremental coverage calculation in the background.
    """
    try:
        # Initialize progress tracking
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "initializing",
                    "progress": 0,
                    "message": "Starting incremental coverage calculation...",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )

        display_name = location.get("display_name", "Unknown")

        # Run the incremental calculation
        result = await compute_incremental_coverage(location, task_id)

        if result:
            # Update with successful results
            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "completed",
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
            )

            # Final progress update
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "complete",
                        "progress": 100,
                        "result": result,
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )

            logger.info(
                f"Incremental coverage calculation completed for {display_name}"
            )
        else:
            error_msg = "Failed to calculate incremental coverage"
            logger.error(f"Coverage calculation error: {error_msg}")

            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": error_msg,
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
            )

            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "error": error_msg,
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
    except Exception as e:
        logger.exception(f"Error in incremental coverage calculation: {str(e)}")

        try:
            # Update with error information
            await coverage_metadata_collection.update_one(
                {"location.display_name": location.get("display_name", "Unknown")},
                {
                    "$set": {
                        "status": "error",
                        "last_error": str(e),
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
            )

            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "error": str(e),
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
        except Exception as update_error:
            logger.error(f"Failed to update status after error: {update_error}")


# TRIPS (REGULAR, UPLOADED)


@app.get("/api/trips")
async def get_trips(request: Request):
    try:
        query = await build_query_from_request(request)

        # Fetch trips from both collections
        regular_future = find_with_retry(trips_collection, query)
        uploaded_future = find_with_retry(uploaded_trips_collection, query)
        regular, uploaded = await asyncio.gather(regular_future, uploaded_future)

        all_trips = regular + uploaded
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
                    "source": trip.get("source", "regular"),
                    "hardBrakingCount": trip.get("hardBrakingCount"),
                    "hardAccelerationCount": trip.get("hardAccelerationCount"),
                    "startOdometer": trip.get("startOdometer"),
                    "endOdometer": trip.get("endOdometer"),
                    "averageSpeed": trip.get("averageSpeed"),
                }

                # Create GeoJSON feature
                feature = geojson_module.Feature(geometry=geom, properties=props)
                features.append(feature)
            except Exception:
                logger.exception(
                    "Error processing trip for transactionId: %s",
                    trip.get("transactionId"),
                )
                continue

        # Create FeatureCollection
        fc = geojson_module.FeatureCollection(features)
        return JSONResponse(content=fc)
    except Exception:
        logger.exception("Error in /api/trips endpoint")
        raise HTTPException(status_code=500, detail="Failed to retrieve trips")


@app.get("/api/driving-insights")
async def get_driving_insights(request: Request):
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

        # Query both collections
        trips_result = await aggregate_with_retry(trips_collection, pipeline)
        uploaded_result = await aggregate_with_retry(
            uploaded_trips_collection, pipeline
        )

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
        uploaded_mv = await aggregate_with_retry(
            uploaded_trips_collection, pipeline_most_visited
        )

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
        for r in trips_result + uploaded_result:
            if r:
                combined["total_trips"] += r.get("total_trips", 0)
                combined["total_distance"] += r.get("total_distance", 0)
                combined["total_fuel_consumed"] += r.get("total_fuel_consumed", 0)
                combined["max_speed"] = max(
                    combined["max_speed"], r.get("max_speed", 0)
                )
                combined["total_idle_duration"] += r.get("total_idle_duration", 0)
                combined["longest_trip_distance"] = max(
                    combined["longest_trip_distance"], r.get("longest_trip_distance", 0)
                )

        # Process most visited
        all_most_visited = trips_mv + uploaded_mv
        if all_most_visited:
            best = sorted(all_most_visited, key=lambda x: x["count"], reverse=True)[0]
            combined["most_visited"] = {
                "_id": best["_id"],
                "count": best["count"],
                "isCustomPlace": best.get("isCustomPlace", False),
            }

        return JSONResponse(content=combined)
    except Exception as e:
        logger.exception("Error in get_driving_insights")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/metrics")
async def get_metrics(request: Request):
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
        logger.exception("Error in get_metrics")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/fetch_trips")
async def api_fetch_trips():
    # Find the most recent trip in the database
    last_trip = await find_one_with_retry(trips_collection, {}, sort=[("endTime", -1)])
    start_date = (
        last_trip["endTime"]
        if last_trip and last_trip.get("endTime")
        else datetime.now(timezone.utc)
        - timedelta(days=7)  # get last 7 days as backup if no recent trip
    )
    end_date = datetime.now(timezone.utc)
    logger.info("Fetching trips from %s to %s", start_date, end_date)
    await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=False)
    return {"status": "success", "message": "New trips fetched & stored."}


@app.post("/api/fetch_trips_range")
async def api_fetch_trips_range(request: Request):
    data = await request.json()
    start_date = parse_query_date(data["start_date"])
    end_date = parse_query_date(data["end_date"], end_of_day=True)
    if not start_date or not end_date:
        raise HTTPException(status_code=400, detail="Invalid date range.")
    await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=False)
    return {"status": "success", "message": "Trips fetched & stored."}


@app.post("/api/fetch_trips_last_hour")
async def api_fetch_trips_last_hour():
    now_utc = datetime.now(timezone.utc)
    start_date = now_utc - timedelta(hours=1)
    await fetch_bouncie_trips_in_range(start_date, now_utc, do_map_match=True)
    return {"status": "success", "message": "Hourly trip fetch completed."}


# PROCESS TRIPS


@app.post("/api/process_trip/{trip_id}")
async def process_single_trip(trip_id: str, request: Request):
    """
    Process a single trip with options to validate, geocode, and map match.
    """
    try:
        data = await request.json()
        validate_only = data.get("validate_only", False)
        geocode_only = data.get("geocode_only", False)
        map_match = data.get("map_match", True)

        # Get the trip
        trip, collection = await get_trip_from_all_collections(trip_id)

        if not trip:
            raise HTTPException(status_code=404, detail="Trip not found")

        # Create the processor
        processor = TripProcessor(
            mapbox_token=MAPBOX_ACCESS_TOKEN,
            source="api" if collection == trips_collection else "upload",
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
        elif geocode_only:
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
        else:
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
        logger.exception(f"Error processing trip {trip_id}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/bulk_process_trips")
async def bulk_process_trips(request: Request):
    """
    Process multiple trips in bulk with configurable options.
    """
    try:
        data = await request.json()
        query = data.get("query", {})
        options = data.get("options", {})
        limit = min(int(data.get("limit", 100)), 500)  # Cap at 500 for safety

        # Parse options
        do_validate = options.get("validate", True)
        do_geocode = options.get("geocode", True)
        do_map_match = options.get("map_match", False)
        collection_name = options.get("collection", "trips")

        # Select collection
        collection = trips_collection
        if collection_name == "uploaded_trips":
            collection = uploaded_trips_collection

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
                processor = TripProcessor(
                    mapbox_token=MAPBOX_ACCESS_TOKEN,
                    source="api" if collection == trips_collection else "upload",
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
                    f"Error processing trip {trip.get('transactionId')}: {str(e)}"
                )
                results["failed"] += 1

        return {
            "status": "success",
            "message": f"Processed {len(trips)} trips",
            "results": results,
        }
    except Exception as e:
        logger.exception("Error in bulk_process_trips")
        raise HTTPException(status_code=500, detail=str(e))


# New endpoint to get trip processing status
@app.get("/api/trips/{trip_id}/status")
async def get_trip_status(trip_id: str):
    """
    Get detailed processing status for a trip
    """
    try:
        trip, collection = await get_trip_from_all_collections(trip_id)

        if not trip:
            raise HTTPException(status_code=404, detail="Trip not found")

        # Create status summary
        status_info = {
            "transaction_id": trip_id,
            "collection": collection.name,
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
        logger.exception(f"Error getting trip status for {trip_id}")
        raise HTTPException(status_code=500, detail=str(e))


# EXPORT ENDPOINTS


@app.get("/export/geojson")
async def export_geojson(request: Request):
    """Export trips as GeoJSON."""
    try:
        query = await build_query_from_request(request)
        trips = await find_with_retry(trips_collection, query)

        if not trips:
            raise HTTPException(status_code=404, detail="No trips found for filters.")

        return await export_geojson_response(trips, "all_trips")
    except Exception as e:
        logger.exception("Error exporting GeoJSON")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/export/gpx")
async def export_gpx(request: Request):
    """Export trips as GPX."""
    try:
        query = await build_query_from_request(request)
        trips = await find_with_retry(trips_collection, query)

        if not trips:
            raise HTTPException(status_code=404, detail="No trips found.")

        return await export_gpx_response(trips, "trips")
    except Exception as e:
        logger.exception("Error exporting GPX")
        raise HTTPException(status_code=500, detail=str(e))


# VALIDATION / OSM DATA


@app.post("/api/validate_location")
async def validate_location(request: Request):
    data = await request.json()
    location = data.get("location")
    location_type = data.get("locationType")
    validated = await validate_location_osm(location, location_type)
    return validated


async def process_elements(elements, streets_only: bool):
    features = []
    for e in elements:
        if e["type"] == "way":
            coords = [(n["lon"], n["lat"]) for n in e.get("geometry", [])]
            if len(coords) >= 2:
                if streets_only:
                    line = LineString(coords)
                    features.append(
                        {
                            "type": "Feature",
                            "geometry": line.__geo_interface__,
                            "properties": e.get("tags", {}),
                        }
                    )
                else:
                    if coords[0] == coords[-1]:
                        poly = Polygon(coords)
                        features.append(
                            {
                                "type": "Feature",
                                "geometry": poly.__geo_interface__,
                                "properties": e.get("tags", {}),
                            }
                        )
                    else:
                        line = LineString(coords)
                        features.append(
                            {
                                "type": "Feature",
                                "geometry": line.__geo_interface__,
                                "properties": e.get("tags", {}),
                            }
                        )
    return features


async def generate_geojson_osm(
    location: Dict[str, Any], streets_only=False
) -> tuple[Optional[dict], Optional[str]]:
    try:
        if not (
            isinstance(location, dict)
            and "osm_id" in location
            and "osm_type" in location
        ):
            return None, "Invalid location data"
        osm_type = "streets" if streets_only else "boundary"
        area_id = int(location["osm_id"])
        if location["osm_type"] == "relation":
            area_id += 3600000000
        if streets_only:
            query = f"""
            [out:json];
            area({area_id})->.searchArea;
            (way["highway"](area.searchArea););
            (._;>;);
            out geom;
            """
        else:
            query = f"""
            [out:json];
            ({location["osm_type"]}({location["osm_id"]});
            >;
            );
            out geom;
            """
        async with aiohttp.ClientSession() as session:
            async with session.get(
                OVERPASS_URL, params={"data": query}, timeout=30
            ) as response:
                response.raise_for_status()
                data = await response.json()
        features = await process_elements(data["elements"], streets_only)
        if features:
            gdf = gpd.GeoDataFrame.from_features(features).set_geometry("geometry")
            geojson_data = json.loads(gdf.to_json())
            bson_size_estimate = len(json.dumps(geojson_data).encode("utf-8"))
            if bson_size_estimate <= 16793598:
                existing_data = await find_one_with_retry(
                    osm_data_collection, {"location": location, "type": osm_type}
                )
                if existing_data:
                    await update_one_with_retry(
                        osm_data_collection,
                        {"_id": existing_data["_id"]},
                        {
                            "$set": {
                                "geojson": geojson_data,
                                "updated_at": datetime.now(timezone.utc),
                            }
                        },
                    )
                    logger.info(
                        "Updated OSM data for %s, type: %s",
                        location.get("display_name", "Unknown"),
                        osm_type,
                    )
                else:
                    await insert_one_with_retry(
                        osm_data_collection,
                        {
                            "location": location,
                            "type": osm_type,
                            "geojson": geojson_data,
                            "created_at": datetime.now(timezone.utc),
                        },
                    )
                    logger.info(
                        "Stored OSM data for %s, type: %s",
                        location.get("display_name", "Unknown"),
                        osm_type,
                    )
            else:
                logger.warning(
                    "OSM data for %s is too large for MongoDB",
                    location.get("display_name", "Unknown"),
                )
            return geojson_data, None
        return None, "No features found"
    except aiohttp.ClientError:
        logger.exception("Error generating geojson from Overpass")
        return None, "Error communicating with Overpass API"
    except Exception as e:
        logger.exception("Error generating geojson")
        return None, str(e)


@app.post("/api/generate_geojson")
async def generate_geojson_endpoint(request: Request):
    data = await request.json()
    location = data.get("location")
    streets_only = data.get("streetsOnly", False)
    geojson_data, err = await generate_geojson_osm(location, streets_only)
    if geojson_data:
        return geojson_data
    raise HTTPException(status_code=400, detail=err)


# MAP MATCHING ENDPOINTS


@app.post("/api/map_match_trips")
async def map_match_trips_endpoint(request: Request):
    try:
        data = await request.json()
        start_date = parse_query_date(data.get("start_date"))
        end_date = parse_query_date(data.get("end_date"), end_of_day=True)
        trip_id = data.get("trip_id")

        query = {}
        if trip_id:
            query["transactionId"] = trip_id
        elif start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        else:
            raise HTTPException(
                status_code=400, detail="Either trip_id or date range is required"
            )

        trips_list = await find_with_retry(trips_collection, query)

        if not trips_list:
            raise HTTPException(
                status_code=404, detail="No trips found matching criteria"
            )

        # Use the TripProcessor for map matching
        processed_count = 0
        failed_count = 0
        for trip in trips_list:
            try:
                processor = TripProcessor(
                    mapbox_token=MAPBOX_ACCESS_TOKEN, source="api"
                )
                processor.set_trip_data(trip)
                await processor.process(do_map_match=True)
                result = await processor.save(map_match_result=True)

                if result:
                    processed_count += 1
                else:
                    failed_count += 1
                    logger.warning(
                        f"Failed to save matched trip {trip.get('transactionId')}"
                    )
            except Exception as e:
                failed_count += 1
                logger.error(
                    f"Error processing trip {trip.get('transactionId')}: {str(e)}"
                )

        return {
            "status": "success",
            "message": f"Map matching completed: {processed_count} successful, {failed_count} failed.",
            "processed_count": processed_count,
            "failed_count": failed_count,
        }
    except Exception as e:
        logger.exception("Error in map_match_trips endpoint")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/matched_trips")
async def get_matched_trips(request: Request):
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
                    },
                )
                features.append(feature)
            except Exception:
                logger.exception(
                    "Error processing matched trip %s", trip.get("transactionId")
                )
                continue

        fc = geojson_module.FeatureCollection(features)
        return JSONResponse(content=fc)
    except Exception as e:
        logger.exception("Error in get_matched_trips")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/matched_trips/delete")
async def delete_matched_trips(request: Request):
    try:
        data = await request.json()
        start_date_str = data.get("start_date")
        end_date_str = data.get("end_date")
        interval_days = int(data.get("interval_days", 0))
        start_date = parse_query_date(start_date_str)
        end_date = parse_query_date(end_date_str)

        if not start_date or not end_date:
            raise HTTPException(status_code=400, detail="Invalid date range")

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
        logger.exception("Error in delete_matched_trips")
        raise HTTPException(
            status_code=500, detail=f"Error deleting matched trips: {e}"
        )


@app.post("/api/matched_trips/remap")
async def remap_matched_trips(request: Request):
    try:
        data = await request.json()
        start_date_str = data.get("start_date")
        end_date_str = data.get("end_date")
        interval_days = int(data.get("interval_days", 0))

        if interval_days > 0:
            start_date = datetime.utcnow() - timedelta(days=interval_days)
            end_date = datetime.utcnow()
        else:
            start_date = parse_query_date(start_date_str)
            end_date = parse_query_date(end_date_str, end_of_day=True)

        await delete_many_with_retry(
            matched_trips_collection,
            {"startTime": {"$gte": start_date, "$lte": end_date}},
        )

        trips_list = await find_with_retry(
            trips_collection, {"startTime": {"$gte": start_date, "$lte": end_date}}
        )

        for trip in trips_list:
            processor = TripProcessor(mapbox_token=MAPBOX_ACCESS_TOKEN, source="api")
            processor.set_trip_data(trip)
            await processor.process(do_map_match=True)
            await processor.save(map_match_result=True)

        return {"status": "success", "message": "Re-matching completed."}
    except Exception as e:
        logger.exception("Error in remap_matched_trips")
        raise HTTPException(status_code=500, detail=f"Error re-matching trips: {e}")


@app.get("/api/export/trip/{trip_id}")
async def export_single_trip(trip_id: str, request: Request):
    """Export a single trip by ID."""
    fmt = request.query_params.get("format", "geojson")

    t = await find_one_with_retry(trips_collection, {"transactionId": trip_id})

    if not t:
        raise HTTPException(status_code=404, detail="Trip not found")

    start_date = t.get("startTime")
    date_str = start_date.strftime("%Y%m%d") if start_date else "unknown_date"
    filename_base = f"trip_{trip_id}_{date_str}"

    try:
        return await create_export_response([t], fmt, filename_base)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"Error exporting trip {trip_id}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/matched_trips/{trip_id}")
async def delete_matched_trip(trip_id: str):
    try:
        result = await delete_one_with_retry(
            matched_trips_collection,
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]},
        )
        if result.deleted_count:
            return {"status": "success", "message": "Deleted matched trip"}
        raise HTTPException(status_code=404, detail="Trip not found")
    except Exception as e:
        logger.exception("Error deleting matched trip %s", trip_id)
        raise HTTPException(status_code=500, detail=str(e))


# COMBINED EXPORT ENDPOINTS


async def fetch_all_trips_no_filter() -> List[dict]:
    regular_trips = await find_with_retry(trips_collection, {})
    uploaded_trips = await find_with_retry(uploaded_trips_collection, {})
    return regular_trips + uploaded_trips


@app.get("/api/export/all_trips")
async def export_all_trips(request: Request):
    """Export all trips in various formats."""
    fmt = request.query_params.get("format", "geojson").lower()
    all_trips = await fetch_all_trips_no_filter()

    current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename_base = f"all_trips_{current_time}"

    if fmt == "json":
        return JSONResponse(content=all_trips)

    try:
        return await create_export_response(all_trips, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Error exporting all trips")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/export/trips")
async def export_trips_within_range(request: Request):
    """Export trips within a date range."""
    fmt = request.query_params.get("format", "geojson").lower()
    query = await build_query_from_request(request)

    # Check if date range is valid by checking if query has startTime filter
    if "startTime" not in query:
        raise HTTPException(status_code=400, detail="Invalid or missing date range")

    # Use the utility functions from db.py
    trips_data = await find_with_retry(trips_collection, query)
    ups_data = await find_with_retry(uploaded_trips_collection, query)
    all_trips = trips_data + ups_data

    # Create filename from date range
    date_range = extract_date_range_string(query)
    filename_base = f"trips_{date_range}"

    try:
        return await create_export_response(all_trips, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Error exporting trips within range")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/export/matched_trips")
async def export_matched_trips_within_range(request: Request):
    """Export matched trips within a date range."""
    fmt = request.query_params.get("format", "geojson").lower()
    query = await build_query_from_request(request)

    # Check if date range is valid by checking if query has startTime filter
    if "startTime" not in query:
        raise HTTPException(status_code=400, detail="Invalid or missing date range")

    matched = await find_with_retry(matched_trips_collection, query)

    # Create filename from date range
    date_range = extract_date_range_string(query)
    filename_base = f"matched_trips_{date_range}"

    try:
        return await create_export_response(matched, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Error exporting matched trips")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/export/streets")
async def export_streets(request: Request):
    """Export streets data for a location."""
    location_param = request.query_params.get("location")
    fmt = request.query_params.get("format", "geojson").lower()

    if not location_param:
        raise HTTPException(status_code=400, detail="No location param")

    loc = json.loads(location_param)
    data, error = await generate_geojson_osm(loc, streets_only=True)

    if not data:
        raise HTTPException(
            status_code=500, detail=error or "No data returned from Overpass"
        )

    location_name = get_location_filename(loc)
    filename_base = f"streets_{location_name}"

    try:
        return await create_export_response(data, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Error exporting streets data")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/export/boundary")
async def export_boundary(request: Request):
    """Export boundary data for a location."""
    location_param = request.query_params.get("location")
    fmt = request.query_params.get("format", "geojson").lower()

    if not location_param:
        raise HTTPException(status_code=400, detail="No location provided")

    loc = json.loads(location_param)
    data, error = await generate_geojson_osm(loc, streets_only=False)

    if not data:
        raise HTTPException(
            status_code=500, detail=error or "No boundary data from Overpass"
        )

    location_name = get_location_filename(loc)
    filename_base = f"boundary_{location_name}"

    try:
        return await create_export_response(data, fmt, filename_base)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Error exporting boundary data")
        raise HTTPException(status_code=500, detail=str(e))


# PREPROCESS_STREETS / STREET SEGMENT


@app.post("/api/preprocess_streets")
async def preprocess_streets_route(request: Request):
    try:
        data = await request.json()
        location = data.get("location")
        location_type = data.get("location_type")
        if not location or not location_type:
            raise HTTPException(status_code=400, detail="Missing location data")
        validated_location = await validate_location_osm(location, location_type)
        if not validated_location:
            raise HTTPException(status_code=400, detail="Invalid location")
        try:
            await update_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": validated_location["display_name"]},
                {
                    "$set": {
                        "location": validated_location,
                        "status": "processing",
                        "total_length": 0,
                        "driven_length": 0,
                        "coverage_percentage": 0,
                        "total_segments": 0,
                    }
                },
                upsert=True,
            )
        except Exception:
            existing = await find_one_with_retry(
                coverage_metadata_collection,
                {"location.display_name": validated_location["display_name"]},
            )
            if existing and existing.get("status") == "processing":
                raise HTTPException(
                    status_code=400, detail="This area is already being processed"
                )
            raise
        task_id = str(uuid.uuid4())
        asyncio.create_task(process_area(validated_location, task_id))
        return {"status": "success", "task_id": task_id}
    except Exception as e:
        logger.exception("Error in preprocess_streets")
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(status_code=500, detail=str(e))


async def process_area(location: Dict[str, Any], task_id: str):
    """
    Process an area by preprocessing streets and calculating coverage.
    Handles errors properly and updates status.
    """
    try:
        # Initialize progress
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "preprocessing",
                    "progress": 0,
                    "message": "Preprocessing streets...",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )

        # Update metadata to show processing status
        display_name = location.get("display_name", "Unknown")
        await coverage_metadata_collection.update_one(
            {"location.display_name": display_name},
            {
                "$set": {
                    "location": location,
                    "status": "processing",
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )

        # Preprocess streets
        await async_preprocess_streets(location)

        # Update progress
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "calculating",
                    "progress": 50,
                    "message": "Calculating coverage...",
                    "updated_at": datetime.now(timezone.utc),
                }
            },
        )

        # Calculate coverage
        result = await compute_coverage_for_location(location, task_id)

        if result:
            # Update with results
            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "completed",
                        "total_length": result["total_length"],
                        "driven_length": result["driven_length"],
                        "coverage_percentage": result["coverage_percentage"],
                        "last_updated": datetime.now(timezone.utc),
                        "streets_data": result["streets_data"],
                        "total_segments": result.get("total_segments", 0),
                        "street_types": result.get("street_types", []),
                    }
                },
            )

            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "complete",
                        "progress": 100,
                        "result": result,
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )

            logger.info("Coverage calculation completed for %s", display_name)
        else:
            error_msg = "Failed to calculate coverage"
            logger.error("Coverage calculation error: %s", error_msg)

            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "status": "error",
                        "last_error": error_msg,
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
            )

            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "error": error_msg,
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
    except Exception as e:
        logger.exception(
            f"Error processing area {location.get('display_name', 'Unknown')}"
        )

        try:
            # Update both collections with error information
            await coverage_metadata_collection.update_one(
                {"location.display_name": location["display_name"]},
                {
                    "$set": {
                        "status": "error",
                        "last_error": str(e),
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
            )

            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "error": str(e),
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
        except Exception as update_error:
            logger.error("Failed to update status after error: %s", update_error)


@app.get("/api/street_segment/{segment_id}")
async def get_street_segment_details(segment_id: str):
    try:
        segment = await find_one_with_retry(
            streets_collection, {"properties.segment_id": segment_id}, {"_id": 0}
        )
        if not segment:
            raise HTTPException(status_code=404, detail="Segment not found")
        return segment
    except Exception as e:
        logger.exception("Error fetching segment details")
        raise HTTPException(status_code=500, detail=str(e))


# LAST TRIP POINT


@app.get("/api/last_trip_point")
async def get_last_trip_point():
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
    except Exception:
        logger.exception("Error get_last_trip_point")
        raise HTTPException(
            status_code=500, detail="Failed to retrieve last trip point"
        )


# SINGLE TRIP GET/DELETE


@app.get("/api/trips/{trip_id}")
async def get_single_trip(trip_id: str):
    try:
        trip, _ = await get_trip_from_all_collections(trip_id)

        if not trip:
            raise HTTPException(status_code=404, detail="Trip not found")

        # Use SerializationHelper instead of serialize_trip
        return {"status": "success", "trip": SerializationHelper.serialize_trip(trip)}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("get_single_trip error")
        raise HTTPException(status_code=500, detail="Internal server error") from e


@app.delete("/api/trips/{trip_id}")
async def delete_trip(trip_id: str):
    try:
        trip, collection = await get_trip_from_all_collections(trip_id)

        if not trip:
            raise HTTPException(status_code=404, detail="Trip not found")

        # Delete the trip from the original collection
        result = await delete_one_with_retry(collection, {"transactionId": trip_id})

        # Also delete from matched_trips if it exists there
        matched_delete_result = None
        if collection != matched_trips_collection:
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

        raise HTTPException(status_code=500, detail="Failed to delete trip")
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        logger.error("Error deleting trip: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error") from e


@app.get("/api/debug/trip/{trip_id}")
async def debug_trip(trip_id: str):
    try:
        regular_trip = await find_one_with_retry(
            trips_collection,
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]},
        )
        matched_trip = await find_one_with_retry(
            matched_trips_collection,
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]},
        )
        return {
            "regular_trip_found": bool(regular_trip),
            "matched_trip_found": bool(matched_trip),
            "regular_trip_id_field": (
                regular_trip.get("transactionId") if regular_trip else None
            ),
            "matched_trip_id_field": (
                matched_trip.get("transactionId") if matched_trip else None
            ),
        }
    except Exception as e:
        logger.exception("debug_trip error")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/first_trip_date")
async def get_first_trip_date():
    try:
        regular_trip = await find_one_with_retry(
            trips_collection, {}, sort=[("startTime", 1)]
        )
        uploaded_trip = await find_one_with_retry(
            uploaded_trips_collection, {}, sort=[("startTime", 1)]
        )

        candidates = []
        if regular_trip and regular_trip.get("startTime"):
            candidates.append(regular_trip["startTime"])
        if uploaded_trip and uploaded_trip.get("startTime"):
            candidates.append(uploaded_trip["startTime"])

        if not candidates:
            now = datetime.now(timezone.utc)
            return {"first_trip_date": now.isoformat()}

        earliest_trip_date = min(candidates)
        if earliest_trip_date.tzinfo is None:
            earliest_trip_date = earliest_trip_date.replace(tzinfo=timezone.utc)

        # Use SerializationHelper instead of direct iso formatting
        return {
            "first_trip_date": SerializationHelper.serialize_datetime(
                earliest_trip_date
            )
        }
    except Exception as e:
        logger.exception("get_first_trip_date error")
        raise HTTPException(status_code=500, detail=str(e))


# GPX / GEOJSON UPLOAD


@app.get("/api/uploaded_trips")
async def get_uploaded_trips():
    try:
        trips = await find_with_retry(uploaded_trips_collection, {})
        # Use SerializationHelper instead of serialize_trip
        serialized_trips = [SerializationHelper.serialize_trip(trip) for trip in trips]
        return {"status": "success", "trips": serialized_trips}
    except Exception as e:
        logger.exception("Error get_uploaded_trips")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/uploaded_trips_bulk_delete")
async def bulk_delete_uploaded_trips(request: Request):
    try:
        data = await request.json()
        trip_ids = data.get("trip_ids", [])
        if not trip_ids:
            raise HTTPException(status_code=400, detail="No trip IDs")

        logger.info("Bulk delete requested for %d uploaded trip IDs", len(trip_ids))

        valid_ids = []
        for tid in trip_ids:
            try:
                valid_ids.append(ObjectId(tid))
            except bson.errors.InvalidId:
                logger.warning("Invalid ObjectId format: %s", tid)

        if not valid_ids:
            raise HTTPException(status_code=400, detail="No valid IDs found")

        # Find all trips first to get their transaction IDs
        ups_to_delete = await find_with_retry(
            uploaded_trips_collection, {"_id": {"$in": valid_ids}}
        )

        # Extract transaction IDs, handling the case where some might not have
        # a transactionId
        trans_ids = []
        for trip in ups_to_delete:
            if "transactionId" in trip:
                trans_ids.append(trip["transactionId"])

        # Log what we're about to delete
        logger.info(
            "Found %d uploaded trips to delete with %d transaction IDs",
            len(ups_to_delete),
            len(trans_ids),
        )

        # Delete the trips
        del_res = await delete_many_with_retry(
            uploaded_trips_collection, {"_id": {"$in": valid_ids}}
        )

        # Delete associated matched trips if any
        matched_del_res = None
        if trans_ids:
            matched_del_res = await delete_many_with_retry(
                matched_trips_collection, {"transactionId": {"$in": trans_ids}}
            )

        deleted_matched = matched_del_res.deleted_count if matched_del_res else 0
        logger.info(
            "Deleted %d uploaded trips and %d matched trips",
            del_res.deleted_count,
            deleted_matched,
        )

        return {
            "status": "success",
            "deleted_uploaded_trips": del_res.deleted_count,
            "deleted_matched_trips": deleted_matched,
        }
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        logger.error("Error in bulk_delete_uploaded_trips: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/uploaded_trips/{trip_id}")
async def delete_uploaded_trip(trip_id: str):
    try:
        # Convert to ObjectId safely (this will raise InvalidId for malformed
        # ids)
        try:
            object_id = ObjectId(trip_id)
        except bson.errors.InvalidId:
            logger.error("Invalid ObjectId format: %s", trip_id)
            raise HTTPException(
                status_code=400, detail="Invalid trip ID format: %s" % trip_id
            )

        # First, find the uploaded trip to get its transactionId (if it exists)
        uploaded_trip = await find_one_with_retry(
            uploaded_trips_collection, {"_id": object_id}
        )
        if not uploaded_trip:
            raise HTTPException(status_code=404, detail="Uploaded trip not found")

        transaction_id = uploaded_trip.get("transactionId")

        # Delete the uploaded trip
        result = await delete_one_with_retry(
            uploaded_trips_collection, {"_id": object_id}
        )

        # Also delete the matched trip if it exists
        matched_delete_result = None
        if transaction_id:
            matched_delete_result = await delete_one_with_retry(
                matched_trips_collection, {"transactionId": transaction_id}
            )

        if result.deleted_count == 1:
            return {
                "status": "success",
                "message": "Trip deleted",
                "deleted_matched_trips": (
                    matched_delete_result.deleted_count if matched_delete_result else 0
                ),
            }
        raise HTTPException(status_code=404, detail="Not found")
    except HTTPException:
        # Re-raise HTTP exceptions
        raise
    except Exception as e:
        logger.error("Error deleting uploaded trip: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def meters_to_miles(m: float) -> float:
    return m / 1609.34


def calculate_distance(coordinates: List[List[float]]) -> float:
    """Calculate the total distance of a trip from a list of [lng, lat] coordinates."""
    total_distance = 0.0
    for i in range(len(coordinates) - 1):
        lon1, lat1 = coordinates[i]
        lon2, lat2 = coordinates[i + 1]
        total_distance += haversine_util(lon1, lat1, lon2, lat2, unit="miles")
    return total_distance


def calculate_gpx_distance(coords: List[List[float]]) -> float:
    dist = 0
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        dist += gpxpy.geo.haversine_distance(lat1, lon1, lat2, lon2)
    return dist


def process_geojson_trip(geojson_data: dict) -> Optional[List[dict]]:
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
                }
            )
        return trips
    except Exception:
        logger.exception("Error in process_geojson_trip")
        return None


async def process_and_store_trip(trip: dict):
    try:
        processor = TripProcessor(mapbox_token=MAPBOX_ACCESS_TOKEN, source="upload")
        processor.set_trip_data(trip)

        # Ensure we have GPS data
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
                processor.processed_data["gps"] = gps_data
            except json.JSONDecodeError:
                logger.warning(
                    f"Invalid GPS data for trip {trip.get('transactionId', 'unknown')}"
                )
                return

        # Extract and geocode the locations
        await processor.process(do_map_match=False)
        await processor.save()

    except bson.errors.DuplicateKeyError:
        logger.warning("Duplicate trip ID %s; skipping.", trip.get("transactionId"))
    except Exception:
        logger.exception("process_and_store_trip error")
        raise


@app.post("/api/upload_gpx")
async def upload_gpx_endpoint(request: Request):
    try:
        form = await request.form()
        files = form.getlist("files[]")
        if not files:
            raise HTTPException(status_code=400, detail="No files found for upload")

        success_count = 0
        for f in files:
            filename = f.filename.lower()
            if filename.endswith(".gpx"):
                gpx_data = await f.read()
                gpx_obj = gpxpy.parse(gpx_data)
                for track in gpx_obj.tracks:
                    for seg in track.segments:
                        coords = [[p.longitude, p.latitude] for p in seg.points]
                        if len(coords) < 2:
                            continue
                        times = [p.time for p in seg.points if p.time]
                        if not times:
                            continue
                        start_t = min(times)
                        end_t = max(times)

                        # Convert points to format expected by TripProcessor
                        coord_data = []
                        for i, point in enumerate(seg.points):
                            if point.time:
                                coord_data.append(
                                    {
                                        "timestamp": point.time,
                                        "lat": point.latitude,
                                        "lon": point.longitude,
                                    }
                                )

                        # Use TripProcessor's classmethod to process the
                        # coordinates
                        trip_data = await TripProcessor.process_from_coordinates(
                            coord_data,
                            start_time=start_t,
                            end_time=end_t,
                            transaction_id=f"GPX-{start_t.strftime('%Y%m%d%H%M%S')}-{filename}",
                            imei="UPLOADED",
                            source="upload",
                            mapbox_token=MAPBOX_ACCESS_TOKEN,
                        )

                        # Create a processor to save the trip data
                        processor = TripProcessor(
                            mapbox_token=MAPBOX_ACCESS_TOKEN, source="upload"
                        )
                        processor.set_trip_data(trip_data)
                        await processor.save()
                        success_count += 1

            elif filename.endswith(".geojson"):
                content = await f.read()
                data_geojson = json.loads(content)
                feats = data_geojson.get("features", [])

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
                        dateutil_parser.isoparse(etime_str)
                        if etime_str
                        else stime_parsed
                    )

                    coords = geom.get("coordinates", [])
                    if len(coords) < 2:
                        continue

                    processor = TripProcessor(
                        mapbox_token=MAPBOX_ACCESS_TOKEN, source="upload"
                    )

                    trip_data = {
                        "transactionId": tid,
                        "startTime": stime_parsed,
                        "endTime": etime_parsed,
                        "gps": json.dumps(geom),
                        "imei": "UPLOADED",
                        "source": "upload",
                        "filename": filename,
                    }

                    processor.set_trip_data(trip_data)
                    await processor.process(do_map_match=False)
                    await processor.save()
                    success_count += 1
            else:
                logger.warning("Skipping unhandled file extension: %s", filename)

        return {"status": "success", "message": f"{success_count} trips uploaded."}
    except Exception as e:
        logger.exception("Error upload_gpx")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/upload")
async def upload_files(request: Request, files: List[UploadFile] = File(...)):
    try:
        count = 0
        for file in files:
            filename = file.filename.lower()
            content_data = await file.read()
            if filename.endswith(".gpx"):
                gpx_obj = gpxpy.parse(content_data)
                for track in gpx_obj.tracks:
                    for seg in track.segments:
                        if not seg.points:
                            continue
                        coords = [[p.longitude, p.latitude] for p in seg.points]
                        times = [p.time for p in seg.points if p.time]
                        if not times:
                            continue
                        st = min(times)
                        en = max(times)
                        trip_dict = {
                            "transactionId": str(ObjectId()),
                            "startTime": st,
                            "endTime": en,
                            "gps": json.dumps(
                                {"type": "LineString", "coordinates": coords}
                            ),
                            "imei": "UPLOADED",
                            "distance": calculate_distance(coords),
                        }
                        await process_and_store_trip(trip_dict)
                        count += 1
            elif filename.endswith(".geojson"):
                try:
                    data_geojson = json.loads(content_data)
                except json.JSONDecodeError:
                    logger.warning("Invalid geojson: %s", filename)
                    continue
                trips = process_geojson_trip(data_geojson)
                if trips:
                    for t in trips:
                        await process_and_store_trip(t)
                        count += 1

        return {"status": "success", "message": f"Processed {count} trips"}
    except Exception as e:
        logger.exception("Error uploading files")
        raise HTTPException(status_code=500, detail=str(e))


# PLACES ENDPOINTS


@app.api_route("/api/places", methods=["GET", "POST"])
async def handle_places(request: Request):
    if request.method == "GET":
        places = await find_with_retry(places_collection, {})
        return [
            {"_id": str(p["_id"]), **CustomPlace.from_dict(p).to_dict()} for p in places
        ]

    data = await request.json()
    place = CustomPlace(data["name"], data["geometry"])
    result = await insert_one_with_retry(places_collection, place.to_dict())
    return {"_id": str(result.inserted_id), **place.to_dict()}


@app.delete("/api/places/{place_id}")
async def delete_place(place_id: str):
    await delete_one_with_retry(places_collection, {"_id": ObjectId(place_id)})
    return ""


@app.get("/api/places/{place_id}/statistics")
async def get_place_statistics(place_id: str):
    try:
        place = await find_one_with_retry(
            places_collection, {"_id": ObjectId(place_id)}
        )
        if not place:
            raise HTTPException(status_code=404, detail="Place not found")

        query = {
            "$or": [
                {"destinationPlaceId": place_id},
                {
                    "destinationGeoPoint": {
                        "$geoWithin": {"$geometry": place["geometry"]}
                    }
                },
            ],
            "endTime": {"$ne": None},
        }

        valid_trips = []
        for coll in [trips_collection, uploaded_trips_collection]:
            trips_list = await find_with_retry(coll, query)
            valid_trips.extend(trips_list)

        valid_trips.sort(key=lambda x: x["endTime"])
        visits = []
        durations = []
        time_since_last_visits = []
        first_visit = None
        last_visit = None

        for i, t in enumerate(valid_trips):
            try:
                t_end = t["endTime"]
                if isinstance(t_end, str):
                    t_end = dateutil_parser.isoparse(t_end)
                if t_end.tzinfo is None:
                    t_end = t_end.replace(tzinfo=timezone.utc)

                if first_visit is None:
                    first_visit = t_end
                last_visit = t_end

                if i < len(valid_trips) - 1:
                    next_trip = valid_trips[i + 1]
                    same_place = False
                    if next_trip.get("startPlaceId") == place_id:
                        same_place = True
                    else:
                        start_pt = next_trip.get("startGeoPoint")
                        if (
                            start_pt
                            and isinstance(start_pt, dict)
                            and "coordinates" in start_pt
                        ):
                            if shape(place["geometry"]).contains(shape(start_pt)):
                                same_place = True

                    if same_place:
                        next_start = next_trip.get("startTime")
                        if isinstance(next_start, str):
                            next_start = dateutil_parser.isoparse(next_start)
                        if next_start and next_start.tzinfo is None:
                            next_start = next_start.replace(tzinfo=timezone.utc)
                        if next_start and next_start > t_end:
                            duration_minutes = (
                                next_start - t_end
                            ).total_seconds() / 60.0
                            if duration_minutes > 0:
                                durations.append(duration_minutes)

                if i > 0:
                    prev_trip_end = valid_trips[i - 1].get("endTime")
                    if isinstance(prev_trip_end, str):
                        prev_trip_end = dateutil_parser.isoparse(prev_trip_end)
                    if prev_trip_end and prev_trip_end.tzinfo is None:
                        prev_trip_end = prev_trip_end.replace(tzinfo=timezone.utc)
                    if prev_trip_end and t_end > prev_trip_end:
                        hrs_since_last = (
                            t_end - prev_trip_end
                        ).total_seconds() / 3600.0
                        if hrs_since_last >= 0:
                            time_since_last_visits.append(hrs_since_last)

                visits.append(t_end)
            except Exception:
                logger.exception("Issue processing trip for place %s", place_id)
                continue

        total_visits = len(visits)
        avg_duration = sum(durations) / len(durations) if durations else 0

        def format_h_m(m: float) -> str:
            hh = int(m // 60)
            mm = int(m % 60)
            return f"{hh}h {mm:02d}m"

        avg_duration_str = format_h_m(avg_duration) if avg_duration > 0 else "0h 00m"
        avg_time_since_last = (
            sum(time_since_last_visits) / len(time_since_last_visits)
            if time_since_last_visits
            else 0
        )
        return {
            "totalVisits": total_visits,
            "averageTimeSpent": avg_duration_str,
            "firstVisit": SerializationHelper.serialize_datetime(first_visit),
            "lastVisit": SerializationHelper.serialize_datetime(last_visit),
            "averageTimeSinceLastVisit": avg_time_since_last,
            "name": place["name"],
        }
    except Exception as e:
        logger.exception("Error place stats %s", place_id)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/places/{place_id}/trips")
async def get_trips_for_place(place_id: str):
    try:
        place = await find_one_with_retry(
            places_collection, {"_id": ObjectId(place_id)}
        )
        if not place:
            raise HTTPException(status_code=404, detail="Place not found")

        query = {
            "$or": [
                {"destinationPlaceId": place_id},
                {
                    "destinationGeoPoint": {
                        "$geoWithin": {"$geometry": place["geometry"]}
                    }
                },
            ],
            "endTime": {"$ne": None},
        }

        valid_trips = []
        for coll in [trips_collection, uploaded_trips_collection]:
            trips_list = await find_with_retry(coll, query)
            valid_trips.extend(trips_list)

        valid_trips.sort(key=lambda x: x["endTime"])
        trips_data = []

        for i, trip in enumerate(valid_trips):
            end_time = trip["endTime"]
            if isinstance(end_time, str):
                end_time = dateutil_parser.isoparse(end_time)
            if end_time.tzinfo is None:
                end_time = end_time.replace(tzinfo=timezone.utc)

            duration_str = "0h 00m"
            time_since_last_str = "N/A"

            if i < len(valid_trips) - 1:
                next_trip = valid_trips[i + 1]
                same_place = False
                if next_trip.get("startPlaceId") == place_id:
                    same_place = True
                else:
                    start_pt = next_trip.get("startGeoPoint")
                    if (
                        start_pt
                        and isinstance(start_pt, dict)
                        and "coordinates" in start_pt
                    ):
                        if shape(place["geometry"]).contains(shape(start_pt)):
                            same_place = True
                    if same_place:
                        next_start = next_trip.get("startTime")
                        if isinstance(next_start, str):
                            next_start = dateutil_parser.isoparse(next_start)
                        if next_start and next_start.tzinfo is None:
                            next_start = next_start.replace(tzinfo=timezone.utc)
                        if next_start and next_start > end_time:
                            duration_minutes = (
                                next_start - end_time
                            ).total_seconds() / 60.0
                            hh = int(duration_minutes // 60)
                            mm = int(duration_minutes % 60)
                            duration_str = f"{hh}h {mm:02d}m"

            if i > 0:
                prev_trip_end = valid_trips[i - 1].get("endTime")
                if isinstance(prev_trip_end, str):
                    prev_trip_end = dateutil_parser.isoparse(prev_trip_end)
                if prev_trip_end and prev_trip_end.tzinfo is None:
                    prev_trip_end = prev_trip_end.replace(tzinfo=timezone.utc)
                if prev_trip_end and end_time > prev_trip_end:
                    hrs_since_last = (end_time - prev_trip_end).total_seconds() / 3600.0
                    time_since_last_str = f"{hrs_since_last:.2f} hours"

            trips_data.append(
                {
                    "transactionId": trip["transactionId"],
                    "endTime": end_time.isoformat(),
                    "duration": duration_str,
                    "timeSinceLastVisit": time_since_last_str,
                }
            )

        return JSONResponse(content=trips_data)
    except Exception as e:
        logger.exception("Error fetching trips for place %s", place_id)
        raise HTTPException(status_code=500, detail=str(e))


# NON-CUSTOM PLACE VISITS


@app.get("/api/non_custom_places_visits")
async def get_non_custom_places_visits():
    try:
        pipeline = [
            {"$match": {"destination": {"$ne": None}, "destinationPlaceId": None}},
            {
                "$group": {
                    "_id": "$destination",
                    "totalVisits": {"$sum": 1},
                    "firstVisit": {"$min": "$endTime"},
                    "lastVisit": {"$max": "$endTime"},
                }
            },
            {"$match": {"totalVisits": {"$gte": 5}}},
            {"$sort": {"totalVisits": -1}},
        ]

        trips_results = await aggregate_with_retry(trips_collection, pipeline)
        uploaded_results = await aggregate_with_retry(
            uploaded_trips_collection, pipeline
        )

        combined_results = trips_results + uploaded_results
        visits_data = []

        for doc in combined_results:
            visits_data.append(
                {
                    "name": doc["_id"],
                    "totalVisits": doc["totalVisits"],
                    "firstVisit": SerializationHelper.serialize_datetime(
                        doc.get("firstVisit")
                    ),
                    "lastVisit": SerializationHelper.serialize_datetime(
                        doc.get("lastVisit")
                    ),
                }
            )

        return JSONResponse(content=visits_data)
    except Exception as e:
        logger.exception("Error fetching non-custom place visits")
        raise HTTPException(status_code=500, detail=str(e))


# TRIP ANALYTICS


@app.get("/api/trip-analytics")
async def get_trip_analytics(request: Request):
    try:
        query = await build_query_from_request(request)

        # Check if date range is valid by checking if query has startTime filter
        if "startTime" not in query:
            raise HTTPException(status_code=400, detail="Missing date range")

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
        logger.exception("Error trip analytics")
        raise HTTPException(status_code=500, detail=str(e))


# GEOPOINT UPDATES / REGEOCODING


@app.post("/update_geo_points")
async def update_geo_points_route(request: Request):
    data = await request.json()
    collection_name = data.get("collection")
    if collection_name not in ["trips", "uploaded_trips"]:
        raise HTTPException(status_code=400, detail="Invalid collection name")

    coll_map = {
        "trips": trips_collection,
        "uploaded_trips": uploaded_trips_collection,
    }
    collection = coll_map[collection_name]

    try:
        await update_geo_points(collection)
        return {"message": f"GeoPoints updated for {collection_name}"}
    except Exception as e:
        logger.exception("Error in update_geo_points_route")
        raise HTTPException(status_code=500, detail=f"Error updating GeoPoints: {e}")


@app.post("/api/regeocode_all_trips")
async def regeocode_all_trips():
    try:
        for collection in [trips_collection, uploaded_trips_collection]:
            trips_list = await find_with_retry(collection, {})
            for trip in trips_list:
                processor = TripProcessor(
                    mapbox_token=MAPBOX_ACCESS_TOKEN,
                    source="api" if collection == trips_collection else "upload",
                )
                processor.set_trip_data(trip)
                await processor.validate()
                if processor.state == TripState.VALIDATED:
                    await processor.process_basic()
                    if processor.state == TripState.PROCESSED:
                        await processor.geocode()
                        await processor.save()

        return {"message": "All trips re-geocoded successfully."}
    except Exception as e:
        logger.exception("Error in regeocode_all_trips")
        raise HTTPException(status_code=500, detail=f"Error re-geocoding trips: {e}")


@app.post("/api/trips/refresh_geocoding")
async def refresh_geocoding_for_trips(request: Request):
    data = await request.json()
    trip_ids = data.get("trip_ids", [])
    if not trip_ids:
        raise HTTPException(status_code=400, detail="No trip_ids provided")

    updated_count = 0
    for trip_id in trip_ids:
        trip = await find_one_with_retry(trips_collection, {"transactionId": trip_id})
        if trip:
            processor = TripProcessor(mapbox_token=MAPBOX_ACCESS_TOKEN, source="api")
            processor.set_trip_data(trip)
            await processor.validate()
            if processor.state == TripState.VALIDATED:
                await processor.process_basic()
                if processor.state == TripState.PROCESSED:
                    await processor.geocode()
                    if processor.state == TripState.GEOCODED:
                        await processor.save()
                        updated_count += 1

    return {
        "message": f"Geocoding refreshed for {updated_count} trips.",
        "updated_count": updated_count,
    }


# REAL-TIME / BOUNCIE WEBHOOK


@app.post("/webhook/bouncie")
async def bouncie_webhook(request: Request):
    data = await request.json()
    return await handle_bouncie_webhook(data)


@app.get("/api/active_trip")
async def active_trip_endpoint():
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
async def trip_updates_endpoint(last_sequence: int = 0):
    """
    Get trip updates since a specific sequence number

    Args:
        last_sequence: Only return updates newer than this sequence

    Returns:
        Dict: Contains status, has_update flag, and trip data if available
    """
    try:
        logger.info("Fetching trip updates since sequence %d", last_sequence)

        # Validate input
        if last_sequence < 0:
            return JSONResponse(
                status_code=400,
                content={
                    "status": "error",
                    "has_update": False,
                    "message": "Invalid sequence number: must be non-negative",
                    "error_code": "INVALID_SEQUENCE",
                    "server_time": datetime.now(timezone.utc).isoformat(),
                },
            )

        # Check if database connection is healthy
        if not db_manager._connection_healthy:
            logger.error("Database connection is unhealthy")
            return JSONResponse(
                status_code=503,
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
        status_code = 500

        if (
            "Cannot connect to database" in error_message
            or "ServerSelectionTimeoutError" in error_message
        ):
            error_code = "DB_CONNECTION_ERROR"
            status_code = 503
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
async def clear_collection(collection: Dict[str, str]):
    try:
        name = collection.get("collection")
        if not name:
            raise HTTPException(status_code=400, detail="Missing 'collection' field")

        result = await delete_many_with_retry(db_manager.db[name], {})

        return {
            "message": f"Successfully cleared collection {name}",
            "deleted_count": result.deleted_count,
        }
    except Exception as e:
        logger.exception("Error clearing collection")
        raise HTTPException(status_code=500, detail=str(e))


# COVERAGE AREA MANAGEMENT


@app.get("/api/coverage_areas")
async def get_coverage_areas():
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
        logger.error("Error fetching coverage areas: %s", e)
        return {"success": False, "error": str(e)}


@app.post("/api/coverage_areas/delete")
async def delete_coverage_area(request: Request):
    try:
        data = await request.json()
        location = data.get("location")
        if not location or not isinstance(location, dict):
            raise HTTPException(status_code=400, detail="Invalid location data")

        display_name = location.get("display_name")
        if not display_name:
            raise HTTPException(status_code=400, detail="Invalid location display name")

        delete_result = await delete_one_with_retry(
            coverage_metadata_collection, {"location.display_name": display_name}
        )

        await delete_many_with_retry(
            streets_collection, {"properties.location": display_name}
        )

        if delete_result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Coverage area not found")

        return {"status": "success", "message": "Coverage area deleted successfully"}
    except Exception as e:
        logger.exception("Error deleting coverage area")
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/coverage_areas/cancel")
async def cancel_coverage_area(request: Request):
    try:
        data = await request.json()
        location = data.get("location")
        if not location or not isinstance(location, dict):
            raise HTTPException(status_code=400, detail="Invalid location data")

        display_name = location.get("display_name")
        if not display_name:
            raise HTTPException(status_code=400, detail="Invalid location display name")

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
        logger.exception("Error canceling coverage area")
        raise HTTPException(status_code=500, detail=str(e))


# APPLICATION LIFECYCLE


@app.on_event("startup")
async def startup_event():
    """
    Initialize database indexes and components on application startup.
    """
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
    except Exception:
        logger.exception("Failed to initialize database indexes.")
        raise  # Crash the application; we can't continue without indexes.


@app.on_event("shutdown")
async def shutdown_event():
    # Note: task_manager.stop() removed since Celery workers
    # are managed separately in Railway services

    # Close database connections to free memory
    await db_manager.cleanup_connections()

    # Clean up HTTP sessions
    await cleanup_session()

    logger.info("Application shutdown completed successfully")


# ERROR HANDLERS


@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    return JSONResponse(status_code=404, content={"error": "Endpoint not found"})


@app.exception_handler(500)
async def internal_error_handler(request: Request, exc):
    return JSONResponse(status_code=500, content={"error": "Internal server error"})


@app.get("/api/database/storage-info")
async def get_storage_info():
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
        logger.exception("Error getting storage info")
        # Return a sensible fallback value rather than raising an error
        return {"used_mb": 0, "limit_mb": 512, "usage_percent": 0, "error": str(e)}


@app.get("/api/coverage_areas/{location_id}")
async def get_coverage_area_details(location_id: str):
    try:
        # Find the coverage data
        coverage_doc = None

        try:
            # First try to find by ObjectId
            coverage_doc = await find_one_with_retry(
                coverage_metadata_collection, {"_id": ObjectId(location_id)}
            )
        except Exception as e:
            logger.warning(
                f"Error looking up by ObjectId: {str(e)}, trying by display name"
            )
            # If that fails, try to find by display name (fallback)
            coverage_doc = await find_one_with_retry(
                coverage_metadata_collection, {"location.display_name": location_id}
            )

        if not coverage_doc:
            logger.error(f"Coverage area not found for id: {location_id}")
            return {"success": False, "error": "Coverage area not found"}

        # Extract basic info
        location_name = coverage_doc.get("location", {}).get("display_name", "Unknown")
        location_obj = coverage_doc.get("location", {})
        # Use SerializationHelper instead of serialize_datetime
        last_updated = SerializationHelper.serialize_datetime(
            coverage_doc.get("last_updated")
        )
        total_length = coverage_doc.get("total_length", 0)
        driven_length = coverage_doc.get("driven_length", 0)
        coverage_percentage = coverage_doc.get("coverage_percentage", 0)

        # Check if streets_data exists and is properly formed
        streets_data = coverage_doc.get("streets_data", {})
        has_valid_street_data = (
            isinstance(streets_data, dict)
            and isinstance(streets_data.get("features"), list)
            and len(streets_data.get("features", [])) > 0
        )

        # If no valid street data, return a special response
        if not has_valid_street_data:
            logger.error(
                f"No or invalid streets_data found for location: {location_name}"
            )

            # Get metadata about the coverage document for debugging
            status = coverage_doc.get("status", "unknown")
            last_error = coverage_doc.get("last_error", "No error message available")

            return {
                "success": True,
                "coverage": {
                    "location_name": location_name,
                    "location": location_obj,
                    "total_length": total_length,
                    "driven_length": driven_length,
                    "coverage_percentage": coverage_percentage,
                    "last_updated": last_updated,
                    "streets_geojson": {},
                    "total_streets": 0,
                    "street_types": [],
                    "status": status,
                    "has_error": status == "error",
                    "error_message": last_error if status == "error" else None,
                    "needs_reprocessing": True,
                },
            }

        # Get street types from the document if they exist, otherwise compute
        # them
        street_types = coverage_doc.get("street_types", [])
        if not street_types:
            street_types = collect_street_type_stats(streets_data.get("features", []))

        # Transform data for the dashboard with complete information
        result = {
            "success": True,
            "coverage": {
                "location_name": location_name,
                "location": location_obj,
                "total_length": total_length,
                "driven_length": driven_length,
                "coverage_percentage": coverage_percentage,
                "last_updated": last_updated,
                "total_streets": len(streets_data.get("features", [])),
                "streets_geojson": streets_data,
                "street_types": street_types,
                "status": coverage_doc.get("status", "completed"),
                "has_error": coverage_doc.get("status") == "error",
                "error_message": (
                    coverage_doc.get("last_error")
                    if coverage_doc.get("status") == "error"
                    else None
                ),
                "needs_reprocessing": False,
            },
        }
        return result
    except Exception as e:
        logger.error(
            f"Error fetching coverage area details: {str(e)}",
            exc_info=True,
        )
        return {"success": False, "error": str(e)}


def collect_street_type_stats(features):
    """Collect statistics about street types and their coverage"""
    street_types = defaultdict(
        lambda: {"total": 0, "covered": 0, "length": 0, "covered_length": 0}
    )

    for feature in features:
        street_type = feature.get("properties", {}).get("highway", "unknown")
        length = feature.get("properties", {}).get("segment_length", 0)
        is_covered = feature.get("properties", {}).get("driven", False)

        street_types[street_type]["total"] += 1
        street_types[street_type]["length"] += length

        if is_covered:
            street_types[street_type]["covered"] += 1
            street_types[street_type]["covered_length"] += length

    # Convert to list format for easier consumption in frontend
    result = []
    for street_type, stats in street_types.items():
        coverage_pct = (
            (stats["covered_length"] / stats["length"] * 100)
            if stats["length"] > 0
            else 0
        )
        result.append(
            {
                "type": street_type,
                "total": stats["total"],
                "covered": stats["covered"],
                "length": stats["length"],
                "covered_length": stats["covered_length"],
                "coverage_percentage": coverage_pct,
            }
        )

    # Sort by total length descending
    result.sort(key=lambda x: x["length"], reverse=True)
    return result


@app.get("/api/export/advanced")
async def export_advanced(request: Request):
    """
    Advanced configurable export for trips data.

    Allows fine-grained control over data sources, fields to include,
    date range, and export format.
    """
    # Get export format
    fmt = request.query_params.get("format", "json").lower()

    # Get data source preferences
    include_trips = request.query_params.get("include_trips", "true").lower() == "true"
    include_matched_trips = (
        request.query_params.get("include_matched_trips", "true").lower() == "true"
    )
    include_uploaded_trips = (
        request.query_params.get("include_uploaded_trips", "true").lower() == "true"
    )

    # Get data field preferences
    include_basic_info = (
        request.query_params.get("include_basic_info", "true").lower() == "true"
    )
    include_locations = (
        request.query_params.get("include_locations", "true").lower() == "true"
    )
    include_telemetry = (
        request.query_params.get("include_telemetry", "true").lower() == "true"
    )
    include_geometry = (
        request.query_params.get("include_geometry", "true").lower() == "true"
    )
    include_meta = request.query_params.get("include_meta", "true").lower() == "true"
    include_custom = (
        request.query_params.get("include_custom", "true").lower() == "true"
    )

    # Get CSV-specific options
    include_gps_in_csv = (
        request.query_params.get("include_gps_in_csv", "false").lower() == "true"
    )
    flatten_location_fields = (
        request.query_params.get("flatten_location_fields", "true").lower() == "true"
    )

    # Date filtering
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

    # Database access
    db_manager = DatabaseManager()

    try:
        # Get trips from regular trips collection
        if include_trips:
            trips_collection = db_manager.get_collection("trips")
            query = date_filter or {}
            regular_trips = await find_with_retry(trips_collection, query)

            # Process each trip based on field preferences
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
                    processed_trip["trip_type"] = "regular"
                    trips.append(processed_trip)

        # Get trips from map-matched trips collection
        if include_matched_trips:
            matched_trips_collection = db_manager.get_collection("matched_trips")
            query = date_filter or {}
            matched_trips = await find_with_retry(matched_trips_collection, query)

            # Process each matched trip based on field preferences
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

        # Get trips from uploaded trips collection
        if include_uploaded_trips:
            uploaded_trips_collection = db_manager.get_collection("uploaded_trips")
            query = date_filter or {}
            uploaded_trips = await find_with_retry(uploaded_trips_collection, query)

            # Process each uploaded trip based on field preferences
            for trip in uploaded_trips:
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
                    processed_trip["trip_type"] = "uploaded"
                    trips.append(processed_trip)

        # Format timestamp for filename
        current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename_base = f"trips_export_{current_time}"

        # If CSV format is requested, build the CSV data
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

        # If JSON format is requested, return JSON data directly
        if fmt == "json":
            return JSONResponse(
                content=json.loads(json.dumps(trips, default=default_serializer))
            )

        # For other formats (GeoJSON, GPX, Shapefile), use the existing export response creator
        try:
            return await create_export_response(
                trips,
                fmt,
                filename_base,
                include_gps_in_csv=include_gps_in_csv,
                flatten_location_fields=flatten_location_fields,
            )
        except ValueError as e:
            logger.error("Export error: %s", e)
            raise HTTPException(status_code=400, detail=str(e))

    except Exception as e:
        logger.error("Error in advanced export: %s", str(e))
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


async def process_trip_for_export(
    trip: Dict[str, Any],
    include_basic_info: bool = True,
    include_locations: bool = True,
    include_telemetry: bool = True,
    include_geometry: bool = True,
    include_meta: bool = True,
    include_custom: bool = True,
) -> Dict[str, Any]:
    """
    Process a trip dictionary based on field preferences for export.

    Args:
        trip: Original trip dictionary
        include_*: Booleans indicating which fields to include

    Returns:
        Dict: Processed trip with only the requested fields
    """
    result = {}

    # Define field mappings for each category
    basic_info_fields = [
        "_id",
        "transactionId",
        "trip_id",
        "startTime",
        "endTime",
        "duration",
        "durationInMinutes",
        "completed",
        "active",
    ]

    location_fields = [
        "startLocation",
        "destination",
        "startAddress",
        "endAddress",
        "startPoint",
        "endPoint",
        "state",
        "city",
    ]

    telemetry_fields = [
        "distance",
        "distanceInMiles",
        "startOdometer",
        "endOdometer",
        "maxSpeed",
        "averageSpeed",
        "idleTime",
        "fuelConsumed",
        "fuelEconomy",
        "speedingEvents",
    ]

    geometry_fields = ["gps", "path", "simplified_path", "route", "geometry"]

    meta_fields = [
        "deviceId",
        "imei",
        "vehicleId",
        "source",
        "processingStatus",
        "processingTime",
        "mapMatchStatus",
        "confidence",
        "insertedAt",
        "updatedAt",
    ]

    custom_fields = ["notes", "tags", "category", "purpose", "customFields"]

    # Copy fields according to preferences
    all_fields = []
    if include_basic_info:
        all_fields.extend(basic_info_fields)
    if include_locations:
        all_fields.extend(location_fields)
    if include_telemetry:
        all_fields.extend(telemetry_fields)
    if include_geometry:
        all_fields.extend(geometry_fields)
    if include_meta:
        all_fields.extend(meta_fields)
    if include_custom:
        all_fields.extend(custom_fields)

    # Copy fields from original trip
    for field in all_fields:
        if field in trip:
            result[field] = trip[field]

    # Always include _id for reference
    if "_id" not in result and "_id" in trip:
        result["_id"] = trip["_id"]

    return result


async def create_csv_export(
    trips: List[Dict[str, Any]],
    include_gps_in_csv: bool = False,
    flatten_location_fields: bool = True,
) -> str:
    """
    Convert trip dictionaries to CSV format.

    Args:
        trips: List of trip dictionaries
        include_gps_in_csv: Whether to include GPS data as JSON strings
        flatten_location_fields: Whether to flatten location fields into separate columns

    Returns:
        str: CSV data as a string
    """
    if not trips:
        return "No data to export"

    import csv
    from io import StringIO

    # Create CSV buffer
    output = StringIO()

    # Prepare flattened fieldnames if needed
    location_fields = []
    if flatten_location_fields:
        location_fields = [
            "startLocation_formatted_address",
            "startLocation_street_number",
            "startLocation_street",
            "startLocation_city",
            "startLocation_county",
            "startLocation_state",
            "startLocation_postal_code",
            "startLocation_country",
            "startLocation_lat",
            "startLocation_lng",
            "destination_formatted_address",
            "destination_street_number",
            "destination_street",
            "destination_city",
            "destination_county",
            "destination_state",
            "destination_postal_code",
            "destination_country",
            "destination_lat",
            "destination_lng",
        ]

    # Collect all possible field names from all trips
    fieldnames = set()
    for trip in trips:
        fieldnames.update(trip.keys())

    # Add location fields if flattening
    if flatten_location_fields:
        fieldnames.update(location_fields)
        # Remove the original location fields since we'll flatten them
        if "startLocation" in fieldnames:
            fieldnames.remove("startLocation")
        if "destination" in fieldnames:
            fieldnames.remove("destination")

    # Sort fields for consistent order
    fieldnames = sorted(fieldnames)

    # Move important fields to the beginning for better readability
    priority_fields = [
        "_id",
        "transactionId",
        "trip_id",
        "trip_type",
        "startTime",
        "endTime",
    ] + (location_fields if flatten_location_fields else [])

    for field in reversed(priority_fields):
        if field in fieldnames:
            fieldnames.remove(field)
            fieldnames.insert(0, field)

    # Create CSV writer
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()

    # Write each trip as a row, handling nested objects
    for trip in trips:
        flat_trip = {}
        for key, value in trip.items():
            # Handle GPS and geometry fields based on user preference
            if key in ["gps", "geometry", "path", "simplified_path", "route"]:
                if include_gps_in_csv:
                    # Include as JSON string if requested
                    flat_trip[key] = json.dumps(value, default=default_serializer)
                else:
                    flat_trip[key] = "[Geometry data not included in CSV format]"
            # Handle location fields if flattening is enabled
            elif flatten_location_fields and key in ["startLocation", "destination"]:
                # Skip the original field, we'll add flattened versions below
                pass
            # Handle nested objects by converting to JSON string
            elif isinstance(value, (dict, list)):
                flat_trip[key] = json.dumps(value, default=default_serializer)
            # Handle dates
            elif isinstance(value, datetime):
                flat_trip[key] = value.isoformat()
            else:
                flat_trip[key] = value

        # Add flattened location fields if needed
        if flatten_location_fields:
            # Process startLocation
            start_loc = trip.get("startLocation", {})
            if isinstance(start_loc, str):
                try:
                    start_loc = json.loads(start_loc)
                except json.JSONDecodeError:
                    start_loc = {}

            if isinstance(start_loc, dict):
                flat_trip["startLocation_formatted_address"] = start_loc.get(
                    "formatted_address", ""
                )

                # Extract address components
                addr_comps = start_loc.get("address_components", {})
                if isinstance(addr_comps, dict):
                    flat_trip["startLocation_street_number"] = addr_comps.get(
                        "street_number", ""
                    )
                    flat_trip["startLocation_street"] = addr_comps.get("street", "")
                    flat_trip["startLocation_city"] = addr_comps.get("city", "")
                    flat_trip["startLocation_county"] = addr_comps.get("county", "")
                    flat_trip["startLocation_state"] = addr_comps.get("state", "")
                    flat_trip["startLocation_postal_code"] = addr_comps.get(
                        "postal_code", ""
                    )
                    flat_trip["startLocation_country"] = addr_comps.get("country", "")

                # Extract coordinates
                coords = start_loc.get("coordinates", {})
                if isinstance(coords, dict):
                    flat_trip["startLocation_lat"] = coords.get("lat", "")
                    flat_trip["startLocation_lng"] = coords.get("lng", "")

            # Process destination
            dest = trip.get("destination", {})
            if isinstance(dest, str):
                try:
                    dest = json.loads(dest)
                except json.JSONDecodeError:
                    dest = {}

            if isinstance(dest, dict):
                flat_trip["destination_formatted_address"] = dest.get(
                    "formatted_address", ""
                )

                # Extract address components
                addr_comps = dest.get("address_components", {})
                if isinstance(addr_comps, dict):
                    flat_trip["destination_street_number"] = addr_comps.get(
                        "street_number", ""
                    )
                    flat_trip["destination_street"] = addr_comps.get("street", "")
                    flat_trip["destination_city"] = addr_comps.get("city", "")
                    flat_trip["destination_county"] = addr_comps.get("county", "")
                    flat_trip["destination_state"] = addr_comps.get("state", "")
                    flat_trip["destination_postal_code"] = addr_comps.get(
                        "postal_code", ""
                    )
                    flat_trip["destination_country"] = addr_comps.get("country", "")

                # Extract coordinates
                coords = dest.get("coordinates", {})
                if isinstance(coords, dict):
                    flat_trip["destination_lat"] = coords.get("lat", "")
                    flat_trip["destination_lng"] = coords.get("lng", "")

        writer.writerow(flat_trip)

    return output.getvalue()


@app.get("/ai-insights", response_class=HTMLResponse)
async def ai_insights_page(request: Request):
    """Render the AI-powered insights page"""
    return templates.TemplateResponse(
        "ai_insights.html", {"request": request, "environ": os.environ}
    )


@app.get("/api/ai-insights", response_class=JSONResponse)
async def get_ai_insights(request: Request):
    try:
        # Get date range from request, similar to other analytics endpoints
        query = await build_query_from_request(request)

        # Fetch trip data from both collections using the query
        regular_future = find_with_retry(trips_collection, query)
        uploaded_future = find_with_retry(uploaded_trips_collection, query)
        regular, uploaded = await asyncio.gather(regular_future, uploaded_future)

        all_trips = regular + uploaded

        # Format data for AI analysis
        trip_data = []
        for trip in all_trips:
            # Extract key information
            try:
                st = trip.get("startTime")
                et = trip.get("endTime")

                if not st or not et:
                    continue

                # Parse datetime fields if needed
                if isinstance(st, str):
                    st = dateutil_parser.isoparse(st)
                if isinstance(et, str):
                    et = dateutil_parser.isoparse(et)
                if st.tzinfo is None:
                    st = st.replace(tzinfo=timezone.utc)
                if et.tzinfo is None:
                    et = et.replace(tzinfo=timezone.utc)

                # Create a simplified trip record
                trip_record = {
                    "transaction_id": trip.get("transactionId", "unknown"),
                    "start_time": st.isoformat(),
                    "end_time": et.isoformat(),
                    "start_location": trip.get("startLocation", "Unknown"),
                    "destination": trip.get("destination", "Unknown"),
                    "distance": float(trip.get("distance", 0)),
                    "max_speed": float(trip.get("maxSpeed", 0)),
                    "average_speed": (
                        float(trip.get("averageSpeed", 0))
                        if trip.get("averageSpeed")
                        else 0
                    ),
                    "idle_duration": trip.get("totalIdleDuration", 0),
                    "fuel_consumed": float(trip.get("fuelConsumed", 0)),
                    "hard_braking_count": (
                        int(trip.get("hardBrakingCount", 0))
                        if trip.get("hardBrakingCount")
                        else 0
                    ),
                    "hard_acceleration_count": (
                        int(trip.get("hardAccelerationCount", 0))
                        if trip.get("hardAccelerationCount")
                        else 0
                    ),
                }

                # Extract coordinates if available
                geom = trip.get("gps")
                if isinstance(geom, str):
                    geom = json.loads(geom)

                if geom and isinstance(geom, dict) and geom.get("type") == "LineString":
                    trip_record["coordinates"] = geom.get("coordinates", [])

                trip_data.append(trip_record)
            except Exception as e:
                logger.warning(f"Error processing trip for AI analysis: {str(e)}")
                continue

        # Get insights from Google Gemini API
        ai_insights = await get_gemini_insights(trip_data)

        # Return combined data
        return JSONResponse(
            content={"trip_data": trip_data, "ai_insights": ai_insights}
        )
    except Exception as e:
        logger.exception("Error in get_ai_insights")
        raise HTTPException(status_code=500, detail=str(e))


async def get_gemini_insights(trip_data):
    """Process trip data with Google Gemini to get insights"""
    try:
        # Configure the Gemini API with your key
        genai.configure(api_key=os.environ.get("GOOGLE_API_KEY"))

        # If no trips, return empty insights
        if not trip_data:
            return {
                "summary": "No trip data available for the selected time period.",
                "driving_patterns": [],
                "efficiency_tips": [],
                "route_insights": [],
                "safety_insights": [],
            }

        # Prepare data for Gemini
        prompt = f"""
        You are an advanced geospatial and location intelligence analyst tasked with discovering deep, meaningful patterns in driving data. Analyze the following trip data and provide sophisticated insights that would be impossible for a human to discern without machine learning algorithms. 
        
        IMPORTANT: Focus EXCLUSIVELY on location patterns, spatial relationships, temporal patterns, and route optimization. DO NOT include any analysis related to braking, acceleration, or other vehicle performance metrics as these are not reliable in this dataset.
        
        Trip data: {json.dumps(trip_data, indent=2)}
        
        Provide insights in these specific categories:
        
        1. SUMMARY: Create a comprehensive, data-driven summary of the overall driving patterns, identifying key locations, frequency of visits, and time patterns. Include specific locations, frequencies, and measurable patterns.
        
        2. LOCATION PATTERNS: Identify surprising or non-obvious location-based patterns, such as:
           - Clusters of frequently visited locations
           - Temporal patterns in location visits (time of day, day of week patterns)
           - Potential correlations between locations visited
           - Hidden "hub and spoke" patterns in movement
           - Geographic boundaries or "territories" of movement

        3. ROUTE OPTIMIZATION OPPORTUNITIES: Provide specific, data-driven route optimization suggestions based on:
           - Redundant or overlapping route segments
           - Traffic pattern analysis based on time/location data
           - Potential route consolidation opportunities
           - Specific shortcuts or alternate routes with precise location references
           - Time-sensitive optimizations (e.g., different optimal routes at different times)
        
        4. PREDICTIVE INSIGHTS: Use the spatial and temporal patterns to make specific predictions:
           - Future likely destinations based on time, day, and starting point
           - Optimal departure times for common routes
           - Location-based correlations and relationships
           - Potential "missing" locations that fit the pattern but haven't been visited
        
        Format the response as a JSON object with the following structure:
        {{
            "summary": "Detailed, location-specific summary of the driving data",
            "driving_patterns": ["specific pattern 1 with locations and frequencies", "specific pattern 2 with locations and frequencies", ...],
            "route_insights": ["specific route insight 1 with exact locations", "specific route insight 2 with exact locations", ...],
            "predictive_insights": ["specific prediction 1 with actionable detail", "specific prediction 2 with actionable detail", ...]
        }}
        
        Make all insights HIGHLY SPECIFIC and DATA-DRIVEN:
        - Include exact location names, frequencies, and measurable patterns
        - Avoid generic advice like "reduce idle time" or "maintain consistent speed"
        - Focus on non-obvious insights that would require machine learning to discover
        - Provide actionable intelligence, not surface-level observations
        - When suggesting route optimizations, reference specific roads, intersections, or shortcuts
        
        Only include the JSON in your response, no other text.
        """

        # Generate content with Gemini
        model = genai.GenerativeModel("gemini-2.0-flash")
        response = model.generate_content(prompt)

        # Parse the response
        try:
            content_text = response.text
            # Clean up the response in case it contains markdown code blocks
            if "```json" in content_text:
                content_text = content_text.split("```json")[1].split("```")[0].strip()
            elif "```" in content_text:
                content_text = content_text.split("```")[1].split("```")[0].strip()

            insights = json.loads(content_text)
            return insights
        except json.JSONDecodeError:
            # Fallback if JSON parsing fails
            logger.warning("Failed to parse Gemini response as JSON")
            return {
                "summary": "AI analysis unavailable at this time.",
                "driving_patterns": ["Data analysis incomplete"],
                "route_insights": ["Route analysis unavailable"],
                "predictive_insights": ["Predictive analysis unavailable"],
            }
    except Exception as e:
        logger.exception("Error in get_gemini_insights: %s", str(e))
        return {
            "summary": "AI analysis encountered an error.",
            "driving_patterns": ["Data analysis incomplete due to an error"],
            "route_insights": ["Route analysis unavailable"],
            "predictive_insights": ["Predictive analysis unavailable"],
        }


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run("app:app", host="0.0.0.0", port=port, log_level="info", reload=True)
