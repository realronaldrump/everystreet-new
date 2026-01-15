"""
Centralized configuration for external APIs.

This module is the single source of truth for configuration used across the
application. Sensitive tokens are sourced from environment variables (or a
secrets manager) and are never stored in user-editable settings or the database.
"""

from __future__ import annotations

import os
from typing import Any, Final

# --- Bouncie API Endpoints (constants, not credentials) ---
AUTH_URL: Final[str] = "https://auth.bouncie.com/oauth/token"
API_BASE_URL: Final[str] = "https://api.bouncie.dev/v1"
MAPBOX_TOKEN_ENV_VAR: Final[str] = "MAPBOX_TOKEN"
MAPBOX_TOKEN_MIN_LENGTH: Final[int] = 20


def get_mapbox_token() -> str:
    """
    Get the Mapbox access token from environment variables.

    This does not validate the token. Call require_mapbox_token() when
    a structurally valid public token is required.
    """
    return os.getenv(MAPBOX_TOKEN_ENV_VAR, "").strip()


def validate_mapbox_token(token: str) -> None:
    """Validate that the Mapbox token is present and looks like a public token."""
    if not token:
        raise RuntimeError(
            "MAPBOX_TOKEN is not set. Configure it in the environment before startup.",
        )
    if not token.startswith("pk."):
        raise RuntimeError(
            "MAPBOX_TOKEN must be a public token starting with 'pk.' because it is "
            "exposed to the client.",
        )
    if len(token) < MAPBOX_TOKEN_MIN_LENGTH:
        raise RuntimeError(
            "MAPBOX_TOKEN looks too short to be valid. Check the configured value.",
        )


def require_mapbox_token() -> str:
    """Return a validated Mapbox token or raise a RuntimeError."""
    token = get_mapbox_token()
    validate_mapbox_token(token)
    return token


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


__all__ = [
    "API_BASE_URL",
    "AUTH_URL",
    "get_bouncie_config",
    "get_mapbox_token",
    "require_mapbox_token",
    "validate_mapbox_token",
]
