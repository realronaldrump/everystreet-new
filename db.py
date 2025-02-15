import os
import json
import certifi
import logging
from datetime import timezone
from typing import Optional, Any, Dict

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
import pymongo

# Configure logging for this module.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


class DatabaseManager:
    _instance = None
    _client = None
    _db = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(DatabaseManager, cls).__new__(cls)
        return cls._instance

    def __init__(self):
        if self._client is None:
            self._initialize_client()

    def _initialize_client(self):
        """Initialize the MongoDB client and database connection."""
        try:
            self._client = AsyncIOMotorClient(
                os.getenv("MONGO_URI"),
                tls=True,
                tlsAllowInvalidCertificates=True,
                tlsCAFile=certifi.where(),
                tz_aware=True,
                tzinfo=timezone.utc,
            )
            self._db = self._client["every_street"]
            logger.info("MongoDB client initialized successfully.")
        except Exception as e:
            logger.error(
                "Failed to initialize MongoDB client: %s", e, exc_info=True
            )
            raise e

    @property
    def db(self) -> AsyncIOMotorDatabase:
        """Get the database instance."""
        return self._db

    @property
    def client(self) -> AsyncIOMotorClient:
        """Get the client instance."""
        return self._client


# Create a single instance of the database manager
db_manager = DatabaseManager()

# Export collections using the singleton database manager
trips_collection = db_manager.db["trips"]
matched_trips_collection = db_manager.db["matched_trips"]
historical_trips_collection = db_manager.db["historical_trips"]
uploaded_trips_collection = db_manager.db["uploaded_trips"]
places_collection = db_manager.db["places"]
osm_data_collection = db_manager.db["osm_data"]
realtime_data_collection = db_manager.db["realtime_data"]
streets_collection = db_manager.db["streets"]
coverage_metadata_collection = db_manager.db["coverage_metadata"]
live_trips_collection = db_manager.db["live_trips"]
archived_live_trips_collection = db_manager.db["archived_live_trips"]
task_config_collection = db_manager.db["task_config"]
task_history_collection = db_manager.db["task_history"]
progress_collection = db_manager.db["progress_status"]


async def init_task_history_collection():
    """Initialize indexes for task history collection."""
    try:
        await task_history_collection.create_index([("task_id", 1)])
        await task_history_collection.create_index([("timestamp", -1)])
        await task_history_collection.create_index(
            [("task_id", 1), ("timestamp", -1)]
        )
        logger.info("Task history collection indexes created successfully")
    except Exception as e:
        logger.error(
            "Error creating task history indexes: %s", e, exc_info=True
        )
        raise e


async def get_trip_from_db(trip_id: str) -> Optional[Dict[str, Any]]:
    """
    Asynchronously retrieves a trip document by its transactionId from the
    trips_collection.

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
            logger.warning("Trip %s not found in DB", trip_id)
            return None
        if "gps" not in t:
            logger.error("Trip %s missing GPS", trip_id)
            return None
        if isinstance(t["gps"], str):
            try:
                t["gps"] = json.loads(t["gps"])
            except Exception as e:
                logger.error(
                    "Failed to parse gps for %s: %s",
                    trip_id,
                    e,
                    exc_info=True,
                )
                return None
        return t
    except Exception as e:
        logger.error(
            "Error retrieving trip %s: %s", trip_id, e, exc_info=True
        )
        return None


async def ensure_street_coverage_indexes():
    """Create indexes for street coverage collections."""
    try:
        # Create compound index for location and status
        await coverage_metadata_collection.create_index(
            [
                ("location.display_name", pymongo.ASCENDING),
                ("status", pymongo.ASCENDING)
            ],
            unique=True
        )

        await streets_collection.create_index(
            [("properties.location", pymongo.ASCENDING)]
        )
        await streets_collection.create_index(
            [("properties.segment_id", pymongo.ASCENDING)]
        )
        await trips_collection.create_index([("gps", pymongo.ASCENDING)])
        await trips_collection.create_index(
            [("startTime", pymongo.ASCENDING)]
        )
        await trips_collection.create_index([("endTime", pymongo.ASCENDING)])
        logger.info("Street coverage indexes created successfully")
    except Exception as e:
        logger.error(
            "Error creating street coverage indexes: %s", e, exc_info=True
        )
        raise e
