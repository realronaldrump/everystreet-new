"""
Centralized configuration for external APIs.

This module is the single source of truth for configuration used across the
application. All API tokens and credentials are stored in MongoDB and
configured via the profile page - no environment variables needed.
"""

from __future__ import annotations

from typing import Any, Final

# --- Bouncie API Endpoints (constants, not credentials) ---
AUTH_URL: Final[str] = "https://auth.bouncie.com/oauth/token"
API_BASE_URL: Final[str] = "https://api.bouncie.dev/v1"


def get_mapbox_token() -> str:
    """
    Get Mapbox access token from cached settings.

    This provides sync access to the token for module-level usage. The cache is
    populated at app startup via ensure_settings_cached().
    """
    from app_settings import get_cached_mapbox_token

    return get_cached_mapbox_token()


def get_clarity_id() -> str | None:
    """
    Get Clarity project ID from cached settings.

    This provides sync access to the ID for module-level usage. The cache is populated
    at app startup via ensure_settings_cached().
    """
    from app_settings import get_cached_clarity_id

    return get_cached_clarity_id()


async def get_bouncie_config() -> dict[str, Any]:
    """
    Get Bouncie API configuration from database.

    This is a single-user app. All Bouncie credentials are stored in MongoDB
    and configured via the profile page. No environment variable fallbacks.

    Returns:
        Dictionary containing:
            - client_id: str
            - client_secret: str
            - redirect_uri: str
            - authorization_code: str
            - authorized_devices: list[str]
            - fetch_concurrency: int (defaults to 12)
            - access_token: str | None
            - expires_at: float | None (timestamp)
    """
    from bouncie_credentials import get_bouncie_credentials

    return await get_bouncie_credentials()


async def get_app_settings() -> dict[str, Any]:
    """
    Get app settings from database.

    Returns:
        Dictionary containing:
            - mapbox_access_token: str
            - clarity_project_id: str | None
    """
    from app_settings import get_app_settings as _get_app_settings

    return await _get_app_settings()


__all__ = [
    "API_BASE_URL",
    "AUTH_URL",
    "get_app_settings",
    "get_bouncie_config",
    "get_clarity_id",
    "get_mapbox_token",
]
