"""
MongoDB Logging Handler for storing application logs in MongoDB.

This allows viewing server logs remotely through the web interface.
"""

import contextlib
import logging
from datetime import datetime
from typing import Any


class MongoDBHandler(logging.Handler):
    """Custom logging handler that writes log records to MongoDB."""

    def __init__(self, db_manager, collection_name: str = "server_logs"):
        """
        Initialize the MongoDB logging handler.

        Args:
            db_manager: The DatabaseManager instance
            collection_name: Name of the collection to store logs in
        """
        super().__init__()
        self._db_manager = db_manager
        self._collection_name = collection_name
        self._setup_complete = False

    def _get_collection(self):
        """Get fresh collection reference using current event loop's db connection."""
        return self._db_manager.db[self._collection_name]

    async def setup_indexes(self):
        """Create indexes for the logs collection."""
        if self._setup_complete:
            return

        try:
            collection = self._get_collection()
            # Create index on timestamp for efficient querying
            await collection.create_index([("timestamp", -1)])
            # Create index on level for filtering
            await collection.create_index("level")
            # TTL index to auto-delete logs older than 30 days
            await collection.create_index(
                "timestamp", expireAfterSeconds=30 * 24 * 60 * 60
            )
            self._setup_complete = True
        except Exception as e:
            # Don't fail if index creation fails
            print(f"Warning: Could not create log indexes: {e}")

    def emit(self, record: logging.LogRecord) -> None:
        """
        Emit a log record to MongoDB.

        Args:
            record: The log record to store
        """
        try:
            # Format the log record
            log_entry = self._format_log_entry(record)

            # We need to use asyncio to insert into MongoDB
            # Since emit() is synchronous, we'll use a background task
            import asyncio

            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # If event loop is running, schedule the coroutine
                    asyncio.create_task(self._async_emit(log_entry))
                else:
                    # If no event loop, create one
                    loop.run_until_complete(self._async_emit(log_entry))
            except RuntimeError:
                # If we can't get an event loop, try creating a new one
                asyncio.run(self._async_emit(log_entry))

        except Exception:
            # Don't fail the application if logging fails
            self.handleError(record)

    async def _async_emit(self, log_entry: dict[str, Any]) -> None:
        """
        Asynchronously insert log entry into MongoDB.

        Args:
            log_entry: The formatted log entry to insert
        """
        with contextlib.suppress(Exception):
            collection = self._get_collection()
            await collection.insert_one(log_entry)

    def _format_log_entry(self, record: logging.LogRecord) -> dict[str, Any]:
        """
        Format a log record into a dictionary for MongoDB storage.

        Args:
            record: The log record to format

        Returns:
            Dictionary containing formatted log data
        """
        log_entry = {
            "timestamp": datetime.utcnow(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
            "process": record.process,
            "thread": record.thread,
        }

        # Add exception info if present
        if record.exc_info:
            log_entry["exception"] = self.format(record)

        # Add extra fields if present
        if hasattr(record, "extra"):
            log_entry["extra"] = record.extra

        return log_entry
