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
        logger.error(f"Failed to initialize MongoDB client: {e}", exc_info=True)
        raise e


# Initialize the client and the database.
mongo_client: AsyncIOMotorClient = get_mongo_client()
db = mongo_client["every_street"]

# Export collections for use elsewhere in your application.
trips_collection = db["trips"]
matched_trips_collection = db["matched_trips"]
historical_trips_collection = db["historical_trips"]
uploaded_trips_collection = db["uploaded_trips"]
places_collection = db["places"]
osm_data_collection = db["osm_data"]
realtime_data_collection = db["realtime_data"]
streets_collection = db["streets"]
coverage_metadata_collection = db["coverage_metadata"]
live_trips_collection = db["live_trips"]
archived_live_trips_collection = db["archived_live_trips"]
task_config_collection = db["task_config"]


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
                logger.error(f"Failed to parse gps for {trip_id}: {e}", exc_info=True)
                return None
        return t
    except Exception as e:
        logger.error(f"Error retrieving trip {trip_id}: {e}", exc_info=True)
        return None
