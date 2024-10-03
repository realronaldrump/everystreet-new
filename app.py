import asyncio
import json
from datetime import datetime, timedelta, timezone
import aiohttp
from flask import Flask, render_template, request, jsonify, make_response
from flask_socketio import SocketIO
import os
from dotenv import load_dotenv
from pymongo import MongoClient
import certifi
from geojson import loads as geojson_loads, dumps as geojson_dumps
import traceback

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

async def reverse_geocode_nominatim(lat, lon):
    url = f"https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat={lat}&lon={lon}&addressdetails=1"
    headers = {'User-Agent': 'EveryStreet/1.0'}
    try:
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
    except Exception as e:
        print(f"Error in Nominatim geocoding: {e}")
        return f"Location at {lat}, {lon}"

def fetch_trips_for_geojson():
    trips = trips_collection.find()  # Adjust your query as needed
    features = []
    
    for trip in trips:
        feature = geojson.Feature(
            geometry=geojson.loads(trip['gps']),
            properties={
                "transactionId": trip['transactionId'],
                "imei": trip['imei'],
                "startTime": trip['startTime'],
                "endTime": trip['endTime'],
                "distance": trip['distance'],
                "destination": trip['destination']
            }
        )
        features.append(feature)
    
    return geojson.FeatureCollection(features)
    
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
            for imei in AUTHORIZED_DEVICES:
                print(f"Fetching trips for IMEI: {imei}")
                device_trips = await fetch_trips_in_intervals(session, access_token, imei, start_date, end_date)
                print(f"Fetched {len(device_trips)} trips for IMEI {imei}")
                all_trips.extend(device_trips)
                
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

                    trip['startTime'] = datetime.fromisoformat(trip['startTime'])
                    trip['endTime'] = datetime.fromisoformat(trip['endTime'])
                    
                    # Reverse geocode the last point of the trip
                    gps_data = geojson_loads(trip['gps'] if isinstance(trip['gps'], str) else json.dumps(trip['gps']))
                    last_point = gps_data['coordinates'][-1]
                    print(f"Last point coordinates: {last_point}")
                    trip['destination'] = await reverse_geocode_nominatim(last_point[1], last_point[0])
                    
                    if isinstance(trip['gps'], dict):
                        trip['gps'] = geojson_dumps(trip['gps'])
                    result = trips_collection.update_one(
                        {'transactionId': trip['transactionId']},
                        {'$set': trip},
                        upsert=True
                    )
                    print(f"Updated trip {trip['transactionId']} for IMEI {trip.get('imei', 'Unknown')}: {'Inserted' if result.upserted_id else 'Updated'}")
                except Exception as e:
                    print(f"Error updating trip {trip.get('transactionId', 'Unknown')}: {e}")
                    print(traceback.format_exc())
            
            # Log the count of trips in the database for each IMEI
            for imei in AUTHORIZED_DEVICES:
                try:
                    count = trips_collection.count_documents({'imei': imei})
                    print(f"Trips in database for IMEI {imei}: {count}")
                except Exception as e:
                    print(f"Error counting trips for IMEI {imei}: {e}")
        
    except Exception as e:
        print(f"Error in fetch_and_store_trips: {e}")
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
    if trips_collection is None:
        return jsonify({"error": "Database not connected"}), 500
    
    try:
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        imei = request.args.get('imei')
        
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
        
        if imei:
            query['imei'] = imei
        else:
            query['imei'] = {'$in': AUTHORIZED_DEVICES}
        
        print(f"Query: {query}")  # Debug print
        
        # Projection to limit the fields returned
        projection = {
            '_id': 0,
            'transactionId': 1,
            'imei': 1,
            'startTime': 1,
            'endTime': 1,
            'distance': 1,
            'gps': 1,
            'destination': 1
        }
        
        trips = list(trips_collection.find(query, projection))
        print(f"Found {len(trips)} trips")  # Debug print
        
        # Process trips on the server side
        processed_trips = []
        for trip in trips:
            try:
                gps_data = trip['gps']
                if isinstance(gps_data, str):
                    gps_data = json.loads(gps_data)
                
                processed_trip = {
                    'type': 'Feature',
                    'geometry': gps_data,
                    'properties': {
                        'transactionId': trip['transactionId'],
                        'imei': trip['imei'],
                        'startTime': trip['startTime'].isoformat(),
                        'endTime': trip['endTime'].isoformat(),
                        'distance': trip['distance'],
                        'destination': trip.get('destination', 'Unknown')
                    }
                }
                processed_trips.append(processed_trip)
            except Exception as e:
                print(f"Error processing trip {trip.get('transactionId', 'Unknown')}: {e}")
                print(f"Trip data: {trip}")
                print(traceback.format_exc())
        
        geojson = {
            'type': 'FeatureCollection',
            'features': processed_trips
        }
        
        total_trips = len(processed_trips)
        print(f"Returning {total_trips} trips in total")
        
        return jsonify(geojson)
    except Exception as e:
        print(f"Error in get_trips: {e}")
        print(traceback.format_exc())
        return jsonify({"error": f"An error occurred while fetching trips: {str(e)}"}), 500

@app.route('/api/driving-insights')
def get_driving_insights():
    if trips_collection is None:
        return jsonify({"error": "Database not connected"}), 500
    
    try:
        start_date = request.args.get('start_date')
        end_date = request.args.get('end_date')
        imei = request.args.get('imei')
        
        query = {}
        if start_date and end_date:
            query['startTime'] = {
                '$gte': datetime.fromisoformat(start_date),
                '$lte': datetime.fromisoformat(end_date)
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
                insight['lastVisit'] = insight['lastVisit'].isoformat()
        
        return jsonify(insights)
    except Exception as e:
        print(f"Error in get_driving_insights: {e}")
        print(traceback.format_exc())
        return jsonify({"error": f"An error occurred while fetching driving insights: {str(e)}"}), 500

@app.route('/api/metrics')
def get_metrics():
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    imei = request.args.get('imei')
    
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
    if data['eventType'] == 'tripData' and data['imei'] in AUTHORIZED_DEVICES:
        live_routes_collection.insert_one(data)
        socketio.emit('live_route_update', data)
    return '', 204

@app.route('/api/fetch_trips', methods=['POST'])
async def api_fetch_trips():
    try:
        await fetch_and_store_trips()
        return jsonify({"status": "success", "message": "Trips fetched and stored successfully."}), 200
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

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
    except Exception as e:
        return jsonify({"error": str(e)}), 500

async def start_background_tasks():
    await fetch_and_store_trips()

if __name__ == '__main__':
    port = int(os.getenv('PORT', 8080))
    socketio.run(app, port=port, debug=False, allow_unsafe_werkzeug=True)
