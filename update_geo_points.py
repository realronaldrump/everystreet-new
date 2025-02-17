import os
import sys
import json
import asyncio
import logging
from motor.motor_asyncio import AsyncIOMotorClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

MONGO_URI = os.environ.get("MONGO_URI")
DB_NAME = "every_street"

client = AsyncIOMotorClient(MONGO_URI, tz_aware=True)
db = client[DB_NAME]
trips_collection = db["trips"]
historical_trips_collection = db["historical_trips"]
uploaded_trips_collection = db["uploaded_trips"]


async def update_geo_points(collection):
    """
    Asynchronously update documents in the given collection to add startGeoPoint and
    destinationGeoPoint.
    """
    logger.info("Starting GeoPoint update for collection: %s", collection.name)
    updated_count = 0
    try:
        cursor = collection.find(
            {
                "$or": [
                    {"startGeoPoint": {"$exists": False}},
                    {"destinationGeoPoint": {"$exists": False}},
                ]
            },
            no_cursor_timeout=True,
        )
        async for doc in cursor:
            try:
                gps_data = doc.get("gps")
                if isinstance(gps_data, str):
                    gps_data = json.loads(gps_data)
                coords = gps_data.get("coordinates", [])
                if not coords:
                    continue
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
                    await collection.update_one(
                        {"_id": doc["_id"]}, {"$set": update_fields}
                    )
                    updated_count += 1
                    logger.debug(
                        "Updated GeoPoints for document _id: %s",
                        doc.get("_id", "?"),
                    )
            except (KeyError, IndexError) as e:
                logger.warning(
                    "Skipping document %s: Incomplete GPS data - %s",
                    doc.get("_id", "?"),
                    e,
                )
            except json.JSONDecodeError as e:
                logger.error(
                    "Invalid JSON in 'gps' for document %s: %s",
                    doc.get("_id", "?"),
                    e,
                    exc_info=True,
                )
            except Exception as e:
                logger.error(
                    "Error updating document %s: %s",
                    doc.get("_id", "?"),
                    e,
                    exc_info=True,
                )
    except Exception as e:
        logger.error(
            "Error iterating collection %s: %s",
            collection.name,
            e,
            exc_info=True,
        )
    finally:
        logger.info(
            "GeoPoint update for collection %s completed. Updated %d documents.",
            collection.name,
            updated_count,
        )


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
        # Run the async update_geo_points function using asyncio.run.
        asyncio.run(update_geo_points(coll))
    else:
        print("No collection name provided")
