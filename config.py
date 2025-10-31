"""Centralized configuration for environment variables and external APIs.

This module is the single source of truth for configuration used across the
application. Import constants from here rather than calling os.getenv directly
in multiple places.

NOTE: Bouncie credentials can now be managed via the profile page and are
stored in MongoDB. Use get_bouncie_config() for runtime credential access.
"""

from __future__ import annotations

import os
from typing import Any, Final

from dotenv import load_dotenv

# Load environment variables from .env if present
load_dotenv()


# --- Bouncie API Configuration ---
# These are fallback values from environment variables
# For runtime access, use get_bouncie_config() which reads from database
CLIENT_ID: Final[str | None] = os.getenv("CLIENT_ID")
CLIENT_SECRET: Final[str | None] = os.getenv("CLIENT_SECRET")
REDIRECT_URI: Final[str | None] = os.getenv("REDIRECT_URI")
AUTHORIZATION_CODE: Final[str | None] = os.getenv("AUTHORIZATION_CODE")

# Bouncie API Endpoints
AUTH_URL: Final[str] = "https://auth.bouncie.com/oauth/token"
API_BASE_URL: Final[str] = "https://api.bouncie.dev/v1"

# Authorized devices (IMEIs) allowed to fetch trips for
AUTHORIZED_DEVICES: Final[list[str]] = [
    d for d in os.getenv("AUTHORIZED_DEVICES", "").split(",") if d
]


# --- Mapbox Configuration ---
MAPBOX_ACCESS_TOKEN: Final[str] = os.getenv("MAPBOX_ACCESS_TOKEN", "")


async def get_bouncie_config() -> dict[str, Any]:
    """Get Bouncie API configuration from database or environment variables.
    
    This function retrieves Bouncie credentials from MongoDB if available,
    otherwise falls back to environment variables.
    
    Returns:
        Dictionary containing:
            - client_id: str
            - client_secret: str
            - redirect_uri: str
            - authorization_code: str
            - authorized_devices: list[str]
    """
    try:
        from bouncie_credentials import get_bouncie_credentials
        return await get_bouncie_credentials()
    except Exception:
        # Fallback to module-level constants
        return {
            "client_id": CLIENT_ID or "",
            "client_secret": CLIENT_SECRET or "",
            "redirect_uri": REDIRECT_URI or "",
            "authorization_code": AUTHORIZATION_CODE or "",
            "authorized_devices": AUTHORIZED_DEVICES,
        }


__all__ = [
    "CLIENT_ID",
    "CLIENT_SECRET",
    "REDIRECT_URI",
    "AUTHORIZATION_CODE",
    "AUTH_URL",
    "API_BASE_URL",
    "AUTHORIZED_DEVICES",
    "MAPBOX_ACCESS_TOKEN",
    "get_bouncie_config",
]
