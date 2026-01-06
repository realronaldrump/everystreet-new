"""Centralized configuration for environment variables and external APIs.

This module is the single source of truth for configuration used across the
application. Bouncie credentials are stored in MongoDB and configured via
the profile page - no environment variables needed for Bouncie.
"""

from __future__ import annotations

import os
from typing import Any, Final

from dotenv import load_dotenv

# Load environment variables from .env if present (for Mapbox, etc.)
load_dotenv()


# --- Bouncie API Endpoints (constants, not credentials) ---
AUTH_URL: Final[str] = "https://auth.bouncie.com/oauth/token"
API_BASE_URL: Final[str] = "https://api.bouncie.dev/v1"


# --- Mapbox & Analytics Configuration ---
MAPBOX_ACCESS_TOKEN: Final[str] = os.getenv("MAPBOX_ACCESS_TOKEN", "")
CLARITY_PROJECT_ID: Final[str | None] = os.getenv("CLARITY_PROJECT_ID") or None


async def get_bouncie_config() -> dict[str, Any]:
    """Get Bouncie API configuration from database.

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


__all__ = [
    "AUTH_URL",
    "API_BASE_URL",
    "MAPBOX_ACCESS_TOKEN",
    "CLARITY_PROJECT_ID",
    "get_bouncie_config",
]
