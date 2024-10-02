import asyncio
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO
import os
from dotenv import load_dotenv
from datetime import datetime, timedelta, timezone
from pymongo import MongoClient
import json
import geojson
from bounciepy import AsyncRESTAPIClient
from bson import json_util

# Load environment variables from .env file
load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY')
socketio = SocketIO(app)

# MongoDB setup
try:
    client = MongoClient(os.getenv('MONGO_URI'))
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
AUTHORIZED_DEVICES = os.getenv('AUTHORIZED_DEVICES').split(',')
MAPBOX_ACCESS_TOKEN = os.getenv('MAPBOX_ACCESS_TOKEN')

# Create AsyncRESTAPIClient instance
bouncie_client = AsyncRESTAPIClient(
    client_id=CLIENT_ID,
    client_secret=CLIENT_SECRET,
    redirect_url=REDIRECT_URI,
    auth_code=AUTH_CODE
)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/trips')
def get_trips():
    if trips_collection is None:
        return jsonify({"error": "Database not connected"}), 500
    
    start_date = request.args.get('start_date')
    end_date = request.args.get('end_date')
    
    query = {}
    if start_date and end_date:
        query['startTime'] = {
            '$gte': datetime.fromisoformat(start_date),
            '$lte': datetime.fromisoformat(end_date)
        }
    
    query['imei'] = {'$in': AUTHORIZED_DEVICES}
    
    trips = list(trips_collection.find(query, {'_id': 0}))
    
    # Log trips count for each IMEI
    imei_counts = {}
    for trip in trips:
        imei = trip.get('imei')
        if imei:
            imei_counts[imei] = imei_counts.get(imei, 0) + 1
        else:
            print(f"Warning: Trip {trip.get('transactionId')} has no IMEI")
    
    for imei, count in imei_counts.items():
        print(f"Retrieved {count} trips for IMEI {imei}")
    
    # Convert ObjectId to string for JSON serialization and ensure IMEI is included
    for trip in trips:
        if 'gps' in trip and isinstance(trip['gps'], dict):
            trip['gps'] = json.dumps(trip['gps'])
    
    print(f"Returning {len(trips)} trips in total")
    return jsonify(trips)

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

# Fetch trips and store in MongoDB
async def fetch_and_store_trips():
    try:
        await bouncie_client.get_access_token()
        
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(days=4*365)  # Fetch last 4 years of trips
        
        all_trips = []
        for imei in AUTHORIZED_DEVICES:
            print(f"Fetching trips for IMEI {imei}")
            trips = await bouncie_client.get_trips(imei=imei, gps_format="geojson")
            
            if trips is None:
                print(f"No trips fetched for IMEI {imei}")
                continue  # Skip processing if trips is None

            # Filter trips based on start_date and end_date
            filtered_trips = [
                trip for trip in trips
                if start_date <= datetime.fromisoformat(trip['startTime']) <= end_date
            ]

            print(f"Fetched {len(filtered_trips)} trips for IMEI {imei}")
            
            if filtered_trips:
                for trip in filtered_trips:
                    trip['startTime'] = datetime.fromisoformat(trip['startTime'])
                    trip['endTime'] = datetime.fromisoformat(trip['endTime'])
                    trip['imei'] = imei  # Ensure IMEI is stored with each trip
                    result = trips_collection.update_one(
                        {'transactionId': trip['transactionId']},
                        {'$set': trip},
                        upsert=True
                    )
                    print(f"Updated trip {trip['transactionId']} for IMEI {imei}: {'Inserted' if result.upserted_id else 'Updated'}")
                all_trips.extend(filtered_trips)
            
            print(f"Successfully processed {len(filtered_trips)} trips for IMEI {imei}")
        print(f"Total trips processed: {len(all_trips)}")
        
        # Log the count of trips in the database for each IMEI
        for imei in AUTHORIZED_DEVICES:
            count = trips_collection.count_documents({'imei': imei})
            print(f"Trips in database for IMEI {imei}: {count}")
        
    except Exception as e:
        print(f"Error in fetch_and_store_trips: {e}")
    finally:
        await bouncie_client._session.close()  # Ensure the session is closed

# Start background tasks
async def start_background_tasks():
    await fetch_and_store_trips()

if __name__ == '__main__':
    asyncio.run(start_background_tasks())
    socketio.run(app, port=8080, debug=True, allow_unsafe_werkzeug=True)