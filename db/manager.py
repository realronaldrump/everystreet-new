"""Database connection manager module.

Provides a singleton DatabaseManager class for MongoDB connections with
robust retry logic, connection pooling, and event loop handling.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from datetime import UTC
from typing import TYPE_CHECKING, Any, TypeVar

import certifi
from gridfs import AsyncGridFSBucket
from pymongo import AsyncMongoClient
from pymongo.errors import ConnectionFailure, OperationFailure

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from pymongo.asynchronous.collection import AsyncCollection
    from pymongo.asynchronous.database import AsyncDatabase

logger = logging.getLogger(__name__)

T = TypeVar("T")


class DatabaseManager:
    """Singleton class to manage the MongoDB client, database connection, and GridFS.

    This class handles:
    - Connection pooling and lifecycle management
    - Event loop change detection and reconnection
    - Retry logic with exponential backoff
    - Thread-safe singleton pattern
    - GridFS bucket access

    Environment Variables:
        MONGO_URI: MongoDB connection URI
        MONGO_HOST: MongoDB host (fallback if MONGO_URI not set)
        MONGO_PORT: MongoDB port (fallback if MONGO_URI not set)
        MONGODB_DATABASE: Database name (default: every_street)
        MONGODB_MAX_POOL_SIZE: Connection pool size (default: 50)
        MONGODB_CONNECTION_TIMEOUT_MS: Connection timeout (default: 5000)
        MONGODB_SERVER_SELECTION_TIMEOUT_MS: Server selection timeout (default: 10000)
        MONGODB_SOCKET_TIMEOUT_MS: Socket timeout (default: 30000)
        MONGODB_MAX_RETRY_ATTEMPTS: Max retry attempts (default: 5)
    """

    _instance: DatabaseManager | None = None
    _lock = threading.Lock()

    def __new__(cls) -> DatabaseManager:
        """Create or return the singleton instance."""
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialized = False
        return cls._instance

    def __init__(self) -> None:
        """Initialize the database manager with configuration from environment."""
        if not getattr(self, "_initialized", False):
            self._client: AsyncMongoClient | None = None
            self._db: AsyncDatabase | None = None
            self._gridfs_bucket_instance: AsyncGridFSBucket | None = None
            self._bound_loop: asyncio.AbstractEventLoop | None = None
            self._connection_healthy = True
            self._beanie_initialized = False
            self._db_semaphore = asyncio.Semaphore(10)
            self._collections: dict[str, AsyncCollection] = {}
            self._initialized = True
            self._conn_retry_backoff = [1, 2, 5, 10, 30]

            # Load configuration from environment
            self._max_pool_size = int(os.getenv("MONGODB_MAX_POOL_SIZE", "50"))
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

            logger.debug(
                "Database configuration initialized with pool size %s",
                self._max_pool_size,
            )

    def _initialize_client(self) -> None:
        """Initialize the MongoDB client with proper connection settings.

        Raises:
            Exception: If client initialization fails.
        """
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

            # Configure TLS for MongoDB Atlas connections
            if mongo_uri.startswith("mongodb+srv://"):
                client_kwargs.update(
                    tls=True,
                    tlsAllowInvalidCertificates=True,
                    tlsCAFile=certifi.where(),
                )

            self._client = AsyncMongoClient(mongo_uri, **client_kwargs)
            self._db = self._client[self._db_name]
            self._connection_healthy = True
            self._collections = {}
            self._gridfs_bucket_instance = None
            logger.info("MongoDB client initialized successfully")

        except Exception as e:
            self._connection_healthy = False
            logger.error("Failed to initialize MongoDB client: %s", str(e))
            raise

    @staticmethod
    def _get_current_loop() -> asyncio.AbstractEventLoop | None:
        """Safely get the current running event loop.

        Returns:
            The current event loop or None if no loop is running.
        """
        try:
            return asyncio.get_running_loop()
        except RuntimeError:
            return None

    def _close_client_sync(self) -> None:
        """Synchronously reset client state for loop change scenarios.

        Note: With PyMongo's AsyncMongoClient, close() is async. In sync context,
        we just reset the references and let garbage collection handle cleanup.
        """
        if self._client:
            # Can't await close() in sync context - just reset references
            logger.debug("Resetting MongoDB client state due to event loop change")
            self._client = None
            self._db = None
            self._collections = {}
            self._gridfs_bucket_instance = None
            self._bound_loop = None
            self._beanie_initialized = False

    def _check_loop_and_reconnect(self) -> None:
        """Check if event loop has changed and reconnect if necessary."""
        current_loop = self._get_current_loop()

        # Check if the bound loop is closed
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

        # Check if the event loop has changed
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
    def db(self) -> AsyncDatabase:
        """Get the database instance, initializing if necessary.

        Returns:
            The AsyncDatabase instance.

        Raises:
            ConnectionFailure: If database cannot be initialized.
        """
        self._check_loop_and_reconnect()
        if self._db is None or not self._connection_healthy:
            self._initialize_client()
            self._bound_loop = self._get_current_loop()
        if self._db is None:
            raise ConnectionFailure("Database instance could not be initialized.")
        return self._db

    @property
    def client(self) -> AsyncMongoClient:
        """Get the client instance, initializing if necessary.

        Returns:
            The AsyncMongoClient instance.

        Raises:
            ConnectionFailure: If client cannot be initialized.
        """
        self._check_loop_and_reconnect()
        if self._client is None or not self._connection_healthy:
            self._initialize_client()
            self._bound_loop = self._get_current_loop()
        if self._client is None:
            raise ConnectionFailure("MongoDB client could not be initialized.")
        return self._client

    @property
    def gridfs_bucket(self) -> AsyncGridFSBucket:
        """Get the GridFS bucket instance.

        Returns:
            The AsyncGridFSBucket instance.
        """
        db_instance = self.db
        if self._gridfs_bucket_instance is None:
            self._gridfs_bucket_instance = AsyncGridFSBucket(db_instance)
        return self._gridfs_bucket_instance

    @property
    def connection_healthy(self) -> bool:
        """Check if the connection is healthy.

        Returns:
            True if connection is healthy, False otherwise.
        """
        return self._connection_healthy

    @property
    def max_retry_attempts(self) -> int:
        """Get the maximum number of retry attempts.

        Returns:
            Maximum retry attempts configuration value.
        """
        return self._max_retry_attempts

    def get_collection(self, collection_name: str) -> AsyncCollection:
        """Get a collection by name with caching.

        Args:
            collection_name: Name of the collection.

        Returns:
            The AsyncCollection instance.
        """
        if collection_name not in self._collections or not self._connection_healthy:
            self._collections[collection_name] = self.db[collection_name]
        return self._collections[collection_name]

    def ensure_connection(self) -> None:
        """Ensure the database connection is initialized."""
        if not self._connection_healthy:
            self._initialize_client()

    async def execute_with_retry(
        self,
        operation: Callable[[], Awaitable[T]],
        max_attempts: int | None = None,
        operation_name: str = "database operation",
    ) -> T:
        """Execute a database operation with retry logic.

        Uses exponential backoff for retries on connection failures and
        transient errors.

        Args:
            operation: Async callable to execute.
            max_attempts: Maximum retry attempts (defaults to config value).
            operation_name: Name of operation for logging.

        Returns:
            The result of the operation.

        Raises:
            ConnectionFailure: If all retry attempts fail.
            OperationFailure: For non-transient operation failures.
            RuntimeError: If all retries exhausted.
        """
        if max_attempts is None:
            max_attempts = self._max_retry_attempts

        attempts = 0

        while attempts < max_attempts:
            attempts += 1
            retry_delay = self._conn_retry_backoff[
                min(attempts - 1, len(self._conn_retry_backoff) - 1)
            ]

            try:
                async with self._db_semaphore:
                    # Ensure connection is active
                    _ = self.client
                    _ = self.db
                    if not self._connection_healthy:
                        self._initialize_client()

                    return await operation()

            except ConnectionFailure as e:
                self._connection_healthy = False
                logger.warning(
                    "Attempt %d/%d for %s failed due to connection error: %s. "
                    "Retrying in %ds...",
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
                        f"Failed to connect after {max_attempts} attempts "
                        f"for {operation_name}"
                    ) from e

                await asyncio.sleep(retry_delay)

            except OperationFailure as e:
                is_transient = e.has_error_label(
                    "TransientTransactionError"
                ) or e.code in [11600, 11602]

                if is_transient and attempts < max_attempts:
                    logger.warning(
                        "Attempt %d/%d for %s failed with transient OperationFailure "
                        "(Code: %s): %s. Retrying in %ds...",
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
            f"All {max_attempts} retry attempts failed for {operation_name}"
        )

    async def safe_create_index(
        self,
        collection_name: str,
        keys: str | list[tuple[str, int]],
        **kwargs: Any,
    ) -> str | None:
        """Safely create an index, handling conflicts and duplicates.

        Args:
            collection_name: Name of the collection.
            keys: Index keys specification.
            **kwargs: Additional index options (name, unique, background, etc.).

        Returns:
            Index name if created or already exists, None on conflict.
        """
        from pymongo.errors import DuplicateKeyError

        try:
            collection = self.get_collection(collection_name)
            existing_indexes = await collection.index_information()
            keys_tuple = tuple(
                sorted(list(keys) if isinstance(keys, list) else [(keys, 1)])
            )

            # Check if index with same keys already exists
            for idx_name, idx_info in existing_indexes.items():
                if idx_name == "_id_":
                    continue

                idx_keys = tuple(sorted(idx_info.get("key", [])))
                if idx_keys == keys_tuple:
                    logger.debug(
                        "Index with keys %s already exists as '%s' on %s, "
                        "skipping creation",
                        keys_tuple,
                        idx_name,
                        collection_name,
                    )
                    return idx_name

            # Check if index with same name exists
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
            return self._get_existing_index_name(collection_name, keys)

        except OperationFailure as e:
            return await self._handle_index_operation_failure(
                e, collection_name, keys, kwargs
            )

    async def _handle_index_operation_failure(
        self,
        error: OperationFailure,
        collection_name: str,
        keys: str | list[tuple[str, int]],
        kwargs: dict[str, Any],
    ) -> str | None:
        """Handle OperationFailure during index creation.

        Args:
            error: The OperationFailure exception.
            collection_name: Name of the collection.
            keys: Index keys specification.
            kwargs: Index options.

        Returns:
            Index name if recreated successfully, None otherwise.

        Raises:
            OperationFailure: For unhandled operation failures.
        """
        collection = self.get_collection(collection_name)

        if error.code == 85:  # IndexOptionsConflict
            index_name_to_create = kwargs.get("name")
            if index_name_to_create and index_name_to_create in str(
                (error.details or {}).get("errmsg", "")
            ):
                logger.warning(
                    "IndexOptionsConflict for index '%s' on collection '%s'. "
                    "Attempting to drop and recreate. Error: %s",
                    index_name_to_create,
                    collection_name,
                    str(error),
                )
                try:
                    await collection.drop_index(index_name_to_create)
                    logger.info(
                        "Successfully dropped conflicting index '%s' on '%s'. "
                        "Retrying creation.",
                        index_name_to_create,
                        collection_name,
                    )

                    async def _create_index() -> str:
                        return await collection.create_index(keys, **kwargs)

                    result = await self.execute_with_retry(
                        _create_index,
                        operation_name=(
                            f"index recreation on {collection_name} after conflict"
                        ),
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
                        "Failed to drop and recreate index '%s' on '%s' "
                        "after IndexOptionsConflict: %s",
                        index_name_to_create,
                        collection_name,
                        str(drop_recreate_e),
                    )
                    return None
            else:
                logger.warning(
                    "IndexOptionsConflict on %s (but not a simple name/options "
                    "mismatch or name not specified): %s",
                    collection_name,
                    str(error),
                )
                return None

        elif error.code in (86, 68):  # Index key specs or name conflict
            logger.warning(
                "Index conflict (key specs or name already exists and "
                "options match): %s",
                str(error),
            )
            return None

        else:
            logger.error("Error creating index: %s", str(error))
            raise

    def _get_existing_index_name(
        self,
        _collection_name: str,
        _keys: str | list[tuple[str, int]],
    ) -> str | None:
        """Get the name of an existing index with matching keys.

        Args:
            collection_name: Name of the collection.
            keys: Index keys specification.

        Returns:
            Index name if found, None otherwise.
        """
        # This is a sync helper, should be called after DuplicateKeyError
        # The actual lookup needs to be async but we return None as a fallback
        return None

    async def init_beanie(self) -> None:
        """Initialize Beanie ODM with all document models.

        This should be called once during application startup.
        """
        if self._beanie_initialized:
            logger.debug("Beanie already initialized, skipping")
            return

        from beanie import init_beanie

        from db.models import ALL_DOCUMENT_MODELS

        await init_beanie(database=self.db, document_models=ALL_DOCUMENT_MODELS)
        self._beanie_initialized = True
        logger.info(
            "Beanie ODM initialized with %d document models",
            len(ALL_DOCUMENT_MODELS),
        )

    async def cleanup_connections(self) -> None:
        """Clean up MongoDB client connections."""
        if self._client:
            try:
                logger.info("Closing MongoDB client connections...")
                await self._client.close()
            except Exception as e:
                logger.error("Error closing MongoDB client: %s", str(e))
            finally:
                self._client = None
                self._db = None
                self._collections = {}
                self._gridfs_bucket_instance = None
                self._connection_healthy = False
                self._beanie_initialized = False
                logger.info("MongoDB client state reset")

    def __del__(self) -> None:
        """Destructor to reset client references.

        Note: With PyMongo's AsyncMongoClient, close() is async.
        In __del__, we cannot await, so we just reset references.
        """
        if hasattr(self, "_client") and self._client:
            # Cannot await close() in __del__ - just reset references
            self._client = None
            self._db = None
            self._collections = {}
            self._gridfs_bucket_instance = None


# Singleton instance
db_manager = DatabaseManager()
