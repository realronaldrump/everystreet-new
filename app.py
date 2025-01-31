from update_geo_points import update_geo_points
from utils import validate_location_osm
from map_matching import (
    process_and_map_match_trip,
)
from timezonefinder import TimezoneFinder
from shapely.geometry import (
    LineString,
    Point,
    Polygon,
    mapping,
    shape,
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
from aiohttp.client_exceptions import ClientConnectorError, ClientResponseError
from bson import ObjectId
from dateutil import parser
from dotenv import load_dotenv
from quart import (
    Quart,
    Response,
    jsonify,
    render_template,
    request,
    send_file
)
from apscheduler.schedulers.asyncio import AsyncIOScheduler
scheduler = AsyncIOScheduler()

# We import the map_matching logic

# Import from utils.py


load_dotenv()

# Logging Configuration (Structured Logging - JSON)
logging.basicConfig(level=logging.INFO,  # Set default level to INFO
                    format='%(asctime)s - %(levelname)s - %(name)s - %(message)s')  # Simple format for console
logger = logging.getLogger(__name__)

app = Quart(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "supersecretfallback")

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

# Global variable to store progress information
progress_data = {
    "fetch_and_store_trips": {"status": "idle", "progress": 0, "message": ""},
    "fetch_and_store_trips_in_range": {"status": "idle", "progress": 0, "message": ""},
    "run_preprocess_streets": {"status": "idle", "progress": 0, "message": ""},
}

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
        logger.info("MongoDB client initialized successfully.")
        return client
    except Exception as e:
        # Log exception details
        logger.error(
            f"Failed to initialize MongoDB client: {e}", exc_info=True)
        raise


mongo_client = get_mongo_client()
db = mongo_client["every_street"]
trips_collection = db["trips"]
matched_trips_collection = db["matched_trips"]
historical_trips_collection = db["historical_trips"]
uploaded_trips_collection = db["uploaded_trips"]
places_collection = db["places"]
osm_data_collection = db["osm_data"]
realtime_data_collection = db["realtime_data"]
streets_collection = db["streets"]
coverage_metadata_collection = db["coverage_metadata"]
live_trips_collection = db["live_trips"]
archived_live_trips_collection = db["archived_live_trips"]

# Ensure some indexes
uploaded_trips_collection.create_index("transactionId", unique=True)
matched_trips_collection.create_index("transactionId", unique=True)
osm_data_collection.create_index([("location", 1), ("type", 1)], unique=True)
streets_collection.create_index([("geometry", "2dsphere")])
streets_collection.create_index([("properties.location", 1)])
coverage_metadata_collection.create_index([("location", 1)], unique=True)

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
    try:
        async with client_session.post(AUTH_URL, data=payload) as auth_response:
            auth_response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
            data = await auth_response.json()
            access_token = data.get("access_token")
            if not access_token:
                # Log if token is missing
                logger.error(f"Access token not found in response: {data}")
                return None
            logger.info(
                "Successfully retrieved access token from Bouncie API.")
            return access_token
    except ClientResponseError as e:
        # Log ClientResponseError with details
        logger.error(
            f"ClientResponseError retrieving access token: {e.status} - {e.message}", exc_info=True)
        return None
    except ClientConnectorError as e:
        # Log ClientConnectorError
        logger.error(
            f"ClientConnectorError retrieving access token: {e}", exc_info=True)
        return None
    except Exception as e:
        # Log any other exceptions
        logger.error(
            f"Unexpected error retrieving access token: {e}", exc_info=True)
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
            response.raise_for_status()
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

            logger.info(
                f"Successfully fetched {len(trips)} trips from Bouncie API for IMEI: {imei}, date range: {start_date} to {end_date}")
            return trips
    except ClientResponseError as e:
        logger.error(
            f"ClientResponseError fetching trips from Bouncie API: {e.status} - {e.message}, IMEI: {imei}, date range: {start_date} to {end_date}", exc_info=True)
        return []
    except ClientConnectorError as e:
        logger.error(
            f"ClientConnectorError fetching trips from Bouncie API: {e}, IMEI: {imei}, date range: {start_date} to {end_date}", exc_info=True)
        return []
    except Exception as e:
        logger.error(
            f"Unexpected error fetching trips from Bouncie API: {e}, IMEI: {imei}, date range: {start_date} to {end_date}", exc_info=True)
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
        try:
            trips = await get_trips_from_api(main_session, access_token, imei, current_start, current_end)
            all_trips.extend(trips)
        except Exception as e:
            # Log interval specific errors
            logger.error(
                f"Error fetching trips for interval {current_start} to {current_end}: {e}", exc_info=True)
        current_start = current_end

    return all_trips

#############################
# Periodic fetch
#############################


async def periodic_fetch_trips():
    """
    Periodically fetch trips from Bouncie API and store them.
    This task runs in the background on a schedule.
    """
    try:
        last_trip = trips_collection.find_one(sort=[("endTime", -1)])
        start_date = (
            last_trip["endTime"]
            if last_trip
            else datetime.now(timezone.utc) - timedelta(days=7)
        )
        end_date = datetime.now(timezone.utc)
        logger.info(
            f"Periodic trip fetch started from {start_date} to {end_date}")
        await fetch_and_store_trips_in_range(start_date, end_date, update_progress=False)
        logger.info("Periodic trip fetch completed successfully.")
    except Exception as e:
        logger.error(f"Error during periodic trip fetch: {e}", exc_info=True)

#############################
# Data Validation
#############################


def validate_trip_data(trip):
    """
    Ensure the trip has transactionId, startTime, endTime, gps, etc.
    Return (bool_ok, error_message), with enhanced logging.
    """
    transaction_id = trip.get(
        'transactionId', '?')  # Get transaction ID safely
    # Log function entry
    logger.info(f"Validating trip data for trip {transaction_id}...")

    required = ["transactionId", "startTime", "endTime", "gps"]
    for field in required:
        if field not in trip:
            error_message = f"Missing required field: {field}"
            # Log missing field as warning
            logger.warning(
                f"Validation failed for trip {transaction_id}: {error_message}")
            return (False, error_message)
    # Log if required fields are present
    logger.debug(f"Required fields present for trip {transaction_id}.")

    try:
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        if "type" not in gps_data or "coordinates" not in gps_data:
            error_message = "gps data missing 'type' or 'coordinates'"
            # Log GPS data structure issue
            logger.warning(
                f"Validation failed for trip {transaction_id}: {error_message}")
            return (False, error_message)
        if not isinstance(gps_data["coordinates"], list):
            error_message = "gps['coordinates'] must be a list"
            # Log coords not a list
            logger.warning(
                f"Validation failed for trip {transaction_id}: {error_message}")
            return (False, error_message)
        # Log valid GPS structure
        logger.debug(f"GPS data structure is valid for trip {transaction_id}.")
    except json.JSONDecodeError as e:  # Catch JSON decoding errors specifically
        error_message = f"Invalid gps data format: {str(e)}"
        # Log JSON decode error with exception info
        logger.warning(
            f"Validation failed for trip {transaction_id}: {error_message}", exc_info=True)
        return (False, error_message)
    except Exception as e:  # Catch other potential errors during validation
        error_message = f"Error validating gps data: {str(e)}"
        # Log general validation error with exception info
        logger.error(
            f"Error during gps data validation for trip {transaction_id}: {error_message}", exc_info=True)
        return (False, error_message)

    # Log validation success
    logger.info(f"Trip data validation successful for trip {transaction_id}.")
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
                    display_name = data.get("display_name", None)
                    if display_name:
                        logger.debug(
                            f"Reverse geocoded ({lat},{lon}) to: {display_name} (attempt {attempt})")
                        return display_name
                    else:
                        logger.warning(
                            f"Nominatim reverse geocode returned no display_name for ({lat},{lon}) (attempt {attempt})")

        except (ClientResponseError, ClientConnectorError, asyncio.TimeoutError) as e:
            log_level = logging.WARNING if attempt < retries else logging.ERROR
            logger.log(
                log_level, f"Nominatim error attempt {attempt} for ({lat},{lon}): {e}", exc_info=True)
            if attempt < retries:
                await asyncio.sleep(backoff_factor * (2 ** (attempt - 1)))

    logger.error(
        f"Failed to reverse geocode ({lat},{lon}) after {retries} attempts.")
    return None  # Return None after all retries have failed

#############################
# Quart endpoints
#############################


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
                f"Error processing trip {trip.get('transactionId')}: {e}", exc_info=True)

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
        # Log timezone retrieval errors
        logger.error(f"Error getting trip timezone: {e}", exc_info=True)
        return "UTC"

#############################
# Main fetch/store logic
#############################


async def fetch_and_store_trips():
    """
    For all authorized devices, fetch last 4 years of trips from Bouncie,
    store them in the 'trips' collection.
    """
    global progress_data
    progress_data["fetch_and_store_trips"]["status"] = "running"
    progress_data["fetch_and_store_trips"]["progress"] = 0
    progress_data["fetch_and_store_trips"]["message"] = "Starting fetch"

    try:
        async with aiohttp.ClientSession() as client_session:
            access_token = await get_access_token(client_session)
            if not access_token:
                logger.error(
                    "Failed to obtain access token, aborting fetch_and_store_trips.")
                progress_data["fetch_and_store_trips"]["status"] = "failed"
                progress_data["fetch_and_store_trips"]["message"] = "Failed to obtain access token"
                return

            end_date = datetime.now(timezone.utc)
            start_date = end_date - timedelta(days=365 * 4)

            all_trips = []
            total_devices = len(AUTHORIZED_DEVICES)
            for device_count, imei in enumerate(AUTHORIZED_DEVICES, 1):
                progress_data["fetch_and_store_trips"][
                    "message"] = f"Fetching trips for device {device_count} of {total_devices}"
                device_trips = await fetch_trips_in_intervals(
                    client_session, access_token, imei, start_date, end_date
                )
                all_trips.extend(device_trips)
                # Progress goes to 50% here
                progress = int((device_count / total_devices) * 50)
                progress_data["fetch_and_store_trips"]["progress"] = progress

            # Insert or update each trip
            progress_data["fetch_and_store_trips"]["message"] = "Storing trips in database"
            total_trips = len(all_trips)
            for index, trip in enumerate(all_trips):
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
                    logger.debug(
                        f"Trip {trip.get('transactionId')} processed and stored/updated.")

                    # Update progress
                    progress = int(50 + (index / total_trips)
                                   * 50)  # Remaining 50%
                    progress_data["fetch_and_store_trips"]["progress"] = progress
                except Exception as e:
                    logger.error(
                        f"Error inserting/updating trip {trip.get('transactionId')}: {e}", exc_info=True)

            progress_data["fetch_and_store_trips"]["status"] = "completed"
            progress_data["fetch_and_store_trips"]["progress"] = 100
            progress_data["fetch_and_store_trips"]["message"] = "Fetch and store completed"

    except Exception as e:
        logger.error(f"Error in fetch_and_store_trips: {e}", exc_info=True)
        progress_data["fetch_and_store_trips"]["status"] = "failed"
        progress_data["fetch_and_store_trips"]["message"] = f"Error: {e}"


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
            # Log missing GPS
            logger.error(f"Trip {trip.get('transactionId')} missing gps data.")
            return None
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        trip["gps"] = json.dumps(gps_data)

        if not gps_data.get("coordinates"):
            logger.error(
                f"Trip {trip.get('transactionId')} has invalid coordinates.")  # Log invalid coords
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
        # Log general trip processing errors
        logger.error(
            f"Error processing trip {trip.get('transactionId')}: {e}", exc_info=True)
        return None

#############################
# Quart endpoints
#############################


@app.route("/api/trips")
async def get_trips():
    """
    Return regular, uploaded, historical trips as combined FeatureCollection.
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
                    trip["endTime"] = trip["endTime"].replace(
                        tzinfo=timezone.utc)

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
                    f"Error processing trip {trip.get('transactionId')}: {e}", exc_info=True)

        return jsonify(geojson_module.FeatureCollection(features))
    except Exception as e:
        # Log endpoint specific errors
        logger.error(f"Error in /api/trips endpoint: {e}", exc_info=True)
        return jsonify({"error": "Failed to retrieve trips"}), 500


def format_idle_time(seconds):
    """
    Convert float 'seconds' to hh:mm:ss string, handling potential floats.
    """
    if not seconds:
        return "00:00:00"

    try:
        seconds = int(seconds)  # Convert to integer
    except (TypeError, ValueError):
        logger.error(f"Invalid input for format_idle_time: {seconds}")
        return "Invalid Input"

    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"

#############################
# Driving Insights
#############################


@app.route("/api/driving-insights")
async def get_driving_insights():
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
                        "total_distance": {"$sum": {"$ifNull": ["$distance", 0]}},
                        "total_fuel_consumed": {"$sum": {"$ifNull": ["$fuelConsumed", 0]}},
                        "max_speed": {"$max": {"$ifNull": ["$maxSpeed", 0]}},
                        "total_idle_duration": {"$sum": {"$ifNull": ["$totalIdleDuration", 0]}},
                        "longest_trip_distance": {"$max": {"$ifNull": ["$distance", 0]}},
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


@app.route("/api/fetch_trips", methods=["POST"])
async def api_fetch_trips():
    """Triggers the big fetch from Bouncie for all devices (4 yrs)."""
    try:
        await fetch_and_store_trips()
        return jsonify({"status": "success", "message": "Trips fetched & stored."}), 200
    except Exception as e:
        # Log endpoint specific errors
        logger.error(f"Error in api_fetch_trips endpoint: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/fetch_trips_range", methods=["POST"])
async def api_fetch_trips_range():
    """Fetch & store trips in a certain date range for all devices."""
    global progress_data
    progress_data["fetch_and_store_trips_in_range"]["status"] = "running"
    progress_data["fetch_and_store_trips_in_range"]["progress"] = 0
    progress_data["fetch_and_store_trips_in_range"]["message"] = "Starting fetch in range"
    try:
        data = await request.get_json()
        start_date = datetime.fromisoformat(
            data["start_date"]).replace(tzinfo=timezone.utc)
        end_date = datetime.fromisoformat(data["end_date"]).replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
        ) + timedelta(days=1)
        await fetch_and_store_trips_in_range(start_date, end_date, update_progress=True)
        return jsonify({"status": "success", "message": "Trips fetched & stored."}), 200
    except Exception as e:
        # Log endpoint specific errors
        logger.error(
            f"Error in api_fetch_trips_range endpoint: {e}", exc_info=True)
        progress_data["fetch_and_store_trips_in_range"]["status"] = "failed"
        progress_data["fetch_and_store_trips_in_range"]["message"] = f"Error: {e}"
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/fetch_trips_last_hour", methods=["POST"])
async def api_fetch_trips_last_hour():
    """API endpoint to manually trigger fetching trips from the last hour."""
    try:
        await hourly_fetch_trips()  # Call the function directly
        return jsonify({"status": "success", "message": "Hourly trip fetch initiated."}), 200
    except Exception as e:
        logger.error(
            f"Error initiating hourly trip fetch via API: {e}", exc_info=True)
        return jsonify({"status": "error", "message": "Failed to initiate hourly trip fetch."}), 500

#############################
# After request
#############################


@app.after_request
async def add_header(response):
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
async def export_geojson():
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
        logger.error(f"Error exporting gpx: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500

#############################
# Start background tasks
#############################


def start_background_tasks():
    """
    Starts background tasks using the APScheduler for periodic executions.
    """
    try:
        # Fetch and store trips periodically (every hour)
        scheduler.add_job(fetch_and_store_trips, "interval",
                          hours=1, max_instances=1)

        # Run coverage calculations for all locations periodically (every hour)
        scheduler.add_job(update_coverage_for_all_locations,
                          "interval", hours=1, max_instances=1)

        # Periodic cleanup of stale trips
        scheduler.add_job(cleanup_stale_trips, "interval",
                          minutes=5, max_instances=1)

        # Cleanup invalid trips every 24 hours
        scheduler.add_job(cleanup_invalid_trips, "interval",
                          hours=24, max_instances=1)

        # Run periodic fetch trips every 30 minutes
        scheduler.add_job(periodic_fetch_trips, "interval",
                          minutes=30, max_instances=1)

        # Start the scheduler
        scheduler.start()
        logger.info(
            "Scheduler initialized and background tasks started successfully.")
    except Exception as e:
        logger.error(f"Failed to start scheduler: {e}", exc_info=True)


async def hourly_fetch_trips():
    """
    Fetches and stores trips from the last hour.
    This function is meant to be run periodically by the scheduler.
    """
    try:
        # Calculate the current UTC time and the time 1 hour ago
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(hours=1)

        logger.info(
            f"Hourly trip fetch started for range: {start_date} to {end_date}")
        await fetch_and_store_trips_in_range(start_date, end_date)
        logger.info("Hourly trip fetch completed successfully.")

        # Map match the newly fetched trips
        logger.info("Starting map matching for hourly fetched trips...")
        current_hour_end = datetime.now(timezone.utc)
        current_hour_start = current_hour_end - timedelta(hours=1)
        new_trips_to_match = trips_collection.find({
            "startTime": {"$gte": current_hour_start, "$lte": current_hour_end}
        })

        map_matched_count = 0
        for trip in new_trips_to_match:
            await process_and_map_match_trip(trip)
            map_matched_count += 1
        logger.info(
            f"Map matching completed for {map_matched_count} hourly fetched trips.")
    except Exception as e:
        logger.error(f"Error during hourly trip fetch: {e}", exc_info=True)

#############################
# Location validation
#############################


@app.route("/api/validate_location", methods=["POST"])
async def validate_location():
    data = await request.get_json()
    location = data.get("location")
    location_type = data.get("locationType")
    validated = await validate_location_osm(location, location_type)
    return jsonify(validated)


async def validate_location_osm(location, location_type):
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
    try:
        async with aiohttp.ClientSession() as session:  # Create aiohttp session
            async with session.get(
                "https://nominatim.openstreetmap.org/search",
                params=params,
                headers=headers,
                timeout=10
            ) as response:
                response.raise_for_status()
                data = await response.json()  # Await response.json()
                return data[0] if data else None
    except aiohttp.ClientError as e:  # Catch aiohttp exceptions
        logger.error(
            f"Error validating location with Nominatim: {e}", exc_info=True)
        return None

#############################
# Generate GeoJSON from Overpass
#############################


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
        if not isinstance(location, dict) or "osm_id" not in location or "osm_type" not in location:
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
            async with session.get(OVERPASS_URL, params={"data": query}, timeout=30) as response:
                response.raise_for_status()  # Raise HTTPError for bad status
                data = await response.json()  # Await response.json()

        features = process_elements(data["elements"], streets_only)
        if features:
            gdf = gpd.GeoDataFrame.from_features(features)
            gdf = gdf.set_geometry("geometry")
            geojson_data = json.loads(gdf.to_json())

            # Estimate BSON size (very approximate)
            bson_size_estimate = len(json.dumps(geojson_data).encode('utf-8'))

            if bson_size_estimate <= 16793598:  # Check if within MongoDB's limit
                # Store in database
                existing_data = osm_data_collection.find_one(
                    {"location": location, "type": osm_type})
                if existing_data:
                    osm_data_collection.update_one(
                        {"_id": existing_data["_id"]},
                        {"$set": {"geojson": geojson_data,
                                  "updated_at": datetime.now(timezone.utc)}}
                    )
                    logger.info(
                        f"Updated OSM data for {location['display_name']}, type: {osm_type}")
                else:
                    osm_data_collection.insert_one({
                        "location": location,
                        "type": osm_type,
                        "geojson": geojson_data,
                        "created_at": datetime.now(timezone.utc)
                    })
                    logger.info(
                        f"Stored OSM data for {location['display_name']}, type: {osm_type}")
            else:
                logger.warning(
                    f"Data for {location['display_name']}, type: {osm_type} is too large for MongoDB ({bson_size_estimate} bytes). Returning directly.")

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
        data = await request.get_json()
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
        # Log endpoint errors
        logger.error(
            f"Error in map_match_historical_trips endpoint: {e}", exc_info=True)
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

    matched_trips = list(matched_trips_collection.find(query))

    features = []
    for trip in matched_trips:
        try:
            feature = geojson_module.Feature(
                geometry=geojson_loads(trip["matchedGps"]),
                properties={
                    "transactionId": trip["transactionId"],
                    "imei": trip.get("imei", ""),
                    "startTime": trip["startTime"].isoformat() if trip.get("startTime") else "",
                    "endTime": trip["endTime"].isoformat() if trip.get("endTime") else "",
                    "distance": trip.get("distance", 0),
                    "timeZone": trip.get("timeZone", "UTC"),
                    "destination": trip.get("destination", "N/A"),
                    "startLocation": trip.get("startLocation", "N/A"),
                },
            )
            features.append(feature)
        except Exception as e:
            logger.error(
                f"Error processing matched trip {trip.get('transactionId')}: {e}", exc_info=True)

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


async def create_geojson(trips):
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


async def create_gpx(trips):
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

#############################
# Preprocessing Route
#############################


@app.route("/api/preprocess_streets", methods=["POST"])
async def preprocess_streets_route():
    """
    Triggers the preprocessing of street data for a given location.
    Expects JSON payload: {"location": "Waco, TX", "location_type": "city"}
    """
    global progress_data
    progress_data["run_preprocess_streets"]["status"] = "running"
    progress_data["run_preprocess_streets"]["progress"] = 0
    progress_data["run_preprocess_streets"]["message"] = "Starting preprocessing"
    try:
        data = await request.get_json()
        location_query = data.get("location")
        # Default to "city" if not provided
        location_type = data.get("location_type", "city")

        if not location_query:
            return jsonify({"status": "error", "message": "Location is required"}), 400

        # Validate the location (you can still keep this check here)
        validated_location = await validate_location_osm(
            location_query, location_type)
        if not validated_location:
            return jsonify({"status": "error", "message": "Invalid location"}), 400

        # Run the preprocessing script as an asynchronous task
        asyncio.create_task(run_preprocess_streets(
            validated_location, location_type))

        return jsonify(
            {
                "status": "success",
                "message": f"Street data preprocessing initiated for {validated_location['display_name']}. Check server logs for progress.",
            }
        )

    except Exception as e:
        logger.error(f"Error in preprocess_streets_route: {e}", exc_info=True)
        progress_data["run_preprocess_streets"]["status"] = "failed"
        progress_data["run_preprocess_streets"]["message"] = f"Error: {e}"
        return jsonify({"status": "error", "message": str(e)}), 500


async def run_preprocess_streets(validated_location, location_type):
    """
    Runs the preprocess_streets.py script with the given location and type.
    """
    global progress_data
    progress_data["run_preprocess_streets"][
        "message"] = f"Preprocessing: {validated_location['display_name']}"
    try:
        process = await asyncio.create_subprocess_exec(
            "python",
            "preprocess_streets.py",
            validated_location["display_name"],
            "--type",
            location_type,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # Read output line by line and update progress
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            line = line.decode().strip()
            logger.info(f"preprocess_streets.py output: {line}")

            # Parse progress from output (this is just an example, adapt as needed)
            if "%" in line:
                try:
                    percentage = int(line.split("%")[0].split(" ")[-1])
                    progress_data["run_preprocess_streets"]["progress"] = percentage
                except ValueError:
                    pass

        stdout, stderr = await process.communicate()

        if process.returncode == 0:
            logger.info(
                f"Successfully processed street data for {validated_location['display_name']}")
            progress_data["run_preprocess_streets"]["status"] = "completed"
            progress_data["run_preprocess_streets"]["progress"] = 100
            progress_data["run_preprocess_streets"]["message"] = "Preprocessing completed"
        else:
            logger.error(
                f"Error processing street data for {validated_location['display_name']}: {stderr.decode()}")
            progress_data["run_preprocess_streets"]["status"] = "failed"
            progress_data["run_preprocess_streets"]["message"] = f"Error: {stderr.decode()}"

    except Exception as e:
        logger.error(
            f"Error running preprocess_streets.py: {e}", exc_info=True)
        progress_data["run_preprocess_streets"]["status"] = "failed"
        progress_data["run_preprocess_streets"]["message"] = f"Error: {e}"

#############################
# Street Segment Details Route
#############################


@app.route("/api/street_segment/<segment_id>", methods=["GET"])
async def get_street_segment_details(segment_id):
    """
    Returns details for a specific street segment.
    """
    try:
        segment = streets_collection.find_one(
            {"properties.segment_id": segment_id}, {"_id": 0})
        if not segment:
            return jsonify({"status": "error", "message": "Segment not found"}), 404

        return jsonify(segment)

    except Exception as e:
        logger.error(f"Error fetching segment details: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500

#############################
# Street coverage
#############################


@app.route("/api/street_coverage", methods=["POST"])
async def get_street_coverage():
    """
    Return street coverage for a location, including segment data.
    """
    try:
        data = await request.get_json()
        location = data.get("location")
        if not location or not isinstance(location, dict) or "display_name" not in location:
            return jsonify({"status": "error", "message": "Invalid location data."}), 400

        location_name = location["display_name"]

        # Get coverage stats from MongoDB
        coverage_stats = coverage_metadata_collection.find_one(
            {"location": location_name})

        if not coverage_stats:
            return jsonify({"status": "error", "message": "Coverage data not found for this location"}), 404

        # Get street segments from MongoDB
        street_segments = list(streets_collection.find(
            {"properties.location": location_name}, {"_id": 0}))

        return jsonify({
            "total_length": coverage_stats["total_length"],
            "driven_length": coverage_stats["driven_length"],
            "coverage_percentage": coverage_stats["coverage_percentage"],
            "streets_data": {
                "type": "FeatureCollection",
                "metadata": {
                    "total_length_miles": meters_to_miles(coverage_stats["total_length"]),
                    "driven_length_miles": meters_to_miles(coverage_stats["driven_length"]),
                },
                "features": street_segments
            },
        })

    except Exception as e:
        logger.error(
            f"Error calculating coverage: {e}\n{traceback.format_exc()}")
        return jsonify({"status": "error", "message": str(e)}), 500

# New function to update street coverage (to be called periodically or after new trips are added)


async def update_street_coverage(location_name):
    """
    Updates the driven status of street segments based on recent trips.
    Now it gets the location from the segments themselves.
    """
    logger.info(f"Updating street coverage for location: {location_name}")
    try:
        # Get the last processed trip timestamp for the location
        coverage_metadata = coverage_metadata_collection.find_one(
            {"location": location_name})
        last_processed_trip_time = coverage_metadata.get("last_processed_trip_time", datetime.min.replace(
            tzinfo=timezone.utc)) if coverage_metadata else datetime.min.replace(tzinfo=timezone.utc)
        logger.info(f"Last processed trip time: {last_processed_trip_time}")

        # Find new trips since the last update
        new_trips = list(matched_trips_collection.find({
            "startTime": {"$gt": last_processed_trip_time}
        }))

        logger.info(f"Found {len(new_trips)} new trips (no location filter)")

        if not new_trips:
            logger.info(f"No new trips found since {last_processed_trip_time}")
            return

        # Buffer trip lines and update street segments
        updated_segments = set()  # Keep track of updated segments for this location
        for trip in new_trips:
            logger.info(f"Processing trip: {trip['transactionId']}")
            try:
                trip_line = shape(geojson_loads(trip["matchedGps"]))
                buffered_line = trip_line.buffer(
                    0.00005)  # Buffer by ~5 meters

                # Find intersecting segments for the specific location using a geospatial query
                intersecting_segments = streets_collection.find({
                    "properties.location": location_name,
                    "geometry": {
                        "$geoIntersects": {
                            "$geometry": mapping(buffered_line)
                        }
                    }
                })

                for segment in intersecting_segments:
                    segment_id = segment["properties"]["segment_id"]

                    # Only update if the segment hasn't been updated already
                    if segment_id not in updated_segments:
                        streets_collection.update_one(
                            {"_id": segment["_id"]},
                            {
                                "$set": {"properties.driven": True, "properties.last_updated": datetime.now(timezone.utc)},
                                "$addToSet": {"properties.matched_trips": trip["transactionId"]}
                            }
                        )
                        # Add to the set of updated segments
                        updated_segments.add(segment_id)
                        logger.info(f"Updated segment: {segment_id}")

            except Exception as e:
                logger.error(
                    f"Error processing trip {trip['transactionId']}: {e}")

        # Recalculate and update coverage metadata
        total_segments = streets_collection.count_documents(
            {"properties.location": location_name})
        driven_segments = streets_collection.count_documents(
            {"properties.location": location_name, "properties.driven": True})
        total_length = sum(segment["properties"]["length"] for segment in streets_collection.find(
            {"properties.location": location_name}, {"properties.length": 1}))
        driven_length = sum(segment["properties"]["length"] for segment in streets_collection.find(
            {"properties.location": location_name, "properties.driven": True}, {"properties.length": 1}))
        coverage_percentage = (driven_length / total_length) * \
            100 if total_length > 0 else 0

        logger.info(f"Updating coverage metadata for {location_name}:")
        logger.info(f"  Total segments: {total_segments}")
        logger.info(f"  Driven segments: {driven_segments}")
        logger.info(f"  Total length: {total_length}")
        logger.info(f"  Driven length: {driven_length}")
        logger.info(f"  Coverage percentage: {coverage_percentage}")

        coverage_metadata_collection.update_one(
            {"location": location_name},
            {
                "$set": {
                    "total_segments": total_segments,
                    "driven_segments": driven_segments,
                    "total_length": total_length,
                    "driven_length": driven_length,
                    "coverage_percentage": coverage_percentage,
                    "last_updated": datetime.now(timezone.utc),
                    "last_processed_trip_time": max(trip["startTime"] for trip in new_trips)
                }
            },
            upsert=True
        )

        logger.info(f"Street coverage updated for {location_name}")

    except Exception as e:
        logger.error(
            f"Error updating street coverage for {location_name}: {e}")
        raise


async def update_coverage_for_all_locations():
    """
    Updates street coverage for all locations in the coverage_metadata collection.
    This task runs periodically in the background.
    """
    try:
        logger.info(
            "Starting periodic street coverage update for all locations...")
        locations = coverage_metadata_collection.distinct("location")
        for location in locations:
            await update_street_coverage(location)
        logger.info("Finished periodic street coverage update.")
    except Exception as e:
        logger.error(
            f"Error updating coverage for all locations: {e}", exc_info=True)


def run_periodic_fetches():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(periodic_fetch_trips())
    finally:
        loop.close()

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
    start_date = (await request.get_json()).get("start_date")
    end_date = (await request.get_json()).get("end_date")
    inserted_count = await load_historical_data(start_date, end_date)
    return jsonify({"message": f"Loaded historical data. Inserted {inserted_count} new trips."})

#############################
# Coverage calculation (long)
#############################
# The coverage endpoints for boundary coverage are kept the same

#############################
# Last trip point
#############################


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

#############################
# Upload
#############################


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

        return jsonify({"status": "success", "message": f"{success_count} trips uploaded."})
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
        logger.error(f"Error in process_geojson_trip: {e}", exc_info=True)
        return None


def calculate_distance(lat1, lon1, lat2, lon2):
    """
    Calculate the distance between two points in miles using the Haversine formula.
    """
    R = 3958.8  # Radius of Earth in miles
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2)**2 + cos(radians(lat1)) * \
        cos(radians(lat2)) * sin(dlon / 2)**2
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return R * c

#############################
# Manage uploaded trips
#############################


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
        logger.error(
            f"Error in bulk_delete_uploaded_trips: {e}", exc_info=True)
        return jsonify({"status": "error", "message": str(e)}), 500

#############################
# Places
#############################


@app.route("/api/places", methods=["GET", "POST"])
async def handle_places():
    """
    GET: Return all places
    POST: Insert new place
    """
    if request.method == "GET":
        pls = list(places_collection.find())
        return jsonify([
            {"_id": str(p["_id"]), **CustomPlace.from_dict(p).to_dict()} for p in pls
        ])
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
    Calculate how many times user ended a trip at that place,
    along with duration of stay and time since last visit.
    """
    try:
        p = places_collection.find_one({"_id": ObjectId(place_id)})
        if not p:
            return jsonify({"error": "Place not found"}), 404

        place_shape = shape(p["geometry"])
        visits = []
        first_visit = None
        last_visit = None
        durations = []
        time_since_last_visits = []
        current_time = datetime.now(timezone.utc)

        # Geospatial query for trips ending within the place's geometry
        query = {
            "destinationGeoPoint": {
                "$geoWithin": {
                    "$geometry": p["geometry"]
                }
            }
        }

        # Fetch relevant trips
        trips_cursor = trips_collection.find(query)
        historical_trips_cursor = historical_trips_collection.find(query)
        uploaded_trips_cursor = uploaded_trips_collection.find(query)

        all_trips = list(
            trips_cursor) + list(historical_trips_cursor) + list(uploaded_trips_cursor)
        all_trips.sort(key=lambda x: x["endTime"])

        for i, t in enumerate(all_trips):
            try:
                t_end = t["endTime"].replace(
                    tzinfo=timezone.utc) if t["endTime"].tzinfo is None else t["endTime"]
                if first_visit is None:
                    first_visit = t_end
                last_visit = t_end

                if i < len(all_trips) - 1:
                    next_t = all_trips[i + 1]
                    n_start = next_t["startTime"].replace(
                        tzinfo=timezone.utc) if next_t["startTime"].tzinfo is None else next_t["startTime"]
                    duration = (n_start - t_end).total_seconds() / 60.0
                    durations.append(duration)

                    # Calculate time since last visit
                    if i > 0:
                        prev_t = all_trips[i - 1]
                        prev_t_end = prev_t["endTime"].replace(
                            tzinfo=timezone.utc) if prev_t["endTime"].tzinfo is None else prev_t["endTime"]
                        time_since_last_visit = (
                            t_end - prev_t_end).total_seconds() / 3600.0  # in hours
                        time_since_last_visits.append(time_since_last_visit)
                else:
                    duration = (current_time - t_end).total_seconds() / 60.0
                    durations.append(duration)

                visits.append(duration)
            except Exception as e:
                logger.error(
                    f"Place {p['name']} trip check error: {e}", exc_info=True)
                continue

        total_visits = len(visits)
        avg_duration = sum(durations) / total_visits if total_visits else 0
        avg_duration_str = f"{int(avg_duration // 60)}h {int(avg_duration % 60)}m"

        avg_time_since_last_visit = sum(
            time_since_last_visits) / len(time_since_last_visits) if time_since_last_visits else 0

        return jsonify({
            "totalVisits": total_visits,
            "averageTimeSpent": avg_duration_str,
            "firstVisit": first_visit.isoformat() if first_visit else None,
            "lastVisit": last_visit.isoformat() if last_visit else None,
            "averageTimeSinceLastVisit": avg_time_since_last_visit,
            "name": p["name"],
        })
    except Exception as e:
        logger.error(f"Error place stats {place_id}: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


@app.route("/api/places/<place_id>/trips")
async def get_trips_for_place(place_id):
    """
    Returns a list of trips that ended at the specified place,
    along with the duration of stay and time since the last visit.
    """
    try:
        place = places_collection.find_one({"_id": ObjectId(place_id)})
        if not place:
            return jsonify({"error": "Place not found"}), 404

        # Find trips that end at this place
        query = {
            "destinationGeoPoint": {
                "$geoWithin": {
                    "$geometry": place["geometry"]
                }
            }
        }
        trips = list(trips_collection.find(query)) + \
            list(historical_trips_collection.find(query)) + \
            list(uploaded_trips_collection.find(query))

        trips.sort(key=lambda x: x["endTime"])

        trips_data = []
        for i, trip in enumerate(trips):
            trip_end_time = trip["endTime"].replace(
                tzinfo=timezone.utc) if trip["endTime"].tzinfo is None else trip["endTime"]

            # Calculate duration of stay (time until next trip starts)
            if i < len(trips) - 1:
                next_trip = trips[i + 1]
                next_trip_start_time = next_trip["startTime"].replace(
                    tzinfo=timezone.utc) if next_trip["startTime"].tzinfo is None else next_trip["startTime"]
                # Duration in minutes
                duration = (next_trip_start_time -
                            trip_end_time).total_seconds() / 60
            else:
                # Duration in minutes
                duration = (datetime.now(timezone.utc) -
                            trip_end_time).total_seconds() / 60

            # Calculate time since last visit
            if i > 0:
                previous_trip = trips[i - 1]
                previous_trip_end_time = previous_trip["endTime"].replace(
                    tzinfo=timezone.utc) if previous_trip["endTime"].tzinfo is None else previous_trip["endTime"]
                time_since_last_visit = (
                    trip_end_time - previous_trip_end_time).total_seconds() / 3600  # Time in hours
            else:
                time_since_last_visit = None

            trips_data.append({
                "transactionId": trip["transactionId"],
                "endTime": trip_end_time.isoformat(),
                "duration": f"{int(duration // 60)}h {int(duration % 60)}m",
                "timeSinceLastVisit": f"{time_since_last_visit:.2f} hours" if time_since_last_visit is not None else "N/A",
            })

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
            {"$group": {
                "_id": "$destination",
                "totalVisits": {"$sum": 1},
                "firstVisit": {"$min": "$endTime"},
                "lastVisit": {"$max": "$endTime"},
            }},
            # Only include places visited at least 5 times (you can adjust this)
            {"$match": {"totalVisits": {"$gte": 5}}},
            {"$sort": {"totalVisits": -1}},  # Sort by most visited
        ]

        # Combine results from all three collections
        all_trips = list(trips_collection.aggregate(pipeline)) + \
            list(historical_trips_collection.aggregate(pipeline)) + \
            list(uploaded_trips_collection.aggregate(pipeline))

        # Process the results to match the expected format
        visits_data = []
        for doc in all_trips:
            visits_data.append({
                "name": doc["_id"],
                "totalVisits": doc["totalVisits"],
                "firstVisit": doc["firstVisit"].isoformat() if doc["firstVisit"] else None,
                "lastVisit": doc["lastVisit"].isoformat() if doc["lastVisit"] else None,
            })

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

#############################
# Bouncie webhook for real-time
#############################


@app.route("/stream")
async def stream():
    """SSE endpoint for live trip updates"""
    async def event_stream():
        try:
            # Send initial connection established message
            yield "data: {\"type\": \"connected\"}\n\n"

            while True:
                try:
                    # Get current active trip if any
                    active_trip = live_trips_collection.find_one(
                        {"status": "active"})

                    if active_trip:
                        # Send trip data
                        data = {
                            "type": "trip_update",
                            "data": {
                                "transactionId": active_trip["transactionId"],
                                "coordinates": active_trip.get("coordinates", [])
                            }
                        }
                        yield f"data: {json.dumps(data)}\n\n"
                    else:
                        # Send heartbeat to keep connection alive
                        yield "data: {\"type\": \"heartbeat\"}\n\n"

                    await asyncio.sleep(1)
                except Exception as e:
                    logger.error(f"Error in event stream loop: {e}")
                    continue

        except Exception as e:
            logger.error(f"Error in event stream: {e}")

    response = Response(event_stream(), mimetype="text/event-stream")
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['Connection'] = 'keep-alive'
    response.headers['X-Accel-Buffering'] = 'no'  # Important for nginx
    return response


@app.route("/webhook/bouncie", methods=["POST"])
async def bouncie_webhook():
    try:
        data = await request.get_json()
        event_type = data.get("eventType")

        if not event_type:
            return jsonify({"error": "Missing eventType"}), 400

        transaction_id = data.get("transactionId")

        if event_type == "tripStart":
            live_trips_collection.delete_many({"status": "active"})
            live_trips_collection.insert_one({
                "transactionId": transaction_id,
                "status": "active",
                "startTime": datetime.now(timezone.utc),
                "coordinates": [],
                "lastUpdate": datetime.now(timezone.utc)
            })

        elif event_type == "tripData":
            if "data" in data:
                coordinates_to_add = []
                seen_coords = set()

                # Fetch existing coordinates from MongoDB
                trip = live_trips_collection.find_one(
                    {"transactionId": transaction_id, "status": "active"})
                existing_coordinates = trip.get(
                    "coordinates", []) if trip else []

                # Populate seen_coords with existing coordinates to avoid duplicates
                for coord_obj in existing_coordinates:
                    seen_coords.add((coord_obj["lat"], coord_obj["lon"]))

                for point in data["data"]:
                    if "gps" in point:
                        coord_tuple = (point["gps"]["lat"],
                                       point["gps"]["lon"])
                        if coord_tuple not in seen_coords:
                            coordinates_to_add.append({
                                "lat": point["gps"]["lat"],
                                "lon": point["gps"]["lon"]
                            })
                            seen_coords.add(coord_tuple)

                if coordinates_to_add:
                    live_trips_collection.update_one(
                        {"transactionId": transaction_id, "status": "active"},
                        {
                            "$push": {"coordinates": {"$each": coordinates_to_add}},
                            "$set": {"lastUpdate": datetime.now(timezone.utc)}
                        }
                    )
                    logger.info(
                        f"Updated trip {transaction_id} with {len(coordinates_to_add)} new coordinates")

        elif event_type == "tripEnd":
            trip = live_trips_collection.find_one(
                {"transactionId": transaction_id})
            if trip:
                trip["endTime"] = datetime.now(timezone.utc)
                trip["status"] = "completed"
                archived_live_trips_collection.insert_one(trip)
                live_trips_collection.delete_one({"_id": trip["_id"]})

        return jsonify({"status": "success"}), 200

    except Exception as e:
        logger.error(f"Error in bouncie_webhook: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/active_trip", methods=["GET"])
async def get_active_trip():
    """API endpoint to get the current active trip data for persistence"""
    try:
        active_trip = live_trips_collection.find_one({"status": "active"})
        if active_trip:
            trip_data = {
                "transactionId": active_trip["transactionId"],
                "coordinates": active_trip.get("coordinates", [])
            }
            return jsonify(trip_data), 200
        else:
            return jsonify({}), 200  # Return empty JSON if no active trip
    except Exception as e:
        logger.error(f"Error in get_active_trip: {e}")
        return jsonify({"error": str(e)}), 500


def is_valid_gps_point(point):
    """
    Validate GPS point data for correctness.
    """
    gps = point.get("gps", {})
    lat, lon = gps.get("lat"), gps.get("lon")
    return lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180


async def cleanup_stale_trips():
    """Periodically archives trips that haven't been updated in 5 minutes"""
    try:
        now = datetime.now(timezone.utc)
        stale_threshold = now - timedelta(minutes=5)

        stale_trips = live_trips_collection.find({
            "lastUpdate": {"$lt": stale_threshold},
            "status": "active"
        })

        for trip in stale_trips:
            trip["status"] = "stale"
            trip["endTime"] = now
            archived_live_trips_collection.insert_one(trip)
            live_trips_collection.delete_one({"_id": trip["_id"]})

    except Exception as e:
        logger.error(f"Error cleaning up stale trips: {e}")

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
        logger.error(f"Error retrieving trip {trip_id}: {e}", exc_info=True)
        return None


def store_trip(trip):
    """
    Stores a trip in the trips_collection, with enhanced logging.
    """
    transaction_id = trip.get(
        'transactionId', '?')  # Get transaction ID safely
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
            {"transactionId": trip["transactionId"]}, update_data, upsert=True)
        # Log successful storage with details
        logger.info(
            f"Stored trip {trip['transactionId']} successfully. Modified count: {result.modified_count}, Upserted: {result.upserted_id is not None}")
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
        (event for event in realtime_trip_data if event['event_type'] == 'tripStart'), None)
    trip_end_event = next(
        (event for event in realtime_trip_data if event['event_type'] == 'tripEnd'), None)
    trip_data_events = [event['data']['data'] for event in realtime_trip_data if event['event_type']
                        == 'tripData' and 'data' in event['data'] and event['data']['data']]

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
        trip_start_event['data']['start']['timestamp'])
    end_time = parser.isoparse(trip_end_event['data']['end']['timestamp'])
    imei = trip_start_event['imei']
    transaction_id = trip_start_event['transactionId']

    # Log parsed basic trip info
    logger.debug(
        f"Parsed startTime: {start_time}, endTime: {end_time}, transactionId: {transaction_id}, imei: {imei}")

    all_coords = []
    for data_chunk in trip_data_events:  # Iterate over chunks of tripData
        for point in data_chunk:  # Iterate over points within each chunk
            # Robust GPS data check
            if point.get('gps') and point['gps'].get('lat') is not None and point['gps'].get('lon') is not None:
                # Ensure lon, lat order
                all_coords.append([point['gps']['lon'], point['gps']['lat']])

    if not all_coords:
        # Log no coords warning
        logger.warning(
            f"No valid GPS coordinates found in realtime data for trip {transaction_id}.")
        return None
    # Log coord count
    logger.debug(
        f"Extracted {len(all_coords)} coordinates from tripData events.")

    trip_gps = {
        "type": "LineString",
        "coordinates": all_coords
    }

    trip = {
        "transactionId": transaction_id,
        "imei": imei,
        "startTime": start_time,
        "endTime": end_time,
        "gps": trip_gps,
        "source": "webhook",  # Mark source as webhook
        "startOdometer": trip_start_event['data']['start']['odometer'],
        "endOdometer": trip_end_event['data']['end']['odometer'],
        "fuelConsumed": trip_end_event['data']['end']['fuelConsumed'],
        "timeZone": trip_start_event['data']['start']['timeZone'],
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
    Reverse geocode start/dest if missing.
    Check if start/end are within a custom place.
    Robustly handle missing or incorrect gps data, with enhanced logging.
    """
    transaction_id = trip.get('transactionId', '?')
    logger.info(f"Processing trip data for trip {transaction_id}...")

    try:
        gps_data = trip.get("gps")
        if not gps_data:
            logger.warning(
                f"Trip {transaction_id} has no GPS data to process.")
            return trip

        if isinstance(gps_data, str):
            try:
                gps_data = json.loads(gps_data)
            except json.JSONDecodeError:
                logger.error(
                    f"Invalid JSON in gps data for trip {transaction_id}.", exc_info=True)
                return trip

        coords = gps_data.get("coordinates")
        if not coords or not isinstance(coords, list) or len(coords) < 2:
            logger.warning(
                f"Trip {transaction_id} has invalid or insufficient coordinates.")
            return trip

        st = coords[0]
        en = coords[-1]

        start_point = Point(st[0], st[1])
        end_point = Point(en[0], en[1])

        logger.debug(
            f"Extracted start point: {st}, end point: {en} for trip {transaction_id}")

        # Check for custom places
        start_place = get_place_at_point(start_point)
        end_place = get_place_at_point(end_point)

        if start_place:
            trip["startLocation"] = start_place["name"]
            trip["startPlaceId"] = start_place["_id"]
            logger.debug(
                f"Start point of trip {transaction_id} is within custom place: {start_place['name']}")
        else:
            start_location_name = await reverse_geocode_nominatim(st[1], st[0])
            trip["startLocation"] = start_location_name
            logger.debug(
                f"Start point of trip {transaction_id} reverse geocoded to: {start_location_name}")

        if end_place:
            trip["destination"] = end_place["name"]
            trip["destinationPlaceId"] = end_place["_id"]
            logger.debug(
                f"End point of trip {transaction_id} is within custom place: {end_place['name']}")
        else:
            destination_name = await reverse_geocode_nominatim(en[1], en[0])
            trip["destination"] = destination_name
            logger.debug(
                f"End point of trip {transaction_id} reverse geocoded to: {destination_name}")

        # Set destinationGeoPoint for geospatial querying
        trip["destinationGeoPoint"] = {
            "type": "Point",
            "coordinates": [en[0], en[1]]  # Longitude, Latitude
        }

        # Set startGeoPoint for geospatial querying
        trip["startGeoPoint"] = {
            "type": "Point",
            "coordinates": [st[0], st[1]]  # Longitude, Latitude
        }
        logger.debug(f"GeoPoints set for trip {transaction_id}.")

        logger.info(
            f"Trip data processing completed for trip {transaction_id}.")
        return trip
    except Exception as e:
        logger.error(
            f"Error in process_trip_data for trip {transaction_id}: {e}", exc_info=True)
        return trip

# add the update geo points route to the settings page


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
        collections = [trips_collection,
                       historical_trips_collection, uploaded_trips_collection]
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


async def fetch_and_store_trips_in_range(start_date, end_date, update_progress=False):
    """
    Main function used by /api/fetch_trips_range
    """
    global progress_data
    if update_progress:
        progress_data["fetch_and_store_trips_in_range"]["status"] = "running"
        progress_data["fetch_and_store_trips_in_range"]["progress"] = 0
        progress_data["fetch_and_store_trips_in_range"]["message"] = "Fetching trips in range"
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
                if update_progress:
                    progress_data["fetch_and_store_trips_in_range"]["status"] = "failed"
                    progress_data["fetch_and_store_trips_in_range"]["message"] = "Failed to get Bouncie access token"
                return

            all_trips = []
            total_devices = len(AUTHORIZED_DEVICES)
            for idx, imei in enumerate(AUTHORIZED_DEVICES):
                dev_trips = await fetch_trips_in_intervals(sess, token, imei, start_date, end_date)
                logger.info(f"Fetched {len(dev_trips)} trips for {imei}")
                all_trips.extend(dev_trips)
                if update_progress:
                    prog = int((idx + 1) / total_devices * 50)
                    progress_data["fetch_and_store_trips_in_range"]["progress"] = prog
                    progress_data["fetch_and_store_trips_in_range"][
                        "message"] = f"Fetched trips for device {idx + 1} of {total_devices}"

            logger.info(f"Total fetched: {len(all_trips)}")
            processed_count = 0
            skipped_count = 0
            error_count = 0

            total_trips = len(all_trips)
            for index, trip in enumerate(all_trips):
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
                        f"Error processing trip {trip.get('transactionId','?')}: {e}", exc_info=True)
                    error_count += 1
                if update_progress:
                    prog = int(50 + (index / total_trips) * 50)
                    progress_data["fetch_and_store_trips_in_range"]["progress"] = prog
                    progress_data["fetch_and_store_trips_in_range"][
                        "message"] = f"Processed trip {index + 1} of {total_trips}"

            logger.info(
                f"Done range: {processed_count} ok, {skipped_count} skipped, {error_count} errors")

            if update_progress:
                progress_data["fetch_and_store_trips_in_range"]["status"] = "completed"
                progress_data["fetch_and_store_trips_in_range"]["progress"] = 100
                progress_data["fetch_and_store_trips_in_range"]["message"] = "Fetch and store completed"

    except Exception as e:
        logger.error(
            f"Error fetch_and_store_trips_in_range: {e}", exc_info=True)
        if update_progress:
            progress_data["fetch_and_store_trips_in_range"]["status"] = "failed"
            progress_data["fetch_and_store_trips_in_range"]["message"] = f"Error: {e}"

#############################
# Earliest trip date
#############################


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

#############################
# Error handlers
#############################


@app.errorhandler(404)
async def not_found_error(error):
    return jsonify({"error": "Endpoint not found"}), 404


@app.errorhandler(500)
async def internal_error(error):
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
        logger.error(f"cleanup_invalid_trips: {e}", exc_info=True)

#############################
# Bulk delete
#############################


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

        return jsonify({
            "status": "success",
            "message": f"Deleted {res.deleted_count} trips",
            "deleted_count": res.deleted_count,
        })
    except Exception as e:
        logger.error(f"bulk_delete_trips: {e}", exc_info=True)
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

    return jsonify({"message": f"Geocoding refreshed for {updated_count} trips.", "updated_count": updated_count}), 200


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
            return jsonify({"status": "success", "message": "Trip deleted successfully"}), 200
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

#############################
# Run
#############################
if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    # Start the background tasks before running the app
    start_background_tasks()
    # Use uvicorn or hypercorn to run the app
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")