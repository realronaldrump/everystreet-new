import contextlib
import logging
from datetime import datetime
from typing import Any

from db.models import ServerLog


class MongoDBHandler(logging.Handler):
    """Custom logging handler that writes log records to MongoDB via Beanie."""

    def __init__(self):
        """Initialize the MongoDB logging handler."""
        super().__init__()
        self._pending_tasks = set()

    async def setup_indexes(self):
        """No-op as Beanie handles index creation at model level."""

    def emit(self, record: logging.LogRecord) -> None:
        """
        Emit a log record to MongoDB.

        Args:
            record: The log record to store
        """
        try:
            # Format the log record
            log_entry = self._format_log_entry(record)

            import asyncio

            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None

            if loop and loop.is_running():
                if loop.is_closed():
                    return
                task = loop.create_task(self._async_emit(log_entry))
                self._pending_tasks.add(task)
                task.add_done_callback(self._pending_tasks.discard)
            else:
                asyncio.run(self._async_emit(log_entry))

        except Exception:
            # Don't fail the application if logging fails
            self.handleError(record)

    async def _async_emit(self, log_entry: dict[str, Any]) -> None:
        """Asynchronously insert log entry via Beanie."""
        with contextlib.suppress(Exception):
            log_doc = ServerLog(**log_entry)
            await log_doc.insert()

    def close(self) -> None:
        """Cancel any pending log insert tasks."""
        for task in list(self._pending_tasks):
            task.cancel()
        self._pending_tasks.clear()
        super().close()

    def _format_log_entry(self, record: logging.LogRecord) -> dict[str, Any]:
        """Format log record for Beanie ServerLog model."""
        log_entry = {
            "timestamp": datetime.utcnow(),
            "level": record.levelname,
            "logger_name": record.name,
            "message": record.getMessage(),
            "pathname": record.pathname,
            "lineno": record.lineno,
            "funcName": record.funcName,
        }

        # Add exception info if present
        if record.exc_info:
            log_entry["exc_info"] = self.format(record)

        return log_entry
