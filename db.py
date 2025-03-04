# db.py

from __future__ import annotations  # 1) Handle forward references cleanly

import os
import certifi
import logging
import asyncio
import threading
import time
from datetime import timezone
from typing import (
    Optional,
    Any,
    Dict,
    Tuple,
    Callable,
    TypeVar,
    Awaitable,
    ClassVar,
)

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
import pymongo
from pymongo.errors import (
    ConnectionFailure,
    ServerSelectionTimeoutError,
    NetworkTimeout,
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
    """
    Singleton class to manage the MongoDB client and database connection.
    Provides helper methods for checking quota and safely creating indexes.
    """

    _instance: ClassVar[DatabaseManager | None] = None
    _client: AsyncIOMotorClient | None = None
    _db: AsyncIOMotorDatabase | None = None
    _quota_exceeded: bool = False
    _lock = threading.Lock()
    _db_semaphore: asyncio.Semaphore | None = None
    _last_connection_check: float = 0.0
    _connection_healthy: bool = True
    _max_concurrent_operations: int = 10
    _connection_check_interval: int = 60  # seconds

    # Connection pooling and retry configuration
    _max_pool_size: int = 5
    _min_pool_size: int = 0
    _max_idle_time_ms: int = 5000
    _connect_timeout_ms: int = 5000
    _server_selection_timeout_ms: int = 10000
    _socket_timeout_ms: int = 30000
    _retry_writes: bool = True
    _retry_reads: bool = True
    _max_retry_attempts: int = 3
    _retry_delay_ms: int = 500

    def __new__(cls) -> DatabaseManager:
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self) -> None:
        # IMPORTANT:  DO NOT initialize the client here.  Delay it.
        if self._client is None:
            self._db_semaphore = asyncio.Semaphore(self._max_concurrent_operations)

    def _initialize_client(self) -> None:
        """Initialize the MongoDB client and database connection with proper pooling."""
        try:
            mongo_uri: str = os.getenv("MONGO_URI") or ""
            if not mongo_uri:
                raise ValueError("MONGO_URI environment variable not set")

            self._client = AsyncIOMotorClient(
                mongo_uri,
                tls=True,
                tlsAllowInvalidCertificates=True,
                tlsCAFile=certifi.where(),
                tz_aware=True,
                tzinfo=timezone.utc,
                maxPoolSize=self._max_pool_size,
                minPoolSize=self._min_pool_size,
                maxIdleTimeMS=self._max_idle_time_ms,
                connectTimeoutMS=self._connect_timeout_ms,
                serverSelectionTimeoutMS=self._server_selection_timeout_ms,
                socketTimeoutMS=self._socket_timeout_ms,
                retryWrites=self._retry_writes,
                retryReads=self._retry_reads,
                waitQueueTimeoutMS=10000,  # 10s to wait for a connection from the pool
                appname="EveryStreet",
            )
            self._db = self._client["every_street"]
            self._connection_healthy = True
            self._last_connection_check = time.time()
            # Use % formatting for logging as per instructions
            logger.info(
                "MongoDB client initialized successfully with %s", "connection pooling."
            )
        except Exception as e:
            self._connection_healthy = False
            # Use % formatting for logging as per instructions
            logger.error("Failed to initialize MongoDB client: %s", e, exc_info=True)
            raise

    @property
    def db(self) -> AsyncIOMotorDatabase:
        # Initialize the client ONLY when .db is accessed for the first time.
        if self._db is None:
            self._initialize_client()  # This now happens lazily
        if self._db is None:
            raise RuntimeError("Database not initialized.")
        return self._db

    @property
    def client(self) -> AsyncIOMotorClient:
        # Initialize on first access to .client as well
        if self._client is None:
            self._initialize_client()
        if self._client is None:
            raise RuntimeError("Client not initialized.")
        return self._client

    @property
    def quota_exceeded(self) -> bool:
        return self._quota_exceeded

    async def check_connection_health(self) -> bool:
        """
        Check the health of the MongoDB connection.
        Returns True if connection is healthy, False otherwise.
        """
        now = time.time()

        # Only check periodically to avoid too many pings
        if (
            now - self._last_connection_check < self._connection_check_interval
            and self._connection_healthy
        ):
            return self._connection_healthy

        try:
            # Ping the database to check connection
            await self._db.command("ping")
            self._connection_healthy = True
        except (ConnectionFailure, ServerSelectionTimeoutError) as e:
            logger.error("Database connection health check failed: %s", e)
            self._connection_healthy = False
            # Try to reinitialize the client
            try:
                self._initialize_client()
                logger.info(
                    "Successfully reinitialized MongoDB client "
                    "after connection failure"
                )
                self._connection_healthy = True
            except Exception as reinit_error:
                logger.error("Failed to reinitialize MongoDB client: %s", reinit_error)

        self._last_connection_check = now
        return self._connection_healthy

    async def execute_with_retry(
        self,
        operation: Callable[[], Awaitable[T]],
        max_attempts: int | None = None,
        operation_name: str = "database operation",
    ) -> T:
        """
        Execute a database operation with retry logic in case of connection failures.
        """
        if max_attempts is None:
            max_attempts = self._max_retry_attempts

        attempts = 0
        last_error: Exception | None = None
        retry_delay = self._retry_delay_ms / 1000.0  # convert ms to seconds

        while attempts < max_attempts:
            attempts += 1
            try:
                if not self._client or not self._connection_healthy:
                    # Re-initialize client if needed
                    self._initialize_client()

                # Execute the operation
                return await operation()

            except (
                ConnectionFailure,
                ServerSelectionTimeoutError,
                NetworkTimeout,
            ) as e:
                last_error = e
                # Wrapped logger call
                logger.warning(
                    "Attempt %d/%d for %s failed with connection error: %s",
                    attempts,
                    max_attempts,
                    operation_name,
                    str(e),
                )
                self._connection_healthy = False
                if attempts < max_attempts:
                    await asyncio.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff

            except OSError as e:
                # Handle memory allocation errors specifically
                if "Cannot allocate memory" in str(e):
                    logger.warning(
                        "Memory allocation error during %s: %s. "
                        "Attempting to recover...",
                        operation_name,
                        str(e),
                    )
                    recovery_successful = await self.handle_memory_error()

                    if recovery_successful and attempts < max_attempts:
                        continue
                    last_error = e
                else:
                    last_error = e
                    logger.warning("OS error during %s: %s", operation_name, str(e))

                if attempts < max_attempts:
                    await asyncio.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff

            except Exception as e:
                last_error = e
                logger.warning(
                    "Attempt %d/%d for %s failed with error: %s",
                    attempts,
                    max_attempts,
                    operation_name,
                    str(e),
                )
                if attempts < max_attempts:
                    await asyncio.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff

        # If we exit the loop, all retries failed
        if last_error:
            raise last_error
        raise RuntimeError(f"Unknown error executing {operation_name}")

    async def check_quota(self) -> Tuple[Optional[float], Optional[float]]:
        """
        Check if the database quota is exceeded with retry logic.

        Returns:
            Tuple of (used_mb, limit_mb). Returns (None, None) on error.
        """
        try:

            async def _do_check_quota():
                stats = await self.db.command("dbStats")
                data_size = stats.get("dataSize")
                if data_size is None:
                    logger.error("dbStats did not return 'dataSize'")
                    return None, None
                used_mb = data_size / (1024 * 1024)
                limit_mb = 512  # Free-tier limit
                self._quota_exceeded = used_mb > limit_mb
                if self._quota_exceeded:
                    # Wrapped logger
                    logger.warning(
                        "MongoDB quota exceeded: using %.2f MB of %d MB",
                        used_mb,
                        limit_mb,
                    )
                return used_mb, limit_mb

            return await self.execute_with_retry(
                _do_check_quota, operation_name="quota check"
            )
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
        Uses retry logic for transient errors. If the index already exists with
        a different name, logs a warning and continues.
        """
        if self._quota_exceeded:
            logger.warning(
                "Skipping index creation for %s due to quota exceeded",
                collection_name,
            )
            return

        try:

            async def _do_create_index():
                return await self.db[collection_name].create_index(keys, **kwargs)

            await self.execute_with_retry(
                _do_create_index, operation_name=f"index creation on {collection_name}"
            )

            logger.info("Index created on %s with keys %s", collection_name, keys)
        except OperationFailure as e:
            # Check for the specific error code for IndexOptionsConflict (85)
            if e.code == 85:
                logger.warning(
                    "Index on %s with keys %s already exists with a different name. "
                    "Skipping creation.",
                    collection_name,
                    keys,
                )
            elif "you are over your space quota" in str(e).lower():
                self._quota_exceeded = True
                logger.warning(
                    "Cannot create index on %s due to quota exceeded", collection_name
                )
            else:
                logger.error(
                    "Error creating index on %s: %s", collection_name, e, exc_info=True
                )
        except Exception as e:
            logger.error(
                "Error creating index on %s: %s", collection_name, e, exc_info=True
            )

    async def get_collection_stats(
        self, collection_name: str
    ) -> Optional[Dict[str, Any]]:
        """
        Get statistics for a collection with retry logic.

        Args:
            collection_name: Name of the collection

        Returns:
            Dictionary of collection statistics or None on error.
        """
        try:

            async def _do_get_stats():
                return await self.db.command("collStats", collection_name)

            return await self.execute_with_retry(
                _do_get_stats,
                operation_name=f"get stats for {collection_name}",
            )
        except Exception as e:
            logger.error(
                "Error getting stats for collection %s: %s", collection_name, e
            )
            return None

    async def cleanup_connections(self) -> None:
        """
        Close all connections in the pool to release resources.
        Call this during application shutdown.
        """
        if self._client:
            try:
                logger.info("Closing MongoDB client connections...")
                self._client.close()
                self._client = None  # Avoid reuse after closing
                logger.info("MongoDB client connections closed successfully")
            except Exception as e:
                logger.error("Error closing MongoDB connections: %s", e, exc_info=True)

    def __del__(self) -> None:
        """
        Destructor to ensure connections are closed when the manager is
        garbage collected.
        """
        if self._client and asyncio.get_event_loop().is_running():
            try:
                asyncio.create_task(self.cleanup_connections())
            except Exception as e:
                # Just log; we're in a destructor
                logger.error("Error in DatabaseManager destructor: %s", e)

    async def handle_memory_error(self) -> bool:
        """
        Handle memory allocation errors by:
          1. Forcing garbage collection
          2. Closing the existing client
          3. Reducing connection pool size temporarily
          4. Reinitializing the client

        Returns:
            bool: True if recovery was successful, False otherwise.
        """
        import gc
        import psutil

        # Use % formatting for logging
        logger.warning("Attempting to recover from memory allocation error...")

        # Get current memory usage for logging
        process = psutil.Process()
        memory_info = process.memory_info()
        memory_percent = process.memory_percent()

        logger.warning(
            "Current memory usage: %s MB (%.2f%% of system memory)",
            memory_info.rss / (1024 * 1024),
            memory_percent,
        )

        original_pool_size = self._max_pool_size
        self._connection_healthy = False

        # Close existing connections
        if self._client:
            try:
                self._client.close()
                self._client = None
                self._db = None
            except Exception as e:
                # Use % formatting for logging
                logger.error(
                    "Error closing client during memory error recovery: %s",
                    e,
                )

        # Force garbage collection
        gc.collect()
        # Give the system time to reclaim memory
        await asyncio.sleep(2)  # Increased from 1 to 2 seconds

        # Reduce pool size temporarily
        self._max_pool_size = max(1, self._max_pool_size // 2)
        # Reduce idle time to close connections more quickly
        self._max_idle_time_ms = max(1000, self._max_idle_time_ms // 2)

        # Log memory after GC but before reinitializing
        memory_info = process.memory_info()
        memory_percent = process.memory_percent()
        logger.info(
            "Memory after GC: %s MB (%.2f%% of system memory)",
            memory_info.rss / (1024 * 1024),
            memory_percent,
        )

        # Attempt to reinitialize with smaller pool
        try:
            self._initialize_client()
            self._connection_healthy = True
            logger.info(
                "Successfully recovered from memory error with reduced "
                "pool size (%d -> %d)",
                original_pool_size,
                self._max_pool_size,
            )
            return True
        except Exception as e:
            logger.error("Failed to reinitialize client after memory error: %s", str(e))
            return False


# Corrected instantiation:
db_manager = DatabaseManager()  # Instantiate the singleton, but don't connect yet
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


async def init_task_history_collection() -> None:
    """
    Initialize indexes for the task history collection concurrently.
    """
    try:
        tasks = [
            db_manager.safe_create_index(
                "task_history", [("task_id", pymongo.ASCENDING)]
            ),
            db_manager.safe_create_index("task_history", [("timestamp", -1)]),
            db_manager.safe_create_index(
                "task_history",
                [("task_id", pymongo.ASCENDING), ("timestamp", -1)],
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
            db_manager.safe_create_index(
                "coverage_metadata",
                [
                    ("location.display_name", pymongo.ASCENDING),
                    ("status", pymongo.ASCENDING),
                ],
                unique=True,
            ),
            db_manager.safe_create_index(
                "streets", [("properties.location", pymongo.ASCENDING)]
            ),
            db_manager.safe_create_index(
                "streets", [("properties.segment_id", pymongo.ASCENDING)]
            ),
            db_manager.safe_create_index("trips", [("gps", pymongo.ASCENDING)]),
            db_manager.safe_create_index("trips", [("startTime", pymongo.ASCENDING)]),
            db_manager.safe_create_index("trips", [("endTime", pymongo.ASCENDING)]),
            db_manager.safe_create_index(
                "trips",
                [("startTime", pymongo.ASCENDING), ("endTime", pymongo.ASCENDING)],
                name="trips_date_range",
            ),
            db_manager.safe_create_index(
                "matched_trips",
                [("startTime", pymongo.ASCENDING), ("endTime", pymongo.ASCENDING)],
                name="matched_trips_date_range",
            ),
        ]
        await asyncio.gather(*tasks)
        logger.info("Street coverage indexes created successfully")
    except Exception as e:
        logger.error("Error creating street coverage indexes: %s", e, exc_info=True)
        raise


# Utility functions for database operations with retry
async def find_one_with_retry(collection, query, projection=None):
    """
    Execute find_one with retry logic.
    """

    async def _operation():
        return await collection.find_one(query, projection)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"find_one on {collection.name}"
    )


async def find_with_retry(
    collection, query, projection=None, sort=None, limit=None, skip=None
):
    """
    Execute find with retry logic and return a list.
    """

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


async def update_one_with_retry(
    collection,
    filter_query,  # Renamed from 'filter' to avoid PYL-W0622
    update,
    upsert=False,
):
    """
    Execute update_one with retry logic.
    """

    async def _operation():
        return await collection.update_one(filter_query, update, upsert=upsert)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"update_one on {collection.name}"
    )


async def aggregate_with_retry(collection, pipeline):
    """
    Execute aggregate with retry logic.
    """

    async def _operation():
        return await collection.aggregate(pipeline).to_list(None)

    return await db_manager.execute_with_retry(
        _operation, operation_name=f"aggregate on {collection.name}"
    )
