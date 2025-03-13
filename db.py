"""
Database management module.

Provides a singleton DatabaseManager class for MongoDB connections and operations,
with robust retry logic, connection pooling, and serialization helpers.
"""

from __future__ import annotations

import os
import certifi
import logging
import asyncio
import threading
import json
from datetime import datetime, timezone
from typing import (
    Optional,
    Any,
    Dict,
    Tuple,
    Callable,
    TypeVar,
    Awaitable,
    List,
    Union,
    cast,
    Iterator,
    Iterable,
)

from fastapi import Request
from motor.motor_asyncio import (
    AsyncIOMotorClient,
    AsyncIOMotorDatabase,
    AsyncIOMotorCollection,
    AsyncIOMotorCursor,
)
import pymongo
from bson import ObjectId, json_util
from pymongo.errors import (
    ConnectionFailure,
    ServerSelectionTimeoutError,
    OperationFailure,
    DuplicateKeyError,
)

# Set up logging
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
            self._collections: Dict[str, AsyncIOMotorCollection] = {}
            self._initialized = True
            self._conn_retry_backoff = [
                1,
                2,
                5,
                10,
                30,
            ]  # Exponential backoff in seconds

            # Configuration - could be moved to env vars
            self._max_pool_size = int(os.getenv("MONGODB_MAX_POOL_SIZE", "10"))
            self._connection_timeout_ms = int(
                os.getenv("MONGODB_CONNECTION_TIMEOUT_MS", "5000")
            )
            self._server_selection_timeout_ms = int(
                os.getenv("MONGODB_SERVER_SELECTION_TIMEOUT_MS", "10000")
            )
            self._socket_timeout_ms = int(
                os.getenv("MONGODB_SOCKET_TIMEOUT_MS", "30000")
            )
            self._max_retry_attempts = int(os.getenv("MONGODB_MAX_RETRY_ATTEMPTS", "5"))
            self._db_name = os.getenv("MONGODB_DATABASE", "every_street")

    def _initialize_client(self) -> None:
        """Initialize the MongoDB client with proper connection settings."""
        try:
            mongo_uri = os.getenv("MONGO_URI")
            if not mongo_uri:
                raise ValueError("MONGO_URI environment variable not set")

            logger.info("Initializing MongoDB client...")
            self._client = AsyncIOMotorClient(
                mongo_uri,
                tls=True,
                tlsAllowInvalidCertificates=True,
                tlsCAFile=certifi.where(),
                tz_aware=True,
                tzinfo=timezone.utc,
                maxPoolSize=self._max_pool_size,
                minPoolSize=0,
                maxIdleTimeMS=5000,
                connectTimeoutMS=self._connection_timeout_ms,
                serverSelectionTimeoutMS=self._server_selection_timeout_ms,
                socketTimeoutMS=self._socket_timeout_ms,
                retryWrites=True,
                retryReads=True,
                waitQueueTimeoutMS=10000,
                appname="EveryStreet",
            )
            self._db = self._client[self._db_name]
            self._connection_healthy = True
            self._collections = {}  # Reset cached collections
            logger.info("MongoDB client initialized successfully")
        except Exception as e:
            self._connection_healthy = False
            logger.error("Failed to initialize MongoDB client: %s", e)
            raise

    @property
    def db(self) -> AsyncIOMotorDatabase:
        """Get the database instance, initializing the client if needed."""
        if self._db is None or not self._connection_healthy:
            self._initialize_client()
        return self._db

    @property
    def client(self) -> AsyncIOMotorClient:
        """Get the client instance, initializing if needed."""
        if self._client is None or not self._connection_healthy:
            self._initialize_client()
        return self._client

    @property
    def quota_exceeded(self) -> bool:
        """Check if the database quota is exceeded."""
        return self._quota_exceeded

    def get_collection(self, collection_name: str) -> AsyncIOMotorCollection:
        """Get a collection by name, cached for efficiency."""
        if collection_name not in self._collections or not self._connection_healthy:
            self._collections[collection_name] = self.db[collection_name]
        return self._collections[collection_name]

    async def execute_with_retry(
        self,
        operation: Callable[[], Awaitable[T]],
        max_attempts: int = None,
        operation_name: str = "database operation",
    ) -> T:
        """Execute a database operation with retry logic."""
        if max_attempts is None:
            max_attempts = self._max_retry_attempts

        attempts = 0
        last_exception = None

        while attempts < max_attempts:
            attempts += 1
            retry_delay = self._conn_retry_backoff[
                min(attempts - 1, len(self._conn_retry_backoff) - 1)
            ]

            try:
                async with self._db_semaphore:
                    if not self._client or not self._connection_healthy:
                        self._initialize_client()
                    return await operation()
            except (ConnectionFailure, ServerSelectionTimeoutError) as e:
                last_exception = e
                self._connection_healthy = False
                logger.warning(
                    "Attempt %d/%d for %s failed: %s. Retrying in %ds...",
                    attempts,
                    max_attempts,
                    operation_name,
                    str(e),
                    retry_delay,
                )

                if attempts >= max_attempts:
                    logger.error(
                        "All %d connection attempts for %s failed. Last error: %s",
                        max_attempts,
                        operation_name,
                        str(e),
                    )
                    raise

                await asyncio.sleep(retry_delay)
            except Exception as e:
                # For other exceptions, only retry server errors (5xx)
                if (
                    hasattr(e, "code")
                    and 500 <= e.code < 600
                    and attempts < max_attempts
                ):
                    logger.warning(
                        "Server error in %s: %s. Retrying in %ds...",
                        operation_name,
                        str(e),
                        retry_delay,
                    )
                    await asyncio.sleep(retry_delay)
                else:
                    # For all other errors, log and re-raise
                    logger.error(
                        "Error in %s (attempt %d/%d): %s",
                        operation_name,
                        attempts,
                        max_attempts,
                        str(e),
                    )
                    raise

        # This should never be reached as max_attempts failures should raise an exception
        raise RuntimeError(
            f"All {max_attempts} retry attempts failed for {operation_name}"
        )

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
    ) -> Optional[str]:
        """Create an index on a collection if quota is not exceeded."""
        if self._quota_exceeded:
            logger.warning(
                "Skipping index creation for %s due to quota exceeded",
                collection_name,
            )
            return None

        try:
            # Skip if index already exists
            if "name" in kwargs:
                index_name = kwargs["name"]
                existing_indexes = await self.get_collection(
                    collection_name
                ).index_information()
                if index_name in existing_indexes:
                    logger.debug(
                        f"Index {index_name} already exists, skipping creation"
                    )
                    return index_name

            async def _create_index():
                return await self.get_collection(collection_name).create_index(
                    keys, **kwargs
                )

            result = await self.execute_with_retry(
                _create_index,
                operation_name=f"index creation on {collection_name}",
            )
            logger.info("Index created on %s with keys %s", collection_name, keys)
            return result
        except DuplicateKeyError:
            # This can happen with concurrent index creation
            logger.warning(
                f"Index already exists on {collection_name}, ignoring DuplicateKeyError"
            )
            return None
        except OperationFailure as e:
            if "over your space quota" in str(e).lower():
                self._quota_exceeded = True
                logger.warning("Cannot create index due to quota exceeded")
            elif e.code in (85, 86, 68):  # Index conflicts
                logger.warning("Index conflict: %s", str(e))
            else:
                logger.error("Error creating index: %s", str(e))
                raise
            return None

    async def cleanup_connections(self) -> None:
        """Close database connections. Call during application shutdown."""
        if self._client:
            try:
                logger.info("Closing MongoDB client connections...")
                self._client.close()
                self._client = None
                self._db = None
                self._collections = {}
                self._connection_healthy = False
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

            # Reinitialize after a short delay to allow memory to be freed
            await asyncio.sleep(2)

            # Reinitialize with reduced pool size temporarily
            temp_pool_size = self._max_pool_size
            self._max_pool_size = max(2, self._max_pool_size // 2)
            self._initialize_client()

            # Restore original pool size for future connections
            self._max_pool_size = temp_pool_size

            logger.info("Connections reinitialized after memory error")
        except Exception as e:
            logger.error("Error handling memory error: %s", e)

    def __del__(self) -> None:
        """Ensure connections are closed when the manager is garbage collected."""
        # Don't use asyncio here as this might be called during shutdown
        if self._client:
            try:
                self._client.close()
                self._client = None
                self._db = None
                self._collections = {}
            except Exception:
                pass


# Create singleton instance
db_manager = DatabaseManager()

# Define collections with centralized access
trips_collection = db_manager.get_collection("trips")
matched_trips_collection = db_manager.get_collection("matched_trips")
uploaded_trips_collection = db_manager.get_collection("uploaded_trips")
places_collection = db_manager.get_collection("places")
osm_data_collection = db_manager.get_collection("osm_data")
streets_collection = db_manager.get_collection("streets")
coverage_metadata_collection = db_manager.get_collection("coverage_metadata")
live_trips_collection = db_manager.get_collection("live_trips")
archived_live_trips_collection = db_manager.get_collection("archived_live_trips")
task_config_collection = db_manager.get_collection("task_config")
task_history_collection = db_manager.get_collection("task_history")
progress_collection = db_manager.get_collection("progress_status")


# Serialization Functions
class SerializationHelper:
    """Helper class for serializing MongoDB documents to JSON."""

    @staticmethod
    def serialize_datetime(dt: Optional[datetime]) -> Optional[str]:
        """Return ISO formatted datetime string if dt is not None."""
        return dt.isoformat() if dt else None

    @staticmethod
    def serialize_object_id(obj_id: Optional[ObjectId]) -> Optional[str]:
        """Convert ObjectId to string if not None."""
        return str(obj_id) if obj_id else None

    @staticmethod
    def serialize_document(doc: Dict[str, Any]) -> Dict[str, Any]:
        """Convert MongoDB document to a JSON serializable dictionary."""
        if not doc:
            return {}

        result = {}
        for key, value in doc.items():
            if isinstance(value, ObjectId):
                result[key] = SerializationHelper.serialize_object_id(value)
            elif isinstance(value, datetime):
                result[key] = SerializationHelper.serialize_datetime(value)
            elif isinstance(value, dict):
                result[key] = SerializationHelper.serialize_document(value)
            elif isinstance(value, list):
                result[key] = SerializationHelper.serialize_list(value)
            else:
                result[key] = value

        return result

    @staticmethod
    def serialize_list(items: List[Any]) -> List[Any]:
        """Serialize a list of items."""
        return [
            (
                SerializationHelper.serialize_document(item)
                if isinstance(item, dict)
                else (
                    SerializationHelper.serialize_list(item)
                    if isinstance(item, list)
                    else (
                        SerializationHelper.serialize_object_id(item)
                        if isinstance(item, ObjectId)
                        else (
                            SerializationHelper.serialize_datetime(item)
                            if isinstance(item, datetime)
                            else item
                        )
                    )
                )
            )
            for item in items
        ]

    @staticmethod
    def serialize_trip(trip: Dict[str, Any]) -> Dict[str, Any]:
        """
        Convert trip document to JSON serializable dictionary.
        Handles special fields specific to trip documents.
        """
        if not trip:
            return {}

        # Use basic document serialization first
        result = SerializationHelper.serialize_document(trip)

        # Process GPS data if it exists and is a string
        if "gps" in result and isinstance(result["gps"], str):
            try:
                # Check if it's already valid JSON
                json.loads(result["gps"])
            except json.JSONDecodeError:
                # If not, serialize it using BSON utilities
                result["gps"] = json.loads(json_util.dumps(result["gps"]))

        # Ensure matchedGps is also properly serialized
        if "matchedGps" in result and isinstance(result["matchedGps"], str):
            try:
                json.loads(result["matchedGps"])
            except json.JSONDecodeError:
                result["matchedGps"] = json.loads(json_util.dumps(result["matchedGps"]))

        return result


# Helper for iterating through cursors in batches
async def batch_cursor(
    cursor: AsyncIOMotorCursor, batch_size: int = 100
) -> Iterator[List[Dict[str, Any]]]:
    """
    Process an AsyncIOMotorCursor in manageable batches to limit memory usage.

    Args:
        cursor: The MongoDB cursor to iterate through
        batch_size: Number of documents to fetch at once

    Yields:
        Lists of documents, batch_size at a time
    """
    batch = []
    async for document in cursor:
        batch.append(document)
        if len(batch) >= batch_size:
            yield batch
            batch = []

    # Return any remaining documents
    if batch:
        yield batch


# Date parameter parsing utilities
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


class DateFilter:
    """A utility class for date range filtering."""

    def __init__(
        self,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        field_name: str = "startTime",
    ):
        self.start_date = start_date
        self.end_date = end_date
        self.field_name = field_name

    def get_query_dict(self) -> dict:
        """Get a MongoDB query filter for this date range."""
        query = {}
        if self.start_date and self.end_date:
            query[self.field_name] = {"$gte": self.start_date, "$lte": self.end_date}
        elif self.start_date:
            query[self.field_name] = {"$gte": self.start_date}
        elif self.end_date:
            query[self.field_name] = {"$lte": self.end_date}
        return query


async def parse_date_params(
    request: Request,
    start_param: str = "start_date",
    end_param: str = "end_date",
    field_name: str = "startTime",
    end_of_day: bool = True,
) -> DateFilter:
    """
    Parse start and end date parameters from a request.
    Returns a DateFilter object with parsed datetime objects.
    """
    start_date_str = request.query_params.get(start_param)
    end_date_str = request.query_params.get(end_param)

    start_date = parse_query_date(start_date_str)
    end_date = parse_query_date(end_date_str, end_of_day=end_of_day)

    return DateFilter(start_date, end_date, field_name)


async def build_query_from_request(
    request: Request,
    date_field: str = "startTime",
    end_of_day: bool = True,
    include_imei: bool = True,
    additional_filters: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Build a MongoDB query from request parameters.

    Args:
        request: FastAPI request object
        date_field: Field name for date filtering
        end_of_day: Whether to set end date to end of day
        include_imei: Whether to include IMEI filter
        additional_filters: Additional query filters

    Returns:
        MongoDB query filter
    """
    date_filter = await parse_date_params(
        request, field_name=date_field, end_of_day=end_of_day
    )
    query = date_filter.get_query_dict()

    # Add IMEI filter if requested
    if include_imei and request.query_params.get("imei"):
        query["imei"] = request.query_params.get("imei")

    # Add any additional filters
    if additional_filters:
        query.update(additional_filters)

    return query


# Database Operation Functions with Retry - these are convenience wrappers around execute_with_retry
async def find_one_with_retry(
    collection: AsyncIOMotorCollection,
    query: Dict[str, Any],
    projection: Any = None,
    sort: Any = None,
) -> Optional[Dict[str, Any]]:
    """Execute find_one with retry logic."""

    async def _operation():
        if sort:
            return await collection.find_one(query, projection, sort=sort)
        return await collection.find_one(query, projection)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"find_one on {collection.name}"
    )


async def find_with_retry(
    collection: AsyncIOMotorCollection,
    query: Dict[str, Any],
    projection: Any = None,
    sort: Any = None,
    limit: Optional[int] = None,
    skip: Optional[int] = None,
    batch_size: int = 100,
) -> List[Dict[str, Any]]:
    """Execute find with retry logic and return a list."""

    async def _operation():
        cursor = collection.find(query, projection)
        if sort:
            cursor = cursor.sort(sort)
        if skip:
            cursor = cursor.skip(skip)
        if limit:
            cursor = cursor.limit(limit)

        # For smaller result sets, just use to_list
        if limit and limit <= batch_size:
            return await cursor.to_list(length=limit)

        # For larger result sets, batch the results to control memory usage
        results = []
        async for batch in batch_cursor(cursor, batch_size):
            results.extend(batch)
            if limit and len(results) >= limit:
                return results[:limit]
        return results

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"find on {collection.name}"
    )


async def update_one_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: Dict[str, Any],
    update: Dict[str, Any],
    upsert: bool = False,
) -> pymongo.results.UpdateResult:
    """Execute update_one with retry logic."""

    async def _operation():
        return await collection.update_one(filter_query, update, upsert=upsert)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"update_one on {collection.name}"
    )


async def update_many_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: Dict[str, Any],
    update: Dict[str, Any],
    upsert: bool = False,
) -> pymongo.results.UpdateResult:
    """Execute update_many with retry logic."""

    async def _operation():
        return await collection.update_many(filter_query, update, upsert=upsert)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"update_many on {collection.name}"
    )


async def insert_one_with_retry(
    collection: AsyncIOMotorCollection, document: Dict[str, Any]
) -> pymongo.results.InsertOneResult:
    """Execute insert_one with retry logic."""

    async def _operation():
        return await collection.insert_one(document)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"insert_one on {collection.name}"
    )


async def insert_many_with_retry(
    collection: AsyncIOMotorCollection, documents: List[Dict[str, Any]]
) -> pymongo.results.InsertManyResult:
    """Execute insert_many with retry logic."""

    async def _operation():
        return await collection.insert_many(documents)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"insert_many on {collection.name}"
    )


async def delete_one_with_retry(
    collection: AsyncIOMotorCollection, filter_query: Dict[str, Any]
) -> pymongo.results.DeleteResult:
    """Execute delete_one with retry logic."""

    async def _operation():
        return await collection.delete_one(filter_query)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"delete_one on {collection.name}"
    )


async def delete_many_with_retry(
    collection: AsyncIOMotorCollection, filter_query: Dict[str, Any]
) -> pymongo.results.DeleteResult:
    """Execute delete_many with retry logic."""

    async def _operation():
        return await collection.delete_many(filter_query)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"delete_many on {collection.name}"
    )


async def aggregate_with_retry(
    collection: AsyncIOMotorCollection,
    pipeline: List[Dict[str, Any]],
    batch_size: int = 100,
) -> List[Dict[str, Any]]:
    """Execute aggregate with retry logic."""

    async def _operation():
        result = []
        cursor = collection.aggregate(pipeline)
        async for batch in batch_cursor(cursor, batch_size):
            result.extend(batch)
        return result

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"aggregate on {collection.name}"
    )


async def replace_one_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: Dict[str, Any],
    replacement: Dict[str, Any],
    upsert: bool = False,
) -> pymongo.results.UpdateResult:
    """Execute replace_one with retry logic."""

    async def _operation():
        return await collection.replace_one(filter_query, replacement, upsert=upsert)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"replace_one on {collection.name}"
    )


async def count_documents_with_retry(
    collection: AsyncIOMotorCollection, filter_query: Dict[str, Any]
) -> int:
    """Execute count_documents with retry logic."""

    async def _operation():
        return await collection.count_documents(filter_query)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"count_documents on {collection.name}"
    )


# Common Query Pattern Helper Functions
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

    # Try to find in each collection with proper retries
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
    logger.info("Ensuring street coverage indexes exist...")

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

        await db_manager.safe_create_index(
            "streets",
            [("geometry", "2dsphere")],
            name="streets_geometry_idx",
            background=True,
        )

        # Trip indexes for coverage calculation
        await db_manager.safe_create_index(
            "trips",
            [("startTime", pymongo.ASCENDING)],
            name="trips_start_time_idx",
            background=True,
        )

        await db_manager.safe_create_index(
            "trips",
            [("startGeoPoint", "2dsphere")],
            name="trips_start_geo_idx",
            background=True,
        )

        await db_manager.safe_create_index(
            "trips",
            [("destinationGeoPoint", "2dsphere")],
            name="trips_destination_geo_idx",
            background=True,
        )

        logger.info("Street coverage indexes created successfully")
    except Exception as e:
        logger.error("Error creating street coverage indexes: %s", e)
        raise


async def ensure_location_indexes():
    """
    Ensure indexes exist for the new location structure.
    This includes indexes on address components and coordinates.
    """
    try:
        collections = ["trips", "matched_trips", "uploaded_trips"]

        for collection_name in collections:
            # Index on city for city-level analytics
            await db_manager.safe_create_index(
                collection_name,
                [("startLocation.address_components.city", 1)],
                name=f"{collection_name}_start_city_idx",
                background=True,
            )

            await db_manager.safe_create_index(
                collection_name,
                [("destination.address_components.city", 1)],
                name=f"{collection_name}_dest_city_idx",
                background=True,
            )

            # Index on state for regional analytics
            await db_manager.safe_create_index(
                collection_name,
                [("startLocation.address_components.state", 1)],
                name=f"{collection_name}_start_state_idx",
                background=True,
            )

            await db_manager.safe_create_index(
                collection_name,
                [("destination.address_components.state", 1)],
                name=f"{collection_name}_dest_state_idx",
                background=True,
            )

            # Use existing GeoJSON fields for geospatial queries instead of the coordinates in the structured location
            # This avoids issues with the format of the coordinates field
            logger.info("Using existing GeoJSON fields for geospatial indexes")

        logger.info("Location structure indexes created successfully")
    except Exception as e:
        logger.error("Error creating location structure indexes: %s", e)
        raise


# Transaction handling
async def run_transaction(operations: List[Callable[[], Awaitable[Any]]]) -> bool:
    """
    Run a series of operations within a MongoDB transaction.
    Returns True if transaction succeeded, False otherwise.
    """
    # Use client directly for transaction
    client = db_manager.client
    session = await client.start_session()

    try:
        async with session.start_transaction():
            for op in operations:
                await op()
        return True
    except Exception as e:
        logger.error("Transaction failed: %s", str(e))
        await session.abort_transaction()
        return False
    finally:
        await session.end_session()


async def init_database() -> None:
    """Initialize the database and create collections and indexes."""
    try:
        logger.info("Initializing database...")

        # Get database handle
        db = db_manager.db

        # List of collections to ensure exist
        collections = [
            "trips",
            "matched_trips",
            "places",
            "vehicles",
            "settings",
            "task_history",
            "streets",
            "coverage_metadata",
            "uploaded_trips",
        ]

        # Get existing collections
        existing_collections = await db.list_collection_names()

        # Create collections that don't exist yet
        for collection_name in collections:
            if collection_name not in existing_collections:
                await db.create_collection(collection_name)
                logger.info(f"Created collection: {collection_name}")
            else:
                logger.info(f"Collection already exists: {collection_name}")

        # Initialize indexes
        await init_task_history_collection()
        await ensure_street_coverage_indexes()
        await ensure_location_indexes()

        logger.info("Database initialized successfully")
    except Exception as e:
        logger.error("Error initializing database: %s", e)
        raise
