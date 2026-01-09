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
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, TypeVar

import bson
import certifi
import pymongo
from bson import ObjectId
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

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Awaitable, Callable

    from fastapi import Request

from pymongo.results import (
    DeleteResult,
    InsertManyResult,
    InsertOneResult,
    UpdateResult,
)

from date_utils import (
    normalize_calendar_date,
    normalize_to_utc_datetime,
    parse_timestamp,
)

logger = logging.getLogger(__name__)


T = TypeVar("T")


class DatabaseManager:
    """Singleton class to manage the MongoDB client, database connection, and.

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
            self._gridfs_bucket_instance: None | (AsyncIOMotorGridFSBucket) = None
            self._bound_loop: asyncio.AbstractEventLoop | None = None
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

            self._max_pool_size = int(os.getenv("MONGODB_MAX_POOL_SIZE", "50"))
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
                mongo_host = os.getenv("MONGO_HOST", "mongo")
                mongo_port = os.getenv("MONGO_PORT", "27017")
                db_name = os.getenv("MONGODB_DATABASE", "every_street")
                mongo_uri = f"mongodb://{mongo_host}:{mongo_port}/{db_name}"
                logger.warning(
                    "MONGO_URI not set, constructing from components: %s",
                    mongo_uri,
                )

            logger.debug("Initializing MongoDB client with URI: %s", mongo_uri)

            client_kwargs: dict[str, Any] = {
                "tz_aware": True,
                "tzinfo": UTC,
                "maxPoolSize": self._max_pool_size,
                "minPoolSize": 0,
                "maxIdleTimeMS": 60000,
                "connectTimeoutMS": self._connection_timeout_ms,
                "serverSelectionTimeoutMS": self._server_selection_timeout_ms,
                "socketTimeoutMS": self._socket_timeout_ms,
                "retryWrites": True,
                "retryReads": True,
                "waitQueueTimeoutMS": 30000,
                "appname": "EveryStreet",
            }

            if mongo_uri.startswith("mongodb+srv://"):
                client_kwargs.update(
                    tls=True,
                    tlsAllowInvalidCertificates=True,
                    tlsCAFile=certifi.where(),
                )

            self._client = AsyncIOMotorClient(
                mongo_uri,
                **client_kwargs,
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

    @staticmethod
    def _get_current_loop() -> asyncio.AbstractEventLoop | None:
        """Safely get the current running event loop, or None if no loop is running."""
        try:
            return asyncio.get_running_loop()
        except RuntimeError:
            return None

    def _close_client_sync(self) -> None:
        """Synchronously close the current client (for loop change scenarios)."""
        if self._client:
            try:
                self._client.close()
                logger.debug("Closed MongoDB client due to event loop change")
            except Exception as e:
                logger.warning("Error closing MongoDB client: %s", e)
            finally:
                self._client = None
                self._db = None
                self._collections = {}
                self._gridfs_bucket_instance = None
                self._bound_loop = None

    def _check_loop_and_reconnect(self) -> None:
        """Check if event loop has changed and reconnect if necessary."""
        current_loop = self._get_current_loop()
        if (
            self._client is not None
            and self._bound_loop is not None
            and self._bound_loop.is_closed()
        ):
            logger.info(
                "Event loop is closed (was %s), reconnecting MongoDB client",
                id(self._bound_loop),
            )
            self._close_client_sync()
        if (
            self._client is not None
            and current_loop is not None
            and self._bound_loop != current_loop
        ):
            logger.info(
                "Event loop changed (was %s, now %s), reconnecting MongoDB client",
                id(self._bound_loop),
                id(current_loop),
            )
            self._close_client_sync()

    @property
    def db(self) -> AsyncIOMotorDatabase:
        self._check_loop_and_reconnect()
        if self._db is None or not self._connection_healthy:
            self._initialize_client()
            self._bound_loop = self._get_current_loop()
        if self._db is None:
            raise ConnectionFailure(
                "Database instance could not be initialized.",
            )
        return self._db

    @property
    def client(self) -> AsyncIOMotorClient:
        self._check_loop_and_reconnect()
        if self._client is None or not self._connection_healthy:
            self._initialize_client()
            self._bound_loop = self._get_current_loop()
        if self._client is None:
            raise ConnectionFailure("MongoDB client could not be initialized.")
        return self._client

    @property
    def gridfs_bucket(
        self,
    ) -> AsyncIOMotorGridFSBucket:
        db_instance = self.db
        if self._gridfs_bucket_instance is None:
            self._gridfs_bucket_instance = AsyncIOMotorGridFSBucket(
                db_instance,
            )
        return self._gridfs_bucket_instance

    def get_collection(self, collection_name: str) -> AsyncIOMotorCollection:
        if collection_name not in self._collections or not self._connection_healthy:
            self._collections[collection_name] = self.db[collection_name]
        return self._collections[collection_name]

    async def execute_with_retry(
        self,
        operation: Callable[[], Awaitable[T]],
        max_attempts: int | None = None,
        operation_name: str = "database operation",
    ) -> T:
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

    async def safe_create_index(
        self,
        collection_name: str,
        keys: str | list[tuple[str, int]],
        **kwargs: Any,
    ) -> str | None:
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

                idx_keys = tuple(sorted(idx_info.get("key", [])))
                if idx_keys == keys_tuple:
                    logger.debug(
                        "Index with keys %s already exists as '%s' on %s, skipping creation",
                        keys_tuple,
                        idx_name,
                        collection_name,
                    )
                    return idx_name

            if "name" in kwargs:
                index_name = kwargs["name"]
                if index_name in existing_indexes:
                    logger.debug(
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
                        sorted(idx_info.get("key", [])),
                    )
                    if idx_keys_check == keys_tuple_check:
                        return idx_name
            except Exception:
                pass
            return None
        except OperationFailure as e:
            if e.code == 85:
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
                        result = await self.execute_with_retry(
                            _create_index,
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
                        return None
                else:
                    logger.warning(
                        "IndexOptionsConflict on %s (but not a simple name/options mismatch or name not specified): %s",
                        collection_name,
                        str(e),
                    )
                    return None

            elif e.code in (
                86,
                68,
            ):
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
        return self._connection_healthy

    def ensure_connection(self) -> None:
        if not self._connection_healthy:
            self._initialize_client()


db_manager = DatabaseManager()


class CollectionProxy:
    """Proxy that always resolves the current collection from the db manager."""

    def __init__(self, name: str) -> None:
        self._name = name

    @property
    def _collection(self) -> AsyncIOMotorCollection:
        return db_manager.get_collection(self._name)

    def __getattr__(self, attr: str) -> Any:
        return getattr(self._collection, attr)

    def __repr__(self) -> str:
        return f"<CollectionProxy name={self._name}>"


def _get_collection(
    name: str,
) -> CollectionProxy:
    return CollectionProxy(name)


trips_collection = _get_collection("trips")
places_collection = _get_collection("places")
osm_data_collection = _get_collection("osm_data")
streets_collection = _get_collection("streets")
coverage_metadata_collection = _get_collection("coverage_metadata")
live_trips_collection = _get_collection("live_trips")
archived_live_trips_collection = _get_collection("archived_live_trips")
task_config_collection = _get_collection("task_config")
task_history_collection = _get_collection("task_history")
progress_collection = _get_collection("progress_status")
gas_fillups_collection = _get_collection("gas_fillups")
vehicles_collection = _get_collection("vehicles")
optimal_route_progress_collection = _get_collection("optimal_route_progress")


def serialize_datetime(
    dt: datetime | str | None,
) -> str | None:
    if dt is None:
        return None
    if isinstance(dt, str | datetime):
        dt = parse_timestamp(dt)
    if dt is None:
        return None
    return dt.isoformat().replace("+00:00", "Z")


def serialize_for_json(data: Any) -> Any:
    if isinstance(data, dict):
        return {k: serialize_for_json(v) for k, v in data.items()}
    if isinstance(data, list):
        return [serialize_for_json(item) for item in data]
    if isinstance(data, ObjectId):
        return str(data)
    if isinstance(data, datetime):
        return data.isoformat()
    return data


def serialize_document(doc: dict[str, Any]) -> dict[str, Any]:
    if not doc:
        return {}
    return serialize_for_json(doc)


def json_dumps(data: Any, **kwargs) -> str:
    """Serialize data to JSON string with MongoDB type handling.

    This is the canonical way to serialize MongoDB documents to JSON strings.
    Handles ObjectId, datetime, and nested structures automatically.

    Args:
        data: Data to serialize (dict, list, or any JSON-serializable type)
        **kwargs: Additional arguments passed to json.dumps (e.g., separators, indent)

    Returns:
        JSON string
    """
    return json.dumps(serialize_for_json(data), **kwargs)


async def batch_cursor(
    cursor: AsyncIOMotorCursor,
    batch_size: int = 100,
) -> AsyncIterator[list[dict[str, Any]]]:
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
    if not date_str:
        return None

    dt = normalize_to_utc_datetime(date_str)
    if dt is None:
        logger.warning("Unable to parse date string '%s'; returning None.", date_str)
        return None

    is_date_only = (
        isinstance(date_str, str) and "T" not in date_str and "t" not in date_str
    )

    if is_date_only:
        if end_of_day:
            return dt.replace(hour=23, minute=59, second=59, microsecond=999999)
        return dt.replace(hour=0, minute=0, second=0, microsecond=0)

    return dt


def build_calendar_date_expr(
    start_date: str | datetime | None,
    end_date: str | datetime | None,
    *,
    date_field: str = "startTime",
) -> dict[str, Any] | None:
    start_str = normalize_calendar_date(start_date)
    end_str = normalize_calendar_date(end_date)

    if start_date and not start_str:
        logger.warning("Invalid start date provided for filtering: %s", start_date)
    if end_date and not end_str:
        logger.warning("Invalid end date provided for filtering: %s", end_date)

    if not start_str and not end_str:
        return None

    tz_expr: dict[str, Any] = {
        "$switch": {
            "branches": [
                {
                    "case": {"$in": ["$timeZone", ["", "0000"]]},
                    "then": "UTC",
                }
            ],
            "default": {"$ifNull": ["$timeZone", "UTC"]},
        }
    }

    date_expr: dict[str, Any] = {
        "$dateToString": {
            "format": "%Y-%m-%d",
            "date": f"${date_field}",
            "timezone": tz_expr,
        }
    }

    clauses: list[dict[str, Any]] = []
    if start_str:
        clauses.append({"$gte": [date_expr, start_str]})
    if end_str:
        clauses.append({"$lte": [date_expr, end_str]})

    if not clauses:
        return None

    return {"$and": clauses} if len(clauses) > 1 else clauses[0]


async def build_query_from_request(
    request: Request,
    date_field: str = "startTime",
    _end_of_day: bool = True,
    include_imei: bool = True,
    additional_filters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    query: dict[str, Any] = {}

    start_date_str = request.query_params.get("start_date")
    end_date_str = request.query_params.get("end_date")

    date_expr = build_calendar_date_expr(
        start_date_str,
        end_date_str,
        date_field=date_field,
    )

    if date_expr:
        query["$expr"] = date_expr

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
    async def _operation():
        return await collection.insert_one(document)

    return await db_manager.execute_with_retry(
        _operation,
        operation_name=f"insert_one on {collection.name}",
    )


async def insert_many_with_retry(
    collection: AsyncIOMotorCollection,
    documents: list[dict[str, Any]],
    *,
    ordered: bool = False,
) -> InsertManyResult:
    async def _operation():
        return await collection.insert_many(documents, ordered=ordered)

    return await db_manager.execute_with_retry(
        _operation,
        operation_name=f"insert_many on {collection.name}",
    )


async def delete_one_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: dict[str, Any],
) -> DeleteResult:
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
    """Ensure all necessary indexes exist for the entire application."""
    logger.debug("Ensuring all application indexes exist...")

    try:
        logger.debug(
            "Ensuring indexes for 'coverage_metadata' and 'streets' collections..."
        )
        await db_manager.safe_create_index(
            "coverage_metadata",
            [("location.display_name", pymongo.ASCENDING)],
            name="coverage_metadata_display_name_idx",
            unique=True,
            background=True,
        )
        await db_manager.safe_create_index(
            "coverage_metadata",
            [("status", pymongo.ASCENDING), ("last_updated", pymongo.ASCENDING)],
            name="coverage_metadata_status_updated_idx",
            background=True,
        )

        # Compound index for geospatial coverage queries
        await db_manager.safe_create_index(
            "streets",
            [("properties.location", pymongo.ASCENDING), ("geometry", "2dsphere")],
            name="streets_location_geo_idx",
            background=True,
        )

        # Additional index for status updates
        await db_manager.safe_create_index(
            "streets",
            [
                ("properties.location", pymongo.ASCENDING),
                ("properties.segment_id", pymongo.ASCENDING),
            ],
            name="streets_location_segment_id_unique_idx",
            unique=True,
            background=True,
        )

        logger.debug("Ensuring indexes for 'trips' and 'places' functionality...")
        await db_manager.safe_create_index(
            "trips",
            [("startTime", pymongo.ASCENDING)],
            name="trips_startTime_asc_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("endTime", pymongo.ASCENDING)],
            name="trips_endTime_asc_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("destinationPlaceId", pymongo.ASCENDING)],
            name="trips_destinationPlaceId_idx",
            background=True,
            sparse=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("destinationPlaceName", pymongo.ASCENDING)],
            name="trips_destinationPlaceName_idx",
            background=True,
            sparse=True,
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
                ("destinationGeoPoint", "2dsphere"),
                ("_id", 1),
            ],
            name="trips_coverage_query_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("transactionId", pymongo.ASCENDING)],
            name="trips_transactionId_idx",
            unique=True,
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("endTime", pymongo.DESCENDING)],
            name="trips_endTime_desc_idx",
            background=True,
        )

        logger.debug("Ensuring indexes for 'matched_trips' collection...")
        await db_manager.safe_create_index(
            "matched_trips",
            [("transactionId", pymongo.ASCENDING)],
            name="matched_trips_transactionId_idx",
            unique=True,
            background=True,
        )
        await db_manager.safe_create_index(
            "matched_trips",
            [("startTime", pymongo.ASCENDING)],
            name="matched_trips_startTime_asc_idx",
            background=True,
        )

        logger.info("All application indexes have been ensured/created successfully.")
    except Exception as e:
        logger.error(
            "A critical error occurred while creating application indexes: %s",
            str(e),
        )
        raise


async def ensure_location_indexes() -> None:
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
        # New GeoJSON 2dsphere index for trips
        await db_manager.safe_create_index(
            "trips",
            [("gps", pymongo.GEOSPHERE)],
            name="trips_gps_2dsphere_idx",
            background=True,
        )

        logger.info("Location structure indexes ensured/created successfully")
    except Exception as e:
        logger.error(
            "Error creating location structure indexes: %s",
            str(e),
        )


async def ensure_archived_trip_indexes() -> None:
    db = DatabaseManager()
    collection_name = "archived_live_trips"
    await db.safe_create_index(
        collection_name,
        [("gps", pymongo.GEOSPHERE)],
        name="archived_gps_2dsphere_idx",
        background=True,
    )
    await db.safe_create_index(
        collection_name,
        "transactionId",
        name="archived_transactionId_idx",
        unique=True,
        background=True,
    )
    await db.safe_create_index(
        collection_name,
        "endTime",
        name="archived_endTime_idx",
        background=True,
    )
    logger.info("Indexes ensured for '%s'.", collection_name)


async def ensure_gas_tracking_indexes() -> None:
    logger.debug("Ensuring gas tracking indexes exist...")
    try:
        await db_manager.safe_create_index(
            "gas_fillups",
            [("imei", pymongo.ASCENDING), ("fillup_time", pymongo.DESCENDING)],
            name="gas_fillups_imei_time_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "gas_fillups",
            [("fillup_time", pymongo.DESCENDING)],
            name="gas_fillups_fillup_time_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "gas_fillups",
            [("vin", pymongo.ASCENDING)],
            name="gas_fillups_vin_idx",
            background=True,
            sparse=True,
        )
        await db_manager.safe_create_index(
            "vehicles",
            [("imei", pymongo.ASCENDING)],
            name="vehicles_imei_idx",
            unique=True,
            background=True,
        )
        await db_manager.safe_create_index(
            "vehicles",
            [("vin", pymongo.ASCENDING)],
            name="vehicles_vin_idx",
            background=True,
            sparse=True,
        )
        await db_manager.safe_create_index(
            "vehicles",
            [("is_active", pymongo.ASCENDING)],
            name="vehicles_is_active_idx",
            background=True,
        )
        logger.info("Gas tracking indexes ensured/created successfully")
    except Exception as e:
        logger.error(
            "Error creating gas tracking indexes: %s",
            str(e),
        )


async def ensure_places_indexes() -> None:
    """Ensure indexes exist for places collection (custom places for visits)."""
    logger.debug("Ensuring places collection indexes exist...")
    try:
        # 2dsphere index on geometry for $geoIntersects queries in trip_processor
        await db_manager.safe_create_index(
            "places",
            [("geometry", pymongo.GEOSPHERE)],
            name="places_geometry_2dsphere_idx",
            background=True,
        )
        logger.info("Places collection indexes ensured/created successfully")
    except Exception as e:
        logger.error(
            "Error creating places indexes: %s",
            str(e),
        )


async def init_database() -> None:
    logger.info("Initializing database...")
    await init_task_history_collection()
    await ensure_street_coverage_indexes()
    await ensure_location_indexes()
    await ensure_archived_trip_indexes()
    await ensure_gas_tracking_indexes()
    await ensure_places_indexes()
    _ = db_manager.get_collection("places")
    _ = db_manager.get_collection("task_config")
    _ = db_manager.get_collection("progress_status")
    _ = db_manager.get_collection("osm_data")
    _ = db_manager.get_collection("live_trips")
    _ = db_manager.get_collection("archived_live_trips")
    _ = db_manager.get_collection("gas_fillups")
    _ = db_manager.get_collection("vehicles")
    logger.info("Database initialization complete.")
