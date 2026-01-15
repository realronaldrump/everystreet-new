"""
Remove legacy mapbox_access_token fields from app_settings documents.

This script is safe to run multiple times.
"""

from __future__ import annotations

import asyncio
import logging

from db import db_manager
from db.models import AppSettings

logger = logging.getLogger(__name__)


async def run() -> None:
    """Unset mapbox_access_token from all AppSettings documents."""
    await db_manager.init_beanie()
    result = await AppSettings.find_all().update(
        {"$unset": {"mapbox_access_token": ""}},
    )
    modified = result.modified_count if result else 0
    logger.info(
        "Removed mapbox_access_token from %d app_settings document(s).",
        modified,
    )
    await db_manager.cleanup_connections()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    asyncio.run(run())
