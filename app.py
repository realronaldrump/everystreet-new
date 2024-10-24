import json
import threading
from datetime import datetime, timedelta, timezone
import aiohttp
from flask import Flask, render_template, request, jsonify, session, Response, send_file
from flask_socketio import SocketIO
import os
from dotenv import load_dotenv
from pymongo import MongoClient
import certifi
import geojson as geojson_module
from geojson import loads as geojson_loads, dumps as geojson_dumps
import traceback
from timezonefinder import TimezoneFinder
import pytz
import asyncio
from shapely.geometry import Polygon, LineString, MultiPolygon, MultiLineString, shape
import geopandas as gpd
import requests
import glob
import gpxpy
import gpxpy.gpx
from dateutil import parser
import math
import io
import zipfile
from shapely.ops import linemerge
import pymongo
import time
import logging  # Added import
from aiohttp.client_exceptions import ClientConnectorError, ClientResponseError
from shapely.ops import linemerge
from multiprocessing import Pool
from functools import partial
from shapely.geometry import mapping

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY')
socketio = SocketIO(app, cors_allowed_origins="*")

# MongoDB setup
try:
    client = MongoClient(
        os.getenv('MONGO_URI'),
        tls=True,
        tlsAllowInvalidCertificates=True,
        tlsCAFile=certifi.where()
    )
    db = client['every_street']
    trips_collection = db['trips']
    matched_trips_collection = db['matched_trips']
    # Collection for historical trips
    historical_trips_collection = db['historical_trips']
    print("Successfully connected to MongoDB")
except Exception as mongo_error:
    print(f"Error connecting to MongoDB: {mongo_error}")
    raise

# Bouncie API setup
CLIENT_ID = os.getenv('CLIENT_ID')
CLIENT_SECRET = os.getenv('CLIENT_SECRET')
REDIRECT_URI = os.getenv('REDIRECT_URI')
AUTH_CODE = os.getenv('AUTHORIZATION_CODE')
AUTHORIZED_DEVICES = os.getenv('AUTHORIZED_DEVICES', '').split(',')
MAPBOX_ACCESS_TOKEN = os.getenv('MAPBOX_ACCESS_TOKEN')

AUTH_URL = "https://auth.bouncie.com/oauth/token"
API_BASE_URL = "https://api.bouncie.dev/v1"

OVERPASS_URL = "http://overpass-api.de/api/interpreter"

# Initialize TimezoneFinder
tf = TimezoneFinder()


async def get_access_token(client_session):
    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": AUTH_CODE,
        "redirect_uri": REDIRECT_URI
    }
    async with client_session.post(AUTH_URL, data=payload) as auth_response:
        data = await auth_response.json()
        return data.get('access_token')


async def get_trips_from_api(client_session, access_token, imei, start_date, end_date):
    headers = {"Authorization": access_token,
               "Content-Type": "application/json"}
    params = {
        "imei": imei,
        "gps-format": "geojson",
        "starts-after": start_date.isoformat(),
        "ends-before": end_date.isoformat()
    }
    async with client_session.get(f"{API_BASE_URL}/trips", headers=headers, params=params) as response:
        if response.status == 200:
            trips = await response.json()
            for trip in trips:
                # Parse the startTime and endTime
                if 'startTime' in trip and isinstance(trip['startTime'], str):
                    trip['startTime'] = parser.isoparse(trip['startTime'])
                if 'endTime' in trip and isinstance(trip['endTime'], str):
                    trip['endTime'] = parser.isoparse(trip['endTime'])
            return trips
        print(f"Error fetching trips: {response.status}")
        return []


async def fetch_trips_in_intervals(main_session, access_token, imei, start_date, end_date):
    all_trips = []
    current_start = start_date
    if current_start.tzinfo is None:
        current_start = current_start.replace(tzinfo=timezone.utc)
    if end_date.tzinfo is None:
        end_date = end_date.replace(tzinfo=timezone.utc)
    while current_start < end_date:
        current_end = min(current_start + timedelta(days=7), end_date)
        trips = await get_trips_from_api(main_session, access_token, imei, current_start, current_end)
        all_trips.extend(trips)
        current_start = current_end
    return all_trips


def is_valid_geojson(geojson_obj):
    return geojson_obj['type'] in ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection']


def periodic_fetch_trips():
    with app.app_context():
        try:
            # Get the timestamp of the last trip
            last_trip = trips_collection.find_one(sort=[("endTime", -1)])
            if last_trip:
                start_date = last_trip['endTime']
                if start_date.tzinfo is None:
                    start_date = start_date.replace(tzinfo=timezone.utc)
            else:
                start_date = datetime.now(timezone.utc) - timedelta(days=1)

            end_date = datetime.now(timezone.utc)

            print(f"Fetching trips from {start_date} to {end_date}")
            asyncio.run(fetch_and_store_trips_in_range(start_date, end_date))

            # Schedule the next run
            threading.Timer(30 * 60, periodic_fetch_trips).start()
        except Exception as e:
            print(f"Error in periodic fetch: {e}")
            print(traceback.format_exc())
            # Reschedule even if there's an error
            threading.Timer(30 * 60, periodic_fetch_trips).start()


def validate_trip_data(trip):
    required_fields = ['transactionId', 'imei',
                       'startTime', 'endTime', 'distance', 'gps']
    for field in required_fields:
        if field not in trip:
            return False, f"Missing required field: {field}"

    try:
        # Parse startTime and endTime if they are strings
        if isinstance(trip['startTime'], str):
            trip['startTime'] = parser.isoparse(trip['startTime'])
        if isinstance(trip['endTime'], str):
            trip['endTime'] = parser.isoparse(trip['endTime'])

        geojson_obj = geojson_loads(trip['gps'] if isinstance(
            trip['gps'], str) else json.dumps(trip['gps']))
        if not is_valid_geojson(geojson_obj):
            return False, "Invalid GeoJSON data"
    except Exception as validation_error:
        return False, f"Error validating trip data: {str(validation_error)}"

    return True, None


async def reverse_geocode_nominatim(lat, lon, retries=3, backoff_factor=1):
    """
    Reverse geocodes latitude and longitude to an address using Nominatim.

    Args:
        lat (float): Latitude.
        lon (float): Longitude.
        retries (int): Number of retry attempts.
        backoff_factor (int): Factor for exponential backoff.

    Returns:
        str or None: The formatted address or None if failed.
    """
    url = 'https://nominatim.openstreetmap.org/reverse'
    params = {
        'format': 'jsonv2',
        'lat': lat,
        'lon': lon,
        'zoom': 18,
        'addressdetails': 1
    }
    headers = {
        # Replace with your app name and contact info
        'User-Agent': 'YourAppName/1.0 (your.email@example.com)'
    }

    for attempt in range(1, retries + 1):
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
                async with session.get(url, params=params, headers=headers) as response:
                    response.raise_for_status()  # Raise exception for HTTP errors
                    data = await response.json()
                    address = data.get('display_name', None)
                    logger.info(
                        f"Reverse geocoding successful for ({lat}, {lon}): {address}")
                    return address
        except ClientResponseError as e:
            logger.error(
                f"HTTP error on attempt {attempt}: {e.status} {e.message}")
            if 500 <= e.status < 600:
                # Server-side error, retry
                pass
            else:
                # Client-side error, do not retry
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
                f"All {retries} attempts to reverse geocode failed for ({lat}, {lon})")
            return None


def fetch_trips_for_geojson():
    trips = trips_collection.find()
    features = []

    for trip in trips:
        feature = geojson_module.Feature(
            geometry=geojson_loads(trip['gps']),
            properties={
                "transactionId": trip['transactionId'],
                "imei": trip['imei'],
                "startTime": trip['startTime'].isoformat(),
                "endTime": trip['endTime'].isoformat(),
                "distance": trip['distance'],
                "destination": trip['destination'],
                "startLocation": trip.get('startLocation', 'N/A')
            }
        )
        features.append(feature)

    return geojson_module.FeatureCollection(features)


def get_trip_timezone(trip):
    """
    Determines the timezone of a trip based on its GPS coordinates.
    If no timezone can be determined, defaults to America/Chicago timezone.
    """
    try:
        gps_data = geojson_loads(trip['gps'] if isinstance(
            trip['gps'], str) else json.dumps(trip['gps']))
        if gps_data['type'] == 'Point':
            lon, lat = gps_data['coordinates']
            timezone_str = tf.timezone_at(lng=lon, lat=lat)
            if timezone_str:
                return timezone_str
        elif gps_data['type'] in ['LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon']:
            # Use the first coordinate to determine timezone
            lon, lat = gps_data['coordinates'][0]
            timezone_str = tf.timezone_at(lng=lon, lat=lat)
            if timezone_str:
                return timezone_str
        return 'America/Chicago'
    except Exception as e:
        print(f"Error getting trip timezone: {e}")
        return 'America/Chicago'


async def fetch_and_store_trips():
    try:
        print("Starting fetch_and_store_trips")
        print(f"Authorized devices: {AUTHORIZED_DEVICES}")
        async with aiohttp.ClientSession() as client_session:
            access_token = await get_access_token(client_session)
            print("Access token obtained")

            end_date = datetime.now(timezone.utc)
            start_date = end_date - timedelta(days=365*4)

            all_trips = []
            total_devices = len(AUTHORIZED_DEVICES)
            for device_count, imei in enumerate(AUTHORIZED_DEVICES, 1):
                print(f"Fetching trips for IMEI: {imei}")
                device_trips = await fetch_trips_in_intervals(client_session, access_token, imei, start_date, end_date)
                print(f"Fetched {len(device_trips)} trips for IMEI {imei}")
                all_trips.extend(device_trips)

                progress = int((device_count / total_devices) * 100)
                socketio.emit('loading_progress', {'progress': progress})

            print(f"Total trips fetched: {len(all_trips)}")

            for trip in all_trips:
                try:
                    existing_trip = trips_collection.find_one(
                        {'transactionId': trip['transactionId']})
                    if existing_trip:
                        print(
                            f"Trip {trip['transactionId']} already exists in the database. Skipping.")
                        continue
                    is_valid, error_message = validate_trip_data(trip)
                    if not is_valid:
                        print(
                            f"Invalid trip data for {trip.get('transactionId', 'Unknown')}: {error_message}")
                        continue

                    trip_timezone = get_trip_timezone(trip)

                    # Ensure startTime and endTime are datetime objects
                    if isinstance(trip['startTime'], str):
                        trip['startTime'] = parser.isoparse(trip['startTime'])
                    if isinstance(trip['endTime'], str):
                        trip['endTime'] = parser.isoparse(trip['endTime'])

                    trip['startTime'] = trip['startTime'].astimezone(
                        pytz.timezone(trip_timezone))
                    trip['endTime'] = trip['endTime'].astimezone(
                        pytz.timezone(trip_timezone))

                    gps_data = geojson_loads(trip['gps'] if isinstance(
                        trip['gps'], str) else json.dumps(trip['gps']))

                    start_point = gps_data['coordinates'][0]
                    last_point = gps_data['coordinates'][-1]

                    trip['startGeoPoint'] = start_point
                    trip['destinationGeoPoint'] = last_point

                    trip['destination'] = await reverse_geocode_nominatim(last_point[1], last_point[0])
                    trip['startLocation'] = await reverse_geocode_nominatim(start_point[1], start_point[0])

                    if isinstance(trip['gps'], dict):
                        trip['gps'] = geojson_dumps(trip['gps'])
                    result = trips_collection.update_one(
                        {'transactionId': trip['transactionId']},
                        {'$set': trip},
                        upsert=True
                    )
                    print(
                        f"Updated trip {trip['transactionId']} for IMEI {trip.get('imei', 'Unknown')}: {'Inserted' if result.upserted_id else 'Updated'}")
                except Exception as trip_error:
                    print(
                        f"Error updating trip {trip.get('transactionId', 'Unknown')}: {trip_error}")
                    print(traceback.format_exc())

            for imei in AUTHORIZED_DEVICES:
                try:
                    count = trips_collection.count_documents({'imei': imei})
                    print(f"Trips in database for IMEI {imei}: {count}")
                except Exception as count_error:
                    print(
                        f"Error counting trips for IMEI {imei}: {count_error}")
    except Exception as fetch_error:
        print(f"Error in fetch_and_store_trips: {fetch_error}")
        print(traceback.format_exc())


async def fetch_and_store_trips_in_range(start_date, end_date):
    try:
        print("Starting fetch_and_store_trips_in_range")
        print(f"Authorized devices: {AUTHORIZED_DEVICES}")
        async with aiohttp.ClientSession() as client_session:
            access_token = await get_access_token(client_session)
            print("Access token obtained")

            all_trips = []
            for imei in AUTHORIZED_DEVICES:
                print(f"Fetching trips for IMEI: {imei}")
                device_trips = await fetch_trips_in_intervals(client_session, access_token, imei, start_date, end_date)
                print(f"Fetched {len(device_trips)} trips for IMEI {imei}")
                all_trips.extend(device_trips)

            print(f"Total trips fetched: {len(all_trips)}")

            for trip in all_trips:
                try:
                    existing_trip = trips_collection.find_one(
                        {'transactionId': trip['transactionId']})
                    if existing_trip:
                        print(
                            f"Trip {trip['transactionId']} already exists in the database. Skipping.")
                        continue

                    is_valid, error_message = validate_trip_data(trip)
                    if not is_valid:
                        print(
                            f"Invalid trip data for {trip.get('transactionId', 'Unknown')}: {error_message}")
                        continue

                    trip_timezone = get_trip_timezone(trip)

                    # Ensure startTime and endTime are datetime objects
                    if isinstance(trip['startTime'], str):
                        trip['startTime'] = parser.isoparse(trip['startTime'])
                    if isinstance(trip['endTime'], str):
                        trip['endTime'] = parser.isoparse(trip['endTime'])

                    trip['startTime'] = trip['startTime'].astimezone(
                        pytz.timezone(trip_timezone))
                    trip['endTime'] = trip['endTime'].astimezone(
                        pytz.timezone(trip_timezone))

                    gps_data = geojson_loads(trip['gps'] if isinstance(
                        trip['gps'], str) else json.dumps(trip['gps']))

                    start_point = gps_data['coordinates'][0]
                    last_point = gps_data['coordinates'][-1]

                    trip['startGeoPoint'] = start_point
                    trip['destinationGeoPoint'] = last_point

                    lat, lon = last_point[1], last_point[0]
                    trip['destination'] = await reverse_geocode_nominatim(lat, lon)
                    trip['startLocation'] = await reverse_geocode_nominatim(start_point[1], start_point[0])

                    if isinstance(trip['gps'], dict):
                        trip['gps'] = geojson_dumps(trip['gps'])
                    update_result = trips_collection.update_one(
                        {'transactionId': trip['transactionId']},
                        {'$set': trip},
                        upsert=True
                    )
                    print(
                        f"Updated trip {trip['transactionId']} for IMEI {trip.get('imei', 'Unknown')}: {'Inserted' if update_result.upserted_id else 'Updated'}")
                except Exception as trip_error:
                    print(
                        f"Error updating trip {trip.get('transactionId', 'Unknown')}: {trip_error}")
                    print(traceback.format_exc())

            for imei in AUTHORIZED_DEVICES:
                try:
                    count = trips_collection.count_documents({'imei': imei})
                    print(f"Trips in database for IMEI {imei}: {count}")
                except Exception as count_error:
                    print(
                        f"Error counting trips for IMEI {imei}: {count_error}")
    except Exception as fetch_error:
        logger.error(f"Error in fetch_and_store_trips_in_range: {fetch_error}")
        logger.debug(traceback.format_exc())


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/trips')
def trips_page():
    return render_template('trips.html')


@app.route('/driving-insights')
def driving_insights_page():
    return render_template('driving_insights.html')


async def process_historical_trip(trip):
    """Processes a single historical trip, reverse geocodes locations, and sets timezone."""
    trip_timezone = get_trip_timezone(trip)

    # Ensure startTime and endTime are datetime objects
    if isinstance(trip['startTime'], str):
        trip['startTime'] = parser.isoparse(trip['startTime'])
    if isinstance(trip['endTime'], str):
        trip['endTime'] = parser.isoparse(trip['endTime'])

    trip['startTime'] = trip['startTime'].astimezone(
        pytz.timezone(trip_timezone))
    trip['endTime'] = trip['endTime'].astimezone(pytz.timezone(trip_timezone))

    gps_data = geojson_module.loads(trip['gps'])
    start_point = gps_data['coordinates'][0]
    last_point = gps_data['coordinates'][-1]

    # trip['destination'] = await reverse_geocode_nominatim(last_point[1], last_point[0])
    # trip['startLocation'] = await reverse_geocode_nominatim(start_point[1], start_point[0])

    return trip


async def load_historical_data(start_date_str=None, end_date_str=None):
    """Loads historical data from GeoJSON files within a date range, handles duplicates and errors."""
    all_trips = []  # Initialize all_trips here
    for filename in glob.glob('olddrivingdata/*.geojson'):
        with open(filename, 'r') as f:
            try:
                geojson_data = geojson_module.load(f)
                for feature in geojson_data['features']:
                    trip = feature['properties']
                    trip['gps'] = geojson_dumps(feature['geometry'])
                    trip['startTime'] = datetime.fromisoformat(
                        trip['timestamp']).replace(tzinfo=timezone.utc)
                    trip['endTime'] = datetime.fromisoformat(
                        trip['end_timestamp']).replace(tzinfo=timezone.utc)
                    trip['imei'] = 'HISTORICAL'
                    trip['transactionId'] = f"HISTORICAL-{trip['timestamp']}"

                    if start_date_str:
                        start_date = datetime.fromisoformat(
                            start_date_str).replace(tzinfo=timezone.utc)
                        if trip['startTime'] < start_date:
                            continue
                    if end_date_str:
                        end_date = datetime.fromisoformat(
                            end_date_str).replace(tzinfo=timezone.utc)
                        if trip['endTime'] > end_date:
                            continue

                    # Add the trip to be processed later
                    all_trips.append(trip)

            except (json.JSONDecodeError, TypeError) as e:
                print(f"Error processing file {filename}: {e}")

    # Process all trips asynchronously to improve performance
    async def process_all_trips():
        tasks = [process_historical_trip(trip) for trip in all_trips]
        return await asyncio.gather(*tasks)

    processed_trips = await process_all_trips()

    # Insert processed trips into the database, checking for duplicates
    inserted_count = 0
    for trip in processed_trips:
        try:
            if not historical_trips_collection.find_one({'transactionId': trip['transactionId']}):
                historical_trips_collection.insert_one(trip)
                inserted_count += 1
                print(f"Inserted historical trip: {trip['transactionId']}")
            else:
                print(
                    f"Historical trip already exists: {trip['transactionId']}")
        except pymongo.errors.PyMongoError as e:
            print(
                f"Error inserting trip {trip.get('transactionId', 'Unknown')} into database: {e}")

    return inserted_count


@app.route('/api/trips')
def get_trips():
    start_date_str = request.args.get('start_date')
    end_date_str = request.args.get('end_date')
    imei = request.args.get('imei')

    start_date = datetime.fromisoformat(start_date_str).replace(
        tzinfo=timezone.utc) if start_date_str else None
    end_date = datetime.fromisoformat(end_date_str).replace(
        hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc) if end_date_str else None

    query = {}
    if start_date and end_date:
        query['startTime'] = {'$gte': start_date, '$lte': end_date}
    if imei:
        query['imei'] = imei

    trips = list(trips_collection.find(query))

    historical_query = query.copy()
    if 'imei' in historical_query:
        del historical_query['imei']
    historical_trips = list(historical_trips_collection.find(historical_query))
    trips.extend(historical_trips)

    for trip in trips:
        trip['startTime'] = trip['startTime'].astimezone(
            pytz.timezone('America/Chicago'))
        trip['endTime'] = trip['endTime'].astimezone(
            pytz.timezone('America/Chicago'))

    return jsonify(geojson_module.FeatureCollection([
        geojson_module.Feature(
            geometry=geojson_loads(trip['gps']),
            properties={
                'transactionId': trip['transactionId'],
                'imei': trip['imei'],
                'startTime': trip['startTime'].isoformat(),
                'endTime': trip['endTime'].isoformat(),
                'distance': trip.get('distance', 0),
                'timezone': trip.get('timezone', 'America/Chicago'),
                'destination': trip.get('destination', 'N/A'),
                'startLocation': trip.get('startLocation', 'N/A')
            }
        ) for trip in trips
    ]))


@app.route('/api/driving-insights')
def get_driving_insights():
    """Returns driving insights excluding historical data."""
    try:
        start_date_str = request.args.get('start_date')
        end_date_str = request.args.get('end_date')
        imei = request.args.get('imei')

        start_date = datetime.fromisoformat(start_date_str).replace(
            tzinfo=timezone.utc) if start_date_str else None
        end_date = datetime.fromisoformat(end_date_str).replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc) if end_date_str else None

        # Build the query to exclude historical trips
        query = {
            'source': {'$ne': 'historical'}  # Exclude historical trips
        }
        if start_date and end_date:
            query['startTime'] = {
                '$gte': start_date,
                '$lte': end_date
            }
        if imei:
            query['imei'] = imei

        # Aggregate to get insights
        pipeline = [
            {'$match': query},
            {
                '$group': {
                    '_id': '$destination',
                    'count': {'$sum': 1},
                    'lastVisit': {'$max': '$endTime'}
                }
            },
            {'$sort': {'count': -1}}
        ]

        insights = list(trips_collection.aggregate(pipeline))

        # Format the results
        formatted_results = []
        for result in insights:
            if result['_id']:  # Only include non-null destinations
                formatted_results.append({
                    '_id': result['_id'],
                    'count': result['count'],
                    'lastVisit': result['lastVisit'].isoformat()
                })

        return jsonify(formatted_results)

    except Exception as e:
        logger.error(f"Error in get_driving_insights: {str(e)}")
        return jsonify({'error': str(e)}), 500


def calculate_insights_for_historical_data(start_date_str, end_date_str, imei):
    start_date = datetime.fromisoformat(start_date_str).replace(
        tzinfo=timezone.utc) if start_date_str else None
    end_date = datetime.fromisoformat(end_date_str).replace(
        tzinfo=timezone.utc) if end_date_str else None

    query = {}
    if start_date and end_date:
        query['startTime'] = {'$gte': start_date, '$lte': end_date}
    all_trips = list(historical_trips_collection.find(query))

    insights = {}
    for trip in all_trips:
        destination = trip.get('destination', 'N/A')
        if destination not in insights:
            insights[destination] = {
                '_id': destination,
                'count': 0,
                'totalDistance': 0,
                'averageDistance': 0,
                'lastVisit': datetime.min.replace(tzinfo=timezone.utc)
            }
        insights[destination]['count'] += 1
        insights[destination]['totalDistance'] += trip.get('distance', 0)
        insights[destination]['lastVisit'] = max(
            insights[destination]['lastVisit'], trip['endTime'])

    for destination in insights:
        insights[destination]['averageDistance'] = insights[destination]['totalDistance'] / \
            insights[destination]['count'] if insights[destination]['count'] > 0 else 0

    return list(insights.values())


@app.route('/api/metrics')
def get_metrics():
    start_date_str = request.args.get('start_date')
    end_date_str = request.args.get('end_date')
    imei = request.args.get('imei')

    # Create proper datetime objects with timezone
    start_date = datetime.fromisoformat(start_date_str).replace(
        tzinfo=timezone.utc) if start_date_str else None
    end_date = datetime.fromisoformat(end_date_str).replace(
        hour=23, minute=59, second=59, microsecond=999999,
        tzinfo=timezone.utc) if end_date_str else None

    # Build query
    query = {}
    if start_date and end_date:
        query['startTime'] = {'$gte': start_date, '$lte': end_date}
    if imei:
        query['imei'] = imei

    # Get trips from both collections
    trips = list(trips_collection.find(query))
    historical_trips = list(historical_trips_collection.find(query))
    all_trips = trips + historical_trips

    # Calculate metrics
    total_trips = len(all_trips)
    total_distance = sum(trip.get('distance', 0) for trip in all_trips)
    avg_distance = total_distance / total_trips if total_trips > 0 else 0

    # Calculate average start time
    start_times = [trip['startTime'].astimezone(pytz.timezone(
        'America/Chicago')).hour for trip in all_trips]
    avg_start_time = sum(start_times) / len(start_times) if start_times else 0

    # Convert to 12-hour format
    hour = int(avg_start_time)
    minutes = int((avg_start_time % 1) * 60)
    period = 'AM' if hour < 12 else 'PM'
    if hour == 0:
        hour = 12
    elif hour > 12:
        hour -= 12

    # Calculate average driving time
    driving_times = [(trip['endTime'] - trip['startTime']
                      ).total_seconds() / 60 for trip in all_trips]
    avg_driving_time = sum(driving_times) / \
        len(driving_times) if driving_times else 0

    return jsonify({
        'total_trips': total_trips,
        'total_distance': f"{round(total_distance, 2)}",
        'avg_distance': f"{round(avg_distance, 2)}",
        'avg_start_time': f"{hour:02d}:{minutes:02d} {period}",
        'avg_driving_time': f"{int(avg_driving_time // 60):02d}:{int(avg_driving_time % 60):02d}"
    })


@app.route('/api/fetch_trips', methods=['POST'])
async def api_fetch_trips():
    try:
        await fetch_and_store_trips()
        return jsonify({"status": "success", "message": "Trips fetched and stored successfully."}), 200
    except Exception as fetch_error:
        return jsonify({"status": "error", "message": str(fetch_error)}), 500


@app.route('/api/fetch_trips_range', methods=['POST'])
def api_fetch_trips_range():
    try:
        data = request.json
        start_date = datetime.fromisoformat(
            data['start_date']).replace(tzinfo=timezone.utc)
        end_date = datetime.fromisoformat(data['end_date']).replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc) + timedelta(days=1)
        asyncio.run(fetch_and_store_trips_in_range(start_date, end_date))
        return jsonify({"status": "success", "message": "Trips fetched and stored successfully."}), 200
    except Exception as fetch_error:
        return jsonify({"status": "error", "message": str(fetch_error)}), 500


@app.after_request
def add_header(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response


@app.route('/export/geojson')
def export_geojson():
    try:
        start_date_str = request.args.get('start_date')
        end_date_str = request.args.get('end_date')
        imei = request.args.get('imei')

        start_date = datetime.strptime(
            start_date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc) if start_date_str else None
        end_date = datetime.strptime(end_date_str, '%Y-%m-%d').replace(hour=23, minute=59,
                                                                       second=59, microsecond=999999, tzinfo=timezone.utc) if end_date_str else None

        query = {}
        if start_date:
            query['startTime'] = {'$gte': start_date}
        if end_date:
            if 'startTime' in query:
                query['startTime']['$lte'] = end_date
            else:
                query['startTime'] = {'$lte': end_date}
        if imei:
            query['imei'] = imei

        print(f"Export GeoJSON Query: {query}")

        trips_cursor = trips_collection.find(query)
        trips = list(trips_cursor)

        if not trips:
            return jsonify({"error": "No trips found for the specified filters."}), 404

        geojson = {
            "type": "FeatureCollection",
            "features": []
        }

        for trip in trips:
            gps_data = trip['gps']
            if isinstance(gps_data, str):
                gps_data = json.loads(gps_data)

            feature = {
                "type": "Feature",
                "geometry": gps_data,
                "properties": {
                    "transactionId": trip['transactionId'],
                    "startTime": trip['startTime'].isoformat(),
                    "endTime": trip['endTime'].isoformat(),
                    "distance": trip['distance'],
                    "imei": trip['imei']
                }
            }
            geojson["features"].append(feature)

        return jsonify(geojson)
    except Exception as e:
        print(f"Error exporting GeoJSON: {str(e)}")
        return jsonify({"error": "An error occurred while exporting GeoJSON."}), 500


@app.route('/export/gpx')
def export_gpx():
    try:
        start_date_str = request.args.get('start_date')
        end_date_str = request.args.get('end_date')
        imei = request.args.get('imei')

        start_date = datetime.strptime(
            start_date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc) if start_date_str else None
        end_date = datetime.strptime(end_date_str, '%Y-%m-%d').replace(hour=23, minute=59,
                                                                       second=59, microsecond=999999, tzinfo=timezone.utc) if end_date_str else None

        query = {}
        if start_date:
            query['startTime'] = {'$gte': start_date}
        if end_date:
            if 'startTime' in query:
                query['startTime']['$lte'] = end_date
            else:
                query['startTime'] = {'$lte': end_date}
        if imei:
            query['imei'] = imei

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

            gps_data = trip['gps']
            if isinstance(gps_data, str):
                try:
                    gps_data = json.loads(gps_data)
                except json.JSONDecodeError as json_error:
                    print(
                        f"Error decoding GPS JSON for trip {trip.get('transactionId', 'Unknown')}: {json_error}")
                    continue

            if gps_data.get('type') == 'LineString':
                for coord in gps_data.get('coordinates', []):
                    if isinstance(coord, list) and len(coord) >= 2:
                        lon, lat = coord[0], coord[1]
                        gpx_segment.points.append(
                            gpxpy.gpx.GPXTrackPoint(lat, lon))
            elif gps_data.get('type') == 'Point':
                coord = gps_data.get('coordinates', [])
                if isinstance(coord, list) and len(coord) >= 2:
                    lon, lat = coord[0], coord[1]
                    gpx_segment.points.append(
                        gpxpy.gpx.GPXTrackPoint(lat, lon))
            else:
                print(
                    f"Unsupported GPS type '{gps_data.get('type')}' for trip {trip.get('transactionId', 'Unknown')}. Skipping.")
                continue

            gpx_track.name = trip.get('transactionId', 'Unnamed Trip')
            gpx_track.description = f"Trip from {trip.get('startLocation', 'Unknown')} to {trip.get('destination', 'Unknown')}"

        gpx_xml = gpx.to_xml()

        return Response(
            gpx_xml,
            mimetype='application/gpx+xml',
            headers={
                'Content-Disposition': 'attachment;filename=trips.gpx'
            }
        )

    except Exception as e:
        print(f"Error exporting GPX: {e}")
        print(traceback.format_exc())
        return jsonify({"error": f"An error occurred while exporting GPX: {str(e)}"}), 500


async def start_background_tasks():
    await fetch_and_store_trips()


@app.route('/api/validate_location', methods=['POST'])
def validate_location():
    data = request.json
    location = data.get('location')
    location_type = data.get('locationType')
    validated_location = validate_location_osm(location, location_type)
    return jsonify(validated_location)


@app.route('/api/generate_geojson', methods=['POST'])
def generate_geojson():
    try:
        data = request.json
        print('Received data:', data)  # Add this line
        location = data.get('location')
        streets_only = data.get('streetsOnly', False)
        geojson_data, error_message = generate_geojson_osm(
            location, streets_only)
        if geojson_data:
            return jsonify(geojson_data)
        return jsonify({"error": error_message}), 400
    except Exception as e:
        return jsonify({'status': 'error', 'message': f'An error occurred: {str(e)}'}), 500


def validate_location_osm(location, location_type):
    params = {'q': location, 'format': 'json',
              'limit': 1, 'featuretype': location_type}
    headers = {'User-Agent': 'GeojsonGenerator/1.0'}
    response = requests.get(
        "https://nominatim.openstreetmap.org/search", params=params, headers=headers)
    if response.status_code == 200:
        data = response.json()
        return data[0] if data else None
    return None


def generate_geojson_osm(location, streets_only=False):
    area_id = int(location['osm_id']) + \
        3600000000 if location['osm_type'] == 'relation' else int(
            location['osm_id'])

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
        "http://overpass-api.de/api/interpreter", params={'data': query})
    if response.status_code != 200:
        return None, "Failed to get response from Overpass API"

    data = response.json()
    features = process_elements(data['elements'], streets_only)

    if features:
        gdf = gpd.GeoDataFrame.from_features(features)
        gdf = gdf.set_geometry('geometry')
        return json.loads(gdf.to_json()), None
    return None, f"No features found. Raw response: {json.dumps(data)}"


def process_elements(elements, streets_only):
    features = []
    ways = {e['id']: e for e in elements if e['type'] == 'way'}

    for element in elements:
        if element['type'] == 'way':
            coords = [(node['lon'], node['lat'])
                      for node in element.get('geometry', [])]
            if len(coords) >= 2:
                geom = LineString(coords) if streets_only else (
                    Polygon(coords) if coords[0] == coords[-1] else LineString(coords))
                features.append({
                    'type': 'Feature',
                    'geometry': geom.__geo_interface__,
                    'properties': element.get('tags', {})
                })
        elif element['type'] == 'relation' and not streets_only:
            outer_rings = []
            for member in element.get('members', []):
                if member['type'] == 'way' and member['role'] == 'outer':
                    way = ways.get(member['ref'])
                    if way:
                        coords = [(node['lon'], node['lat'])
                                  for node in way.get('geometry', [])]
                        if len(coords) >= 3 and coords[0] == coords[-1]:
                            outer_rings.append(Polygon(coords))
            if outer_rings:
                geom = outer_rings[0] if len(
                    outer_rings) == 1 else MultiPolygon(outer_rings)
                features.append({
                    'type': 'Feature',
                    'geometry': geom.__geo_interface__,
                    'properties': element.get('tags', {})
                })
    return features


# Map Matching Functions
MAX_MAPBOX_COORDINATES = 100


async def map_match_coordinates(coordinates):
    """Map match a list of coordinates using the Mapbox Map Matching API."""
    if len(coordinates) < 2:
        return {'code': 'Error', 'message': 'At least two coordinates are required for map matching.'}

    url = 'https://api.mapbox.com/matching/v5/mapbox/driving/'

    chunks = [coordinates[i:i + MAX_MAPBOX_COORDINATES]
              for i in range(0, len(coordinates), MAX_MAPBOX_COORDINATES)]
    matched_geometries = []

    async with aiohttp.ClientSession() as client_session:
        for chunk in chunks:
            coordinates_str = ';'.join([f'{lon},{lat}' for lon, lat in chunk])
            url_with_coords = url + coordinates_str

            params = {
                'access_token': MAPBOX_ACCESS_TOKEN,
                'geometries': 'geojson',
                'radiuses': ';'.join(['25' for _ in chunk])
            }

            async with client_session.get(url_with_coords, params=params) as response:
                if response.status == 200:
                    data = await response.json()
                    if data['code'] == 'Ok':
                        matched_geometries.extend(
                            data['matchings'][0]['geometry']['coordinates'])
                    else:
                        print(
                            f"Error map-matching chunk: {data.get('message', 'Map Matching API Error')}")
                        return {'code': 'Error', 'message': data.get('message', 'Map Matching API Error')}
                elif response.status == 422:
                    error_data = await response.json()
                    print(
                        f"Error map-matching chunk: Status 422, Message: {error_data.get('message', 'No message')}, Coordinates: {chunk}")
                    return {'code': 'Error', 'message': error_data.get('message', 'Map Matching API Error 422')}
                else:
                    print(
                        f"Error map-matching chunk: Map Matching API request failed with status {response.status}")
                    return {'code': 'Error', 'message': f'Map Matching API request failed with status {response.status}'}

    return {'code': 'Ok', 'matchings': [{'geometry': {'coordinates': matched_geometries, 'type': 'LineString'}}]}


def is_valid_coordinate(coord):
    """Checks if a coordinate is within valid ranges."""
    lon, lat = coord
    return -90 <= lat <= 90 and -180 <= lon <= 180


async def process_and_map_match_trip(trip):
    """Processes a trip, map matches its coordinates, and stores the result."""
    try:
        existing_matched_trip = matched_trips_collection.find_one(
            {'transactionId': trip['transactionId']})
        if existing_matched_trip:
            print(
                f"Trip {trip['transactionId']} already map-matched. Skipping.")
            return

        if trip['imei'] == 'HISTORICAL':

            coords = geojson_loads(trip['gps'])['coordinates']
            total_distance = 0
            for i in range(len(coords) - 1):
                total_distance += haversine_distance(coords[i], coords[i + 1])
            trip['distance'] = total_distance

        gps_data = geojson_loads(trip['gps'])
        coordinates = gps_data['coordinates']

        if not coordinates:
            print(
                f"Error: Trip {trip['transactionId']} has no coordinates. Skipping.")
            return

        if not all(is_valid_coordinate(coord) for coord in coordinates):
            print(
                f"Error: Trip {trip['transactionId']} has invalid coordinates. Skipping.")
            return

        map_match_result = await map_match_coordinates(coordinates)

        if map_match_result['code'] == 'Ok':
            matched_trip = trip.copy()
            matched_trip['matchedGps'] = geojson_dumps(
                map_match_result['matchings'][0]['geometry'])
            matched_trips_collection.insert_one(matched_trip)
            print(f"Trip {trip['transactionId']} map-matched and stored.")
        else:
            print(
                f"Error map-matching trip {trip['transactionId']}: {map_match_result['message']}")

    except Exception as e:
        print(
            f"Error processing and map-matching trip {trip.get('transactionId', 'Unknown')}: {e}")
        print(traceback.format_exc())


def haversine_distance(coord1, coord2):
    """Calculates the distance between two coordinates using the Haversine formula."""
    R = 6371
    lat1, lon1 = math.radians(coord1[1]), math.radians(coord1[0])
    lat2, lon2 = math.radians(coord2[1]), math.radians(coord2[0])

    dlon = lon2 - lon1
    dlat = lat2 - lat1

    a = math.sin(dlat / 2)**2 + math.cos(lat1) * \
        math.cos(lat2) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    distance = R * c
    return distance * 0.621371


@app.route('/api/map_match_trips', methods=['POST'])
async def map_match_trips():
    """Map matches trips in the database within the specified date range."""
    try:
        data = request.json
        start_date_str = data.get('start_date')
        end_date_str = data.get('end_date')

        start_date = datetime.fromisoformat(start_date_str).replace(
            tzinfo=timezone.utc) if start_date_str else None
        end_date = datetime.fromisoformat(end_date_str).replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc) if end_date_str else None

        query = {}
        if start_date and end_date:
            query['startTime'] = {
                '$gte': start_date,
                '$lte': end_date
            }

        trips = trips_collection.find(query)
        for trip in trips:
            await process_and_map_match_trip(trip)
        return jsonify({'status': 'success', 'message': 'Map matching initiated for trips within the date range.'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/map_match_historical_trips', methods=['POST'])
async def map_match_historical_trips():
    """Map matches historical trips in the database within the specified date range."""
    try:
        data = request.json
        start_date_str = data.get('start_date')
        end_date_str = data.get('end_date')

        start_date = datetime.fromisoformat(start_date_str).replace(
            tzinfo=timezone.utc) if start_date_str else None
        end_date = datetime.fromisoformat(end_date_str).replace(
            hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc) if end_date_str else None

        query = {}
        if start_date and end_date:
            query['startTime'] = {
                '$gte': start_date,
                '$lte': end_date
            }

        historical_trips = historical_trips_collection.find(query)
        for trip in historical_trips:
            await process_and_map_match_trip(trip)
        return jsonify({'status': 'success', 'message': 'Map matching initiated for historical trips within the date range.'})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/matched_trips')
def get_matched_trips():
    """Returns map-matched trips as GeoJSON."""
    start_date_str = request.args.get('start_date')
    end_date_str = request.args.get('end_date')
    imei = request.args.get('imei')

    start_date = datetime.fromisoformat(start_date_str).replace(
        tzinfo=timezone.utc) if start_date_str else None
    end_date = datetime.fromisoformat(end_date_str).replace(
        hour=23, minute=59, second=59, microsecond=999999, tzinfo=timezone.utc) if end_date_str else None

    query = {}
    if start_date and end_date:
        query['startTime'] = {
            '$gte': start_date,
            '$lte': end_date
        }
    if imei:
        query['imei'] = imei

    matched_trips = list(matched_trips_collection.find(query))

    return jsonify(geojson_module.FeatureCollection([
        geojson_module.Feature(
            geometry=geojson_loads(trip['matchedGps']),
            properties={
                'transactionId': trip['transactionId'],
                'imei': trip['imei'],
                'startTime': trip['startTime'].isoformat(),
                'endTime': trip['endTime'].isoformat(),
                'distance': trip.get('distance', 0),
                'timezone': trip.get('timezone', 'America/Chicago'),
                'destination': trip.get('destination', 'N/A'),
                'startLocation': trip.get('startLocation', 'N/A')
            }
        ) for trip in matched_trips
    ]))


@app.route('/export')
def export_page():
    return render_template('export.html')


@app.route('/api/export/trips')
def export_trips():
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    export_format = request.args.get('format')

    trips = fetch_trips(start_date, end_date)

    if export_format == 'geojson':
        geojson_data = create_geojson(trips)
        return send_file(
            io.BytesIO(geojson_data.encode()),
            mimetype='application/geo+json',
            as_attachment=True,
            download_name='trips.geojson'
        )
    if export_format == 'gpx':
        gpx_data = create_gpx(trips)
        return send_file(
            io.BytesIO(gpx_data.encode()),
            mimetype='application/gpx+xml',
            as_attachment=True,
            download_name='trips.gpx'
        )


@app.route('/api/export/matched_trips')
def export_matched_trips():
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    export_format = request.args.get('format')

    matched_trips = fetch_matched_trips(start_date, end_date)

    if export_format == 'geojson':
        geojson_data = create_geojson(matched_trips)
        return send_file(
            io.BytesIO(geojson_data.encode()),
            mimetype='application/geo+json',
            as_attachment=True,
            download_name='matched_trips.geojson'
        )
    if export_format == 'gpx':
        gpx_data = create_gpx(matched_trips)
        return send_file(
            io.BytesIO(gpx_data.encode()),
            mimetype='application/gpx+xml',
            as_attachment=True,
            download_name='matched_trips.gpx'
        )


@app.route('/api/export/streets')
def export_streets():
    location = request.args.get('location')
    export_format = request.args.get('format')

    streets_data, _ = generate_geojson_osm(
        json.loads(location), streets_only=True)

    if export_format == 'geojson':
        return send_file(
            io.BytesIO(json.dumps(streets_data).encode()),
            mimetype='application/geo+json',
            as_attachment=True,
            download_name='streets.geojson'
        )
    if export_format == 'shapefile':
        gdf = gpd.GeoDataFrame.from_features(streets_data['features'])
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as zf:
            for ext in ['shp', 'shx', 'dbf', 'prj']:
                temp_file = io.BytesIO()
                gdf.to_file(temp_file, driver='ESRI Shapefile')
                temp_file.seek(0)
                zf.writestr(f'streets.{ext}', temp_file.getvalue())
        buffer.seek(0)
        return send_file(
            buffer,
            mimetype='application/zip',
            as_attachment=True,
            download_name='streets.zip'
        )


@app.route('/api/export/boundary')
def export_boundary():
    location = request.args.get('location')
    export_format = request.args.get('format')

    boundary_data, _ = generate_geojson_osm(
        json.loads(location), streets_only=False)

    if export_format == 'geojson':
        return send_file(
            io.BytesIO(json.dumps(boundary_data).encode()),
            mimetype='application/geo+json',
            as_attachment=True,
            download_name='boundary.geojson'
        )
    if export_format == 'shapefile':
        gdf = gpd.GeoDataFrame.from_features(boundary_data['features'])
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as zf:
            for ext in ['shp', 'shx', 'dbf', 'prj']:
                temp_file = io.BytesIO()
                gdf.to_file(temp_file, driver='ESRI Shapefile')
                temp_file.seek(0)
                zf.writestr(f'boundary.{ext}', temp_file.getvalue())
        buffer.seek(0)
        return send_file(
            buffer,
            mimetype='application/zip',
            as_attachment=True,
            download_name='boundary.zip'
        )


def fetch_trips(start_date, end_date):
    start_date = parser.parse(start_date)
    end_date = parser.parse(end_date)
    query = {
        'startTime': {
            '$gte': start_date,
            '$lte': end_date
        }
    }
    return list(trips_collection.find(query))


def fetch_matched_trips(start_date, end_date):
    start_date = parser.parse(start_date)
    end_date = parser.parse(end_date)
    query = {
        'startTime': {
            '$gte': start_date,
            '$lte': end_date
        }
    }
    return list(matched_trips_collection.find(query))


def create_geojson(trips):
    features = []
    for trip in trips:
        gps_data = trip['gps']
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)
        feature = {
            "type": "Feature",
            "geometry": gps_data,
            "properties": {
                "transactionId": trip.get('transactionId'),
                "startTime": trip.get('startTime').isoformat(),
                "endTime": trip.get('endTime').isoformat(),
                "distance": trip.get('distance'),
                "startLocation": trip.get('startLocation'),
                "destination": trip.get('destination')
            }
        }
        features.append(feature)

    geojson = {
        "type": "FeatureCollection",
        "features": features
    }
    return json.dumps(geojson)


def create_gpx(trips):
    gpx = gpxpy.gpx.GPX()

    for trip in trips:
        gpx_track = gpxpy.gpx.GPXTrack()
        gpx.tracks.append(gpx_track)

        gpx_segment = gpxpy.gpx.GPXTrackSegment()
        gpx_track.segments.append(gpx_segment)

        gps_data = trip['gps']
        if isinstance(gps_data, str):
            gps_data = json.loads(gps_data)

        if gps_data.get('type') == 'LineString':
            for coord in gps_data.get('coordinates', []):
                if isinstance(coord, list) and len(coord) >= 2:
                    lon, lat = coord[0], coord[1]
                    gpx_segment.points.append(
                        gpxpy.gpx.GPXTrackPoint(lat, lon))
        elif gps_data.get('type') == 'Point':
            coord = gps_data.get('coordinates', [])
            if isinstance(coord, list) and len(coord) >= 2:
                lon, lat = coord[0], coord[1]
                gpx_segment.points.append(gpxpy.gpx.GPXTrackPoint(lat, lon))

        gpx_track.name = trip.get('transactionId', 'Unnamed Trip')
        gpx_track.description = f"Trip from {trip.get('startLocation', 'Unknown')} to {trip.get('destination', 'Unknown')}"

    return gpx.to_xml()


@app.route('/api/streets', methods=['POST'])
def get_streets():
    location = request.json.get('location')

    if not location or not isinstance(location, dict) or 'type' not in location:
        return jsonify({'status': 'error', 'message': 'Invalid location data.'}), 400

    try:
        streets_data, error_message = generate_geojson_osm(
            location, streets_only=True)

        if streets_data is None:
            return jsonify({'status': 'error', 'message': f'Error fetching street data: {error_message}'}), 500

        # Prepare user's trip data
        trips = list(trips_collection.find())
        trip_geometries = []
        for trip in trips:
            gps_data = trip['gps']
            if isinstance(gps_data, str):
                gps_data = json.loads(gps_data)
            geom = shape(gps_data)
            if isinstance(geom, LineString):
                trip_geometries.append(geom)
            elif isinstance(geom, MultiLineString):
                trip_geometries.extend(geom.geoms)

        streets_gdf = gpd.GeoDataFrame.from_features(streets_data['features'])
        streets_gdf.set_crs(epsg=4326, inplace=True)

        if trip_geometries:
            trips_merged = linemerge(trip_geometries)
            streets_gdf['driven'] = streets_gdf.geometry.intersects(
                trips_merged)
        else:
            streets_gdf['driven'] = False

        # Convert streets to GeoJSON
        streets_json = json.loads(streets_gdf.to_json())
        return jsonify(streets_json)
    except Exception as e:
        return jsonify({'status': 'error', 'message': f'An error occurred: {str(e)}'}), 500


@app.route('/load_historical_data', methods=['POST'])
async def load_historical_data_endpoint():
    start_date = request.json.get('start_date')
    end_date = request.json.get('end_date')
    inserted_count = await load_historical_data(start_date, end_date)
    return jsonify({"message": f"Historical data loaded successfully. {inserted_count} new trips inserted."})


def process_street_chunk(streets_chunk, all_trips):
    return streets_chunk.intersects(all_trips)


def calculate_street_coverage(boundary_geojson, streets_geojson, matched_trips):
    try:
        logger.info("Converting streets to GeoDataFrame...")
        streets_gdf = gpd.GeoDataFrame.from_features(
            streets_geojson['features'])
        streets_gdf.set_crs(epsg=4326, inplace=True)

        # Convert to a projected CRS for accurate measurements (using UTM)
        logger.info("Converting to projected CRS...")
        # Get center point of data to determine UTM zone
        center_lat = streets_gdf.geometry.centroid.y.mean()
        center_lon = streets_gdf.geometry.centroid.x.mean()
        utm_zone = int((center_lon + 180) / 6) + 1
        utm_crs = f'EPSG:326{utm_zone:02d}' if center_lat >= 0 else f'EPSG:327{utm_zone:02d}'

        streets_gdf = streets_gdf.to_crs(utm_crs)

        logger.info("Processing matched trips...")
        chunk_size = 100
        all_lines = []

        for i in range(0, len(matched_trips), chunk_size):
            chunk = matched_trips[i:i + chunk_size]
            logger.info(
                f"Processing chunk {i//chunk_size + 1}/{len(matched_trips)//chunk_size + 1}")

            for trip in chunk:
                try:
                    trip_geom = shape(json.loads(trip['matchedGps']))
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
                           predicate='intersects', how='left')
        streets_gdf['driven'] = ~joined.index_right.isna()

        logger.info("Calculating final statistics...")
        total_length = streets_gdf.geometry.length.sum()
        driven_length = streets_gdf[streets_gdf['driven']
                                    ].geometry.length.sum()
        coverage_percentage = (driven_length / total_length) * 100

        # Convert back to WGS84 (EPSG:4326) for GeoJSON output
        logger.info("Converting back to WGS84 for output...")
        streets_gdf = streets_gdf.to_crs(epsg=4326)

        # Ensure valid GeoJSON output
        geojson_data = {
            'type': 'FeatureCollection',
            'features': []
        }

        for idx, row in streets_gdf.iterrows():
            feature = {
                'type': 'Feature',
                'geometry': mapping(row.geometry),
                'properties': {
                    'driven': bool(row['driven']),
                    'name': row.get('name', 'Unknown Street')
                }
            }
            geojson_data['features'].append(feature)

        return {
            'total_length': float(total_length),
            'driven_length': float(driven_length),
            'coverage_percentage': float(coverage_percentage),
            'streets_data': geojson_data
        }
    except Exception as e:
        logger.error(
            f"Error in calculate_street_coverage: {str(e)}\n{traceback.format_exc()}")
        raise


@app.route('/api/street_coverage', methods=['POST'])
def get_street_coverage():
    try:
        logger.info("Starting street coverage calculation")
        location = request.json.get('location')
        if not location:
            return jsonify({'error': 'No location provided'}), 400

        logger.info("Fetching OSM street network...")
        streets_data, streets_error = generate_geojson_osm(
            location, streets_only=True)
        if not streets_data:
            return jsonify({'error': f'Error getting streets: {streets_error}'}), 500

        logger.info("Fetching boundary data...")
        boundary_data, boundary_error = generate_geojson_osm(
            location, streets_only=False)
        if not boundary_data:
            return jsonify({'error': f'Error getting boundary: {boundary_error}'}), 500

        logger.info("Fetching matched trips...")
        matched_trips = list(matched_trips_collection.find())
        logger.info(f"Found {len(matched_trips)} matched trips")

        if not matched_trips:
            # Return empty but valid GeoJSON
            return jsonify({
                'total_length': 0,
                'driven_length': 0,
                'coverage_percentage': 0,
                'streets_data': {
                    'type': 'FeatureCollection',
                    'features': []
                }
            })

        logger.info("Calculating coverage...")
        coverage_data = calculate_street_coverage(
            boundary_data,
            streets_data,
            matched_trips
        )

        # Validate GeoJSON structure before returning
        if not coverage_data.get('streets_data') or \
           not isinstance(coverage_data['streets_data'], dict) or \
           coverage_data['streets_data'].get('type') != 'FeatureCollection' or \
           not isinstance(coverage_data['streets_data'].get('features'), list):
            raise ValueError("Invalid GeoJSON structure in coverage data")

        logger.info("Coverage calculation complete")
        return jsonify(coverage_data)
    except Exception as e:
        logger.error(
            f"Error in street coverage calculation: {str(e)}\n{traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    port = int(os.getenv('PORT', '8080'))
    threading.Timer(1, periodic_fetch_trips).start()
    socketio.run(app, host='0.0.0.0', port=port,
                 debug=False, allow_unsafe_werkzeug=True)
