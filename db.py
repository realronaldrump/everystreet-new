import os
import json
import certifi
import logging
import asyncio
import threading
from datetime import timezone
from typing import Optional, Any, Dict, Tuple

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
import pymongo

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


class DatabaseManager:
    """
    Singleton class to manage the MongoDB client and database connection.
    Provides helper methods for checking quota and safely creating indexes.
    """

    _instance: Optional["DatabaseManager"] = None
    _client: Optional[AsyncIOMotorClient] = None
    _db: Optional[AsyncIOMotorDatabase] = None
    _quota_exceeded: bool = False
    _lock = threading.Lock()

    def __new__(cls) -> "DatabaseManager":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self) -> None:
        if self._client is None:
            self._initialize_client()

    def _initialize_client(self) -> None:
        """Initialize the MongoDB client and database connection."""
        try:
            mongo_uri: str = os.getenv("MONGO_URI")
            if not mongo_uri:
                raise ValueError("MONGO_URI environment variable not set")
            self._client = AsyncIOMotorClient(
                mongo_uri,
                tls=True,
                tlsAllowInvalidCertificates=True,
                tlsCAFile=certifi.where(),
                tz_aware=True,
                tzinfo=timezone.utc,
            )
            self._db = self._client["every_street"]
            logger.info("MongoDB client initialized successfully.")
        except Exception as e:
            logger.error("Failed to initialize MongoDB client: %s", e, exc_info=True)
            raise

    @property
    def db(self) -> AsyncIOMotorDatabase:
        if self._db is None:
            raise RuntimeError("Database not initialized.")
        return self._db

    @property
    def client(self) -> AsyncIOMotorClient:
        if self._client is None:
            raise RuntimeError("Client not initialized.")
        return self._client

    @property
    def quota_exceeded(self) -> bool:
        return self._quota_exceeded

    async def check_quota(self) -> Tuple[Optional[float], Optional[float]]:
        """
        Check if the database quota is exceeded.
        Returns:
            Tuple of (used_mb, limit_mb). Returns (None, None) on error.
        """
        try:
            stats = await self.db.command("dbStats")
            data_size = stats.get("dataSize")
            if data_size is None:
                logger.error("dbStats did not return 'dataSize'")
                return None, None
            used_mb = data_size / (1024 * 1024)
            limit_mb = 512  # Free-tier limit
            self._quota_exceeded = used_mb > limit_mb
            if self._quota_exceeded:
                logger.warning(
                    "MongoDB quota exceeded: using %.2f MB of %d MB", used_mb, limit_mb
                )
            return used_mb, limit_mb
        except Exception as e:
            if "you are over your space quota" in str(e).lower():
                self._quota_exceeded = True
                logger.error("MongoDB quota exceeded: %s", e)
            else:
                logger.error("Error checking database quota: %s", e)
            return None, None

    async def safe_create_index(
        self, collection_name: str, keys, **kwargs: Any
    ) -> None:
        """
        Create an index on a given collection if the quota is not exceeded.
        """
        if self._quota_exceeded:
            logger.warning(
                "Skipping index creation for %s due to quota exceeded", collection_name
            )
            return
        try:
            await self.db[collection_name].create_index(keys, **kwargs)
            logger.info("Index created on %s with keys %s", collection_name, keys)
        except Exception as e:
            if "you are over your space quota" in str(e).lower():
                self._quota_exceeded = True
                logger.warning(
                    "Cannot create index on %s due to quota exceeded", collection_name
                )
            else:
                logger.error(
                    "Error creating index on %s: %s", collection_name, e, exc_info=True
                )


db_manager = DatabaseManager()
db: AsyncIOMotorDatabase = db_manager.db

# Define collections
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
task_history_collection = db["task_history"]
progress_collection = db["progress_status"]


async def init_task_history_collection() -> None:
    """
    Initialize indexes for the task history collection concurrently.
    """
    try:
        tasks = [
            task_history_collection.create_index([("task_id", pymongo.ASCENDING)]),
            task_history_collection.create_index([("timestamp", -1)]),
            task_history_collection.create_index(
                [("task_id", pymongo.ASCENDING), ("timestamp", -1)]
            ),
        ]
        await asyncio.gather(*tasks)
        logger.info("Task history collection indexes created successfully")
    except Exception as e:
        logger.error("Error creating task history indexes: %s", e, exc_info=True)
        raise


async def ensure_street_coverage_indexes() -> None:
    """
    Create indexes for collections used in street coverage concurrently.
    """
    try:
        tasks = [
            coverage_metadata_collection.create_index(
                [
                    ("location.display_name", pymongo.ASCENDING),
                    ("status", pymongo.ASCENDING),
                ],
                unique=True,
            ),
            streets_collection.create_index(
                [("properties.location", pymongo.ASCENDING)]
            ),
            streets_collection.create_index(
                [("properties.segment_id", pymongo.ASCENDING)]
            ),
            trips_collection.create_index([("gps", pymongo.ASCENDING)]),
            trips_collection.create_index([("startTime", pymongo.ASCENDING)]),
            trips_collection.create_index([("endTime", pymongo.ASCENDING)]),
        ]
        await asyncio.gather(*tasks)
        logger.info("Street coverage indexes created successfully")
    except Exception as e:
        logger.error("Error creating street coverage indexes: %s", e, exc_info=True)
        raise
