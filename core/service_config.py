"""
Service configuration loader.

Provides async functions to load user-specific configuration from the
database.
"""

from __future__ import annotations

import logging
import os
import time
from typing import TYPE_CHECKING

from core.settings_snapshot import (
    PUBLISHED_SETTING_NAMES,
    clear_user_settings,
    publish_user_settings,
)

if TYPE_CHECKING:
    from db.models import AppSettings

logger = logging.getLogger(__name__)

# Settings are cached per process. The cache is short-lived rather than
# permanent so a change saved by the web process reaches the worker
# without a restart -- the two processes cannot invalidate each other.
DEFAULT_CACHE_TTL_SECONDS = 30.0

_settings_cache: AppSettings | None = None
_cached_at: float = 0.0


def _cache_ttl_seconds() -> float:
    raw = os.getenv("SETTINGS_CACHE_TTL_SECONDS", "").strip()
    if not raw:
        return DEFAULT_CACHE_TTL_SECONDS
    try:
        return max(0.0, float(raw))
    except ValueError:
        return DEFAULT_CACHE_TTL_SECONDS


def _cache_is_fresh() -> bool:
    if _settings_cache is None:
        return False
    return (time.monotonic() - _cached_at) < _cache_ttl_seconds()


def _publish(settings: AppSettings) -> None:
    values = {
        name: getattr(settings, name, None) for name in PUBLISHED_SETTING_NAMES
    }
    publish_user_settings(values)


async def get_service_config(*, force_refresh: bool = False) -> AppSettings:
    """
    Get service configuration from the database.

    Returns the AppSettings document, cached for a short interval so that
    frequent callers do not hit MongoDB on every read while still picking
    up changes saved by another process.
    """
    global _settings_cache, _cached_at

    if not force_refresh and _cache_is_fresh() and _settings_cache is not None:
        return _settings_cache

    from db.models import AppSettings

    settings = await AppSettings.find_one()
    if settings is None:
        settings = AppSettings()
        await settings.insert()
        logger.info("Created default AppSettings document")

    _settings_cache = settings
    _cached_at = time.monotonic()
    _publish(settings)
    return settings


async def refresh_service_config() -> AppSettings:
    """Force a reload, e.g. at the start of a background job."""
    return await get_service_config(force_refresh=True)


def clear_config_cache() -> None:
    """
    Invalidate the settings cache so the next read refetches.

    Called after a settings update so the writing process sees its own
    change immediately. Other processes pick it up within the cache TTL.

    The published snapshot is deliberately left in place: synchronous
    readers cannot trigger a refetch, so keeping the last known values is
    better than dropping them back to built-in defaults mid-request.
    """
    global _settings_cache, _cached_at
    _settings_cache = None
    _cached_at = 0.0


def reset_service_config_state() -> None:
    """Drop both the cache and the published snapshot (test teardown)."""
    clear_config_cache()
    clear_user_settings()
