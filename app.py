# Standard library imports
import json
import threading
import os
import glob
import math
import io
import zipfile
import logging
from datetime import datetime, timedelta, timezone, UTC
import traceback
import pymongo

# Third-party library imports
import aiohttp
from aiohttp.client_exceptions import ClientConnectorError, ClientResponseError
from flask import Flask, render_template, request, jsonify, session, Response, send_file
from flask_socketio import SocketIO
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError
import certifi
import geojson as geojson_module
from geojson import (
    loads as geojson_loads,
    dumps as geojson_dumps,
)
from timezonefinder import TimezoneFinder
import pytz
import asyncio
from shapely.geometry import (
    Polygon,
    LineString,
    MultiPolygon,
    MultiLineString,
    shape,
    Point,
    mapping,
)
from shapely.ops import linemerge
import geopandas as gpd
import requests
import gpxpy
import gpxpy.gpx
from dateutil import parser
from bson import ObjectId
from pyproj import Transformer


# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

# MongoDB setup
try:
    client = MongoClient(
        os.getenv("MONGO_URI"),
        tls=True,
        tlsAllowInvalidCertificates=True,
        tlsCAFile=certifi.where(),
        tz_aware=True,
        # Ensure datetime objects are timezone-aware (UTC)
        tzinfo=timezone.utc,
    )
    db = client["every_street"]
    trips_collection = db["trips"]
    matched_trips_collection = db["matched_trips"]
    historical_trips_collection = db["historical_trips"]
    uploaded_trips_collection = db["uploaded_trips"]
    places_collection = db["places"]
    print("Successfully connected to MongoDB")
except Exception as mongo_error:
    print(f"Error connecting to MongoDB: {mongo_error}")
    raise

uploaded_trips_collection.create_index("transactionId", unique=True)
matched_trips_collection.create_index("transactionId", unique=True)

# Bouncie API setup
CLIENT_ID = os.getenv("CLIENT_ID")
CLIENT_SECRET = os.getenv("CLIENT_SECRET")
REDIRECT_URI = os.getenv("REDIRECT_URI")
AUTH_CODE = os.getenv("AUTHORIZATION_CODE")
AUTHORIZED_DEVICES = os.getenv("AUTHORIZED_DEVICES", "").split(",")
MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN")

AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"

OVERPASS_URL = "http://overpass-api.de/api/interpreter"


class CustomPlace:
    def __init__(self, name, geometry, created_at=None):
        self.name = name
        self.geometry = geometry
        self.created_at = created_at or datetime.now(UTC)

    def to_dict(self):
        return {
            "name": self.name,
            "geometry": self.geometry,
            "created_at": self.created_at,
        }

    @staticmethod
    def from_dict(data):
        return CustomPlace(
            name=data["name"],
            geometry=data["geometry"],
            created_at=data.get("created_at", datetime.now(UTC)),
        )


# Initialize TimezoneFinder
tf = TimezoneFinder()


async def get_access_token(client_session):
    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": AUTH_CODE,
        "redirect_uri": REDIRECT_URI,
    }

    logger.info(
        "Requesting access token with payload: "
        + str(
            {k: v[:10] + "..." if k !=
                "grant_type" else v for k, v in payload.items()}
        )
    )

    async with client_session.post(AUTH_URL, data=payload) as auth_response:
        logger.info(f"Auth Response Status: {auth_response.status}")
        logger.info("Auth Response Headers: %s", auth_response.headers)

        response_text = await auth_response.text()
        logger.info(f"Auth Response Body: {response_text}")

        if auth_response.status == 200:
            data = json.loads(response_text)
            return data.get("access_token")
        logger.error(f"Error getting access token: {auth_response.status}")
        logger.error("Error response: %s", response_text)
        return None


async def get_trips_from_api(client_session, access_token, imei, start_date, end_date):
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
                trips = json.loads(await response.text())
                for trip in trips:
                    # Get timezone for this trip
                    tz_str = get_trip_timezone(trip)
                    timezone = pytz.timezone(tz_str)

                    # Process start time
                    if "startTime" in trip and isinstance(trip["startTime"], str):
                        # Parse the UTC time from Bouncie
                        parsed_time = parser.isoparse(trip["startTime"])
                        if parsed_time.tzinfo is None:
                            parsed_time = parsed_time.replace(tzinfo=pytz.UTC)

                        # Convert to local time for the trip's location
                        local_time = parsed_time.astimezone(timezone)
                        trip["startTime"] = local_time
                        # Store timezone for frontend use
                        trip["timezone"] = tz_str

                    # Process end time
                    if "endTime" in trip and isinstance(trip["endTime"], str):
                        parsed_time = parser.isoparse(trip["endTime"])
                        if parsed_time.tzinfo is None:
                            parsed_time = parsed_time.replace(tzinfo=pytz.UTC)

                        local_time = parsed_time.astimezone(timezone)
                        trip["endTime"] = local_time

                return trips
            if response.status == 401:
                logger.error("Authentication error - token may be expired")
                return []
            logger.error(f"Error fetching trips: {response.status}")
            return []
    except Exception as e:
        logger.error(f"Exception in get_trips_from_api: {str(e)}")
        return []


async def fetch_trips_in_intervals(
    main_session, access_token, imei, start_date, end_date
):
    all_trips = []
    current_start = start_date
    if current_start.tzinfo is None:
        current_start = current_start.replace(tzinfo=timezone.utc)
    if end_date.tzinfo is None:
        end_date = end_date.replace(tzinfo=timezone.utc)
    while current_start < end_date:
        current_end = min(current_start + timedelta(days=7), end_date)
        trips = await get_trips_from_api(
            main_session, access_token, imei, current_start, current_end
        )
        all_trips.extend(trips)
        current_start = current_end
    return all_trips


def is_valid_geojson(geojson_obj):
    return geojson_obj["type"] in [
        "Point",
        "LineString",
        "Polygon",
        "MultiPoint",
        "MultiLineString",
        "MultiPolygon",
        "GeometryCollection",
    ]


def periodic_fetch_trips():
    with app.app_context():
        try:
            last_trip = trips_collection.find_one(sort=[("endTime", -1)])
            if last_trip:
                start_date = last_trip["endTime"]
            else:
                # Last week if no trips
                start_date = datetime.now(timezone.utc) - timedelta(days=7)

            end_date = datetime.now(timezone.utc)

            logger.info(f"Fetching trips from {start_date} to {end_date}")
            asyncio.run(fetch_and_store_trips_in_range(start_date, end_date))

        except Exception as e:
            logger.error(f"Error in periodic fetch: {str(e)}")
        finally:
            threading.Timer(30 * 60, periodic_fetch_trips).start()


def validate_trip_data(trip):
    required_fields = ["transactionId", "startTime", "endTime", "gps"]

    # Check for required fields
    for field in required_fields:
        if field not in trip:
            return False, f"Missing required field: {field}"

    # Validate GPS data
    try:
        if isinstance(trip["gps"], str):
            gps_data = json.loads(trip["gps"])
        else:
            gps_data = trip["gps"]

        if not isinstance(gps_data, dict):
            return False, "GPS data must be a GeoJSON object"

        if "type" not in gps_data or "coordinates" not in gps_data:
            return False, "Invalid GeoJSON structure"

        if not isinstance(gps_data["coordinates"], list):
            return False, "Coordinates must be a list"

    except json.JSONDecodeError:
        return False, "Invalid GPS JSON data"
    except Exception as e:
        return False, f"GPS validation error: {str(e)}"

    return True, None


async def reverse_geocode_nominatim(lat, lon, retries=3, backoff_factor=1):
    url = "https://nominatim.openstreetmap.org/reverse"
    params = {
        "format": "jsonv2",
        "lat": lat,
        "lon": lon,
        "zoom": 18,
        "addressdetails": 1,
    }
    headers = {"User-Agent": "YourAppName/1.0 (your.email@example.com)"}

    for attempt in range(1, retries + 1):
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=10)
            ) as session:
                async with session.get(url, params=params, headers=headers) as response:
                    response.raise_for_status()
                    data = await response.json()
                    address = data.get("display_name", None)
                    logger.info(
                        f"Reverse geocoding successful for ({lat}, {lon}): {address}"
                    )
                    return address
        except ClientResponseError as e:
            logger.error(
                f"HTTP error on attempt {attempt}: {e.status} {e.message}")
            if 500 <= e.status < 600:
                pass
            else:
                break
        except ClientConnectorError as e:
            logger.error(f"Connection error on attempt {attempt}: {e}")
        except asyncio.TimeoutError:
            logger.error(f"Timeout error on attempt {attempt}")
        except Exception as e:
            logger.error(f"Unexpected error on attempt {attempt}: {e}")

        if attempt < retries:
            sleep_time = backoff_factor * (2 ** (attempt - 1))
            logger.info(f"Retrying in {sleep_time} seconds...")
            await asyncio.sleep(sleep_time)
        else:
            logger.error(
                f"All {retries} attempts to reverse geocode failed for ({lat}, {lon})"
            )
            return None


def fetch_trips_for_geojson():
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
                "distance": trip["distance"],
                "destination": trip["destination"],
                "startLocation": trip.get("startLocation", "N/A"),
                "timezone": get_trip_timezone(trip),
            },
        )
        features.append(feature)

    return geojson_module.FeatureCollection(features)


def get_trip_timezone(trip):
    try:
        gps_data = geojson_loads(
            trip["gps"] if isinstance(
                trip["gps"], str) else json.dumps(trip["gps"])
        )
        if gps_data["type"] == "Point":
            lon, lat = gps_data["coordinates"]
        elif gps_data["type"] in [
            "LineString",
            "Polygon",
            "MultiPoint",
            "MultiLineString",
            "MultiPolygon",
        ]:
            # Use the first point of the trip
            lon, lat = gps_data["coordinates"][0]
        else:
            return "UTC"

        timezone_str = tf.timezone_at(lng=lon, lat=lat)
        if not timezone_str:
            return "UTC"

        return timezone_str

    except Exception as e:
        logger.error(f"Error getting trip timezone: {e}")
        return "UTC"


async def fetch_and_store_trips():
    try:
        print("Starting fetch_and_store_trips")
        print(f"Authorized devices: {AUTHORIZED_DEVICES}")
        async with aiohttp.ClientSession() as client_session:
            access_token = await get_access_token(client_session)
            print("Access token obtained")

            end_date = datetime.now(timezone.utc)
            start_date = end_date - timedelta(days=365 * 4)

            all_trips = []
            total_devices = len(AUTHORIZED_DEVICES)
            for device_count, imei in enumerate(AUTHORIZED_DEVICES, 1):
                print(f"Fetching trips for IMEI: {imei}")
                device_trips = await fetch_trips_in_intervals(
                    client_session, access_token, imei, start_date, end_date
                )
                print(f"Fetched {len(device_trips)} trips for IMEI {imei}")
                all_trips.extend(device_trips)

                progress = int((device_count / total_devices) * 100)
                socketio.emit("loading_progress", {"progress": progress})

            print(f"Total trips fetched: {len(all_trips)}")

            for trip in all_trips:
                try:
                    existing_trip = trips_collection.find_one(
                        {"transactionId": trip["transactionId"]}
                    )
                    if existing_trip:
                        print(
                            f"Trip {trip['transactionId']} already exists in the database. Skipping."
                        )
                        continue
                    is_valid, error_message = validate_trip_data(trip)
                    if not is_valid:
                        print(
                            f"Invalid trip data for {trip.get('transactionId', 'Unknown')}: {error_message}"
                        )
                        continue

                    trip_timezone = get_trip_timezone(trip)

                    if isinstance(trip["startTime"], str):
                        trip["startTime"] = parser.isoparse(trip["startTime"])
                    if isinstance(trip["endTime"], str):
                        trip["endTime"] = parser.isoparse(trip["endTime"])

                    if isinstance(trip["startTime"], str):
                        trip["startTime"] = parser.isoparse(trip["startTime"])
                    if isinstance(trip["endTime"], str):
                        trip["endTime"] = parser.isoparse(trip["endTime"])

                    gps_data = geojson_loads(
                        trip["gps"]
                        if isinstance(trip["gps"], str)
                        else json.dumps(trip["gps"])
                    )

                    start_point = gps_data["coordinates"][0]
                    last_point = gps_data["coordinates"][-1]

                    trip["startGeoPoint"] = start_point
                    trip["destinationGeoPoint"] = last_point

                    trip["destination"] = await reverse_geocode_nominatim(
                        last_point[1], last_point[0]
                    )
                    trip["startLocation"] = await reverse_geocode_nominatim(
                        start_point[1], start_point[0]
                    )

                    if isinstance(trip["gps"], dict):
                        trip["gps"] = geojson_dumps(trip["gps"])
                    result = trips_collection.update_one(
                        {"transactionId": trip["transactionId"]},
                        {"$set": trip},
                        upsert=True,
                    )
                    print(
                        f"Updated trip {trip['transactionId']} for IMEI {trip.get('imei', 'Unknown')}: {'Inserted' if result.upserted_id else 'Updated'}"
                    )
                except Exception as trip_error:
                    print(
                        f"Error updating trip {trip.get('transactionId', 'Unknown')}: {trip_error}"
                    )
                    print(traceback.format_exc())

            for imei in AUTHORIZED_DEVICES:
                try:
                    count = trips_collection.count_documents({"imei": imei})
                    print(f"Trips in database for IMEI {imei}: {count}")
                except Exception as count_error:
                    print(
                        f"Error counting trips for IMEI {imei}: {count_error}")
    except Exception as fetch_error:
        print(f"Error in fetch_and_store_trips: {fetch_error}")
        print(traceback.format_exc())


def process_trip(trip):
    try:
        # Parse startTime
        if isinstance(trip["startTime"], str):
            parsed_start = parser.isoparse(trip["startTime"])
            if parsed_start.tzinfo is None:
                parsed_start = parsed_start.replace(tzinfo=timezone.utc)
            trip["startTime"] = parsed_start

        # Parse endTime
        if isinstance(trip["endTime"], str):
            parsed_end = parser.isoparse(trip["endTime"])
            if parsed_end.tzinfo is None:
                parsed_end = parsed_end.replace(tzinfo=timezone.utc)
            trip["endTime"] = parsed_end

        # Ensure datetime fields have tzinfo
        if trip["startTime"].tzinfo is None:
            trip["startTime"] = trip["startTime"].replace(tzinfo=timezone.utc)
        if trip["endTime"].tzinfo is None:
            trip["endTime"] = trip["endTime"].replace(tzinfo=timezone.utc)

        # Ensure gps field exists and is properly formatted
        if "gps" not in trip:
            logger.error(
                f"Trip {trip.get('transactionId', 'Unknown')} missing gps field"
            )
            return None

        # Convert gps to string if it's a dict
        if isinstance(trip["gps"], dict):
            trip["gps"] = json.dumps(trip["gps"])

        # Extract points from GPS data
        gps_data = geojson_loads(trip["gps"])
        if not gps_data.get("coordinates"):
            logger.error(
                f"Trip {trip.get('transactionId', 'Unknown')} has invalid GPS coordinates"
            )
            return None

        start_point = gps_data["coordinates"][0]
        last_point = gps_data["coordinates"][-1]

        trip["startGeoPoint"] = start_point
        trip["destinationGeoPoint"] = last_point

        # Ensure distance is a valid number
        if "distance" in trip:
            try:
                trip["distance"] = float(trip["distance"])
            except (ValueError, TypeError):
                trip["distance"] = 0.0
        else:
            trip["distance"] = 0.0

        return trip

    except Exception as e:
        logger.error(
            f"Error processing trip {trip.get('transactionId', 'Unknown')}: {str(e)}"
        )
        logger.debug(traceback.format_exc())
        return None


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/trips")
def trips_page():
    return render_template("trips.html")


@app.route("/driving-insights")
def driving_insights_page():
    return render_template("driving_insights.html")


@app.route("/visits")
def visits_page():
    return render_template("visits.html")


async def process_historical_trip(trip):
    trip_timezone = get_trip_timezone(trip)

    if isinstance(trip["startTime"], str):
        trip["startTime"] = parser.isoparse(trip["startTime"])
    if isinstance(trip["endTime"], str):
        trip["endTime"] = parser.isoparse(trip["endTime"])

    if isinstance(trip["startTime"], str):
        trip["startTime"] = parser.isoparse(trip["startTime"])
    if isinstance(trip["endTime"], str):
        trip["endTime"] = parser.isoparse(trip["endTime"])

    gps_data = geojson_module.loads(trip["gps"])
    start_point = gps_data["coordinates"][0]
    last_point = gps_data["coordinates"][-1]

    return trip


async def load_historical_data(start_date_str=None, end_date_str=None):
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

            except (json.JSONDecodeError, TypeError) as e:
                print(f"Error processing file {filename}: {e}")

    async def process_all_trips():
        tasks = [process_historical_trip(trip) for trip in all_trips]
        return await asyncio.gather(*tasks)

    processed_trips = await process_all_trips()

    inserted_count = 0
    for trip in processed_trips:
        try:
            if not historical_trips_collection.find_one(
                {"transactionId": trip["transactionId"]}
            ):
                historical_trips_collection.insert_one(trip)
                inserted_count += 1
                print(f"Inserted historical trip: {trip['transactionId']}")
            else:
                print(
                    f"Historical trip already exists: {trip['transactionId']}")
        except pymongo.errors.PyMongoError as e:
            print(
                f"Error inserting trip {trip.get('transactionId', 'Unknown')} into database: {e}"
            )

    return inserted_count


@app.route("/api/trips")
def get_trips():
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

    # Get trips from all collections
    regular_trips = list(trips_collection.find(query))
    uploaded_trips = list(uploaded_trips_collection.find(query))
    # Add historical trips
    historical_trips = list(historical_trips_collection.find(query))
    all_trips = regular_trips + uploaded_trips + \
        historical_trips  # Combine all trips

    features = []
    for trip in all_trips:
        try:
            # Ensure datetime fields have tzinfo
            if trip["startTime"].tzinfo is None:
                trip["startTime"] = trip["startTime"].replace(
                    tzinfo=timezone.utc)
            if trip["endTime"].tzinfo is None:
                trip["endTime"] = trip["endTime"].replace(tzinfo=timezone.utc)

            geometry = geojson_loads(
                trip["gps"] if isinstance(
                    trip["gps"], str) else json.dumps(trip["gps"])
            )
            properties = {
                "transactionId": trip["transactionId"],
                "imei": trip.get("imei", "UPLOAD"),
                # Include timezone information in the ISO format string
                "startTime": trip["startTime"].astimezone(timezone.utc).isoformat(),
                "endTime": trip["endTime"].astimezone(timezone.utc).isoformat(),
                "distance": float(trip.get("distance", 0)),
                "timezone": trip.get("timezone", "America/Chicago"),
                "maxSpeed": float(trip.get("maxSpeed", 0)),
                "startLocation": trip.get("startLocation", "N/A"),
                "destination": trip.get("destination", "N/A"),
                "totalIdleDuration": trip.get("totalIdleDuration", 0),
                "fuelConsumed": float(trip.get("fuelConsumed", 0)),
                "source": trip.get("source", "regular"),
            }
            feature = geojson_module.Feature(
                geometry=geometry, properties=properties)
            features.append(feature)
        except Exception as e:
            logger.error(
                f"Error processing trip {trip.get('transactionId', 'Unknown')}: {e}"
            )

    return jsonify(geojson_module.FeatureCollection(features))


@app.route("/api/driving-insights")
def get_driving_insights():
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

        # Aggregation pipeline for regular trips
        pipeline_trips = [
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
        ]

        # Aggregation pipeline for uploaded trips
        pipeline_uploaded = [
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
        ]

        # Aggregation pipeline for most visited destinations
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

        # Execute aggregations
        result_trips = list(trips_collection.aggregate(pipeline_trips))
        result_uploaded = list(
            uploaded_trips_collection.aggregate(pipeline_uploaded))
        result_most_visited_trips = list(
            trips_collection.aggregate(pipeline_most_visited)
        )
        result_most_visited_uploaded = list(
            uploaded_trips_collection.aggregate(pipeline_most_visited)
        )

        # Combine trip metrics
        combined_insights = {
            "total_trips": 0,
            "total_distance": 0.0,
            "total_fuel_consumed": 0.0,
            "max_speed": 0.0,
            "total_idle_duration": 0,
            "longest_trip_distance": 0.0,
            "most_visited": {},
        }

        if result_trips:
            combined_insights["total_trips"] += result_trips[0].get(
                "total_trips", 0)
            combined_insights["total_distance"] += result_trips[0].get(
                "total_distance", 0.0
            )
            combined_insights["total_fuel_consumed"] += result_trips[0].get(
                "total_fuel_consumed", 0.0
            )
            combined_insights["max_speed"] = max(
                combined_insights["max_speed"], result_trips[0].get(
                    "max_speed", 0.0)
            )
            combined_insights["total_idle_duration"] += result_trips[0].get(
                "total_idle_duration", 0
            )
            combined_insights["longest_trip_distance"] = max(
                combined_insights["longest_trip_distance"],
                result_trips[0].get("longest_trip_distance", 0.0),
            )

        if result_uploaded:
            combined_insights["total_trips"] += result_uploaded[0].get(
                "total_trips", 0)
            combined_insights["total_distance"] += result_uploaded[0].get(
                "total_distance", 0.0
            )
            combined_insights["total_fuel_consumed"] += result_uploaded[0].get(
                "total_fuel_consumed", 0.0
            )
            combined_insights["max_speed"] = max(
                combined_insights["max_speed"], result_uploaded[0].get(
                    "max_speed", 0.0)
            )
            combined_insights["total_idle_duration"] += result_uploaded[0].get(
                "total_idle_duration", 0
            )
            combined_insights["longest_trip_distance"] = max(
                combined_insights["longest_trip_distance"],
                result_uploaded[0].get("longest_trip_distance", 0.0),
            )

        # Combine most visited destinations
        all_most_visited = result_most_visited_trips + result_most_visited_uploaded
        if all_most_visited:
            # Sort by count in descending order
            all_most_visited_sorted = sorted(
                all_most_visited, key=lambda x: x["count"], reverse=True
            )
            top_destination = all_most_visited_sorted[0]
            combined_insights["most_visited"] = {
                "_id": top_destination["_id"],
                "count": top_destination["count"],
                "isCustomPlace": top_destination.get("isCustomPlace", False),
            }

        return jsonify(
            {
                "total_trips": combined_insights["total_trips"],
                "total_distance": round(combined_insights["total_distance"], 2),
                "total_fuel_consumed": round(
                    combined_insights["total_fuel_consumed"], 2
                ),
                "max_speed": round(combined_insights["max_speed"], 2),
                "total_idle_duration": combined_insights["total_idle_duration"],
                "longest_trip_distance": round(
                    combined_insights["longest_trip_distance"], 2
                ),
                "most_visited": combined_insights["most_visited"],
            }
        )
    except Exception as e:
        logger.error(f"Error in get_driving_insights: {str(e)}")
        return jsonify({"error": str(e)}), 500


def calculate_insights_for_historical_data(start_date_str, end_date_str, imei):
    start_date = (
        datetime.fromisoformat(start_date_str).replace(tzinfo=timezone.utc)
        if start_date_str
        else None
    )
    end_date = (
        datetime.fromisoformat(end_date_str).replace(tzinfo=timezone.utc)
        if end_date_str
        else None
    )

    query = {}
    if start_date and end_date:
        query["startTime"] = {"$gte": start_date, "$lte": end_date}
    all_trips = list(historical_trips_collection.find(query))

    insights = {}
    for trip in all_trips:
        destination = trip.get("destination", "N/A")
        if destination not in insights:
            insights[destination] = {
                "_id": destination,
                "count": 0,
                "totalDistance": 0,
                "averageDistance": 0,
                "lastVisit": datetime.min.replace(tzinfo=timezone.utc),
            }
        insights[destination]["count"] += 1
        insights[destination]["totalDistance"] += trip.get("distance", 0)
        insights[destination]["lastVisit"] = max(
            insights[destination]["lastVisit"], trip["endTime"]
        )

    for destination in insights:
        insights[destination]["averageDistance"] = (
            insights[destination]["totalDistance"] /
            insights[destination]["count"]
            if insights[destination]["count"] > 0
            else 0
        )

    return list(insights.values())


@app.route("/api/metrics")
def get_metrics():
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

    trips = list(trips_collection.find(query))
    historical_trips = list(historical_trips_collection.find(query))
    all_trips = trips + historical_trips

    total_trips = len(all_trips)
    total_distance = sum(trip.get("distance", 0) for trip in all_trips)
    avg_distance = total_distance / total_trips if total_trips > 0 else 0

    start_times = [
        trip["startTime"].astimezone(pytz.timezone("America/Chicago")).hour
        for trip in all_trips
    ]
    avg_start_time = sum(start_times) / len(start_times) if start_times else 0

    hour = int(avg_start_time)
    minutes = int((avg_start_time % 1) * 60)
    period = "AM" if hour < 12 else "PM"
    if hour == 0:
        hour = 12
    elif hour > 12:
        hour -= 12

    driving_times = [
        (trip["endTime"] - trip["startTime"]).total_seconds() / 60 for trip in all_trips
    ]
    avg_driving_time = sum(driving_times) / \
        len(driving_times) if driving_times else 0

    return jsonify(
        {
            "total_trips": total_trips,
            "total_distance": f"{round(total_distance, 2)}",
            "avg_distance": f"{round(avg_distance, 2)}",
            "avg_start_time": f"{hour:02d}:{minutes:02d} {period}",
            "avg_driving_time": f"{int(avg_driving_time // 60):02d}:{int(avg_driving_time % 60):02d}",
        }
    )


@app.route("/api/fetch_trips", methods=["POST"])
async def api_fetch_trips():
    try:
        await fetch_and_store_trips()
        return (
            jsonify(
                {
                    "status": "success",
                    "message": "Trips fetched and stored successfully.",
                }
            ),
            200,
        )
    except Exception as fetch_error:
        return jsonify({"status": "error", "message": str(fetch_error)}), 500


@app.route("/api/fetch_trips_range", methods=["POST"])
def api_fetch_trips_range():
    try:
        data = request.json
        start_date = datetime.fromisoformat(data["start_date"]).replace(
            tzinfo=timezone.utc
        )
        end_date = datetime.fromisoformat(data["end_date"]).replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc
        ) + timedelta(days=1)
        asyncio.run(fetch_and_store_trips_in_range(start_date, end_date))
        return (
            jsonify(
                {
                    "status": "success",
                    "message": "Trips fetched and stored successfully.",
                }
            ),
            200,
        )
    except Exception as fetch_error:
        return jsonify({"status": "error", "message": str(fetch_error)}), 500


@app.after_request
def add_header(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@app.route("/export/geojson")
def export_geojson():
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
            if "startTime" in query:
                query["startTime"]["$lte"] = end_date
            else:
                query["startTime"] = {"$lte": end_date}
        if imei:
            query["imei"] = imei

        print(f"Export GeoJSON Query: {query}")

        trips_cursor = trips_collection.find(query)
        trips = list(trips_cursor)

        if not trips:
            return jsonify({"error": "No trips found for the specified filters."}), 404

        geojson = {"type": "FeatureCollection", "features": []}

        for trip in trips:
            gps_data = trip["gps"]
            if isinstance(gps_data, str):
                gps_data = json.loads(gps_data)

            feature = {
                "type": "Feature",
                "geometry": gps_data,
                "properties": {
                    "transactionId": trip["transactionId"],
                    "startTime": trip["startTime"].isoformat(),
                    "endTime": trip["endTime"].isoformat(),
                    "distance": trip["distance"],
                    "imei": trip["imei"],
                },
            }
            geojson["features"].append(feature)

        return jsonify(geojson)
    except Exception as e:
        print(f"Error exporting GeoJSON: {str(e)}")
        return jsonify({"error": "An error occurred while exporting GeoJSON."}), 500


@app.route("/export/gpx")
def export_gpx():
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
            if "startTime" in query:
                query["startTime"]["$lte"] = end_date
            else:
                query["startTime"] = {"$lte": end_date}
        if imei:
            query["imei"] = imei

        print(f"Export GPX Query: {query}")

        trips_cursor = trips_collection.find(query)
        trips = list(trips_cursor)

        if not trips:
            return jsonify({"error": "No trips found for the specified filters."}), 404

        gpx = gpxpy.gpx.GPX()

        for trip in trips:
            gpx_track = gpxpy.gpx.GPXTrack()
            gpx.tracks.append(gpx_track)

            gpx_segment = gpxpy.gpx.GPXTrackSegment()
            gpx_track.segments.append(gpx_segment)

            gps_data = trip["gps"]
            if isinstance(gps_data, str):
                try:
                    gps_data = json.loads(gps_data)
                except json.JSONDecodeError as json_error:
                    print(
                        f"Error decoding GPS JSON for trip {trip.get('transactionId', 'Unknown')}: {json_error}"
                    )
                    continue

            if gps_data.get("type") == "LineString":
                for coord in gps_data.get("coordinates", []):
                    if isinstance(coord, list) and len(coord) >= 2:
                        lon, lat = coord[0], coord[1]
                        gpx_segment.points.append(
                            gpxpy.gpx.GPXTrackPoint(lat, lon))
            elif gps_data.get("type") == "Point":
                coord = gps_data.get("coordinates", [])
                if isinstance(coord, list) and len(coord) >= 2:
                    lon, lat = coord[0], coord[1]
                    gpx_segment.points.append(
                        gpxpy.gpx.GPXTrackPoint(lat, lon))
            else:
                print(
                    f"Unsupported GPS type '{gps_data.get('type')}' for trip {trip.get('transactionId', 'Unknown')}. Skipping."
                )
                continue

            gpx_track.name = trip.get("transactionId", "Unnamed Trip")
            gpx_track.description = f"Trip from {trip.get('startLocation', 'Unknown')} to {trip.get('destination', 'Unknown')}"

        gpx_xml = gpx.to_xml()

        return Response(
            gpx_xml,
            mimetype="application/gpx+xml",
            headers={"Content-Disposition": "attachment;filename=trips.gpx"},
        )

    except Exception as e:
        print(f"Error exporting GPX: {e}")
        print(traceback.format_exc())
        return (
            jsonify({"error": f"An error occurred while exporting GPX: {str(e)}"}),
            500,
        )


async def start_background_tasks():
    await fetch_and_store_trips()


@app.route("/api/validate_location", methods=["POST"])
def validate_location():
    data = request.json
    location = data.get("location")
    location_type = data.get("locationType")
    validated_location = validate_location_osm(location, location_type)
    return jsonify(validated_location)


@app.route("/api/generate_geojson", methods=["POST"])
def generate_geojson():
    try:
        data = request.json
        print("Received data:", data)
        location = data.get("location")
        streets_only = data.get("streetsOnly", False)
        geojson_data, error_message = generate_geojson_osm(
            location, streets_only)
        if geojson_data:
            return jsonify(geojson_data)
        return jsonify({"error": error_message}), 400
    except Exception as e:
        return (
            jsonify({"status": "error", "message": f"An error occurred: {str(e)}"}),
            500,
        )


def validate_location_osm(location, location_type):
    params = {"q": location, "format": "json",
              "limit": 1, "featuretype": location_type}
    headers = {"User-Agent": "GeojsonGenerator/1.0"}
    response = requests.get(
        "https://nominatim.openstreetmap.org/search", params=params, headers=headers
    )
    if response.status_code == 200:
        data = response.json()
        return data[0] if data else None
    return None


def generate_geojson_osm(location, streets_only=False):
    try:
        if not isinstance(location, dict):
            return None, "Invalid location format"

        if "osm_id" not in location or "osm_type" not in location:
            return None, "Missing osm_id or osm_type in location data"

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

        response = requests.get(
            "http://overpass-api.de/api/interpreter", params={"data": query}
        )
        if response.status_code != 200:
            return None, "Failed to get response from Overpass API"

        data = response.json()
        features = process_elements(data["elements"], streets_only)

        if features:
            gdf = gpd.GeoDataFrame.from_features(features)
            gdf = gdf.set_geometry("geometry")
            return json.loads(gdf.to_json()), None
        return None, f"No features found. Raw response: {json.dumps(data)}"
    except Exception as e:
        print(f"Error generating GeoJSON: {str(e)}")
        return None, f"An error occurred while generating GeoJSON: {str(e)}"


def process_elements(elements, streets_only):
    features = []
    ways = {e["id"]: e for e in elements if e["type"] == "way"}

    for element in elements:
        if element["type"] == "way":
            coords = [
                (node["lon"], node["lat"]) for node in element.get("geometry", [])
            ]
            if len(coords) >= 2:
                geom = (
                    LineString(coords)
                    if streets_only
                    else (
                        Polygon(coords)
                        if coords[0] == coords[-1]
                        else LineString(coords)
                    )
                )
                geom = geom.__geo_interface__
                features.append(
                    {
                        "type": "Feature",
                        "geometry": geom,
                        "properties": element.get("tags", {}),
                    }
                )
        elif element["type"] == "relation" and not streets_only:
            outer_rings = []
            for member in element.get("members", []):
                if member["type"] == "way" and member["role"] == "outer":
                    way = ways.get(member["ref"])
                    if way:
                        coords = [
                            (node["lon"], node["lat"])
                            for node in way.get("geometry", [])
                        ]
                        if len(coords) >= 3 and coords[0] == coords[-1]:
                            outer_rings.append(Polygon(coords))
            if outer_rings:
                geom = (
                    outer_rings[0]
                    if len(outer_rings) == 1
                    else MultiPolygon(outer_rings)
                )
                features.append(
                    {
                        "type": "Feature",
                        "geometry": geom.__geo_interface__,
                        "properties": element.get("tags", {}),
                    }
                )
    return features


# Map Matching Functions
MAX_MAPBOX_COORDINATES = 100


async def map_match_coordinates(coordinates):
    if len(coordinates) < 2:
        return {
            "code": "Error",
            "message": "At least two coordinates are required for map matching.",
        }

    url = "https://api.mapbox.com/matching/v5/mapbox/driving/"

    chunks = [
        coordinates[i: i + MAX_MAPBOX_COORDINATES]
        for i in range(0, len(coordinates), MAX_MAPBOX_COORDINATES)
    ]
    matched_geometries = []

    async with aiohttp.ClientSession() as client_session:
        for chunk in chunks:
            coordinates_str = ";".join([f"{lon},{lat}" for lon, lat in chunk])
            url_with_coords = url + coordinates_str

            params = {
                "access_token": MAPBOX_ACCESS_TOKEN,
                "geometries": "geojson",
                "radiuses": ";".join(["25" for _ in chunk]),
            }

            async with client_session.get(url_with_coords, params=params) as response:
                if response.status == 200:
                    data = await response.json()
                    if data["code"] == "Ok":
                        matched_geometries.extend(
                            data["matchings"][0]["geometry"]["coordinates"]
                        )
                    else:
                        print(
                            f"Error map-matching chunk: {data.get('message', 'Map Matching API Error')}"
                        )
                        return {
                            "code": "Error",
                            "message": data.get("message", "Map Matching API Error"),
                        }
                elif response.status == 422:
                    error_data = await response.json()
                    print(
                        f"Error map-matching chunk: Status 422, Message: {error_data.get('message', 'No message')}, Coordinates: {chunk}"
                    )
                    return {
                        "code": "Error",
                        "message": error_data.get(
                            "message", "Map Matching API Error 422"
                        ),
                    }
                else:
                    print(
                        f"Error map-matching chunk: Map Matching API request failed with status {response.status}"
                    )
                    return {
                        "code": "Error",
                        "message": f"Map Matching API request failed with status {response.status}",
                    }

    return {
        "code": "Ok",
        "matchings": [
            {"geometry": {"coordinates": matched_geometries, "type": "LineString"}}
        ],
    }


def is_valid_coordinate(coord):
    """Check if a coordinate pair is valid."""
    lon, lat = coord
    return -180 <= lon <= 180 and -90 <= lat <= 90


async def process_and_map_match_trip(trip):
    try:
        # Validate trip data before processing
        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.error(
                f"Invalid trip data for map matching: {error_message}")
            return None

        existing_matched_trip = matched_trips_collection.find_one(
            {"transactionId": trip["transactionId"]}
        )
        if existing_matched_trip:
            print(
                f"Trip {trip['transactionId']} already map-matched. Skipping.")
            return

        if trip["imei"] == "HISTORICAL":
            coords = geojson_loads(trip["gps"])["coordinates"]
            total_distance = 0
            for i in range(len(coords) - 1):
                total_distance += haversine_distance(coords[i], coords[i + 1])
            trip["distance"] = total_distance

        gps_data = geojson_loads(trip["gps"])
        coordinates = gps_data["coordinates"]

        if not coordinates:
            print(
                f"Error: Trip {trip['transactionId']} has no coordinates. Skipping.")
            return

        if not all(is_valid_coordinate(coord) for coord in coordinates):
            print(
                f"Error: Trip {trip['transactionId']} has invalid coordinates. Skipping."
            )
            return

        map_match_result = await map_match_coordinates(coordinates)

        if map_match_result["code"] == "Ok":
            matched_trip = trip.copy()
            matched_trip["matchedGps"] = geojson_dumps(
                map_match_result["matchings"][0]["geometry"]
            )
            matched_trips_collection.insert_one(matched_trip)
            print(f"Trip {trip['transactionId']} map-matched and stored.")
        else:
            print(
                f"Error map-matching trip {trip['transactionId']}: {map_match_result['message']}"
            )

    except Exception as e:
        logger.error(
            f"Error processing and map-matching trip {trip.get('transactionId', 'Unknown')}: {str(e)}"
        )
        return None


def haversine_distance(coord1, coord2):
    R = 6371
    lat1, lon1 = math.radians(coord1[1]), math.radians(coord1[0])
    lat2, lon2 = math.radians(coord2[1]), math.radians(coord2[0])

    dlon = lon2 - lon1
    dlat = lat2 - lat1

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    distance = R * c
    return distance * 0.621371


@app.route("/api/map_match_trips", methods=["POST"])
async def map_match_trips():
    try:
        data = request.json
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
        for trip in trips:
            await process_and_map_match_trip(trip)
        return jsonify(
            {
                "status": "success",
                "message": "Map matching initiated for trips within the date range.",
            }
        )
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/map_match_historical_trips", methods=["POST"])
async def map_match_historical_trips():
    try:
        data = request.json
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

        historical_trips = historical_trips_collection.find(query)
        for trip in historical_trips:
            await process_and_map_match_trip(trip)
        return jsonify(
            {
                "status": "success",
                "message": "Map matching initiated for historical trips within the date range.",
            }
        )
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/matched_trips")
def get_matched_trips():
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

    matched_trips = list(matched_trips_collection.find(query))

    return jsonify(
        geojson_module.FeatureCollection(
            [
                geojson_module.Feature(
                    geometry=geojson_loads(trip["matchedGps"]),
                    properties={
                        "transactionId": trip["transactionId"],
                        "imei": trip["imei"],
                        "startTime": trip["startTime"].isoformat(),
                        "endTime": trip["endTime"].isoformat(),
                        "distance": trip.get("distance", 0),
                        "timezone": trip.get("timezone", "America/Chicago"),
                        "destination": trip.get("destination", "N/A"),
                        "startLocation": trip.get("startLocation", "N/A"),
                    },
                )
                for trip in matched_trips
            ]
        )
    )


@app.route("/export")
def export_page():
    return render_template("export.html")


@app.route("/api/export/trips")
def export_trips():
    start_date = request.args.get("start_date")
    end_date = request.args.get("end_date")
    export_format = request.args.get("format")

    trips = fetch_trips(start_date, end_date)

    if export_format == "geojson":
        geojson_data = create_geojson(trips)
        return send_file(
            io.BytesIO(geojson_data.encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            download_name="trips.geojson",
        )
    if export_format == "gpx":
        gpx_data = create_gpx(trips)
        return send_file(
            io.BytesIO(gpx_data.encode()),
            mimetype="application/gpx+xml",
            as_attachment=True,
            download_name="trips.gpx",
        )


@app.route("/api/export/matched_trips")
def export_matched_trips():
    start_date = request.args.get("start_date")
    end_date = request.args.get("end_date")
    export_format = request.args.get("format")

    matched_trips = fetch_matched_trips(start_date, end_date)

    if export_format == "geojson":
        geojson_data = create_geojson(matched_trips)
        return send_file(
            io.BytesIO(geojson_data.encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            download_name="matched_trips.geojson",
        )
    if export_format == "gpx":
        gpx_data = create_gpx(matched_trips)
        return send_file(
            io.BytesIO(gpx_data.encode()),
            mimetype="application/gpx+xml",
            as_attachment=True,
            download_name="matched_trips.gpx",
        )


@app.route("/api/export/streets")
def export_streets():
    location = request.args.get("location")
    export_format = request.args.get("format")

    streets_data, _ = generate_geojson_osm(
        json.loads(location), streets_only=True)

    if export_format == "geojson":
        return send_file(
            io.BytesIO(json.dumps(streets_data).encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            download_name="streets.geojson",
        )
    if export_format == "shapefile":
        gdf = gpd.GeoDataFrame.from_features(streets_data["features"])
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zf:
            for ext in ["shp", "shx", "dbf", "prj"]:
                temp_file = io.BytesIO()
                gdf.to_file(temp_file, driver="ESRI Shapefile")
                temp_file.seek(0)
                zf.writestr(f"streets.{ext}", temp_file.getvalue())
        buffer.seek(0)
        return send_file(
            buffer,
            mimetype="application/zip",
            as_attachment=True,
            download_name="streets.zip",
        )


@app.route("/api/export/boundary")
def export_boundary():
    location = request.args.get("location")
    export_format = request.args.get("format")

    boundary_data, _ = generate_geojson_osm(
        json.loads(location), streets_only=False)

    if export_format == "geojson":
        return send_file(
            io.BytesIO(json.dumps(boundary_data).encode()),
            mimetype="application/geo+json",
            as_attachment=True,
            download_name="boundary.geojson",
        )
    if export_format == "shapefile":
        gdf = gpd.GeoDataFrame.from_features(boundary_data["features"])
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as zf:
            for ext in ["shp", "shx", "dbf", "prj"]:
                temp_file = io.BytesIO()
                gdf.to_file(temp_file, driver="ESRI Shapefile")
                temp_file.seek(0)
                zf.writestr(f"boundary.{ext}", temp_file.getvalue())
        buffer.seek(0)
        return send_file(
            buffer,
            mimetype="application/zip",
            as_attachment=True,
            download_name="boundary.zip",
        )


def fetch_trips(start_date, end_date):
    start_date = parser.parse(start_date)
    end_date = parser.parse(end_date)
    query = {"startTime": {"$gte": start_date, "$lte": end_date}}
    return list(trips_collection.find(query))


def fetch_matched_trips(start_date, end_date):
    start_date = parser.parse(start_date)
    end_date = parser.parse(end_date)
    query = {"startTime": {"$gte": start_date, "$lte": end_date}}
    return list(matched_trips_collection.find(query))


def create_geojson(trips):
    features = []
    for trip in trips:
        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        feature = {
            "type": "Feature",
            "geometry": gps_data,
            "properties": {
                "transactionId": trip.get("transactionId"),
                "startTime": trip.get("startTime").isoformat(),
                "endTime": trip.get("endTime").isoformat(),
                "distance": trip.get("distance"),
                "startLocation": trip.get("startLocation"),
                "destination": trip.get("destination"),
            },
        }
        features.append(feature)

    geojson = {"type": "FeatureCollection", "features": features}
    return json.dumps(geojson)


def create_gpx(trips):
    gpx = gpxpy.gpx.GPX()

    for trip in trips:
        gpx_track = gpxpy.gpx.GPXTrack()
        gpx.tracks.append(gpx_track)

        gpx_segment = gpxpy.gpx.GPXTrackSegment()
        gpx_track.segments.append(gpx_segment)

        gps_data = trip["gps"]
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)

        if gps_data.get("type") == "LineString":
            for coord in gps_data.get("coordinates", []):
                if isinstance(coord, list) and len(coord) >= 2:
                    lon, lat = coord[0], coord[1]
                    gpx_segment.points.append(
                        gpxpy.gpx.GPXTrackPoint(lat, lon))
        elif gps_data.get("type") == "Point":
            coord = gps_data.get("coordinates", [])
            if isinstance(coord, list) and len(coord) >= 2:
                lon, lat = coord[0], coord[1]
                gpx_segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))

        gpx_track.name = trip.get("transactionId", "Unnamed Trip")
        gpx_track.description = f"Trip from {trip.get('startLocation', 'Unknown')} to {trip.get('destination', 'Unknown')}"

    return gpx.to_xml()


@app.route("/api/streets", methods=["POST"])
def get_streets():
    location = request.json.get("location")

    if not location or not isinstance(location, dict) or "type" not in location:
        return jsonify({"status": "error", "message": "Invalid location data."}), 400

    try:
        streets_data, error_message = generate_geojson_osm(
            location, streets_only=True)

        if streets_data is None:
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": f"Error fetching street data: {error_message}",
                    }
                ),
                500,
            )

        trips = list(trips_collection.find())
        trip_geometries = []
        for trip in trips:
            gps_data = trip["gps"]
            if isinstance(gps_data, str):
                gps_data = json.loads(gps_data)
            geom = shape(gps_data)
            if isinstance(geom, LineString):
                trip_geometries.append(geom)
            elif isinstance(geom, MultiLineString):
                trip_geometries.extend(geom.geoms)

        streets_gdf = gpd.GeoDataFrame.from_features(streets_data["features"])
        streets_gdf.set_crs(epsg=4326, inplace=True)

        if trip_geometries:
            trips_merged = linemerge(trip_geometries)
            streets_gdf["driven"] = streets_gdf.geometry.intersects(
                trips_merged)
        else:
            streets_gdf["driven"] = False

        streets_json = json.loads(streets_gdf.to_json())
        return jsonify(streets_json)
    except Exception as e:
        return (
            jsonify({"status": "error", "message": f"An error occurred: {str(e)}"}),
            500,
        )


@app.route("/load_historical_data", methods=["POST"])
async def load_historical_data_endpoint():
    start_date = request.json.get("start_date")
    end_date = request.json.get("end_date")
    inserted_count = await load_historical_data(start_date, end_date)
    return jsonify(
        {
            "message": f"Historical data loaded successfully. {inserted_count} new trips inserted."
        }
    )


def process_street_chunk(streets_chunk, all_trips):
    return streets_chunk.intersects(all_trips)


def calculate_street_coverage(boundary_geojson, streets_geojson, matched_trips):
    try:
        logger.info("Converting streets to GeoDataFrame...")
        streets_gdf = gpd.GeoDataFrame.from_features(
            streets_geojson["features"])
        streets_gdf.set_crs(epsg=4326, inplace=True)

        logger.info("Converting to projected CRS...")
        center_lat = streets_gdf.geometry.centroid.y.mean()
        center_lon = streets_gdf.geometry.centroid.x.mean()
        utm_zone = int((center_lon + 180) / 6) + 1
        utm_crs = (
            f"EPSG:326{utm_zone:02d}" if center_lat >= 0 else f"EPSG:327{utm_zone:02d}"
        )

        streets_gdf = streets_gdf.to_crs(utm_crs)

        logger.info("Processing matched trips...")
        chunk_size = 100
        all_lines = []

        for i in range(0, len(matched_trips), chunk_size):
            chunk = matched_trips[i: i + chunk_size]
            logger.info(
                f"Processing chunk {i//chunk_size + 1}/{len(matched_trips)//chunk_size + 1}"
            )

            for trip in chunk:
                try:
                    trip_geom = shape(json.loads(trip["matchedGps"]))
                    if isinstance(trip_geom, LineString):
                        all_lines.append(trip_geom)
                    elif isinstance(trip_geom, MultiLineString):
                        all_lines.extend(list(trip_geom.geoms))
                except Exception as e:
                    logger.error(f"Error processing trip: {e}")
                    continue

        logger.info("Merging trip lines...")
        all_trips = linemerge(all_lines)

        logger.info("Creating trips GeoDataFrame...")
        trips_gdf = gpd.GeoDataFrame(geometry=[all_trips], crs=4326)
        trips_gdf = trips_gdf.to_crs(utm_crs)

        logger.info("Performing spatial join...")
        joined = gpd.sjoin(streets_gdf, trips_gdf,
                           predicate="intersects", how="left")
        streets_gdf["driven"] = ~joined.index_right.isna()

        logger.info("Calculating final statistics...")
        total_length = streets_gdf.geometry.length.sum()
        driven_length = streets_gdf[streets_gdf["driven"]
                                    ].geometry.length.sum()
        coverage_percentage = (driven_length / total_length) * 100

        logger.info("Converting back to WGS84 for output...")
        streets_gdf = streets_gdf.to_crs(epsg=4326)

        geojson_data = {"type": "FeatureCollection", "features": []}

        for idx, row in streets_gdf.iterrows():
            feature = {
                "type": "Feature",
                "geometry": mapping(row.geometry),
                "properties": {
                    "driven": bool(row["driven"]),
                    "name": row.get("name", "Unknown Street"),
                },
            }
            geojson_data["features"].append(feature)

        return {
            "total_length": float(total_length),
            "driven_length": float(driven_length),
            "coverage_percentage": float(coverage_percentage),
            "streets_data": geojson_data,
        }
    except Exception as e:
        logger.error(
            f"Error in calculate_street_coverage: {str(e)}\n{traceback.format_exc()}"
        )
        raise


def split_line_into_segments(line, segment_length_meters=10):
    """Split a line into smaller segments of approximately equal length"""
    try:
        # Validate input geometry
        if not isinstance(line, LineString):
            logger.warning(
                f"Non-LineString geometry encountered: {type(line)}")
            return [line]

        if line.is_empty or not line.is_valid:
            logger.warning("Empty or invalid geometry encountered")
            return [line]

        if line.length == 0:
            logger.warning("Zero-length line encountered")
            return [line]

        # Convert to UTM for accurate distance measurements
        center_lat = line.centroid.y
        center_lon = line.centroid.x
        utm_zone = int((center_lon + 180) / 6) + 1
        utm_crs = (
            f"EPSG:326{utm_zone:02d}" if center_lat >= 0 else f"EPSG:327{utm_zone:02d}"
        )

        # Use the new pyproj transform approach
        transformer = Transformer.from_crs(
            "EPSG:4326", utm_crs, always_xy=True)
        x_coords, y_coords = transformer.transform(line.xy[0], line.xy[1])
        line_utm = LineString(zip(x_coords, y_coords))

        # Calculate number of segments needed
        total_length = line_utm.length
        if total_length <= 0 or math.isnan(total_length):
            logger.warning(f"Invalid line length: {total_length}")
            return [line]

        num_segments = max(1, int(total_length / segment_length_meters))

        segments = []
        for i in range(num_segments):
            start_dist = i * segment_length_meters
            end_dist = min((i + 1) * segment_length_meters, total_length)

            # Extract segment
            start_point = line_utm.interpolate(start_dist)
            end_point = line_utm.interpolate(end_dist)
            segment_utm = LineString([start_point, end_point])

            # Convert back to WGS84
            transformer = Transformer.from_crs(
                utm_crs, "EPSG:4326", always_xy=True)
            segment_coords = transformer.transform(
                [p[0] for p in segment_utm.coords], [p[1]
                                                     for p in segment_utm.coords]
            )
            segment = LineString(zip(segment_coords[0], segment_coords[1]))
            segments.append(segment)

        return segments

    except Exception as e:
        logger.error(f"Error in split_line_into_segments: {str(e)}")
        return [line]  # Return original line if splitting fails


def calculate_street_coverage(boundary_geojson, streets_geojson, matched_trips):
    try:
        logger.info("Converting streets to GeoDataFrame...")
        streets_gdf = gpd.GeoDataFrame.from_features(
            streets_geojson["features"])
        streets_gdf.set_crs(epsg=4326, inplace=True)

        # Calculate the center point to determine UTM zone
        center_lat = streets_gdf.geometry.centroid.y.mean()
        center_lon = streets_gdf.geometry.centroid.x.mean()
        utm_zone = int((center_lon + 180) / 6) + 1
        utm_epsg = 32600 + utm_zone if center_lat >= 0 else 32700 + utm_zone

        logger.info("Splitting streets into segments...")
        segmented_streets = []
        for idx, row in streets_gdf.iterrows():
            segments = split_line_into_segments(row.geometry)
            for segment in segments:
                segmented_streets.append(
                    {"geometry": segment, "properties": row.drop(
                        "geometry").to_dict()}
                )

        streets_gdf = gpd.GeoDataFrame.from_features(segmented_streets)
        streets_gdf.set_crs(epsg=4326, inplace=True)

        logger.info("Processing matched trips...")
        all_lines = []
        for trip in matched_trips:
            try:
                trip_geom = shape(json.loads(trip["matchedGps"]))
                if isinstance(trip_geom, LineString):
                    all_lines.append(trip_geom)
                elif isinstance(trip_geom, MultiLineString):
                    all_lines.extend(list(trip_geom.geoms))
            except Exception as e:
                logger.error(f"Error processing trip: {e}")
                continue

        logger.info("Merging trip lines...")
        all_trips = linemerge(all_lines)

        logger.info("Creating trips GeoDataFrame...")
        trips_gdf = gpd.GeoDataFrame(geometry=[all_trips], crs=4326)

        logger.info("Performing spatial join...")
        joined = gpd.sjoin(streets_gdf, trips_gdf,
                           predicate="intersects", how="left")
        streets_gdf["driven"] = ~joined.index_right.isna()

        # Calculate statistics using the correct UTM projection
        streets_utm = streets_gdf.to_crs(epsg=utm_epsg)
        total_length = streets_utm.geometry.length.sum()
        driven_length = streets_utm[streets_utm["driven"]
                                    ].geometry.length.sum()
        coverage_percentage = (driven_length / total_length) * 100

        # Prepare output GeoJSON
        streets_gdf = streets_gdf.dissolve(
            by=["name", "driven"], as_index=False)

        geojson_data = {"type": "FeatureCollection", "features": []}

        for idx, row in streets_gdf.iterrows():
            feature = {
                "type": "Feature",
                "geometry": mapping(row.geometry),
                "properties": {
                    "driven": bool(row["driven"]),
                    "name": row.get("name", "Unknown Street"),
                },
            }
            geojson_data["features"].append(feature)

        return {
            "total_length": float(total_length),
            "driven_length": float(driven_length),
            "coverage_percentage": float(coverage_percentage),
            "streets_data": geojson_data,
        }

    except Exception as e:
        logger.error(
            f"Error in calculate_street_coverage: {str(e)}\n{traceback.format_exc()}"
        )
        raise


@app.route("/api/coverage", methods=["POST"])
def get_coverage():
    try:
        data = request.json
        boundary_geojson = data.get("boundary")
        streets_geojson = data.get("streets")

        # Fetch matched trips from the database
        matched_trips = list(matched_trips_collection.find())

        coverage_data = calculate_street_coverage(
            boundary_geojson, streets_geojson, matched_trips
        )

        return jsonify(coverage_data)
    except Exception as e:
        logger.error(f"Error calculating coverage: {str(e)}")
        return (
            jsonify(
                {"status": "error",
                    "message": f"Error calculating coverage: {str(e)}"}
            ),
            500,
        )


@app.route("/api/last_trip_point")
def get_last_trip_point():
    try:
        most_recent_trip = trips_collection.find_one(
            sort=[("endTime", pymongo.DESCENDING)]
        )

        if not most_recent_trip:
            # Return null instead of 404
            return jsonify({"lastPoint": None}), 200

        try:
            # Handle string GPS data
            if isinstance(most_recent_trip["gps"], str):
                gps_data = geojson_loads(most_recent_trip["gps"])
            # Handle dictionary GPS data
            else:
                gps_data = most_recent_trip["gps"]

            # Ensure we have coordinates
            if (
                not gps_data
                or "coordinates" not in gps_data
                or not gps_data["coordinates"]
            ):
                return jsonify({"lastPoint": None}), 200

            last_point = gps_data["coordinates"][-1]
            return jsonify({"lastPoint": last_point})

        except (KeyError, ValueError, TypeError) as e:
            logger.error(f"Error parsing GPS data: {str(e)}")
            return jsonify({"lastPoint": None}), 200

    except Exception as e:
        logger.error(f"Error fetching last trip point: {str(e)}")
        return (
            jsonify(
                {"error": "An error occurred while fetching the last trip point."}),
            500,
        )


@app.route("/upload")
def upload_page():
    return render_template("upload.html")


def meters_to_miles(meters):
    return meters * 0.000621371  # Convert meters to miles


def calculate_gpx_distance(coordinates):
    """Calculate distance in meters between a series of [lon, lat] coordinates"""
    total_distance = 0
    for i in range(len(coordinates) - 1):
        lon1, lat1 = coordinates[i]
        lon2, lat2 = coordinates[i + 1]
        # Calculate distance using haversine formula
        distance = gpxpy.geo.haversine_distance(lat1, lon1, lat2, lon2)
        total_distance += distance
    return total_distance


@app.route("/api/upload_gpx", methods=["POST"])
async def upload_gpx():
    try:
        files = request.files.getlist("files[]")
        uploaded_trips = []

        for file in files:
            if file.filename.endswith(".gpx"):
                # Process GPX file
                gpx_data = file.read()
                gpx = gpxpy.parse(gpx_data)

                for track in gpx.tracks:
                    for segment in track.segments:
                        coordinates = [
                            [point.longitude, point.latitude]
                            for point in segment.points
                        ]
                        if len(coordinates) < 2:
                            continue

                        points_with_time = [
                            point for point in segment.points if point.time
                        ]
                        if points_with_time:
                            start_time = min(p.time for p in points_with_time)
                            end_time = max(p.time for p in points_with_time)
                        else:
                            start_time = datetime.now(timezone.utc)
                            end_time = start_time

                        gps_data = {"type": "LineString",
                                    "coordinates": coordinates}

                        distance_meters = calculate_gpx_distance(coordinates)
                        distance_miles = meters_to_miles(distance_meters)

                        trip = {
                            "transactionId": f"GPX-{start_time.strftime('%Y%m%d%H%M%S')}-{file.filename}",
                            "startTime": start_time,
                            "endTime": end_time,
                            "gps": json.dumps(gps_data),
                            "distance": round(distance_miles, 2),
                            "source": "upload",
                            "filename": file.filename,
                            "imei": "HISTORICAL",
                        }

                        await process_and_store_trip(trip, uploaded_trips)

            elif file.filename.endswith(".geojson"):
                # Process GeoJSON file
                geojson_data = json.load(file)
                trips = process_geojson_trip(geojson_data)

                if trips:
                    for trip in trips:
                        trip["source"] = "upload"
                        trip["filename"] = file.filename
                        await process_and_store_trip(trip, uploaded_trips)

        return jsonify(
            {
                "status": "success",
                "message": f"{len(uploaded_trips)} trips uploaded successfully.",
            }
        )

    except Exception as e:
        logger.error(f"Error uploading files: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500


async def process_and_store_trip(trip, uploaded_trips):
    try:
        # Parse GPS data if it's a string
        gps_data = (
            json.loads(trip["gps"]) if isinstance(
                trip["gps"], str) else trip["gps"]
        )
        coordinates = gps_data["coordinates"]
        start_point = coordinates[0]
        end_point = coordinates[-1]

        # Only geocode if locations don't exist
        if not trip.get("startLocation"):
            trip["startLocation"] = await reverse_geocode_nominatim(
                start_point[1], start_point[0]
            )

        if not trip.get("destination"):
            trip["destination"] = await reverse_geocode_nominatim(
                end_point[1], end_point[0]
            )

        # Store in database
        try:
            # Ensure GPS data is stored as a string
            if isinstance(trip["gps"], dict):
                trip["gps"] = json.dumps(trip["gps"])

            # Check if trip already exists
            existing_trip = uploaded_trips_collection.find_one(
                {"transactionId": trip["transactionId"]}
            )
            if existing_trip:
                # Only update if locations are missing
                update_fields = {}
                if not existing_trip.get("startLocation"):
                    update_fields["startLocation"] = trip["startLocation"]
                if not existing_trip.get("destination"):
                    update_fields["destination"] = trip["destination"]

                if update_fields:
                    uploaded_trips_collection.update_one(
                        {"transactionId": trip["transactionId"]},
                        {"$set": update_fields},
                    )
            else:
                # Insert new trip
                uploaded_trips_collection.insert_one(trip)
                uploaded_trips.append(trip)
                logger.info(
                    f"Successfully stored trip: {trip['transactionId']}")

        except DuplicateKeyError:
            logger.warning(
                f"Duplicate trip encountered: {trip['transactionId']}. Skipping."
            )
    except Exception as e:
        logger.error(f"Error processing trip: {str(e)}")
        logger.exception("Full traceback:")
        raise


@app.route("/api/uploaded_trips")
def get_uploaded_trips():
    try:
        trips = list(uploaded_trips_collection.find())
        for trip in trips:
            trip["_id"] = str(trip["_id"])
            trip["startTime"] = trip["startTime"].isoformat()
            trip["endTime"] = trip["endTime"].isoformat()
        return jsonify({"status": "success", "trips": trips})
    except Exception as e:
        logger.error(f"Error fetching uploaded trips: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/uploaded_trips/<trip_id>", methods=["DELETE"])
def delete_uploaded_trip(trip_id):
    try:
        result = uploaded_trips_collection.delete_one(
            {"_id": ObjectId(trip_id)})
        if result.deleted_count == 1:
            return jsonify(
                {"status": "success", "message": "Trip deleted successfully."}
            )
        return jsonify({"status": "error", "message": "Trip not found."}), 404
    except Exception as e:
        logger.error(f"Error deleting uploaded trip: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/uploaded_trips/bulk_delete", methods=["DELETE"])
def bulk_delete_uploaded_trips():
    try:
        data = request.json
        trip_ids = data.get("trip_ids", [])
        if not trip_ids:
            return jsonify({"status": "error", "message": "No trip IDs provided."}), 400

        # Convert trip_ids to ObjectId, handle invalid IDs
        valid_trip_ids = []
        for trip_id in trip_ids:
            try:
                valid_trip_ids.append(ObjectId(trip_id))
            except:
                continue  # skip invalid IDs

        if not valid_trip_ids:
            return (
                jsonify(
                    {"status": "error", "message": "No valid trip IDs provided."}),
                400,
            )

        # Find trips to be deleted
        trips_to_delete = uploaded_trips_collection.find(
            {"_id": {"$in": valid_trip_ids}}
        )
        transaction_ids = [trip["transactionId"] for trip in trips_to_delete]

        # Delete from uploaded_trips_collection
        delete_result = uploaded_trips_collection.delete_many(
            {"_id": {"$in": valid_trip_ids}}
        )

        # Delete from matched_trips_collection
        if transaction_ids:
            matched_delete_result = matched_trips_collection.delete_many(
                {"transactionId": {"$in": transaction_ids}}
            )
        else:
            matched_delete_result = None

        return jsonify(
            {
                "status": "success",
                "deleted_uploaded_trips": delete_result.deleted_count,
                "deleted_matched_trips": matched_delete_result.deleted_count
                if matched_delete_result
                else 0,
            }
        )
    except Exception as e:
        logger.error(f"Error in bulk_delete_uploaded_trips: {e}")
        return (
            jsonify(
                {
                    "status": "error",
                    "message": "An error occurred while deleting trips.",
                }
            ),
            500,
        )


@app.route("/api/places", methods=["GET", "POST"])
def handle_places():
    if request.method == "GET":
        places = list(places_collection.find())
        return jsonify(
            [
                {"_id": str(place["_id"]), **
                 CustomPlace.from_dict(place).to_dict()}
                for place in places
            ]
        )

    if request.method == "POST":
        place_data = request.json
        place = CustomPlace(
            name=place_data["name"], geometry=place_data["geometry"])
        result = places_collection.insert_one(place.to_dict())
        return jsonify({"_id": str(result.inserted_id), **place.to_dict()})


@app.route("/api/places/<place_id>", methods=["DELETE"])
def delete_place(place_id):
    places_collection.delete_one({"_id": ObjectId(place_id)})
    return "", 204


@app.route("/api/places/<place_id>/statistics")
def get_place_statistics(place_id):
    try:
        place = places_collection.find_one({"_id": ObjectId(place_id)})
        if not place:
            return jsonify({"error": "Place not found"}), 404

        place_shape = shape(place["geometry"])
        visits = []
        first_visit = None
        last_visit = None

        # Get all trips sorted by start time to ensure chronological order
        all_trips = list(trips_collection.find().sort("startTime", 1))
        current_time = datetime.now(timezone.utc)

        # Process each trip
        for i, trip in enumerate(all_trips):
            try:
                gps_data = geojson_loads(trip["gps"])
                last_point = Point(gps_data["coordinates"][-1])

                if place_shape.contains(last_point):
                    # Ensure times are timezone-aware
                    trip_end = (
                        trip["endTime"].replace(tzinfo=timezone.utc)
                        if trip["endTime"].tzinfo is None
                        else trip["endTime"]
                    )

                    # Calculate duration until next trip starts
                    if i < len(all_trips) - 1:
                        next_trip = all_trips[i + 1]
                        next_start = (
                            next_trip["startTime"].replace(tzinfo=timezone.utc)
                            if next_trip["startTime"].tzinfo is None
                            else next_trip["startTime"]
                        )
                        duration = (next_start - trip_end).total_seconds() / 60
                    else:
                        # For the last trip, calculate duration until now
                        duration = (current_time -
                                    trip_end).total_seconds() / 60

                    # Store visit information
                    visits.append(duration)

                    # Update first visit time if this is the first one we've found
                    if first_visit is None:
                        first_visit = trip_end

                    # Update last visit time if this is the most recent
                    if last_visit is None or trip_end > last_visit:
                        last_visit = trip_end

            except Exception as e:
                logger.error(
                    f"Error processing trip for place {place['name']}: {e}")
                continue

        # Calculate statistics
        total_visits = len(visits)
        if total_visits > 0:
            avg_minutes = sum(visits) / total_visits
            hours = int(avg_minutes // 60)
            minutes = int(avg_minutes % 60)
            avg_time_str = f"{hours}h {minutes}m"
        else:
            avg_time_str = "0h 0m"

        return jsonify(
            {
                "totalVisits": total_visits,
                "averageTimeSpent": avg_time_str,
                "firstVisit": first_visit.isoformat() if first_visit else None,
                "lastVisit": last_visit.isoformat() if last_visit else None,
                "name": place["name"],
            }
        )

    except Exception as e:
        logger.error(f"Error calculating place statistics: {e}")
        return jsonify({"error": "Internal server error"}), 500


async def process_trip_destination(trip):
    gps_data = geojson_loads(trip["gps"])
    last_point = Point(gps_data["coordinates"][-1])

    # Check custom places first
    custom_place = places_collection.find_one(
        {
            "geometry": {
                "$geoIntersects": {
                    "$geometry": {
                        "type": "Point",
                        "coordinates": [last_point.x, last_point.y],
                    }
                }
            }
        }
    )

    if custom_place:
        return custom_place["name"]

    # Fall back to reverse geocoding
    return await reverse_geocode_nominatim(last_point.y, last_point.x)


def organize_daily_data(results):
    """
    Organize aggregated results into daily distance totals
    """
    daily_data = {}
    for result in results:
        date = result["_id"]["date"]
        if date not in daily_data:
            daily_data[date] = {"distance": 0, "count": 0}
        daily_data[date]["distance"] += result["totalDistance"]
        daily_data[date]["count"] += result["tripCount"]

    return [
        {"date": date, "distance": data["distance"], "count": data["count"]}
        for date, data in sorted(daily_data.items())
    ]


def organize_hourly_data(results):
    """
    Organize aggregated results into hourly distribution
    """
    hourly_data = {}
    for result in results:
        hour = result["_id"]["hour"]
        if hour not in hourly_data:
            hourly_data[hour] = 0
        hourly_data[hour] += result["tripCount"]

    return [
        {"hour": hour, "count": count} for hour, count in sorted(hourly_data.items())
    ]


@app.route("/api/trip-analytics")
def get_trip_analytics():
    start_date = request.args.get("start_date")
    end_date = request.args.get("end_date")

    if not start_date or not end_date:
        return jsonify({"error": "Missing date parameters"}), 400

    try:
        pipeline = [
            {
                "$match": {
                    "startTime": {
                        "$gte": datetime.fromisoformat(start_date),
                        "$lte": datetime.fromisoformat(end_date),
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
        logging.error(f"Error in trip analytics: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@app.route("/webhook/bouncie", methods=["POST"])
def bouncie_webhook():
    webhook_key = os.getenv("WEBHOOK_KEY")
    auth_header = request.headers.get("Authorization")

    # Log incoming webhook request
    app.logger.info(f"Received webhook request: {request.json}")

    if not auth_header or auth_header != webhook_key:
        app.logger.error(f"Invalid webhook key: {auth_header}")
        return jsonify({"error": "Invalid webhook key"}), 401

    try:
        webhook_data = request.json
        event_type = webhook_data.get("eventType")

        if event_type == "tripStart":
            emit_data = {
                "transactionId": webhook_data.get("transactionId"),
                "imei": webhook_data.get("imei"),
                "start": webhook_data.get(
                    "start"
                ),  # Ensure 'start' contains the full object from Bouncie
            }
        elif event_type == "tripData":
            emit_data = {
                "transactionId": webhook_data.get("transactionId"),
                "imei": webhook_data.get("imei"),
                # Ensure 'data' is an array
                "data": webhook_data.get("data", []),
            }
        elif event_type == "tripMetrics":
            emit_data = {
                "transactionId": webhook_data.get("transactionId"),
                "imei": webhook_data.get("imei"),
                "metrics": webhook_data.get("metrics"),
            }
        elif event_type == "tripEnd":
            emit_data = {
                "transactionId": webhook_data.get("transactionId"),
                "imei": webhook_data.get("imei"),
                "end": webhook_data.get(
                    "end"
                ),  # Ensure 'end' contains the full object from Bouncie
            }
        else:
            emit_data = webhook_data

        socketio.emit(f"trip_{event_type}", emit_data)

        if event_type == "tripEnd":
            store_trip_data(webhook_data)

        return jsonify({"status": "success"}), 200

    except Exception as e:
        app.logger.error(f"Error processing webhook: {str(e)}")
        return (
            jsonify({"status": "success"}),
            200,
        )  # Still return 200 to prevent webhook deactivation


def store_trip_data(trip_data):
    """Store completed trip data in MongoDB"""
    try:
        formatted_trip = {
            "transactionId": trip_data.get("transactionId"),
            "imei": trip_data.get("imei"),
            # Use current time if not provided
            "startTime": datetime.now(timezone.utc),
            # Use current time if not provided
            "endTime": datetime.now(timezone.utc),
            "distance": trip_data.get("distance", 0),
            "data": trip_data.get("data", {}),
        }

        # Insert into your existing trips collection
        db.trips.insert_one(formatted_trip)

    except Exception as e:
        app.logger.error(f"Error formatting/storing trip data: {str(e)}")
        # Don't raise the exception - let the webhook still return 200


@socketio.on("connect")
def handle_connect():
    logger.info("Client connected")


@socketio.on("disconnect")
def handle_disconnect():
    logger.info("Client disconnected")


def get_trip_from_db(trip_id):
    try:
        trip = trips_collection.find_one({"transactionId": trip_id})
        if not trip:
            logger.warning(f"Trip {trip_id} not found in database")
            return None

        # Ensure GPS data is properly formatted
        if "gps" not in trip:
            logger.error(f"Trip {trip_id} missing GPS data")
            return None

        # Convert string GPS data to dict if needed
        if isinstance(trip["gps"], str):
            try:
                trip["gps"] = json.loads(trip["gps"])
            except json.JSONDecodeError:
                logger.error(f"Failed to parse GPS data for trip {trip_id}")
                return None

        return trip
    except Exception as e:
        logger.error(f"Error retrieving trip {trip_id}: {str(e)}")
        return None


def store_trip(trip):
    try:
        # Validate trip data
        is_valid, error_message = validate_trip_data(trip)
        if not is_valid:
            logger.error(f"Invalid trip data: {error_message}")
            return False

        # Ensure GPS data is stored as a string
        if isinstance(trip["gps"], dict):
            trip["gps"] = json.dumps(trip["gps"])

        # Parse times if they're strings
        for time_field in ["startTime", "endTime"]:
            if isinstance(trip[time_field], str):
                trip[time_field] = parser.isoparse(trip[time_field])

        # Store the trip
        result = trips_collection.update_one(
            {"transactionId": trip["transactionId"]}, {"$set": trip}, upsert=True
        )

        logger.info(f"Successfully stored trip {trip['transactionId']}")
        return True
    except Exception as e:
        logger.error(
            f"Error storing trip {trip.get('transactionId', 'Unknown')}: {str(e)}"
        )
        return False


async def process_trip_data(trip):
    try:
        # Convert GPS to dict if it's a string
        gps_data = (
            trip["gps"] if isinstance(
                trip["gps"], dict) else json.loads(trip["gps"])
        )

        if not gps_data or "coordinates" not in gps_data:
            logger.error(
                f"Invalid GPS data for trip {trip.get('transactionId')}")
            return None

        start_point = gps_data["coordinates"][0]
        last_point = gps_data["coordinates"][-1]

        # Add processed data
        trip["startGeoPoint"] = start_point
        trip["destinationGeoPoint"] = last_point

        # Only geocode if locations don't exist
        if not trip.get("destination"):
            trip["destination"] = await reverse_geocode_nominatim(
                last_point[1], last_point[0]
            )
        if not trip.get("startLocation"):
            trip["startLocation"] = await reverse_geocode_nominatim(
                start_point[1], start_point[0]
            )

        return trip
    except Exception as e:
        logger.error(f"Error processing trip data: {str(e)}")
        return None


async def fetch_and_store_trips_in_range(start_date, end_date):
    try:
        logger.info(
            f"Starting fetch_and_store_trips_in_range from {start_date} to {end_date}"
        )
        logger.info(f"Authorized devices: {AUTHORIZED_DEVICES}")

        # Ensure dates are timezone-aware
        if start_date.tzinfo is None:
            start_date = start_date.replace(tzinfo=timezone.utc)
        if end_date.tzinfo is None:
            end_date = end_date.replace(tzinfo=timezone.utc)

        async with aiohttp.ClientSession() as client_session:
            access_token = await get_access_token(client_session)
            if not access_token:
                logger.error("Failed to obtain access token")
                return

            logger.info("Access token obtained")

            all_trips = []
            total_devices = len(AUTHORIZED_DEVICES)
            for idx, imei in enumerate(AUTHORIZED_DEVICES, 1):
                logger.info(
                    f"Fetching trips for IMEI: {imei} ({idx}/{total_devices})")
                device_trips = await fetch_trips_in_intervals(
                    client_session, access_token, imei, start_date, end_date
                )
                logger.info(
                    f"Fetched {len(device_trips)} trips for IMEI {imei}")
                all_trips.extend(device_trips)

                # Emit progress through socketio if available
                progress = (idx / total_devices) * 100
                socketio.emit("fetch_progress", {"progress": progress})

            logger.info(f"Total trips fetched: {len(all_trips)}")

            processed_count = 0
            skipped_count = 0
            error_count = 0

            for trip in all_trips:
                try:
                    # Check if trip exists and is valid
                    existing_trip = get_trip_from_db(trip["transactionId"])
                    if existing_trip:
                        logger.info(
                            f"Trip {trip['transactionId']} already exists in the database. Skipping."
                        )
                        skipped_count += 1
                        continue

                    # Process new trip data
                    processed_trip = await process_trip_data(trip)
                    if not processed_trip:
                        logger.warning(
                            f"Failed to process trip {trip['transactionId']}. Skipping."
                        )
                        error_count += 1
                        continue

                    # Store the processed trip
                    if not store_trip(processed_trip):
                        logger.error(
                            f"Failed to store trip {trip['transactionId']}")
                        error_count += 1
                        continue

                    processed_count += 1

                except Exception as e:
                    logger.error(
                        f"Error processing trip {trip.get('transactionId', 'Unknown')}: {str(e)}"
                    )
                    error_count += 1
                    continue

            # Log final summary
            logger.info(
                f"Processing complete: {processed_count} processed, {skipped_count} skipped, {error_count} errors"
            )

            # Log final counts per device
            for imei in AUTHORIZED_DEVICES:
                count = trips_collection.count_documents({"imei": imei})
                logger.info(f"Trips in database for IMEI {imei}: {count}")

            return {
                "processed": processed_count,
                "skipped": skipped_count,
                "errors": error_count,
            }

    except Exception as e:
        logger.error(f"Error in fetch_and_store_trips_in_range: {str(e)}")
        logger.exception("Full traceback:")
        return None


@app.route("/api/first_trip_date")
def get_first_trip_date():
    try:
        # Query all three collections for the earliest trip
        regular_first = trips_collection.find_one({}, sort=[("startTime", 1)])
        uploaded_first = uploaded_trips_collection.find_one(
            {}, sort=[("startTime", 1)])
        historical_first = historical_trips_collection.find_one(
            {}, sort=[("startTime", 1)]
        )

        dates = []
        if regular_first and "startTime" in regular_first:
            dates.append(regular_first["startTime"])
        if uploaded_first and "startTime" in uploaded_first:
            dates.append(uploaded_first["startTime"])
        if historical_first and "startTime" in historical_first:
            dates.append(historical_first["startTime"])

        if not dates:
            # If no trips found, return today's date
            return jsonify({"first_trip_date": datetime.now(timezone.utc).isoformat()})

        # Return the earliest date
        first_date = min(dates)

        # Ensure timezone is UTC
        if first_date.tzinfo is None:
            first_date = first_date.replace(tzinfo=timezone.utc)

        logger.info(f"Found earliest trip date: {first_date.isoformat()}")

        return jsonify({"first_trip_date": first_date.isoformat()})

    except Exception as e:
        logger.error(f"Error getting first trip date: {str(e)}")
        return (
            jsonify({"error": "Failed to get first trip date", "message": str(e)}),
            500,
        )


@app.errorhandler(404)
def not_found_error(error):
    return jsonify({"error": "Endpoint not found"}), 404


@app.errorhandler(500)
def internal_error(error):
    return jsonify({"error": "Internal server error"}), 500


async def cleanup_invalid_trips():
    try:
        all_trips = list(trips_collection.find({}))
        for trip in all_trips:
            is_valid, error_message = validate_trip_data(trip)
            if not is_valid:
                logger.warning(
                    f"Found invalid trip {trip.get('transactionId')}: {error_message}"
                )
                # Option 1: Delete invalid trips
                # trips_collection.delete_one({'_id': trip['_id']})
                # Option 2: Mark them as invalid
                trips_collection.update_one(
                    {"_id": trip["_id"]}, {"$set": {"invalid": True}}
                )

        logger.info("Trip cleanup completed")
    except Exception as e:
        logger.error(f"Error during trip cleanup: {str(e)}")


@app.route("/api/trips/bulk_delete", methods=["DELETE"])
def bulk_delete_trips():
    try:
        data = request.json
        trip_ids = data.get("trip_ids", [])

        if not trip_ids:
            return jsonify({"status": "error", "message": "No trip IDs provided"}), 400

        # Delete from trips collection
        delete_result = trips_collection.delete_many(
            {"transactionId": {"$in": trip_ids}}
        )

        # Also delete any corresponding matched trips
        matched_trips_collection.delete_many(
            {"original_trip_id": {"$in": trip_ids}})

        return jsonify(
            {
                "status": "success",
                "message": f"Successfully deleted {delete_result.deleted_count} trips",
                "deleted_count": delete_result.deleted_count,
            }
        )

    except Exception as e:
        logger.error(f"Error in bulk delete trips: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500


def process_geojson_trip(geojson_data):
    try:
        features = geojson_data.get("features", [])
        processed_trips = []

        logger.info(f"Processing {len(features)} features from GeoJSON")

        for feature in features:
            properties = feature.get("properties", {})
            geometry = feature.get("geometry", {})

            # Log the entire properties object for debugging
            logger.debug(
                f"Raw properties data: {json.dumps(properties, indent=2)}")

            # Get timestamps from start_location
            start_location = properties.get("start_location", {})
            if isinstance(start_location, dict):
                start_time = start_location.get("timestamp")
                logger.debug(f"Start time from start_location: {start_time}")
            else:
                start_time = None

            # Get timestamps from end_location
            end_location = properties.get("end_location", {})
            if isinstance(end_location, dict):
                end_time = end_location.get("timestamp")
                logger.debug(f"End time from end_location: {end_time}")
            else:
                end_time = None

            # If no timestamps in locations, try direct properties
            if not start_time:
                start_time = properties.get("start_time")
                logger.debug(f"Start time from properties: {start_time}")
            if not end_time:
                end_time = properties.get("end_time")
                logger.debug(f"End time from properties: {end_time}")

            # Try to extract timestamp from transaction_id if still no timestamps
            transaction_id = properties.get("transaction_id", "")
            if not (start_time and end_time) and "-" in transaction_id:
                try:
                    # Extract timestamp from transaction ID
                    timestamp_str = transaction_id.split("-")[-1]
                    if timestamp_str.isdigit():
                        timestamp_ms = int(timestamp_str)
                        dt = datetime.fromtimestamp(
                            timestamp_ms / 1000, tz=timezone.utc
                        )
                        if not start_time:
                            start_time = dt.isoformat()
                        if not end_time:
                            end_time = (
                                dt + timedelta(minutes=5)
                                # Assume 5-minute trip if no end time
                            ).isoformat()
                        logger.debug(
                            f"Generated times from transaction_id: Start={start_time}, End={end_time}"
                        )
                except Exception as e:
                    logger.debug(
                        f"Failed to extract timestamp from transaction_id: {str(e)}"
                    )

            if not start_time or not end_time:
                logger.warning(
                    f"Skipping trip due to missing time data: {transaction_id}"
                )
                continue

            try:
                # Parse the timestamps
                parsed_start = parser.isoparse(start_time)
                parsed_end = parser.isoparse(end_time)

                # Ensure timestamps are timezone-aware
                if parsed_start.tzinfo is None:
                    parsed_start = parsed_start.replace(tzinfo=timezone.utc)
                if parsed_end.tzinfo is None:
                    parsed_end = parsed_end.replace(tzinfo=timezone.utc)

                trip = {
                    "transactionId": transaction_id,
                    "startTime": parsed_start,
                    "endTime": parsed_end,
                    "gps": json.dumps(
                        {
                            "type": geometry["type"],
                            "coordinates": geometry["coordinates"],
                        }
                    ),
                    "distance": calculate_distance(geometry["coordinates"]),
                    "imei": "HISTORICAL",
                    "source": "upload",
                    "maxSpeed": properties.get("max_speed"),
                    "hardBrakings": properties.get("hard_brakings", []),
                    "hardAccelerations": properties.get("hard_accelerations", []),
                    "idle": properties.get("idle", []),
                    "startLocation": start_location,
                    "endLocation": end_location,
                }

                processed_trips.append(trip)
                logger.info(
                    f"Successfully processed trip: {trip['transactionId']}")

            except (ValueError, TypeError) as e:
                logger.error(
                    f"Error parsing timestamps for trip {transaction_id}: {str(e)}"
                )
                continue

        logger.info(f"Processed {len(processed_trips)} trips from GeoJSON")
        return processed_trips

    except Exception as e:
        logger.error(f"Error processing GeoJSON trip: {str(e)}")
        logger.exception("Full traceback:")
        return None


def calculate_distance(coordinates):
    """Calculate total distance in miles from coordinates"""
    total_distance = 0
    for i in range(len(coordinates) - 1):
        point1 = coordinates[i]
        point2 = coordinates[i + 1]

        # Calculate distance between consecutive points
        lat1, lon1 = point1[1], point1[0]
        lat2, lon2 = point2[1], point2[0]

        # Use haversine formula
        R = 3959.87433  # Earth's radius in miles

        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)

        a = math.sin(dlat / 2) * math.sin(dlat / 2) + math.cos(
            math.radians(lat1)
        ) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) * math.sin(dlon / 2)

        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        distance = R * c

        total_distance += distance

    return total_distance


def process_gpx(gpx):
    processed_trips = []

    for track in gpx.tracks:
        for segment in track.segments:
            if not segment.points:
                continue

            coordinates = [[p.longitude, p.latitude] for p in segment.points]
            times = [p.time for p in segment.points if p.time]

            if not times:
                continue

            trip = {
                "transactionId": str(ObjectId()),
                "startTime": times[0].replace(tzinfo=timezone.utc),
                "endTime": times[-1].replace(tzinfo=timezone.utc),
                "gps": {"type": "LineString", "coordinates": coordinates},
                "imei": "HISTORICAL",
                "distance": calculate_distance(coordinates),
            }

            processed_trips.append(trip)

    return processed_trips


@app.route("/edit_trips")
def edit_trips_page():
    return render_template("edit_trips.html")

@app.route("/api/edit_trips", methods=["GET"])
def get_edit_trips():
    try:
        start_date = request.args.get("start_date")
        end_date = request.args.get("end_date")
        trip_type = request.args.get("type")  # 'trips' or 'matched_trips'

        if trip_type == "trips":
            collection = trips_collection
        elif trip_type == "matched_trips":
            collection = matched_trips_collection
        else:
            return jsonify({"status": "error", "message": "Invalid trip type"}), 400

        query = {"startTime": {"$gte": start_date, "$lte": end_date}}

        trips = list(collection.find(query))
        for trip in trips:
            trip["_id"] = str(trip["_id"])  # Convert ObjectId to string

        return jsonify({"status": "success", "trips": trips}), 200

    except Exception as e:
        logger.error(f"Error fetching trips for editing: {e}")
        return jsonify({"status": "error", "message": "Internal server error"}), 500


@app.route("/api/upload", methods=["POST"])
async def upload_files():
    try:
        files = request.files.getlist("files[]")
        processed_count = 0
        uploaded_trips = []

        for file in files:
            if file.filename.endswith(".gpx"):
                gpx = gpxpy.parse(file)
                trips = process_gpx(gpx)
            elif file.filename.endswith(".geojson"):
                geojson_data = json.load(file)
                trips = process_geojson_trip(geojson_data)
            else:
                continue

            if not trips:
                continue

            for trip in trips:
                try:
                    # Process and store the trip
                    await process_and_store_trip(trip, uploaded_trips)
                    processed_count += 1
                except Exception as e:
                    logger.error(f"Error processing trip: {str(e)}")

        return jsonify(
            {
                "status": "success",
                "message": f"Successfully processed {processed_count} trips",
            }
        )

    except Exception as e:
        logger.error(f"Error processing upload: {str(e)}")
        return jsonify({"status": "error", "message": str(e)}), 500


def validate_trip_update(data):
    """
    Validate the trip update data.
    Ensure that each point has valid latitude and longitude.
    """
    try:
        for point in data["points"]:
            lat = point.get("lat")
            lon = point.get("lon")
            if not -90 <= lat <= 90 or not -180 <= lon <= 180:
                return False, "Invalid latitude or longitude values."
        return True, ""
    except Exception as e:
        logger.error(f"Validation error: {e}")
        return False, "Invalid data format."


@app.route("/api/trips/<trip_id>", methods=["PUT"])
def update_trip(trip_id):
    try:
        data = request.json
        trip_type = data.get("type")
        geometry = data.get("geometry")
        properties = data.get("properties", {})

        collection = (
            matched_trips_collection
            if trip_type == "matched_trips"
            else trips_collection
        )

        # Find the trip using both direct and nested property paths
        trip = collection.find_one(
            {
                "$or": [
                    {"properties.transactionId": trip_id},
                    {"properties.transactionId": str(trip_id)},
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ]
            }
        )

        if not trip:
            other_collection = (
                trips_collection
                if trip_type == "matched_trips"
                else matched_trips_collection
            )
            trip = other_collection.find_one(
                {
                    "$or": [
                        {"properties.transactionId": trip_id},
                        {"properties.transactionId": str(trip_id)},
                        {"transactionId": trip_id},
                        {"transactionId": str(trip_id)},
                    ]
                }
            )
            if trip:
                collection = other_collection

        if not trip:
            return jsonify({"error": f"Trip not found with ID: {trip_id}"}), 404

        update_fields = {"updatedAt": datetime.now(timezone.utc)}

        # Handle geometry update if provided
        if geometry and isinstance(geometry, dict):
            gps_data = {"type": "LineString",
                        "coordinates": geometry["coordinates"]}
            update_fields.update(
                {"geometry": geometry, "gps": json.dumps(gps_data)})

        # Handle properties update
        if properties:
            # Convert date strings to datetime objects
            for field in ["startTime", "endTime"]:
                if field in properties and isinstance(properties[field], str):
                    try:
                        properties[field] = parser.isoparse(properties[field])
                    except (ValueError, TypeError):
                        pass

            # Convert numeric fields
            for field in ["distance", "maxSpeed", "totalIdleDuration", "fuelConsumed"]:
                if field in properties and properties[field] is not None:
                    try:
                        properties[field] = float(properties[field])
                    except (ValueError, TypeError):
                        pass

            # Update the properties
            if "properties" in trip:
                # If the trip already has a properties object, update it
                update_fields["properties"] = {
                    **trip["properties"], **properties}
            else:
                # If the trip doesn't have a properties object, update fields directly
                update_fields.update(properties)

        # Perform the update
        result = collection.update_one(
            {"_id": trip["_id"]}, {"$set": update_fields})

        if result.modified_count == 0:
            return jsonify({"error": "No changes were made to the trip"}), 400

        return jsonify({"message": "Trip updated successfully"}), 200

    except Exception as e:
        app.logger.error(f"Error updating trip {trip_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@app.route("/api/trips/<trip_id>", methods=["GET"])
def get_single_trip(trip_id):
    """Fetch a single trip by ID."""
    try:
        trip = trips_collection.find_one({"_id": ObjectId(trip_id)})
        if not trip:
            return jsonify({"status": "error", "message": "Trip not found."}), 404
        trip["_id"] = str(trip["_id"])
        return jsonify({"status": "success", "trip": trip}), 200
    except Exception as e:
        logger.error(f"Error fetching trip: {e}")
        return jsonify({"status": "error", "message": "Internal server error."}), 500


@app.route("/api/debug/trip/<trip_id>", methods=["GET"])
def debug_trip(trip_id):
    try:
        # Search in both collections
        regular_trip = trips_collection.find_one(
            {
                "$or": [
                    {"properties.transactionId": trip_id},
                    {"properties.transactionId": str(trip_id)},
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ]
            }
        )

        matched_trip = matched_trips_collection.find_one(
            {
                "$or": [
                    {"properties.transactionId": trip_id},
                    {"properties.transactionId": str(trip_id)},
                    {"transactionId": trip_id},
                    {"transactionId": str(trip_id)},
                ]
            }
        )

        return jsonify(
            {
                "regular_trip_found": bool(regular_trip),
                "matched_trip_found": bool(matched_trip),
                "regular_trip_id_field": regular_trip.get("properties", {}).get(
                    "transactionId"
                )
                if regular_trip
                else None,
                "matched_trip_id_field": matched_trip.get("properties", {}).get(
                    "transactionId"
                )
                if matched_trip
                else None,
            }
        )

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/street_coverage", methods=["POST"])
def get_street_coverage():
    try:
        data = request.json
        location = data.get("location")

        # First, generate the streets GeoJSON
        streets_data, error_message = generate_geojson_osm(
            location, streets_only=True)
        if streets_data is None:
            return (
                jsonify(
                    {
                        "status": "error",
                        "message": f"Error fetching street data: {error_message}",
                    }
                ),
                500,
            )

        # Fetch matched trips from the database
        matched_trips = list(matched_trips_collection.find())

        # Calculate coverage
        coverage_data = calculate_street_coverage(
            location, streets_data, matched_trips  # boundary geojson  # streets geojson
        )

        return jsonify(coverage_data)
    except Exception as e:
        logger.error(f"Error calculating street coverage: {str(e)}")
        return (
            jsonify(
                {
                    "status": "error",
                    "message": f"Error calculating street coverage: {str(e)}",
                }
            ),
            500,
        )


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    threading.Timer(1, periodic_fetch_trips).start()
    socketio.run(
        app, host="0.0.0.0", port=port, debug=False, allow_unsafe_werkzeug=True
    )
