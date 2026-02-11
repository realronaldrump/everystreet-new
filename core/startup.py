"""Shared runtime startup/shutdown utilities for app and worker processes."""

from __future__ import annotations

import logging

from core.http.session import cleanup_session
from db import db_manager
from db.logging_handler import MongoDBHandler


async def initialize_shared_runtime(
    *,
    logger: logging.Logger | None = None,
    handler_level: int = logging.INFO,
    handler_formatter: logging.Formatter | None = None,
) -> MongoDBHandler:
    """Initialize shared DB/config/logging runtime dependencies."""
    await db_manager.init_beanie()
    if logger is not None:
        logger.info("Beanie ODM initialized successfully.")

    from core.service_config import get_service_config

    await get_service_config()

    handler = MongoDBHandler()
    await handler.setup_indexes()
    handler.setLevel(handler_level)
    if handler_formatter is not None:
        handler.setFormatter(handler_formatter)

    logging.getLogger().addHandler(handler)
    return handler


def detach_mongo_handler(handler: MongoDBHandler | None) -> None:
    """Detach and close the MongoDB logging handler if present."""
    if handler is None:
        return

    root_logger = logging.getLogger()
    root_logger.removeHandler(handler)
    handler.close()


async def shutdown_shared_runtime(
    *,
    mongo_handler: MongoDBHandler | None = None,
    close_http_session: bool = True,
) -> None:
    """Clean up shared runtime resources."""
    detach_mongo_handler(mongo_handler)
    if close_http_session:
        await cleanup_session()
    await db_manager.cleanup_connections()
