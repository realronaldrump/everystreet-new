# app.py (Corrected)
import os
import json
import logging
import asyncio
import traceback
import zipfile
import glob
import io
from datetime import datetime, timedelta, timezone
from math import radians, cos, sin, sqrt, atan2
from typing import List, Dict, Any
from fastapi.staticfiles import StaticFiles
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError
from starlette.websockets import WebSocketDisconnect
import shutil

import aiohttp
import certifi
import geopandas as gpd
import geojson as geojson_module
import gpxpy
import pytz
from bson import ObjectId
from dateutil import parser
from dotenv import load_dotenv
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.base import JobLookupError
from shapely.geometry import LineString, Point, Polygon, shape

from timestamp_utils import get_trip_timestamps, sort_and_filter_trip_coordinates
from update_geo_points import update_geo_points
from utils import validate_location_osm, validate_trip_data, reverse_geocode_nominatim
from map_matching import process_and_map_match_trip
from bouncie_trip_fetcher import fetch_bouncie_trips_in_range, fetch_and_store_trips
from preprocess_streets import preprocess_streets as async_preprocess_streets
from tasks import task_manager, AVAILABLE_TASKS, start_background_tasks, TaskStatus
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
)
from trip_processing import format_idle_time
from export_helpers import create_geojson, create_gpx
from street_coverage_calculation import (
    compute_coverage_for_location,
    update_coverage_for_all_locations,
)

load_dotenv()

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)

uploaded_trips_collection.create_index("transactionId", unique=True)
matched_trips_collection.create_index("transactionId", unique=True)
osm_data_collection.create_index([("location", 1), ("type", 1)], unique=True)
streets_collection.create_index([("geometry", "2dsphere")])
streets_collection.create_index([("properties.location", 1)])
coverage_metadata_collection.create_index([("location", 1)], unique=True)

from fastapi import FastAPI, Request, WebSocket, HTTPException, UploadFile, File
from fastapi.responses import (
    JSONResponse,
    HTMLResponse,
    StreamingResponse,
    FileResponse,
)
from fastapi.templating import Jinja2Templates

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

active_trips = {}
progress_data = {
    "fetch_and_store_trips": {"status": "idle", "progress": 0, "message": ""},
    "fetch_bouncie_trips_in_range": {"status": "idle", "progress": 0, "message": ""},
    "preprocess_streets": {"status": "idle", "progress": 0, "message": ""},
}


@app.middleware("http")
async def add_header(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@app.get("/api/background_tasks/config")
async def get_background_tasks_config():
    """Get current task configuration and status."""
    config = await task_manager._get_config()

    # Enrich the response with task definitions and current status
    for task_id, task_def in task_manager.tasks.items():
        if task_id not in config["tasks"]:
            config["tasks"][task_id] = {}

        task_config = config["tasks"][task_id]
        task_config["display_name"] = task_def.display_name
        task_config["description"] = task_def.description
        task_config["priority"] = task_def.priority.name
        task_config["status"] = task_config.get("status", "IDLE")

        # Format timestamps for display
        for ts_field in ["last_run", "next_run", "start_time", "end_time"]:
            if ts_field in task_config and task_config[ts_field]:
                if isinstance(task_config[ts_field], str):
                    task_config[ts_field] = task_config[ts_field]
                else:
                    task_config[ts_field] = task_config[ts_field].isoformat()

    return config


@app.post("/api/background_tasks/config")
async def update_background_tasks_config(request: Request):
    data = await request.json()
    config = await task_manager._get_config()
    if "globalDisable" in data:
        config["disabled"] = data["globalDisable"]
    if "tasks" in data:
        for task_id, task_config in data["tasks"].items():
            if task_id in task_manager.tasks:
                if task_id not in config["tasks"]:
                    config["tasks"][task_id] = {}
                config["tasks"][task_id].update(task_config)
    await task_config_collection.replace_one(
        {"_id": "global_background_task_config"}, config, upsert=True
    )
    await task_manager.reinitialize_tasks()
    return {"status": "success", "message": "Configuration updated"}


@app.post("/api/background_tasks/pause")
async def pause_background_tasks(request: Request):
    data = await request.json()
    minutes = data.get("minutes", 30)

    config = await task_manager._get_config()
    config["disabled"] = True
    await task_config_collection.replace_one(
        {"_id": "global_background_task_config"}, config, upsert=True
    )

    await task_manager.stop()
    return {
        "status": "success",
        "message": f"Background tasks paused for {minutes} minutes",
    }


@app.post("/api/background_tasks/resume")
async def resume_background_tasks():
    config = await task_manager._get_config()
    config["disabled"] = False
    await task_config_collection.replace_one(
        {"_id": "global_background_task_config"}, config, upsert=True
    )

    await task_manager.start()
    return {"status": "success", "message": "Background tasks resumed"}


@app.post("/api/background_tasks/stop_all")
async def stop_all_background_tasks():
    await task_manager.stop()
    return {"status": "success", "message": "All background tasks stopped"}


@app.post("/api/background_tasks/enable")
async def enable_all_background_tasks():
    config = await task_manager._get_config()
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
    config = await task_manager._get_config()
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
    """Manually run selected tasks with improved status tracking."""
    try:
        data = await request.json()
        tasks_to_run = data.get("tasks", [])
        results = []

        for task_id in tasks_to_run:
            if task_id == "ALL":
                for t_id in task_manager.tasks:
                    task_func = task_manager._get_task_function(t_id)
                    if task_func:
                        try:
                            await task_manager._update_task_status(
                                t_id, TaskStatus.RUNNING
                            )
                            await task_func()
                            await task_manager._update_task_status(
                                t_id, TaskStatus.COMPLETED
                            )
                            results.append({"task": t_id, "success": True})
                        except Exception as e:
                            error_msg = str(e)
                            await task_manager._update_task_status(
                                t_id, TaskStatus.FAILED
                            )
                            logger.error(f"Error running task {t_id}: {error_msg}")
                            results.append(
                                {"task": t_id, "success": False, "error": error_msg}
                            )
            elif task_id in task_manager.tasks:
                task_func = task_manager._get_task_function(task_id)
                if task_func:
                    try:
                        await task_manager._update_task_status(
                            task_id, TaskStatus.RUNNING
                        )
                        await task_func()
                        await task_manager._update_task_status(
                            task_id, TaskStatus.COMPLETED
                        )
                        results.append({"task": task_id, "success": True})
                    except Exception as e:
                        error_msg = str(e)
                        await task_manager._update_task_status(
                            task_id, TaskStatus.FAILED
                        )
                        logger.error(f"Error running task {task_id}: {error_msg}")
                        results.append(
                            {"task": task_id, "success": False, "error": error_msg}
                        )

        return {
            "status": "success",
            "message": f"Manually ran {len(results)} tasks",
            "results": results,
        }
    except Exception as e:
        logger.error(f"Error in manually_run_tasks: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/background_tasks/manual_run_old")  # Keep the old one, rename it
async def manually_run_tasks_old(request: Request):
    data = await request.json()
    tasks_to_run = data.get("tasks", [])
    if not tasks_to_run:
        raise HTTPException(status_code=400, detail="No tasks provided")
    if "ALL" in tasks_to_run:
        tasks_to_run = [t.id for t in AVAILABLE_TASKS]  # Use the new AVAILABLE_TASKS

    results = []

    async def run_task_by_id(task_id: str):
        task_func = task_manager._get_task_function(
            task_id
        )  # Corrected: use _get_task_function
        if task_func:
            await task_func()
            return True
        else:
            return False

    for t in tasks_to_run:
        ok = await run_task_by_id(t)
        results.append({"task": t, "success": ok})
    return {"status": "success", "results": results}


class ConnectionManager:
    def __init__(self):
        self.active_connections = []  # type: List[WebSocket]

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


class CustomPlace:
    def __init__(self, name: str, geometry: dict, created_at: datetime = None):
        self.name = name
        self.geometry = geometry
        self.created_at = created_at or datetime.now(timezone.utc)

    def to_dict(self):
        return {
            "name": self.name,
            "geometry": self.geometry,
            "created_at": self.created_at.isoformat(),
        }

    @staticmethod
    def from_dict(data: dict):
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


@app.get("/api/edit_trips")
async def get_edit_trips(request: Request):
    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")
        trip_type = request.query_params.get("type")

        if trip_type == "trips":
            collection = trips_collection
        elif trip_type == "matched_trips":
            collection = matched_trips_collection
        else:
            raise HTTPException(status_code=400, detail="Invalid trip type")

        start_date = datetime.fromisoformat(start_date_str)
        end_date = datetime.fromisoformat(end_date_str)
        query = {"startTime": {"$gte": start_date, "$lte": end_date}}

        docs = []
        trips_cursor = collection.find(query)
        async for doc in to_async_iterator(trips_cursor):
            doc["_id"] = str(doc["_id"])
            docs.append(doc)

        return {"status": "success", "trips": docs}

    except Exception as e:
        logger.error(f"Error fetching trips for editing: {e}", exc_info=True)
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
            {
                "$or": [
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ]
            }
        )

        if not trip:
            other_collection = (
                matched_trips_collection
                if trip_type != "matched_trips"
                else trips_collection
            )
            trip = await other_collection.find_one(
                {
                    "$or": [
                        {"transactionId": trip_id},
                        {"transactionId": str(trip_id)},
                    ]
                }
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
                        props[field] = parser.isoparse(props[field])
                    except ValueError:
                        pass
            for field in ["distance", "maxSpeed", "totalIdleDuration", "fuelConsumed"]:
                if field in props and props[field] is not None:
                    try:
                        props[field] = float(props[field])
                    except ValueError:
                        pass

            if "properties" in trip:
                update_fields["properties"] = {**trip["properties"], **props}
            else:
                update_fields.update(props)

        result = await collection.update_one(
            {"_id": trip["_id"]}, {"$set": update_fields}
        )
        if not result.modified_count:
            raise HTTPException(status_code=400, detail="No changes made")

        return {"message": "Trip updated"}

    except Exception as e:
        logger.error(f"Error updating {trip_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


async def fetch_trips_for_geojson():
    features = []
    async for trip in trips_collection.find():
        try:
            geom = trip.get("gps")
            if isinstance(geom, str):
                geom = geojson_module.loads(geom)
            props = {
                "transactionId": trip.get("transactionId"),
                "imei": trip.get("imei"),
                "startTime": (
                    trip.get("startTime").isoformat() if trip.get("startTime") else ""
                ),
                "endTime": (
                    trip.get("endTime").isoformat() if trip.get("endTime") else ""
                ),
                "distance": trip.get("distance", 0),
                "destination": trip.get("destination", ""),
                "startLocation": trip.get("startLocation", ""),
                "timeZone": trip.get("timeZone", "UTC"),
            }
            feature = geojson_module.Feature(geometry=geom, properties=props)
            features.append(feature)
        except Exception as e:
            logger.error(
                f"Error processing trip {trip.get('transactionId')}: {e}", exc_info=True
            )
    return geojson_module.FeatureCollection(features)


@app.post("/api/street_coverage")
async def get_street_coverage(request: Request):
    try:
        data = await request.json()
        location = data.get("location")
        if not location or not isinstance(location, dict):
            raise HTTPException(status_code=400, detail="Invalid location data.")
        logger.info(
            f"Calculating coverage for location: {location.get('display_name', 'Unknown')}"
        )
        result = await compute_coverage_for_location(location)
        if result is None:
            raise HTTPException(
                status_code=404, detail="No street data found or error in computation."
            )
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
        return result
    except Exception as e:
        logger.error(
            f"Error in street coverage calculation: {e}\n{traceback.format_exc()}"
        )
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/trips")
async def get_trips(request: Request):
    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")
        imei = request.query_params.get("imei")
        start_date = (
            datetime.fromisoformat(start_date_str).replace(tzinfo=timezone.utc)
            if start_date_str
            else None
        )
        end_date = (
            datetime.fromisoformat(end_date_str).replace(
                hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
            )
            if end_date_str
            else None
        )
        query = {}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        if imei:
            query["imei"] = imei

        async def fetch_trips(coll, q):
            return await coll.find(q).to_list(length=None)

        regular, uploaded, historical = await asyncio.gather(
            fetch_trips(trips_collection, query),
            fetch_trips(uploaded_trips_collection, query),
            fetch_trips(historical_trips_collection, query),
        )
        all_trips = regular + uploaded + historical
        features = []
        for trip in all_trips:
            try:
                st = trip.get("startTime")
                et = trip.get("endTime")
                if st is None or et is None:
                    logger.warning(
                        f"Skipping trip {trip.get('transactionId', 'unknown')} due to missing times"
                    )
                    continue
                if isinstance(st, str):
                    st = parser.isoparse(st)
                if isinstance(et, str):
                    et = parser.isoparse(et)
                if st.tzinfo is None:
                    st = st.replace(tzinfo=timezone.utc)
                if et.tzinfo is None:
                    et = et.replace(tzinfo=timezone.utc)
                trip["startTime"] = st
                trip["endTime"] = et
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
                logger.error(
                    f"Error processing trip {trip.get('transactionId', 'unknown')}: {e}",
                    exc_info=True,
                )
                continue
        fc = geojson_module.FeatureCollection(features)
        return JSONResponse(content=fc)
    except Exception as e:
        logger.error(f"Error in /api/trips endpoint: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve trips")


@app.get("/api/driving-insights")
async def get_driving_insights(request: Request):
    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")
        imei = request.query_params.get("imei")
        start_date = (
            datetime.fromisoformat(start_date_str).replace(tzinfo=timezone.utc)
            if start_date_str
            else None
        )
        end_date = (
            datetime.fromisoformat(end_date_str).replace(
                hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
            )
            if end_date_str
            else None
        )
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
        result_trips = await trips_collection.aggregate(pipeline).to_list(length=None)
        result_uploaded = await uploaded_trips_collection.aggregate(pipeline).to_list(
            length=None
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
        result_most_visited_trips = await trips_collection.aggregate(
            pipeline_most_visited
        ).to_list(length=None)
        result_most_visited_uploaded = await uploaded_trips_collection.aggregate(
            pipeline_most_visited
        ).to_list(length=None)

        combined = {
            "total_trips": 0,
            "total_distance": 0.0,
            "total_fuel_consumed": 0.0,
            "max_speed": 0.0,
            "total_idle_duration": 0,
            "longest_trip_distance": 0.0,
            "most_visited": {},
        }
        for r in result_trips + result_uploaded:
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
        all_most_visited = result_most_visited_trips + result_most_visited_uploaded
        if all_most_visited:
            best = sorted(all_most_visited, key=lambda x: x["count"], reverse=True)[0]
            combined["most_visited"] = {
                "_id": best["_id"],
                "count": best["count"],
                "isCustomPlace": best.get("isCustomPlace", False),
            }
        return JSONResponse(content=combined)
    except Exception as e:
        logger.error(f"Error in get_driving_insights: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/metrics")
async def get_metrics(request: Request):
    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")
        imei = request.query_params.get("imei")

        start_date = (
            datetime.fromisoformat(start_date_str).replace(tzinfo=timezone.utc)
            if start_date_str
            else None
        )
        end_date = (
            datetime.fromisoformat(end_date_str).replace(
                hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
            )
            if end_date_str
            else None
        )

        query = {}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        if imei:
            query["imei"] = imei

        # Use asyncio.gather to run MongoDB queries concurrently
        trips_cursor, hist_cursor = await asyncio.gather(
            trips_collection.find(query).to_list(None),
            historical_trips_collection.find(query).to_list(None),
        )

        all_trips = trips_cursor + hist_cursor
        total_trips = len(all_trips)

        if not total_trips:
            fc = geojson_module.FeatureCollection([])  # An empty feature collection
            return JSONResponse(content=fc)

        total_distance = sum(t.get("distance", 0) for t in all_trips)
        avg_distance = total_distance / total_trips if total_trips > 0 else 0.0

        # Process start times
        start_times = []
        for t in all_trips:
            st = t.get("startTime")
            if st.tzinfo is None:
                st = st.replace(tzinfo=timezone.utc)
            st_local = st.astimezone(pytz.timezone("America/Chicago"))
            start_times.append(st_local.hour + st_local.minute / 60.0)

        avg_start_time = sum(start_times) / len(start_times) if start_times else 0
        hour = int(avg_start_time)
        minute = int((avg_start_time - hour) * 60)
        am_pm = "AM" if hour < 12 else "PM"
        if hour == 0:
            hour = 12
        elif hour > 12:
            hour -= 12

        # Calculate driving times
        driving_times = [
            (t["endTime"] - t["startTime"]).total_seconds() / 60.0 for t in all_trips
        ]
        avg_driving_minutes = (
            sum(driving_times) / len(driving_times) if driving_times else 0
        )
        avg_driving_h = int(avg_driving_minutes // 60)
        avg_driving_m = int(avg_driving_minutes % 60)

        total_driving_hours = sum(driving_times) / 60.0 if driving_times else 0
        avg_speed = total_distance / total_driving_hours if total_driving_hours else 0
        max_speed = max((t.get("maxSpeed", 0) for t in all_trips), default=0)

        return JSONResponse(
            content={
                "total_trips": total_trips,
                "total_distance": f"{round(total_distance, 2)}",
                "avg_distance": f"{round(avg_distance, 2)}",
                "avg_start_time": f"{hour:02d}:{minute:02d} {am_pm}",
                "avg_driving_time": f"{avg_driving_h:02d}:{avg_driving_m:02d}",
                "avg_speed": f"{round(avg_speed, 2)}",
                "max_speed": f"{round(max_speed, 2)}",
            }
        )
    except Exception as e:
        logger.error(f"Error in get_metrics: {e}", exc_info=True)
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
    start_date = datetime.fromisoformat(data["start_date"]).replace(tzinfo=timezone.utc)
    end_date = datetime.fromisoformat(data["end_date"]).replace(
        hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
    )
    await fetch_bouncie_trips_in_range(
        start_date, end_date, do_map_match=False, progress_data=progress_data
    )
    return {"status": "success", "message": "Trips fetched & stored."}


@app.post("/api/fetch_trips_last_hour")
async def api_fetch_trips_last_hour():
    now_utc = datetime.now(timezone.utc)
    start_date = now_utc - timedelta(hours=1)
    await fetch_bouncie_trips_in_range(start_date, now_utc, do_map_match=True)
    return {"status": "success", "message": "Hourly trip fetch completed."}


# Export Endpoints


@app.get("/export/geojson")
async def export_geojson(request: Request):
    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")
        imei = request.query_params.get("imei")

        start_date = (
            datetime.strptime(start_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            if start_date_str
            else None
        )
        end_date = (
            datetime.strptime(end_date_str, "%Y-%m-%d").replace(
                hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
            )
            if end_date_str
            else None
        )

        query = {}
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
                    "startTime": t["startTime"].isoformat(),
                    "endTime": t["endTime"].isoformat(),
                    "distance": t.get("distance", 0),
                    "imei": t["imei"],
                },
            }
            fc["features"].append(feature)

        content = json.dumps(fc)
        return StreamingResponse(
            io.BytesIO(content.encode()),
            media_type="application/geo+json",
            headers={
                "Content-Disposition": f'attachment; filename="all_trips.geojson"'
            },
        )
    except Exception as e:
        logger.error(f"Error exporting GeoJSON: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/export/gpx")
async def export_gpx(request: Request):
    try:
        start_date_str = request.query_params.get("start_date")
        end_date_str = request.query_params.get("end_date")
        imei = request.query_params.get("imei")

        start_date = (
            datetime.strptime(start_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            if start_date_str
            else None
        )
        end_date = (
            datetime.strptime(end_date_str, "%Y-%m-%d").replace(
                hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
            )
            if end_date_str
            else None
        )

        query = {}
        if start_date:
            query["startTime"] = {"$gte": start_date}
        if end_date:
            query.setdefault("startTime", {})["$lte"] = end_date
        if imei:
            query["imei"] = imei

        trips = await trips_collection.find(query).to_list(None)

        if not trips:
            raise HTTPException(status_code=404, detail="No trips found.")

        gpx = gpxpy.gpx.GPX()

        for t in trips:
            track = gpxpy.gpx.GPXTrack()
            gpx.tracks.append(track)
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

        gpx_xml = gpx.to_xml()
        return StreamingResponse(
            io.BytesIO(gpx_xml.encode()),
            media_type="application/gpx+xml",
            headers={"Content-Disposition": f'attachment; filename="trips.gpx"'},
        )
    except Exception as e:
        logger.error(f"Error exporting gpx: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# Location & GeoJSON Generation


@app.post("/api/validate_location")
async def validate_location(request: Request):
    data = await request.json()
    location = data.get("location")
    location_type = data.get("locationType")
    validated = await validate_location_osm(location, location_type)
    return validated


async def process_elements(elements, streets_only):
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


async def generate_geojson_osm(location, streets_only=False):
    try:
        if (
            not isinstance(location, dict)
            or "osm_id" not in location
            or "osm_type" not in location
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
            (
              way["highway"](area.searchArea);
            );
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
        # Await process_elements because it is an async function.
        features = await process_elements(data["elements"], streets_only)
        if features:
            gdf = gpd.GeoDataFrame.from_features(features)
            gdf = gdf.set_geometry("geometry")
            geojson_data = json.loads(gdf.to_json())
            bson_size_estimate = len(json.dumps(geojson_data).encode("utf-8"))
            if bson_size_estimate <= 16793598:
                # Await the find_one call so that existing_data is a dict.
                existing_data = await osm_data_collection.find_one(
                    {"location": location, "type": osm_type}
                )
                if existing_data:
                    # Await update_one since it is async.
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
                        f"Updated OSM data for {location.get('display_name', 'Unknown')}, type: {osm_type}"
                    )
                else:
                    # Await insert_one as well.
                    await osm_data_collection.insert_one(
                        {
                            "location": location,
                            "type": osm_type,
                            "geojson": geojson_data,
                            "created_at": datetime.now(timezone.utc),
                        }
                    )
                    logger.info(
                        f"Stored OSM data for {location.get('display_name', 'Unknown')}, type: {osm_type}"
                    )
            else:
                logger.warning(
                    f"Data for {location.get('display_name', 'Unknown')} is too large for MongoDB."
                )
            return geojson_data, None
        return None, "No features found"
    except aiohttp.ClientError as e:
        logger.error("Error generating geojson from Overpass: %s", e, exc_info=True)
        return None, "Error communicating with Overpass API"
    except Exception as e:
        logger.error(f"Error generating geojson: {e}", exc_info=True)
        return None, str(e)


@app.post("/api/generate_geojson")
async def generate_geojson(request: Request):
    data = await request.json()
    location = data.get("location")
    streets_only = data.get("streetsOnly", False)
    geojson_data, err = await generate_geojson_osm(location, streets_only)
    if geojson_data:
        return geojson_data
    raise HTTPException(status_code=400, detail=err)


# Map Matching Endpoints


async def to_async_iterator(cursor):
    items = await cursor.to_list(length=None)
    for item in items:
        yield item


@app.post("/api/map_match_trips")
async def map_match_trips(request: Request):
    try:
        data = await request.json()
        start_date_str = data.get("start_date")
        end_date_str = data.get("end_date")
        start_date = (
            datetime.fromisoformat(start_date_str).replace(tzinfo=timezone.utc)
            if start_date_str
            else None
        )
        end_date = (
            datetime.fromisoformat(end_date_str).replace(
                hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
            )
            if end_date_str
            else None
        )
        query = {}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        cursor = trips_collection.find(query)
        async for trip in to_async_iterator(cursor):
            await process_and_map_match_trip(trip)
        return {"status": "success", "message": "Map matching started for trips."}
    except Exception as e:
        logger.error(f"Error in map_match_trips endpoint: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/map_match_historical_trips")
async def map_match_historical_trips(request: Request):
    try:
        data = await request.json()
        start_date_str = data.get("start_date")
        end_date_str = data.get("end_date")
        start_date = (
            datetime.fromisoformat(start_date_str).replace(tzinfo=timezone.utc)
            if start_date_str
            else None
        )
        end_date = (
            datetime.fromisoformat(end_date_str).replace(
                hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
            )
            if end_date_str
            else None
        )
        query = {}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        cursor = historical_trips_collection.find(query)
        async for trip in to_async_iterator(cursor):
            await process_and_map_match_trip(trip)
        return {
            "status": "success",
            "message": "Map matching for historical trips started.",
        }
    except Exception as e:
        logger.error(
            f"Error in map_match_historical_trips endpoint: {e}", exc_info=True
        )
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/matched_trips")
async def get_matched_trips(request: Request):
    start_date_str = request.query_params.get("start_date")
    end_date_str = request.query_params.get("end_date")
    imei = request.query_params.get("imei")
    start_date = (
        datetime.fromisoformat(start_date_str).replace(tzinfo=timezone.utc)
        if start_date_str
        else None
    )
    end_date = (
        datetime.fromisoformat(end_date_str).replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
        )
        if end_date_str
        else None
    )
    query = {}
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
                    "startTime": (
                        trip["startTime"].isoformat() if trip.get("startTime") else ""
                    ),
                    "endTime": (
                        trip["endTime"].isoformat() if trip.get("endTime") else ""
                    ),
                    "distance": trip.get("distance", 0),
                    "timeZone": trip.get("timeZone", "UTC"),
                    "destination": trip.get("destination", "N/A"),
                    "startLocation": trip.get("startLocation", "N/A"),
                },
            )
            features.append(feature)
        except Exception as e:
            logger.error(
                f"Error processing matched trip {trip.get('transactionId')}: {e}",
                exc_info=True,
            )
            continue
    fc = geojson_module.FeatureCollection(features)
    return JSONResponse(content=fc)


@app.post("/api/matched_trips/delete")
async def delete_matched_trips(request: Request):
    """
    Deletes matched trips within a selected date range, optionally in intervals.
    """
    try:
        data = await request.json()
        start_date = datetime.fromisoformat(data.get("start_date")).replace(
            tzinfo=timezone.utc
        )
        end_date = datetime.fromisoformat(data.get("end_date")).replace(
            tzinfo=timezone.utc
        )
        interval_days = int(data.get("interval_days", 0))

        total_deleted_count = 0  # Keep track of the total deleted count

        if interval_days > 0:
            current_start = start_date
            while current_start < end_date:
                current_end = min(
                    current_start + timedelta(days=interval_days), end_date
                )
                # Use await with delete_many if it's an async operation
                result = await matched_trips_collection.delete_many(
                    {"startTime": {"$gte": current_start, "$lt": current_end}}
                )
                total_deleted_count += result.deleted_count
                current_start = current_end
        else:
            # Use await with delete_many if it's an async operation
            result = await matched_trips_collection.delete_many(
                {"startTime": {"$gte": start_date, "$lte": end_date}}
            )
            total_deleted_count = result.deleted_count

        return {"status": "success", "deleted_count": total_deleted_count}

    except Exception as e:
        logger.error(f"Error in delete_matched_trips: {e}", exc_info=True)
        raise HTTPException(
            status_code=500, detail=f"Error deleting matched trips: {e}"
        )


@app.post("/api/matched_trips/remap")
async def remap_matched_trips(request: Request):
    """
    Deletes existing matched trips and re-matches them within a date range or predefined interval.
    """
    try:
        data = await request.json()
        start_date_str = data.get("start_date")
        end_date_str = data.get("end_date")
        interval_days = int(data.get("interval_days", 0))

        if interval_days > 0:
            start_date = datetime.utcnow() - timedelta(days=interval_days)
            end_date = datetime.utcnow()
        else:
            start_date = datetime.fromisoformat(start_date_str).replace(
                tzinfo=timezone.utc
            )
            end_date = datetime.fromisoformat(end_date_str).replace(tzinfo=timezone.utc)

        # Delete old matched trips (use await if delete_many is async)
        await matched_trips_collection.delete_many(
            {"startTime": {"$gte": start_date, "$lte": end_date}}
        )

        # Fetch original trips and re-match them
        trips_cursor = trips_collection.find(
            {"startTime": {"$gte": start_date, "$lte": end_date}}
        )
        async for trip in to_async_iterator(trips_cursor):
            await process_and_map_match_trip(trip)

        return {"status": "success", "message": "Re-matching completed."}

    except Exception as e:
        logger.error(f"Error in remap_matched_trips: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error re-matching trips: {e}")


@app.get("/api/export/trip/{trip_id}")
async def export_single_trip(trip_id: str, request: Request):
    fmt = request.query_params.get("format", "geojson")
    t = await trips_collection.find_one({"transactionId": trip_id})
    if not t:
        raise HTTPException(status_code=404, detail="Trip not found")
    if fmt == "geojson":
        gps_data = t["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        feature = {
            "type": "Feature",
            "geometry": gps_data,
            "properties": {
                "transactionId": t["transactionId"],
                "startTime": t["startTime"].isoformat(),
                "endTime": t["endTime"].isoformat(),
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
        gpx = gpxpy.gpx.GPX()
        track = gpxpy.gpx.GPXTrack()
        gpx.tracks.append(track)
        seg = gpxpy.gpx.GPXTrackSegment()
        track.segments.append(seg)
        gps_data = t["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        if gps_data.get("type") == "LineString":
            for coord in gps_data.get("coordinates", []):
                lon, lat = coord[0], coord[1]
                seg.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
        track.name = t["transactionId"]
        gpx_xml = gpx.to_xml()
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
        result = await matched_trips_collection.delete_one(
            {"$or": [{"transactionId": trip_id}, {"transactionId": str(trip_id)}]}
        )
        if result.deleted_count:
            return {"status": "success", "message": "Deleted matched trip"}
        raise HTTPException(status_code=404, detail="Trip not found")
    except Exception as e:
        logger.error(f"Error deleting matched trip {trip_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/export", response_class=HTMLResponse)
async def export_page(request: Request):
    return templates.TemplateResponse("export.html", {"request": request})


async def fetch_all_trips_no_filter():
    trips = await trips_collection.find().to_list(length=None)
    uploaded = await uploaded_trips_collection.find().to_list(length=None)
    historical = await historical_trips_collection.find().to_list(length=None)
    return trips + uploaded + historical


@app.get("/api/export/all_trips")
async def export_all_trips(request: Request):
    fmt = request.query_params.get("format", "geojson").lower()
    all_trips = await fetch_all_trips_no_filter()
    if fmt == "geojson":
        geojson_data = await create_geojson(all_trips)
        return StreamingResponse(
            io.BytesIO(geojson_data.encode()),
            media_type="application/geo+json",
            headers={"Content-Disposition": 'attachment; filename="all_trips.geojson"'},
        )
    elif fmt == "gpx":
        gpx_data = await create_gpx(all_trips)
        return StreamingResponse(
            io.BytesIO(gpx_data.encode()),
            media_type="application/gpx+xml",
            headers={"Content-Disposition": 'attachment; filename="all_trips.gpx"'},
        )
    elif fmt == "json":
        return JSONResponse(content=all_trips)
    else:
        raise HTTPException(status_code=400, detail="Invalid export format")


@app.get("/api/export/trips")
async def export_trips(request: Request):
    start_date = request.query_params.get("start_date")
    end_date = request.query_params.get("end_date")
    fmt = request.query_params.get("format")
    ts = await fetch_all_trips(start_date, end_date)
    if fmt == "geojson":
        geojson_data = await create_geojson(ts)
        return StreamingResponse(
            io.BytesIO(geojson_data.encode()),
            media_type="application/geo+json",
            headers={"Content-Disposition": 'attachment; filename="all_trips.geojson"'},
        )
    elif fmt == "gpx":
        gpx_data = await create_gpx(ts)
        return StreamingResponse(
            io.BytesIO(gpx_data.encode()),
            media_type="application/gpx+xml",
            headers={"Content-Disposition": 'attachment; filename="all_trips.gpx"'},
        )
    else:
        raise HTTPException(status_code=400, detail="Invalid export format")


async def fetch_all_trips(start_date_str, end_date_str):
    sd = parser.parse(start_date_str)
    ed = parser.parse(end_date_str)
    query = {"startTime": {"$gte": sd, "$lte": ed}}
    trips = await trips_collection.find(query).to_list(length=None)
    uploaded = await uploaded_trips_collection.find(query).to_list(length=None)
    historical = await historical_trips_collection.find(query).to_list(length=None)
    return trips + uploaded + historical


@app.get("/api/export/matched_trips")
async def export_matched_trips(request: Request):
    start_date = request.query_params.get("start_date")
    end_date = request.query_params.get("end_date")
    fmt = request.query_params.get("format")
    ms = await fetch_matched_trips(start_date, end_date)
    if fmt == "geojson":
        fc = await create_geojson(ms)
        return StreamingResponse(
            io.BytesIO(fc.encode()),
            media_type="application/geo+json",
            headers={
                "Content-Disposition": 'attachment; filename="matched_trips.geojson"'
            },
        )
    elif fmt == "gpx":
        data = await create_gpx(ms)
        return StreamingResponse(
            io.BytesIO(data.encode()),
            media_type="application/gpx+xml",
            headers={"Content-Disposition": 'attachment; filename="matched_trips.gpx"'},
        )
    else:
        raise HTTPException(status_code=400, detail="Invalid export format")


async def fetch_matched_trips(start_date_str, end_date_str):
    sd = parser.parse(start_date_str)
    ed = parser.parse(end_date_str)
    query = {"startTime": {"$gte": sd, "$lte": ed}}
    return await matched_trips_collection.find(query).to_list(length=None)


@app.get("/api/export/streets")
async def export_streets(request: Request):
    location = request.query_params.get("location")
    fmt = request.query_params.get("format")
    if not location:
        raise HTTPException(status_code=400, detail="No location param")
    loc = json.loads(location)
    data, _ = await generate_geojson_osm(loc, streets_only=True)
    if not data:
        raise HTTPException(status_code=500, detail="No data returned")
    if fmt == "geojson":
        return StreamingResponse(
            io.BytesIO(json.dumps(data, default=str).encode()),
            media_type="application/geo+json",
            headers={"Content-Disposition": 'attachment; filename="streets.geojson"'},
        )
    elif fmt == "shapefile":
        gdf = gpd.GeoDataFrame.from_features(data["features"])
        buf = io.BytesIO()
        tmp_dir = "inmem_shp"
        if not os.path.exists(tmp_dir):
            os.mkdir(tmp_dir)
        out_path = os.path.join(tmp_dir, "streets.shp")
        gdf.to_file(out_path, driver="ESRI Shapefile")
        with zipfile.ZipFile(buf, "w") as zf:
            for f in os.listdir(tmp_dir):
                with open(os.path.join(tmp_dir, f), "rb") as fh:
                    zf.writestr(f"streets/{f}", fh.read())
        # Instead of os.rmdir, remove the directory recursively:
        shutil.rmtree(tmp_dir)
        buf.seek(0)
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="streets.zip"'},
        )
    else:
        raise HTTPException(status_code=400, detail="Invalid export format")


@app.get("/api/export/boundary")
async def export_boundary(request: Request):
    location = request.query_params.get("location")
    fmt = request.query_params.get("format")
    if not location:
        raise HTTPException(status_code=400, detail="No location")
    loc = json.loads(location)
    data, _ = await generate_geojson_osm(loc, streets_only=False)
    if not data:
        raise HTTPException(status_code=500, detail="No boundary data")
    if fmt == "geojson":
        return StreamingResponse(
            io.BytesIO(json.dumps(data, default=str).encode()),
            media_type="application/geo+json",
            headers={"Content-Disposition": 'attachment; filename="boundary.geojson"'},
        )
    elif fmt == "shapefile":
        gdf = gpd.GeoDataFrame.from_features(data["features"])
        buf = io.BytesIO()
        tmp_dir = "inmem_shp"
        if not os.path.exists(tmp_dir):
            os.mkdir(tmp_dir)
        out_path = os.path.join(tmp_dir, "boundary.shp")
        gdf.to_file(out_path, driver="ESRI Shapefile")
        with zipfile.ZipFile(buf, "w") as zf:
            for f in os.listdir(tmp_dir):
                with open(os.path.join(tmp_dir, f), "rb") as fh:
                    zf.writestr(f"boundary/{f}", fh.read())
        # Remove the temporary directory recursively.
        shutil.rmtree(tmp_dir)
        buf.seek(0)
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="boundary.zip"'},
        )
    else:
        raise HTTPException(status_code=400, detail="Invalid export format")


# Preprocessing & Street Segment Details


@app.post("/api/preprocess_streets")
async def preprocess_streets_route(request: Request):
    try:
        data = await request.json()
        location_query = data.get("location")
        location_type = data.get("location_type", "city")
        if not location_query:
            raise HTTPException(status_code=400, detail="Location is required")
        validated_location = await validate_location_osm(location_query, location_type)
        if not validated_location:
            raise HTTPException(status_code=400, detail="Invalid location")
        asyncio.create_task(async_preprocess_streets(validated_location))
        return {
            "status": "success",
            "message": f"Street data preprocessing initiated for {validated_location.get('display_name', location_query)}. Check server logs for progress.",
        }
    except Exception as e:
        logger.error(f"Error in preprocess_streets_route: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


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
        logger.error(f"Error fetching segment details: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# Historical Data Loading


async def process_historical_trip(trip):
    trip["startTime"] = (
        parser.isoparse(trip["startTime"])
        if isinstance(trip["startTime"], str)
        else trip["startTime"]
    )
    trip["endTime"] = (
        parser.isoparse(trip["endTime"])
        if isinstance(trip["endTime"], str)
        else trip["endTime"]
    )
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
                        start_date = datetime.fromisoformat(start_date_str).replace(
                            tzinfo=timezone.utc
                        )
                        if trip["startTime"] < start_date:
                            continue
                    if end_date_str:
                        end_date = datetime.fromisoformat(end_date_str).replace(
                            tzinfo=timezone.utc
                        )
                        if trip["endTime"] > end_date:
                            continue
                    all_trips.append(trip)
            except Exception as e:
                logger.error(f"Error reading {filename}: {e}")
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
            logger.error(f"Error inserting historical trip: {e}")
    return inserted_count


@app.post("/load_historical_data")
async def load_historical_data_endpoint(request: Request):
    data = await request.json()
    start_date = data.get("start_date")
    end_date = data.get("end_date")
    inserted_count = await load_historical_data(start_date, end_date)
    return {"message": f"Loaded historical data. Inserted {inserted_count} new trips."}


# Last Trip Point & Upload Endpoints


@app.get("/api/last_trip_point")
async def get_last_trip_point():
    try:
        # Use await with Motor's asynchronous find_one and specify sort with -1.
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
        logger.error(f"Error get_last_trip_point: {e}", exc_info=True)
        raise HTTPException(
            status_code=500, detail="Failed to retrieve last trip point"
        )


@app.get("/upload", response_class=HTMLResponse)
async def upload_page(request: Request):
    return templates.TemplateResponse("upload.html", {"request": request})


@app.get("/api/trips/{trip_id}")
async def get_single_trip(trip_id: str):
    """
    Return single trip by _id from 'trips_collection'.
    """
    try:
        # Convert trip_id to ObjectId
        try:
            object_id = ObjectId(trip_id)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid trip ID format")

        # Find the trip (use await if find_one is async)
        trip = await trips_collection.find_one({"_id": object_id})

        if not trip:
            raise HTTPException(status_code=404, detail="Trip not found")

        # Convert ObjectId and datetime fields to strings
        trip["_id"] = str(trip["_id"])
        trip["startTime"] = trip["startTime"].isoformat()
        trip["endTime"] = trip["endTime"].isoformat()

        return {"status": "success", "trip": trip}

    except HTTPException:
        raise  # Re-raise HTTPException to avoid catching it in the general exception handler
    except Exception as e:
        logger.error(f"get_single_trip error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


@app.delete("/api/trips/{trip_id}")
async def delete_trip(trip_id: str):
    """
    Deletes a trip by its transactionId.
    """
    try:
        # Find the trip in both collections using transactionId
        trip = await trips_collection.find_one({"transactionId": trip_id})
        if not trip:
            trip = await matched_trips_collection.find_one({"transactionId": trip_id})
            if not trip:
                raise HTTPException(status_code=404, detail="Trip not found")
            collection = matched_trips_collection
        else:
            collection = trips_collection

        # Delete the trip using transactionId
        result = await collection.delete_one({"transactionId": trip_id})

        if result.deleted_count == 1:
            return {"status": "success", "message": "Trip deleted successfully"}

        # This should ideally not be reached if the trip was found
        raise HTTPException(status_code=500, detail="Failed to delete trip")

    except HTTPException:
        raise  # Re-raise HTTPExceptions
    except Exception as e:
        logger.error(f"Error deleting trip: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/debug/trip/{trip_id}")
async def debug_trip(trip_id: str):
    """
    Debug helper, check if found in trips or matched_trips, ID mismatch, etc.
    """
    try:
        # Find in regular trips collection (use await if find_one is async)
        regular_trip = await trips_collection.find_one(
            {
                "$or": [
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ]
            }
        )

        # Find in matched trips collection (use await if find_one is async)
        matched_trip = await matched_trips_collection.find_one(
            {
                "$or": [
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ]
            }
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
        logger.error(f"debug_trip error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/first_trip_date")
async def get_first_trip_date():
    """
    Return earliest startTime across trips, uploaded, historical.
    """
    try:
        # Find earliest trip in each collection (use await if find_one is async)
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
        logger.error(f"get_first_trip_date error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/upload_gpx")
async def upload_gpx(request: Request):
    try:
        form = await request.form()
        files = form.getlist("files[]")
        map_match = form.get("map_match", "false") == "true"
        if not files:
            raise HTTPException(status_code=400, detail="No files found")
        success_count = 0
        for f in files:
            filename = f.filename.lower()
            if filename.endswith(".gpx"):
                gpx_data = await f.read()
                gpx = gpxpy.parse(gpx_data)
                for track in gpx.tracks:
                    for seg in track.segments:
                        coords = [[p.longitude, p.latitude] for p in seg.points]
                        if len(coords) < 2:
                            continue
                        start_t = min(
                            (p.time for p in seg.points if p.time),
                            default=datetime.now(timezone.utc),
                        )
                        end_t = max(
                            (p.time for p in seg.points if p.time), default=start_t
                        )
                        geo = {"type": "LineString", "coordinates": coords}
                        dist_meters = calculate_gpx_distance(coords)
                        dist_miles = meters_to_miles(dist_meters)
                        trip = {
                            "transactionId": f"GPX-{start_t.strftime('%Y%m%d%H%M%S')}-{filename}",
                            "startTime": start_t,
                            "endTime": end_t,
                            "gps": json.dumps(geo),
                            "distance": round(dist_miles, 2),
                            "source": "upload",
                            "filename": f.filename,
                            "imei": "HISTORICAL",
                        }
                        await process_and_store_trip(trip)
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
                logger.warning(f"Skipping unhandled file extension: {filename}")
        return {"status": "success", "message": f"{success_count} trips uploaded."}
    except Exception as e:
        logger.error(f"Error upload_gpx: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def calculate_gpx_distance(coords):
    dist = 0
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        dist += gpxpy.geo.haversine_distance(lat1, lon1, lat2, lon2)
    return dist


def meters_to_miles(m):
    return m * 0.000621371


async def process_and_store_trip(trip):
    try:
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        coords = gps_data["coordinates"]
        start_pt = coords[0]
        end_pt = coords[-1]

        if not trip.get("startLocation"):
            trip["startLocation"] = await reverse_geocode_nominatim(
                start_pt[1], start_pt[0]
            )
        if not trip.get("destination"):
            trip["destination"] = await reverse_geocode_nominatim(end_pt[1], end_pt[0])

        # If gps is stored as a dict, convert it to a JSON string.
        if isinstance(trip["gps"], dict):
            trip["gps"] = json.dumps(trip["gps"])

        # Use await for asynchronous Motor calls.
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
    except DuplicateKeyError:
        logger.warning(f"Duplicate trip ID {trip['transactionId']}, skipping.")
    except Exception as e:
        logger.error(f"process_and_store_trip error: {e}", exc_info=True)
        raise


def process_geojson_trip(geojson_data):
    try:
        feats = geojson_data.get("features", [])
        trips = []
        for f in feats:
            props = f.get("properties", {})
            geom = f.get("geometry", {})
            stime = props.get("start_time")
            etime = props.get("end_time")
            tid = props.get(
                "transaction_id", f"geojson-{int(datetime.now().timestamp())}"
            )
            stime_parsed = (
                parser.isoparse(stime) if stime else datetime.now(timezone.utc)
            )
            etime_parsed = parser.isoparse(etime) if etime else stime_parsed
            trip = {
                "transactionId": tid,
                "startTime": stime_parsed,
                "endTime": etime_parsed,
                "gps": json.dumps(
                    {"type": geom.get("type"), "coordinates": geom.get("coordinates")}
                ),
                "distance": calculate_distance(geom.get("coordinates")),
                "imei": "HISTORICAL",
            }
            trips.append(trip)
        return trips
    except Exception as e:
        logger.error(f"Error in process_geojson_trip: {e}", exc_info=True)
        return None


def calculate_distance(coordinates):
    if not coordinates or len(coordinates) < 2:
        return 0
    dist = 0
    for i in range(len(coordinates) - 1):
        lon1, lat1 = coordinates[i]
        lon2, lat2 = coordinates[i + 1]
        dist += haversine(lon1, lat1, lon2, lat2)
    return dist


def haversine(lon1, lat1, lon2, lat2):
    R = 3958.8
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = (
        sin(dlat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    )
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return R * c


# Uploaded Trips Endpoints


@app.get("/api/uploaded_trips")
async def get_uploaded_trips():
    try:
        ups = await uploaded_trips_collection.find().to_list(length=None)
        for u in ups:
            u["_id"] = str(u["_id"])
            if isinstance(u.get("startTime"), datetime):
                u["startTime"] = u["startTime"].isoformat()
            if isinstance(u.get("endTime"), datetime):
                u["endTime"] = u["endTime"].isoformat()
        return {"status": "success", "trips": ups}
    except Exception as e:
        logger.error(f"Error get_uploaded_trips: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/uploaded_trips/{trip_id}")
async def delete_uploaded_trip(trip_id: str):
    try:
        result = uploaded_trips_collection.delete_one({"_id": ObjectId(trip_id)})
        if result.deleted_count == 1:
            return {"status": "success", "message": "Trip deleted"}
        raise HTTPException(status_code=404, detail="Not found")
    except Exception as e:
        logger.error(f"Error deleting uploaded trip: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


async def process_gpx(gpx: gpxpy.gpx.GPX) -> List[Dict[str, Any]]:
    """
    Asynchronously convert a GPX object to a list of trip dictionaries.
    """

    def _process_gpx_sync(gpx: gpxpy.gpx.GPX) -> List[Dict[str, Any]]:
        """
        Synchronous part of GPX processing, to be run in a separate thread.
        """
        out = []
        for track in gpx.tracks:
            for seg in track.segments:
                if not seg.points:
                    continue
                coords = [[p.longitude, p.latitude] for p in seg.points]
                times = [p.time for p in seg.points if p.time]
                if not times:
                    continue
                st = min(times)
                en = max(times)
                out.append(
                    {
                        "transactionId": str(ObjectId()),
                        "startTime": st,
                        "endTime": en,
                        "gps": {"type": "LineString", "coordinates": coords},
                        "imei": "HISTORICAL",
                        "distance": calculate_distance(coords),
                    }
                )
        return out

    # Run the synchronous part in a separate thread
    return await asyncio.to_thread(_process_gpx_sync, gpx)


def validate_trip_update(data: dict) -> tuple[bool, str]:
    try:
        for p in data["points"]:
            lat = p.get("lat")
            lon = p.get("lon")
            if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
                return False, "Out of range lat/lon"
        return True, ""
    except Exception:
        return False, "Invalid data format"


async def fetch_trips(start_date_str: str, end_date_str: str) -> list:
    sd = parser.parse(start_date_str)
    ed = parser.parse(end_date_str)
    query = {"startTime": {"$gte": sd, "$lte": ed}}
    trips = await trips_collection.find(query).to_list(length=None)
    return trips


@app.post("/api/upload")
async def upload_files(request: Request, files: List[UploadFile] = File(...)):
    """
    Alternate endpoint for uploading multiple GPX/GeoJSON files.
    Similar to /api/upload_gpx.
    """
    try:
        count = 0
        for file in files:
            filename = file.filename
            if filename.endswith(".gpx"):
                gpx_data = await file.read()
                gpx = gpxpy.parse(gpx_data)
                trips = await process_gpx(gpx)
                for trip in trips:
                    await process_and_store_trip(trip)
                    count += 1
            elif filename.endswith(".geojson"):
                try:
                    data = json.loads(await file.read())
                except json.JSONDecodeError:
                    logger.warning(f"Invalid geojson: {filename}")
                    continue
                trips = process_geojson_trip(data)
                if trips:
                    for trip in trips:
                        await process_and_store_trip(trip)
                        count += 1
        return {"status": "success", "message": f"Processed {count} trips"}

    except Exception as e:
        logger.error(f"Error uploading: {e}", exc_info=True)
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
            except:
                pass
        if not valid_ids:
            raise HTTPException(status_code=400, detail="No valid IDs")
        ups_to_delete = list(
            uploaded_trips_collection.find({"_id": {"$in": valid_ids}})
        )
        trans_ids = [u["transactionId"] for u in ups_to_delete]
        del_res = uploaded_trips_collection.delete_many({"_id": {"$in": valid_ids}})
        matched_del_res = matched_trips_collection.delete_many(
            {"transactionId": {"$in": trans_ids}}
        )
        return {
            "status": "success",
            "deleted_uploaded_trips": del_res.deleted_count,
            "deleted_matched_trips": matched_del_res.deleted_count,
        }
    except Exception as e:
        logger.error(f"Error in bulk_delete_uploaded_trips: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/trips/bulk_delete")
async def bulk_delete_trips(request: Request):
    """
    Deletes multiple trip documents by their transaction IDs.
    """
    try:
        data = await request.json()
        trip_ids = data.get("trip_ids", [])
        if not trip_ids:
            raise HTTPException(status_code=400, detail="No trip IDs provided")

        # Use await if delete_many is async
        trips_result = await trips_collection.delete_many(
            {"transactionId": {"$in": trip_ids}}
        )
        # Use await if delete_many is async
        matched_trips_result = await matched_trips_collection.delete_many(
            {"original_trip_id": {"$in": trip_ids}}
        )

        return {
            "status": "success",
            "message": f"Deleted {trips_result.deleted_count} trips and {matched_trips_result.deleted_count} matched trips",
            "deleted_trips_count": trips_result.deleted_count,
            "deleted_matched_trips_count": matched_trips_result.deleted_count,
        }

    except Exception as e:
        logger.error(f"Error in bulk_delete_trips: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# Places Endpoints


@app.api_route("/api/places", methods=["GET", "POST"])
async def handle_places(request: Request):
    if request.method == "GET":
        # Await conversion of the async cursor to a list
        pls = await places_collection.find().to_list(length=None)
        return [
            {"_id": str(p["_id"]), **CustomPlace.from_dict(p).to_dict()} for p in pls
        ]

    data = await request.json()
    place = CustomPlace(data["name"], data["geometry"])
    # Await the asynchronous insert operation
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
        # For each collection, await the async cursor conversion to a list.
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
                            from shapely.geometry import shape

                            if shape(p["geometry"]).contains(shape(start_pt)):
                                same_place = True
                    if same_place:
                        next_start = next_trip.get("startTime")
                        if next_start and isinstance(next_start, datetime):
                            if next_start.tzinfo is None:
                                next_start = next_start.replace(tzinfo=timezone.utc)
                            duration_minutes = (
                                next_start - t_end
                            ).total_seconds() / 60.0
                            if duration_minutes > 0:
                                durations.append(duration_minutes)
                if i > 0:
                    prev_trip = valid_trips[i - 1]
                    prev_end = prev_trip.get("endTime")
                    if prev_end and isinstance(prev_end, datetime):
                        if prev_end.tzinfo is None:
                            prev_end = prev_end.replace(tzinfo=timezone.utc)
                        hrs_since_last = (t_end - prev_end).total_seconds() / 3600.0
                        if hrs_since_last >= 0:
                            time_since_last_visits.append(hrs_since_last)
                visits.append(t_end)
            except Exception as ex:
                logger.error(
                    f"Issue processing a trip for place {place_id}: {ex}", exc_info=True
                )
                continue
        total_visits = len(visits)
        avg_duration = sum(durations) / len(durations) if durations else 0

        def format_h_m(m):
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
            "firstVisit": first_visit.isoformat() if first_visit else None,
            "lastVisit": last_visit.isoformat() if last_visit else None,
            "averageTimeSinceLastVisit": avg_time_since_last,
            "name": p["name"],
        }
    except Exception as e:
        logger.error(f"Error place stats {place_id}: {e}", exc_info=True)
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
            if end_time.tzinfo is None:
                end_time = end_time.replace(tzinfo=timezone.utc)
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
                        from shapely.geometry import shape

                        if shape(p["geometry"]).contains(shape(start_pt)):
                            same_place = True
                if same_place:
                    next_start = next_trip.get("startTime")
                    if next_start and isinstance(next_start, datetime):
                        if next_start.tzinfo is None:
                            next_start = next_start.replace(tzinfo=timezone.utc)
                        duration_minutes = (
                            next_start - end_time
                        ).total_seconds() / 60.0
                        hh = int(duration_minutes // 60)
                        mm = int(duration_minutes % 60)
                        duration_str = f"{hh}h {mm:02d}m"
                    else:
                        duration_str = "0h 00m"
                else:
                    duration_str = "0h 00m"
            else:
                duration_str = "0h 00m"
            if i > 0:
                prev_trip_end = valid_trips[i - 1].get("endTime")
                if prev_trip_end and isinstance(prev_trip_end, datetime):
                    if prev_trip_end.tzinfo is None:
                        prev_trip_end = prev_trip_end.replace(tzinfo=timezone.utc)
                    hrs_since_last = (end_time - prev_trip_end).total_seconds() / 3600.0
                    time_since_last_str = f"{hrs_since_last:.2f} hours"
                else:
                    time_since_last_str = "N/A"
            else:
                time_since_last_str = "N/A"
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
        logger.error(f"Error fetching trips for place {place_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# Non-Custom Places & Analytics


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
        trips_results = await trips_collection.aggregate(pipeline).to_list(length=None)
        historical_results = await historical_trips_collection.aggregate(
            pipeline
        ).to_list(length=None)
        uploaded_results = await uploaded_trips_collection.aggregate(pipeline).to_list(
            length=None
        )
        results = trips_results + historical_results + uploaded_results
        visits_data = []
        for doc in results:
            visits_data.append(
                {
                    "name": doc["_id"],
                    "totalVisits": doc["totalVisits"],
                    "firstVisit": (
                        doc["firstVisit"].isoformat() if doc.get("firstVisit") else None
                    ),
                    "lastVisit": (
                        doc["lastVisit"].isoformat() if doc.get("lastVisit") else None
                    ),
                }
            )
        return JSONResponse(content=visits_data)
    except Exception as e:
        logger.error(f"Error fetching non-custom place visits: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/trip-analytics")
async def get_trip_analytics(request: Request):
    start_date_str = request.query_params.get("start_date")
    end_date_str = request.query_params.get("end_date")
    if not start_date_str or not end_date_str:
        raise HTTPException(status_code=400, detail="Missing date range")
    try:
        pipeline = [
            {
                "$match": {
                    "startTime": {
                        "$gte": datetime.fromisoformat(start_date_str),
                        "$lte": datetime.fromisoformat(end_date_str),
                    }
                }
            },
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
        # Await the asynchronous aggregation and convert the cursor to a list.
        results = await trips_collection.aggregate(pipeline).to_list(length=None)

        def organize_daily_data(results):
            daily_data = {}
            for r in results:
                date = r["_id"]["date"]
                if date not in daily_data:
                    daily_data[date] = {"distance": 0, "count": 0}
                daily_data[date]["distance"] += r["totalDistance"]
                daily_data[date]["count"] += r["tripCount"]
            return [
                {"date": d, "distance": v["distance"], "count": v["count"]}
                for d, v in sorted(daily_data.items())
            ]

        def organize_hourly_data(results):
            hourly_data = {}
            for r in results:
                hour = r["_id"]["hour"]
                if hour not in hourly_data:
                    hourly_data[hour] = 0
                hourly_data[hour] += r["tripCount"]
            return [{"hour": h, "count": c} for h, c in sorted(hourly_data.items())]

        daily_list = organize_daily_data(results)
        hourly_list = organize_hourly_data(results)
        return JSONResponse(
            content={
                "daily_distances": daily_list,
                "time_distribution": hourly_list,
            }
        )
    except Exception as e:
        logger.error(f"Error trip analytics: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# geocoding
@app.post("/update_geo_points")
async def update_geo_points_route(request: Request):
    """
    Update GeoPoints for a given collection.
    """
    data = await request.json()
    collection_name = data.get("collection")
    if collection_name not in ["trips", "historical_trips", "uploaded_trips"]:
        raise HTTPException(status_code=400, detail="Invalid collection name")

    # Map collection name to actual collection object
    if collection_name == "trips":
        collection = trips_collection
    elif collection_name == "historical_trips":
        collection = historical_trips_collection
    elif collection_name == "uploaded_trips":
        collection = uploaded_trips_collection
    else:
        raise HTTPException(status_code=400, detail="Invalid collection name")

    try:
        await update_geo_points(collection)
        return {"message": f"GeoPoints updated for {collection_name}"}
    except Exception as e:
        # Log endpoint errors
        logger.error(f"Error in update_geo_points_route: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error updating GeoPoints: {e}")


@app.post("/api/regeocode_all_trips")
async def regeocode_all_trips():
    """
    Re-geocodes all trips in the database to check if they are within custom places.
    """
    try:
        collections = [
            trips_collection,
            historical_trips_collection,
            uploaded_trips_collection,
        ]
        for collection in collections:
            # Iterate synchronously using a regular for loop
            async for trip in to_async_iterator(collection.find({})):
                await process_trip_data(trip)  # Still await the async function
                await collection.replace_one({"_id": trip["_id"]}, trip)

        return {"message": "All trips re-geocoded successfully."}
    except Exception as e:
        logger.error(f"Error in regeocode_all_trips: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error re-geocoding trips: {e}")


@app.post("/api/trips/refresh_geocoding")
async def refresh_geocoding_for_trips(request: Request):
    """
    Refreshes geocoding for selected trips.
    """
    data = await request.json()
    trip_ids = data.get("trip_ids", [])

    updated_count = 0
    for trip_id in trip_ids:
        trip = await trips_collection.find_one(
            {"transactionId": trip_id}
        )  # Use await if find_one is async
        if trip:
            updated_trip = await process_trip_data(trip)
            await trips_collection.replace_one(
                {"_id": trip["_id"]}, updated_trip
            )  # Use await if replace_one is async
            updated_count += 1

    return {
        "message": f"Geocoding refreshed for {updated_count} trips.",
        "updated_count": updated_count,
    }


@app.delete("/api/trips/bulk_delete")
async def bulk_delete_trips(request: Request):
    """
    Deletes multiple trip documents by their transaction IDs.
    """
    try:
        data = await request.json()
        trip_ids = data.get("trip_ids", [])
        if not trip_ids:
            raise HTTPException(status_code=400, detail="No trip IDs provided")

        # Convert transaction IDs to ObjectIds if necessary and validate them
        object_ids = []
        for trip_id in trip_ids:
            try:
                object_ids.append(ObjectId(trip_id))
            except Exception:
                logger.warning(f"Invalid ObjectId format: {trip_id}")

        if not object_ids:
            raise HTTPException(status_code=400, detail="No valid trip IDs provided")

        # Delete trips from the 'trips_collection'
        trips_delete_result = await trips_collection.delete_many(
            {"_id": {"$in": object_ids}}  # Find by _id which should be ObjectIds
        )

        # Delete corresponding matched trips from 'matched_trips_collection'
        # Here we delete by 'transactionId'
        matched_trips_delete_result = await matched_trips_collection.delete_many(
            {
                "transactionId": {"$in": trip_ids}
            }  # Find by transactionId which should be string
        )

        return {
            "status": "success",
            "message": f"Deleted {trips_delete_result.deleted_count} trips and {matched_trips_delete_result.deleted_count} matched trips",
            "deleted_trips_count": trips_delete_result.deleted_count,
            "deleted_matched_trips_count": matched_trips_delete_result.deleted_count,
        }

    except Exception as e:
        logger.error(f"Error in bulk_delete_trips: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# Real-Time & Webhook Endpoints


@app.post("/webhook/bouncie")
async def bouncie_webhook(request: Request):
    try:
        data = await request.json()
        event_type = data.get("eventType")
        if not event_type:
            raise HTTPException(status_code=400, detail="Missing eventType")

        transaction_id = data.get("transactionId")
        if event_type in ("tripStart", "tripData", "tripEnd") and not transaction_id:
            raise HTTPException(
                status_code=400, detail="Missing transactionId for trip event"
            )

        # Process the event based on its type.
        if event_type == "tripStart":
            # Get the starting timestamp from the event data.
            start_time, _ = get_trip_timestamps(data)
            # Remove any existing active trip with the same transactionId.
            await live_trips_collection.delete_many(
                {"transactionId": transaction_id, "status": "active"}
            )
            # Insert the new active trip.
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
            # Find the active trip for this transaction.
            trip_doc = await live_trips_collection.find_one(
                {"transactionId": transaction_id, "status": "active"}
            )
            if not trip_doc:
                # If not found, create a new active trip.
                now = datetime.now(timezone.utc)
                await live_trips_collection.insert_one(
                    {
                        "transactionId": transaction_id,
                        "status": "active",
                        "startTime": now,
                        "coordinates": [],
                        "lastUpdate": now,
                    }
                )
                trip_doc = await live_trips_collection.find_one(
                    {"transactionId": transaction_id, "status": "active"}
                )
            # If the event contains trip data, update the coordinates.
            if "data" in data:
                new_coords = sort_and_filter_trip_coordinates(data["data"])
                all_coords = trip_doc.get("coordinates", []) + new_coords
                all_coords.sort(key=lambda c: c["timestamp"])
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
                        }
                    },
                )

        elif event_type == "tripEnd":
            # Extract the start and end times.
            start_time, end_time = get_trip_timestamps(data)
            # Find the active trip.
            trip = await live_trips_collection.find_one(
                {"transactionId": transaction_id}
            )
            if trip:
                # Update the trip with the end time and mark it completed.
                trip["endTime"] = end_time
                trip["status"] = "completed"
                # Archive the trip.
                await archived_live_trips_collection.insert_one(trip)
                # Delete the active trip document.
                await live_trips_collection.delete_one({"_id": trip["_id"]})

        # After processing, try to retrieve the current active trip.
        active_trip = await live_trips_collection.find_one({"status": "active"})
        if active_trip:
            # Convert top-level datetimes
            for key in ("startTime", "lastUpdate", "endTime"):
                if key in active_trip and isinstance(active_trip[key], datetime):
                    active_trip[key] = active_trip[key].isoformat()

            # Convert _id
            if "_id" in active_trip:
                active_trip["_id"] = str(active_trip["_id"])

            # ALSO convert timestamps in coordinates
            if "coordinates" in active_trip:
                for coord in active_trip["coordinates"]:
                    if "timestamp" in coord and isinstance(
                        coord["timestamp"], datetime
                    ):
                        coord["timestamp"] = coord["timestamp"].isoformat()

            message = {"type": "trip_update", "data": active_trip}
        else:
            message = {"type": "heartbeat"}

        # Broadcast with everything stringified
        await manager.broadcast(json.dumps(message))
        return {"status": "success"}

    except Exception as e:
        logger.error(f"Error in bouncie_webhook: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/active_trip")
async def get_active_trip():
    try:
        active_trip = await live_trips_collection.find_one({"status": "active"})
        if active_trip:
            for key in ("startTime", "lastUpdate", "endTime"):
                if key in active_trip and isinstance(active_trip[key], datetime):
                    active_trip[key] = active_trip[key].isoformat()
            active_trip["_id"] = str(active_trip["_id"])
            return active_trip
        else:
            raise HTTPException(status_code=404, detail="No active trip")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


async def assemble_trip_from_realtime_data(realtime_trip_data):
    """
    Assembles a complete trip object from a list of realtime data events, with enhanced logging.
    """
    logger.info("Assembling trip from realtime data...")  # Log function entry
    if not realtime_trip_data:
        # Log empty data
        logger.warning("Realtime trip data list is empty, cannot assemble trip.")
        return None

    # Log number of events
    logger.debug(f"Realtime data contains {len(realtime_trip_data)} events.")

    trip_start_event = next(
        (event for event in realtime_trip_data if event["event_type"] == "tripStart"),
        None,
    )
    trip_end_event = next(
        (event for event in realtime_trip_data if event["event_type"] == "tripEnd"),
        None,
    )
    trip_data_events = [
        event["data"]["data"]
        for event in realtime_trip_data
        if event["event_type"] == "tripData"
        and "data" in event["data"]
        and event["data"]["data"]
    ]

    if not trip_start_event:
        # Log missing start event
        logger.error("Missing tripStart event in realtime data, cannot assemble trip.")
        return None
    if not trip_end_event:
        # Log missing end event
        logger.error("Missing tripEnd event in realtime data, cannot assemble trip.")
        return None

    start_time = parser.isoparse(trip_start_event["data"]["start"]["timestamp"])
    end_time = parser.isoparse(trip_end_event["data"]["end"]["timestamp"])
    imei = trip_start_event["imei"]
    transaction_id = trip_start_event["transactionId"]

    # Log parsed basic trip info
    logger.debug(
        f"Parsed startTime: {start_time}, endTime: {end_time}, transactionId: {transaction_id}, imei: {imei}"
    )

    all_coords = []
    for data_chunk in trip_data_events:  # Iterate over chunks of tripData
        for point in data_chunk:  # Iterate over points within each chunk
            # Robust GPS data check
            if (
                point.get("gps")
                and point["gps"].get("lat") is not None
                and point["gps"].get("lon") is not None
            ):
                # Ensure lon, lat order
                all_coords.append([point["gps"]["lon"], point["gps"]["lat"]])

    if not all_coords:
        # Log no coords warning
        logger.warning(
            f"No valid GPS coordinates found in realtime data for trip {transaction_id}."
        )
        return None
    # Log coord count
    logger.debug(f"Extracted {len(all_coords)} coordinates from tripData events.")

    trip_gps = {"type": "LineString", "coordinates": all_coords}

    trip = {
        "transactionId": transaction_id,
        "imei": imei,
        "startTime": start_time,
        "endTime": end_time,
        "gps": trip_gps,
        "source": "webhook",  # Mark source as webhook
        "startOdometer": trip_start_event["data"]["start"]["odometer"],
        "endOdometer": trip_end_event["data"]["end"]["odometer"],
        "fuelConsumed": trip_end_event["data"]["end"]["fuelConsumed"],
        "timeZone": trip_start_event["data"]["start"]["timeZone"],
        "maxSpeed": 0,  # Initialize, can be calculated later if needed
        "averageSpeed": 0,  # Initialize, can be calculated later
        "totalIdleDuration": 0,  # Initialize, can be calculated later
        "hardBrakingCount": 0,  # Initialize, can be updated from metrics if available later
        "hardAccelerationCount": 0,
    }

    # Log trip object assembled
    logger.debug(f"Assembled trip object with transactionId: {transaction_id}")

    # Use existing processing for geocoding etc.
    processed_trip = await process_trip_data(trip)

    # Log function completion
    logger.info(f"Trip assembly completed for transactionId: {transaction_id}.")
    return processed_trip


# WebSocket Endpoint


async def process_trip_data(trip):
    """
    Processes a trip's geocoding data. For both the start and destination points:
      - If the point falls within a defined custom place (found asynchronously), assign the custom place's name and its _id.
      - Otherwise, call reverse_geocode_nominatim and extract its "display_name".
    Also sets the geo-point fields for geospatial queries.
    """
    transaction_id = trip.get("transactionId", "?")
    logger.info(f"Processing trip data for trip {transaction_id}...")
    try:
        gps_data = trip.get("gps")
        if not gps_data:
            logger.warning(f"Trip {transaction_id} has no GPS data to process.")
            return trip

        # If GPS data is stored as a string, parse it into a dict.
        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
            except Exception as e:
                logger.error(
                    f"Error parsing GPS data for trip {transaction_id}: {e}",
                    exc_info=True,
                )
                return trip
        # Update the trip's GPS field with the parsed data.
        trip["gps"] = gps_data

        if not gps_data.get("coordinates"):
            logger.warning(f"Trip {transaction_id} has no coordinates in GPS data.")
            return trip

        # Extract the first (start) and last (end) coordinates.
        st = gps_data["coordinates"][0]
        en = gps_data["coordinates"][-1]
        logger.debug(
            f"Extracted start point: {st}, end point: {en} for trip {transaction_id}"
        )

        # Create Point objects for start and end.
        start_point = Point(st[0], st[1])
        end_point = Point(en[0], en[1])

        # Lookup custom places asynchronously.
        start_place = await get_place_at_point(start_point)
        if start_place:
            trip["startLocation"] = start_place["name"]
            trip["startPlaceId"] = str(start_place.get("_id", ""))
            logger.debug(
                f"Start point of trip {transaction_id} is within custom place: {start_place['name']}"
            )
        else:
            geocode_data = await reverse_geocode_nominatim(st[1], st[0])
            start_location = ""
            if geocode_data and isinstance(geocode_data, dict):
                start_location = geocode_data.get("display_name", "")
            trip["startLocation"] = start_location
            logger.debug(
                f"Start point of trip {transaction_id} reverse geocoded to: {start_location}"
            )

        end_place = await get_place_at_point(end_point)
        if end_place:
            trip["destination"] = end_place["name"]
            trip["destinationPlaceId"] = str(end_place.get("_id", ""))
            logger.debug(
                f"End point of trip {transaction_id} is within custom place: {end_place['name']}"
            )
        else:
            geocode_data = await reverse_geocode_nominatim(en[1], en[0])
            destination_name = ""
            if geocode_data and isinstance(geocode_data, dict):
                destination_name = geocode_data.get("display_name", "")
            trip["destination"] = destination_name
            logger.debug(
                f"End point of trip {transaction_id} reverse geocoded to: {destination_name}"
            )

        # Set GeoPoint fields for geospatial queries.
        trip["startGeoPoint"] = {"type": "Point", "coordinates": [st[0], st[1]]}
        trip["destinationGeoPoint"] = {"type": "Point", "coordinates": [en[0], en[1]]}

        logger.debug(f"GeoPoints set for trip {transaction_id}.")
        logger.info(f"Trip data processing completed for trip {transaction_id}.")
        return trip

    except Exception as e:
        logger.error(
            f"Error in process_trip_data for trip {transaction_id}: {e}",
            exc_info=True,
        )
        return trip


async def get_place_at_point(point):
    """
    Find a custom place that contains the given point.
    """
    places = await places_collection.find({}).to_list(length=None)
    for p in places:
        place_shape = shape(p["geometry"])
        if place_shape.contains(point):
            return p
    return None


# ---------------------------------------------------------------------------
# Helper: Process a Bouncie event and update live trip
# ---------------------------------------------------------------------------
async def process_bouncie_event(data: dict):
    event_type = data.get("eventType")
    transaction_id = data.get("transactionId")
    if not event_type or (
        event_type in ("tripStart", "tripData", "tripEnd") and not transaction_id
    ):
        raise HTTPException(status_code=400, detail="Invalid event payload")

    # Assume get_trip_timestamps and sort_and_filter_trip_coordinates are already defined.
    if event_type == "tripStart":
        start_time, _ = get_trip_timestamps(data)
        live_trip = {
            "transactionId": transaction_id,
            "status": "active",
            "startTime": start_time,
            "coordinates": [],
            "lastUpdate": start_time,
        }
        await live_trips_collection.update_one(
            {"transactionId": transaction_id, "status": "active"},
            {"$set": live_trip},
            upsert=True,
        )

    elif event_type == "tripData":
        # Fetch existing active trip
        trip_doc = await live_trips_collection.find_one(
            {"transactionId": transaction_id, "status": "active"}
        )
        if not trip_doc:
            now = datetime.now(timezone.utc)
            live_trip = {
                "transactionId": transaction_id,
                "status": "active",
                "startTime": now,
                "coordinates": [],
                "lastUpdate": now,
            }
            await live_trips_collection.insert_one(live_trip)
            trip_doc = live_trip

        if "data" in data:
            new_coords = sort_and_filter_trip_coordinates(data["data"])
            all_coords = trip_doc.get("coordinates", []) + new_coords
            all_coords.sort(key=lambda c: c["timestamp"])
            new_last_update = (
                all_coords[-1]["timestamp"] if all_coords else trip_doc.get("startTime")
            )
            await live_trips_collection.update_one(
                {"transactionId": transaction_id, "status": "active"},
                {"$set": {"coordinates": all_coords, "lastUpdate": new_last_update}},
            )

    elif event_type == "tripEnd":
        start_time, end_time = get_trip_timestamps(data)
        trip = await live_trips_collection.find_one({"transactionId": transaction_id})
        if trip:
            trip["endTime"] = end_time
            trip["status"] = "completed"
            await archived_live_trips_collection.insert_one(trip)
            await live_trips_collection.delete_one({"transactionId": transaction_id})
    # End if

    # After processing, return the current active trip (if any) for broadcasting.
    return await live_trips_collection.find_one({"status": "active"})


@app.websocket("/ws/live_trip")
async def ws_live_trip(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Simply keep the connection open.
        while True:
            await asyncio.sleep(10)
    except WebSocketDisconnect:
        manager.disconnect(websocket)


# Error Handlers & Startup


@app.exception_handler(404)
async def not_found_handler(request: Request, exc):
    return JSONResponse(status_code=404, content={"error": "Endpoint not found"})


@app.exception_handler(500)
async def internal_error_handler(request: Request, exc):
    return JSONResponse(status_code=500, content={"error": "Internal server error"})


@app.on_event("startup")
async def startup_event():
    """Initialize the application on startup."""
    try:
        # Initialize task history collection
        await init_task_history_collection()

        # Start background tasks
        await start_background_tasks()

        logger.info("Application startup completed successfully")
    except Exception as e:
        logger.error(f"Error during application startup: {e}", exc_info=True)
        raise e


# Main


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run("app:app", host="0.0.0.0", port=port, log_level="info", reload=True)


# Add task history and details endpoints
@app.get("/api/background_tasks/history")
async def get_task_history():
    """Get the task execution history."""
    return task_manager.task_history


@app.get("/api/background_tasks/task/{task_id}")
async def get_task_details(task_id: str):
    """Get detailed information about a specific background task."""
    try:
        # Get the task definition from the task manager
        task_def = task_manager.tasks.get(task_id)
        if not task_def:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")

        # Get the current task configuration
        config = await task_manager._get_config()
        task_config = config.get("tasks", {}).get(task_id, {})

        # Get the task's history
        history = []
        cursor = (
            task_history_collection.find({"task_id": task_id})
            .sort("timestamp", -1)
            .limit(5)
        )
        async for entry in cursor:
            history.append(
                {
                    "timestamp": (
                        entry["timestamp"].isoformat() if entry["timestamp"] else None
                    ),
                    "status": entry["status"],
                    "runtime": entry.get("runtime"),
                    "error": entry.get("error"),
                }
            )

        # Format timestamps
        for ts_field in ["last_run", "next_run", "start_time", "end_time"]:
            if ts_field in task_config and task_config[ts_field]:
                if isinstance(task_config[ts_field], str):
                    task_config[ts_field] = task_config[ts_field]
                else:
                    task_config[ts_field] = task_config[ts_field].isoformat()

        # Compile the task details
        task_details = {
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
            "last_run": task_config.get("last_run"),
            "next_run": task_config.get("next_run"),
            "start_time": task_config.get("start_time"),
            "end_time": task_config.get("end_time"),
            "last_error": task_config.get("last_error"),
            "history": history,
        }

        return task_details

    except Exception as e:
        logger.error(f"Error getting task details for {task_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def calculate_task_success_rate(history: List[Dict]) -> float:
    """Calculate the success rate from task history."""
    if not history:
        return 0.0

    successful = sum(1 for entry in history if entry["status"] == "COMPLETED")
    return (successful / len(history)) * 100
