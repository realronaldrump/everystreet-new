"""Database management module.

Provides a singleton DatabaseManager class for MongoDB connections and
operations, with robust retry logic, connection pooling, serialization helpers,
and GridFS access.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import datetime, timezone
from typing import (
    Any,
    TypeVar,
)

import bson
import certifi
import pymongo
from bson import ObjectId, json_util
from fastapi import Request
from motor.motor_asyncio import (
    AsyncIOMotorClient,
    AsyncIOMotorCollection,
    AsyncIOMotorCursor,
    AsyncIOMotorDatabase,
    AsyncIOMotorGridFSBucket,
)
from pymongo.errors import (
    ConnectionFailure,
    DuplicateKeyError,
    OperationFailure,
    ServerSelectionTimeoutError,
)
from pymongo.results import DeleteResult, InsertOneResult, UpdateResult

logger = logging.getLogger(__name__)

T = TypeVar("T")


class DatabaseManager:
    """Singleton class to manage the MongoDB client, database connection, and
    GridFS.
    """

    _instance: DatabaseManager | None = None
    _lock = threading.Lock()

    def __new__(cls) -> DatabaseManager:
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialized = False
        return cls._instance

    def __init__(self) -> None:
        if not getattr(self, "_initialized", False):
            self._client: AsyncIOMotorClient | None = None
            self._db: AsyncIOMotorDatabase | None = None
            self._gridfs_bucket_instance: None | (
                AsyncIOMotorGridFSBucket
            ) = None
            self._quota_exceeded = False
            self._connection_healthy = True
            self._db_semaphore = asyncio.Semaphore(10)
            self._collections: dict[str, AsyncIOMotorCollection] = {}
            self._initialized = True
            self._conn_retry_backoff = [
                1,
                2,
                5,
                10,
                30,
            ]

            self._max_pool_size = int(os.getenv("MONGODB_MAX_POOL_SIZE", "10"))
            self._connection_timeout_ms = int(
                os.getenv(
                    "MONGODB_CONNECTION_TIMEOUT_MS",
                    "5000",
                ),
            )
            self._server_selection_timeout_ms = int(
                os.getenv(
                    "MONGODB_SERVER_SELECTION_TIMEOUT_MS",
                    "10000",
                ),
            )
            self._socket_timeout_ms = int(
                os.getenv(
                    "MONGODB_SOCKET_TIMEOUT_MS",
                    "30000",
                ),
            )
            self._max_retry_attempts = int(
                os.getenv(
                    "MONGODB_MAX_RETRY_ATTEMPTS",
                    "5",
                ),
            )
            self._db_name = os.getenv("MONGODB_DATABASE", "every_street")

            logger.debug(
                "Database configuration initialized with pool size %s",
                self._max_pool_size,
            )

    def _initialize_client(self) -> None:
        """Initialize the MongoDB client with proper connection settings."""
        try:
            mongo_uri = os.getenv("MONGO_URI")
            if not mongo_uri:
                raise ValueError("MONGO_URI environment variable not set")

            logger.debug("Initializing MongoDB client...")
            self._client = AsyncIOMotorClient(
                mongo_uri,
                tls=True,
                tlsAllowInvalidCertificates=True,
                tlsCAFile=certifi.where(),
                tz_aware=True,
                tzinfo=timezone.utc,
                maxPoolSize=self._max_pool_size,
                minPoolSize=0,
                maxIdleTimeMS=60000,
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
            self._collections = {}
            self._gridfs_bucket_instance = None
            logger.info("MongoDB client initialized successfully")
        except Exception as e:
            self._connection_healthy = False
            logger.error(
                "Failed to initialize MongoDB client: %s",
                str(e),
            )
            raise

    @property
    def db(self) -> AsyncIOMotorDatabase:
        """Get the database instance, initializing the client if needed."""
        if self._db is None or not self._connection_healthy:
            self._initialize_client()
        if self._db is None:
            raise ConnectionFailure(
                "Database instance could not be initialized.",
            )
        return self._db

    @property
    def client(self) -> AsyncIOMotorClient:
        """Get the client instance, initializing if needed."""
        if self._client is None or not self._connection_healthy:
            self._initialize_client()
        if self._client is None:
            raise ConnectionFailure("MongoDB client could not be initialized.")
        return self._client

    @property
    def gridfs_bucket(
        self,
    ) -> AsyncIOMotorGridFSBucket:
        """Get a GridFS bucket instance, initializing if needed."""
        db_instance = self.db
        if self._gridfs_bucket_instance is None:
            self._gridfs_bucket_instance = AsyncIOMotorGridFSBucket(
                db_instance,
            )
        return self._gridfs_bucket_instance

    @property
    def quota_exceeded(self) -> bool:
        """Check if the database quota is exceeded."""
        return self._quota_exceeded

    def get_collection(self, collection_name: str) -> AsyncIOMotorCollection:
        """Get a collection by name, cached for efficiency.

        Args:
            collection_name: Name of the collection

        Returns:
            MongoDB collection

        """
        if (
            collection_name not in self._collections
            or not self._connection_healthy
        ):
            self._collections[collection_name] = self.db[collection_name]
        return self._collections[collection_name]

    async def execute_with_retry(
        self,
        operation: Callable[[], Awaitable[T]],
        max_attempts: int | None = None,
        operation_name: str = "database operation",
    ) -> T:
        """Execute a database operation with retry logic.

        Args:
            operation: Async function to execute
            max_attempts: Maximum number of retry attempts
            operation_name: Name of operation for logging

        Returns:
            Result of the operation

        Raises:
            Exception: If operation fails after all attempts

        """
        if max_attempts is None:
            max_attempts = self._max_retry_attempts

        attempts = 0

        while attempts < max_attempts:
            attempts += 1
            retry_delay = self._conn_retry_backoff[
                min(
                    attempts - 1,
                    len(self._conn_retry_backoff) - 1,
                )
            ]

            try:
                async with self._db_semaphore:
                    _ = self.client
                    _ = self.db
                    if not self._connection_healthy:
                        self._initialize_client()

                    return await operation()

            except (
                ConnectionFailure,
                ServerSelectionTimeoutError,
            ) as e:
                self._connection_healthy = False
                logger.warning(
                    "Attempt %d/%d for %s failed due to connection error: %s. Retrying in %ds...",
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
                    raise ConnectionFailure(
                        f"Failed to connect after {max_attempts} attempts for {operation_name}",
                    ) from e

                await asyncio.sleep(retry_delay)

            except OperationFailure as e:
                is_transient = e.has_error_label(
                    "TransientTransactionError",
                ) or e.code in [
                    11600,
                    11602,
                ]

                if is_transient and attempts < max_attempts:
                    logger.warning(
                        "Attempt %d/%d for %s failed with transient OperationFailure (Code: %s): %s. Retrying in %ds...",
                        attempts,
                        max_attempts,
                        operation_name,
                        e.code,
                        str(e),
                        retry_delay,
                    )
                    await asyncio.sleep(retry_delay)
                else:
                    logger.error(
                        "Error in %s (attempt %d/%d, Code: %s): %s",
                        operation_name,
                        attempts,
                        max_attempts,
                        e.code,
                        str(e),
                        exc_info=False,
                    )
                    raise

            except Exception as e:
                logger.error(
                    "Unexpected error in %s (attempt %d/%d): %s",
                    operation_name,
                    attempts,
                    max_attempts,
                    str(e),
                    exc_info=True,
                )

                raise

        raise RuntimeError(
            f"All {max_attempts} retry attempts failed for {operation_name}",
        )

    async def check_quota(
        self,
    ) -> tuple[float | None, float | None]:
        """Check if the database quota is exceeded.

        Returns:
            Tuple of (used_mb, limit_mb) or (None, None) on error

        """
        try:

            async def _check_quota() -> tuple[float, float]:
                stats = await self.db.command("dbStats")
                data_size = stats.get("dataSize", 0)
                used_mb = data_size / (1024 * 1024)
                limit_mb = 512
                self._quota_exceeded = used_mb > limit_mb
                return used_mb, limit_mb

            return await self.execute_with_retry(
                _check_quota,
                operation_name="quota check",
            )
        except Exception as e:
            if "over your space quota" in str(e).lower():
                self._quota_exceeded = True
            logger.error(
                "Error checking database quota: %s",
                str(e),
            )
            return None, None

    async def safe_create_index(
        self,
        collection_name: str,
        keys: str | list[tuple[str, int]],
        **kwargs: Any,
    ) -> str | None:
        """Create an index on a collection if quota is not exceeded.

        Args:
            collection_name: Name of the collection
            keys: Keys to index
            **kwargs: Additional arguments for create_index

        Returns:
            Name of the created index or None

        """
        if self._quota_exceeded:
            logger.warning(
                "Skipping index creation for %s due to quota exceeded",
                collection_name,
            )
            return None

        try:
            collection = self.get_collection(collection_name)

            existing_indexes = await collection.index_information()

            keys_tuple = tuple(
                sorted(list(keys) if isinstance(keys, list) else [(keys, 1)]),
            )

            for (
                idx_name,
                idx_info,
            ) in existing_indexes.items():
                if idx_name == "_id_":
                    continue

                idx_keys = tuple(sorted(list(idx_info.get("key", []))))
                if idx_keys == keys_tuple:
                    logger.info(
                        "Index with keys %s already exists as '%s' on %s, skipping creation",
                        keys_tuple,
                        idx_name,
                        collection_name,
                    )
                    return idx_name

            if "name" in kwargs:
                index_name = kwargs["name"]
                if index_name in existing_indexes:
                    logger.info(
                        "Index %s already exists, skipping creation",
                        index_name,
                    )
                    return index_name

            async def _create_index() -> str:
                return await collection.create_index(keys, **kwargs)

            result = await self.execute_with_retry(
                _create_index,
                operation_name=f"index creation on {collection_name}",
            )
            logger.info(
                "Index created on %s with keys %s (Name: %s)",
                collection_name,
                keys,
                result,
            )
            return result
        except DuplicateKeyError:
            logger.warning(
                "Index already exists on %s, ignoring DuplicateKeyError",
                collection_name,
            )
            try:
                collection = self.get_collection(collection_name)
                existing_indexes_info = await collection.index_information()
                keys_tuple_check = tuple(
                    sorted(
                        list(keys) if isinstance(keys, list) else [(keys, 1)],
                    ),
                )
                for (
                    idx_name,
                    idx_info,
                ) in existing_indexes_info.items():
                    idx_keys_check = tuple(
                        sorted(list(idx_info.get("key", []))),
                    )
                    if idx_keys_check == keys_tuple_check:
                        return idx_name
            except Exception:
                pass
            return None
        except OperationFailure as e:
            if "over your space quota" in str(e).lower():
                self._quota_exceeded = True
                logger.warning("Cannot create index due to quota exceeded")
            elif e.code == 85:  # IndexOptionsConflict
                # Check if the conflict is due to an index with the same name but different options
                index_name_to_create = kwargs.get("name")
                if index_name_to_create and index_name_to_create in str(
                    e.details.get("errmsg", "")
                ):
                    logger.warning(
                        "IndexOptionsConflict for index '%s' on collection '%s'. Attempting to drop and recreate. Error: %s",
                        index_name_to_create,
                        collection_name,
                        str(e),
                    )
                    try:
                        await collection.drop_index(index_name_to_create)
                        logger.info(
                            "Successfully dropped conflicting index '%s' on '%s'. Retrying creation.",
                            index_name_to_create,
                            collection_name,
                        )
                        # Retry the original create_index call
                        result = await self.execute_with_retry(
                            _create_index,  # _create_index is defined above
                            operation_name=f"index recreation on {collection_name} after conflict",
                        )
                        logger.info(
                            "Index recreated on %s with keys %s (Name: %s)",
                            collection_name,
                            keys,
                            result,
                        )
                        return result
                    except Exception as drop_recreate_e:
                        logger.error(
                            "Failed to drop and recreate index '%s' on '%s' after IndexOptionsConflict: %s",
                            index_name_to_create,
                            collection_name,
                            str(drop_recreate_e),
                        )
                        # If drop/recreate fails, re-raise original error or just log and return None
                        # For now, let's log and return None to avoid startup failure
                        return None
                else:
                    # Different kind of IndexOptionsConflict or name not specified/matched
                    logger.warning(
                        "IndexOptionsConflict on %s (but not a simple name/options mismatch or name not specified): %s",
                        collection_name,
                        str(e),
                    )
                    return None

            elif (
                e.code
                in (
                    86,
                    68,
                )
            ):  # Other conflicts (IndexKeySpecsConflict, IndexNameAlreadyExists and not options conflict)
                logger.warning(
                    "Index conflict (key specs or name already exists and options match): %s",
                    str(e),
                )
            else:
                logger.error(
                    "Error creating index: %s",
                    str(e),
                )
                raise
            return None

    async def cleanup_connections(self) -> None:
        """Close database connections.

        Call during application shutdown.
        """
        if self._client:
            try:
                logger.info("Closing MongoDB client connections...")
                self._client.close()
            except Exception as e:
                logger.error(
                    "Error closing MongoDB client: %s",
                    str(e),
                )
            finally:
                self._client = None
                self._db = None
                self._collections = {}
                self._gridfs_bucket_instance = None
                self._connection_healthy = False
                logger.info("MongoDB client state reset")

    def __del__(self) -> None:
        """Ensure connections are closed when the manager is garbage
        collected.
        """
        if hasattr(self, "_client") and self._client:
            try:
                self._client.close()
            except Exception:
                pass
            finally:
                self._client = None
                self._db = None
                self._collections = {}
                self._gridfs_bucket_instance = None

    @property
    def connection_healthy(self) -> bool:
        """Public property to check if the database connection is healthy."""
        return self._connection_healthy

    def ensure_connection(self) -> None:
        """Public method to ensure the client is initialized and healthy."""
        if not self._connection_healthy:
            self._initialize_client()


db_manager = DatabaseManager()


def _get_collection(
    name: str,
) -> AsyncIOMotorCollection:
    return db_manager.get_collection(name)


trips_collection = _get_collection("trips")
matched_trips_collection = _get_collection("matched_trips")

places_collection = _get_collection("places")
osm_data_collection = _get_collection("osm_data")
streets_collection = _get_collection("streets")
coverage_metadata_collection = _get_collection("coverage_metadata")
live_trips_collection = _get_collection("live_trips")
archived_live_trips_collection = _get_collection("archived_live_trips")
task_config_collection = _get_collection("task_config")
task_history_collection = _get_collection("task_history")
progress_collection = _get_collection("progress_status")


def post_process_deserialize(obj):
    """Recursively convert Mongo Extended JSON types ($date, $oid) to Python types."""
    if isinstance(obj, dict):
        if "$oid" in obj and len(obj) == 1:
            try:
                return str(ObjectId(obj["$oid"]))
            except Exception as oid_err:
                logger.warning(
                    "Could not convert $oid value '%s' to ObjectId: %s",
                    obj["$oid"],
                    oid_err,
                )
                return obj
        elif "$date" in obj and len(obj) == 1:
            try:
                date_val = obj["$date"]
                if isinstance(date_val, dict) and "$numberLong" in date_val:
                    ms_epoch = int(date_val["$numberLong"])
                    return datetime.fromtimestamp(
                        ms_epoch / 1000.0,
                        tz=timezone.utc,
                    )
                if isinstance(date_val, str):
                    dt = datetime.fromisoformat(
                        date_val.replace("Z", "+00:00"),
                    )
                    if dt.tzinfo is None:
                        dt = dt.astimezone(timezone.utc)
                    return dt.astimezone(timezone.utc)
                if isinstance(date_val, (int, float)):
                    if abs(date_val) > 2e9:
                        return datetime.fromtimestamp(
                            date_val / 1000.0,
                            tz=timezone.utc,
                        )
                    return datetime.fromtimestamp(
                        date_val,
                        tz=timezone.utc,
                    )
                logger.warning(
                    "Unexpected value type within $date dict: %s - Value: %s",
                    type(date_val),
                    date_val,
                )
                return obj
            except (
                ValueError,
                TypeError,
                KeyError,
            ) as dt_err:
                logger.error(
                    "Error parsing $date object %s: %s",
                    obj,
                    dt_err,
                )
                return obj
        else:
            return {k: post_process_deserialize(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [post_process_deserialize(item) for item in obj]
    else:
        return obj


class SerializationHelper:
    """Helper class for serializing MongoDB documents to JSON."""

    @staticmethod
    def serialize_datetime(
        dt: datetime | None,
    ) -> str | None:
        """Return ISO formatted datetime string if dt is not None.

        Args:
            dt: Datetime to serialize

        Returns:
            ISO formatted string or None

        """
        if dt is None:
            return None
        if dt.tzinfo is None:
            dt = dt.astimezone(timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")

    @staticmethod
    def serialize_document(
        doc: dict[str, Any],
    ) -> dict[str, Any]:
        """Convert MongoDB document to a dictionary suitable for internal use,
        ensuring BSON types like dates and ObjectIds are converted to
        standard Python types.

        Args:
            doc: MongoDB document (dictionary)

        Returns:
            Dictionary with standard Python types (datetime, str for ObjectId).

        """
        if not doc:
            return {}
        try:
            serialized_string = json_util.dumps(doc)
            loaded_data = json.loads(serialized_string)
            return post_process_deserialize(loaded_data)

        except (TypeError, ValueError) as e:
            logger.error(
                "Error serializing/processing document: %s. Document snippet: %s",
                e,
                str(doc)[:200],
            )
            fallback_result = {}
            for key, value in doc.items():
                if isinstance(value, ObjectId):
                    fallback_result[key] = value
                elif isinstance(value, datetime):
                    fallback_result[key] = (
                        SerializationHelper.serialize_datetime(value)
                    )
                elif isinstance(value, (dict, list)):
                    fallback_result[key] = (
                        f"<Complex Type: {type(value).__name__}>"
                    )
                else:
                    try:
                        json.dumps(value)
                        fallback_result[key] = value
                    except TypeError:
                        fallback_result[key] = str(value)
            return fallback_result

    @staticmethod
    def serialize_trip(
        trip: dict[str, Any],
    ) -> dict[str, Any]:
        """Convert trip document to JSON serializable dictionary. Handles
        special fields specific to trip documents. (Relies on serialize_document)

        Args:
            trip: Trip document

        Returns:
            JSON serializable trip dictionary

        """
        return SerializationHelper.serialize_document(trip)


async def batch_cursor(
    cursor: AsyncIOMotorCursor,
    batch_size: int = 100,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Process an AsyncIOMotorCursor in manageable batches to limit memory
    usage.

    Args:
        cursor: The MongoDB cursor to iterate through
        batch_size: Number of documents to fetch at once
        no_timeout: If True, prevents cursor from timing out during long operations

    Yields:
        Lists of documents, batch_size at a time

    """
    batch = []
    try:
        async for document in cursor:
            batch.append(document)
            if len(batch) >= batch_size:
                yield batch
                batch = []
                await asyncio.sleep(0)

        if batch:
            yield batch
    finally:
        pass


def parse_query_date(
    date_str: str | None,
    end_of_day: bool = False,
) -> datetime | None:
    """Parse a date string into a timezone-aware UTC datetime object. Handles
    ISO formats (including 'Z') and 'YYYY-MM-DD'.

    Args:
        date_str: Date string to parse
        end_of_day: If True, set time to end of day (23:59:59.999999 UTC)

    Returns:
        Timezone-aware UTC datetime object or None if parsing fails

    """
    if not date_str:
        return None

    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.astimezone(timezone.utc)
        dt = dt.astimezone(timezone.utc)

        if end_of_day:
            dt = dt.replace(
                hour=23,
                minute=59,
                second=59,
                microsecond=999999,
            )
        return dt
    except ValueError:
        try:
            dt_date = datetime.strptime(date_str, "%Y-%m-%d").date()
            if end_of_day:
                dt = datetime.combine(
                    dt_date,
                    datetime.max.time(),
                    tzinfo=timezone.utc,
                )
            else:
                dt = datetime.combine(
                    dt_date,
                    datetime.min.time(),
                    tzinfo=timezone.utc,
                )
            return dt
        except ValueError:
            logger.warning(
                "Unable to parse date string '%s'; returning None.",
                date_str,
            )
            return None


class DateFilter:
    """A utility class for date range filtering."""

    def __init__(
        self,
        start_date: datetime | None = None,
        end_date: datetime | None = None,
        field_name: str = "startTime",
    ):
        """Initialize date filter. Dates should be timezone-aware (UTC).

        Args:
            start_date: Start of date range (UTC)
            end_date: End of date range (UTC)
            field_name: Field name to filter on

        """
        self.start_date = start_date
        self.end_date = end_date
        self.field_name = field_name

    def get_query_dict(self) -> dict:
        """Get a MongoDB query filter for this date range.

        Returns:
            MongoDB query dictionary

        """
        query = {}
        date_query = {}
        if self.start_date:
            date_query["$gte"] = self.start_date
        if self.end_date:
            date_query["$lte"] = self.end_date

        if date_query:
            query[self.field_name] = date_query
        return query


async def parse_date_params(
    request: Request,
    start_param: str = "start_date",
    end_param: str = "end_date",
    field_name: str = "startTime",
    end_of_day: bool = True,
) -> DateFilter:
    """Parse start and end date parameters from a request. Returns a DateFilter
    object with parsed UTC datetime objects.

    Args:
        request: FastAPI request
        start_param: Name of start date parameter
        end_param: Name of end date parameter
        field_name: Field name for filtering
        end_of_day: Whether to set end date to end of day

    Returns:
        DateFilter object

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
    additional_filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a MongoDB query from request parameters.

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
        request,
        field_name=date_field,
        end_of_day=end_of_day,
    )
    query = date_filter.get_query_dict()

    imei_param = request.query_params.get("imei")
    if include_imei and imei_param:
        query["imei"] = imei_param

    if additional_filters:
        query.update(additional_filters)

    return query


async def find_one_with_retry(
    collection: AsyncIOMotorCollection,
    query: dict[str, Any],
    projection: Any = None,
    sort: Any = None,
) -> dict[str, Any] | None:
    """Execute find_one with retry logic.

    Args:
        collection: MongoDB collection
        query: Query filter
        projection: Fields to include/exclude
        sort: Sort specification

    Returns:
        Found document or None

    """

    async def _operation():
        if sort:
            return await collection.find_one(query, projection, sort=sort)
        return await collection.find_one(query, projection)

    try:
        return await db_manager.execute_with_retry(
            _operation,
            operation_name=f"find_one on {collection.name}",
        )
    except Exception as e:
        logger.error(
            "find_one_with_retry failed on %s: %s",
            collection.name,
            str(e),
        )
        raise


async def find_with_retry(
    collection: AsyncIOMotorCollection,
    query: dict[str, Any],
    projection: Any = None,
    sort: Any = None,
    limit: int | None = None,
    skip: int | None = None,
    batch_size: int = 100,
) -> list[dict[str, Any]]:
    """Execute find with retry logic and return a list.

    Args:
        collection: MongoDB collection
        query: Query filter
        projection: Fields to include/exclude
        sort: Sort specification
        limit: Maximum number of documents to return
        skip: Number of documents to skip
        batch_size: Batch size for cursor

    Returns:
        List of documents

    """

    async def _operation():
        cursor = collection.find(query, projection)
        if sort:
            cursor = cursor.sort(sort)
        if skip:
            cursor = cursor.skip(skip)
        if limit:
            cursor = cursor.limit(limit)

        results = []
        async for batch in batch_cursor(cursor, batch_size):
            results.extend(batch)
            if limit and len(results) >= limit:
                return results[:limit]
        return results

    return await db_manager.execute_with_retry(
        _operation,
        operation_name=f"find on {collection.name}",
    )


async def update_one_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: dict[str, Any],
    update: dict[str, Any],
    upsert: bool = False,
) -> UpdateResult:
    """Execute update_one with retry logic.

    Args:
        collection: MongoDB collection
        filter_query: Query filter
        update: Update specification
        upsert: Whether to insert if not found

    Returns:
        UpdateResult

    """

    async def _operation():
        return await collection.update_one(filter_query, update, upsert=upsert)

    return await db_manager.execute_with_retry(
        _operation,
        operation_name=f"update_one on {collection.name}",
    )


async def update_many_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: dict[str, Any],
    update: dict[str, Any],
    upsert: bool = False,
) -> UpdateResult:
    """Execute update_many with retry logic.

    Args:
        collection: MongoDB collection
        filter_query: Query filter
        update: Update specification
        upsert: Whether to insert if not found

    Returns:
        UpdateResult

    """

    async def _operation():
        return await collection.update_many(
            filter_query,
            update,
            upsert=upsert,
        )

    return await db_manager.execute_with_retry(
        _operation,
        operation_name=f"update_many on {collection.name}",
    )


async def insert_one_with_retry(
    collection: AsyncIOMotorCollection,
    document: dict[str, Any],
) -> InsertOneResult:
    """Execute insert_one with retry logic.

    Args:
        collection: MongoDB collection
        document: Document to insert

    Returns:
        InsertOneResult

    """

    async def _operation():
        return await collection.insert_one(document)

    return await db_manager.execute_with_retry(
        _operation,
        operation_name=f"insert_one on {collection.name}",
    )


async def delete_one_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: dict[str, Any],
) -> DeleteResult:
    """Execute delete_one with retry logic.

    Args:
        collection: MongoDB collection
        filter_query: Query filter

    Returns:
        DeleteResult

    """

    async def _operation():
        return await collection.delete_one(filter_query)

    return await db_manager.execute_with_retry(
        _operation,
        operation_name=f"delete_one on {collection.name}",
    )


async def delete_many_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: dict[str, Any],
) -> DeleteResult:
    """Execute delete_many with retry logic.

    Args:
        collection: MongoDB collection
        filter_query: Query filter

    Returns:
        DeleteResult

    """

    async def _operation():
        return await collection.delete_many(filter_query)

    return await db_manager.execute_with_retry(
        _operation,
        operation_name=f"delete_many on {collection.name}",
    )


async def aggregate_with_retry(
    collection: AsyncIOMotorCollection,
    pipeline: list[dict[str, Any]],
    batch_size: int = 100,
    allow_disk_use: bool = True,
) -> list[dict[str, Any]]:
    """Execute aggregate with retry logic.

    Args:
        collection: MongoDB collection
        pipeline: Aggregation pipeline
        batch_size: Batch size for cursor
        allow_disk_use: Allow MongoDB to use disk for large aggregations

    Returns:
        List of documents

    """

    async def _operation():
        result = []
        cursor = collection.aggregate(pipeline, allowDiskUse=allow_disk_use)
        async for batch in batch_cursor(cursor, batch_size):
            result.extend(batch)
        return result

    return await db_manager.execute_with_retry(
        _operation,
        operation_name=f"aggregate on {collection.name}",
    )


async def count_documents_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: dict[str, Any],
    **kwargs: Any,
) -> int:
    """Execute count_documents with retry logic.

    Args:
        collection: MongoDB collection
        filter_query: Query filter
        **kwargs: Additional options for count_documents (e.g., hint)

    Returns:
        Document count

    """

    async def _operation():
        return await collection.count_documents(filter_query, **kwargs)

    return await db_manager.execute_with_retry(
        _operation,
        operation_name=f"count_documents on {collection.name}",
    )


async def get_trip_by_id(
    trip_id: str,
    collection: AsyncIOMotorCollection | None = None,
    check_both_id_types: bool = True,
) -> dict[str, Any] | None:
    """Get a trip by transaction ID or ObjectId.

    Args:
        trip_id: Transaction ID or ObjectId string
        collection: Optional collection (defaults to trips_collection)
        check_both_id_types: Whether to check both transaction ID and ObjectId

    Returns:
        Trip document or None

    """
    if collection is None:
        collection = trips_collection

    trip = await find_one_with_retry(collection, {"transactionId": trip_id})

    if not trip and check_both_id_types and ObjectId.is_valid(trip_id):
        try:
            object_id = ObjectId(trip_id)
            trip = await find_one_with_retry(collection, {"_id": object_id})
        except bson.errors.InvalidId:
            pass
        except Exception as e:
            logger.warning(
                "Unexpected error finding trip by ObjectId %s: %s",
                trip_id,
                e,
            )

    return trip


async def init_task_history_collection() -> None:
    """Initialize the task_history collection and its indexes."""
    logger.debug("Initializing task history collection and indexes...")
    try:
        await db_manager.safe_create_index(
            "task_history",
            [("task_id", pymongo.ASCENDING)],
            name="task_history_task_id_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "task_history",
            [("timestamp", pymongo.DESCENDING)],
            name="task_history_timestamp_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "task_history",
            [
                ("task_id", pymongo.ASCENDING),
                ("timestamp", pymongo.DESCENDING),
            ],
            name="task_history_task_timestamp_idx",
            background=True,
        )
        logger.info(
            "Task history collection indexes ensured/created successfully",
        )
    except Exception as e:
        logger.error(
            "Error creating task history indexes: %s",
            str(e),
        )


async def ensure_street_coverage_indexes() -> None:
    """Ensure necessary indexes exist for street coverage collections."""
    logger.debug("Ensuring street coverage indexes exist...")

    try:
        await db_manager.safe_create_index(
            "coverage_metadata",
            [
                (
                    "location.display_name",
                    pymongo.ASCENDING,
                ),
            ],
            name="coverage_metadata_display_name_idx",
            unique=True,
            background=True,
        )
        await db_manager.safe_create_index(
            "coverage_metadata",
            [
                ("status", pymongo.ASCENDING),
                (
                    "last_updated",
                    pymongo.ASCENDING,
                ),
            ],
            name="coverage_metadata_status_updated_idx",
            background=True,
        )

        await db_manager.safe_create_index(
            "streets",
            [
                (
                    "properties.location",
                    pymongo.ASCENDING,
                ),
            ],
            name="streets_properties_location_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "streets",
            [
                (
                    "properties.segment_id",
                    pymongo.ASCENDING,
                ),
            ],
            name="streets_properties_segment_id_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "streets",
            [("geometry", "2dsphere")],
            name="streets_geometry_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "streets",
            [
                ("properties.location", 1),
                ("properties.driven", 1),
                ("properties.highway", 1),
                ("properties.segment_length", 1),
            ],
            name="streets_coverage_aggregation_idx",
            background=True,
        )

        await db_manager.safe_create_index(
            "trips",
            [("startTime", pymongo.ASCENDING)],
            name="trips_startTime_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("startGeoPoint", "2dsphere")],
            name="trips_startGeoPoint_2dsphere_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("destinationGeoPoint", "2dsphere")],
            name="trips_destinationGeoPoint_2dsphere_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [
                ("startGeoPoint", "2dsphere"),
                (
                    "destinationGeoPoint",
                    "2dsphere",
                ),
                ("_id", 1),
            ],
            name="trips_coverage_query_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("source", pymongo.ASCENDING)],
            name="trips_source_idx",
            background=True,
        )

        # CRITICAL PERFORMANCE INDEXES - Adding missing indexes for frequent lookups and sorts
        await db_manager.safe_create_index(
            "trips",
            [("transactionId", pymongo.ASCENDING)],
            name="trips_transactionId_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("endTime", pymongo.DESCENDING)],
            name="trips_endTime_desc_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "matched_trips",
            [("transactionId", pymongo.ASCENDING)],
            name="matched_trips_transactionId_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "matched_trips",
            [("startTime", pymongo.ASCENDING)],
            name="matched_trips_startTime_idx",
            background=True,
        )

        logger.info("Street coverage indexes ensured/created successfully")
    except Exception as e:
        logger.error(
            "Error creating street coverage indexes: %s",
            str(e),
        )
        raise


async def ensure_location_indexes() -> None:
    """Ensure necessary indexes exist for location data in trip collections."""
    logger.debug("Ensuring location structure indexes exist...")
    try:
        collections = ["trips", "matched_trips"]

        for collection_name in collections:
            await db_manager.safe_create_index(
                collection_name,
                [
                    (
                        "startLocation.address_components.city",
                        1,
                    ),
                ],
                name=f"{collection_name}_start_city_idx",
                background=True,
                sparse=True,
            )
            await db_manager.safe_create_index(
                collection_name,
                [
                    (
                        "destination.address_components.city",
                        1,
                    ),
                ],
                name=f"{collection_name}_dest_city_idx",
                background=True,
                sparse=True,
            )

            await db_manager.safe_create_index(
                collection_name,
                [
                    (
                        "startLocation.address_components.state",
                        1,
                    ),
                ],
                name=f"{collection_name}_start_state_idx",
                background=True,
                sparse=True,
            )
            await db_manager.safe_create_index(
                collection_name,
                [
                    (
                        "destination.address_components.state",
                        1,
                    ),
                ],
                name=f"{collection_name}_dest_state_idx",
                background=True,
                sparse=True,
            )

        logger.info("Location structure indexes ensured/created successfully")
    except Exception as e:
        logger.error(
            "Error creating location structure indexes: %s",
            str(e),
        )


async def run_transaction(
    operations: list[Callable[[], Awaitable[Any]]],
    max_retries: int = 3,
) -> bool:
    """Run a series of operations within a MongoDB transaction with retry logic for write conflicts.
    Note: Requires replica set or sharded cluster. Standalone instances do not support transactions.

    Args:
        operations: List of async operations to execute
        max_retries: Maximum number of retries for transient errors like write conflicts

    Returns:
        True if transaction succeeded, False otherwise

    """
    client = db_manager.client
    retry_count = 0
    while retry_count <= max_retries:
        try:
            async with await client.start_session() as session:
                async with session.start_transaction():
                    logger.debug("Starting transaction...")
                    for i, op in enumerate(operations):
                        logger.debug(
                            "Executing operation %d in transaction...",
                            i + 1,
                        )
                        await op(session=session)
                    logger.debug("Transaction committed.")
            return True
        except (ConnectionFailure, OperationFailure) as e:
            is_transient = False
            if hasattr(e, "has_error_label"):
                is_transient = e.has_error_label("TransientTransactionError")
            elif hasattr(e, "details") and isinstance(e.details, dict):
                is_transient = "TransientTransactionError" in (
                    e.details.get("errorLabels", [])
                )
            if is_transient and retry_count < max_retries:
                retry_count += 1
                delay = 0.1 * (2**retry_count)
                logger.warning(
                    f"Transient transaction error (attempt {retry_count}/{max_retries}), retrying in {delay}s: {e}"
                )
                await asyncio.sleep(delay)
                continue
            logger.error(
                f"Transaction failed after {retry_count + 1} attempts: {e}",
                exc_info=True,
            )
            return False
        except Exception as e:
            logger.error(
                "Unexpected error during transaction: %s", e, exc_info=True
            )
            return False


async def ensure_archived_trip_indexes() -> None:
    """Ensure necessary indexes exist on the archived_live_trips collection."""
    db = DatabaseManager()
    collection_name = "archived_live_trips"
    # 2dsphere index for GPS data
    await db.safe_create_index(
        collection_name,
        [("gps", pymongo.GEOSPHERE)],
        name="archived_gps_2dsphere_idx",
        background=True,
    )
    # Index on transactionId for faster lookups if not already present
    await db.safe_create_index(
        collection_name,
        "transactionId",
        name="archived_transactionId_idx",
        unique=True,  # Assuming transactionId should be unique in this collection
        background=True,
    )
    # Index on endTime for sorting or querying by time
    await db.safe_create_index(
        collection_name,
        "endTime",
        name="archived_endTime_idx",
        background=True,
    )
    logger.info(f"Indexes ensured for '{collection_name}'.")


async def init_database() -> None:
    """Initialize the database by ensuring all collections and indexes exist."""
    logger.info("Initializing database...")

    used_mb, limit_mb = await db_manager.check_quota()
    if db_manager.quota_exceeded:
        logger.warning(
            "Storage quota exceeded (%.2f MB / %d MB). Database operations may fail.",
            used_mb,
            limit_mb,
        )

    await init_task_history_collection()

    await ensure_street_coverage_indexes()
    await ensure_location_indexes()
    await ensure_archived_trip_indexes()

    _ = db_manager.get_collection("places")
    _ = db_manager.get_collection("task_config")
    _ = db_manager.get_collection("progress_status")
    _ = db_manager.get_collection("osm_data")
    _ = db_manager.get_collection("live_trips")
    _ = db_manager.get_collection("archived_live_trips")

    logger.info("Database initialization complete.")
