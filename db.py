import os
import json
import certifi
import logging
from datetime import timezone
from typing import Optional, Any, Dict

from motor.motor_asyncio import AsyncIOMotorClient

# Configure logging for this module.
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)


def get_mongo_client() -> AsyncIOMotorClient:
    """
    Creates and returns an asynchronous MongoDB client using TLS and CA checks.
    The MONGO_URI environment variable must be set.
    """
    try:
        client = AsyncIOMotorClient(
            os.getenv("MONGO_URI"),
            tls=True,
            tlsAllowInvalidCertificates=True,
            tlsCAFile=certifi.where(),
            tz_aware=True,
            tzinfo=timezone.utc,
        )
        logger.info("MongoDB client initialized successfully.")
        return client
    except Exception as e:
        logger.error(
            f"Failed to initialize MongoDB client: {e}", exc_info=True)
        raise e


# Export collections for use elsewhere in your application.  STILL NEEDED
# BUT, access them through task_manager.db in tasks.py
trips_collection = get_mongo_client()["every_street"]["trips"]
matched_trips_collection = get_mongo_client()["every_street"]["matched_trips"]
historical_trips_collection = get_mongo_client(
)["every_street"]["historical_trips"]
uploaded_trips_collection = get_mongo_client(
)["every_street"]["uploaded_trips"]
places_collection = get_mongo_client()["every_street"]["places"]
osm_data_collection = get_mongo_client()["every_street"]["osm_data"]
realtime_data_collection = get_mongo_client()["every_street"]["realtime_data"]
streets_collection = get_mongo_client()["every_street"]["streets"]
coverage_metadata_collection = get_mongo_client(
)["every_street"]["coverage_metadata"]
live_trips_collection = get_mongo_client()["every_street"]["live_trips"]
archived_live_trips_collection = get_mongo_client()["every_street"][
    "archived_live_trips"
]
task_config_collection = get_mongo_client()["every_street"]["task_config"]
task_history_collection = get_mongo_client()["every_street"]["task_history"]


# Create indexes for task history collection
async def init_task_history_collection():
    """Initialize indexes for task history collection."""
    try:
        await task_history_collection.create_index([("task_id", 1)])
        await task_history_collection.create_index([("timestamp", -1)])
        await task_history_collection.create_index([("task_id", 1), ("timestamp", -1)])
        logger.info("Task history collection indexes created successfully")
    except Exception as e:
        logger.error(
            f"Error creating task history indexes: {e}", exc_info=True)
        raise e


async def get_trip_from_db(trip_id: str) -> Optional[Dict[str, Any]]:
    """
    Asynchronously retrieves a trip document by its transactionId from the trips_collection.

    Ensures that the trip contains a 'gps' field and, if stored as a JSON string,
    converts it to a dictionary.

    Parameters:
        trip_id (str): The transaction ID of the trip.

    Returns:
        dict or None: The trip document if found and valid; otherwise, None.
    """
    try:
        t = await trips_collection.find_one({"transactionId": trip_id})
        if not t:
            logger.warning(f"Trip {trip_id} not found in DB")
            return None
        if "gps" not in t:
            logger.error(f"Trip {trip_id} missing GPS")
            return None
        if isinstance(t["gps"], str):
            try:
                t["gps"] = json.loads(t["gps"])
            except Exception as e:
                logger.error(
                    f"Failed to parse gps for {trip_id}: {e}", exc_info=True)
                return None
        return t
    except Exception as e:
        logger.error(f"Error retrieving trip {trip_id}: {e}", exc_info=True)
        return None
