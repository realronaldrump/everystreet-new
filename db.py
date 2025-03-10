# db.py

from __future__ import annotations

import os
import certifi
import logging
import asyncio
import threading
from datetime import datetime, timezone, timedelta
from typing import Optional, Any, Dict, Tuple, Callable, TypeVar, Awaitable, List, Union

from motor.motor_asyncio import (
    AsyncIOMotorClient,
    AsyncIOMotorDatabase,
    AsyncIOMotorCollection,
)
import pymongo
from bson import ObjectId
from pymongo.errors import (
    ConnectionFailure,
    ServerSelectionTimeoutError,
    OperationFailure,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Return type for the execute_with_retry function
T = TypeVar("T")


class DatabaseManager:
    """Singleton class to manage the MongoDB client and database connection."""

    _instance = None
    _lock = threading.Lock()

    def __new__(cls) -> DatabaseManager:
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialized = False
        return cls._instance

    def __init__(self) -> None:
        if not getattr(self, "_initialized", False):
            self._client = None
            self._db = None
            self._quota_exceeded = False
            self._connection_healthy = True
            self._db_semaphore = asyncio.Semaphore(10)
            self._initialized = True

    def _initialize_client(self) -> None:
        """Initialize the MongoDB client with proper connection settings."""
        try:
            mongo_uri = os.getenv("MONGO_URI")
            if not mongo_uri:
                raise ValueError("MONGO_URI environment variable not set")

            self._client = AsyncIOMotorClient(
                mongo_uri,
                tls=True,
                tlsAllowInvalidCertificates=True,
                tlsCAFile=certifi.where(),
                tz_aware=True,
                tzinfo=timezone.utc,
                maxPoolSize=5,
                minPoolSize=0,
                maxIdleTimeMS=5000,
                connectTimeoutMS=5000,
                serverSelectionTimeoutMS=10000,
                socketTimeoutMS=30000,
                retryWrites=True,
                retryReads=True,
                waitQueueTimeoutMS=10000,
                appname="EveryStreet",
            )
            self._db = self._client["every_street"]
            logger.info("MongoDB client initialized successfully")
        except Exception as e:
            logger.error("Failed to initialize MongoDB client: %s", e)
            raise

    @property
    def db(self) -> AsyncIOMotorDatabase:
        """Get the database instance, initializing the client if needed."""
        if self._db is None:
            self._initialize_client()
        return self._db

    @property
    def client(self) -> AsyncIOMotorClient:
        """Get the client instance, initializing if needed."""
        if self._client is None:
            self._initialize_client()
        return self._client

    @property
    def quota_exceeded(self) -> bool:
        """Check if the database quota is exceeded."""
        return self._quota_exceeded

    async def execute_with_retry(
        self,
        operation: Callable[[], Awaitable[T]],
        max_attempts: int = 3,
        operation_name: str = "database operation",
    ) -> T:
        """Execute a database operation with retry logic."""
        attempts = 0
        retry_delay = 0.5

        while attempts < max_attempts:
            attempts += 1
            try:
                async with self._db_semaphore:
                    if not self._client:
                        self._initialize_client()
                    return await operation()
            except (ConnectionFailure, ServerSelectionTimeoutError) as e:
                logger.warning(
                    "Attempt %d/%d for %s failed: %s",
                    attempts,
                    max_attempts,
                    operation_name,
                    str(e),
                )
                if attempts >= max_attempts:
                    raise
                await asyncio.sleep(retry_delay)
                retry_delay *= 2
            except Exception as e:
                # For other exceptions, only retry server errors (5xx)
                if (
                    hasattr(e, "code")
                    and 500 <= e.code < 600
                    and attempts < max_attempts
                ):
                    logger.warning(
                        "Server error in %s: %s. Retrying...", operation_name, str(e)
                    )
                    await asyncio.sleep(retry_delay)
                    retry_delay *= 2
                else:
                    raise

        raise RuntimeError(f"All retry attempts failed for {operation_name}")

    async def check_quota(self) -> Tuple[Optional[float], Optional[float]]:
        """Check if the database quota is exceeded."""
        try:

            async def _check_quota():
                stats = await self.db.command("dbStats")
                data_size = stats.get("dataSize", 0)
                used_mb = data_size / (1024 * 1024)
                limit_mb = 512  # Free-tier limit
                self._quota_exceeded = used_mb > limit_mb
                return used_mb, limit_mb

            return await self.execute_with_retry(
                _check_quota, operation_name="quota check"
            )
        except Exception as e:
            if "over your space quota" in str(e).lower():
                self._quota_exceeded = True
            logger.error("Error checking database quota: %s", e)
            return None, None

    async def safe_create_index(
        self, collection_name: str, keys, **kwargs: Any
    ) -> None:
        """Create an index on a collection if quota is not exceeded."""
        if self._quota_exceeded:
            logger.warning(
                "Skipping index creation for %s due to quota exceeded",
                collection_name,
            )
            return

        try:
            # Skip if index already exists
            if "name" in kwargs:
                index_name = kwargs["name"]
                existing_indexes = await self.db[collection_name].index_information()
                if index_name in existing_indexes:
                    return

            await self.execute_with_retry(
                lambda: self.db[collection_name].create_index(keys, **kwargs),
                operation_name=f"index creation on {collection_name}",
            )
            logger.info("Index created on %s with keys %s", collection_name, keys)
        except OperationFailure as e:
            if "over your space quota" in str(e).lower():
                self._quota_exceeded = True
                logger.warning("Cannot create index due to quota exceeded")
            elif e.code in (85, 86, 68):  # Index conflicts
                logger.warning("Index conflict: %s", str(e))
            else:
                raise

    async def cleanup_connections(self) -> None:
        """Close database connections. Call during application shutdown."""
        if self._client:
            try:
                logger.info("Closing MongoDB client connections...")
                self._client.close()
                self._client = None
                self._db = None
                logger.info("MongoDB client connections closed")
            except Exception as e:
                logger.error("Error closing MongoDB connections: %s", e)

    async def handle_memory_error(self) -> None:
        """Handle memory-related errors by cleaning up connections."""
        try:
            logger.warning(
                "Handling memory error: Closing and reinitializing connections"
            )
            await self.cleanup_connections()
            # Force garbage collection
            import gc

            gc.collect()
            # Reinitialize after a short delay
            await asyncio.sleep(1)
            self._initialize_client()
        except Exception as e:
            logger.error("Error handling memory error: %s", e)

    def __del__(self) -> None:
        """Ensure connections are closed when the manager is garbage collected."""
        if self._client and asyncio.get_event_loop().is_running():
            try:
                asyncio.create_task(self.cleanup_connections())
            except Exception:
                pass


# Create singleton instance
db_manager = DatabaseManager()
db = db_manager.db

# Define collections
trips_collection = db["trips"]
matched_trips_collection = db["matched_trips"]
uploaded_trips_collection = db["uploaded_trips"]
places_collection = db["places"]
osm_data_collection = db["osm_data"]
streets_collection = db["streets"]
coverage_metadata_collection = db["coverage_metadata"]
live_trips_collection = db["live_trips"]
archived_live_trips_collection = db["archived_live_trips"]
task_config_collection = db["task_config"]
task_history_collection = db["task_history"]
progress_collection = db["progress_status"]


# ------------------------------------------------------------------------------
# Serialization Functions
# ------------------------------------------------------------------------------


def serialize_datetime(dt: Optional[datetime]) -> Optional[str]:
    """Return ISO formatted datetime string if dt is not None."""
    return dt.isoformat() if dt else None


def serialize_object_id(obj_id: Optional[ObjectId]) -> Optional[str]:
    """Convert ObjectId to string if not None."""
    return str(obj_id) if obj_id else None


def serialize_trip(trip: dict) -> dict:
    """Convert ObjectId and datetime fields in a trip dict to serializable types."""
    if not trip:
        return {}

    result = dict(trip)

    # Handle _id
    if "_id" in result:
        result["_id"] = serialize_object_id(result["_id"])

    # Handle common datetime fields
    for key in (
        "startTime",
        "endTime",
        "lastUpdate",
        "created_at",
        "updated_at",
        "timestamp",
    ):
        if key in result and isinstance(result[key], datetime):
            result[key] = serialize_datetime(result[key])

    # Return the serialized trip
    return result


# ------------------------------------------------------------------------------
# Database Operation Functions with Retry
# ------------------------------------------------------------------------------


async def find_one_with_retry(collection, query, projection=None, sort=None):
    """Execute find_one with retry logic."""

    async def _operation():
        if sort:
            return await collection.find_one(query, projection, sort=sort)
        return await collection.find_one(query, projection)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"find_one on {collection.name}"
    )


async def find_with_retry(
    collection, query, projection=None, sort=None, limit=None, skip=None
):
    """Execute find with retry logic and return a list."""

    async def _operation():
        cursor = collection.find(query, projection)
        if sort:
            cursor = cursor.sort(sort)
        if skip:
            cursor = cursor.skip(skip)
        if limit:
            cursor = cursor.limit(limit)
        return await cursor.to_list(length=None)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"find on {collection.name}"
    )


async def update_one_with_retry(collection, filter_query, update, upsert=False):
    """Execute update_one with retry logic."""

    async def _operation():
        return await collection.update_one(filter_query, update, upsert=upsert)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"update_one on {collection.name}"
    )


async def update_many_with_retry(collection, filter_query, update, upsert=False):
    """Execute update_many with retry logic."""

    async def _operation():
        return await collection.update_many(filter_query, update, upsert=upsert)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"update_many on {collection.name}"
    )


async def insert_one_with_retry(collection, document):
    """Execute insert_one with retry logic."""

    async def _operation():
        return await collection.insert_one(document)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"insert_one on {collection.name}"
    )


async def insert_many_with_retry(collection, documents):
    """Execute insert_many with retry logic."""

    async def _operation():
        return await collection.insert_many(documents)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"insert_many on {collection.name}"
    )


async def delete_one_with_retry(collection, filter_query):
    """Execute delete_one with retry logic."""

    async def _operation():
        return await collection.delete_one(filter_query)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"delete_one on {collection.name}"
    )


async def delete_many_with_retry(collection, filter_query):
    """Execute delete_many with retry logic."""

    async def _operation():
        return await collection.delete_many(filter_query)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"delete_many on {collection.name}"
    )


async def aggregate_with_retry(collection, pipeline):
    """Execute aggregate with retry logic."""

    async def _operation():
        return await collection.aggregate(pipeline).to_list(None)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"aggregate on {collection.name}"
    )


async def replace_one_with_retry(collection, filter_query, replacement, upsert=False):
    """Execute replace_one with retry logic."""

    async def _operation():
        return await collection.replace_one(filter_query, replacement, upsert=upsert)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"replace_one on {collection.name}"
    )


async def count_documents_with_retry(collection, filter_query):
    """Execute count_documents with retry logic."""

    async def _operation():
        return await collection.count_documents(filter_query)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"count_documents on {collection.name}"
    )


# ------------------------------------------------------------------------------
# Common Query Pattern Helper Functions
# ------------------------------------------------------------------------------


def parse_query_date(
    date_str: Optional[str], end_of_day: bool = False
) -> Optional[datetime]:
    """
    Parse a date string into a datetime object.
    Replaces trailing "Z" with "+00:00" for ISO8601 compatibility.
    """
    if not date_str:
        return None
    date_str = date_str.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(date_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if end_of_day:
            dt = dt.replace(hour=23, minute=59, second=59, microsecond=999999)
        return dt
    except ValueError:
        try:
            dt2 = datetime.strptime(date_str, "%Y-%m-%d")
            dt2 = dt2.replace(tzinfo=timezone.utc)
            if end_of_day:
                dt2 = dt2.replace(hour=23, minute=59, second=59, microsecond=999999)
            return dt2
        except ValueError:
            logger.warning(
                "Unable to parse date string '%s'; returning None.", date_str
            )
            return None


async def get_trips_in_date_range(
    start_date: datetime,
    end_date: datetime,
    imei: Optional[str] = None,
    collection: Optional[AsyncIOMotorCollection] = None,
) -> List[Dict[str, Any]]:
    """Get trips within a date range with optional IMEI filter."""
    if collection is None:
        collection = trips_collection

    query = {"startTime": {"$gte": start_date, "$lte": end_date}}
    if imei:
        query["imei"] = imei

    return await find_with_retry(collection, query)


async def get_trip_by_id(
    trip_id: str,
    collection: Optional[AsyncIOMotorCollection] = None,
    check_both_id_types: bool = True,
) -> Optional[Dict[str, Any]]:
    """Get a trip by transaction ID or ObjectId."""
    if collection is None:
        collection = trips_collection

    # First try as transaction ID
    trip = await find_one_with_retry(collection, {"transactionId": trip_id})

    # If not found and check_both_id_types is True, try as ObjectId
    if not trip and check_both_id_types:
        try:
            object_id = ObjectId(trip_id)
            trip = await find_one_with_retry(collection, {"_id": object_id})
        except Exception:
            pass

    return trip


async def get_trip_from_all_collections(
    trip_id: str,
) -> Tuple[Optional[Dict[str, Any]], Optional[AsyncIOMotorCollection]]:
    """Find a trip in any of the trip collections."""
    collections = [
        trips_collection,
        matched_trips_collection,
        uploaded_trips_collection,
    ]

    for collection in collections:
        trip = await get_trip_by_id(trip_id, collection, check_both_id_types=True)
        if trip:
            return trip, collection

    return None, None


async def get_latest_trips(
    limit: int = 10, collection: Optional[AsyncIOMotorCollection] = None
) -> List[Dict[str, Any]]:
    """Get the most recent trips."""
    if collection is None:
        collection = trips_collection

    return await find_with_retry(collection, {}, sort=[("startTime", -1)], limit=limit)


async def init_task_history_collection() -> None:
    """Initialize indexes for the task history collection."""
    try:
        await db_manager.safe_create_index(
            "task_history", [("task_id", pymongo.ASCENDING)]
        )
        await db_manager.safe_create_index("task_history", [("timestamp", -1)])
        await db_manager.safe_create_index(
            "task_history",
            [("task_id", pymongo.ASCENDING), ("timestamp", -1)],
        )
        logger.info("Task history collection indexes created successfully")
    except Exception as e:
        logger.error("Error creating task history indexes: %s", e)
        raise


async def ensure_street_coverage_indexes() -> None:
    """Create indexes for street coverage collections."""
    logger = logging.getLogger(__name__)

    try:
        # Core indexes for coverage functionality
        await db_manager.safe_create_index(
            "coverage_metadata",
            [("location.display_name", pymongo.ASCENDING)],
            name="coverage_metadata_display_name_idx",
            background=True,
        )

        await db_manager.safe_create_index(
            "streets",
            [("properties.location", pymongo.ASCENDING)],
            name="streets_properties_location_idx",
            background=True,
        )

        await db_manager.safe_create_index(
            "streets",
            [("properties.segment_id", pymongo.ASCENDING)],
            name="streets_properties_segment_id_idx",
            background=True,
        )

        # Trip indexes for coverage calculation
        await db_manager.safe_create_index(
            "trips",
            [("startTime", pymongo.ASCENDING)],
            name="trips_start_time_idx",
            background=True,
        )

        logger.info("Street coverage indexes created successfully")
    except Exception as e:
        logger.error("Error creating street coverage indexes: %s", e)
        raise
