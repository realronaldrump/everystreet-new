import asyncio
import json
from datetime import datetime, timedelta, timezone
import aiohttp
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO
import os
from dotenv import load_dotenv
from pymongo import MongoClient
import certifi
from geojson import loads as geojson_loads
import certifi

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY')
socketio = SocketIO(app)

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
except Exception as e:
    print(f"Error connecting to MongoDB: {e}")
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

def is_valid(geojson_obj):
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
        if not is_valid(geojson_obj):
            return False, "Invalid GeoJSON data"
    except Exception as e:
        return False, f"Error validating GeoJSON: {str(e)}"
    
    return True, None

async def fetch_and_store_trips():
    try:
        print("Starting fetch_and_store_trips")
        print(f"Authorized devices: {AUTHORIZED_DEVICES}")
        async with aiohttp.ClientSession() as session:
            access_token = await get_access_token(session)
            print("Access token obtained")
            
            end_date = datetime.now(timezone.utc)
            start_date = end_date - timedelta(days=1460)  # Fetch last 4 years of trips
            
            all_trips = []
            for imei in AUTHORIZED_DEVICES:
                print(f"Fetching trips for IMEI: {imei}")
                device_trips = await fetch_trips_in_intervals(session, access_token, imei, start_date, end_date)
                print(f"Fetched {len(device_trips)} trips for IMEI {imei}")
                all_trips.extend(device_trips)
                
            print(f"Total trips fetched: {len(all_trips)}")
            
            for trip in all_trips:
                try:
                    is_valid, error_message = validate_trip_data(trip)
                    if not is_valid:
                        print(f"Invalid trip data for {trip.get('transactionId', 'Unknown')}: {error_message}")
                        continue

                    trip['startTime'] = datetime.fromisoformat(trip['startTime'])
                    trip['endTime'] = datetime.fromisoformat(trip['endTime'])
                    if isinstance(trip['gps'], dict):
                        trip['gps'] = json.dumps(trip['gps'])
                    result = trips_collection.update_one(
                        {'transactionId': trip['transactionId']},
                        {'$set': trip},
                        upsert=True
                    )
                    print(f"Updated trip {trip['transactionId']} for IMEI {trip.get('imei', 'Unknown')}: {'Inserted' if result.upserted_id else 'Updated'}")
                except Exception as e:
                    print(f"Error updating trip {trip.get('transactionId', 'Unknown')}: {e}")
            
            # Log the count of trips in the database for each IMEI
            for imei in AUTHORIZED_DEVICES:
                try:
                    count = trips_collection.count_documents({'imei': imei})
                    print(f"Trips in database for IMEI {imei}: {count}")
                except Exception as e:
                    print(f"Error counting trips for IMEI {imei}: {e}")
        
    except Exception as e:
        print(f"Error in fetch_and_store_trips: {e}")
        import traceback
        traceback.print_exc()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/trips')
def trips_page():
    return render_template('trips.html') 

@app.route('/api/trips')
def get_trips():
    if trips_collection is None:
        return jsonify({"error": "Database not connected"}), 500
    
    try:
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        
        query = {}
        if start_date and end_date:
            query['startTime'] = {
                '$gte': datetime.fromisoformat(start_date),
                '$lte': datetime.fromisoformat(end_date)
            }
        else:
            end_date = datetime.now(timezone.utc)
            start_date = end_date - timedelta(days=1460)
            query['startTime'] = {'$gte': start_date, '$lte': end_date}
        
        query['imei'] = {'$in': AUTHORIZED_DEVICES}
        
        trips = list(trips_collection.find(query, {'_id': 0}))
        
        imei_counts = {}
        for trip in trips:
            imei = trip.get('imei')
            if imei:
                imei_counts[imei] = imei_counts.get(imei, 0) + 1
            else:
                print(f"Warning: Trip {trip.get('transactionId')} has no IMEI")
        
        for imei, count in imei_counts.items():
            print(f"Retrieved {count} trips for IMEI {imei}")
        
        for trip in trips:
            if 'gps' in trip and isinstance(trip['gps'], str):
                try:
                    trip['gps'] = json.loads(trip['gps'])
                except json.JSONDecodeError:
                    print(f"Error decoding GPS data for trip {trip.get('transactionId')}")
        
        print(f"Returning {len(trips)} trips in total")
        return jsonify(trips)
    except Exception as e:
        print(f"Error in get_trips: {e}")
        return jsonify({"error": "An error occurred while fetching trips"}), 500

@app.route('/api/metrics')
def get_metrics():
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    
    query = {}
    if start_date and end_date:
        query['startTime'] = {
            '$gte': datetime.fromisoformat(start_date),
            '$lte': datetime.fromisoformat(end_date)
        }
    else:
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=1460)
        query['startTime'] = {'$gte': start_date, '$lte': end_date}
    
    trips = list(trips_collection.find(query))
    
    total_trips = len(trips)
    total_distance = sum(trip['distance'] for trip in trips)
    avg_distance = total_distance / total_trips if total_trips > 0 else 0
    avg_start_time = sum((trip['startTime'].hour * 60 + trip['startTime'].minute) for trip in trips) / total_trips if total_trips > 0 else 0
    avg_driving_time = sum((trip['endTime'] - trip['startTime']).total_seconds() / 60 for trip in trips) / total_trips if total_trips > 0 else 0
    
    metrics = {
        'total_trips': total_trips,
        'total_distance': total_distance,
        'avg_distance': avg_distance,
        'avg_start_time': f"{int(avg_start_time // 60):02d}:{int(avg_start_time % 60):02d}",
        'avg_driving_time': f"{int(avg_driving_time // 60):02d}:{int(avg_driving_time % 60):02d}"
    }
    
    return jsonify(metrics)

@app.route('/webhook', methods=['POST'])
def webhook():
    data = request.json
    if data['eventType'] == 'tripData' and data['imei'] in AUTHORIZED_DEVICES:
        live_routes_collection.insert_one(data)
        socketio.emit('live_route_update', data)
    return '', 204

async def start_background_tasks():
    await fetch_and_store_trips()

if __name__ == '__main__':
    port = int(os.getenv('PORT', 8080))
    asyncio.run(start_background_tasks())
    socketio.run(app, port=port, debug=False, allow_unsafe_werkzeug=True)
