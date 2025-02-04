import os
import certifi
import logging
from pymongo import MongoClient
from datetime import timezone
import json

# Configure logging for this module.
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)
logger = logging.getLogger(__name__)


def get_mongo_client():
    """
    Creates and returns a MongoClient using TLS and CA checks.
    The MONGO_URI environment variable must be set.
    """
    try:
        client = MongoClient(
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
        raise


# Initialize the client and the database.
mongo_client = get_mongo_client()
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

def get_trip_from_db(trip_id):
    try:
        t = trips_collection.find_one({"transactionId": trip_id})
        if not t:
            logger.warning(f"Trip {trip_id} not found in DB")
            return None
        if "gps" not in t:
            logger.error(f"Trip {trip_id} missing GPS")
            return None
        if isinstance(t["gps"], str):
            try:
                t["gps"] = json.loads(t["gps"])
            except:
                logger.error(f"Failed to parse gps for {trip_id}")
                return None
        return t
    except Exception as e:
        logger.error(f"Error retrieving trip {trip_id}: {e}", exc_info=True)
        return None
