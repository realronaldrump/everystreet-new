"""
Database connection manager module.

Provides a singleton DatabaseManager class for MongoDB connections with robust retry
logic, connection pooling, and event loop handling.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from datetime import UTC
from typing import Any, Self

import certifi
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

logger = logging.getLogger(__name__)

class DatabaseManager:
    """
    Singleton class to manage the MongoDB client and database connection.

    This class handles:
    - Connection pooling and lifecycle management
    - Event loop change detection and reconnection
    - Retry logic with exponential backoff
    - Thread-safe singleton pattern
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

    def __new__(cls) -> Self:
        """Create or return the singleton instance."""
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialized = False
        return cls._instance

    def __init__(self) -> None:
        """Initialize the database manager with configuration from environment."""
        if not getattr(self, "_initialized", False):
            self._client: AsyncIOMotorClient | None = None
            self._db: AsyncIOMotorDatabase | None = None
            self._bound_loop: asyncio.AbstractEventLoop | None = None
            self._connection_healthy = True
            self._beanie_initialized = False
            self._initialized = True
            self._conn_retry_backoff = [1, 2, 5, 10, 30]

            # Load configuration from environment
            self._max_pool_size = int(os.getenv("MONGODB_MAX_POOL_SIZE", "50"))
            self._connection_timeout_ms = int(
                os.getenv("MONGODB_CONNECTION_TIMEOUT_MS", "5000"),
            )
            self._server_selection_timeout_ms = int(
                os.getenv("MONGODB_SERVER_SELECTION_TIMEOUT_MS", "10000"),
            )
            self._socket_timeout_ms = int(
                os.getenv("MONGODB_SOCKET_TIMEOUT_MS", "30000"),
            )
            self._max_retry_attempts = int(os.getenv("MONGODB_MAX_RETRY_ATTEMPTS", "5"))
            self._db_name = os.getenv("MONGODB_DATABASE", "every_street")

            logger.debug(
                "Database configuration initialized with pool size %s",
                self._max_pool_size,
            )

    def _initialize_client(self) -> None:
        """
        Initialize the MongoDB client with proper connection settings.

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

            self._client = AsyncIOMotorClient(mongo_uri, **client_kwargs)
            self._db = self._client[self._db_name]
            self._connection_healthy = True
            logger.info("MongoDB client initialized successfully")

        except Exception as e:
            self._connection_healthy = False
            logger.exception("Failed to initialize MongoDB client: %s", str(e))
            raise

    @staticmethod
    def _get_current_loop() -> asyncio.AbstractEventLoop | None:
        """
        Safely get the current running event loop.

        Returns:
            The current event loop or None if no loop is running.
        """
        try:
            return asyncio.get_running_loop()
        except RuntimeError:
            return None

    def _close_client_sync(self) -> None:
        """
        Synchronously reset client state for loop change scenarios.

        Note: Motor clients are safe to close synchronously; we just reset references.
        """
        self._client = None
        self._db = None
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
    def db(self) -> AsyncIOMotorDatabase:
        """
        Get the database instance, initializing if necessary.

        Returns:
            The AsyncIOMotorDatabase instance.

        Raises:
            RuntimeError: If database cannot be initialized.
        """
        self._check_loop_and_reconnect()
        if self._db is None or not self._connection_healthy:
            self._initialize_client()
            self._bound_loop = self._get_current_loop()
        if self._db is None:
            msg = "Database instance could not be initialized."
            raise RuntimeError(msg)
        return self._db

    @property
    def client(self) -> AsyncIOMotorClient:
        """
        Get the client instance, initializing if necessary.

        Returns:
            The AsyncIOMotorClient instance.

        Raises:
            RuntimeError: If client cannot be initialized.
        """
        self._check_loop_and_reconnect()
        if self._client is None or not self._connection_healthy:
            self._initialize_client()
            self._bound_loop = self._get_current_loop()
        if self._client is None:
            msg = "MongoDB client could not be initialized."
            raise RuntimeError(msg)
        return self._client

    @property
    def connection_healthy(self) -> bool:
        """
        Check if the connection is healthy.

        Returns:
            True if connection is healthy, False otherwise.
        """
        return self._connection_healthy

    @property
    def max_retry_attempts(self) -> int:
        """
        Get the maximum number of retry attempts.

        Returns:
            Maximum retry attempts configuration value.
        """
        return self._max_retry_attempts

    async def init_beanie(self) -> None:
        """
        Initialize Beanie ODM with all document models.

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
                self._client.close()
            except Exception as e:
                logger.exception("Error closing MongoDB client: %s", str(e))
            finally:
                self._client = None
                self._db = None
                self._connection_healthy = False
                self._beanie_initialized = False
                logger.info("MongoDB client state reset")

    def __del__(self) -> None:
        """
        Destructor to reset client references.

        Note: We cannot await in __del__, so we just reset references.
        """
        if hasattr(self, "_client") and self._client:
            # Cannot await close() in __del__ - just reset references
            self._client = None
            self._db = None


# Singleton instance
db_manager = DatabaseManager()
