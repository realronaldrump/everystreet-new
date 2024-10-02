import json
from pymongo import MongoClient
import os
from dotenv import load_dotenv
from geojson import loads as geojson_loads

load_dotenv()

client = MongoClient(os.getenv('MONGO_URI'))
db = client['every_street']
trips_collection = db['trips']

def validate_and_fix_gps(gps_data):
    if isinstance(gps_data, str):
        try:
            gps_json = json.loads(gps_data)
        except json.JSONDecodeError:
            return None
    elif isinstance(gps_data, dict):
        gps_json = gps_data
    else:
        return None

    try:
        if is_valid(gps_json):
            return json.dumps(gps_json)
        else:
            return None
    except Exception:
        return None

def migrate_trips():
    for trip in trips_collection.find():
        if 'gps' in trip:
            fixed_gps = validate_and_fix_gps(trip['gps'])
            if fixed_gps:
                trips_collection.update_one(
                    {'_id': trip['_id']},
                    {'$set': {'gps': fixed_gps}}
                )
                print(f"Updated GPS data for trip {trip['transactionId']}")
            else:
                print(f"Invalid GPS data for trip {trip['transactionId']}, could not fix")

if __name__ == "__main__":
    migrate_trips()
    print("Migration completed")