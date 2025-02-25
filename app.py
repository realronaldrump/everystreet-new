import os
import json
import logging
import asyncio
import io
import uuid
from datetime import datetime, timedelta, timezone
from math import radians, cos, sin, sqrt, atan2
from typing import List, Dict, Any, Optional, Union, Tuple

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
from fastapi import FastAPI, Request, WebSocket, HTTPException, UploadFile, File
from fastapi.templating import Jinja2Templates
from fastapi.responses import JSONResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketDisconnect

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

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

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


# --- Helper Functions ---
def serialize_datetime(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def serialize_trip(trip: dict) -> dict:
    if "_id" in trip:
        trip["_id"] = str(trip["_id"])
    for key in ("startTime", "endTime"):
        if key in trip and isinstance(trip[key], datetime):
            trip[key] = trip[key].isoformat()
    return trip


def parse_query_date(
    date_str: Optional[str], end_of_day: bool = False
) -> Optional[datetime]:
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


def parse_gps(gps) -> dict:
    if isinstance(gps, str):
        try:
            return json.loads(gps)
        except Exception as e:
            logger.error("Error parsing gps data: %s", e)
            return {}
    return gps


async def get_trip_and_collection(
    trip_id: str, trip_type: Optional[str] = None
) -> Tuple[Optional[dict], Any]:
    coll = (
        trips_collection if trip_type != "matched_trips" else matched_trips_collection
    )
    trip = await coll.find_one(
        {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]}
    )
    if not trip:
        other_coll = (
            trips_collection
            if coll == matched_trips_collection
            else matched_trips_collection
        )
        trip = await other_coll.find_one(
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]}
        )
        if trip:
            coll = other_coll
    return trip, coll


# --- WebSocket Connection Manager ---
class ConnectionManager:
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


# --- Custom Place Class ---
class CustomPlace:
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


# --- Basic Pages ---
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
        storage_limit_mb = 512
        storage_usage_percent = round((storage_used_mb / storage_limit_mb) * 100, 2)
        collections_info = []
        for coll_name in await db.list_collection_names():
            stats = await db.command("collStats", coll_name)
            collections_info.append(
                {
                    "name": coll_name,
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


# --- Middleware ---
@app.middleware("http")
async def add_header(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# --- Background Tasks Config / Control ---
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
            for task_id, task_cfg in data["tasks"].items():
                if task_id in task_manager.tasks:
                    if task_id not in config["tasks"]:
                        config["tasks"][task_id] = {}
                    if "enabled" in task_cfg:
                        config["tasks"][task_id]["enabled"] = task_cfg["enabled"]
                    if "interval_minutes" in task_cfg:
                        config["tasks"][task_id]["interval_minutes"] = task_cfg[
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


# --- Edit Trips Endpoints ---
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
        coll = trips_collection if trip_type == "trips" else matched_trips_collection
        query: Dict[str, Any] = {}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        docs = await coll.find(query).to_list(length=None)
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
        trip, coll = await get_trip_and_collection(trip_id, trip_type)
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
        result = await coll.update_one({"_id": trip["_id"]}, {"$set": update_fields})
        if not result.modified_count:
            raise HTTPException(status_code=400, detail="No changes made")
        return {"message": "Trip updated"}
    except Exception as e:
        logger.exception("Error updating trip %s", trip_id)
        raise HTTPException(status_code=500, detail=str(e))


# --- Street Coverage / Computations ---
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
            disp = location.get("display_name", "Unknown")
            await coverage_metadata_collection.update_one(
                {"location.display_name": disp},
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


# --- Trips (Regular, Uploaded, Historical) ---
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
        reg_fut = trips_collection.find(query).to_list(None)
        up_fut = uploaded_trips_collection.find(query).to_list(None)
        hist_fut = historical_trips_collection.find(query).to_list(None)
        regular, uploaded, historical = await asyncio.gather(reg_fut, up_fut, hist_fut)
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
                geom = parse_gps(trip.get("gps"))
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
        pipeline_mv = [
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
        trips_mv = await trips_collection.aggregate(pipeline_mv).to_list(None)
        uploaded_mv = await uploaded_trips_collection.aggregate(pipeline_mv).to_list(
            None
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
        all_mv = trips_mv + uploaded_mv
        if all_mv:
            best = sorted(all_mv, key=lambda x: x["count"], reverse=True)[0]
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
        trips_future = trips_collection.find(query).to_list(None)
        hist_future = historical_trips_collection.find(query).to_list(None)
        trips_data, hist_data = await asyncio.gather(trips_future, hist_future)
        all_trips = trips_data + hist_data
        total_trips = len(all_trips)
        if not total_trips:
            empty = {
                "total_trips": 0,
                "total_distance": "0.00",
                "avg_distance": "0.00",
                "avg_start_time": "00:00 AM",
                "avg_driving_time": "00:00",
                "avg_speed": "0.00",
                "max_speed": "0.00",
            }
            return JSONResponse(content=empty)
        total_distance = sum(t.get("distance", 0) for t in all_trips)
        avg_distance_val = total_distance / total_trips if total_trips > 0 else 0.0
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
    start_date = datetime.now(timezone.utc) - timedelta(days=4 * 365)
    end_date = datetime.now(timezone.utc)
    await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=False)
    return {"status": "success", "message": "Trips fetched & stored."}


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


# --- Export Endpoints ---
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
            gps_data = parse_gps(t["gps"])
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
            gps_data = parse_gps(t["gps"])
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
            track.description = (
                f"Trip from {t.get('startLocation', 'Unknown')} to "
                f"{t.get('destination', 'Unknown')}"
            )
        gpx_xml = gpx_obj.to_xml()
        return StreamingResponse(
            io.BytesIO(gpx_xml.encode()),
            media_type="application/gpx+xml",
            headers={"Content-Disposition": 'attachment; filename="trips.gpx"'},
        )
    except Exception as e:
        logger.exception("Error exporting GPX")
        raise HTTPException(status_code=500, detail=str(e))


# --- Validation / OSM Data ---
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
) -> Tuple[Optional[dict], Optional[str]]:
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
            bson_size = len(json.dumps(geojson_data).encode("utf-8"))
            if bson_size <= 16793598:
                existing = await osm_data_collection.find_one(
                    {"location": location, "type": osm_type}
                )
                if existing:
                    await osm_data_collection.update_one(
                        {"_id": existing["_id"]},
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


# --- Map Matching Endpoints ---
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
        trips_list = await trips_collection.find(query).to_list(length=None)
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
        trips_list = await historical_trips_collection.find(query).to_list(length=None)
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
        total_deleted = 0
        if interval_days > 0:
            current = start_date
            while current < end_date:
                current_end = min(current + timedelta(days=interval_days), end_date)
                res = await matched_trips_collection.delete_many(
                    {"startTime": {"$gte": current, "$lt": current_end}}
                )
                total_deleted += res.deleted_count
                current = current_end
        else:
            res = await matched_trips_collection.delete_many(
                {"startTime": {"$gte": start_date, "$lte": end_date}}
            )
            total_deleted = res.deleted_count
        return {"status": "success", "deleted_count": total_deleted}
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
        trips_list = await trips_collection.find(
            {"startTime": {"$gte": start_date, "$lte": end_date}}
        ).to_list(length=None)
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
    if fmt == "geojson":
        gps_data = parse_gps(t["gps"])
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
                "Content-Disposition": f'attachment; filename="trip_{trip_id}.geojson"'
            },
        )
    elif fmt == "gpx":
        gpx_obj = gpxpy.gpx.GPX()
        track = gpxpy.gpx.GPXTrack()
        gpx_obj.tracks.append(track)
        seg = gpxpy.gpx.GPXTrackSegment()
        track.segments.append(seg)
        gps_data = parse_gps(t["gps"])
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
                "Content-Disposition": f'attachment; filename="trip_{trip_id}.gpx"'
            },
        )
    else:
        raise HTTPException(status_code=400, detail="Unsupported format")


@app.delete("/api/matched_trips/{trip_id}")
async def delete_matched_trip(trip_id: str):
    try:
        res = await matched_trips_collection.delete_one(
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]}
        )
        if res.deleted_count:
            return {"status": "success", "message": "Deleted matched trip"}
        raise HTTPException(status_code=404, detail="Trip not found")
    except Exception as e:
        logger.exception("Error deleting matched trip %s", trip_id)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/debug/trip/{trip_id}")
async def debug_trip(trip_id: str):
    try:
        reg_trip = await trips_collection.find_one(
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]}
        )
        match_trip = await matched_trips_collection.find_one(
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]}
        )
        return {
            "regular_trip_found": bool(reg_trip),
            "matched_trip_found": bool(match_trip),
            "regular_trip_id_field": (
                reg_trip.get("transactionId") if reg_trip else None
            ),
            "matched_trip_id_field": (
                match_trip.get("transactionId") if match_trip else None
            ),
        }
    except Exception as e:
        logger.exception("debug_trip error")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/first_trip_date")
async def get_first_trip_date():
    try:
        reg_trip = await trips_collection.find_one({}, sort=[("startTime", 1)])
        up_trip = await uploaded_trips_collection.find_one({}, sort=[("startTime", 1)])
        hist_trip = await historical_trips_collection.find_one(
            {}, sort=[("startTime", 1)]
        )
        candidates = []
        if reg_trip and reg_trip.get("startTime"):
            candidates.append(reg_trip["startTime"])
        if up_trip and up_trip.get("startTime"):
            candidates.append(up_trip["startTime"])
        if hist_trip and hist_trip.get("startTime"):
            candidates.append(hist_trip["startTime"])
        if not candidates:
            now = datetime.now(timezone.utc)
            return {"first_trip_date": now.isoformat()}
        earliest = min(candidates)
        if earliest.tzinfo is None:
            earliest = earliest.replace(tzinfo=timezone.utc)
        return {"first_trip_date": earliest.isoformat()}
    except Exception as e:
        logger.exception("get_first_trip_date error")
        raise HTTPException(status_code=500, detail=str(e))


# --- GPX / GeoJSON Upload ---
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
        res = await uploaded_trips_collection.delete_one({"_id": ObjectId(trip_id)})
        if res.deleted_count == 1:
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
            stime = (
                dateutil_parser.isoparse(stime_str)
                if stime_str
                else datetime.now(timezone.utc)
            )
            etime = dateutil_parser.isoparse(etime_str) if etime_str else stime
            trip_geo = {
                "type": geom.get("type"),
                "coordinates": geom.get("coordinates"),
            }
            dist = calculate_distance(geom.get("coordinates", []))
            trips.append(
                {
                    "transactionId": tid,
                    "startTime": stime,
                    "endTime": etime,
                    "gps": json.dumps(trip_geo),
                    "distance": dist,
                    "imei": "HISTORICAL",
                }
            )
        return trips
    except Exception as e:
        logger.exception("Error in process_geojson_trip")
        return None


async def process_and_store_trip(trip: dict):
    try:
        gps = trip["gps"]
        if isinstance(gps, str):
            gps = json.loads(gps)
        coords = gps.get("coordinates", [])
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
            fname = f.filename.lower()
            if fname.endswith(".gpx"):
                data = await f.read()
                gpx_obj = gpxpy.parse(data)
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
                        dist_m = calculate_gpx_distance(coords)
                        dist_miles = meters_to_miles(dist_m)
                        trip_data = {
                            "transactionId": f"GPX-{start_t.strftime('%Y%m%d%H%M%S')}-{fname}",
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
            elif fname.endswith(".geojson"):
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
                logger.warning("Skipping unhandled file extension: %s", fname)
        return {"status": "success", "message": f"{success_count} trips uploaded."}
    except Exception as e:
        logger.exception("Error upload_gpx")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/upload")
async def upload_files(request: Request, files: List[UploadFile] = File(...)):
    try:
        count = 0
        for file in files:
            fname = file.filename.lower()
            content = await file.read()
            if fname.endswith(".gpx"):
                gpx_obj = gpxpy.parse(content)
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
            elif fname.endswith(".geojson"):
                try:
                    data_geojson = json.loads(content)
                except json.JSONDecodeError:
                    logger.warning("Invalid geojson: %s", fname)
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


@app.delete("/api/trips/bulk_delete")
async def bulk_delete_trips(request: Request):
    try:
        data = await request.json()
        trip_ids = data.get("trip_ids", [])
        if not trip_ids:
            raise HTTPException(status_code=400, detail="No trip IDs provided")
        res1 = await trips_collection.delete_many({"transactionId": {"$in": trip_ids}})
        res2 = await matched_trips_collection.delete_many(
            {"transactionId": {"$in": trip_ids}}
        )
        return {
            "status": "success",
            "message": f"Deleted {res1.deleted_count} trips and {res2.deleted_count} matched trips",
            "deleted_trips_count": res1.deleted_count,
            "deleted_matched_trips_count": res2.deleted_count,
        }
    except Exception as e:
        logger.exception("Error in bulk_delete_trips")
        raise HTTPException(status_code=500, detail=str(e))


# --- Places Endpoints ---
@app.api_route("/api/places", methods=["GET", "POST"])
async def handle_places(request: Request):
    if request.method == "GET":
        pls = await places_collection.find().to_list(length=None)
        return [
            {"_id": str(p["_id"]), **CustomPlace.from_dict(p).to_dict()} for p in pls
        ]
    else:
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
            trips = await coll.find(query).to_list(length=None)
            valid_trips.extend(trips)
        valid_trips.sort(key=lambda x: x["endTime"])
        visits = []
        durations = []
        time_since = []
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
                    same = False
                    if next_trip.get("startPlaceId") == place_id:
                        same = True
                    else:
                        start_pt = next_trip.get("startGeoPoint")
                        if (
                            start_pt
                            and isinstance(start_pt, dict)
                            and "coordinates" in start_pt
                        ):
                            if shape(p["geometry"]).contains(shape(start_pt)):
                                same = True
                    if same:
                        next_start = next_trip.get("startTime")
                        if isinstance(next_start, str):
                            next_start = dateutil_parser.isoparse(next_start)
                        if next_start and next_start.tzinfo is None:
                            next_start = next_start.replace(tzinfo=timezone.utc)
                        if next_start and next_start > t_end:
                            dur = (next_start - t_end).total_seconds() / 60.0
                            if dur > 0:
                                durations.append(dur)
                if i > 0:
                    prev_end = valid_trips[i - 1].get("endTime")
                    if isinstance(prev_end, str):
                        prev_end = dateutil_parser.isoparse(prev_end)
                    if prev_end and prev_end.tzinfo is None:
                        prev_end = prev_end.replace(tzinfo=timezone.utc)
                    if prev_end and t_end > prev_end:
                        hrs = (t_end - prev_end).total_seconds() / 3600.0
                        if hrs >= 0:
                            time_since.append(hrs)
                visits.append(t_end)
            except Exception as ex:
                logger.exception("Issue processing trip for place %s", place_id)
                continue
        total_visits = len(visits)
        avg_dur = sum(durations) / len(durations) if durations else 0

        def fmt(m: float) -> str:
            return f"{int(m // 60)}h {int(m % 60):02d}m"

        return {
            "totalVisits": total_visits,
            "averageTimeSpent": fmt(avg_dur) if avg_dur > 0 else "0h 00m",
            "firstVisit": serialize_datetime(first_visit),
            "lastVisit": serialize_datetime(last_visit),
            "averageTimeSinceLastVisit": (
                (sum(time_since) / len(time_since)) if time_since else 0
            ),
            "name": p["name"],
        }
    except Exception as e:
        logger.exception("Error place stats %s", place_id)
        raise HTTPException(status_code=500, detail=str(e))


# --- GPX / GeoJSON Processing and Upload Helpers ---


@app.delete("/api/uploaded_trips/bulk_delete")
async def bulk_delete_uploaded_trips(request: Request):
    try:
        data = await request.json()
        trip_ids = data.get("trip_ids", [])
        if not trip_ids:
            raise HTTPException(status_code=400, detail="No trip IDs")
        valid = []
        for tid in trip_ids:
            try:
                valid.append(ObjectId(tid))
            except bson.errors.InvalidId:
                logger.warning("Invalid ObjectId: %s", tid)
        if not valid:
            raise HTTPException(status_code=400, detail="No valid IDs found")
        ups = await uploaded_trips_collection.find({"_id": {"$in": valid}}).to_list(
            length=None
        )
        trans = [u["transactionId"] for u in ups]
        res1 = await uploaded_trips_collection.delete_many({"_id": {"$in": valid}})
        res2 = await matched_trips_collection.delete_many(
            {"transactionId": {"$in": trans}}
        )
        return {
            "status": "success",
            "deleted_uploaded_trips": res1.deleted_count,
            "deleted_matched_trips": res2.deleted_count,
        }
    except Exception as e:
        logger.exception("Error in bulk_delete_uploaded_trips")
        raise HTTPException(status_code=500, detail=str(e))


# --- Last Trip Point ---
@app.get("/api/last_trip_point")
async def get_last_trip_point():
    try:
        recent = await trips_collection.find_one(sort=[("endTime", -1)])
        if not recent:
            return {"lastPoint": None}
        gps = parse_gps(recent["gps"])
        if "coordinates" not in gps or not gps["coordinates"]:
            return {"lastPoint": None}
        return {"lastPoint": gps["coordinates"][-1]}
    except Exception:
        logger.exception("Error in get_last_trip_point")
        raise HTTPException(
            status_code=500, detail="Failed to retrieve last trip point"
        )


# --- Single Trip GET/DELETE ---
@app.get("/api/trips/{trip_id}")
async def get_single_trip(trip_id: str):
    try:
        trip, _ = await get_trip_and_collection(trip_id)
        if not trip:
            raise HTTPException(status_code=404, detail="Trip not found")
        return {"status": "success", "trip": serialize_trip(trip)}
    except Exception as e:
        logger.exception("Error in get_single_trip")
        raise HTTPException(status_code=500, detail="Internal server error") from e


@app.delete("/api/trips/{trip_id}")
async def delete_trip(trip_id: str):
    try:
        trip = await trips_collection.find_one({"transactionId": trip_id})
        if trip:
            coll = trips_collection
        else:
            trip = await matched_trips_collection.find_one({"transactionId": trip_id})
            if trip:
                coll = matched_trips_collection
            else:
                raise HTTPException(status_code=404, detail="Trip not found")
        res = await coll.delete_one({"transactionId": trip_id})
        if res.deleted_count == 1:
            return {"status": "success", "message": "Trip deleted successfully"}
        raise HTTPException(status_code=500, detail="Failed to delete trip")
    except Exception as e:
        logger.exception("Error deleting trip")
        raise HTTPException(status_code=500, detail="Internal server error") from e


# --- Add new trip-analytics endpoint ---
@app.get("/api/trip-analytics")
async def get_trip_analytics(request: Request):
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

        # Get trip data
        trips_list = await trips_collection.find(query).to_list(length=None)
        uploaded_list = await uploaded_trips_collection.find(query).to_list(length=None)
        all_trips = trips_list + uploaded_list

        # Process daily distances
        daily_distances = {}
        time_distribution = [{"hour": i, "count": 0} for i in range(24)]

        for trip in all_trips:
            try:
                start_time = trip.get("startTime")
                if not start_time:
                    continue

                if isinstance(start_time, str):
                    start_time = dateutil_parser.isoparse(start_time)
                if start_time.tzinfo is None:
                    start_time = start_time.replace(tzinfo=timezone.utc)

                # Add to time distribution
                hour = start_time.hour
                time_distribution[hour]["count"] += 1

                # Add to daily distances
                date_key = start_time.strftime("%Y-%m-%d")
                distance = float(trip.get("distance", 0))

                if date_key not in daily_distances:
                    daily_distances[date_key] = {
                        "date": date_key,
                        "distance": 0,
                        "count": 0,
                    }

                daily_distances[date_key]["distance"] += distance
                daily_distances[date_key]["count"] += 1

            except Exception as e:
                logger.warning(f"Error processing trip analytics: {e}")
                continue

        # Convert to sorted list for output
        daily_distances_list = list(daily_distances.values())
        daily_distances_list.sort(key=lambda x: x["date"])

        return {
            "daily_distances": daily_distances_list,
            "time_distribution": time_distribution,
        }
    except Exception as e:
        logger.exception("Error in get_trip_analytics")
        raise HTTPException(status_code=500, detail=str(e))
