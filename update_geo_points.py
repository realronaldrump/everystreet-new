import os
import sys
import json
import logging
from pymongo import MongoClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)

MONGO_URI = os.environ.get("MONGO_URI")
DB_NAME = "every_street"
client = MongoClient(MONGO_URI)
db = client[DB_NAME]
trips_collection = db["trips"]
historical_trips_collection = db["historical_trips"]
uploaded_trips_collection = db["uploaded_trips"]


def update_geo_points(collection):
    """
    Update documents in the given collection to add startGeoPoint and destinationGeoPoint.
    """
    logger.info(f"Starting GeoPoint update for collection: {collection.name}")
    updated_count = 0
    try:
        cursor = collection.find(
            {
                "$or": [
                    {"startGeoPoint": {"$exists": False}},
                    {"destinationGeoPoint": {"$exists": False}},
                ]
            },
            no_cursor_timeout=True
        )
        for doc in cursor:
            try:
                gps_data = doc["gps"]
                if isinstance(gps_data, str):
                    gps_data = json.loads(gps_data)
                coords = gps_data.get("coordinates", [])
                if not coords:
                    continue
                start_coord = coords[0]
                end_coord = coords[-1]
                update_fields = {}
                if "startGeoPoint" not in doc:
                    update_fields["startGeoPoint"] = {"type": "Point", "coordinates": start_coord}
                if "destinationGeoPoint" not in doc:
                    update_fields["destinationGeoPoint"] = {"type": "Point", "coordinates": end_coord}
                if update_fields:
                    collection.update_one({"_id": doc["_id"]}, {"$set": update_fields})
                    updated_count += 1
                    logger.debug(f"Updated GeoPoints for document _id: {doc.get('_id', '?')}")
            except (KeyError, IndexError) as e:
                logger.warning(f"Skipping document {doc.get('_id', '?')}: Incomplete GPS data - {e}")
            except json.JSONDecodeError as e:
                logger.error(f"Invalid JSON in 'gps' for document {doc.get('_id', '?')}: {e}", exc_info=True)
            except Exception as e:
                logger.error(f"Error updating document {doc.get('_id', '?')}: {e}", exc_info=True)
    except Exception as e:
        logger.error(f"Error iterating collection {collection.name}: {e}", exc_info=True)
    finally:
        logger.info(f"GeoPoint update for collection {collection.name} completed. Updated {updated_count} documents.")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        collection_name = sys.argv[1]
        if collection_name == "trips":
            coll = trips_collection
        elif collection_name == "historical_trips":
            coll = historical_trips_collection
        elif collection_name == "uploaded_trips":
            coll = uploaded_trips_collection
        else:
            print("Invalid collection name")
            sys.exit(1)
        update_geo_points(coll)
    else:
        print("No collection name provided")