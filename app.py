from timestamp_utils import get_trip_timestamps, sort_and_filter_trip_coordinates
from update_geo_points import update_geo_points
from utils import validate_location_osm
from map_matching import (
    process_and_map_match_trip,
)
from bouncie_trip_fetcher import fetch_bouncie_trips_in_range, fetch_and_store_trips
from preprocess_streets import preprocess_streets as async_preprocess_streets
from utils import validate_trip_data, reverse_geocode_nominatim, validate_location_osm
from tasks import (
    cleanup_stale_trips,
    cleanup_invalid_trips,
    periodic_fetch_trips,
    start_background_tasks,
    scheduler,
)
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
)
from trip_processing import format_idle_time
from export_helpers import create_geojson, create_gpx
from shapely.geometry import LineString, Point, Polygon, shape
from street_coverage_calculation import (
    compute_coverage_for_location,
    update_coverage_for_all_locations,
)
from pymongo.errors import DuplicateKeyError
from math import radians, cos, sin, sqrt, atan2
from pymongo import MongoClient
from geojson import dumps as geojson_dumps, loads as geojson_loads
import asyncio
import glob
import io
import json
import logging
import os
import traceback
import zipfile
from datetime import datetime, timedelta, timezone
import aiohttp
import certifi
import geopandas as gpd
import geojson as geojson_module
import gpxpy
import gpxpy.gpx
import pymongo
import pytz
from bson import ObjectId
from dateutil import parser
from dotenv import load_dotenv
from quart import (
    Quart,
    Response,
    jsonify,
    render_template,
    request,
    send_file,
    websocket,
)
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.base import JobLookupError
from datetime import datetime, timezone

scheduler = AsyncIOScheduler()


load_dotenv()

# Logging Configuration (Structured Logging - JSON)
logging.basicConfig(
    level=logging.INFO,  # Set default level to INFO
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)  # Simple format for console
logger = logging.getLogger(__name__)

app = Quart(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "supersecretfallback")

# Bouncie config
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_CODE = os.getenv("AUTHORIZATION_CODE")
AUTHORIZED_DEVICES = [d for d in os.getenv(
    "AUTHORIZED_DEVICES", "").split(",") if d]
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"
OVERPASS_URL = "http://overpass-api.de/api/interpreter"

# For active, real-time trips
active_trips = {}

# Global variable to store progress information
progress_data = {
    "fetch_and_store_trips": {"status": "idle", "progress": 0, "message": ""},
    "fetch_bouncie_trips_in_range": {"status": "idle", "progress": 0, "message": ""},
    "preprocess_streets": {"status": "idle", "progress": 0, "message": ""},
}


# MongoDB Initialization


def get_mongo_client():
    """
    Creates and returns a MongoClient, with TLS and CA checks.
    """
    try:
        client = MongoClient(
            os.getenv("MONGO_URI"),
            tls=True,
            tlsAllowInvalidCertificates=True,
            tlsCAFile=certifi.where(),
            tz_aware=True,
            tzinfo=timezone.utc,
        )
        logger.info("MongoDB client initialized successfully.")
        return client
    except Exception as e:
        # Log exception details
        logger.error(
            f"Failed to initialize MongoDB client: {e}", exc_info=True)
        raise


mongo_client = get_mongo_client()
db = mongo_client["every_street"]

# Ensure some indexes
uploaded_trips_collection.create_index("transactionId", unique=True)
matched_trips_collection.create_index("transactionId", unique=True)
osm_data_collection.create_index([("location", 1), ("type", 1)], unique=True)
streets_collection.create_index([("geometry", "2dsphere")])
streets_collection.create_index([("properties.location", 1)])
coverage_metadata_collection.create_index([("location", 1)], unique=True)

# tasks

AVAILABLE_TASKS = [
    {
        "id": "fetch_and_store_trips",
        "display_name": "Fetch & Store Trips",
        "default_interval_minutes": 30,
    },
    {
        "id": "periodic_fetch_trips",
        "display_name": "Periodic Trip Fetch",
        "default_interval_minutes": 30,
    },
    {
        "id": "update_coverage_for_all_locations",
        "display_name": "Update Coverage (All Locations)",
        "default_interval_minutes": 60,
    },
    {
        "id": "cleanup_stale_trips",
        "display_name": "Cleanup Stale Trips",
        "default_interval_minutes": 60,
    },
    {
        "id": "cleanup_invalid_trips",
        "display_name": "Cleanup Invalid Trips",
        "default_interval_minutes": 1440,  # once per day
    },
]


def get_task_config():
    """
    Retrieves the background task config doc from MongoDB.
    If none exists, we create a default one.
    """
    cfg = task_config_collection.find_one(
        {"_id": "global_background_task_config"})
    if not cfg:
        # create a default
        cfg = {
            "_id": "global_background_task_config",
            "pausedUntil": None,  # if globally paused
            "disabled": False,  # if globally disabled
            "tasks": {
                # each task: { "interval_minutes": X, "enabled": True/False }
            },
        }
        # Prepopulate with defaults
        for t in AVAILABLE_TASKS:
            cfg["tasks"][t["id"]] = {
                "interval_minutes": t["default_interval_minutes"],
                "enabled": True,
            }
        task_config_collection.insert_one(cfg)
    return cfg


def save_task_config(cfg):
    """
    Saves the given config doc to the DB, overwriting the old one.
    """
    task_config_collection.replace_one(
        {"_id": "global_background_task_config"}, cfg, upsert=True
    )


@app.route("/api/background_tasks/config", methods=["GET"])
async def get_background_tasks_config():
    """
    Returns the current background task configuration, including intervals,
    whether globally disabled, paused, etc.
    """
    cfg = get_task_config()
    return jsonify(cfg)


@app.route("/api/background_tasks/config", methods=["POST"])
async def update_background_tasks_config():
    """
    Allows the client to update the intervals or enable/disable each task.
    Expects JSON like:
    {
      "tasks": {
         "fetch_and_store_trips": { "interval_minutes": 60, "enabled": true },
         "periodic_fetch_trips":  { "interval_minutes": 180, "enabled": false },
         ...
      }
    }
    Also can set "globalDisable": bool,
    or "pauseDurationMinutes": int to do a one-time pause for X minutes
    """
    data = await request.get_json()
    cfg = get_task_config()

    if "globalDisable" in data:
        cfg["disabled"] = bool(data["globalDisable"])

    if "pauseDurationMinutes" in data:
        mins = data["pauseDurationMinutes"]
        if mins > 0:
            cfg["pausedUntil"] = datetime.now(
                timezone.utc) + timedelta(minutes=mins)
        else:
            cfg["pausedUntil"] = None  # unpause if 0

    # If client wants to update individual tasks
    if "tasks" in data:
        for task_id, task_data in data["tasks"].items():
            if task_id in cfg["tasks"]:
                # update interval
                if "interval_minutes" in task_data:
                    cfg["tasks"][task_id]["interval_minutes"] = task_data[
                        "interval_minutes"
                    ]
                # update enable
                if "enabled" in task_data:
                    cfg["tasks"][task_id]["enabled"] = bool(
                        task_data["enabled"])

    save_task_config(cfg)
    # Also re-initialize background tasks so changes take effect immediately
    reinitialize_scheduler_tasks()

    return jsonify({"status": "success", "message": "Background task config updated"})


@app.route("/api/background_tasks/pause", methods=["POST"])
async def pause_background_tasks():
    """
    Pause all background tasks for a specified duration or until a specific time.
    Expects JSON like { "minutes": 30 } or { "minutes": 0 } to unpause
    """
    data = await request.get_json()
    mins = data.get("minutes", 0)
    cfg = get_task_config()
    if mins > 0:
        cfg["pausedUntil"] = datetime.now(
            timezone.utc) + timedelta(minutes=mins)
    else:
        # unpause
        cfg["pausedUntil"] = None
    save_task_config(cfg)
    reinitialize_scheduler_tasks()
    return jsonify(
        {
            "status": "success",
            "message": f"Paused for {mins} minutes" if mins > 0 else "Unpaused",
        }
    )


@app.route("/api/background_tasks/resume", methods=["POST"])
async def resume_background_tasks():
    """
    Immediately unpause tasks if they were paused.
    """
    cfg = get_task_config()
    cfg["pausedUntil"] = None
    save_task_config(cfg)
    reinitialize_scheduler_tasks()
    return jsonify({"status": "success", "message": "Tasks resumed"})


@app.route("/api/background_tasks/stop_all", methods=["POST"])
async def stop_all_background_tasks():
    """
    Immediately stop all tasks that might be 'in process' by removing them from the scheduler entirely.
    They will remain out of schedule unless reinitialized or re-enabled.
    """
    for t in AVAILABLE_TASKS:
        job_id = t["id"]
        try:
            scheduler.remove_job(job_id)
        except JobLookupError:
            pass
    return jsonify(
        {"status": "success", "message": "All background tasks removed from scheduler."}
    )


@app.route("/api/background_tasks/enable", methods=["POST"])
async def enable_all_background_tasks():
    """
    Enable tasks globally (disable=false) and reinitialize.
    """
    cfg = get_task_config()
    cfg["disabled"] = False
    save_task_config(cfg)
    reinitialize_scheduler_tasks()
    return jsonify({"status": "success", "message": "All tasks globally enabled"})


@app.route("/api/background_tasks/disable", methods=["POST"])
async def disable_all_background_tasks():
    """
    Disable tasks globally. This will remove them from the schedule
    until re-enabled. We'll also set disabled=true in the config.
    """
    cfg = get_task_config()
    cfg["disabled"] = True
    save_task_config(cfg)
    reinitialize_scheduler_tasks()
    return jsonify({"status": "success", "message": "All tasks globally disabled"})


@app.route("/api/background_tasks/manual_run", methods=["POST"])
async def manually_run_tasks():
    """
    Manually trigger one or multiple tasks.
    Expects JSON like { "tasks": ["fetch_and_store_trips", ...] }
    or { "tasks": ["ALL"] } to run all available tasks.
    """
    data = await request.get_json()
    tasks_to_run = data.get("tasks", [])
    if not tasks_to_run:
        return jsonify({"status": "error", "message": "No tasks provided"}), 400

    if "ALL" in tasks_to_run:
        tasks_to_run = [t["id"] for t in AVAILABLE_TASKS]

    import asyncio

    async def run_task_by_id(task_id):
        if task_id == "fetch_and_store_trips":
            await fetch_and_store_trips()
        elif task_id == "periodic_fetch_trips":
            await periodic_fetch_trips()
        elif task_id == "update_coverage_for_all_locations":
            await update_coverage_for_all_locations()
        elif task_id == "cleanup_stale_trips":
            await cleanup_stale_trips()
        elif task_id == "cleanup_invalid_trips":
            await cleanup_invalid_trips()
        else:
            return False
        return True

    results = []
    for t in tasks_to_run:
        ok = await run_task_by_id(t)
        results.append({"task": t, "success": ok})

    return jsonify({"status": "success", "results": results})


def reinitialize_scheduler_tasks():
    """
    Re-read the config from DB, remove existing jobs, re-add them with correct intervals if enabled,
    unless globally disabled or paused.
    """

    for t in AVAILABLE_TASKS:
        job_id = t["id"]
        try:
            scheduler.remove_job(job_id)
        except JobLookupError:
            pass

    cfg = get_task_config()
    # if globally disabled, do not schedule anything
    if cfg.get("disabled"):
        logger.info(
            "Background tasks are globally disabled. No tasks scheduled.")
        return

    paused_until = cfg.get("pausedUntil")
    is_currently_paused = False
    if paused_until:
        now_utc = datetime.now(timezone.utc)
        if paused_until > now_utc:
            is_currently_paused = True

    for t in AVAILABLE_TASKS:
        task_id = t["id"]
        task_settings = cfg["tasks"].get(task_id, {})
        if not task_settings:
            # if not found in config, skip
            continue
        if not task_settings.get("enabled", True):
            continue  # skip if not individually enabled
        interval = task_settings.get(
            "interval_minutes", t["default_interval_minutes"])

        next_run_time = None
        if is_currently_paused:
            next_run_time = paused_until + timedelta(seconds=1)

        if task_id == "fetch_and_store_trips":
            job_func = fetch_and_store_trips
        elif task_id == "periodic_fetch_trips":
            job_func = periodic_fetch_trips
        elif task_id == "update_coverage_for_all_locations":
            job_func = update_coverage_for_all_locations
        elif task_id == "cleanup_stale_trips":
            job_func = cleanup_stale_trips
        elif task_id == "cleanup_invalid_trips":
            job_func = cleanup_invalid_trips
        else:
            continue

        # Now schedule it
        scheduler.add_job(
            job_func,
            "interval",
            minutes=interval,
            id=task_id,
            next_run_time=next_run_time,
            max_instances=1,
        )

    logger.info("Scheduler tasks reinitialized based on new config.")


# Model or helper class


class CustomPlace:
    """Represents a custom-defined place with a name, geometry, and creation time."""

    def __init__(self, name, geometry, created_at=None):
        self.name = name
        self.geometry = geometry
        self.created_at = created_at or datetime.now(timezone.utc)

    def to_dict(self):
        """Dict representation for DB insertion."""
        return {
            "name": self.name,
            "geometry": self.geometry,
            "created_at": self.created_at,
        }

    @staticmethod
    def from_dict(data):
        """Factory method from DB dict data."""
        return CustomPlace(
            name=data["name"],
            geometry=data["geometry"],
            created_at=data.get("created_at", datetime.now(timezone.utc)),
        )


# Quart endpoints


@app.route("/")
async def index():
    """Renders the main map page."""
    return await render_template("index.html")


@app.route("/trips")
async def trips_page():
    """Trips listing page."""
    return await render_template("trips.html")


@app.route("/settings")
async def settings():
    """Render the settings page."""
    return await render_template("settings.html")


@app.route("/driving-insights")
async def driving_insights_page():
    """Driving insights page."""
    return await render_template("driving_insights.html")


@app.route("/visits")
async def visits_page():
    """Custom places visits & stats page."""
    return await render_template("visits.html")


#  Fetch for geojson map


def fetch_trips_for_geojson():
    """
    Returns all trips as a GeoJSON FeatureCollection.
    Used by e.g. the map for quick visualization.
    """
    trips = trips_collection.find()
    features = []

    for trip in trips:
        try:
            feature = geojson_module.Feature(
                geometry=geojson_loads(trip["gps"]),
                properties={
                    "transactionId": trip["transactionId"],
                    "imei": trip["imei"],
                    "startTime": trip["startTime"].isoformat(),
                    "endTime": trip["endTime"].isoformat(),
                    "distance": trip.get("distance", 0),
                    "destination": trip.get("destination", ""),
                    "startLocation": trip.get("startLocation", ""),
                    "timeZone": trip.get("timeZone", "UTC"),
                },
            )
            features.append(feature)
        except Exception as e:
            # Log error for individual trip processing
            logger.error(
                f"Error processing trip {trip.get('transactionId')}: {e}", exc_info=True
            )

    return geojson_module.FeatureCollection(features)


@app.route("/api/street_coverage", methods=["POST"])
async def get_street_coverage():
    """
    Calculates street coverage using a new raster-based method.

    Expects a JSON payload with a key "location" containing the validated location object.
    This object should ideally include a "boundingbox" (or "geojson") and a "display_name".

    Returns a JSON response containing:
      - total_length (meters)
      - driven_length (meters)
      - coverage_percentage
      - raster_dimensions (nrows, ncols)
      - streets_data: { metadata: { total_length_miles, driven_length_miles }, features: [] }
    """
    try:
        data = await request.get_json()
        location = data.get("location")
        if not location or not isinstance(location, dict):
            return jsonify({"status": "error", "message": "Invalid location data."}), 400

        logger.info(
            f"Calculating coverage for location: {location.get('display_name', 'Unknown')}"
        )

        # Compute coverage (this function now expects location to be a dictionary)
        result = compute_coverage_for_location(location)
        if result is None:
            return jsonify({
                "status": "error",
                "message": "No street data found or error in computation."
            }), 404

        # Get the display name from the location dict
        display_name = location.get("display_name", "Unknown")
        # Update the coverage metadata document using the key "location.display_name"
        coverage_metadata_collection.update_one(
            {"location.display_name": display_name},
            {
                "$set": {
                    "location": location,  # store the full location object
                    "total_length": result["total_length"],
                    "driven_length": result["driven_length"],
                    "coverage_percentage": result["coverage_percentage"],
                    "last_updated": datetime.now(timezone.utc),
                }
            },
            upsert=True,
        )

        # Assemble the response object.
        response_obj = {
            "total_length": result["total_length"],
            "driven_length": result["driven_length"],
            "coverage_percentage": result["coverage_percentage"],
            "raster_dimensions": result["raster_dimensions"],
            "streets_data": {
                "metadata": {
                    "total_length_miles": float(result["total_length"]) * 0.000621371,
                    "driven_length_miles": float(result["driven_length"]) * 0.000621371,
                },
                "features": [],  # This approach uses raster data only.
            },
        }

        return jsonify(response_obj)
    except Exception as e:
        import traceback
        logger.error(f"Error in street coverage calculation: {e}\n{traceback.format_exc()}")
        return jsonify({"status": "error", "message": str(e)}), 500


# Quart endpoints


@app.route("/api/trips")
async def get_trips():
    """
    Return a combined FeatureCollection of regular, uploaded, and historical trips.
    Trips missing a valid startTime or endTime will be skipped.
    """
    try:
        # Parse query parameters (if provided)
        start_date_str = request.args.get("start_date")
        end_date_str = request.args.get("end_date")
        imei = request.args.get("imei")

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

        # Build MongoDB query
        query = {}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        if imei:
            query["imei"] = imei

        # Run blocking PyMongo calls off the event loop.
        async def fetch_trips(collection, query):
            return await asyncio.to_thread(lambda: list(collection.find(query)))

        regular, uploaded, historical = await asyncio.gather(
            fetch_trips(trips_collection, query),
            fetch_trips(uploaded_trips_collection, query),
            fetch_trips(historical_trips_collection, query),
        )

        all_trips = regular + uploaded + historical

        features = []

        for trip in all_trips:
            try:
                # Ensure that both startTime and endTime exist
                st = trip.get("startTime")
                et = trip.get("endTime")
                if st is None or et is None:
                    logger.warning(
                        f"Skipping trip {trip.get('transactionId', 'unknown')} due to missing startTime or endTime"
                    )
                    continue

                # If stored as strings, parse them
                if isinstance(st, str):
                    st = parser.isoparse(st)
                if isinstance(et, str):
                    et = parser.isoparse(et)

                # If the datetime objects are not tz-aware, set UTC as default
                if st.tzinfo is None:
                    st = st.replace(tzinfo=timezone.utc)
                if et.tzinfo is None:
                    et = et.replace(tzinfo=timezone.utc)
                # Save back into the trip
                trip["startTime"] = st
                trip["endTime"] = et

                # Process GPS geometry
                geometry = trip.get("gps")
                if isinstance(geometry, str):
                    geometry = geojson_loads(geometry)

                properties = {
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

                feature = geojson_module.Feature(
                    geometry=geometry, properties=properties
                )
                features.append(feature)
            except Exception as e:
                logger.error(
                    f"Error processing trip {trip.get('transactionId', 'unknown')}: {e}",
                    exc_info=True,
                )
                # Optionally continue processing other trips
                continue

        return jsonify(geojson_module.FeatureCollection(features))
    except Exception as e:
        logger.error(f"Error in /api/trips endpoint: {e}", exc_info=True)
        return jsonify({"error": "Failed to retrieve trips"}), 500


# Driving Insights


@app.route("/api/driving-insights")
async def get_driving_insights():
    """
    Summarize total trips, distances, speed, etc. across trips and uploads.
    """
    try:
        start_date_str = request.args.get("start_date")
        end_date_str = request.args.get("end_date")
        imei = request.args.get("imei")

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

        def pipeline_agg(collection):
            return collection.aggregate(
                [
                    {"$match": query},
                    {
                        "$group": {
                            "_id": None,
                            "total_trips": {"$sum": 1},
                            "total_distance": {"$sum": {"$ifNull": ["$distance", 0]}},
                            "total_fuel_consumed": {
                                "$sum": {"$ifNull": ["$fuelConsumed", 0]}
                            },
                            "max_speed": {"$max": {"$ifNull": ["$maxSpeed", 0]}},
                            "total_idle_duration": {
                                "$sum": {"$ifNull": ["$totalIdleDuration", 0]}
                            },
                            "longest_trip_distance": {
                                "$max": {"$ifNull": ["$distance", 0]}
                            },
                        }
                    },
                ]
            )

        result_trips = list(pipeline_agg(trips_collection))
        result_uploaded = list(pipeline_agg(uploaded_trips_collection))

        # also get top visited place
        def pipeline_most_visited(collection):
            return collection.aggregate(
                [
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
            )

        result_most_visited_trips = list(
            pipeline_most_visited(trips_collection))
        result_most_visited_uploaded = list(
            pipeline_most_visited(uploaded_trips_collection)
        )

        # Merge results
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
                combined["total_fuel_consumed"] += r.get(
                    "total_fuel_consumed", 0)
                combined["max_speed"] = max(
                    combined["max_speed"], r.get("max_speed", 0)
                )
                combined["total_idle_duration"] += r.get(
                    "total_idle_duration", 0)
                combined["longest_trip_distance"] = max(
                    combined["longest_trip_distance"], r.get(
                        "longest_trip_distance", 0)
                )

        # find the single most visited among the merges
        all_most_visited = result_most_visited_trips + result_most_visited_uploaded
        if all_most_visited:
            best = sorted(all_most_visited,
                          key=lambda x: x["count"], reverse=True)[0]
            combined["most_visited"] = {
                "_id": best["_id"],
                "count": best["count"],
                "isCustomPlace": best.get("isCustomPlace", False),
            }

        return jsonify(
            {
                "total_trips": combined["total_trips"],
                "total_distance": round(combined["total_distance"], 2),
                "total_fuel_consumed": round(combined["total_fuel_consumed"], 2),
                "max_speed": round(combined["max_speed"], 2),
                "total_idle_duration": combined["total_idle_duration"],
                "longest_trip_distance": round(combined["longest_trip_distance"], 2),
                "most_visited": combined["most_visited"],
            }
        )
    except Exception as e:
        logger.error(f"Error in get_driving_insights: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


@app.route("/api/metrics")
async def get_metrics():
    """
    Example metrics for a date range:
    total trips, distance, average distance,
    average start time, average driving time, average speed, max speed
    """
    start_date_str = request.args.get("start_date")
    end_date_str = request.args.get("end_date")
    imei = request.args.get("imei")

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

    # Combine normal + historical
    trips = list(trips_collection.find(query))
    hist = list(historical_trips_collection.find(query))
    all_trips = trips + hist

    total_trips = len(all_trips)
    total_distance = sum(t.get("distance", 0) for t in all_trips)
    avg_distance = total_distance / total_trips if total_trips > 0 else 0.0

    # average start time
    start_times = []
    for t in all_trips:
        st = t["startTime"]
        if st.tzinfo is None:
            st = st.replace(tzinfo=timezone.utc)
        # convert to local
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

    # driving times
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

    return jsonify(
        {
            "total_trips": total_trips,
            "total_distance": f"{round(total_distance, 2)}",
            "avg_distance": f"{round(avg_distance, 2)}",
            "avg_start_time": f"{hour:02d}:{minute:02d} {am_pm}",
            "avg_driving_time": f"{avg_driving_h:02d}:{avg_driving_m:02d}",
            "avg_speed": f"{round(avg_speed, 2)}",
            "max_speed": f"{round(max_speed, 2)}",
        }
    )


@app.route("/api/fetch_trips", methods=["POST"])
async def api_fetch_trips():
    """Fetch last 4 years of trips and store them."""
    start_date = datetime.now(timezone.utc) - timedelta(days=4 * 365)
    end_date = datetime.now(timezone.utc)
    await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=False)
    return jsonify({"status": "success", "message": "Trips fetched & stored."})


@app.route("/api/fetch_trips_range", methods=["POST"])
async def api_fetch_trips_range():
    """Fetch and store trips in a given date range."""
    data = await request.get_json()
    start_date = datetime.fromisoformat(
        data["start_date"]).replace(tzinfo=timezone.utc)
    end_date = datetime.fromisoformat(
        data["end_date"]).replace(tzinfo=timezone.utc)
    await fetch_bouncie_trips_in_range(
        start_date, end_date, do_map_match=False, progress_data=progress_data
    )
    return jsonify({"status": "success", "message": "Trips fetched & stored."})


@app.route("/api/fetch_trips_last_hour", methods=["POST"])
async def api_fetch_trips_last_hour():
    """Fetch and store trips from the last hour."""
    now_utc = datetime.now(timezone.utc)
    start_date = now_utc - timedelta(hours=1)
    await fetch_bouncie_trips_in_range(start_date, now_utc, do_map_match=True)
    return jsonify({"status": "success", "message": "Hourly trip fetch completed."})


# After request


@app.after_request
async def add_header(response):
    """
    Add no-cache headers.
    """
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# Exports


@app.route("/export/geojson")
async def export_geojson():
    """
    Exports a range of trips as GeoJSON.
    """
    try:
        start_date_str = request.args.get("start_date")
        end_date_str = request.args.get("end_date")
        imei = request.args.get("imei")

        start_date = (
            datetime.strptime(
                start_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
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

        trips = list(trips_collection.find(query))
        if not trips:
            return jsonify({"error": "No trips found for filters."}), 404

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
        return jsonify(fc)
    except Exception as e:
        logger.error(f"Error exporting GeoJSON: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


@app.route("/export/gpx")
async def export_gpx():
    """
    Exports a range of trips as GPX.
    """
    try:
        start_date_str = request.args.get("start_date")
        end_date_str = request.args.get("end_date")
        imei = request.args.get("imei")

        start_date = (
            datetime.strptime(
                start_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
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

        trips = list(trips_collection.find(query))
        if not trips:
            return jsonify({"error": "No trips found."}), 404

        gpx = gpxpy.gpx.GPX()
        for t in trips:
            track = gpxpy.gpx.GPXTrack()
            gpx.tracks.append(track)
            seg = gpxpy.gpx.GPXTrackSegment()
            track.segments.append(seg)

            gps_data = t["gps"]
            if isinstance(gps_data, str):
                gps_data = json.loads(gps_data)
            if gps_data["type"] == "LineString":
                for coord in gps_data["coordinates"]:
                    lon, lat = coord[0], coord[1]
                    seg.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
            elif gps_data["type"] == "Point":
                lon, lat = gps_data["coordinates"]
                seg.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))

            track.name = t.get("transactionId", "Unnamed Trip")
            track.description = (
                f"Trip from {t.get('startLocation')} to {t.get('destination')}"
            )

        gpx_xml = gpx.to_xml()
        return Response(
            gpx_xml,
            mimetype="application/gpx+xml",
            headers={"Content-Disposition": "attachment;filename=trips.gpx"},
        )
    except Exception as e:
        logger.error(f"Error exporting gpx: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


# Location validation


@app.route("/api/validate_location", methods=["POST"])
async def validate_location():
    data = await request.get_json()
    location = data.get("location")
    location_type = data.get("locationType")
    validated = await validate_location_osm(location, location_type)
    return jsonify(validated)


# Generate GeoJSON from Overpass


@app.route("/api/generate_geojson", methods=["POST"])
async def generate_geojson():
    """
    Given a validated location with osm_id/type, query Overpass and return GeoJSON.
    """
    data = await request.get_json()
    location = data.get("location")
    streets_only = data.get("streetsOnly", False)
    geojson_data, err = await generate_geojson_osm(location, streets_only)
    if geojson_data:
        return jsonify(geojson_data)  # Directly return GeoJSON
    return jsonify({"error": err}), 400


async def generate_geojson_osm(location, streets_only=False):
    """
    Query Overpass for the given location's geometry or highways only.
    Bypass MongoDB storage for large data and return directly.
    """
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
        async with aiohttp.ClientSession() as session:  # Create aiohttp session
            # Async get
            async with session.get(
                OVERPASS_URL, params={"data": query}, timeout=30
            ) as response:
                response.raise_for_status()  # Raise HTTPError for bad status
                data = await response.json()  # Await response.json()

        features = process_elements(data["elements"], streets_only)
        if features:
            gdf = gpd.GeoDataFrame.from_features(features)
            gdf = gdf.set_geometry("geometry")
            geojson_data = json.loads(gdf.to_json())

            # Estimate BSON size (very approximate)
            bson_size_estimate = len(json.dumps(geojson_data).encode("utf-8"))

            if bson_size_estimate <= 16793598:  # Check if within MongoDB's limit
                # Store in database
                existing_data = osm_data_collection.find_one(
                    {"location": location, "type": osm_type}
                )
                if existing_data:
                    osm_data_collection.update_one(
                        {"_id": existing_data["_id"]},
                        {
                            "$set": {
                                "geojson": geojson_data,
                                "updated_at": datetime.now(timezone.utc),
                            }
                        },
                    )
                    logger.info(
                        f"Updated OSM data for {location['display_name']}, type: {osm_type}"
                    )
                else:
                    osm_data_collection.insert_one(
                        {
                            "location": location,
                            "type": osm_type,
                            "geojson": geojson_data,
                            "created_at": datetime.now(timezone.utc),
                        }
                    )
                    logger.info(
                        f"Stored OSM data for {location['display_name']}, type: {osm_type}"
                    )
            else:
                logger.warning(
                    f"Data for {location['display_name']}, type: {osm_type} is too large for MongoDB ({bson_size_estimate} bytes). Returning directly."
                )

            return geojson_data, None  # Return GeoJSON directly
        return None, "No features found"

    except aiohttp.ClientError as e:  # Catch aiohttp exceptions
        # Log Overpass errors
        logger.error(
            f"Error generating geojson from Overpass: {e}", exc_info=True)
        return None, "Error communicating with Overpass API"
    except Exception as e:
        logger.error(f"Error generating geojson: {e}", exc_info=True)
        return None, str(e)


def process_elements(elements, streets_only):
    """
    Convert Overpass 'elements' to a list of GeoJSON features.
    """
    features = []
    ways = {e["id"]: e for e in elements if e["type"] == "way"}

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
                    # If the coords form a closed ring, it might be a polygon
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
        elif e["type"] == "relation" and not streets_only:
            # Attempt to unify outer ways into polygons
            pass

    return features


# Map match endpoints


@app.route("/api/map_match_trips", methods=["POST"])
async def map_match_trips():
    """
    Initiates map matching for trips in a date range from 'trips_collection'.
    """
    try:
        data = await request.get_json()
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

        trips = trips_collection.find(query)
        for t in trips:
            await process_and_map_match_trip(t)

        return jsonify(
            {"status": "success", "message": "Map matching started for trips."}
        )
    except Exception as e:
        # Log endpoint errors
        logger.error(f"Error in map_match_trips endpoint: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/map_match_historical_trips", methods=["POST"])
async def map_match_historical_trips():
    """
    Similar to map_match_trips but for 'historical_trips_collection'.
    """
    try:
        data = await request.get_json()
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

        historical = historical_trips_collection.find(query)
        for t in historical:
            await process_and_map_match_trip(t)

        return jsonify({"status": "success", "message": "Map matching for historical."})
    except Exception as e:
        # Log endpoint errors
        logger.error(
            f"Error in map_match_historical_trips endpoint: {e}", exc_info=True
        )
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/matched_trips")
async def get_matched_trips():
    """
    Return matched trips from matched_trips_collection in a date range.
    """
    start_date_str = request.args.get("start_date")
    end_date_str = request.args.get("end_date")
    imei = request.args.get("imei")

    # Convert start/end date strings to datetime objects
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

    matched_trips = list(matched_trips_collection.find(query))

    features = []
    for trip in matched_trips:
        try:
            feature = geojson_module.Feature(
                geometry=geojson_loads(trip["matchedGps"]),
                properties={
                    "transactionId": trip["transactionId"],
                    "imei": trip.get("imei", ""),
                    "startTime": (
                        trip["startTime"].isoformat() if trip.get(
                            "startTime") else ""
                    ),
                    "endTime": (
                        trip["endTime"].isoformat() if trip.get(
                            "endTime") else ""
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

    return jsonify(geojson_module.FeatureCollection(features))


@app.route("/api/export/trip/<trip_id>")
async def export_single_trip(trip_id):
    """
    Exports a single trip by ID in geojson or gpx format (specify ?format=).
    """
    try:
        fmt = request.args.get("format", "geojson")
        t = trips_collection.find_one({"transactionId": trip_id})
        if not t:
            return jsonify({"error": "Trip not found"}), 404

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
                    "imei": t.get("imei", ""),
                },
            }
            fc = {"type": "FeatureCollection", "features": [feature]}
            return Response(
                json.dumps(fc),
                mimetype="application/geo+json",
                headers={
                    "Content-Disposition": f'attachment; filename="trip_{trip_id}.geojson"'
                },
            )
        if fmt == "gpx":
            gpx = gpxpy.gpx.GPX()
            track = gpxpy.gpx.GPXTrack()
            gpx.tracks.append(track)
            seg = gpxpy.gpx.GPXTrackSegment()
            track.segments.append(seg)

            gps_data = t["gps"]
            if isinstance(gps_data, str):
                gps_data = json.loads(gps_data)
            if gps_data["type"] == "LineString":
                for coord in gps_data["coordinates"]:
                    lon, lat = coord
                    seg.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))

            track.name = t["transactionId"]
            return Response(
                gpx.to_xml(),
                mimetype="application/gpx+xml",
                headers={
                    "Content-Disposition": f'attachment; filename="trip_{trip_id}.gpx"'
                },
            )
        return jsonify({"error": "Unsupported format"}), 400
    except Exception as e:
        logger.error(f"Error exporting trip {trip_id}: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


@app.route("/api/matched_trips/<trip_id>", methods=["DELETE"])
async def delete_matched_trip(trip_id):
    """
    Delete a matched trip doc by transactionId.
    """
    try:
        result = matched_trips_collection.delete_one(
            {
                "$or": [
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ]
            }
        )
        if result.deleted_count:
            return jsonify({"status": "success", "message": "Deleted matched trip"})
        return jsonify({"status": "error", "message": "Trip not found"}), 404
    except Exception as e:
        logger.error(
            f"Error deleting matched trip {trip_id}: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/export")
async def export_page():
    """Renders the export page."""
    return await render_template("export.html")


@app.route("/api/export/all_trips")
async def export_all_trips():
    """
    Exports ALL trips (from trips, uploaded_trips, and historical_trips) in the specified format.
    No date filtering; everything in the DB is returned.
    """
    fmt = request.args.get("format", "geojson").lower()  # Default to geojson

    # 1) Fetch EVERYTHING from all trip collections:
    all_trips = await fetch_all_trips_no_filter()

    # 2) Format output accordingly:
    if fmt == "geojson":
        geojson_data = await create_geojson(all_trips)
        return await send_file(
            io.BytesIO(geojson_data.encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            attachment_filename="all_trips.geojson",
        )

    if fmt == "gpx":
        gpx_data = await create_gpx(all_trips)
        return await send_file(
            io.BytesIO(gpx_data.encode()),
            mimetype="application/gpx+xml",
            as_attachment=True,
            attachment_filename="all_trips.gpx",
        )

    if fmt == "json":
        return jsonify(all_trips)

    return jsonify({"error": "Invalid export format"}), 400


async def fetch_all_trips_no_filter():
    """
    Fetches ALL trips from:
      - trips_collection
      - uploaded_trips_collection
      - historical_trips_collection
    """
    trips = list(trips_collection.find())
    uploaded_trips = list(uploaded_trips_collection.find())
    historical_trips = list(historical_trips_collection.find())

    return trips + uploaded_trips + historical_trips


@app.route("/api/export/trips")
async def export_trips():
    """
    Provide direct link to exporting in geojson or gpx from an API standpoint.
    This delegates to create_geojson, create_gpx, etc.
    Now fetches from all three collections.
    """
    start_date = request.args.get("start_date")
    end_date = request.args.get("end_date")
    fmt = request.args.get("format")

    ts = await fetch_all_trips(start_date, end_date)

    if fmt == "geojson":
        geojson_data = await create_geojson(ts)
        return await send_file(
            io.BytesIO(geojson_data.encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            attachment_filename="all_trips.geojson",  # Fixed keyword
        )
    if fmt == "gpx":
        gpx_data = await create_gpx(ts)
        return await send_file(
            io.BytesIO(gpx_data.encode()),
            mimetype="application/gpx+xml",
            as_attachment=True,
            attachment_filename="all_trips.gpx",  # Fixed keyword
        )
    # Handle invalid format here
    return jsonify({"error": "Invalid export format"}), 400


async def fetch_all_trips(start_date_str, end_date_str):
    sd = parser.parse(start_date_str)
    ed = parser.parse(end_date_str)
    query = {"startTime": {"$gte": sd, "$lte": ed}}

    # Fetch from all three collections
    trips = list(trips_collection.find(query))
    uploaded_trips = list(uploaded_trips_collection.find(query))
    historical_trips = list(historical_trips_collection.find(query))

    # Combine the results
    all_trips = trips + uploaded_trips + historical_trips
    return all_trips


def fetch_trips(start_date_str, end_date_str):
    sd = parser.parse(start_date_str)
    ed = parser.parse(end_date_str)
    query = {"startTime": {"$gte": sd, "$lte": ed}}
    return list(trips_collection.find(query))


@app.route("/api/export/matched_trips")
async def export_matched_trips():
    """
    Export matched trips in geojson or gpx.
    """
    start_date = request.args.get("start_date")
    end_date = request.args.get("end_date")
    fmt = request.args.get("format")

    ms = await fetch_matched_trips(start_date, end_date)
    if fmt == "geojson":
        fc = await create_geojson(ms)
        return await send_file(
            io.BytesIO(fc.encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            attachment_filename="matched_trips.geojson",  # Fixed keyword
        )
    if fmt == "gpx":
        data = await create_gpx(ms)
        return await send_file(
            io.BytesIO(data.encode()),
            mimetype="application/gpx+xml",
            as_attachment=True,
            attachment_filename="matched_trips.gpx",  # Fixed keyword
        )
    return jsonify({"error": "Invalid export format"}), 400


async def fetch_matched_trips(start_date_str, end_date_str):
    sd = parser.parse(start_date_str)
    ed = parser.parse(end_date_str)
    query = {"startTime": {"$gte": sd, "$lte": ed}}
    return list(matched_trips_collection.find(query))


@app.route("/api/export/streets")
async def export_streets():
    location = request.args.get("location")
    fmt = request.args.get("format")
    if not location:
        return jsonify({"error": "No location param"}), 400

    loc = json.loads(location)
    data, _ = await generate_geojson_osm(loc, streets_only=True)
    if not data:
        return jsonify({"error": "No data returned"}), 500

    if fmt == "geojson":
        return await send_file(
            io.BytesIO(json.dumps(data).encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            attachment_filename="streets.geojson",  # Fixed keyword
        )
    if fmt == "shapefile":
        gdf = gpd.GeoDataFrame.from_features(data["features"])
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            tmp_dir = "inmem_shp"
            if not os.path.exists(tmp_dir):
                os.mkdir(tmp_dir)
            out_path = os.path.join(tmp_dir, "streets.shp")
            gdf.to_file(out_path, driver="ESRI Shapefile")
            for f in os.listdir(tmp_dir):
                with open(os.path.join(tmp_dir, f), "rb") as fh:
                    zf.writestr(f"streets/{f}", fh.read())
            os.rmdir(tmp_dir)
        buf.seek(0)
        return await send_file(
            buf,
            mimetype="application/zip",
            as_attachment=True,
            attachment_filename="streets.zip",  # Fixed keyword
        )
    return jsonify({"error": "Invalid export format"}), 400


@app.route("/api/export/boundary")
async def export_boundary():
    location = request.args.get("location")
    fmt = request.args.get("format")
    if not location:
        return jsonify({"error": "No location"}), 400

    loc = json.loads(location)
    data, _ = await generate_geojson_osm(loc, streets_only=False)
    if not data:
        return jsonify({"error": "No boundary data"}), 500

    if fmt == "geojson":
        return await send_file(
            io.BytesIO(json.dumps(data).encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            attachment_filename="boundary.geojson",  # Fixed keyword
        )
    if fmt == "shapefile":
        gdf = gpd.GeoDataFrame.from_features(data["features"])
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            tmp_dir = "inmem_shp"
            if not os.path.exists(tmp_dir):
                os.mkdir(tmp_dir)
            out_path = os.path.join(tmp_dir, "boundary.shp")
            gdf.to_file(out_path, driver="ESRI Shapefile")
            for f in os.listdir(tmp_dir):
                with open(os.path.join(tmp_dir, f), "rb") as fh:
                    zf.writestr(f"boundary/{f}", fh.read())
            os.rmdir(tmp_dir)
        buf.seek(0)
        return await send_file(
            buf,
            mimetype="application/zip",
            as_attachment=True,
            attachment_filename="boundary.zip",  # Fixed keyword
        )
    return jsonify({"error": "Invalid export format"}), 400


# Preprocessing Route


@app.route("/api/preprocess_streets", methods=["POST"])
async def preprocess_streets_route():
    """
    Triggers the preprocessing of street data for a given location.
    Expects JSON payload: {"location": "Waco, TX", "location_type": "city"}
    Updated to call the imported asynchronous function rather than launching a subprocess.
    """
    try:
        data = await request.get_json()
        location_query = data.get("location")
        location_type = data.get("location_type", "city")
        if not location_query:
            return jsonify({"status": "error", "message": "Location is required"}), 400

        validated_location = await validate_location_osm(location_query, location_type)
        if not validated_location:
            return jsonify({"status": "error", "message": "Invalid location"}), 400

        # Launch the new asynchronous preprocess function as a background task.
        asyncio.create_task(async_preprocess_streets(validated_location))
        return jsonify(
            {
                "status": "success",
                "message": f"Street data preprocessing initiated for {validated_location['display_name']}. Check server logs for progress.",
            }
        )
    except Exception as e:
        logger.error(f"Error in preprocess_streets_route: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500


# Street Segment Details Route


@app.route("/api/street_segment/<segment_id>", methods=["GET"])
async def get_street_segment_details(segment_id):
    """
    Returns details for a specific street segment.
    """
    try:
        segment = streets_collection.find_one(
            {"properties.segment_id": segment_id}, {"_id": 0}
        )
        if not segment:
            return jsonify({"status": "error", "message": "Segment not found"}), 404

        return jsonify(segment)

    except Exception as e:
        logger.error(f"Error fetching segment details: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500


# Loading historical data


async def process_historical_trip(trip):
    """Parse times and set start/dest geos."""
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
    """
    Load old historical data from 'olddrivingdata' directory .geojson files.
    """
    all_trips = []
    for filename in glob.glob("olddrivingdata/*.geojson"):
        with open(filename, "r") as f:
            try:
                geojson_data = geojson_module.load(f)
                for feature in geojson_data["features"]:
                    trip = feature["properties"]
                    trip["gps"] = geojson_dumps(feature["geometry"])
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
            except (json.JSONDecodeError, Exception) as e:
                logger.error(f"Error reading {filename}: {e}")

    processed = await asyncio.gather(*(process_historical_trip(t) for t in all_trips))
    inserted_count = 0
    for trip in processed:
        try:
            exists = historical_trips_collection.find_one(
                {"transactionId": trip["transactionId"]}
            )
            if not exists:
                historical_trips_collection.insert_one(trip)
                inserted_count += 1
        except pymongo.errors.PyMongoError as e:
            logger.error(f"Error inserting historical trip: {e}")

    return inserted_count


@app.route("/load_historical_data", methods=["POST"])
async def load_historical_data_endpoint():
    data = await request.get_json()
    start_date = data.get("start_date")
    end_date = data.get("end_date")
    inserted_count = await load_historical_data(start_date, end_date)
    return jsonify(
        {"message": f"Loaded historical data. Inserted {inserted_count} new trips."}
    )


# Last trip point


@app.route("/api/last_trip_point")
async def get_last_trip_point():
    """
    Return the last coordinate of the most recent trip for live tracking map init.
    """
    try:
        most_recent = trips_collection.find_one(
            sort=[("endTime", pymongo.DESCENDING)])
        if not most_recent:
            return jsonify({"lastPoint": None})
        gps_data = most_recent["gps"]
        if isinstance(gps_data, str):
            gps_data = geojson_loads(gps_data)
        if "coordinates" not in gps_data or not gps_data["coordinates"]:
            return jsonify({"lastPoint": None})
        return jsonify({"lastPoint": gps_data["coordinates"][-1]})
    except Exception as e:
        logger.error(f"Error get_last_trip_point: {e}", exc_info=True)
        return jsonify({"error": "Failed to retrieve last trip point"}), 500


# Upload


@app.route("/upload")
async def upload_page():
    return await render_template("upload.html")


@app.route("/api/upload_gpx", methods=["POST"])
async def upload_gpx():
    """
    Accept multi-file upload of GPX or GeoJSON. Insert into uploaded_trips_collection.
    """
    try:
        files = (await request.files).getlist("files[]")
        map_match = (await request.form).get("map_match", "false") == "true"
        if not files:
            return jsonify({"status": "error", "message": "No files found"}), 400

        success_count = 0
        for f in files:
            filename = f.filename.lower()
            if filename.endswith(".gpx"):
                gpx_data = await f.read()
                gpx = gpxpy.parse(gpx_data)
                for track in gpx.tracks:
                    for seg in track.segments:
                        coords = [[p.longitude, p.latitude]
                                  for p in seg.points]
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
                            "imei": "HISTORICAL",  # or something if needed
                        }
                        await process_and_store_trip(trip)
                        success_count += 1

            elif filename.endswith(".geojson"):
                data_geojson = json.loads(await f.read())
                trips = process_geojson_trip(data_geojson)
                if trips:
                    for t in trips:
                        t["source"] = "upload"
                        t["filename"] = f.filename
                        await process_and_store_trip(t)
                        success_count += 1
            else:
                logger.warning(
                    f"Skipping unhandled file extension: {filename}")

        return jsonify(
            {"status": "success", "message": f"{success_count} trips uploaded."}
        )
    except Exception as e:
        logger.error(f"Error upload_gpx: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500


def calculate_gpx_distance(coords):
    """Calculate distance in meters from consecutive lon/lat pairs using gpxpy's haversine."""
    dist = 0
    for i in range(len(coords) - 1):
        lon1, lat1 = coords[i]
        lon2, lat2 = coords[i + 1]
        dist += gpxpy.geo.haversine_distance(lat1, lon1, lat2, lon2)
    return dist


def meters_to_miles(m):
    return m * 0.000621371


async def process_and_store_trip(trip, uploaded=[]):
    """
    Insert trip into uploaded_trips_collection with reverse geocode for start/dest.
    """
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

        if isinstance(trip["gps"], dict):
            trip["gps"] = json.dumps(trip["gps"])

        existing = uploaded_trips_collection.find_one(
            {"transactionId": trip["transactionId"]}
        )
        if existing:
            # maybe update geocodes
            updates = {}
            if not existing.get("startLocation") and trip["startLocation"]:
                updates["startLocation"] = trip["startLocation"]
            if not existing.get("destination") and trip["destination"]:
                updates["destination"] = trip["destination"]
            if updates:
                uploaded_trips_collection.update_one(
                    {"transactionId": trip["transactionId"]}, {"$set": updates}
                )
        else:
            uploaded_trips_collection.insert_one(trip)
            uploaded.append(trip)
    except DuplicateKeyError:
        logger.warning(f"Duplicate trip ID {trip['transactionId']}, skipping.")
    except Exception as e:
        logger.error(f"process_and_store_trip error: {e}", exc_info=True)
        raise


def process_geojson_trip(geojson_data):
    """
    Extract trip-like features from a geojson FeatureCollection with 'properties'.
    """
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
            if not (stime and etime):
                # attempt deriving from transaction_id
                pass
            # parse times
            stime_parsed = (
                parser.isoparse(stime) if stime else datetime.now(timezone.utc)
            )
            etime_parsed = parser.isoparse(etime) if etime else stime_parsed

            trip = {
                "transactionId": tid,
                "startTime": stime_parsed,
                "endTime": etime_parsed,
                "gps": json.dumps(
                    {
                        "type": geom["type"],
                        "coordinates": geom["coordinates"],
                    }
                ),
                "distance": calculate_distance(geom["coordinates"]),
                "imei": "HISTORICAL",
            }
            trips.append(trip)
        return trips
    except Exception as e:
        logger.error(f"Error in process_geojson_trip: {e}", exc_info=True)
        return None


def calculate_distance(lat1, lon1, lat2, lon2):
    """
    Calculate the distance between two points in miles using the Haversine formula.
    """
    R = 3958.8
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = (
        sin(dlat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    )
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return R * c


# Manage uploaded trips


@app.route("/api/uploaded_trips")
async def get_uploaded_trips():
    """
    Return all uploaded trips.
    """
    try:
        ups = list(uploaded_trips_collection.find())
        for u in ups:
            u["_id"] = str(u["_id"])
            if isinstance(u["startTime"], datetime):
                u["startTime"] = u["startTime"].isoformat()
            if isinstance(u["endTime"], datetime):
                u["endTime"] = u["endTime"].isoformat()
        return jsonify({"status": "success", "trips": ups})
    except Exception as e:
        logger.error(f"Error get_uploaded_trips: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/uploaded_trips/<trip_id>", methods=["DELETE"])
async def delete_uploaded_trip(trip_id):
    """
    Delete a single uploaded trip by its DB _id.
    """
    try:
        result = uploaded_trips_collection.delete_one(
            {"_id": ObjectId(trip_id)})
        if result.deleted_count == 1:
            return jsonify({"status": "success", "message": "Trip deleted"})
        return jsonify({"status": "error", "message": "Not found"}), 404
    except Exception as e:
        logger.error(f"Error deleting uploaded trip: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/uploaded_trips/bulk_delete", methods=["DELETE"])
async def bulk_delete_uploaded_trips():
    """
    Delete multiple uploaded trips by their DB _id or transactionId. Also remove matched trips.
    """
    try:
        data = await request.get_json()
        trip_ids = data.get("trip_ids", [])
        if not trip_ids:
            return jsonify({"status": "error", "message": "No trip IDs"}), 400

        # validate
        valid_ids = []
        for tid in trip_ids:
            try:
                valid_ids.append(ObjectId(tid))
            except:
                pass

        if not valid_ids:
            return jsonify({"status": "error", "message": "No valid IDs"}), 400

        ups_to_delete = list(
            uploaded_trips_collection.find({"_id": {"$in": valid_ids}})
        )
        trans_ids = [u["transactionId"] for u in ups_to_delete]

        del_res = uploaded_trips_collection.delete_many(
            {"_id": {"$in": valid_ids}})

        matched_del = 0
        if trans_ids:
            matched_del_res = matched_trips_collection.delete_many(
                {"transactionId": {"$in": trans_ids}}
            )
            matched_del = matched_del_res.deleted_count

        return jsonify(
            {
                "status": "success",
                "deleted_uploaded_trips": del_res.deleted_count,
                "deleted_matched_trips": matched_del,
            }
        )
    except Exception as e:
        logger.error(
            f"Error in bulk_delete_uploaded_trips: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500


# Places


@app.route("/api/places", methods=["GET", "POST"])
async def handle_places():
    """
    GET: Return all places
    POST: Insert new place
    """
    if request.method == "GET":
        pls = list(places_collection.find())
        return jsonify(
            [{"_id": str(p["_id"]), **CustomPlace.from_dict(p).to_dict()}
             for p in pls]
        )
    data = await request.get_json()
    place = CustomPlace(data["name"], data["geometry"])
    r = places_collection.insert_one(place.to_dict())
    return jsonify({"_id": str(r.inserted_id), **place.to_dict()})


@app.route("/api/places/<place_id>", methods=["DELETE"])
async def delete_place(place_id):
    places_collection.delete_one({"_id": ObjectId(place_id)})
    return "", 204


@app.route("/api/places/<place_id>/statistics")
async def get_place_statistics(place_id):
    """
    Calculate how many times the user ended a trip at that place,
    along with duration of stay and time since last visit.
    """
    try:
        p = places_collection.find_one({"_id": ObjectId(place_id)})
        if not p:
            return jsonify({"error": "Place not found"}), 404
        query = {
            "$or": [
                {"destinationPlaceId": place_id},
                {"destinationGeoPoint": {
                    "$geoWithin": {"$geometry": p["geometry"]}}},
            ],
            "endTime": {"$ne": None},
        }

        valid_trips = []
        for coll in [
            trips_collection,
            historical_trips_collection,
            uploaded_trips_collection,
        ]:
            cursor = coll.find(query)
            for trip in cursor:
                # Make sure endTime is valid
                end_t = trip.get("endTime")
                if end_t and isinstance(end_t, datetime):
                    valid_trips.append(trip)

        # Sort all those trips strictly by endTime ascending:
        valid_trips.sort(key=lambda x: x["endTime"])

        visits = []
        durations = []
        time_since_last_visits = []
        first_visit = None
        last_visit = None
        current_time = datetime.now(timezone.utc)

        for i, t in enumerate(valid_trips):
            try:
                # Ensure endTime is tz-aware
                t_end = t["endTime"]
                if t_end.tzinfo is None:
                    t_end = t_end.replace(tzinfo=timezone.utc)

                # Set first/last visit
                if first_visit is None:
                    first_visit = t_end
                last_visit = t_end

                if i < len(valid_trips) - 1:
                    next_trip = valid_trips[i + 1]
                    # Check if next_trip started at the same place:
                    # a) check placeId if present:
                    same_place = False
                    if (
                        "startPlaceId" in next_trip
                        and next_trip["startPlaceId"] == place_id
                    ):
                        same_place = True
                    else:
                        # or fallback geospatial check if startGeoPoint is inside p["geometry"]
                        start_pt = next_trip.get("startGeoPoint")
                        if (
                            start_pt
                            and isinstance(start_pt, dict)
                            and "coordinates" in start_pt
                        ):
                            place_shape = shape(p["geometry"])
                            start_shape = shape(start_pt)
                            if place_shape.contains(start_shape):
                                same_place = True

                    if same_place:
                        next_start = next_trip.get("startTime")
                        if next_start and isinstance(next_start, datetime):
                            if next_start.tzinfo is None:
                                next_start = next_start.replace(
                                    tzinfo=timezone.utc)
                            duration_minutes = (
                                next_start - t_end
                            ).total_seconds() / 60.0
                            if duration_minutes > 0:
                                durations.append(duration_minutes)

                else:
                    pass

                if i > 0:
                    prev_trip = valid_trips[i - 1]
                    prev_end = prev_trip.get("endTime")
                    if prev_end and isinstance(prev_end, datetime):
                        if prev_end.tzinfo is None:
                            prev_end = prev_end.replace(tzinfo=timezone.utc)
                        hrs_since_last = (
                            t_end - prev_end).total_seconds() / 3600.0
                        if hrs_since_last >= 0:
                            time_since_last_visits.append(hrs_since_last)

                # Collect durations array for "visits"
                visits.append(t_end)
            except Exception as ex:
                logger.error(
                    f"Issue processing a trip in get_place_statistics for place {place_id}: {ex}",
                    exc_info=True,
                )
                continue

        total_visits = len(visits)

        # *** The big fix: durations are only from consecutive "end@place" => "start@place" pairs. ***
        avg_duration = sum(durations) / len(durations) if durations else 0

        # Convert to an h:mm string:
        def format_h_m(m):
            # m is total minutes
            hh = int(m // 60)
            mm = int(m % 60)
            return f"{hh}h {mm:02d}m"

        avg_duration_str = format_h_m(
            avg_duration) if avg_duration > 0 else "0h 00m"

        avg_time_since_last = (
            sum(time_since_last_visits) / len(time_since_last_visits)
            if time_since_last_visits
            else 0
        )

        return jsonify(
            {
                "totalVisits": total_visits,
                "averageTimeSpent": avg_duration_str,
                "firstVisit": first_visit.isoformat() if first_visit else None,
                "lastVisit": last_visit.isoformat() if last_visit else None,
                "averageTimeSinceLastVisit": avg_time_since_last,
                "name": p["name"],
            }
        )

    except Exception as e:
        logger.error(f"Error place stats {place_id}: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


@app.route("/api/places/<place_id>/trips")
async def get_trips_for_place(place_id):
    """
    Returns a list of trips that *ended* at the specified place,
    including the new, corrected 'duration of stay' logic.

    We do not artificially compute "duration" from each trip to the next
    unless the *next trip* also starts at the same place. But the main
    summary is in get_place_statistics. This route simply returns the
    trip list for UI display.
    """
    try:
        place = places_collection.find_one({"_id": ObjectId(place_id)})
        if not place:
            return jsonify({"error": "Place not found"}), 404

        # Gather from all trip collections, only those that ended at this place
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
        for coll in [
            trips_collection,
            historical_trips_collection,
            uploaded_trips_collection,
        ]:
            for trip in coll.find(query):
                end_t = trip.get("endTime")
                if end_t and isinstance(end_t, datetime):
                    valid_trips.append(trip)

        # Sort by endTime
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
                    # fallback geometry check
                    start_pt = next_trip.get("startGeoPoint")
                    if (
                        start_pt
                        and isinstance(start_pt, dict)
                        and "coordinates" in start_pt
                    ):
                        place_shape = shape(place["geometry"])
                        start_shape = shape(start_pt)
                        if place_shape.contains(start_shape):
                            same_place = True

                if same_place:
                    next_start = next_trip.get("startTime")
                    if next_start and isinstance(next_start, datetime):
                        if next_start.tzinfo is None:
                            next_start = next_start.replace(
                                tzinfo=timezone.utc)
                        duration_minutes = (
                            next_start - end_time
                        ).total_seconds() / 60.0
                        # Format h:mm
                        hh = int(duration_minutes // 60)
                        mm = int(duration_minutes % 60)
                        duration_str = f"{hh}h {mm:02d}m"
                    else:
                        duration_str = "0h 00m"
                else:
                    duration_str = (
                        "0h 00m"  # Next trip not from same place => time spent 0
                    )
            else:
                # no next trip => skip or measure 0
                duration_str = "0h 00m"

            # Compute time since last visit if i>0
            if i > 0:
                prev_trip_end = valid_trips[i - 1]["endTime"]
                if prev_trip_end and isinstance(prev_trip_end, datetime):
                    if prev_trip_end.tzinfo is None:
                        prev_trip_end = prev_trip_end.replace(
                            tzinfo=timezone.utc)
                    hrs_since_last = (
                        end_time - prev_trip_end).total_seconds() / 3600.0
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

        return jsonify(trips_data)

    except Exception as e:
        logger.error(
            f"Error fetching trips for place {place_id}: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


@app.route("/api/non_custom_places_visits")
async def get_non_custom_places_visits():
    """
    Returns visit statistics for places that are NOT custom places (i.e., geocoded destinations).
    """
    try:
        # Use aggregation to find frequent destinations that are not custom places
        pipeline = [
            # Destination exists, but not a custom place
            {"$match": {"destination": {"$ne": None}, "destinationPlaceId": None}},
            {
                "$group": {
                    "_id": "$destination",
                    "totalVisits": {"$sum": 1},
                    "firstVisit": {"$min": "$endTime"},
                    "lastVisit": {"$max": "$endTime"},
                }
            },
            # Only include places visited at least 5 times (you can adjust this)
            {"$match": {"totalVisits": {"$gte": 5}}},
            {"$sort": {"totalVisits": -1}},
        ]

        # Combine results from all three collections
        all_trips = (
            list(trips_collection.aggregate(pipeline))
            + list(historical_trips_collection.aggregate(pipeline))
            + list(uploaded_trips_collection.aggregate(pipeline))
        )

        # Process the results to match the expected format
        visits_data = []
        for doc in all_trips:
            visits_data.append(
                {
                    "name": doc["_id"],
                    "totalVisits": doc["totalVisits"],
                    "firstVisit": (
                        doc["firstVisit"].isoformat(
                        ) if doc["firstVisit"] else None
                    ),
                    "lastVisit": (
                        doc["lastVisit"].isoformat(
                        ) if doc["lastVisit"] else None
                    ),
                }
            )

        return jsonify(visits_data)

    except Exception as e:
        logger.error(
            f"Error fetching non-custom place visits: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


@app.route("/api/trip-analytics")
async def get_trip_analytics():
    """
    Demo: Return daily distances & time distribution for charting.
    """
    start_date_str = request.args.get("start_date")
    end_date_str = request.args.get("end_date")

    if not start_date_str or not end_date_str:
        return jsonify({"error": "Missing date range"}), 400

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

        results = list(trips_collection.aggregate(pipeline))
        return jsonify(
            {
                "daily_distances": organize_daily_data(results),
                "time_distribution": organize_hourly_data(results),
            }
        )
    except Exception as e:
        logger.error(f"Error trip analytics: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


def organize_daily_data(results):
    daily_data = {}
    for r in results:
        date = r["_id"]["date"]
        if date not in daily_data:
            daily_data[date] = {"distance": 0, "count": 0}
        daily_data[date]["distance"] += r["totalDistance"]
        daily_data[date]["count"] += r["tripCount"]
    # convert to list
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


# Bouncie webhook for real-time


@app.route("/stream")
async def stream():
    async def event_stream():
        try:
            # Immediately notify the client of a successful connection.
            yield ('data: {"type": "connected"}\n\n').encode("utf-8")
            while True:
                try:
                    active_trip = live_trips_collection.find_one(
                        {"status": "active"})
                    if active_trip:
                        # Convert any datetime in coordinates to ISO strings.
                        for c in active_trip.get("coordinates", []):
                            ts = c.get("timestamp")
                            if isinstance(ts, datetime):
                                c["timestamp"] = ts.isoformat()
                        data = {
                            "type": "trip_update",
                            "data": {
                                "transactionId": active_trip["transactionId"],
                                "coordinates": active_trip.get("coordinates", []),
                            },
                        }
                        yield (f"data: {json.dumps(data)}\n\n").encode("utf-8")
                    else:
                        yield ('data: {"type": "heartbeat"}\n\n').encode("utf-8")
                    await asyncio.sleep(1)
                except asyncio.CancelledError:
                    # If the client disconnects, this exception is raised.
                    logger.info("Stream cancelled (client disconnected).")
                    break
                except Exception as loop_err:
                    logger.error(
                        f"Error in event stream loop: {loop_err}", exc_info=True
                    )
                    yield (
                        'data: {"type": "error", "message": "Internal error"}\n\n'
                    ).encode("utf-8")
                    await asyncio.sleep(1)
        except asyncio.CancelledError:
            logger.info("Stream cancelled (client disconnected).")
        except Exception as e:
            logger.error(f"Error in event stream: {e}", exc_info=True)
            yield ('data: {"type": "error", "message": "Stream error"}\n\n').encode(
                "utf-8"
            )

    response = Response(event_stream(), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Connection"] = "keep-alive"
    response.headers["X-Accel-Buffering"] = "no"
    return response


@app.route("/webhook/bouncie", methods=["POST"])
async def bouncie_webhook():
    """
    Handles incoming Bouncie webhook events and updates/stores trip data.
    Uses Bouncie’s timestamps instead of `now_utc`.
    """
    try:
        data = await request.get_json()
        event_type = data.get("eventType")
        if not event_type:
            return jsonify({"error": "Missing eventType"}), 400

        transaction_id = data.get("transactionId")

        if event_type in ("tripStart", "tripData", "tripEnd") and not transaction_id:
            return jsonify({"error": "Missing transactionId for trip event"}), 400

        if event_type == "tripStart":
            start_time, _ = get_trip_timestamps(data)

            # Ensure no active trip is left behind
            live_trips_collection.delete_many(
                {"transactionId": transaction_id, "status": "active"}
            )

            live_trips_collection.insert_one(
                {
                    "transactionId": transaction_id,
                    "status": "active",
                    "startTime": start_time,
                    "coordinates": [],
                    "lastUpdate": start_time,
                }
            )

        elif event_type == "tripData":
            trip_doc = live_trips_collection.find_one(
                {"transactionId": transaction_id, "status": "active"}
            )
            if not trip_doc:
                live_trips_collection.insert_one(
                    {
                        "transactionId": transaction_id,
                        "status": "active",
                        "startTime": datetime.now(
                            timezone.utc
                        ),  # Fallback if tripStart was never received
                        "coordinates": [],
                        "lastUpdate": datetime.now(timezone.utc),
                    }
                )
                trip_doc = live_trips_collection.find_one(
                    {"transactionId": transaction_id, "status": "active"}
                )

            if "data" in data:
                new_coords = sort_and_filter_trip_coordinates(data["data"])
                all_coords = trip_doc.get("coordinates", []) + new_coords
                all_coords.sort(key=lambda c: c["timestamp"])

                live_trips_collection.update_one(
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
            start_time, end_time = get_trip_timestamps(data)

            trip = live_trips_collection.find_one(
                {"transactionId": transaction_id})
            if trip:
                trip["endTime"] = end_time
                trip["status"] = "completed"
                archived_live_trips_collection.insert_one(trip)
                live_trips_collection.delete_one({"_id": trip["_id"]})

        return jsonify({"status": "success"}), 200

    except Exception as e:
        logger.error(f"Error in bouncie_webhook: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/active_trip")
async def get_active_trip():
    try:
        active_trip = live_trips_collection.find_one({"status": "active"})
        if active_trip:
            # Convert ObjectId and datetime fields to string for JSON serialization
            active_trip["_id"] = str(active_trip["_id"])
            if isinstance(active_trip.get("startTime"), datetime):
                active_trip["startTime"] = active_trip["startTime"].isoformat()
            if isinstance(active_trip.get("lastUpdate"), datetime):
                active_trip["lastUpdate"] = active_trip["lastUpdate"].isoformat()
            return jsonify(active_trip)
        return jsonify({}), 404
    except Exception as e:
        logger.error(f"Error retrieving active trip: {e}", exc_info=True)
        return jsonify({"error": "Internal Server Error"}), 500


# DB helpers


def get_trip_from_db(trip_id):
    try:
        t = trips_collection.find_one({"transactionId": trip_id})
        if not t:
            logger.warning(f"Trip {trip_id} not found in DB")
            return None
        if "gps" not in t:
            logger.error(f"Trip {trip_id} missing GPS")
            return None
        if isinstance(t["gps"], str):
            try:
                t["gps"] = json.loads(t["gps"])
            except:
                logger.error(f"Failed to parse gps for {trip_id}")
                return None
        return t
    except Exception as e:
        logger.error(f"Error retrieving trip {trip_id}: {e}", exc_info=True)
        return None


def store_trip(trip):
    """
    Stores a trip in the trips_collection, with enhanced logging.
    """
    transaction_id = trip.get(
        "transactionId", "?")  # Get transaction ID safely
    # Log function entry
    logger.info(f"Storing trip {transaction_id} in trips_collection...")

    ok, msg = validate_trip_data(trip)
    if not ok:
        # Log validation failure
        logger.error(
            f"Trip data validation failed for trip {transaction_id}: {msg}")
        return False
    # Log validation success
    logger.debug(f"Trip data validation passed for trip {transaction_id}.")

    if isinstance(trip["gps"], dict):
        # Log GPS conversion
        logger.debug(
            f"Converting gps data to JSON string for trip {transaction_id}.")
        trip["gps"] = json.dumps(trip["gps"])

    for field in ["startTime", "endTime"]:
        if isinstance(trip[field], str):
            # Log time parsing
            logger.debug(
                f"Parsing {field} from string for trip {transaction_id}.")
            trip[field] = parser.isoparse(trip[field])

    update_data = {
        "$set": {
            **trip,
            "startPlaceId": trip.get("startPlaceId"),
            "destinationPlaceId": trip.get("destinationPlaceId"),
        }
    }

    try:
        result = trips_collection.update_one(
            {"transactionId": trip["transactionId"]}, update_data, upsert=True
        )
        # Log successful storage with details
        logger.info(
            f"Stored trip {trip['transactionId']} successfully. Modified count: {result.modified_count}, Upserted: {result.upserted_id is not None}"
        )
        return True
    except Exception as e:
        # Log trip storage errors
        logger.error(
            f"Error storing trip {trip['transactionId']}: {e}", exc_info=True)
        return False


async def assemble_trip_from_realtime_data(realtime_trip_data):
    """
    Assembles a complete trip object from a list of realtime data events, with enhanced logging.
    """
    logger.info("Assembling trip from realtime data...")  # Log function entry
    if not realtime_trip_data:
        # Log empty data
        logger.warning(
            "Realtime trip data list is empty, cannot assemble trip.")
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
        logger.error(
            "Missing tripStart event in realtime data, cannot assemble trip.")
        return None
    if not trip_end_event:
        # Log missing end event
        logger.error(
            "Missing tripEnd event in realtime data, cannot assemble trip.")
        return None

    start_time = parser.isoparse(
        trip_start_event["data"]["start"]["timestamp"])
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
    logger.debug(
        f"Extracted {len(all_coords)} coordinates from tripData events.")

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
        # Initialize, can be updated from metrics if available later
        "hardAccelerationCount": 0,
    }

    # Log trip object assembled
    logger.debug(f"Assembled trip object with transactionId: {transaction_id}")

    # Use existing processing for geocoding etc.
    processed_trip = await process_trip_data(trip)

    # Log function completion
    logger.info(
        f"Trip assembly completed for transactionId: {transaction_id}.")
    return processed_trip


async def process_trip_data(trip):
    """
    Processes a trip’s geocoding data. For both the start and destination points:
      - If the point falls within a defined custom place, assign the custom place’s name.
      - Otherwise, call reverse_geocode_nominatim and extract its "display_name".
    Also sets the geo point fields for geospatial queries.

    This fixes the error where, if not in a custom place, the full geocoding response
    (an object) was being assigned rather than its "display_name".
    """
    transaction_id = trip.get("transactionId", "?")
    logger.info(f"Processing trip data for trip {transaction_id}...")
    try:
        gps_data = trip.get("gps")
        if not gps_data:
            logger.warning(
                f"Trip {transaction_id} has no GPS data to process.")
            return trip

        # If GPS data is a string, parse it into a dict.
        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
            except Exception as e:
                logger.error(
                    f"Error parsing GPS data for trip {transaction_id}: {e}",
                    exc_info=True,
                )
                return trip
        # Update the trip's GPS data
        trip["gps"] = gps_data

        if not gps_data.get("coordinates"):
            logger.warning(
                f"Trip {transaction_id} has no coordinates in GPS data.")
            return trip

        # Extract the first (start) and last (end) coordinates
        st = gps_data["coordinates"][0]
        en = gps_data["coordinates"][-1]

        start_point = Point(st[0], st[1])
        end_point = Point(en[0], en[1])
        logger.debug(
            f"Extracted start point: {st}, end point: {en} for trip {transaction_id}"
        )

        # Check if the start point falls within a custom place.
        start_place = get_place_at_point(start_point)
        if start_place:
            trip["startLocation"] = start_place["name"]
            trip["startPlaceId"] = str(start_place.get("_id", ""))
            logger.debug(
                f"Start point of trip {transaction_id} is within custom place: {start_place['name']}"
            )
        else:
            # Otherwise, use reverse geocoding and extract "display_name"
            geocode_data = await reverse_geocode_nominatim(st[1], st[0])
            start_location = ""
            if geocode_data and isinstance(geocode_data, dict):
                start_location = geocode_data.get("display_name", "")
            trip["startLocation"] = start_location
            logger.debug(
                f"Start point of trip {transaction_id} reverse geocoded to: {start_location}"
            )

        # Check if the end point falls within a custom place.
        end_place = get_place_at_point(end_point)
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
        trip["startGeoPoint"] = {
            "type": "Point", "coordinates": [st[0], st[1]]}
        trip["destinationGeoPoint"] = {
            "type": "Point", "coordinates": [en[0], en[1]]}

        logger.debug(f"GeoPoints set for trip {transaction_id}.")
        logger.info(
            f"Trip data processing completed for trip {transaction_id}.")
        return trip

    except Exception as e:
        logger.error(
            f"Error in process_trip_data for trip {transaction_id}: {e}", exc_info=True
        )
        return trip


@app.route("/update_geo_points", methods=["POST"])
async def update_geo_points_route():
    """
    Update GeoPoints for a given collection.
    """
    collection_name = (await request.get_json()).get("collection")
    if collection_name not in ["trips", "historical_trips", "uploaded_trips"]:
        return jsonify({"message": "Invalid collection name"}), 400

    # Map collection name to actual collection object
    if collection_name == "trips":
        collection = trips_collection
    elif collection_name == "historical_trips":
        collection = historical_trips_collection
    elif collection_name == "uploaded_trips":
        collection = uploaded_trips_collection

    try:
        await update_geo_points(collection)
        return jsonify({"message": f"GeoPoints updated for {collection_name}"})
    except Exception as e:
        # Log endpoint errors
        logger.error(f"Error in update_geo_points_route: {e}", exc_info=True)
        return jsonify({"message": f"Error updating GeoPoints: {e}"}), 500


@app.route("/api/regeocode_all_trips", methods=["POST"])
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
            # Iterate synchronously using regular for loop
            for trip in collection.find({}):
                await process_trip_data(trip)  # Still await the async function
                collection.replace_one({"_id": trip["_id"]}, trip)

        return jsonify({"message": "All trips re-geocoded successfully."})
    except Exception as e:
        logger.error(f"Error in regeocode_all_trips: {e}", exc_info=True)
        return jsonify({"message": f"Error re-geocoding trips: {e}"}), 500


def get_place_at_point(point):
    """
    Find a custom place that contains the given point.
    """
    places = list(places_collection.find({}))
    for p in places:
        place_shape = shape(p["geometry"])
        if place_shape.contains(point):
            return p
    return None


# Earliest trip date


@app.route("/api/first_trip_date")
async def get_first_trip_date():
    """
    Return earliest startTime across trips, uploaded, historical.
    """
    try:
        reg = trips_collection.find_one({}, sort=[("startTime", 1)])
        upl = uploaded_trips_collection.find_one({}, sort=[("startTime", 1)])
        hist = historical_trips_collection.find_one(
            {}, sort=[("startTime", 1)])

        candidates = []
        if reg and reg.get("startTime"):
            candidates.append(reg["startTime"])
        if upl and upl.get("startTime"):
            candidates.append(upl["startTime"])
        if hist and hist.get("startTime"):
            candidates.append(hist["startTime"])

        if not candidates:
            dnow = datetime.now(timezone.utc)
            return jsonify({"first_trip_date": dnow.isoformat()})
        best = min(candidates)
        if best.tzinfo is None:
            best = best.replace(tzinfo=timezone.utc)
        return jsonify({"first_trip_date": best.isoformat()})
    except Exception as e:
        logger.error(f"get_first_trip_date err: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


# Error handlers


@app.errorhandler(404)
async def not_found_error(error):
    return jsonify({"error": "Endpoint not found"}), 404


@app.errorhandler(500)
async def internal_error(error):
    return jsonify({"error": "Internal server error"}), 500


# Bulk delete


@app.route("/api/trips/bulk_delete", methods=["DELETE"])
async def bulk_delete_trips():
    """
    Let user delete multiple trip docs by transactionId.
    """
    try:
        data = await request.get_json()
        trip_ids = data.get("trip_ids", [])
        if not trip_ids:
            return jsonify({"status": "error", "message": "No trip IDs"}), 400

        res = trips_collection.delete_many(
            {"transactionId": {"$in": trip_ids}})
        matched_trips_collection.delete_many(
            {"original_trip_id": {"$in": trip_ids}})

        return jsonify(
            {
                "status": "success",
                "message": f"Deleted {res.deleted_count} trips",
                "deleted_count": res.deleted_count,
            }
        )
    except Exception as e:
        logger.error(f"bulk_delete_trips: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500


# GeoJSON trip from .geojson


def process_gpx(gpx):
    """
    Convert gpx object to a list of trip dicts
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


@app.route("/edit_trips")
async def edit_trips_page():
    """Renders the edit trips page."""
    return await render_template("edit_trips.html")


@app.route("/api/edit_trips", methods=["GET"])
async def get_edit_trips():
    """
    Return a list of trips for editing.
    """
    try:
        start_date = request.args.get("start_date")
        end_date = request.args.get("end_date")
        ttype = request.args.get("type")

        if ttype == "trips":
            coll = trips_collection
        elif ttype == "matched_trips":
            coll = matched_trips_collection
        else:
            return jsonify({"status": "error", "message": "Invalid trip type"}), 400

        sd = datetime.fromisoformat(start_date)
        ed = datetime.fromisoformat(end_date)
        query = {"startTime": {"$gte": sd, "$lte": ed}}
        docs = list(coll.find(query))
        for d in docs:
            d["_id"] = str(d["_id"])
        return jsonify({"status": "success", "trips": docs}), 200
    except Exception as e:
        logger.error(f"Error fetching trips for editing: {e}", exc_info=True)
        return jsonify({"status": "error", "message": "Internal server error"}), 500


@app.route("/api/trips/refresh_geocoding", methods=["POST"])
async def refresh_geocoding_for_trips():
    """
    Refreshes geocoding for selected trips.
    """
    data = await request.get_json()
    trip_ids = data.get("trip_ids", [])

    updated_count = 0
    for trip_id in trip_ids:
        trip = trips_collection.find_one({"transactionId": trip_id})
        if trip:
            updated_trip = await process_trip_data(trip)
            trips_collection.replace_one({"_id": trip["_id"]}, updated_trip)
            updated_count += 1

    return (
        jsonify(
            {
                "message": f"Geocoding refreshed for {updated_count} trips.",
                "updated_count": updated_count,
            }
        ),
        200,
    )


@app.route("/api/upload", methods=["POST"])
async def upload_files():
    """
    Alternate endpoint for uploading multiple GPX/GeoJSON files.
    Similar to /api/upload_gpx.
    """
    try:
        files = await request.files.getlist("files[]")
        count = 0
        up = []
        for f in files:
            if f.filename.endswith(".gpx"):
                gpx = gpxpy.parse(await f.read())
                gtrips = process_gpx(gpx)
                for t in gtrips:
                    await process_and_store_trip(t, up)
                    count += 1
            elif f.filename.endswith(".geojson"):
                data = json.load(await f.read())
                trips = process_geojson_trip(data)
                if trips:
                    for t in trips:
                        await process_and_store_trip(t, up)
                        count += 1
        return jsonify({"status": "success", "message": f"Processed {count} trips"})
    except Exception as e:
        logger.error(f"Error uploading: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500


def validate_trip_update(data):
    try:
        for p in data["points"]:
            lat = p.get("lat")
            lon = p.get("lon")
            if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
                return (False, "Out of range lat/lon")
        return (True, "")
    except:
        return (False, "Invalid data format")


@app.route("/api/trips/<trip_id>", methods=["PUT"])
async def update_trip(trip_id):
    """
    Generic update of a trip (regular or matched).
    """
    try:
        data = await request.get_json()
        ttype = data.get("type")
        geometry = data.get("geometry")
        props = data.get("properties", {})

        if ttype == "matched_trips":
            coll = matched_trips_collection
        else:
            coll = trips_collection

        t = coll.find_one(
            {
                "$or": [
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ]
            }
        )
        if not t:
            # maybe it belongs to the other collection
            other_coll = (
                matched_trips_collection
                if ttype != "matched_trips"
                else trips_collection
            )
            t = other_coll.find_one(
                {
                    "$or": [
                        {"transactionId": trip_id},
                        {"transactionId": str(trip_id)},
                    ]
                }
            )
            if t:
                coll = other_coll
        if not t:
            return jsonify({"error": f"No trip found for {trip_id}"}), 404

        update_fields = {"updatedAt": datetime.now(timezone.utc)}
        if geometry and isinstance(geometry, dict):
            gps_data = {"type": "LineString",
                        "coordinates": geometry["coordinates"]}
            update_fields["geometry"] = geometry
            update_fields["gps"] = json.dumps(gps_data)

        if props:
            # parse times
            for f in ["startTime", "endTime"]:
                if f in props and isinstance(props[f], str):
                    try:
                        props[f] = parser.isoparse(props[f])
                    except:
                        pass
            for f in ["distance", "maxSpeed", "totalIdleDuration", "fuelConsumed"]:
                if f in props and props[f] is not None:
                    try:
                        props[f] = float(props[f])
                    except:
                        pass
            if "properties" in t:
                update_fields["properties"] = {**t["properties"], **props}
            else:
                update_fields.update(props)

        r = coll.update_one({"_id": t["_id"]}, {"$set": update_fields})
        if not r.modified_count:
            return jsonify({"error": "No changes"}), 400
        return jsonify({"message": "Trip updated"}), 200
    except Exception as e:
        logger.error(f"Error updating {trip_id}: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


@app.route("/api/trips/<trip_id>", methods=["GET"])
async def get_single_trip(trip_id):
    """
    Return single trip by _id from 'trips_collection'.
    """
    try:
        t = trips_collection.find_one({"_id": ObjectId(trip_id)})
        if not t:
            return jsonify({"status": "error", "message": "Trip not found"}), 404
        t["_id"] = str(t["_id"])
        t["startTime"] = t["startTime"].isoformat()
        t["endTime"] = t["endTime"].isoformat()
        return jsonify({"status": "success", "trip": t}), 200
    except Exception as e:
        logger.error(f"get_single_trip error: {e}", exc_info=True)
        return jsonify({"status": "error", "message": "Internal server error"}), 500


@app.route("/api/trips/<trip_id>", methods=["DELETE"])
async def delete_trip(trip_id):
    """
    Deletes a trip by its ID.
    """
    try:
        # Find the trip in both collections
        trip = trips_collection.find_one({"transactionId": trip_id})
        if not trip:
            trip = matched_trips_collection.find_one(
                {"transactionId": trip_id})
            if not trip:
                return jsonify({"status": "error", "message": "Trip not found"}), 404
            collection = matched_trips_collection
        else:
            collection = trips_collection

        # Delete the trip
        result = collection.delete_one({"transactionId": trip_id})

        if result.deleted_count == 1:
            return (
                jsonify(
                    {"status": "success", "message": "Trip deleted successfully"}),
                200,
            )
        return jsonify({"status": "error", "message": "Failed to delete trip"}), 500
    except Exception as e:
        logger.error(f"Error deleting trip: {e}", exc_info=True)
        return jsonify({"status": "error", "message": "Internal server error"}), 500


@app.route("/api/debug/trip/<trip_id>", methods=["GET"])
async def debug_trip(trip_id):
    """
    Debug helper, check if found in trips or matched_trips, ID mismatch, etc.
    """
    try:
        reg = trips_collection.find_one(
            {
                "$or": [
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ]
            }
        )
        mat = matched_trips_collection.find_one(
            {
                "$or": [
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ]
            }
        )
        return jsonify(
            {
                "regular_trip_found": bool(reg),
                "matched_trip_found": bool(mat),
                "regular_trip_id_field": reg.get("transactionId") if reg else None,
                "matched_trip_id_field": mat.get("transactionId") if mat else None,
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.websocket("/ws/live_trip")
async def ws_live_trip():
    """
    A WebSocket endpoint that continuously sends live trip data.
    Every second, it queries the database for the current active trip and
    sends either a trip update or a heartbeat.
    """
    try:
        while True:
            active_trip = live_trips_collection.find_one({"status": "active"})
            if active_trip:
                # Convert datetime fields to ISO strings for JSON serialization
                if active_trip.get("startTime") and isinstance(
                    active_trip["startTime"], datetime
                ):
                    active_trip["startTime"] = active_trip["startTime"].isoformat()
                if active_trip.get("lastUpdate") and isinstance(
                    active_trip["lastUpdate"], datetime
                ):
                    active_trip["lastUpdate"] = active_trip["lastUpdate"].isoformat()
                # Convert any datetime in coordinates
                if "coordinates" in active_trip:
                    for coord in active_trip["coordinates"]:
                        if "timestamp" in coord and isinstance(
                            coord["timestamp"], datetime
                        ):
                            coord["timestamp"] = coord["timestamp"].isoformat()
                message = {"type": "trip_update", "data": active_trip}
            else:
                message = {"type": "heartbeat"}
            await websocket.send(json.dumps(message))
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        # This exception is raised when the client disconnects.
        logger.info("WebSocket connection cancelled (client disconnected).")
    except Exception as e:
        logger.error(
            "Error in WebSocket endpoint /ws/live_trip: %s", e, exc_info=True)


#   Hook APScheduler into Quart's event loop


@app.before_serving
async def init_background_tasks():
    """
    Ensures APScheduler uses the same event loop as Quart/Uvicorn.
    Starts the scheduler and initializes scheduled tasks.
    """
    loop = asyncio.get_running_loop()
    scheduler.configure(event_loop=loop)
    start_background_tasks()


# Run
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port,
                log_level="info", use_colors=True)
