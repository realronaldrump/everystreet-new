import os
import json
import logging
import asyncio
import zipfile
import glob
import io
import uuid
import tempfile
from datetime import datetime, timedelta, timezone
from math import radians, cos, sin, sqrt, atan2
from typing import List, Dict, Any, Optional, Union

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
from fastapi import FastAPI, Request, WebSocket, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.templating import Jinja2Templates
from fastapi.responses import JSONResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect

# Local module imports
from timestamp_utils import get_trip_timestamps, sort_and_filter_trip_coordinates
from update_geo_points import update_geo_points
from utils import validate_location_osm, reverse_geocode_nominatim, cleanup_session
from map_matching import process_and_map_match_trip
from bouncie_trip_fetcher import fetch_bouncie_trips_in_range
from preprocess_streets import preprocess_streets as async_preprocess_streets
from tasks import task_manager
from db import (
    trips_collection,
    matched_trips_collection,
    historical_trips_collection,
    uploaded_trips_collection,
    live_trips_collection,
    archived_live_trips_collection,
    task_config_collection,
    osm_data_collection,
    streets_collection,
    coverage_metadata_collection,
    places_collection,
    task_history_collection,
    init_task_history_collection,
    progress_collection,
    ensure_street_coverage_indexes,
    db_manager,
    db,
)
from trip_processing import format_idle_time, process_trip_data
from export_helpers import create_geojson, create_gpx
from street_coverage_calculation import compute_coverage_for_location

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
SECRET_KEY = os.getenv("SECRET_KEY", "supersecretfallback")
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_CODE = os.getenv("AUTHORIZATION_CODE")
AUTHORIZED_DEVICES = [d for d in os.getenv("AUTHORIZED_DEVICES", "").split(",") if d]
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"
OVERPASS_URL = "http://overpass-api.de/api/interpreter"


# ------------------------------------------------------------------------------
# Helper Functions
# ------------------------------------------------------------------------------


def serialize_datetime(dt: Optional[datetime]) -> Optional[str]:
    """Return ISO formatted datetime string if dt is not None."""
    return dt.isoformat() if dt else None


def serialize_trip(trip: dict) -> dict:
    """Convert ObjectId and datetime fields in a trip dict to serializable types."""
    if "_id" in trip:
        trip["_id"] = str(trip["_id"])
    for key in ("startTime", "endTime"):
        if key in trip and isinstance(trip[key], datetime):
            trip[key] = trip[key].isoformat()
    return trip


def parse_query_date(
    date_str: Optional[str], end_of_day: bool = False
) -> Optional[datetime]:
    """
    Parse a date string into a datetime object.
    Replaces trailing "Z" with "+00:00" for ISO8601 compatibility.
    """
    if not date_str:
        return None
    date_str = date_str.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(date_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if end_of_day:
            dt = dt.replace(hour=23, minute=59, second=59, microsecond=999999)
        return dt
    except ValueError:
        try:
            dt2 = datetime.strptime(date_str, "%Y-%m-%d")
            dt2 = dt2.replace(tzinfo=timezone.utc)
            if end_of_day:
                dt2 = dt2.replace(hour=23, minute=59, second=59, microsecond=999999)
            return dt2
        except ValueError:
            logger.warning(
                "Unable to parse date string '%s'; returning None.", date_str
            )
            return None


# ------------------------------------------------------------------------------
# WebSocket Connection Manager
# ------------------------------------------------------------------------------


class ConnectionManager:
    """
    Manages WebSocket connections and broadcast messages.
    """

    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception:
                pass


manager = ConnectionManager()


# ------------------------------------------------------------------------------
# Custom Place Class
# ------------------------------------------------------------------------------


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


# ------------------------------------------------------------------------------
# BASIC PAGES
# ------------------------------------------------------------------------------


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
        db_stats = await db.command("dbStats")
        storage_used_mb = round(db_stats["dataSize"] / (1024 * 1024), 2)
        storage_limit_mb = 512  # Example free-tier limit
        storage_usage_percent = round((storage_used_mb / storage_limit_mb) * 100, 2)
        collections_info = []
        for collection_name in await db.list_collection_names():
            stats = await db.command("collStats", collection_name)
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


# ------------------------------------------------------------------------------
# MIDDLEWARE
# ------------------------------------------------------------------------------


@app.middleware("http")
async def add_header(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# ------------------------------------------------------------------------------
# BACKGROUND TASKS CONFIG / CONTROL
# ------------------------------------------------------------------------------


@app.get("/api/background_tasks/config")
async def get_background_tasks_config():
    try:
        config = await task_manager.get_config()
        for task_id, task_def in task_manager.tasks.items():
            if task_id not in config["tasks"]:
                config["tasks"][task_id] = {}
            task_config = config["tasks"][task_id]
            task_config["display_name"] = task_def.display_name
            task_config["description"] = task_def.description
            task_config["priority"] = task_def.priority.name
            task_config["status"] = task_config.get("status", "IDLE")
            task_config["interval_minutes"] = task_config.get(
                "interval_minutes", task_def.default_interval_minutes
            )
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
        return config
    except Exception as e:
        logger.exception("Error getting task configuration.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/config")
async def update_background_tasks_config(request: Request):
    try:
        data = await request.json()
        config = await task_manager.get_config()
        if "globalDisable" in data:
            config["disabled"] = data["globalDisable"]
        if "tasks" in data:
            for task_id, task_config in data["tasks"].items():
                if task_id in task_manager.tasks:
                    if task_id not in config["tasks"]:
                        config["tasks"][task_id] = {}
                    if "enabled" in task_config:
                        config["tasks"][task_id]["enabled"] = task_config["enabled"]
                    if "interval_minutes" in task_config:
                        config["tasks"][task_id]["interval_minutes"] = task_config[
                            "interval_minutes"
                        ]
        await task_config_collection.replace_one(
            {"_id": "global_background_task_config"}, config, upsert=True
        )
        await task_manager.reinitialize_tasks()
        return {"status": "success", "message": "Configuration updated"}
    except Exception as e:
        logger.exception("Error updating task configuration.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/pause")
async def pause_background_tasks(request: Request):
    try:
        data = await request.json()
        minutes = data.get("minutes", 30)
        config = await task_manager.get_config()
        config["disabled"] = True
        await task_config_collection.replace_one(
            {"_id": "global_background_task_config"}, config, upsert=True
        )
        await task_manager.stop()
        return {
            "status": "success",
            "message": f"Background tasks paused for {minutes} minutes",
        }
    except Exception as e:
        logger.exception("Error pausing tasks.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/resume")
async def resume_background_tasks():
    try:
        config = await task_manager.get_config()
        config["disabled"] = False
        await task_config_collection.replace_one(
            {"_id": "global_background_task_config"}, config, upsert=True
        )
        await task_manager.start()
        return {"status": "success", "message": "Background tasks resumed"}
    except Exception as e:
        logger.exception("Error resuming tasks.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/stop_all")
async def stop_all_background_tasks():
    try:
        await task_manager.stop()
        return {"status": "success", "message": "All background tasks stopped"}
    except Exception as e:
        logger.exception("Error stopping all tasks.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/enable")
async def enable_all_background_tasks():
    config = await task_manager.get_config()
    for task_id in task_manager.tasks:
        if task_id not in config["tasks"]:
            config["tasks"][task_id] = {}
        config["tasks"][task_id]["enabled"] = True
    await task_config_collection.replace_one(
        {"_id": "global_background_task_config"}, config, upsert=True
    )
    await task_manager.reinitialize_tasks()
    return {"status": "success", "message": "All background tasks enabled"}


@app.post("/api/background_tasks/disable")
async def disable_all_background_tasks():
    config = await task_manager.get_config()
    for task_id in task_manager.tasks:
        if task_id not in config["tasks"]:
            config["tasks"][task_id] = {}
        config["tasks"][task_id]["enabled"] = False
    await task_config_collection.replace_one(
        {"_id": "global_background_task_config"}, config, upsert=True
    )
    await task_manager.stop()
    return {"status": "success", "message": "All background tasks disabled"}


@app.post("/api/background_tasks/manual_run")
async def manually_run_tasks(request: Request):
    try:
        data = await request.json()
        tasks_to_run = data.get("tasks", [])
        results = []
        config = await task_manager.get_config()
        for task_id in tasks_to_run:
            if task_id == "ALL":
                for t_id in task_manager.tasks:
                    if config["tasks"].get(t_id, {}).get("enabled", True):
                        try:
                            task_manager.scheduler.add_job(
                                task_manager.get_task_function(t_id),
                                id=f"{t_id}_manual_{datetime.now(timezone.utc).timestamp()}",
                                trigger="date",
                                run_date=datetime.now(timezone.utc),
                                max_instances=1,
                                coalesce=True,
                                misfire_grace_time=None,
                            )
                            results.append({"task": t_id, "success": True})
                        except Exception as ex:
                            logger.exception("Error scheduling task %s", t_id)
                            results.append(
                                {"task": t_id, "success": False, "error": str(ex)}
                            )
            elif task_id in task_manager.tasks:
                try:
                    task_manager.scheduler.add_job(
                        task_manager.get_task_function(task_id),
                        id=f"{task_id}_manual_{datetime.now(timezone.utc).timestamp()}",
                        trigger="date",
                        run_date=datetime.now(timezone.utc),
                        max_instances=1,
                        coalesce=True,
                        misfire_grace_time=None,
                    )
                    results.append({"task": task_id, "success": True})
                except Exception as ex:
                    logger.exception("Error scheduling task %s", task_id)
                    results.append(
                        {"task": task_id, "success": False, "error": str(ex)}
                    )
            else:
                results.append(
                    {"task": task_id, "success": False, "error": "Unknown task"}
                )
        return {
            "status": "success",
            "message": f"Triggered {len(results)} tasks",
            "results": results,
        }
    except Exception as e:
        logger.exception("Error in manually_run_tasks")
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------------------
# TASK HISTORY ENDPOINTS
# ------------------------------------------------------------------------------


@app.get("/api/background_tasks/history")
async def get_task_history():
    try:
        history = []
        cursor = task_history_collection.find({}).sort("timestamp", -1).limit(100)
        entries = await cursor.to_list(length=None)
        for entry in entries:
            entry["_id"] = str(entry["_id"])
            entry["timestamp"] = serialize_datetime(entry.get("timestamp"))
            if "runtime" in entry:
                entry["runtime"] = float(entry["runtime"]) if entry["runtime"] else None
            history.append(entry)
        return history
    except Exception as e:
        logger.exception("Error fetching task history.")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/history/clear")
async def clear_task_history():
    try:
        result = await task_history_collection.delete_many({})
        return {
            "status": "success",
            "message": f"Cleared {result.deleted_count} task history entries",
        }
    except Exception as e:
        logger.exception("Error clearing task history.")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/background_tasks/task/{task_id}")
async def get_task_details(task_id: str):
    try:
        task_def = task_manager.tasks.get(task_id)
        if not task_def:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
        config = await task_manager.get_config()
        task_config = config.get("tasks", {}).get(task_id, {})
        history_cursor = (
            task_history_collection.find({"task_id": task_id})
            .sort("timestamp", -1)
            .limit(5)
        )
        history_docs = await history_cursor.to_list(length=None)
        history = []
        for entry in history_docs:
            entry["_id"] = str(entry["_id"])
            history.append(
                {
                    "timestamp": serialize_datetime(entry.get("timestamp")),
                    "status": entry["status"],
                    "runtime": entry.get("runtime"),
                    "error": entry.get("error"),
                }
            )
        return {
            "id": task_id,
            "display_name": task_def.display_name,
            "description": task_def.description,
            "priority": (
                task_def.priority.name
                if hasattr(task_def.priority, "name")
                else str(task_def.priority)
            ),
            "dependencies": task_def.dependencies,
            "status": task_config.get("status", "IDLE"),
            "enabled": task_config.get("enabled", True),
            "interval_minutes": task_config.get(
                "interval_minutes", task_def.default_interval_minutes
            ),
            "last_run": serialize_datetime(task_config.get("last_run")),
            "next_run": serialize_datetime(task_config.get("next_run")),
            "start_time": serialize_datetime(task_config.get("start_time")),
            "end_time": serialize_datetime(task_config.get("end_time")),
            "last_error": task_config.get("last_error"),
            "history": history,
        }
    except Exception as e:
        logger.exception("Error getting task details for %s", task_id)
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------------------
# EDIT TRIPS ENDPOINTS
# ------------------------------------------------------------------------------


@app.get("/api/edit_trips")
async def get_edit_trips(request: Request):
    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")
        trip_type = request.query_params.get("type")
        start_date = parse_query_date(start_date_str)
        end_date = parse_query_date(end_date_str, end_of_day=True)
        if not trip_type or trip_type not in ["trips", "matched_trips"]:
            raise HTTPException(status_code=400, detail="Invalid trip type")
        collection = (
            trips_collection if trip_type == "trips" else matched_trips_collection
        )
        query: Dict[str, Any] = {}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        docs = await collection.find(query).to_list(length=None)
        docs = [serialize_trip(doc) for doc in docs]
        return {"status": "success", "trips": docs}
    except Exception as e:
        logger.exception("Error fetching trips for editing.")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.put("/api/trips/{trip_id}")
async def update_trip(trip_id: str, request: Request):
    try:
        data = await request.json()
        trip_type = data.get("type")
        geometry = data.get("geometry")
        props = data.get("properties", {})
        collection = (
            matched_trips_collection
            if trip_type == "matched_trips"
            else trips_collection
        )
        trip = await collection.find_one(
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]}
        )
        if not trip:
            other_collection = (
                trips_collection
                if trip_type == "matched_trips"
                else matched_trips_collection
            )
            trip = await other_collection.find_one(
                {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]}
            )
            if trip:
                collection = other_collection
        if not trip:
            raise HTTPException(status_code=404, detail=f"No trip found for {trip_id}")
        update_fields = {"updatedAt": datetime.now(timezone.utc)}
        if geometry and isinstance(geometry, dict):
            gps_data = {"type": "LineString", "coordinates": geometry["coordinates"]}
            update_fields["geometry"] = geometry
            update_fields["gps"] = json.dumps(gps_data)
        if props:
            for field in ["startTime", "endTime"]:
                if field in props and isinstance(props[field], str):
                    try:
                        props[field] = dateutil_parser.isoparse(props[field])
                    except ValueError:
                        pass
            for field in ["distance", "maxSpeed", "totalIdleDuration", "fuelConsumed"]:
                if field in props and props[field] is not None:
                    try:
                        props[field] = float(props[field])
                    except ValueError:
                        pass
            if "properties" in trip:
                updated_props = {**trip["properties"], **props}
                update_fields["properties"] = updated_props
            else:
                update_fields.update(props)
        result = await collection.update_one(
            {"_id": trip["_id"]}, {"$set": update_fields}
        )
        if not result.modified_count:
            raise HTTPException(status_code=400, detail="No changes made")
        return {"message": "Trip updated"}
    except Exception as e:
        logger.exception("Error updating trip %s", trip_id)
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------------------
# STREET COVERAGE / COMPUTATIONS
# ------------------------------------------------------------------------------


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
    try:
        result = await compute_coverage_for_location(location, task_id)
        if result:
            display_name = location.get("display_name", "Unknown")
            await coverage_metadata_collection.update_one(
                {"location.display_name": display_name},
                {
                    "$set": {
                        "location": location,
                        "total_length": result["total_length"],
                        "driven_length": result["driven_length"],
                        "coverage_percentage": result["coverage_percentage"],
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
                upsert=True,
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
        else:
            await progress_collection.update_one(
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "error": "No result returned from coverage calculation",
                        "updated_at": datetime.now(timezone.utc),
                    }
                },
            )
    except Exception as e:
        logger.exception("Error in background coverage calculation.")
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


@app.get("/api/street_coverage/{task_id}")
async def get_coverage_status(task_id: str):
    progress = await progress_collection.find_one({"_id": task_id})
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


# ------------------------------------------------------------------------------
# TRIPS (REGULAR, UPLOADED, HISTORICAL)
# ------------------------------------------------------------------------------


@app.get("/api/trips")
async def get_trips(request: Request):
    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")
        imei = request.query_params.get("imei")
        start_date = parse_query_date(start_date_str)
        end_date = parse_query_date(end_date_str, end_of_day=True)
        query: Dict[str, Any] = {}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        if imei:
            query["imei"] = imei
        regular_future = trips_collection.find(query).to_list(None)
        uploaded_future = uploaded_trips_collection.find(query).to_list(None)
        historical_future = historical_trips_collection.find(query).to_list(None)
        regular, uploaded, historical = await asyncio.gather(
            regular_future, uploaded_future, historical_future
        )
        all_trips = regular + uploaded + historical
        features = []
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
                    st = st.replace(tzinfo=timezone.utc)
                if et.tzinfo is None:
                    et = et.replace(tzinfo=timezone.utc)
                geom = trip.get("gps")
                if isinstance(geom, str):
                    geom = geojson_module.loads(geom)
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
                    "totalIdleDurationFormatted": format_idle_time(
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
                feature = geojson_module.Feature(geometry=geom, properties=props)
                features.append(feature)
            except Exception as e:
                logger.exception(
                    "Error processing trip for transactionId: %s",
                    trip.get("transactionId"),
                )
                continue
        fc = geojson_module.FeatureCollection(features)
        return JSONResponse(content=fc)
    except Exception as e:
        logger.exception("Error in /api/trips endpoint")
        raise HTTPException(status_code=500, detail="Failed to retrieve trips")


@app.get("/api/driving-insights")
async def get_driving_insights(request: Request):
    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")
        imei = request.query_params.get("imei")
        start_date = parse_query_date(start_date_str)
        end_date = parse_query_date(end_date_str, end_of_day=True)
        query = {"source": {"$ne": "historical"}}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        if imei:
            query["imei"] = imei
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
        trips_result = await trips_collection.aggregate(pipeline).to_list(None)
        uploaded_result = await uploaded_trips_collection.aggregate(pipeline).to_list(
            None
        )
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
        trips_mv = await trips_collection.aggregate(pipeline_most_visited).to_list(None)
        uploaded_mv = await uploaded_trips_collection.aggregate(
            pipeline_most_visited
        ).to_list(None)
        combined = {
            "total_trips": 0,
            "total_distance": 0.0,
            "total_fuel_consumed": 0.0,
            "max_speed": 0.0,
            "total_idle_duration": 0,
            "longest_trip_distance": 0.0,
            "most_visited": {},
        }
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
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")
        imei = request.query_params.get("imei")
        start_date = parse_query_date(start_date_str)
        end_date = parse_query_date(end_date_str, end_of_day=True)
        query: Dict[str, Any] = {}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        if imei:
            query["imei"] = imei
        trips_cursor_future = trips_collection.find(query).to_list(None)
        hist_cursor_future = historical_trips_collection.find(query).to_list(None)
        trips_data, hist_data = await asyncio.gather(
            trips_cursor_future, hist_cursor_future
        )
        all_trips = trips_data + hist_data
        total_trips = len(all_trips)
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
        total_distance = sum(t.get("distance", 0) for t in all_trips)
        avg_distance_val = (total_distance / total_trips) if total_trips > 0 else 0.0
        start_times = []
        for t in all_trips:
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
        driving_times = []
        for t in all_trips:
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
        max_speed_val = max((t.get("maxSpeed", 0) for t in all_trips), default=0)
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
    last_trip = await trips_collection.find_one(sort=[("endTime", -1)])
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


# ------------------------------------------------------------------------------
# EXPORT ENDPOINTS
# ------------------------------------------------------------------------------


@app.get("/export/geojson")
async def export_geojson(request: Request):
    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")
        imei = request.query_params.get("imei")
        start_date = parse_query_date(start_date_str)
        end_date = parse_query_date(end_date_str, end_of_day=True)
        query: Dict[str, Any] = {}
        if start_date:
            query["startTime"] = {"$gte": start_date}
        if end_date:
            query.setdefault("startTime", {})["$lte"] = end_date
        if imei:
            query["imei"] = imei
        trips = await trips_collection.find(query).to_list(None)
        if not trips:
            raise HTTPException(status_code=404, detail="No trips found for filters.")
        fc = {"type": "FeatureCollection", "features": []}
        for t in trips:
            gps_data = t["gps"]
            if isinstance(gps_data, str):
                gps_data = json.loads(gps_data)
            feature = {
                "type": "Feature",
                "geometry": gps_data,
                "properties": {
                    "transactionId": t["transactionId"],
                    "startTime": serialize_datetime(t.get("startTime")) or "",
                    "endTime": serialize_datetime(t.get("endTime")) or "",
                    "distance": t.get("distance", 0),
                    "imei": t["imei"],
                },
            }
            fc["features"].append(feature)
        content = json.dumps(fc)
        return StreamingResponse(
            io.BytesIO(content.encode()),
            media_type="application/geo+json",
            headers={"Content-Disposition": 'attachment; filename="all_trips.geojson"'},
        )
    except Exception as e:
        logger.exception("Error exporting GeoJSON")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/export/gpx")
async def export_gpx(request: Request):
    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")
        imei = request.query_params.get("imei")
        start_date = parse_query_date(start_date_str)
        end_date = parse_query_date(end_date_str, end_of_day=True)
        query: Dict[str, Any] = {}
        if start_date:
            query["startTime"] = {"$gte": start_date}
        if end_date:
            query.setdefault("startTime", {})["$lte"] = end_date
        if imei:
            query["imei"] = imei
        trips = await trips_collection.find(query).to_list(None)
        if not trips:
            raise HTTPException(status_code=404, detail="No trips found.")
        gpx_obj = gpxpy.gpx.GPX()
        for t in trips:
            track = gpxpy.gpx.GPXTrack()
            gpx_obj.tracks.append(track)
            seg = gpxpy.gpx.GPXTrackSegment()
            track.segments.append(seg)
            gps_data = t["gps"]
            if isinstance(gps_data, str):
                gps_data = json.loads(gps_data)
            if gps_data.get("type") == "LineString":
                for coord in gps_data.get("coordinates", []):
                    lon, lat = coord[0], coord[1]
                    seg.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
            elif gps_data.get("type") == "Point":
                coords = gps_data.get("coordinates", [])
                if len(coords) >= 2:
                    lon, lat = coords[0], coords[1]
                    seg.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
            track.name = t.get("transactionId", "Unnamed Trip")
            track.description = f"Trip from {t.get('startLocation', 'Unknown')} to {t.get('destination', 'Unknown')}"
        gpx_xml = gpx_obj.to_xml()
        return StreamingResponse(
            io.BytesIO(gpx_xml.encode()),
            media_type="application/gpx+xml",
            headers={"Content-Disposition": 'attachment; filename="trips.gpx"'},
        )
    except Exception as e:
        logger.exception("Error exporting GPX")
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------------------
# VALIDATION / OSM DATA
# ------------------------------------------------------------------------------


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
            ({location['osm_type']}({location['osm_id']});
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
                existing_data = await osm_data_collection.find_one(
                    {"location": location, "type": osm_type}
                )
                if existing_data:
                    await osm_data_collection.update_one(
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
                    await osm_data_collection.insert_one(
                        {
                            "location": location,
                            "type": osm_type,
                            "geojson": geojson_data,
                            "created_at": datetime.now(timezone.utc),
                        }
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
    except aiohttp.ClientError as e:
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


# ------------------------------------------------------------------------------
# MAP MATCHING ENDPOINTS
# ------------------------------------------------------------------------------


@app.post("/api/map_match_trips")
async def map_match_trips_endpoint(request: Request):
    try:
        data = await request.json()
        start_date = parse_query_date(data.get("start_date"))
        end_date = parse_query_date(data.get("end_date"), end_of_day=True)
        trip_id = data.get("trip_id")
        query: Dict[str, Any] = {}
        if trip_id:
            query["transactionId"] = trip_id
        elif start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        else:
            raise HTTPException(
                status_code=400, detail="Either trip_id or date range is required"
            )
        cursor = trips_collection.find(query)
        trips_list = await cursor.to_list(length=None)
        if not trips_list:
            raise HTTPException(
                status_code=404, detail="No trips found matching criteria"
            )
        for trip in trips_list:
            await process_and_map_match_trip(trip)
        return {
            "status": "success",
            "message": f"Map matching completed for {len(trips_list)} trip(s).",
        }
    except Exception as e:
        logger.exception("Error in map_match_trips endpoint")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/map_match_historical_trips")
async def map_match_historical_trips_endpoint(request: Request):
    try:
        data = await request.json()
        start_date = parse_query_date(data.get("start_date"))
        end_date = parse_query_date(data.get("end_date"), end_of_day=True)
        query: Dict[str, Any] = {}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        cursor = historical_trips_collection.find(query)
        trips_list = await cursor.to_list(length=None)
        for trip in trips_list:
            await process_and_map_match_trip(trip)
        return {
            "status": "success",
            "message": "Map matching for historical trips started.",
        }
    except Exception as e:
        logger.exception("Error in map_match_historical_trips endpoint")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/matched_trips")
async def get_matched_trips(request: Request):
    start_date_str = request.query_params.get("start_date")
    end_date_str = request.query_params.get("end_date")
    imei = request.query_params.get("imei")
    start_date = parse_query_date(start_date_str)
    end_date = parse_query_date(end_date_str, end_of_day=True)
    query: Dict[str, Any] = {}
    if start_date and end_date:
        query["startTime"] = {"$gte": start_date, "$lte": end_date}
    if imei:
        query["imei"] = imei
    matched = await matched_trips_collection.find(query).to_list(length=None)
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
                    "startTime": serialize_datetime(trip.get("startTime")) or "",
                    "endTime": serialize_datetime(trip.get("endTime")) or "",
                    "distance": trip.get("distance", 0),
                    "timeZone": trip.get("timeZone", "UTC"),
                    "destination": trip.get("destination", "N/A"),
                    "startLocation": trip.get("startLocation", "N/A"),
                },
            )
            features.append(feature)
        except Exception as e:
            logger.exception(
                "Error processing matched trip %s", trip.get("transactionId")
            )
            continue
    fc = geojson_module.FeatureCollection(features)
    return JSONResponse(content=fc)


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
                result = await matched_trips_collection.delete_many(
                    {"startTime": {"$gte": current_start, "$lt": current_end}}
                )
                total_deleted_count += result.deleted_count
                current_start = current_end
        else:
            result = await matched_trips_collection.delete_many(
                {"startTime": {"$gte": start_date, "$lte": end_date}}
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
        await matched_trips_collection.delete_many(
            {"startTime": {"$gte": start_date, "$lte": end_date}}
        )
        trips_cursor = trips_collection.find(
            {"startTime": {"$gte": start_date, "$lte": end_date}}
        )
        trips_list = await trips_cursor.to_list(length=None)
        for trip in trips_list:
            await process_and_map_match_trip(trip)
        return {"status": "success", "message": "Re-matching completed."}
    except Exception as e:
        logger.exception("Error in remap_matched_trips")
        raise HTTPException(status_code=500, detail=f"Error re-matching trips: {e}")


@app.get("/api/export/trip/{trip_id}")
async def export_single_trip(trip_id: str, request: Request):
    fmt = request.query_params.get("format", "geojson")
    t = await trips_collection.find_one({"transactionId": trip_id})
    if not t:
        raise HTTPException(status_code=404, detail="Trip not found")

    start_date = t.get("startTime")
    date_str = start_date.strftime("%Y%m%d") if start_date else "unknown_date"
    filename_base = f"trip_{trip_id}_{date_str}"

    if fmt == "geojson":
        gps_data = t["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        feature = {
            "type": "Feature",
            "geometry": gps_data,
            "properties": {
                "transactionId": t["transactionId"],
                "startTime": serialize_datetime(t.get("startTime")) or "",
                "endTime": serialize_datetime(t.get("endTime")) or "",
                "distance": t.get("distance", 0),
                "imei": t["imei"],
            },
        }
        fc = {"type": "FeatureCollection", "features": [feature]}
        content = json.dumps(fc)
        return StreamingResponse(
            io.BytesIO(content.encode()),
            media_type="application/geo+json",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.geojson"'
            },
        )
    if fmt == "gpx":
        gpx_obj = gpxpy.gpx.GPX()
        track = gpxpy.gpx.GPXTrack()
        gpx_obj.tracks.append(track)
        seg = gpxpy.gpx.GPXTrackSegment()
        track.segments.append(seg)
        gps_data = t["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        if gps_data.get("type") == "LineString":
            for coord in gps_data.get("coordinates", []):
                lon, lat = coord
                seg.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
        track.name = t["transactionId"]
        gpx_xml = gpx_obj.to_xml()
        return StreamingResponse(
            io.BytesIO(gpx_xml.encode()),
            media_type="application/gpx+xml",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.gpx"'
            },
        )
    raise HTTPException(status_code=400, detail="Unsupported format")


@app.delete("/api/matched_trips/{trip_id}")
async def delete_matched_trip(trip_id: str):
    try:
        result = await matched_trips_collection.delete_one(
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]}
        )
        if result.deleted_count:
            return {"status": "success", "message": "Deleted matched trip"}
        raise HTTPException(status_code=404, detail="Trip not found")
    except Exception as e:
        logger.exception("Error deleting matched trip %s", trip_id)
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------------------
# COMBINED EXPORT ENDPOINTS
# ------------------------------------------------------------------------------


async def fetch_all_trips_no_filter() -> List[dict]:
    trips = await trips_collection.find().to_list(length=None)
    uploaded = await uploaded_trips_collection.find().to_list(length=None)
    historical = await historical_trips_collection.find().to_list(length=None)
    return trips + uploaded + historical


@app.get("/api/export/all_trips")
async def export_all_trips(request: Request):
    fmt = request.query_params.get("format", "geojson").lower()
    all_trips = await fetch_all_trips_no_filter()

    current_time = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename_base = f"all_trips_{current_time}"

    if fmt == "geojson":
        geojson_data = await create_geojson(all_trips)
        return StreamingResponse(
            io.BytesIO(geojson_data.encode()),
            media_type="application/geo+json",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.geojson"'
            },
        )
    if fmt == "gpx":
        gpx_data = await create_gpx(all_trips)
        return StreamingResponse(
            io.BytesIO(gpx_data.encode()),
            media_type="application/gpx+xml",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.gpx"'
            },
        )
    if fmt == "json":
        return JSONResponse(content=all_trips)
    raise HTTPException(status_code=400, detail="Invalid export format")


@app.get("/api/export/trips")
async def export_trips_within_range(request: Request):
    start_date_str = request.query_params.get("start_date")
    end_date_str = request.query_params.get("end_date")
    fmt = request.query_params.get("format", "geojson").lower()
    start_date = parse_query_date(start_date_str)
    end_date = parse_query_date(end_date_str, end_of_day=True)
    if not start_date or not end_date:
        raise HTTPException(status_code=400, detail="Invalid or missing date range")
    query = {"startTime": {"$gte": start_date, "$lte": end_date}}
    trips_future = trips_collection.find(query).to_list(length=None)
    uploaded_future = uploaded_trips_collection.find(query).to_list(length=None)
    historical_future = historical_trips_collection.find(query).to_list(length=None)
    trips_data, ups_data, hist_data = await asyncio.gather(
        trips_future, uploaded_future, historical_future
    )
    all_trips = trips_data + ups_data + hist_data

    date_range = f"{start_date.strftime('%Y%m%d')}-{end_date.strftime('%Y%m%d')}"
    filename_base = f"trips_{date_range}"

    if fmt == "geojson":
        geojson_data = await create_geojson(all_trips)
        return StreamingResponse(
            io.BytesIO(geojson_data.encode()),
            media_type="application/geo+json",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.geojson"'
            },
        )
    if fmt == "gpx":
        gpx_data = await create_gpx(all_trips)
        return StreamingResponse(
            io.BytesIO(gpx_data.encode()),
            media_type="application/gpx+xml",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.gpx"'
            },
        )
    raise HTTPException(status_code=400, detail="Invalid export format")


@app.get("/api/export/matched_trips")
async def export_matched_trips_within_range(request: Request):
    start_date_str = request.query_params.get("start_date")
    end_date_str = request.query_params.get("end_date")
    fmt = request.query_params.get("format", "geojson").lower()
    start_date = parse_query_date(start_date_str)
    end_date = parse_query_date(end_date_str, end_of_day=True)
    if not start_date or not end_date:
        raise HTTPException(status_code=400, detail="Invalid or missing date range")
    query = {"startTime": {"$gte": start_date, "$lte": end_date}}
    matched = await matched_trips_collection.find(query).to_list(length=None)

    date_range = f"{start_date.strftime('%Y%m%d')}-{end_date.strftime('%Y%m%d')}"
    filename_base = f"matched_trips_{date_range}"

    if fmt == "geojson":
        geojson_data = await create_geojson(matched)
        return StreamingResponse(
            io.BytesIO(json.dumps(geojson_data).encode()),
            media_type="application/geo+json",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.geojson"'
            },
        )
    if fmt == "gpx":
        gpx_data = await create_gpx(matched)
        return StreamingResponse(
            io.BytesIO(gpx_data.encode()),
            media_type="application/gpx+xml",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.gpx"'
            },
        )
    raise HTTPException(status_code=400, detail="Invalid export format")


@app.get("/api/export/streets")
async def export_streets(request: Request):
    location_param = request.query_params.get("location")
    fmt = request.query_params.get("format", "geojson").lower()
    if not location_param:
        raise HTTPException(status_code=400, detail="No location param")
    loc = json.loads(location_param)
    data, _ = await generate_geojson_osm(loc, streets_only=True)
    if not data:
        raise HTTPException(status_code=500, detail="No data returned from Overpass")

    location_name = (
        loc.get("display_name", "").split(",")[0].strip().replace(" ", "_").lower()
    )
    filename_base = f"streets_{location_name}"

    if fmt == "geojson":
        return StreamingResponse(
            io.BytesIO(json.dumps(data).encode()),
            media_type="application/geo+json",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.geojson"'
            },
        )
    if fmt == "shapefile":
        gdf = gpd.GeoDataFrame.from_features(data["features"])
        with tempfile.TemporaryDirectory() as tmp_dir:
            out_path = os.path.join(tmp_dir, "streets.shp")
            gdf.to_file(out_path, driver="ESRI Shapefile")
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for f in os.listdir(tmp_dir):
                    with open(os.path.join(tmp_dir, f), "rb") as fh:
                        zf.writestr(f"{filename_base}/{f}", fh.read())
            buf.seek(0)
            return StreamingResponse(
                buf,
                media_type="application/zip",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.zip"'
                },
            )
    else:
        raise HTTPException(status_code=400, detail="Invalid export format")


@app.get("/api/export/boundary")
async def export_boundary(request: Request):
    location_param = request.query_params.get("location")
    fmt = request.query_params.get("format", "geojson").lower()
    if not location_param:
        raise HTTPException(status_code=400, detail="No location provided")
    loc = json.loads(location_param)
    data, _ = await generate_geojson_osm(loc, streets_only=False)
    if not data:
        raise HTTPException(status_code=500, detail="No boundary data from Overpass")

    location_name = (
        loc.get("display_name", "").split(",")[0].strip().replace(" ", "_").lower()
    )
    filename_base = f"boundary_{location_name}"

    if fmt == "geojson":
        return StreamingResponse(
            io.BytesIO(json.dumps(data).encode()),
            media_type="application/geo+json",
            headers={
                "Content-Disposition": f'attachment; filename="{filename_base}.geojson"'
            },
        )
    if fmt == "shapefile":
        gdf = gpd.GeoDataFrame.from_features(data["features"])
        with tempfile.TemporaryDirectory() as tmp_dir:
            out_path = os.path.join(tmp_dir, "boundary.shp")
            gdf.to_file(out_path, driver="ESRI Shapefile")
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for f in os.listdir(tmp_dir):
                    with open(os.path.join(tmp_dir, f), "rb") as fh:
                        zf.writestr(f"{filename_base}/{f}", fh.read())
            buf.seek(0)
            return StreamingResponse(
                buf,
                media_type="application/zip",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename_base}.zip"'
                },
            )
    else:
        raise HTTPException(status_code=400, detail="Invalid export format")


# ------------------------------------------------------------------------------
# PREPROCESS_STREETS / STREET SEGMENT
# ------------------------------------------------------------------------------


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
            await coverage_metadata_collection.update_one(
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
        except Exception as ex:
            existing = await coverage_metadata_collection.find_one(
                {"location.display_name": validated_location["display_name"]}
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
    try:
        await async_preprocess_streets(location)
        result = await compute_coverage_for_location(location, task_id)
        if result:
            await coverage_metadata_collection.update_one(
                {"location.display_name": location["display_name"]},
                {
                    "$set": {
                        "status": "completed",
                        "total_length": result["total_length"],
                        "driven_length": result["driven_length"],
                        "coverage_percentage": result["coverage_percentage"],
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
            )
        else:
            await coverage_metadata_collection.update_one(
                {"location.display_name": location["display_name"]},
                {
                    "$set": {
                        "status": "error",
                        "last_error": "Failed to calculate coverage",
                        "last_updated": datetime.now(timezone.utc),
                    }
                },
            )
    except Exception as e:
        logger.exception("Error processing area")
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


@app.get("/api/street_segment/{segment_id}")
async def get_street_segment_details(segment_id: str):
    try:
        segment = await streets_collection.find_one(
            {"properties.segment_id": segment_id}, {"_id": 0}
        )
        if not segment:
            raise HTTPException(status_code=404, detail="Segment not found")
        return segment
    except Exception as e:
        logger.exception("Error fetching segment details")
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------------------
# LOADING HISTORICAL DATA
# ------------------------------------------------------------------------------


async def process_historical_trip(trip: dict) -> dict:
    if isinstance(trip["startTime"], str):
        trip["startTime"] = dateutil_parser.isoparse(trip["startTime"])
    if isinstance(trip["endTime"], str):
        trip["endTime"] = dateutil_parser.isoparse(trip["endTime"])
    gps_data = geojson_module.loads(trip["gps"])
    trip["startGeoPoint"] = gps_data["coordinates"][0]
    trip["destinationGeoPoint"] = gps_data["coordinates"][-1]
    return trip


async def load_historical_data(start_date_str=None, end_date_str=None):
    all_trips = []
    for filename in glob.glob("olddrivingdata/*.geojson"):
        with open(filename, "r") as f:
            try:
                geojson_data = json.load(f)
                for feature in geojson_data["features"]:
                    trip = feature["properties"]
                    trip["gps"] = json.dumps(feature["geometry"])
                    trip["startTime"] = datetime.fromisoformat(
                        trip["timestamp"]
                    ).replace(tzinfo=timezone.utc)
                    trip["endTime"] = datetime.fromisoformat(
                        trip["end_timestamp"]
                    ).replace(tzinfo=timezone.utc)
                    trip["imei"] = "HISTORICAL"
                    trip["transactionId"] = f"HISTORICAL-{trip['timestamp']}"
                    if start_date_str:
                        sdt = parse_query_date(start_date_str)
                        if trip["startTime"] < sdt:
                            continue
                    if end_date_str:
                        edt = parse_query_date(end_date_str, end_of_day=True)
                        if trip["endTime"] > edt:
                            continue
                    all_trips.append(trip)
            except Exception as e:
                logger.error("Error reading %s: %s", filename, e)
    processed = await asyncio.gather(*(process_historical_trip(t) for t in all_trips))
    inserted_count = 0
    for trip in processed:
        try:
            exists = await historical_trips_collection.find_one(
                {"transactionId": trip["transactionId"]}
            )
            if not exists:
                await historical_trips_collection.insert_one(trip)
                inserted_count += 1
        except Exception as e:
            logger.exception("Error inserting historical trip")
    return inserted_count


@app.post("/load_historical_data")
async def load_historical_data_endpoint(request: Request):
    data = await request.json()
    start_date = data.get("start_date")
    end_date = data.get("end_date")
    inserted_count = await load_historical_data(start_date, end_date)
    return {"message": f"Loaded historical data. Inserted {inserted_count} new trips."}


# ------------------------------------------------------------------------------
# LAST TRIP POINT
# ------------------------------------------------------------------------------


@app.get("/api/last_trip_point")
async def get_last_trip_point():
    try:
        most_recent = await trips_collection.find_one(sort=[("endTime", -1)])
        if not most_recent:
            return {"lastPoint": None}
        gps_data = most_recent["gps"]
        if isinstance(gps_data, str):
            gps_data = geojson_module.loads(gps_data)
        if "coordinates" not in gps_data or not gps_data["coordinates"]:
            return {"lastPoint": None}
        return {"lastPoint": gps_data["coordinates"][-1]}
    except Exception as e:
        logger.exception("Error get_last_trip_point")
        raise HTTPException(
            status_code=500, detail="Failed to retrieve last trip point"
        )


# ------------------------------------------------------------------------------
# SINGLE TRIP GET/DELETE
# ------------------------------------------------------------------------------


@app.get("/api/trips/{trip_id}")
async def get_single_trip(trip_id: str):
    try:
        trip = None
        try:
            object_id = ObjectId(trip_id)
            trip = await trips_collection.find_one({"_id": object_id})
        except Exception:
            pass
        if not trip:
            trip = await trips_collection.find_one({"transactionId": trip_id})
        if not trip:
            raise HTTPException(status_code=404, detail="Trip not found")
        trip = serialize_trip(trip)
        return {"status": "success", "trip": trip}
    except Exception as e:
        logger.exception("get_single_trip error")
        raise HTTPException(status_code=500, detail="Internal server error") from e


@app.delete("/api/trips/{trip_id}")
async def delete_trip(trip_id: str):
    try:
        trip = await trips_collection.find_one({"transactionId": trip_id})
        if trip:
            collection = trips_collection
        else:
            trip = await matched_trips_collection.find_one({"transactionId": trip_id})
            if trip:
                collection = matched_trips_collection
            else:
                raise HTTPException(status_code=404, detail="Trip not found")
        result = await collection.delete_one({"transactionId": trip_id})
        if result.deleted_count == 1:
            return {"status": "success", "message": "Trip deleted successfully"}
        raise HTTPException(status_code=500, detail="Failed to delete trip")
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        logger.exception("Error deleting trip")
        raise HTTPException(status_code=500, detail="Internal server error") from e


@app.get("/api/debug/trip/{trip_id}")
async def debug_trip(trip_id: str):
    try:
        regular_trip = await trips_collection.find_one(
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]}
        )
        matched_trip = await matched_trips_collection.find_one(
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]}
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
        regular_trip = await trips_collection.find_one({}, sort=[("startTime", 1)])
        uploaded_trip = await uploaded_trips_collection.find_one(
            {}, sort=[("startTime", 1)]
        )
        historical_trip = await historical_trips_collection.find_one(
            {}, sort=[("startTime", 1)]
        )
        candidates = []
        if regular_trip and regular_trip.get("startTime"):
            candidates.append(regular_trip["startTime"])
        if uploaded_trip and uploaded_trip.get("startTime"):
            candidates.append(uploaded_trip["startTime"])
        if historical_trip and historical_trip.get("startTime"):
            candidates.append(historical_trip["startTime"])
        if not candidates:
            now = datetime.now(timezone.utc)
            return {"first_trip_date": now.isoformat()}
        earliest_trip_date = min(candidates)
        if earliest_trip_date.tzinfo is None:
            earliest_trip_date = earliest_trip_date.replace(tzinfo=timezone.utc)
        return {"first_trip_date": earliest_trip_date.isoformat()}
    except Exception as e:
        logger.exception("get_first_trip_date error")
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------------------
# GPX / GEOJSON UPLOAD
# ------------------------------------------------------------------------------


@app.get("/api/uploaded_trips")
async def get_uploaded_trips():
    try:
        ups = await uploaded_trips_collection.find().to_list(length=None)
        for u in ups:
            u["_id"] = str(u["_id"])
            for key in ("startTime", "endTime"):
                if u.get(key) and isinstance(u[key], datetime):
                    u[key] = u[key].isoformat()
        return {"status": "success", "trips": ups}
    except Exception as e:
        logger.exception("Error get_uploaded_trips")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/uploaded_trips/{trip_id}")
async def delete_uploaded_trip(trip_id: str):
    try:
        result = await uploaded_trips_collection.delete_one({"_id": ObjectId(trip_id)})
        if result.deleted_count == 1:
            return {"status": "success", "message": "Trip deleted"}
        raise HTTPException(status_code=404, detail="Not found")
    except Exception as e:
        logger.exception("Error deleting uploaded trip")
        raise HTTPException(status_code=500, detail=str(e))


def meters_to_miles(m: float) -> float:
    return m * 0.000621371


def haversine(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    R = 3958.8
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = (
        sin(dlat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    )
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return R * c


def calculate_distance(coordinates: List[List[float]]) -> float:
    if not coordinates or len(coordinates) < 2:
        return 0
    dist = 0
    for i in range(len(coordinates) - 1):
        lon1, lat1 = coordinates[i]
        lon2, lat2 = coordinates[i + 1]
        dist += haversine(lon1, lat1, lon2, lat2)
    return dist


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
                    "imei": "HISTORICAL",
                }
            )
        return trips
    except Exception as e:
        logger.exception("Error in process_geojson_trip")
        return None


async def process_and_store_trip(trip: dict):
    try:
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        coords = gps_data.get("coordinates", [])
        if coords:
            start_pt = coords[0]
            end_pt = coords[-1]
            if not trip.get("startLocation"):
                trip["startLocation"] = await reverse_geocode_nominatim(
                    start_pt[1], start_pt[0]
                )
            if not trip.get("destination"):
                trip["destination"] = await reverse_geocode_nominatim(
                    end_pt[1], end_pt[0]
                )
        if isinstance(trip["gps"], dict):
            trip["gps"] = json.dumps(trip["gps"])
        existing = await uploaded_trips_collection.find_one(
            {"transactionId": trip["transactionId"]}
        )
        if existing:
            updates = {}
            if not existing.get("startLocation") and trip.get("startLocation"):
                updates["startLocation"] = trip["startLocation"]
            if not existing.get("destination") and trip.get("destination"):
                updates["destination"] = trip["destination"]
            if updates:
                await uploaded_trips_collection.update_one(
                    {"transactionId": trip["transactionId"]}, {"$set": updates}
                )
        else:
            await uploaded_trips_collection.insert_one(trip)
    except bson.errors.DuplicateKeyError:
        logger.warning("Duplicate trip ID %s; skipping.", trip["transactionId"])
    except Exception as e:
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
                        dist_meters = calculate_gpx_distance(coords)
                        dist_miles = meters_to_miles(dist_meters)
                        trip_data = {
                            "transactionId": f"GPX-{start_t.strftime('%Y%m%d%H%M%S')}-{filename}",
                            "startTime": start_t,
                            "endTime": end_t,
                            "gps": json.dumps(
                                {"type": "LineString", "coordinates": coords}
                            ),
                            "distance": round(dist_miles, 2),
                            "source": "upload",
                            "filename": f.filename,
                            "imei": "HISTORICAL",
                        }
                        await process_and_store_trip(trip_data)
                        success_count += 1
            elif filename.endswith(".geojson"):
                content = await f.read()
                data_geojson = json.loads(content)
                trips = process_geojson_trip(data_geojson)
                if trips:
                    for t in trips:
                        t["source"] = "upload"
                        t["filename"] = f.filename
                        await process_and_store_trip(t)
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
                            "imei": "HISTORICAL",
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


@app.delete("/api/uploaded_trips/bulk_delete")
async def bulk_delete_uploaded_trips(request: Request):
    try:
        data = await request.json()
        trip_ids = data.get("trip_ids", [])
        if not trip_ids:
            raise HTTPException(status_code=400, detail="No trip IDs")
        valid_ids = []
        for tid in trip_ids:
            try:
                valid_ids.append(ObjectId(tid))
            except bson.errors.InvalidId:
                logger.warning("Invalid ObjectId format: %s", tid)
        if not valid_ids:
            raise HTTPException(status_code=400, detail="No valid IDs found")
        ups_to_delete = await uploaded_trips_collection.find(
            {"_id": {"$in": valid_ids}}
        ).to_list(length=None)
        trans_ids = [u["transactionId"] for u in ups_to_delete]
        del_res = await uploaded_trips_collection.delete_many(
            {"_id": {"$in": valid_ids}}
        )
        matched_del_res = await matched_trips_collection.delete_many(
            {"transactionId": {"$in": trans_ids}}
        )
        return {
            "status": "success",
            "deleted_uploaded_trips": del_res.deleted_count,
            "deleted_matched_trips": matched_del_res.deleted_count,
        }
    except Exception as e:
        logger.exception("Error in bulk_delete_uploaded_trips")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/trips/bulk_delete")
async def bulk_delete_trips(request: Request):
    try:
        data = await request.json()
        trip_ids = data.get("trip_ids", [])
        if not trip_ids:
            raise HTTPException(status_code=400, detail="No trip IDs provided")
        trips_result = await trips_collection.delete_many(
            {"transactionId": {"$in": trip_ids}}
        )
        matched_trips_result = await matched_trips_collection.delete_many(
            {"transactionId": {"$in": trip_ids}}
        )
        return {
            "status": "success",
            "message": f"Deleted {trips_result.deleted_count} trips and {matched_trips_result.deleted_count} matched trips",
            "deleted_trips_count": trips_result.deleted_count,
            "deleted_matched_trips_count": matched_trips_result.deleted_count,
        }
    except Exception as e:
        logger.exception("Error in bulk_delete_trips")
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------------------
# PLACES ENDPOINTS
# ------------------------------------------------------------------------------


@app.api_route("/api/places", methods=["GET", "POST"])
async def handle_places(request: Request):
    if request.method == "GET":
        pls = await places_collection.find().to_list(length=None)
        return [
            {"_id": str(p["_id"]), **CustomPlace.from_dict(p).to_dict()} for p in pls
        ]
    data = await request.json()
    place = CustomPlace(data["name"], data["geometry"])
    r = await places_collection.insert_one(place.to_dict())
    return {"_id": str(r.inserted_id), **place.to_dict()}


@app.delete("/api/places/{place_id}")
async def delete_place(place_id: str):
    await places_collection.delete_one({"_id": ObjectId(place_id)})
    return ""


@app.get("/api/places/{place_id}/statistics")
async def get_place_statistics(place_id: str):
    try:
        p = await places_collection.find_one({"_id": ObjectId(place_id)})
        if not p:
            raise HTTPException(status_code=404, detail="Place not found")
        query = {
            "$or": [
                {"destinationPlaceId": place_id},
                {"destinationGeoPoint": {"$geoWithin": {"$geometry": p["geometry"]}}},
            ],
            "endTime": {"$ne": None},
        }
        valid_trips = []
        for coll in [
            trips_collection,
            historical_trips_collection,
            uploaded_trips_collection,
        ]:
            trips_list = await coll.find(query).to_list(length=None)
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
                            if shape(p["geometry"]).contains(shape(start_pt)):
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
            except Exception as ex:
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
            "firstVisit": serialize_datetime(first_visit),
            "lastVisit": serialize_datetime(last_visit),
            "averageTimeSinceLastVisit": avg_time_since_last,
            "name": p["name"],
        }
    except Exception as e:
        logger.exception("Error place stats %s", place_id)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/places/{place_id}/trips")
async def get_trips_for_place(place_id: str):
    try:
        p = await places_collection.find_one({"_id": ObjectId(place_id)})
        if not p:
            raise HTTPException(status_code=404, detail="Place not found")
        query = {
            "$or": [
                {"destinationPlaceId": place_id},
                {"destinationGeoPoint": {"$geoWithin": {"$geometry": p["geometry"]}}},
            ],
            "endTime": {"$ne": None},
        }
        valid_trips = []
        for coll in [
            trips_collection,
            historical_trips_collection,
            uploaded_trips_collection,
        ]:
            trips_list = await coll.find(query).to_list(length=None)
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
                        if shape(p["geometry"]).contains(shape(start_pt)):
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


# ------------------------------------------------------------------------------
# NON-CUSTOM PLACE VISITS
# ------------------------------------------------------------------------------


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
        trips_results = await trips_collection.aggregate(pipeline).to_list(None)
        historical_results = await historical_trips_collection.aggregate(
            pipeline
        ).to_list(None)
        uploaded_results = await uploaded_trips_collection.aggregate(pipeline).to_list(
            None
        )
        combined_results = trips_results + historical_results + uploaded_results
        visits_data = []
        for doc in combined_results:
            visits_data.append(
                {
                    "name": doc["_id"],
                    "totalVisits": doc["totalVisits"],
                    "firstVisit": serialize_datetime(doc.get("firstVisit")),
                    "lastVisit": serialize_datetime(doc.get("lastVisit")),
                }
            )
        return JSONResponse(content=visits_data)
    except Exception as e:
        logger.exception("Error fetching non-custom place visits")
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------------------
# TRIP ANALYTICS
# ------------------------------------------------------------------------------


@app.get("/api/trip-analytics")
async def get_trip_analytics(request: Request):
    start_date_str = request.query_params.get("start_date")
    end_date_str = request.query_params.get("end_date")
    if not start_date_str or not end_date_str:
        raise HTTPException(status_code=400, detail="Missing date range")
    try:
        start_date = parse_query_date(start_date_str)
        end_date = parse_query_date(end_date_str, end_of_day=True)
        if not start_date or not end_date:
            raise HTTPException(status_code=400, detail="Invalid date range")
        pipeline = [
            {"$match": {"startTime": {"$gte": start_date, "$lte": end_date}}},
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
        results = await trips_collection.aggregate(pipeline).to_list(None)

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


# ------------------------------------------------------------------------------
# GEOPOINT UPDATES / REGEOCODING
# ------------------------------------------------------------------------------


@app.post("/update_geo_points")
async def update_geo_points_route(request: Request):
    data = await request.json()
    collection_name = data.get("collection")
    if collection_name not in ["trips", "historical_trips", "uploaded_trips"]:
        raise HTTPException(status_code=400, detail="Invalid collection name")
    coll_map = {
        "trips": trips_collection,
        "historical_trips": historical_trips_collection,
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
        for collection in [
            trips_collection,
            historical_trips_collection,
            uploaded_trips_collection,
        ]:
            trips_list = await collection.find({}).to_list(length=None)
            for trip in trips_list:
                updated_trip = await process_trip_data(trip)
                if updated_trip is not None:
                    await collection.replace_one({"_id": trip["_id"]}, updated_trip)
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
        trip = await trips_collection.find_one({"transactionId": trip_id})
        if trip:
            updated_trip = await process_trip_data(trip)
            if updated_trip is not None:
                await trips_collection.replace_one({"_id": trip["_id"]}, updated_trip)
                updated_count += 1
    return {
        "message": f"Geocoding refreshed for {updated_count} trips.",
        "updated_count": updated_count,
    }


# ------------------------------------------------------------------------------
# REAL-TIME / BOUNCIE WEBHOOK
# ------------------------------------------------------------------------------


@app.post("/webhook/bouncie")
async def bouncie_webhook(request: Request):
    try:
        data = await request.json()
        event_type = data.get("eventType")
        if not event_type:
            logger.error("Missing eventType in webhook data")
            return {"status": "success", "message": "Event processed"}
        transaction_id = data.get("transactionId")
        if event_type in ("tripStart", "tripData", "tripEnd") and not transaction_id:
            logger.error("Missing transactionId for trip event")
            return {"status": "success", "message": "Event processed"}
        if event_type == "tripStart":
            start_time, _ = get_trip_timestamps(data)
            await live_trips_collection.delete_many(
                {"transactionId": transaction_id, "status": "active"}
            )
            await live_trips_collection.insert_one(
                {
                    "transactionId": transaction_id,
                    "status": "active",
                    "startTime": start_time,
                    "coordinates": [],
                    "lastUpdate": start_time,
                }
            )
        elif event_type == "tripData":
            trip_doc = await live_trips_collection.find_one(
                {"transactionId": transaction_id, "status": "active"}
            )
            if not trip_doc:
                now = datetime.now(timezone.utc)
                await live_trips_collection.insert_one(
                    {
                        "transactionId": transaction_id,
                        "status": "active",
                        "startTime": now,
                        "coordinates": [],
                        "lastUpdate": now,
                        "distance": 0,
                        "currentSpeed": 0,
                        "maxSpeed": 0,
                    }
                )
                trip_doc = await live_trips_collection.find_one(
                    {"transactionId": transaction_id, "status": "active"}
                )
            if "data" in data:
                new_coords = sort_and_filter_trip_coordinates(data["data"])
                all_coords = trip_doc.get("coordinates", []) + new_coords
                all_coords.sort(key=lambda c: c["timestamp"])

                # Calculate current speed and distance
                current_speed = 0
                if len(all_coords) >= 2:
                    last_point = all_coords[-1]
                    prev_point = all_coords[-2]

                    # Calculate distance between last two points
                    distance = haversine(
                        prev_point["lon"],
                        prev_point["lat"],
                        last_point["lon"],
                        last_point["lat"],
                    )

                    # Calculate time difference in hours
                    time_diff = (
                        dateutil_parser.isoparse(last_point["timestamp"])
                        - dateutil_parser.isoparse(prev_point["timestamp"])
                    ).total_seconds() / 3600

                    if time_diff > 0:
                        current_speed = distance / time_diff

                # Calculate total distance
                total_distance = trip_doc.get("distance", 0)
                if len(new_coords) >= 2:
                    for i in range(1, len(new_coords)):
                        prev = new_coords[i - 1]
                        curr = new_coords[i]
                        total_distance += haversine(
                            prev["lon"], prev["lat"], curr["lon"], curr["lat"]
                        )

                # Update max speed if needed
                max_speed = max(trip_doc.get("maxSpeed", 0), current_speed)

                # Calculate duration
                duration = (
                    dateutil_parser.isoparse(all_coords[-1]["timestamp"])
                    - dateutil_parser.isoparse(trip_doc["startTime"])
                ).total_seconds()

                await live_trips_collection.update_one(
                    {"_id": trip_doc["_id"]},
                    {
                        "$set": {
                            "coordinates": all_coords,
                            "lastUpdate": (
                                all_coords[-1]["timestamp"]
                                if all_coords
                                else trip_doc["startTime"]
                            ),
                            "distance": total_distance,
                            "currentSpeed": current_speed,
                            "maxSpeed": max_speed,
                            "duration": duration,
                        }
                    },
                )

                # Update the active trip for broadcasting
                active_trip = await live_trips_collection.find_one({"status": "active"})
                if active_trip:
                    for key in ("startTime", "lastUpdate", "endTime"):
                        if key in active_trip and isinstance(
                            active_trip[key], datetime
                        ):
                            active_trip[key] = active_trip[key].isoformat()
                    if "_id" in active_trip:
                        active_trip["_id"] = str(active_trip["_id"])
                    if "coordinates" in active_trip:
                        for coord in active_trip["coordinates"]:
                            ts = coord.get("timestamp")
                            if isinstance(ts, datetime):
                                coord["timestamp"] = ts.isoformat()
                    message = {"type": "trip_update", "data": active_trip}
                else:
                    message = {"type": "heartbeat"}
                await manager.broadcast(json.dumps(message))
        elif event_type == "tripEnd":
            start_time, end_time = get_trip_timestamps(data)
            trip = await live_trips_collection.find_one(
                {"transactionId": transaction_id}
            )
            if trip:
                trip["endTime"] = end_time
                trip["status"] = "completed"
                await archived_live_trips_collection.insert_one(trip)
                await live_trips_collection.delete_one({"_id": trip["_id"]})
        try:
            active_trip = await live_trips_collection.find_one({"status": "active"})
            if active_trip:
                for key in ("startTime", "lastUpdate", "endTime"):
                    if key in active_trip and isinstance(active_trip[key], datetime):
                        active_trip[key] = active_trip[key].isoformat()
                if "_id" in active_trip:
                    active_trip["_id"] = str(active_trip["_id"])
                if "coordinates" in active_trip:
                    for coord in active_trip["coordinates"]:
                        ts = coord.get("timestamp")
                        if isinstance(ts, datetime):
                            coord["timestamp"] = ts.isoformat()
                message = {"type": "trip_update", "data": active_trip}
            else:
                message = {"type": "heartbeat"}
            await manager.broadcast(json.dumps(message))
        except Exception as broadcast_error:
            logger.exception("Error broadcasting webhook update")
        return {"status": "success", "message": "Event processed"}
    except Exception as e:
        logger.exception("Error in bouncie_webhook")
        return {"status": "success", "message": "Event processed with errors"}


@app.get("/api/active_trip")
async def get_active_trip():
    try:
        active_trip = await live_trips_collection.find_one({"status": "active"})
        if active_trip:
            # Convert datetime objects to ISO format strings
            for key in ("startTime", "lastUpdate", "endTime"):
                if key in active_trip and isinstance(active_trip[key], datetime):
                    active_trip[key] = active_trip[key].isoformat()

            # Ensure all required fields are present
            active_trip.setdefault("distance", 0)
            active_trip.setdefault("currentSpeed", 0)
            active_trip.setdefault("maxSpeed", 0)
            active_trip.setdefault("duration", 0)

            # Convert ObjectId to string
            active_trip["_id"] = str(active_trip["_id"])

            # Convert timestamps in coordinates
            if "coordinates" in active_trip:
                for coord in active_trip["coordinates"]:
                    ts = coord.get("timestamp")
                    if isinstance(ts, datetime):
                        coord["timestamp"] = ts.isoformat()

            return active_trip
        raise HTTPException(status_code=404, detail="No active trip")
    except Exception as e:
        logger.exception("Error in get_active_trip")
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------------------
# WEBSOCKET: LIVE TRIP
# ------------------------------------------------------------------------------


@app.websocket("/ws/live_trip")
async def ws_live_trip(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.exception("WebSocket error")
        manager.disconnect(websocket)


# ------------------------------------------------------------------------------
# DATABASE MANAGEMENT ENDPOINTS
# ------------------------------------------------------------------------------


@app.get("/api/database/storage-info")
async def get_storage_info():
    try:
        db_stats = await db.command("dbStats")
        data_size = db_stats.get("dataSize")
        if data_size is None:
            raise ValueError("dbStats did not return 'dataSize'")
        storage_used_mb = round(data_size / (1024 * 1024), 2)
        storage_limit_mb = 512
        storage_usage_percent = round((storage_used_mb / storage_limit_mb) * 100, 2)
        return {
            "used_mb": storage_used_mb,
            "limit_mb": storage_limit_mb,
            "usage_percent": storage_usage_percent,
        }
    except Exception as e:
        logger.exception("Error getting storage info")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/database/optimize-collection")
async def optimize_collection(collection: Dict[str, str]):
    try:
        name = collection.get("collection")
        if not name:
            raise HTTPException(status_code=400, detail="Missing 'collection' field")
        await db.command({"compact": name})
        await db[name].reindex()
        return {"message": f"Successfully optimized collection {name}"}
    except Exception as e:
        logger.exception("Error optimizing collection")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/database/clear-collection")
async def clear_collection(collection: Dict[str, str]):
    try:
        name = collection.get("collection")
        if not name:
            raise HTTPException(status_code=400, detail="Missing 'collection' field")
        result = await db[name].delete_many({})
        return {"message": f"Cleared {result.deleted_count} documents from {name}"}
    except Exception as e:
        logger.exception("Error clearing collection")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/database/optimize-all")
async def optimize_all_collections():
    try:
        collection_names = await db.list_collection_names()
        for coll_name in collection_names:
            await db.command({"compact": coll_name})
            await db[coll_name].reindex()
        return {"message": "Successfully optimized all collections"}
    except Exception as e:
        logger.exception("Error optimizing all collections")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/database/repair-indexes")
async def repair_indexes():
    try:
        collection_names = await db.list_collection_names()
        for coll_name in collection_names:
            await db[coll_name].reindex()
        return {"message": "Successfully repaired indexes for all collections"}
    except Exception as e:
        logger.exception("Error repairing indexes")
        raise HTTPException(status_code=500, detail=str(e))


# ------------------------------------------------------------------------------
# COVERAGE AREA MANAGEMENT
# ------------------------------------------------------------------------------


@app.get("/api/coverage_areas")
async def get_coverage_areas():
    """Get all coverage areas."""
    try:
        areas = await coverage_metadata_collection.find({}).to_list(length=None)
        result = []
        for area in areas:
            area_data = {
                "id": str(area["_id"]),
                "display_name": area.get("location", {}).get("display_name", "Unknown"),
                "total_length": area.get("total_length", 0),
                "driven_length": area.get("driven_length", 0),
                "coverage_percentage": area.get("coverage_percentage", 0),
                "last_updated": area.get("last_updated"),
                "status": area.get("status", "completed"),
                "location": area.get("location", {})
            }
            result.append(area_data)
        return result
    except Exception as e:
        logger.error(f"Error fetching coverage areas: {e}")
        raise HTTPException(status_code=500, detail=str(e))


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
        delete_result = await coverage_metadata_collection.delete_one(
            {"location.display_name": display_name}
        )
        await streets_collection.delete_many({"properties.location": display_name})
        if delete_result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Coverage area not found")
        return {"status": "success", "message": "Coverage area deleted successfully"}
    except Exception as e:
        logger.exception("Error deleting coverage area")
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/coverage_areas/retry")
async def retry_coverage_area(request: Request):
    try:
        data = await request.json()
        location = data.get("location")
        if not location or not isinstance(location, dict):
            raise HTTPException(status_code=400, detail="Invalid location data")
        task_id = str(uuid.uuid4())
        asyncio.create_task(process_coverage_calculation(location, task_id))
        return {"status": "success", "task_id": task_id}
    except Exception as e:
        logger.exception("Error retrying coverage area")
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
        await coverage_metadata_collection.update_one(
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


# ------------------------------------------------------------------------------
# APPLICATION LIFECYCLE
# ------------------------------------------------------------------------------


@app.on_event("startup")
async def startup_event():
    try:
        used_mb, limit_mb = await db_manager.check_quota()
        if not db_manager.quota_exceeded:
            await db_manager.safe_create_index(
                "uploaded_trips", "transactionId", unique=True
            )
            await db_manager.safe_create_index(
                "matched_trips", "transactionId", unique=True
            )
            await db_manager.safe_create_index(
                "osm_data", [("location", 1), ("type", 1)], unique=True
            )
            await db_manager.safe_create_index("streets", [("geometry", "2dsphere")])
            await db_manager.safe_create_index("streets", [("properties.location", 1)])
            await db_manager.safe_create_index(
                "coverage_metadata", [("location", 1)], unique=True
            )
            await task_manager.start()
            await init_task_history_collection()
            await ensure_street_coverage_indexes()
            logger.info("Application startup completed successfully")
        else:
            logger.warning(
                "Application started in limited mode due to exceeded storage quota (%.2f MB / %d MB)",
                used_mb,
                limit_mb,
            )
    except Exception as e:
        logger.exception("Error during application startup")
        # Start in degraded mode if something fails.


@app.on_event("shutdown")
async def shutdown_event():
    await task_manager.stop()
    await cleanup_session()


# ------------------------------------------------------------------------------
# ERROR HANDLERS
# ------------------------------------------------------------------------------


@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    return JSONResponse(status_code=404, content={"error": "Endpoint not found"})


@app.exception_handler(500)
async def internal_error_handler(request: Request, exc):
    return JSONResponse(status_code=500, content={"error": "Internal server error"})


# ------------------------------------------------------------------------------
# Coverage Dashboard Routes
# ------------------------------------------------------------------------------


@app.get("/coverage-dashboard", response_class=HTMLResponse)
async def coverage_dashboard(request: Request):
    """Render the coverage dashboard page."""
    return templates.TemplateResponse("coverage_dashboard.html", {"request": request})


@app.get("/api/coverage_areas")
async def get_coverage_areas():
    """Get all coverage areas."""
    try:
        areas = await coverage_metadata_collection.find({}).to_list(length=None)
        for area in areas:
            area["id"] = str(area["_id"])
            del area["_id"]
        return areas
    except Exception as e:
        logger.error(f"Error fetching coverage areas: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/coverage_data/{location_id}")
async def get_coverage_data(location_id: str):
    """Get coverage data for a specific location."""
    try:
        # Convert string ID to ObjectId
        location_oid = ObjectId(location_id)
        
        # Get coverage metadata
        metadata = await coverage_metadata_collection.find_one({"_id": location_oid})
        if not metadata:
            raise HTTPException(status_code=404, detail="Location not found")
        
        # Get recent trip data for this location
        now = datetime.now(timezone.utc)
        week_ago = now - timedelta(days=7)
        month_ago = now - timedelta(days=30)
        
        # Get coverage history to calculate progress
        history = await progress_collection.find(
            {"location_id": location_oid}
        ).sort("timestamp", -1).to_list(length=100)
        
        # Calculate progress over last week and month
        last_week_progress = 0
        last_month_progress = 0
        new_streets_count = 0
        last_trip_date = None
        recent_daily_average = 0
        
        if history:
            # Get the most recent entry
            latest = history[0]
            
            # Find entry from a week ago
            week_ago_entry = next(
                (h for h in history if h["timestamp"] < week_ago), 
                None
            )
            
            # Find entry from a month ago
            month_ago_entry = next(
                (h for h in history if h["timestamp"] < month_ago), 
                None
            )
            
            if week_ago_entry:
                last_week_progress = round(
                    latest["coverage_percentage"] - week_ago_entry["coverage_percentage"], 
                    1
                )
            
            if month_ago_entry:
                last_month_progress = round(
                    latest["coverage_percentage"] - month_ago_entry["coverage_percentage"], 
                    1
                )
            
            # Calculate recent daily average (miles per day)
            if len(history) > 1:
                recent_entries = history[:min(30, len(history))]
                if len(recent_entries) >= 2:
                    oldest_recent = recent_entries[-1]
                    newest_recent = recent_entries[0]
                    days_diff = (newest_recent["timestamp"] - oldest_recent["timestamp"]).days
                    if days_diff > 0:
                        miles_diff = (newest_recent["driven_length"] - oldest_recent["driven_length"]) / 1609.34
                        recent_daily_average = miles_diff / days_diff
            
            # Get last trip date
            trips = await trips_collection.find(
                {"location_id": location_oid}
            ).sort("startTime", -1).limit(1).to_list(length=1)
            
            if trips:
                last_trip_date = trips[0]["startTime"].strftime("%Y-%m-%d")
                
            # Count new streets in the last week
            new_streets = await streets_collection.count_documents({
                "location_id": location_oid,
                "last_driven": {"$gte": week_ago}
            })
            new_streets_count = new_streets
        
        # Prepare response
        display_name = metadata.get("location", {}).get("display_name", "Unknown")
        
        response = {
            "id": str(metadata["_id"]),
            "display_name": display_name,
            "total_length": metadata.get("total_length", 0),
            "driven_length": metadata.get("driven_length", 0),
            "coverage_percentage": metadata.get("coverage_percentage", 0),
            "last_updated": metadata.get("last_updated"),
            "last_week_progress": last_week_progress,
            "last_month_progress": last_month_progress,
            "new_streets_count": new_streets_count,
            "last_trip_date": last_trip_date,
            "recent_daily_average": recent_daily_average
        }
        
        return response
    except Exception as e:
        logger.error(f"Error fetching coverage data: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/streets/{location_id}")
async def get_streets(location_id: str, search: Optional[str] = None):
    """Get streets for a specific location with optional search filter."""
    try:
        # Convert string ID to ObjectId
        location_oid = ObjectId(location_id)
        
        # Build query
        query = {"location_id": location_oid}
        if search:
            query["name"] = {"$regex": search, "$options": "i"}
        
        # Get streets
        streets = await streets_collection.find(query).to_list(length=None)
        
        # Process streets
        result = []
        for street in streets:
            street_data = {
                "id": str(street["_id"]),
                "name": street.get("name", "Unknown Street"),
                "length": street.get("length", 0),
                "coverage": street.get("coverage", 0),
                "geometry": street.get("geometry"),
            }
            
            if "last_driven" in street and street["last_driven"]:
                street_data["last_driven"] = street["last_driven"].strftime("%Y-%m-%d")
            
            result.append(street_data)
        
        return result
    except Exception as e:
        logger.error(f"Error fetching streets: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/coverage_history/{location_id}")
async def get_coverage_history(location_id: str):
    """Get historical coverage data for a specific location."""
    try:
        # Convert string ID to ObjectId
        location_oid = ObjectId(location_id)
        
        # Get progress history
        history = await progress_collection.find(
            {"location_id": location_oid}
        ).sort("timestamp", 1).to_list(length=None)
        
        # Process history for weekly data points
        weekly_data = []
        if history:
            # Group by week
            weeks = {}
            for entry in history:
                if "timestamp" not in entry:
                    continue
                    
                week_start = entry["timestamp"].replace(
                    hour=0, minute=0, second=0, microsecond=0
                )
                week_start = week_start - timedelta(days=week_start.weekday())
                week_key = week_start.strftime("%Y-%m-%d")
                
                if week_key not in weeks or entry["timestamp"] > weeks[week_key]["timestamp"]:
                    weeks[week_key] = {
                        "date": week_key,
                        "coverage_percentage": entry.get("coverage_percentage", 0),
                        "driven_length": entry.get("driven_length", 0),
                        "timestamp": entry["timestamp"]
                    }
            
            # Convert to list and sort
            weekly_data = list(weeks.values())
            weekly_data.sort(key=lambda x: x["date"])
            
            # Remove timestamp from response
            for entry in weekly_data:
                if "timestamp" in entry:
                    del entry["timestamp"]
        
        return {"weekly": weekly_data}
    except Exception as e:
        logger.error(f"Error fetching coverage history: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/update_coverage/{location_id}")
async def update_coverage(location_id: str, background_tasks: BackgroundTasks):
    """Update coverage for a specific location."""
    try:
        location_oid = ObjectId(location_id)
        
        # Get location data
        location = await coverage_metadata_collection.find_one({"_id": location_oid})
        if not location:
            raise HTTPException(status_code=404, detail="Location not found")
        
        # Create a unique task ID for this update
        task_id = str(uuid.uuid4())
        
        # Start the coverage calculation in the background
        background_tasks.add_task(process_coverage_calculation, location, task_id)
        
        return {"task_id": task_id, "message": "Coverage update started"}
    except Exception as e:
        logger.error(f"Error updating coverage: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/suggest_route")
async def suggest_route(request: Request):
    """Generate a suggested route for uncovered streets."""
    try:
        data = await request.json()
        location_id = data.get("location_id")
        route_type = data.get("route_type", "uncovered")
        length_miles = float(data.get("length_miles", 5))
        
        if not location_id:
            raise HTTPException(status_code=400, detail="Location ID is required")
        
        # Convert string ID to ObjectId
        location_oid = ObjectId(location_id)
        
        # Get location data
        location = await coverage_metadata_collection.find_one({"_id": location_oid})
        if not location:
            raise HTTPException(status_code=404, detail="Location not found")
        
        # Get uncovered streets
        query = {"location_id": location_oid}
        if route_type == "uncovered":
            query["coverage"] = {"$lt": 100}
        
        streets = await streets_collection.find(query).to_list(length=None)
        
        if not streets:
            # Return empty route if no streets found
            return {
                "route": {
                    "type": "FeatureCollection",
                    "features": []
                },
                "total_length_miles": 0,
                "street_count": 0,
                "message": "No suitable streets found for route generation"
            }
        
        # Sort streets by various criteria based on route type
        if route_type == "efficient":
            # Sort by length (shortest first) for efficient routes
            streets.sort(key=lambda s: s.get("length", 0))
        elif route_type == "nearby":
            # For nearby streets, we'd need a reference point
            # For now, just use a random selection
            import random
            random.shuffle(streets)
        else:
            # For uncovered streets, prioritize those with least coverage
            streets.sort(key=lambda s: s.get("coverage", 0))
        
        # Select streets up to the requested length
        selected_streets = []
        total_length = 0
        length_limit = length_miles * 1609.34  # Convert miles to meters
        
        for street in streets:
            if "length" not in street:
                continue
                
            street_length = street.get("length", 0)
            if total_length + street_length <= length_limit:
                selected_streets.append(street)
                total_length += street_length
            
            if total_length >= length_limit:
                break
        
        if not selected_streets and streets:
            # If we couldn't find enough streets, just return the first valid one
            for street in streets:
                if "geometry" in street:
                    selected_streets = [street]
                    total_length = street.get("length", 0)
                    break
        
        if not selected_streets:
            # Return empty route if still no valid streets
            return {
                "route": {
                    "type": "FeatureCollection",
                    "features": []
                },
                "total_length_miles": 0,
                "street_count": 0,
                "message": "No valid streets found for route generation"
            }
        
        # Create a GeoJSON route from the selected streets
        features = []
        for street in selected_streets:
            if "geometry" in street:
                feature = {
                    "type": "Feature",
                    "geometry": street["geometry"],
                    "properties": {
                        "name": street.get("name", "Unknown"),
                        "length": street.get("length", 0),
                        "coverage": street.get("coverage", 0)
                    }
                }
                features.append(feature)
        
        route = {
            "type": "FeatureCollection",
            "features": features
        }
        
        # If we have multiple streets, create a single LineString for the route
        if len(features) > 1:
            try:
                coordinates = []
                for feature in features:
                    if feature["geometry"]["type"] == "LineString":
                        coordinates.extend(feature["geometry"]["coordinates"])
                
                route = {
                    "type": "Feature",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": coordinates
                    },
                    "properties": {
                        "length": total_length,
                        "street_count": len(selected_streets)
                    }
                }
            except Exception as e:
                # If combining fails, just return the feature collection
                logger.error(f"Error combining route features: {e}")
        
        return {
            "route": route,
            "total_length_miles": total_length / 1609.34,
            "street_count": len(selected_streets)
        }
    except Exception as e:
        logger.error(f"Error generating route suggestion: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/export_route")
async def export_route(
    location_id: str,
    route_type: str = "uncovered",
    length_miles: float = 5,
    format: str = "gpx"
):
    """Export a suggested route in GPX or GeoJSON format."""
    try:
        # Create a mock request with the route data
        class MockRequest:
            async def json(self):
                return {
                    "location_id": location_id,
                    "route_type": route_type,
                    "length_miles": float(length_miles)
                }
        
        # Generate the route using the mock request
        route_data = await suggest_route(MockRequest())
        route = route_data["route"]
        
        if format.lower() == "gpx":
            # Convert to GPX
            gpx_content = create_gpx(
                route, f"Suggested Route - {route_type.capitalize()}"
            )
            
            # Return as downloadable file
            return StreamingResponse(
                io.StringIO(gpx_content),
                media_type="application/gpx+xml",
                headers={
                    "Content-Disposition": f"attachment; filename=suggested_route_{route_type}.gpx"
                }
            )
        else:
            # Return GeoJSON
            return StreamingResponse(
                io.StringIO(json.dumps(route)),
                media_type="application/geo+json",
                headers={
                    "Content-Disposition": f"attachment; filename=suggested_route_{route_type}.geojson"
                }
            )
    except Exception as e:
        logger.error(f"Error exporting route: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run("app:app", host="0.0.0.0", port=port, log_level="info", reload=True)
