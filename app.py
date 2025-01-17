import asyncio
import glob
import io
import json
import logging
import math
import os
import traceback
import zipfile
import threading
from datetime import datetime, timedelta, timezone

import aiohttp
import certifi
import geopandas as gpd
import geojson as geojson_module
import gpxpy
import gpxpy.gpx
import pymongo
import pytz
import requests
from aiohttp.client_exceptions import ClientConnectorError, ClientResponseError
from bson import ObjectId
from dateutil import parser
from dotenv import load_dotenv
from shapely.strtree import STRtree
from flask import (
    Flask,
    Response,
    jsonify,
    render_template,
    request,
    send_file,
    session,
)
from flask_socketio import SocketIO, emit
from geojson import dumps as geojson_dumps, loads as geojson_loads
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError
from pyproj import Transformer
from shapely.geometry import (
    LineString,
    MultiLineString,
    MultiPolygon,
    Point,
    Polygon,
    mapping,
    shape,
)
from shapely.ops import linemerge, unary_union, polygonize, transform as shapely_transform
from shapely.errors import TopologicalError
from timezonefinder import TimezoneFinder

# We import the map_matching logic
from map_matching import (
    haversine_distance,
    map_match_coordinates,
    process_and_map_match_trip,
)

load_dotenv()

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "supersecretfallback")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

# Bouncie config
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_CODE = os.getenv("AUTHORIZATION_CODE")
AUTHORIZED_DEVICES = os.getenv("AUTHORIZED_DEVICES", "").split(",")
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"
OVERPASS_URL = "http://overpass-api.de/api/interpreter"

tf = TimezoneFinder()

# For active, real-time trips
active_trips = {}

#############################
# MongoDB Initialization
#############################


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
        logger.info("Connected to MongoDB")
        return client
    except Exception as e:
        logger.error(f"Error connecting to MongoDB: {e}")
        raise


mongo_client = get_mongo_client()
db = mongo_client["every_street"]
trips_collection = db["trips"]
matched_trips_collection = db["matched_trips"]
historical_trips_collection = db["historical_trips"]
uploaded_trips_collection = db["uploaded_trips"]
places_collection = db["places"]

# Ensure some indexes
uploaded_trips_collection.create_index("transactionId", unique=True)
matched_trips_collection.create_index("transactionId", unique=True)

#############################
# Model or helper class
#############################


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

#############################
# Bouncie Authentication
#############################


async def get_access_token(client_session):
    """
    Retrieves an access token from the Bouncie API using OAuth.
    """
    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": AUTH_CODE,
        "redirect_uri": REDIRECT_URI,
    }
    async with client_session.post(AUTH_URL, data=payload) as auth_response:
        if auth_response.status == 200:
            data = await auth_response.json()
            return data.get("access_token")
        logger.error(f"Error retrieving access token: {auth_response.status}")
        return None

#############################
# API calls to Bouncie
#############################


async def get_trips_from_api(client_session, access_token, imei, start_date, end_date):
    """
    Pulls trips from Bouncie's /trips endpoint, for a device IMEI and date range.
    """
    headers = {"Authorization": access_token,
               "Content-Type": "application/json"}
    params = {
        "imei": imei,
        "gps-format": "geojson",
        "starts-after": start_date.isoformat(),
        "ends-before": end_date.isoformat(),
    }
    try:
        async with client_session.get(
            f"{API_BASE_URL}/trips", headers=headers, params=params
        ) as response:
            if response.status == 200:
                trips = await response.json()
                # Attempt localizing times
                for trip in trips:
                    tz_str = get_trip_timezone(trip)
                    timezone_obj = pytz.timezone(tz_str)

                    if "startTime" in trip and isinstance(trip["startTime"], str):
                        parsed = parser.isoparse(trip["startTime"])
                        if parsed.tzinfo is None:
                            parsed = parsed.replace(tzinfo=pytz.UTC)
                        local_time = parsed.astimezone(timezone_obj)
                        trip["startTime"] = local_time
                        trip["timeZone"] = tz_str

                    if "endTime" in trip and isinstance(trip["endTime"], str):
                        parsed = parser.isoparse(trip["endTime"])
                        if parsed.tzinfo is None:
                            parsed = parsed.replace(tzinfo=pytz.UTC)
                        local_time = parsed.astimezone(timezone_obj)
                        trip["endTime"] = local_time

                return trips
            else:
                logger.error(f"Error fetching trips: {response.status}")
                return []
    except Exception as e:
        logger.error(f"Exception in get_trips_from_api: {e}")
        return []


async def fetch_trips_in_intervals(main_session, access_token, imei, start_date, end_date):
    """
    Breaks the date range into 7-day intervals to avoid hitting any Bouncie restrictions.
    """
    all_trips = []
    current_start = start_date.replace(tzinfo=timezone.utc)
    end_date = end_date.replace(tzinfo=timezone.utc)

    while current_start < end_date:
        current_end = min(current_start + timedelta(days=7), end_date)
        trips = await get_trips_from_api(main_session, access_token, imei, current_start, current_end)
        all_trips.extend(trips)
        current_start = current_end

    return all_trips

#############################
# Periodic fetch
#############################


def periodic_fetch_trips():
    """
    Called every X minutes to fetch new trips from Bouncie in the background.
    """
    with app.app_context():
        try:
            last_trip = trips_collection.find_one(sort=[("endTime", -1)])
            start_date = (
                last_trip["endTime"]
                if last_trip
                else datetime.now(timezone.utc) - timedelta(days=7)
            )
            end_date = datetime.now(timezone.utc)
            logger.info(f"Periodic fetch from {start_date} to {end_date}")
            asyncio.run(fetch_and_store_trips_in_range(start_date, end_date))
        except Exception as e:
            logger.error(f"Error in periodic fetch: {e}")
        finally:
            threading.Timer(
                30 * 60, periodic_fetch_trips).start()  # 30 minutes

#############################
# Data Validation
#############################


def validate_trip_data(trip):
    """
    Ensure the trip has transactionId, startTime, endTime, gps, etc. Return (bool_ok, error_message)
    """
    required = ["transactionId", "startTime", "endTime", "gps"]
    for field in required:
        if field not in trip:
            return (False, f"Missing {field}")
    try:
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        if "type" not in gps_data or "coordinates" not in gps_data:
            return (False, "gps data missing 'type' or 'coordinates'")
        if not isinstance(gps_data["coordinates"], list):
            return (False, "gps['coordinates'] must be a list")
    except Exception as e:
        return (False, f"Invalid gps data: {str(e)}")

    return (True, None)

#############################
# Reverse geocode with Nominatim
#############################


async def reverse_geocode_nominatim(lat, lon, retries=3, backoff_factor=1):
    """
    Reverse geocode lat/lon using the OSM Nominatim service. Return display_name or None.
    """
    url = "https://nominatim.openstreetmap.org/reverse"
    params = {
        "format": "jsonv2",
        "lat": lat,
        "lon": lon,
        "zoom": 18,
        "addressdetails": 1,
    }
    headers = {"User-Agent": "EveryStreet/1.0 (your.email@example.com)"}

    for attempt in range(1, retries + 1):
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
                async with session.get(url, params=params, headers=headers) as response:
                    response.raise_for_status()
                    data = await response.json()
                    return data.get("display_name", None)
        except (ClientResponseError, ClientConnectorError, asyncio.TimeoutError) as e:
            logger.error(f"Nominatim error attempt {attempt}: {e}")
            if attempt < retries:
                await asyncio.sleep(backoff_factor * (2 ** (attempt - 1)))

    return None

#############################
#  Fetch for geojson map
#############################


def fetch_trips_for_geojson():
    """
    Returns all trips as a GeoJSON FeatureCollection. 
    Used by e.g. the map for quick visualization.
    """
    trips = trips_collection.find()
    features = []

    for trip in trips:
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

    return geojson_module.FeatureCollection(features)


def get_trip_timezone(trip):
    """
    Simple function that attempts to figure out the timezone for a trip
    by looking at the first coordinate if available, or default 'UTC'.
    """
    try:
        if isinstance(trip["gps"], str):
            gps_data = geojson_loads(trip["gps"])
        else:
            gps_data = trip["gps"]
        coords = gps_data.get("coordinates", [])
        if not coords:
            return "UTC"

        # if it's a Point, just coords
        if gps_data["type"] == "Point":
            lon, lat = coords
        else:
            lon, lat = coords[0]

        tz = tf.timezone_at(lng=lon, lat=lat)
        return tz or "UTC"
    except Exception as e:
        logger.error(f"Error getting trip timezone: {e}")
        return "UTC"

#############################
# Main fetch/store logic
#############################


async def fetch_and_store_trips():
    """
    For all authorized devices, fetch last 4 years of trips from Bouncie,
    store them in the 'trips' collection.
    """
    try:
        async with aiohttp.ClientSession() as client_session:
            access_token = await get_access_token(client_session)
            end_date = datetime.now(timezone.utc)
            start_date = end_date - timedelta(days=365 * 4)

            all_trips = []
            total_devices = len(AUTHORIZED_DEVICES)
            for device_count, imei in enumerate(AUTHORIZED_DEVICES, 1):
                device_trips = await fetch_trips_in_intervals(
                    client_session, access_token, imei, start_date, end_date
                )
                all_trips.extend(device_trips)
                progress = int((device_count / total_devices) * 100)
                socketio.emit("loading_progress", {"progress": progress})

            # Insert or update each trip
            for trip in all_trips:
                try:
                    existing = trips_collection.find_one(
                        {"transactionId": trip["transactionId"]})
                    if existing:
                        continue  # skip

                    # Validate
                    ok, errmsg = validate_trip_data(trip)
                    if not ok:
                        logger.error(
                            f"Skipping invalid trip {trip.get('transactionId')}: {errmsg}")
                        continue

                    # Make sure times are datetime
                    if isinstance(trip["startTime"], str):
                        trip["startTime"] = parser.isoparse(trip["startTime"])
                    if isinstance(trip["endTime"], str):
                        trip["endTime"] = parser.isoparse(trip["endTime"])

                    # Convert gps to string
                    if isinstance(trip["gps"], dict):
                        trip["gps"] = geojson_dumps(trip["gps"])

                    # Add reverse geocode for start/dest
                    gps_data = geojson_loads(trip["gps"])
                    start_pt = gps_data["coordinates"][0]
                    end_pt = gps_data["coordinates"][-1]

                    trip["startGeoPoint"] = start_pt
                    trip["destinationGeoPoint"] = end_pt

                    trip["destination"] = await reverse_geocode_nominatim(end_pt[1], end_pt[0])
                    trip["startLocation"] = await reverse_geocode_nominatim(start_pt[1], start_pt[0])

                    # Upsert
                    trips_collection.update_one(
                        {"transactionId": trip["transactionId"]}, {"$set": trip}, upsert=True
                    )
                except Exception as e:
                    logger.error(
                        f"Error inserting trip {trip.get('transactionId')}: {e}")

    except Exception as e:
        logger.error(f"Error in fetch_and_store_trips: {e}")


def process_trip(trip):
    """
    Simple function to parse times & gps. 
    Possibly used for internal ingestion or conversion.
    """
    try:
        if isinstance(trip["startTime"], str):
            parsed_start = parser.isoparse(trip["startTime"])
            if parsed_start.tzinfo is None:
                parsed_start = parsed_start.replace(tzinfo=timezone.utc)
            trip["startTime"] = parsed_start
        if isinstance(trip["endTime"], str):
            parsed_end = parser.isoparse(trip["endTime"])
            if parsed_end.tzinfo is None:
                parsed_end = parsed_end.replace(tzinfo=timezone.utc)
            trip["endTime"] = parsed_end

        # gps check
        if "gps" not in trip:
            logger.error(f"Trip {trip.get('transactionId')} missing gps")
            return None
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        trip["gps"] = json.dumps(gps_data)

        if not gps_data.get("coordinates"):
            logger.error(
                f"Trip {trip.get('transactionId')} has invalid coords")
            return None

        trip["startGeoPoint"] = gps_data["coordinates"][0]
        trip["destinationGeoPoint"] = gps_data["coordinates"][-1]
        if "distance" in trip:
            try:
                trip["distance"] = float(trip["distance"])
            except (ValueError, TypeError):
                trip["distance"] = 0.0
        else:
            trip["distance"] = 0.0

        return trip
    except Exception as e:
        logger.error(f"Error processing trip {trip.get('transactionId')}: {e}")
        return None

#############################
# Flask endpoints
#############################


@app.route("/")
def index():
    """Renders the main map page."""
    return render_template("index.html")


@app.route("/trips")
def trips_page():
    """Trips listing page."""
    return render_template("trips.html")


@app.route("/driving-insights")
def driving_insights_page():
    """Driving insights page."""
    return render_template("driving_insights.html")


@app.route("/visits")
def visits_page():
    """Custom places visits & stats page."""
    return render_template("visits.html")

#############################
# Loading historical data
#############################


async def process_historical_trip(trip):
    """Parse times and set start/dest geos."""
    trip["startTime"] = parser.isoparse(trip["startTime"]) if isinstance(
        trip["startTime"], str) else trip["startTime"]
    trip["endTime"] = parser.isoparse(trip["endTime"]) if isinstance(
        trip["endTime"], str) else trip["endTime"]
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
                        trip["timestamp"]).replace(tzinfo=timezone.utc)
                    trip["endTime"] = datetime.fromisoformat(
                        trip["end_timestamp"]).replace(tzinfo=timezone.utc)
                    trip["imei"] = "HISTORICAL"
                    trip["transactionId"] = f"HISTORICAL-{trip['timestamp']}"

                    if start_date_str:
                        start_date = datetime.fromisoformat(
                            start_date_str).replace(tzinfo=timezone.utc)
                        if trip["startTime"] < start_date:
                            continue
                    if end_date_str:
                        end_date = datetime.fromisoformat(
                            end_date_str).replace(tzinfo=timezone.utc)
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
                {"transactionId": trip["transactionId"]})
            if not exists:
                historical_trips_collection.insert_one(trip)
                inserted_count += 1
        except pymongo.errors.PyMongoError as e:
            logger.error(f"Error inserting historical trip: {e}")

    return inserted_count


@app.route("/load_historical_data", methods=["POST"])
async def load_historical_data_endpoint():
    """Load historical data route, for older geojson data files."""
    start_date = request.json.get("start_date")
    end_date = request.json.get("end_date")
    inserted_count = await load_historical_data(start_date, end_date)
    return jsonify({"message": f"Loaded historical data. Inserted {inserted_count} new trips."})

#############################
# Core Trip API
#############################


@app.route("/api/trips")
def get_trips():
    """
    Return regular, uploaded, historical trips as combined FeatureCollection.
    """
    start_date_str = request.args.get("start_date")
    end_date_str = request.args.get("end_date")
    imei = request.args.get("imei")

    start_date = datetime.fromisoformat(start_date_str).replace(
        tzinfo=timezone.utc) if start_date_str else None
    end_date = datetime.fromisoformat(end_date_str).replace(
        hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
    ) if end_date_str else None

    query = {}
    if start_date and end_date:
        query["startTime"] = {"$gte": start_date, "$lte": end_date}
    if imei:
        query["imei"] = imei

    regular = list(trips_collection.find(query))
    uploaded = list(uploaded_trips_collection.find(query))
    historical = list(historical_trips_collection.find(query))
    all_trips = regular + uploaded + historical
    features = []

    for trip in all_trips:
        try:
            # make sure times are tz-aware
            if trip["startTime"].tzinfo is None:
                trip["startTime"] = trip["startTime"].replace(
                    tzinfo=timezone.utc)
            if trip["endTime"].tzinfo is None:
                trip["endTime"] = trip["endTime"].replace(tzinfo=timezone.utc)

            geometry = trip["gps"]
            if isinstance(geometry, str):
                geometry = geojson_loads(geometry)

            properties = {
                "transactionId": trip.get("transactionId", "??"),
                "imei": trip.get("imei", "UPLOAD"),
                "startTime": trip["startTime"].astimezone(timezone.utc).isoformat(),
                "endTime": trip["endTime"].astimezone(timezone.utc).isoformat(),
                "distance": float(trip.get("distance", 0)),
                "timeZone": trip.get("timeZone", "America/Chicago"),
                "maxSpeed": float(trip.get("maxSpeed", 0)),
                "startLocation": trip.get("startLocation", "N/A"),
                "destination": trip.get("destination", "N/A"),
                "totalIdleDuration": trip.get("totalIdleDuration", 0),
                "totalIdleDurationFormatted": format_idle_time(trip.get("totalIdleDuration", 0)),
                "fuelConsumed": float(trip.get("fuelConsumed", 0)),
                "source": trip.get("source", "regular"),
                "hardBrakingCount": trip.get("hardBrakingCount"),
                "hardAccelerationCount": trip.get("hardAccelerationCount"),
                "startOdometer": trip.get("startOdometer"),
                "endOdometer": trip.get("endOdometer"),
                "averageSpeed": trip.get("averageSpeed"),
            }

            feature = geojson_module.Feature(
                geometry=geometry, properties=properties)
            features.append(feature)
        except Exception as e:
            logger.error(
                f"Error processing trip {trip.get('transactionId')}: {e}")

    return jsonify(geojson_module.FeatureCollection(features))


def format_idle_time(seconds):
    """
    Convert integer 'seconds' to hh:mm:ss string. 
    """
    if not seconds:
        return "00:00:00"
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"

#############################
# Driving Insights
#############################


@app.route("/api/driving-insights")
def get_driving_insights():
    """
    Summarize total trips, distances, speed, etc. across trips and uploads.
    """
    try:
        start_date_str = request.args.get("start_date")
        end_date_str = request.args.get("end_date")
        imei = request.args.get("imei")

        start_date = datetime.fromisoformat(start_date_str).replace(
            tzinfo=timezone.utc) if start_date_str else None
        end_date = datetime.fromisoformat(end_date_str).replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
        ) if end_date_str else None

        query = {"source": {"$ne": "historical"}}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}
        if imei:
            query["imei"] = imei

        def pipeline_agg(collection):
            return collection.aggregate([
                {"$match": query},
                {
                    "$group": {
                        "_id": None,
                        "total_trips": {"$sum": 1},
                        "total_distance": {"$sum": "$distance"},
                        "total_fuel_consumed": {"$sum": "$fuelConsumed"},
                        "max_speed": {"$max": "$maxSpeed"},
                        "total_idle_duration": {"$sum": "$totalIdleDuration"},
                        "longest_trip_distance": {"$max": "$distance"},
                    }
                },
            ])

        result_trips = list(pipeline_agg(trips_collection))
        result_uploaded = list(pipeline_agg(uploaded_trips_collection))

        # also get top visited place
        def pipeline_most_visited(collection):
            return collection.aggregate([
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
            ])

        result_most_visited_trips = list(
            pipeline_most_visited(trips_collection))
        result_most_visited_uploaded = list(
            pipeline_most_visited(uploaded_trips_collection))

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

        for r in (result_trips + result_uploaded):
            if r:
                combined["total_trips"] += r.get("total_trips", 0)
                combined["total_distance"] += r.get("total_distance", 0)
                combined["total_fuel_consumed"] += r.get(
                    "total_fuel_consumed", 0)
                combined["max_speed"] = max(
                    combined["max_speed"], r.get("max_speed", 0))
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

        return jsonify({
            "total_trips": combined["total_trips"],
            "total_distance": round(combined["total_distance"], 2),
            "total_fuel_consumed": round(combined["total_fuel_consumed"], 2),
            "max_speed": round(combined["max_speed"], 2),
            "total_idle_duration": combined["total_idle_duration"],
            "longest_trip_distance": round(combined["longest_trip_distance"], 2),
            "most_visited": combined["most_visited"],
        })
    except Exception as e:
        logger.error(f"Error in get_driving_insights: {e}")
        return jsonify({"error": str(e)}), 500

#############################
# Additional metrics
#############################


@app.route("/api/metrics")
def get_metrics():
    """
    Example metrics for a date range:
    total trips, distance, average distance, 
    average start time, average driving time, average speed, max speed
    """
    start_date_str = request.args.get("start_date")
    end_date_str = request.args.get("end_date")
    imei = request.args.get("imei")

    start_date = datetime.fromisoformat(start_date_str).replace(
        tzinfo=timezone.utc) if start_date_str else None
    end_date = datetime.fromisoformat(end_date_str).replace(
        hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
    ) if end_date_str else None

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
    driving_times = [(t["endTime"] - t["startTime"]
                      ).total_seconds() / 60.0 for t in all_trips]
    avg_driving_minutes = sum(driving_times) / \
        len(driving_times) if driving_times else 0
    avg_driving_h = int(avg_driving_minutes // 60)
    avg_driving_m = int(avg_driving_minutes % 60)

    total_driving_hours = sum(driving_times) / 60.0 if driving_times else 0
    avg_speed = total_distance / total_driving_hours if total_driving_hours else 0
    max_speed = max((t.get("maxSpeed", 0) for t in all_trips), default=0)

    return jsonify({
        "total_trips": total_trips,
        "total_distance": f"{round(total_distance, 2)}",
        "avg_distance": f"{round(avg_distance, 2)}",
        "avg_start_time": f"{hour:02d}:{minute:02d} {am_pm}",
        "avg_driving_time": f"{avg_driving_h:02d}:{avg_driving_m:02d}",
        "avg_speed": f"{round(avg_speed, 2)}",
        "max_speed": f"{round(max_speed, 2)}",
    })

#############################
# Manual fetch endpoints
#############################


@app.route("/api/fetch_trips", methods=["POST"])
async def api_fetch_trips():
    """Triggers the big fetch from Bouncie for all devices (4 yrs)."""
    try:
        await fetch_and_store_trips()
        return jsonify({"status": "success", "message": "Trips fetched & stored."}), 200
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/fetch_trips_range", methods=["POST"])
def api_fetch_trips_range():
    """Fetch & store trips in a certain date range for all devices."""
    try:
        data = request.json
        start_date = datetime.fromisoformat(
            data["start_date"]).replace(tzinfo=timezone.utc)
        end_date = datetime.fromisoformat(data["end_date"]).replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
        ) + timedelta(days=1)
        asyncio.run(fetch_and_store_trips_in_range(start_date, end_date))
        return jsonify({"status": "success", "message": "Trips fetched & stored."}), 200
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

#############################
# After request
#############################


@app.after_request
def add_header(response):
    """
    Add no-cache headers. 
    """
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

#############################
# Exports
#############################


@app.route("/export/geojson")
def export_geojson():
    """
    Exports a range of trips as GeoJSON. 
    """
    try:
        start_date_str = request.args.get("start_date")
        end_date_str = request.args.get("end_date")
        imei = request.args.get("imei")

        start_date = datetime.strptime(
            start_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc) if start_date_str else None
        end_date = datetime.strptime(end_date_str, "%Y-%m-%d").replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
        ) if end_date_str else None

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
        logger.error(f"Error exporting GeoJSON: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/export/gpx")
def export_gpx():
    """
    Exports a range of trips as GPX.
    """
    try:
        start_date_str = request.args.get("start_date")
        end_date_str = request.args.get("end_date")
        imei = request.args.get("imei")

        start_date = datetime.strptime(
            start_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc) if start_date_str else None
        end_date = datetime.strptime(end_date_str, "%Y-%m-%d").replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
        ) if end_date_str else None

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
            track.description = f"Trip from {t.get('startLocation')} to {t.get('destination')}"

        gpx_xml = gpx.to_xml()
        return Response(
            gpx_xml,
            mimetype="application/gpx+xml",
            headers={"Content-Disposition": "attachment;filename=trips.gpx"},
        )
    except Exception as e:
        logger.error(f"Error exporting gpx: {e}")
        return jsonify({"error": str(e)}), 500

#############################
# Start background tasks
#############################


async def start_background_tasks():
    """
    Called on startup to fetch trips, or maybe do cleanup.
    """
    await fetch_and_store_trips()

#############################
# Location validation
#############################


@app.route("/api/validate_location", methods=["POST"])
def validate_location():
    data = request.json
    location = data.get("location")
    location_type = data.get("locationType")
    validated = validate_location_osm(location, location_type)
    return jsonify(validated)


def validate_location_osm(location, location_type):
    """
    Use OSM Nominatim to see if location is valid. Return the first match or None.
    """
    params = {
        "q": location,
        "format": "json",
        "limit": 1,
        "featuretype": location_type
    }
    headers = {"User-Agent": "GeojsonGenerator/1.0"}
    response = requests.get(
        "https://nominatim.openstreetmap.org/search", params=params, headers=headers)
    if response.status_code == 200:
        data = response.json()
        return data[0] if data else None
    return None

#############################
# Generate GeoJSON from Overpass
#############################


@app.route("/api/generate_geojson", methods=["POST"])
def generate_geojson():
    """
    Given a validated location with osm_id/type, query Overpass for boundary or ways.
    """
    data = request.json
    location = data.get("location")
    streets_only = data.get("streetsOnly", False)
    geojson_data, err = generate_geojson_osm(location, streets_only)
    if geojson_data:
        return jsonify(geojson_data)
    return jsonify({"error": err}), 400


def generate_geojson_osm(location, streets_only=False):
    """
    Query Overpass for the given location's geometry or highways only.
    """
    try:
        if not isinstance(location, dict) or "osm_id" not in location or "osm_type" not in location:
            return None, "Invalid location data"

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

        response = requests.get(OVERPASS_URL, params={"data": query})
        if response.status_code != 200:
            return None, "Overpass error"

        data = response.json()
        features = process_elements(data["elements"], streets_only)
        if features:
            gdf = gpd.GeoDataFrame.from_features(features)
            gdf = gdf.set_geometry("geometry")
            return json.loads(gdf.to_json()), None
        else:
            return None, "No features found"
    except Exception as e:
        logger.error(f"Error generating geojson: {e}")
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
                    features.append({
                        "type": "Feature",
                        "geometry": line.__geo_interface__,
                        "properties": e.get("tags", {}),
                    })
                else:
                    # If the coords form a closed ring, it might be a polygon
                    if coords[0] == coords[-1]:
                        poly = Polygon(coords)
                        features.append({
                            "type": "Feature",
                            "geometry": poly.__geo_interface__,
                            "properties": e.get("tags", {}),
                        })
                    else:
                        line = LineString(coords)
                        features.append({
                            "type": "Feature",
                            "geometry": line.__geo_interface__,
                            "properties": e.get("tags", {}),
                        })
        elif e["type"] == "relation" and not streets_only:
            # Attempt to unify outer ways into polygons
            pass  # (We keep as-is for brevity, or handle more advanced logic)

    return features

#############################
# Map match endpoints
#############################


@app.route("/api/map_match_trips", methods=["POST"])
async def map_match_trips():
    """
    Initiates map matching for trips in a date range from 'trips_collection'.
    """
    try:
        data = request.json
        start_date_str = data.get("start_date")
        end_date_str = data.get("end_date")

        start_date = datetime.fromisoformat(start_date_str).replace(
            tzinfo=timezone.utc) if start_date_str else None
        end_date = datetime.fromisoformat(end_date_str).replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
        ) if end_date_str else None

        query = {}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}

        trips = trips_collection.find(query)
        for t in trips:
            await process_and_map_match_trip(t)

        return jsonify({"status": "success", "message": "Map matching started for trips."})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/map_match_historical_trips", methods=["POST"])
async def map_match_historical_trips():
    """
    Similar to map_match_trips but for 'historical_trips_collection'.
    """
    try:
        data = request.json
        start_date_str = data.get("start_date")
        end_date_str = data.get("end_date")

        start_date = datetime.fromisoformat(start_date_str).replace(
            tzinfo=timezone.utc) if start_date_str else None
        end_date = datetime.fromisoformat(end_date_str).replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
        ) if end_date_str else None

        query = {}
        if start_date and end_date:
            query["startTime"] = {"$gte": start_date, "$lte": end_date}

        historical = historical_trips_collection.find(query)
        for t in historical:
            await process_and_map_match_trip(t)

        return jsonify({"status": "success", "message": "Map matching for historical."})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/matched_trips")
def get_matched_trips():
    """
    Return matched trips from matched_trips_collection in a date range.
    """
    start_date_str = request.args.get("start_date")
    end_date_str = request.args.get("end_date")
    imei = request.args.get("imei")

    start_date = datetime.fromisoformat(start_date_str).replace(
        tzinfo=timezone.utc) if start_date_str else None
    end_date = datetime.fromisoformat(end_date_str).replace(
        hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
    ) if end_date_str else None

    query = {}
    if start_date and end_date:
        query["startTime"] = {"$gte": start_date, "$lte": end_date}
    if imei:
        query["imei"] = imei

    matched = list(matched_trips_collection.find(query))
    fc = []
    for m in matched:
        fc.append(geojson_module.Feature(
            geometry=geojson_loads(m["matchedGps"]),
            properties={
                "transactionId": m["transactionId"],
                "imei": m.get("imei", ""),
                "startTime": m["startTime"].isoformat() if m.get("startTime") else "",
                "endTime": m["endTime"].isoformat() if m.get("endTime") else "",
                "distance": m.get("distance", 0),
                "timeZone": m.get("timeZone", "America/Chicago"),
                "destination": m.get("destination", "N/A"),
                "startLocation": m.get("startLocation", "N/A"),
            },
        ))

    return jsonify(geojson_module.FeatureCollection(fc))


@app.route("/api/export/trip/<trip_id>")
def export_single_trip(trip_id):
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
                json.dumps(fc), mimetype="application/geo+json",
                headers={
                    "Content-Disposition": f'attachment; filename="trip_{trip_id}.geojson"'}
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
            if gps_data["type"] == "LineString":
                for coord in gps_data["coordinates"]:
                    lon, lat = coord
                    seg.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))

            track.name = t["transactionId"]
            return Response(
                gpx.to_xml(),
                mimetype="application/gpx+xml",
                headers={
                    "Content-Disposition": f'attachment; filename="trip_{trip_id}.gpx"'},
            )
        else:
            return jsonify({"error": "Unsupported format"}), 400
    except Exception as e:
        logger.error(f"Error exporting trip {trip_id}: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/matched_trips/<trip_id>", methods=["DELETE"])
def delete_matched_trip(trip_id):
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
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/export")
def export_page():
    """Renders the export page."""
    return render_template("export.html")


@app.route("/api/export/trips")
def export_trips():
    """
    Provide direct link to exporting in geojson or gpx from an API standpoint. 
    This delegates to create_geojson, create_gpx, etc.
    """
    start_date = request.args.get("start_date")
    end_date = request.args.get("end_date")
    fmt = request.args.get("format")

    ts = fetch_trips(start_date, end_date)

    if fmt == "geojson":
        geojson_data = create_geojson(ts)
        return send_file(
            io.BytesIO(geojson_data.encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            download_name="trips.geojson",
        )
    elif fmt == "gpx":
        gpx_data = create_gpx(ts)
        return send_file(
            io.BytesIO(gpx_data.encode()),
            mimetype="application/gpx+xml",
            as_attachment=True,
            download_name="trips.gpx",
        )


def fetch_trips(start_date_str, end_date_str):
    sd = parser.parse(start_date_str)
    ed = parser.parse(end_date_str)
    query = {"startTime": {"$gte": sd, "$lte": ed}}
    return list(trips_collection.find(query))


def create_geojson(trips):
    features = []
    for t in trips:
        gps_data = t["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        feat = {
            "type": "Feature",
            "geometry": gps_data,
            "properties": {
                "transactionId": t["transactionId"],
                "startTime": t["startTime"].isoformat(),
                "endTime": t["endTime"].isoformat(),
                "distance": t.get("distance", 0),
                "startLocation": t.get("startLocation"),
                "destination": t.get("destination"),
            },
        }
        features.append(feat)
    return json.dumps({"type": "FeatureCollection", "features": features})


def create_gpx(trips):
    gpx = gpxpy.gpx.GPX()
    for t in trips:
        track = gpxpy.gpx.GPXTrack()
        gpx.tracks.append(track)
        segment = gpxpy.gpx.GPXTrackSegment()
        track.segments.append(segment)

        gps_data = t["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)

        if gps_data.get("type") == "LineString":
            for c in gps_data.get("coordinates", []):
                if len(c) >= 2:
                    lon, lat = c
                    segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))
        elif gps_data.get("type") == "Point":
            coords = gps_data.get("coordinates", [])
            if len(coords) >= 2:
                lon, lat = coords
                segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))

        track.name = t.get("transactionId", "Unnamed")
        track.description = f"{t.get('startLocation')} => {t.get('destination')}"
    return gpx.to_xml()


@app.route("/api/export/matched_trips")
def export_matched_trips():
    """
    Export matched trips in geojson or gpx.
    """
    start_date = request.args.get("start_date")
    end_date = request.args.get("end_date")
    fmt = request.args.get("format")

    ms = fetch_matched_trips(start_date, end_date)
    if fmt == "geojson":
        fc = create_geojson(ms)
        return send_file(
            io.BytesIO(fc.encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            download_name="matched_trips.geojson",
        )
    elif fmt == "gpx":
        data = create_gpx(ms)
        return send_file(
            io.BytesIO(data.encode()),
            mimetype="application/gpx+xml",
            as_attachment=True,
            download_name="matched_trips.gpx",
        )


def fetch_matched_trips(start_date_str, end_date_str):
    sd = parser.parse(start_date_str)
    ed = parser.parse(end_date_str)
    query = {"startTime": {"$gte": sd, "$lte": ed}}
    return list(matched_trips_collection.find(query))


@app.route("/api/export/streets")
def export_streets():
    location = request.args.get("location")
    fmt = request.args.get("format")
    if not location:
        return jsonify({"error": "No location param"}), 400

    # parse location JSON
    loc = json.loads(location)
    data, _ = generate_geojson_osm(loc, streets_only=True)
    if not data:
        return jsonify({"error": "No data returned"}), 500

    if fmt == "geojson":
        return send_file(
            io.BytesIO(json.dumps(data).encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            download_name="streets.geojson",
        )
    elif fmt == "shapefile":
        gdf = gpd.GeoDataFrame.from_features(data["features"])
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            # In-memory shapefile writing is trickier; we can do a direct approach if needed.
            # We'll do a quick approach writing to a temporary in-memory file.
            # Some libraries require a real file, but let's do best effort.
            with gpd.io.file.fiona.Env():
                tmp_dir = "inmem_shp"
                if not os.path.exists(tmp_dir):
                    os.mkdir(tmp_dir)
                out_path = os.path.join(tmp_dir, "streets.shp")
                gdf.to_file(out_path, driver="ESRI Shapefile")
                # Add all relevant shapefile parts
                for f in os.listdir(tmp_dir):
                    fpath = os.path.join(tmp_dir, f)
                    with open(fpath, "rb") as fh:
                        zf.writestr(f"streets/{f}", fh.read())
                # Clean up
                for f in os.listdir(tmp_dir):
                    os.remove(os.path.join(tmp_dir, f))
                os.rmdir(tmp_dir)
        buf.seek(0)
        return send_file(
            buf, mimetype="application/zip", as_attachment=True, download_name="streets.zip"
        )


@app.route("/api/export/boundary")
def export_boundary():
    location = request.args.get("location")
    fmt = request.args.get("format")
    if not location:
        return jsonify({"error": "No location"}), 400
    loc = json.loads(location)
    data, _ = generate_geojson_osm(loc, streets_only=False)
    if not data:
        return jsonify({"error": "No boundary data"}), 500

    if fmt == "geojson":
        return send_file(
            io.BytesIO(json.dumps(data).encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            download_name="boundary.geojson",
        )
    elif fmt == "shapefile":
        gdf = gpd.GeoDataFrame.from_features(data["features"])
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            tmp_dir = "inmem_shp"
            if not os.path.exists(tmp_dir):
                os.mkdir(tmp_dir)
            out_path = os.path.join(tmp_dir, "boundary.shp")
            gdf.to_file(out_path, driver="ESRI Shapefile")
            for f in os.listdir(tmp_dir):
                fpath = os.path.join(tmp_dir, f)
                with open(fpath, "rb") as fh:
                    zf.writestr(f"boundary/{f}", fh.read())
            for f in os.listdir(tmp_dir):
                os.remove(os.path.join(tmp_dir, f))
            os.rmdir(tmp_dir)
        buf.seek(0)
        return send_file(
            buf, mimetype="application/zip", as_attachment=True, download_name="boundary.zip"
        )

#############################
# Street coverage
#############################


@app.route("/api/streets", methods=["POST"])
def get_streets():
    """
    Return street coverage for a location.
    """
    loc = request.json.get("location")
    if not loc or not isinstance(loc, dict) or "type" not in loc:
        return jsonify({"status": "error", "message": "Invalid location data."}), 400

    data, err = generate_geojson_osm(loc, streets_only=True)
    if data is None:
        return jsonify({"status": "error", "message": f"Error: {err}"}), 500

    # gather all trips
    all_trips = list(trips_collection.find())
    lines = []
    for t in all_trips:
        gps_data = t["gps"]
        if isinstance(gps_data, str):
            gps_data = geojson_loads(gps_data)
        geom = shape(gps_data)
        if isinstance(geom, LineString):
            lines.append(geom)
        elif isinstance(geom, MultiLineString):
            lines.extend(geom.geoms)

    streets_gdf = gpd.GeoDataFrame.from_features(data["features"])
    streets_gdf.set_crs(epsg=4326, inplace=True)

    if lines:
        # Merge
        from shapely.ops import linemerge
        trips_merged = linemerge(lines)
        # Mark each street as driven if intersects
        streets_gdf["driven"] = streets_gdf.geometry.intersects(trips_merged)
    else:
        streets_gdf["driven"] = False

    return jsonify(json.loads(streets_gdf.to_json()))

#############################
# Load historical
#############################


@app.route("/load_historical_data", methods=["POST"])
async def load_historical_data_api():
    start_date = request.json.get("start_date")
    end_date = request.json.get("end_date")
    cnt = await load_historical_data(start_date, end_date)
    return jsonify({"message": f"Loaded {cnt} historical trips."})

#############################
# Coverage calculation (long)
#############################
# The coverage endpoints for boundary coverage are kept the same

#############################
# Last trip point
#############################


@app.route("/api/last_trip_point")
def get_last_trip_point():
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
        logger.error(f"Error get_last_trip_point: {e}")
        return jsonify({"error": "Failed to retrieve last trip point"}), 500

#############################
# Upload
#############################


@app.route("/upload")
def upload_page():
    return render_template("upload.html")


@app.route("/api/upload_gpx", methods=["POST"])
async def upload_gpx():
    """
    Accept multi-file upload of GPX or GeoJSON. Insert into uploaded_trips_collection.
    """
    try:
        files = request.files.getlist("files[]")
        map_match = request.form.get("map_match", "false") == "true"
        if not files:
            return jsonify({"status": "error", "message": "No files found"}), 400

        success_count = 0
        for f in files:
            filename = f.filename.lower()
            if filename.endswith(".gpx"):
                gpx_data = f.read()
                gpx = gpxpy.parse(gpx_data)
                for track in gpx.tracks:
                    for seg in track.segments:
                        coords = [[p.longitude, p.latitude]
                                  for p in seg.points]
                        if len(coords) < 2:
                            continue
                        start_t = min(
                            (p.time for p in seg.points if p.time), default=datetime.now(timezone.utc))
                        end_t = max(
                            (p.time for p in seg.points if p.time), default=start_t)
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
                data_geojson = json.loads(f.read())
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

        return jsonify({"status": "success", "message": f"{success_count} trips uploaded."})
    except Exception as e:
        logger.error(f"Error upload_gpx: {e}")
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
            trip["startLocation"] = await reverse_geocode_nominatim(start_pt[1], start_pt[0])
        if not trip.get("destination"):
            trip["destination"] = await reverse_geocode_nominatim(end_pt[1], end_pt[0])

        if isinstance(trip["gps"], dict):
            trip["gps"] = json.dumps(trip["gps"])

        existing = uploaded_trips_collection.find_one(
            {"transactionId": trip["transactionId"]})
        if existing:
            # maybe update geocodes
            updates = {}
            if not existing.get("startLocation") and trip["startLocation"]:
                updates["startLocation"] = trip["startLocation"]
            if not existing.get("destination") and trip["destination"]:
                updates["destination"] = trip["destination"]
            if updates:
                uploaded_trips_collection.update_one(
                    {"transactionId": trip["transactionId"]}, {"$set": updates})
        else:
            uploaded_trips_collection.insert_one(trip)
            uploaded.append(trip)
    except DuplicateKeyError:
        logger.warning(f"Duplicate trip ID {trip['transactionId']}, skipping.")
    except Exception as e:
        logger.error(f"process_and_store_trip error: {e}")
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
            tid = props.get("transaction_id",
                            f"geojson-{int(datetime.now().timestamp())}")
            if not (stime and etime):
                # attempt deriving from transaction_id
                pass
            # parse times
            stime_parsed = parser.isoparse(
                stime) if stime else datetime.now(timezone.utc)
            etime_parsed = parser.isoparse(etime) if etime else stime_parsed

            trip = {
                "transactionId": tid,
                "startTime": stime_parsed,
                "endTime": etime_parsed,
                "gps": json.dumps({
                    "type": geom["type"],
                    "coordinates": geom["coordinates"],
                }),
                "distance": calculate_distance(geom["coordinates"]),
                "imei": "HISTORICAL",
            }
            trips.append(trip)
        return trips
    except Exception as e:
        logger.error(f"Error in process_geojson_trip: {e}")
        return None


def calculate_distance(coords):
    """
    Approx distance in miles from consecutive coords in a linestring. 
    coords = [[lon, lat], [lon, lat], ...].
    """
    dist = 0.0
    for i in range(len(coords) - 1):
        dist += haversine_distance(coords[i], coords[i + 1])
    return dist

#############################
# Manage uploaded trips
#############################


@app.route("/api/uploaded_trips")
def get_uploaded_trips():
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
        logger.error(f"Error get_uploaded_trips: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/uploaded_trips/<trip_id>", methods=["DELETE"])
def delete_uploaded_trip(trip_id):
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
        logger.error(f"Error deleting uploaded trip: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/uploaded_trips/bulk_delete", methods=["DELETE"])
def bulk_delete_uploaded_trips():
    """
    Delete multiple uploaded trips by their DB _id or transactionId. Also remove matched trips.
    """
    try:
        data = request.json
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

        ups_to_delete = list(uploaded_trips_collection.find(
            {"_id": {"$in": valid_ids}}))
        trans_ids = [u["transactionId"] for u in ups_to_delete]

        del_res = uploaded_trips_collection.delete_many(
            {"_id": {"$in": valid_ids}})

        matched_del = 0
        if trans_ids:
            matched_del_res = matched_trips_collection.delete_many(
                {"transactionId": {"$in": trans_ids}})
            matched_del = matched_del_res.deleted_count

        return jsonify({
            "status": "success",
            "deleted_uploaded_trips": del_res.deleted_count,
            "deleted_matched_trips": matched_del,
        })
    except Exception as e:
        logger.error(f"Error in bulk_delete_uploaded_trips: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

#############################
# Places
#############################


@app.route("/api/places", methods=["GET", "POST"])
def handle_places():
    """
    GET: Return all places 
    POST: Insert new place
    """
    if request.method == "GET":
        pls = list(places_collection.find())
        return jsonify([
            {"_id": str(p["_id"]), **CustomPlace.from_dict(p).to_dict()} for p in pls
        ])
    else:
        data = request.json
        place = CustomPlace(data["name"], data["geometry"])
        r = places_collection.insert_one(place.to_dict())
        return jsonify({"_id": str(r.inserted_id), **place.to_dict()})


@app.route("/api/places/<place_id>", methods=["DELETE"])
def delete_place(place_id):
    places_collection.delete_one({"_id": ObjectId(place_id)})
    return "", 204


@app.route("/api/places/<place_id>/statistics")
def get_place_statistics(place_id):
    """
    Calculate how many times user ended a trip at that place.
    """
    try:
        p = places_collection.find_one({"_id": ObjectId(place_id)})
        if not p:
            return jsonify({"error": "Place not found"}), 404

        place_shape = shape(p["geometry"])
        visits = []
        first_visit = None
        last_visit = None

        all_trips_sorted = list(trips_collection.find().sort("startTime", 1))
        all_trips_sorted += list(
            historical_trips_collection.find().sort("startTime", 1))
        all_trips_sorted += list(uploaded_trips_collection.find().sort("startTime", 1))
    # Sort the combined list
        all_trips_sorted.sort(key=lambda x: x["startTime"])
        current_time = datetime.now(timezone.utc)

        for i, t in enumerate(all_trips_sorted):
            try:
                gps_data = geojson_loads(t["gps"] if isinstance(
                    t["gps"], str) else json.dumps(t["gps"]))
                endpt = gps_data["coordinates"][-1]
                if place_shape.contains(Point(endpt[0], endpt[1])):
                    t_end = t["endTime"].replace(
                        tzinfo=timezone.utc) if t["endTime"].tzinfo is None else t["endTime"]
                    if i < len(all_trips_sorted) - 1:
                        next_t = all_trips_sorted[i + 1]
                        n_start = next_t["startTime"].replace(
                            tzinfo=timezone.utc) if next_t["startTime"].tzinfo is None else next_t["startTime"]
                        duration = (n_start - t_end).total_seconds() / 60.0
                    else:
                        duration = (current_time -
                                    t_end).total_seconds() / 60.0

                    visits.append(duration)
                    if first_visit is None:
                        first_visit = t_end
                    if last_visit is None or t_end > last_visit:
                        last_visit = t_end
            except Exception as e:
                logger.error(f"Place {p['name']} trip check error: {e}")
                continue

        total_visits = len(visits)
        if total_visits:
            avg_min = sum(visits) / total_visits
            hh = int(avg_min // 60)
            mm = int(avg_min % 60)
            avg_str = f"{hh}h {mm}m"
        else:
            avg_str = "0h 0m"

        return jsonify({
            "totalVisits": total_visits,
            "averageTimeSpent": avg_str,
            "firstVisit": first_visit.isoformat() if first_visit else None,
            "lastVisit": last_visit.isoformat() if last_visit else None,
            "name": p["name"],
        })
    except Exception as e:
        logger.error(f"Error place stats {place_id}: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/trip-analytics")
def get_trip_analytics():
    """
    Demo: Return daily distances & time distribution for charting.
    """
    start_date_str = request.args.get("start_date")
    end_date_str = request.args.get("end_date")

    if not start_date_str or not end_date_str:
        return jsonify({"error": "Missing date range"}), 400

    try:
        pipeline = [
            {"$match": {
                "startTime": {
                    "$gte": datetime.fromisoformat(start_date_str),
                    "$lte": datetime.fromisoformat(end_date_str),
                }
            }},
            {
                "$group": {
                    "_id": {
                        "date": {"$dateToString": {"format": "%Y-%m-%d", "date": "$startTime"}},
                        "hour": {"$hour": "$startTime"},
                    },
                    "totalDistance": {"$sum": "$distance"},
                    "tripCount": {"$sum": 1},
                }
            },
        ]

        results = list(trips_collection.aggregate(pipeline))
        return jsonify({
            "daily_distances": organize_daily_data(results),
            "time_distribution": organize_hourly_data(results),
        })
    except Exception as e:
        logger.error(f"Error trip analytics: {e}")
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

#############################
# Bouncie webhook for real-time
#############################


@app.route("/webhook/bouncie", methods=["POST"])
def bouncie_webhook():
    """
    Bouncie real-time webhook endpoint. 
    """
    wh_key = os.getenv("WEBHOOK_KEY")
    auth_header = request.headers.get("Authorization")
    if not auth_header or auth_header != wh_key:
        logger.error(f"Invalid webhook key: {auth_header}")
        return jsonify({"error": "Invalid webhook key"}), 401

    try:
        data = request.json
        event_type = data.get("eventType")
        imei = data.get("imei")
        txid = data.get("transactionId")

        if event_type == "tripStart":
            active_trips[txid] = {
                "imei": imei,
                "start_time": datetime.now(timezone.utc),
                "path": [],
                "last_update": datetime.now(timezone.utc),
            }
            emit_data = {
                "transactionId": txid,
                "imei": imei,
                "start_time": active_trips[txid]["start_time"].isoformat(),
            }
            socketio.emit("trip_started", emit_data)

        elif event_type == "tripData":
            if txid in active_trips:
                new_points = []
                for p in data.get("data", []):
                    if "gps" in p and p["gps"]:
                        lat = p["gps"]["lat"]
                        lon = p["gps"]["lon"]
                        ts = p.get("timestamp") or datetime.now(
                            timezone.utc).isoformat()
                        new_points.append(
                            {"lat": lat, "lon": lon, "timestamp": ts})
                new_points.sort(key=lambda x: parser.isoparse(x["timestamp"]))
                for np in new_points:
                    active_trips[txid]["path"].append(
                        {"lat": np["lat"], "lon": np["lon"]})
                active_trips[txid]["last_update"] = datetime.now(timezone.utc)
                socketio.emit("trip_update", {
                    "transactionId": txid,
                    "path": active_trips[txid]["path"],
                })

        elif event_type == "tripEnd":
            if txid in active_trips:
                def remove_trip():
                    if txid in active_trips:
                        del active_trips[txid]
                        socketio.emit("trip_ended", {"transactionId": txid})
                threading.Timer(600, remove_trip).start()  # remove after 10min

        return jsonify({"status": "success"}), 200
    except Exception as e:
        logger.error(f"webhook error: {e}")
        return jsonify({"status": "success"}), 200

#############################
# Socket.IO events
#############################


@socketio.on("connect")
def handle_connect():
    logger.info("Client connected (socket.io).")
    # Send current active trips
    for txid, tdata in active_trips.items():
        emit("trip_started", {
            "transactionId": txid,
            "imei": tdata["imei"],
            "start_time": tdata["start_time"].isoformat(),
        })
        emit("trip_update", {
            "transactionId": txid,
            "path": [{"lat": c["lat"], "lon": c["lon"]} for c in tdata["path"]],
        })


@socketio.on("disconnect")
def handle_disconnect():
    logger.info("Client disconnected (socket.io).")

#############################
# DB helpers
#############################


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
        logger.error(f"Error retrieving trip {trip_id}: {e}")
        return None


def store_trip(trip):
    ok, msg = validate_trip_data(trip)
    if not ok:
        logger.error(f"Invalid trip data: {msg}")
        return False
    if isinstance(trip["gps"], dict):
        trip["gps"] = json.dumps(trip["gps"])
    for field in ["startTime", "endTime"]:
        if isinstance(trip[field], str):
            trip[field] = parser.isoparse(trip[field])
    trips_collection.update_one({"transactionId": trip["transactionId"]}, {
                                "$set": trip}, upsert=True)
    logger.info(f"Stored trip {trip['transactionId']}")
    return True


async def process_trip_data(trip):
    """
    Reverse geocode start/dest if missing.
    """
    try:
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        coords = gps_data["coordinates"]
        st = coords[0]
        en = coords[-1]
        if not trip.get("destination"):
            trip["destination"] = await reverse_geocode_nominatim(en[1], en[0])
        if not trip.get("startLocation"):
            trip["startLocation"] = await reverse_geocode_nominatim(st[1], st[0])
        return trip
    except Exception as e:
        logger.error(f"Error in process_trip_data: {e}")
        return None


async def fetch_and_store_trips_in_range(start_date, end_date):
    """
    Main function used by /api/fetch_trips_range
    """
    try:
        logger.info(
            f"fetch_and_store_trips_in_range {start_date} -> {end_date}")
        if start_date.tzinfo is None:
            start_date = start_date.replace(tzinfo=timezone.utc)
        if end_date.tzinfo is None:
            end_date = end_date.replace(tzinfo=timezone.utc)

        async with aiohttp.ClientSession() as sess:
            token = await get_access_token(sess)
            if not token:
                logger.error("No Bouncie token retrieved.")
                return

            all_trips = []
            total_devices = len(AUTHORIZED_DEVICES)
            for idx, imei in enumerate(AUTHORIZED_DEVICES):
                dev_trips = await fetch_trips_in_intervals(sess, token, imei, start_date, end_date)
                logger.info(f"Fetched {len(dev_trips)} trips for {imei}")
                all_trips.extend(dev_trips)
                prog = (idx + 1) / total_devices * 100
                socketio.emit("fetch_progress", {"progress": prog})

            logger.info(f"Total fetched: {len(all_trips)}")
            processed_count = 0
            skipped_count = 0
            error_count = 0

            for trip in all_trips:
                try:
                    existing = get_trip_from_db(trip["transactionId"])
                    if existing:
                        logger.info(
                            f"Skipping existing trip {trip['transactionId']}")
                        skipped_count += 1
                        continue

                    tr = await process_trip_data(trip)
                    if not tr:
                        error_count += 1
                        continue

                    if not store_trip(tr):
                        error_count += 1
                        continue
                    processed_count += 1
                except Exception as e:
                    logger.error(
                        f"Error processing trip {trip.get('transactionId','?')}: {e}")
                    error_count += 1

            logger.info(
                f"Done range: {processed_count} ok, {skipped_count} skipped, {error_count} errors")
    except Exception as e:
        logger.error(f"Error fetch_and_store_trips_in_range: {e}")

#############################
# Earliest trip date
#############################


@app.route("/api/first_trip_date")
def get_first_trip_date():
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
        logger.error(f"get_first_trip_date err: {e}")
        return jsonify({"error": str(e)}), 500

#############################
# Error handlers
#############################


@app.errorhandler(404)
def not_found_error(error):
    return jsonify({"error": "Endpoint not found"}), 404


@app.errorhandler(500)
def internal_error(error):
    return jsonify({"error": "Internal server error"}), 500

#############################
# Cleanup invalid trips
#############################


async def cleanup_invalid_trips():
    """
    Optionally run to mark invalid trip docs. 
    """
    try:
        all_trips = list(trips_collection.find({}))
        for t in all_trips:
            ok, msg = validate_trip_data(t)
            if not ok:
                logger.warning(
                    f"Invalid trip {t.get('transactionId','?')}: {msg}")
                trips_collection.update_one(
                    {"_id": t["_id"]}, {"$set": {"invalid": True}})
        logger.info("Trip cleanup done.")
    except Exception as e:
        logger.error(f"cleanup_invalid_trips: {e}")

#############################
# Bulk delete
#############################


@app.route("/api/trips/bulk_delete", methods=["DELETE"])
def bulk_delete_trips():
    """
    Let user delete multiple trip docs by transactionId.
    """
    try:
        data = request.json
        trip_ids = data.get("trip_ids", [])
        if not trip_ids:
            return jsonify({"status": "error", "message": "No trip IDs"}), 400

        res = trips_collection.delete_many(
            {"transactionId": {"$in": trip_ids}})
        matched_trips_collection.delete_many(
            {"original_trip_id": {"$in": trip_ids}})

        return jsonify({
            "status": "success",
            "message": f"Deleted {res.deleted_count} trips",
            "deleted_count": res.deleted_count,
        })
    except Exception as e:
        logger.error(f"bulk_delete_trips: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

#############################
# GeoJSON trip from .geojson
#############################


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
            out.append({
                "transactionId": str(ObjectId()),
                "startTime": st,
                "endTime": en,
                "gps": {"type": "LineString", "coordinates": coords},
                "imei": "HISTORICAL",
                "distance": calculate_distance(coords),
            })
    return out


@app.route("/edit_trips")
def edit_trips_page():
    """Renders the edit trips page."""
    return render_template("edit_trips.html")


@app.route("/api/edit_trips", methods=["GET"])
def get_edit_trips():
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
        logger.error(f"Error fetching trips for editing: {e}")
        return jsonify({"status": "error", "message": "Internal server error"}), 500


@app.route("/api/upload", methods=["POST"])
async def upload_files():
    """
    Alternate endpoint for uploading multiple GPX/GeoJSON files.
    Similar to /api/upload_gpx.
    """
    try:
        files = request.files.getlist("files[]")
        count = 0
        up = []
        for f in files:
            if f.filename.endswith(".gpx"):
                gpx = gpxpy.parse(f)
                gtrips = process_gpx(gpx)
                for t in gtrips:
                    await process_and_store_trip(t, up)
                    count += 1
            elif f.filename.endswith(".geojson"):
                data = json.load(f)
                trips = process_geojson_trip(data)
                if trips:
                    for t in trips:
                        await process_and_store_trip(t, up)
                        count += 1
        return jsonify({"status": "success", "message": f"Processed {count} trips"})
    except Exception as e:
        logger.error(f"Error uploading: {e}")
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
def update_trip(trip_id):
    """
    Generic update of a trip (regular or matched). 
    """
    try:
        data = request.json
        ttype = data.get("type")
        geometry = data.get("geometry")
        props = data.get("properties", {})

        if ttype == "matched_trips":
            coll = matched_trips_collection
        else:
            coll = trips_collection

        t = coll.find_one({
            "$or": [
                {"transactionId": trip_id},
                {"transactionId": str(trip_id)},
            ]
        })
        if not t:
            # maybe it belongs to the other collection
            other_coll = matched_trips_collection if ttype != "matched_trips" else trips_collection
            t = other_coll.find_one({
                "$or": [
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ]
            })
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
        logger.error(f"Error updating {trip_id}: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/trips/<trip_id>", methods=["GET"])
def get_single_trip(trip_id):
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
        logger.error(f"get_single_trip error: {e}")
        return jsonify({"status": "error", "message": "Internal server error"}), 500


@app.route("/api/debug/trip/<trip_id>", methods=["GET"])
def debug_trip(trip_id):
    """
    Debug helper, check if found in trips or matched_trips, ID mismatch, etc.
    """
    try:
        reg = trips_collection.find_one({
            "$or": [
                {"transactionId": trip_id},
                {"transactionId": str(trip_id)},
            ]
        })
        mat = matched_trips_collection.find_one({
            "$or": [
                {"transactionId": trip_id},
                {"transactionId": str(trip_id)},
            ]
        })
        return jsonify({
            "regular_trip_found": bool(reg),
            "matched_trip_found": bool(mat),
            "regular_trip_id_field": reg.get("transactionId") if reg else None,
            "matched_trip_id_field": mat.get("transactionId") if mat else None,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/street_coverage", methods=["POST"])
def get_street_coverage():
    """
    Example coverage calculation. 
    (Implementation remains large/complex; we keep the structure, just ensure it works.)
    """
    try:
        data = request.json
        location = data.get("location")
        if not location:
            return jsonify({"status": "error", "message": "No location"}), 400

        # Reuse existing coverage function
        # We'll do a minimal approach for demonstration
        streets_data, err = generate_geojson_osm(location, streets_only=True)
        if not streets_data:
            return jsonify({"status": "error", "message": f"Street data error: {err}"}), 500

        matched = list(matched_trips_collection.find())
        coverage_data = calculate_street_coverage(
            location, streets_data, matched)
        return jsonify(coverage_data)
    except Exception as e:
        logger.error(f"Error calculating coverage: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


def calculate_street_coverage(location, streets_geojson, matched_trips):
    """
    Stub coverage function that checks if each street intersects the union of matched trips.
    For brevity, left mostly as is. 
    """
    try:
        # We basically do the same steps as the main coverage function.
        # We'll keep it short.

        # Convert matched trips to lines & unify
        lines = []
        for t in matched_trips:
            gps_data = t.get("matchedGps")
            if isinstance(gps_data, str):
                gps_data = geojson_loads(gps_data)
            g = shape(gps_data)
            if isinstance(g, LineString):
                lines.append(g)
            elif isinstance(g, MultiLineString):
                lines.extend(list(g.geoms))

        if lines:
            unioned = linemerge(lines)
        else:
            unioned = None

        # Mark streets
        sgdf = gpd.GeoDataFrame.from_features(streets_geojson["features"])
        sgdf.set_crs(epsg=4326, inplace=True)

        if unioned:
            sgdf["driven"] = sgdf.intersects(unioned)
        else:
            sgdf["driven"] = False

        # Some arbitrary coverage metrics
        total = sgdf.geometry.length.sum()
        driven = sgdf[sgdf["driven"]].geometry.length.sum()
        coverage_pct = (driven / total * 100.0) if total > 0 else 0
        return {
            "total_length": float(total),
            "driven_length": float(driven),
            "coverage_percentage": round(coverage_pct, 2),
            "streets_data": json.loads(sgdf.to_json()),
        }

    except Exception as e:
        logger.error(f"calc coverage error: {e}\n{traceback.format_exc()}")
        raise


#############################
# Run
#############################
if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    threading.Timer(1, periodic_fetch_trips).start()
    socketio.run(app, host="0.0.0.0", port=port,
                 debug=False, allow_unsafe_werkzeug=True)
