from pymongo import MongoClient
import json
import os
import sys
import logging  # Import logging

# Logging Configuration
logging.basicConfig(level=logging.INFO,  # Set default level to INFO
                    format='%(asctime)s - %(levelname)s - %(name)s - %(message)s')
logger = logging.getLogger(__name__)

# Database setup (ensure these match your settings)
MONGO_URI = os.environ.get("MONGO_URI")
DB_NAME = "every_street"

client = MongoClient(MONGO_URI)
db = client[DB_NAME]
trips_collection = db["trips"]
historical_trips_collection = db["historical_trips"]
uploaded_trips_collection = db["uploaded_trips"]


def update_geo_points(collection):
    """
    Updates documents in the given collection to add startGeoPoint and destinationGeoPoint.
    """
    logger.info(
        f"Starting GeoPoint update for collection: {collection.name}")
    updated_count = 0
    try:
        for doc in collection.find(
            {
                "$or": [
                    {"startGeoPoint": {"$exists": False}},
                    {"destinationGeoPoint": {"$exists": False}},
                ]
            }, no_cursor_timeout=True  # Added no_cursor_timeout to prevent cursor timeout for large collections
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
                    collection.update_one({"_id": doc["_id"]}, {
                                          "$set": update_fields})
                    updated_count += 1
                    logger.debug(
                        f"Updated GeoPoints for document _id: {doc.get('_id', '?')}")
            except (KeyError, IndexError) as e:

                logger.warning(
                    f"Skipping document {doc.get('_id', '?')}: GPS data incomplete or missing coordinates - {e}")
            except json.JSONDecodeError as e:  # Catch JSONDecodeError
                # Log JSON decode errors
                logger.error(
                    f"Error processing document {doc.get('_id', '?')}: Invalid JSON in 'gps' field - {e}", exc_info=True)
            except Exception as e:  # Catch any other error during doc processing
                # Log general errors with traceback
                logger.error(
                    f"Error updating document {doc.get('_id', '?')}: {e}", exc_info=True)

    except Exception as e:  # Catch any errors during collection iteration
        # Log collection iteration errors
        logger.error(
            f"Error iterating through collection {collection.name}: {e}", exc_info=True)
    finally:
        # Log completion with update count
        logger.info(
            f"GeoPoint update for collection {collection.name} completed. Updated {updated_count} documents.")


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
