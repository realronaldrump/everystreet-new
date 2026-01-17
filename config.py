"""
Centralized configuration for external APIs.

This module is the single source of truth for configuration used across
the application. Sensitive tokens are sourced from environment variables
(or a secrets manager) and are never stored in user-editable settings or
the database.
"""

from __future__ import annotations

import os
from typing import Any, Final

# --- Bouncie API Endpoints (constants, not credentials) ---
AUTH_URL: Final[str] = "https://auth.bouncie.com/oauth/token"
API_BASE_URL: Final[str] = "https://api.bouncie.dev/v1"
MAPBOX_TOKEN_ENV_VAR: Final[str] = "MAPBOX_TOKEN"
MAPBOX_TOKEN_MIN_LENGTH: Final[int] = 20

VALHALLA_BASE_URL_ENV_VAR: Final[str] = "VALHALLA_BASE_URL"
VALHALLA_STATUS_URL_ENV_VAR: Final[str] = "VALHALLA_STATUS_URL"
VALHALLA_ROUTE_URL_ENV_VAR: Final[str] = "VALHALLA_ROUTE_URL"
VALHALLA_TRACE_ROUTE_URL_ENV_VAR: Final[str] = "VALHALLA_TRACE_ROUTE_URL"
VALHALLA_TRACE_ATTRIBUTES_URL_ENV_VAR: Final[str] = "VALHALLA_TRACE_ATTRIBUTES_URL"

NOMINATIM_BASE_URL_ENV_VAR: Final[str] = "NOMINATIM_BASE_URL"
NOMINATIM_SEARCH_URL_ENV_VAR: Final[str] = "NOMINATIM_SEARCH_URL"
NOMINATIM_REVERSE_URL_ENV_VAR: Final[str] = "NOMINATIM_REVERSE_URL"
NOMINATIM_USER_AGENT_ENV_VAR: Final[str] = "NOMINATIM_USER_AGENT"


def get_mapbox_token() -> str:
    """
    Get the Mapbox access token from environment variables.

    This does not validate the token. Call require_mapbox_token() when a
    structurally valid public token is required.
    """
    return os.getenv(MAPBOX_TOKEN_ENV_VAR, "").strip()


def validate_mapbox_token(token: str) -> None:
    """Validate that the Mapbox token looks like a public token."""
    if not token:
        msg = "MAPBOX_TOKEN is not set. Configure it in the environment before startup."
        raise RuntimeError(
            msg,
        )
    if not token.startswith("pk."):
        msg = (
            "MAPBOX_TOKEN must be a public token starting with 'pk.' because it is "
            "exposed to the client."
        )
        raise RuntimeError(
            msg,
        )
    if len(token) < MAPBOX_TOKEN_MIN_LENGTH:
        msg = "MAPBOX_TOKEN looks too short to be valid. Check the configured value."
        raise RuntimeError(
            msg,
        )


def require_mapbox_token() -> str:
    """Return a validated Mapbox token or raise a RuntimeError."""
    token = get_mapbox_token()
    validate_mapbox_token(token)
    return token


def _require_env_var(env_name: str, description: str) -> str:
    value = os.getenv(env_name, "").strip()
    if not value:
        msg = (
            f"{env_name} is not set. Configure it in the environment before "
            f"startup. {description}"
        )
        raise RuntimeError(
            msg,
        )
    return value


def get_valhalla_base_url() -> str:
    return os.getenv(VALHALLA_BASE_URL_ENV_VAR, "").strip()


def get_valhalla_status_url() -> str:
    return os.getenv(VALHALLA_STATUS_URL_ENV_VAR, "").strip()


def get_valhalla_route_url() -> str:
    return os.getenv(VALHALLA_ROUTE_URL_ENV_VAR, "").strip()


def get_valhalla_trace_route_url() -> str:
    return os.getenv(VALHALLA_TRACE_ROUTE_URL_ENV_VAR, "").strip()


def get_valhalla_trace_attributes_url() -> str:
    return os.getenv(VALHALLA_TRACE_ATTRIBUTES_URL_ENV_VAR, "").strip()


def require_valhalla_base_url() -> str:
    return _require_env_var(
        VALHALLA_BASE_URL_ENV_VAR,
        "Expected Valhalla US9 base URL (e.g. http://100.108.79.105:8004).",
    )


def require_valhalla_status_url() -> str:
    return _require_env_var(
        VALHALLA_STATUS_URL_ENV_VAR,
        "Expected Valhalla /status URL (e.g. http://100.108.79.105:8004/status).",
    )


def require_valhalla_route_url() -> str:
    return _require_env_var(
        VALHALLA_ROUTE_URL_ENV_VAR,
        "Expected Valhalla /route URL (e.g. http://100.108.79.105:8004/route).",
    )


def require_valhalla_trace_route_url() -> str:
    return _require_env_var(
        VALHALLA_TRACE_ROUTE_URL_ENV_VAR,
        "Expected Valhalla /trace_route URL (e.g. http://100.108.79.105:8004/trace_route).",
    )


def require_valhalla_trace_attributes_url() -> str:
    return _require_env_var(
        VALHALLA_TRACE_ATTRIBUTES_URL_ENV_VAR,
        "Expected Valhalla /trace_attributes URL (e.g. http://100.108.79.105:8004/trace_attributes).",
    )


def get_nominatim_base_url() -> str:
    return os.getenv(NOMINATIM_BASE_URL_ENV_VAR, "").strip()


def get_nominatim_search_url() -> str:
    return os.getenv(NOMINATIM_SEARCH_URL_ENV_VAR, "").strip()


def get_nominatim_reverse_url() -> str:
    return os.getenv(NOMINATIM_REVERSE_URL_ENV_VAR, "").strip()


def get_nominatim_user_agent() -> str:
    return os.getenv(NOMINATIM_USER_AGENT_ENV_VAR, "").strip()


def require_nominatim_base_url() -> str:
    return _require_env_var(
        NOMINATIM_BASE_URL_ENV_VAR,
        "Expected Nominatim base URL (e.g. http://100.108.79.105:7070).",
    )


def require_nominatim_search_url() -> str:
    return _require_env_var(
        NOMINATIM_SEARCH_URL_ENV_VAR,
        "Expected Nominatim /search URL (e.g. http://100.108.79.105:7070/search).",
    )


def require_nominatim_reverse_url() -> str:
    return _require_env_var(
        NOMINATIM_REVERSE_URL_ENV_VAR,
        "Expected Nominatim /reverse URL (e.g. http://100.108.79.105:7070/reverse).",
    )


def require_nominatim_user_agent() -> str:
    return _require_env_var(
        NOMINATIM_USER_AGENT_ENV_VAR,
        "Expected a Nominatim User-Agent string (EveryStreet/1.0 ...).",
    )


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
    "get_nominatim_base_url",
    "get_nominatim_reverse_url",
    "get_nominatim_search_url",
    "get_nominatim_user_agent",
    "get_valhalla_base_url",
    "get_valhalla_route_url",
    "get_valhalla_status_url",
    "get_valhalla_trace_attributes_url",
    "get_valhalla_trace_route_url",
    "require_mapbox_token",
    "require_nominatim_base_url",
    "require_nominatim_reverse_url",
    "require_nominatim_search_url",
    "require_nominatim_user_agent",
    "require_valhalla_base_url",
    "require_valhalla_route_url",
    "require_valhalla_status_url",
    "require_valhalla_trace_attributes_url",
    "require_valhalla_trace_route_url",
    "validate_mapbox_token",
]
