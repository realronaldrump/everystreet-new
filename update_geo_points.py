from pymongo import MongoClient
from shapely.geometry import Point
import json
from datetime import datetime, timezone
import os
import sys

# Database setup (ensure these match your settings)
MONGO_URI = os.environ.get("MONGO_URI")  # Fetch from environment variable
DB_NAME = "every_street"  # Replace with your database name

client = MongoClient(MONGO_URI)
db = client[DB_NAME]
trips_collection = db["trips"]
historical_trips_collection = db["historical_trips"]
uploaded_trips_collection = db["uploaded_trips"]

def update_geo_points(collection):
    """
    Updates documents in the given collection to add startGeoPoint and destinationGeoPoint.
    """
    print(f"Updating collection: {collection.name}")
    updated_count = 0
    for doc in collection.find(
        {
            "$or": [
                {"startGeoPoint": {"$exists": False}},
                {"destinationGeoPoint": {"$exists": False}},
            ]
        }
    ):
        try:
            gps_data = doc["gps"]
            if isinstance(gps_data, str):
                gps_data = json.loads(gps_data)
            coords = gps_data["coordinates"]
            start_coord = coords[0]
            end_coord = coords[-1]

            update_fields = {}
            if "startGeoPoint" not in doc:
                update_fields["startGeoPoint"] = {
                    "type": "Point",
                    "coordinates": start_coord,
                }
            if "destinationGeoPoint" not in doc:
                update_fields["destinationGeoPoint"] = {
                    "type": "Point",
                    "coordinates": end_coord,
                }

            if update_fields:
                collection.update_one({"_id": doc["_id"]}, {"$set": update_fields})
                updated_count += 1
        except (KeyError, IndexError, json.JSONDecodeError) as e:
            print(f"Error updating document {doc.get('_id', '?')}: {e}")

    print(f"Updated {updated_count} documents in {collection.name}")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        collection_name = sys.argv[1]
        if collection_name == "trips":
            collection = trips_collection
        elif collection_name == "historical_trips":
            collection = historical_trips_collection
        elif collection_name == "uploaded_trips":
            collection = uploaded_trips_collection
        else:
            print("Invalid collection name")
            sys.exit(1)
        update_geo_points(collection)
    else:
        print("No collection name provided")
