import json
from datetime import datetime, timedelta, timezone
import aiohttp
from flask import Flask, render_template, request, jsonify, session
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

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY')
socketio = SocketIO(app, async_mode='eventlet') 

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
    live_routes_collection = db['live_routes']
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

# Initialize TimezoneFinder
tf = TimezoneFinder()

time_offset = 0

@app.route('/api/set_time_offset', methods=['POST'])
def set_time_offset():
    global time_offset
    data = request.json
    time_offset = data.get('offset', 0)
    return jsonify({"status": "success", "message": f"Time offset set to {time_offset} hours"})

def apply_time_offset(date):
    return date + timedelta(hours=time_offset)

async def get_access_token(session):
    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": AUTH_CODE,
        "redirect_uri": REDIRECT_URI
    }
    async with session.post(AUTH_URL, data=payload) as response:
        data = await response.json()
        return data.get('access_token')

async def get_trips_from_api(session, access_token, imei, start_date, end_date):
    headers = {"Authorization": access_token, "Content-Type": "application/json"}
    params = {
        "imei": imei,
        "gps-format": "geojson",
        "starts-after": start_date.isoformat(),
        "ends-before": end_date.isoformat()
    }
    async with session.get(f"{API_BASE_URL}/trips", headers=headers, params=params) as response:
        if response.status == 200:
            return await response.json()
        else:
            print(f"Error fetching trips: {response.status}")
            return []

async def fetch_trips_in_intervals(session, access_token, imei, start_date, end_date):
    all_trips = []
    current_start = start_date
    while current_start < end_date:
        current_end = min(current_start + timedelta(days=7), end_date)
        trips = await get_trips_from_api(session, access_token, imei, current_start, current_end)
        all_trips.extend(trips)
        current_start = current_end
    return all_trips

def is_valid_geojson(geojson_obj):
    if geojson_obj['type'] not in ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon', 'GeometryCollection']:
        return False
    return True

def validate_trip_data(trip):
    required_fields = ['transactionId', 'imei', 'startTime', 'endTime', 'distance', 'gps']
    for field in required_fields:
        if field not in trip:
            return False, f"Missing required field: {field}"
    
    try:
        geojson_obj = geojson_loads(trip['gps'] if isinstance(trip['gps'], str) else json.dumps(trip['gps']))
        if not is_valid_geojson(geojson_obj):
            return False, "Invalid GeoJSON data"
    except Exception as validation_error:
        return False, f"Error validating GeoJSON: {str(validation_error)}"
    
    return True, None

async def reverse_geocode_nominatim(lat, lon):
    url = f"https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat={lat}&lon={lon}&addressdetails=1"
    headers = {'User-Agent': 'EveryStreet/1.0'}
    async with aiohttp.ClientSession() as session:
        async with session.get(url, headers=headers) as response:
            if response.status == 200:
                data = await response.json()
                address = data.get('address', {})
                formatted_address = []

                # Build the address from desired components
                if 'house_number' in address:
                    formatted_address.append(address['house_number'])
                if 'road' in address:
                    formatted_address.append(address['road'])
                if 'city' in address:
                    formatted_address.append(address['city'])
                elif 'town' in address:
                    formatted_address.append(address['town'])
                elif 'village' in address:
                    formatted_address.append(address['village'])
                if 'state' in address:
                    formatted_address.append(address['state'])

                return ', '.join(formatted_address)
            else:
                print(f"Nominatim API error: {response.status}")
                return f"Location at {lat}, {lon}"
    
    # Add a small delay to avoid overwhelming the Nominatim service
    await asyncio.sleep(0.1)

def fetch_trips_for_geojson():
    trips = trips_collection.find()  # Adjust your query as needed
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
                "startLocation": trip.get('startLocation', 'N/A')  # Add this line
            }
        )
        features.append(feature)
    
    return geojson_module.FeatureCollection(features)

def get_trip_timezone(trip):
    """
    Determines the timezone of a trip based on its GPS coordinates.
    If no timezone can be determined, defaults to Waco, TX timezone.
    """
    try:
        gps_data = geojson_loads(trip['gps'] if isinstance(trip['gps'], str) else json.dumps(trip['gps']))
        if gps_data['coordinates']:
            # Get the coordinates of the first point in the trip
            lon, lat = gps_data['coordinates'][0]
            timezone_str = tf.timezone_at(lng=lon, lat=lat)
            if timezone_str:
                return timezone_str
        return 'America/Chicago'  # Default to Waco, TX timezone
    except Exception as e:
        print(f"Error getting trip timezone: {e}")
        return 'America/Chicago'  # Default to Waco, TX timezone

async def fetch_and_store_trips():
    try:
        print("Starting fetch_and_store_trips")
        print(f"Authorized devices: {AUTHORIZED_DEVICES}")
        async with aiohttp.ClientSession() as session:
            access_token = await get_access_token(session)
            print("Access token obtained")
            
            end_date = datetime.now(timezone.utc)
            start_date = end_date - timedelta(days=365*4)  # Fetch last x days of trips
            
            all_trips = []
            total_devices = len(AUTHORIZED_DEVICES)
            for device_count, imei in enumerate(AUTHORIZED_DEVICES, 1):
                print(f"Fetching trips for IMEI: {imei}")
                device_trips = await fetch_trips_in_intervals(session, access_token, imei, start_date, end_date)
                print(f"Fetched {len(device_trips)} trips for IMEI {imei}")
                all_trips.extend(device_trips)
                
                # Calculate and emit progress
                progress = int((device_count / total_devices) * 100)
                socketio.emit('loading_progress', {'progress': progress})
                
            print(f"Total trips fetched: {len(all_trips)}")
            
            for trip in all_trips:
                try:
                    # Check if the trip already exists in the database
                    existing_trip = trips_collection.find_one({'transactionId': trip['transactionId']})
                    if existing_trip:
                        print(f"Trip {trip['transactionId']} already exists in the database. Skipping.")
                        continue
                    is_valid, error_message = validate_trip_data(trip)
                    if not is_valid:
                        print(f"Invalid trip data for {trip.get('transactionId', 'Unknown')}: {error_message}")
                        continue

                    # Get the trip's timezone
                    trip_timezone = get_trip_timezone(trip)

                    # Parse the timestamps as naive datetime objects
                    trip['startTime'] = datetime.fromisoformat(trip['startTime'].replace('Z', '+00:00')).replace(tzinfo=None)
                    trip['endTime'] = datetime.fromisoformat(trip['endTime'].replace('Z', '+00:00')).replace(tzinfo=None)

                    # Localize the naive datetime objects to UTC, then convert to the trip's timezone
                    trip['startTime'] = pytz.utc.localize(trip['startTime']).astimezone(pytz.timezone(trip_timezone))
                    trip['endTime'] = pytz.utc.localize(trip['endTime']).astimezone(pytz.timezone(trip_timezone))
                    
                    # Parse the GPS data
                    gps_data = geojson_loads(trip['gps'] if isinstance(trip['gps'], str) else json.dumps(trip['gps']))
                    
                    # Extract the first and last points
                    start_point = gps_data['coordinates'][0]
                    last_point = gps_data['coordinates'][-1]
                    
                    # Store the start point as a separate field
                    trip['startGeoPoint'] = start_point
                    
                    # Store the last point as a separate field
                    trip['destinationGeoPoint'] = last_point
                    
                    # Use the last point for reverse geocoding
                    trip['destination'] = await reverse_geocode_nominatim(last_point[1], last_point[0])
                    
                    # Use the first point for reverse geocoding the start location
                    trip['startLocation'] = await reverse_geocode_nominatim(start_point[1], start_point[0])
                    
                    if isinstance(trip['gps'], dict):
                        trip['gps'] = geojson_dumps(trip['gps'])
                    result = trips_collection.update_one(
                        {'transactionId': trip['transactionId']},
                        {'$set': trip},
                        upsert=True
                    )
                    print(f"Updated trip {trip['transactionId']} for IMEI {trip.get('imei', 'Unknown')}: {'Inserted' if result.upserted_id else 'Updated'}")
                except Exception as trip_error:
                    print(f"Error updating trip {trip.get('transactionId', 'Unknown')}: {trip_error}")
                    print(traceback.format_exc())
            
            # Log the count of trips in the database for each IMEI
            for imei in AUTHORIZED_DEVICES:
                try:
                    count = trips_collection.count_documents({'imei': imei})
                    print(f"Trips in database for IMEI {imei}: {count}")
                except Exception as count_error:
                    print(f"Error counting trips for IMEI {imei}: {count_error}")
        
    except Exception as fetch_error:
        print(f"Error in fetch_and_store_trips: {fetch_error}")
        print(traceback.format_exc())

async def fetch_and_store_trips_in_range(start_date, end_date):
    try:
        print("Starting fetch_and_store_trips_in_range")
        print(f"Authorized devices: {AUTHORIZED_DEVICES}")
        async with aiohttp.ClientSession() as session:
            access_token = await get_access_token(session)
            print("Access token obtained")
            
            all_trips = []
            for imei in AUTHORIZED_DEVICES:
                print(f"Fetching trips for IMEI: {imei}")
                device_trips = await fetch_trips_in_intervals(session, access_token, imei, start_date, end_date)
                print(f"Fetched {len(device_trips)} trips for IMEI {imei}")
                all_trips.extend(device_trips)
                
            print(f"Total trips fetched: {len(all_trips)}")
            
            for trip in all_trips:
                try:
                    existing_trip = trips_collection.find_one({'transactionId': trip['transactionId']})
                    if existing_trip:
                        print(f"Trip {trip['transactionId']} already exists in the database. Skipping.")
                        continue

                    is_valid, error_message = validate_trip_data(trip)
                    if not is_valid:
                        print(f"Invalid trip data for {trip.get('transactionId', 'Unknown')}: {error_message}")
                        continue

                    # Get the trip's timezone
                    trip_timezone = get_trip_timezone(trip)

                    # Parse the timestamps as naive datetime objects
                    trip['startTime'] = datetime.fromisoformat(trip['startTime'].replace('Z', '+00:00')).replace(tzinfo=None)
                    trip['endTime'] = datetime.fromisoformat(trip['endTime'].replace('Z', '+00:00')).replace(tzinfo=None)

                    # Localize the naive datetime objects to UTC, then convert to the trip's timezone
                    trip['startTime'] = pytz.utc.localize(trip['startTime']).astimezone(pytz.timezone(trip_timezone))
                    trip['endTime'] = pytz.utc.localize(trip['endTime']).astimezone(pytz.timezone(trip_timezone))
                    
                    # Parse the GPS data
                    gps_data = geojson_loads(trip['gps'] if isinstance(trip['gps'], str) else json.dumps(trip['gps']))
                    
                    # Extract the first and last points
                    start_point = gps_data['coordinates'][0]
                    last_point = gps_data['coordinates'][-1]
                    
                    # Store the start point as a separate field
                    trip['startGeoPoint'] = start_point
                    
                    # Store the last point as a separate field
                    trip['destinationGeoPoint'] = last_point
                    
                    # Use the last point for reverse geocoding
                    trip['destination'] = await reverse_geocode_nominatim(last_point[1], last_point[0])
                    
                    # Use the first point for reverse geocoding the start location
                    trip['startLocation'] = await reverse_geocode_nominatim(start_point[1], start_point[0])
                    
                    if isinstance(trip['gps'], dict):
                        trip['gps'] = geojson_dumps(trip['gps'])
                    result = trips_collection.update_one(
                        {'transactionId': trip['transactionId']},
                        {'$set': trip},
                        upsert=True
                    )
                    print(f"Updated trip {trip['transactionId']} for IMEI {trip.get('imei', 'Unknown')}: {'Inserted' if result.upserted_id else 'Updated'}")
                except Exception as trip_error:
                    print(f"Error updating trip {trip.get('transactionId', 'Unknown')}: {trip_error}")
                    print(traceback.format_exc())
            
            for imei in AUTHORIZED_DEVICES:
                try:
                    count = trips_collection.count_documents({'imei': imei})
                    print(f"Trips in database for IMEI {imei}: {count}")
                except Exception as count_error:
                    print(f"Error counting trips for IMEI {imei}: {count_error}")
    except Exception as fetch_error:
        print(f"Error in fetch_and_store_trips_in_range: {fetch_error}")
        print(traceback.format_exc())

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/trips')
def trips_page():
    return render_template('trips.html')

@app.route('/driving-insights')
def driving_insights_page():
    return render_template('driving_insights.html')

@app.route('/api/trips')
def get_trips():
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    imei = request.args.get('imei')

    query = {}
    if start_date and end_date:
        query['startTime'] = {
            '$gte': datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc),
            '$lte': datetime.fromisoformat(end_date).replace(tzinfo=timezone.utc)
        }
    if imei:
        query['imei'] = imei

    trips = list(trips_collection.find(query))
    
    for trip in trips:
        trip['startTime'] = apply_time_offset(trip['startTime'].astimezone(pytz.timezone('America/Chicago')))
        trip['endTime'] = apply_time_offset(trip['endTime'].astimezone(pytz.timezone('America/Chicago')))
        trip['_id'] = str(trip['_id'])

    return jsonify(geojson_module.FeatureCollection([
        geojson_module.Feature(
            geometry=geojson_loads(trip['gps']),
            properties={
                'transactionId': trip['transactionId'],
                'imei': trip['imei'],
                'startTime': trip['startTime'].isoformat(),
                'endTime': trip['endTime'].isoformat(),
                'distance': trip['distance'],
                'timezone': trip.get('timezone', 'America/Chicago'),
                'destination': trip.get('destination', 'N/A'),
                'startLocation': trip.get('startLocation', 'N/A')
            }
        ) for trip in trips
    ]))

@app.route('/api/driving-insights')
def get_driving_insights():
    if trips_collection is None:
        return jsonify({"error": "Database not connected"}), 500
    
    try:
        start_date_str = request.args.get('start_date')
        end_date_str = request.args.get('end_date')
        imei = request.args.get('imei')
        
        query = {}
        if start_date_str and end_date_str:
            query['startTime'] = {
                '$gte': datetime.fromisoformat(start_date_str).replace(tzinfo=timezone.utc),
                '$lte': datetime.fromisoformat(end_date_str).replace(tzinfo=timezone.utc)
            }
        else:
            # Default to last 7 days
            end_date = datetime.now(timezone.utc)
            start_date = end_date - timedelta(days=7)
            query['startTime'] = {'$gte': start_date, '$lte': end_date}
        
        if imei:
            query['imei'] = imei
        
        pipeline = [
            {'$match': query},
            {
                '$group': {
                    '_id': '$destination',
                    'count': {'$sum': 1},
                    'totalDistance': {'$sum': '$distance'},
                    'averageDistance': {'$avg': '$distance'},
                    'lastVisit': {'$max': '$endTime'}
                }
            },
            {'$sort': {'count': -1}}
        ]
        
        insights = list(trips_collection.aggregate(pipeline))
        
        # Convert datetime objects to strings
        for insight in insights:
            if 'lastVisit' in insight:
                insight['lastVisit'] = insight['lastVisit'].astimezone(pytz.timezone('America/Chicago')).isoformat()
        
        return jsonify(insights)
    except Exception as insight_error:
        print(f"Error in get_driving_insights: {insight_error}")
        print(traceback.format_exc())
        return jsonify({"error": f"An error occurred while fetching driving insights: {str(insight_error)}"}), 500

@app.route('/api/metrics')
def get_metrics():
    start_date_str = request.args.get('start_date')
    end_date_str = request.args.get('end_date')
    imei = request.args.get('imei')
    
    query = {}
    if start_date_str and end_date_str:
        query['startTime'] = {
            '$gte': datetime.fromisoformat(start_date_str).replace(tzinfo=timezone.utc),
            '$lte': datetime.fromisoformat(end_date_str).replace(tzinfo=timezone.utc)
        }
    else:
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=1460)
        query['startTime'] = {'$gte': start_date, '$lte': end_date}
    
    if imei:
        query['imei'] = imei
    else:
        query['imei'] = {'$in': AUTHORIZED_DEVICES}
    
    pipeline = [
        {'$match': query},
        {'$group': {
            '_id': None,
            'total_trips': {'$sum': 1},
            'total_distance': {'$sum': '$distance'},
            'avg_start_time': {'$avg': {'$hour': '$startTime'}},
            'avg_driving_time': {'$avg': {'$subtract': ['$endTime', '$startTime']}}
        }}
    ]
    
    result = list(trips_collection.aggregate(pipeline))
    
    if result:
        metrics = result[0]
        total_trips = metrics['total_trips']
        total_distance = metrics['total_distance']
        avg_distance = total_distance / total_trips if total_trips > 0 else 0
        avg_start_time = metrics['avg_start_time']
        avg_driving_time = metrics['avg_driving_time'] / 60000  # Convert to minutes
        
        return jsonify({
            'total_trips': total_trips,
            'total_distance': round(total_distance, 2),
            'avg_distance': round(avg_distance, 2),
            'avg_start_time': f"{int(avg_start_time):02d}:{int((avg_start_time % 1) * 60):02d}",
            'avg_driving_time': f"{int(avg_driving_time // 60):02d}:{int(avg_driving_time % 60):02d}"
        })
    else:
        return jsonify({
            'total_trips': 0,
            'total_distance': 0,
            'avg_distance': 0,
            'avg_start_time': "00:00",
            'avg_driving_time': "00:00"
        })

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.json
    if data['imei'] in AUTHORIZED_DEVICES:
        if data['eventType'] == 'tripData':
            live_routes_collection.insert_one(data)
            data['isVehicleOff'] = False
            socketio.emit('live_route_update', data)
        elif data['eventType'] == 'tripEnd':
            data['isVehicleOff'] = True
            socketio.emit('live_route_update', data)
    return '', 204

@app.route('/api/fetch_trips', methods=['POST'])
async def api_fetch_trips():
    try:
        await fetch_and_store_trips()
        return jsonify({"status": "success", "message": "Trips fetched and stored successfully."}), 200
    except Exception as fetch_error:
        return jsonify({"status": "error", "message": str(fetch_error)}), 500

@app.route('/api/fetch_trips_in_range', methods=['POST'])
async def api_fetch_trips_in_range():
    try:
        data = request.json
        start_date = datetime.fromisoformat(data['start_date']).replace(tzinfo=timezone.utc)
        end_date = datetime.fromisoformat(data['end_date']).replace(tzinfo=timezone.utc) + timedelta(days=1)  # Include end date
        await fetch_and_store_trips_in_range(start_date, end_date)
        return jsonify({"status": "success", "message": "Trips fetched and stored successfully."}), 200
    except Exception as fetch_error:
        return jsonify({"status": "error", "message": str(fetch_error)}), 500

@app.after_request
def add_header(response):
    """
    Add headers to prevent caching.
    """
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

@app.route('/export/geojson')
def export_geojson():
    try:
        geojson_data = fetch_trips_for_geojson()
        return jsonify(geojson_data)
    except Exception as export_error:
        return jsonify({"error": str(export_error)}), 500

async def start_background_tasks():
    await fetch_and_store_trips()

if __name__ == '__main__':
    port = int(os.getenv('PORT', '8080'))
    socketio.run(app, port=port, debug=False, allow_unsafe_werkzeug=True)