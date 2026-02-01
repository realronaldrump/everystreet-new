"""
Centralized configuration for network APIs.

This module is the single source of truth for configuration used across
the application. Sensitive tokens are sourced from environment variables
(or a secrets manager) and are never stored in user-editable settings or
the database.
"""

from __future__ import annotations

import logging
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
VALHALLA_MAX_SHAPE_POINTS_ENV_VAR: Final[str] = "VALHALLA_MAX_SHAPE_POINTS"

NOMINATIM_BASE_URL_ENV_VAR: Final[str] = "NOMINATIM_BASE_URL"
NOMINATIM_SEARCH_URL_ENV_VAR: Final[str] = "NOMINATIM_SEARCH_URL"
NOMINATIM_REVERSE_URL_ENV_VAR: Final[str] = "NOMINATIM_REVERSE_URL"
NOMINATIM_USER_AGENT_ENV_VAR: Final[str] = "NOMINATIM_USER_AGENT"
OSM_DATA_PATH_ENV_VAR: Final[str] = "OSM_DATA_PATH"
GEOFABRIK_MIRROR_ENV_VAR: Final[str] = "GEOFABRIK_MIRROR"
OSM_EXTRACTS_PATH_ENV_VAR: Final[str] = "OSM_EXTRACTS_PATH"

# Default URLs for Docker internal networking
DEFAULT_NOMINATIM_URL: Final[str] = "http://nominatim:8080"
DEFAULT_VALHALLA_URL: Final[str] = "http://valhalla:8002"
DEFAULT_VALHALLA_MAX_SHAPE_POINTS: Final[int] = 100
DEFAULT_NOMINATIM_USER_AGENT: Final[str] = "Every Street/1.0"
DEFAULT_GEOFABRIK_MIRROR: Final[str] = "https://download.geofabrik.de"
DEFAULT_OSM_EXTRACTS_PATH: Final[str] = "/osm"

logger = logging.getLogger(__name__)

_DEPRECATED_SERVICE_ENV_VARS: Final[tuple[str, ...]] = (
    VALHALLA_BASE_URL_ENV_VAR,
    VALHALLA_STATUS_URL_ENV_VAR,
    VALHALLA_ROUTE_URL_ENV_VAR,
    VALHALLA_TRACE_ROUTE_URL_ENV_VAR,
    VALHALLA_TRACE_ATTRIBUTES_URL_ENV_VAR,
    NOMINATIM_BASE_URL_ENV_VAR,
    NOMINATIM_SEARCH_URL_ENV_VAR,
    NOMINATIM_REVERSE_URL_ENV_VAR,
)
_deprecated_env_warned = False


def _warn_deprecated_service_env_vars() -> None:
    global _deprecated_env_warned
    if _deprecated_env_warned:
        return
    configured = [
        env_name for env_name in _DEPRECATED_SERVICE_ENV_VARS if os.getenv(env_name)
    ]
    if configured:
        logger.warning(
            "Deprecated geo service env vars are ignored: %s. "
            "Using internal Docker DNS endpoints instead.",
            ", ".join(configured),
        )
    _deprecated_env_warned = True


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
    _warn_deprecated_service_env_vars()
    return DEFAULT_VALHALLA_URL


def get_valhalla_status_url() -> str:
    _warn_deprecated_service_env_vars()
    return f"{DEFAULT_VALHALLA_URL}/status"


def get_valhalla_route_url() -> str:
    _warn_deprecated_service_env_vars()
    return f"{DEFAULT_VALHALLA_URL}/route"


def get_valhalla_trace_route_url() -> str:
    _warn_deprecated_service_env_vars()
    return f"{DEFAULT_VALHALLA_URL}/trace_route"


def get_valhalla_trace_attributes_url() -> str:
    _warn_deprecated_service_env_vars()
    return f"{DEFAULT_VALHALLA_URL}/trace_attributes"


def get_valhalla_max_shape_points() -> int:
    raw_value = os.getenv(VALHALLA_MAX_SHAPE_POINTS_ENV_VAR, "").strip()
    if raw_value:
        try:
            parsed = int(raw_value)
            if parsed >= 2:
                return parsed
        except ValueError:
            logger.warning(
                "Invalid VALHALLA_MAX_SHAPE_POINTS value: %s. Using default %d.",
                raw_value,
                DEFAULT_VALHALLA_MAX_SHAPE_POINTS,
            )
    return DEFAULT_VALHALLA_MAX_SHAPE_POINTS


def require_valhalla_base_url() -> str:
    return get_valhalla_base_url()


def require_valhalla_status_url() -> str:
    return get_valhalla_status_url()


def require_valhalla_route_url() -> str:
    return get_valhalla_route_url()


def require_valhalla_trace_route_url() -> str:
    return get_valhalla_trace_route_url()


def require_valhalla_trace_attributes_url() -> str:
    return get_valhalla_trace_attributes_url()


def get_nominatim_base_url() -> str:
    _warn_deprecated_service_env_vars()
    return DEFAULT_NOMINATIM_URL


def get_nominatim_search_url() -> str:
    _warn_deprecated_service_env_vars()
    return f"{DEFAULT_NOMINATIM_URL}/search"


def get_nominatim_reverse_url() -> str:
    _warn_deprecated_service_env_vars()
    return f"{DEFAULT_NOMINATIM_URL}/reverse"


def get_nominatim_user_agent() -> str:
    return os.getenv(NOMINATIM_USER_AGENT_ENV_VAR, DEFAULT_NOMINATIM_USER_AGENT).strip()


def get_osm_data_path() -> str:
    return os.getenv(OSM_DATA_PATH_ENV_VAR, "").strip()


def get_geofabrik_mirror() -> str:
    """Get the Geofabrik mirror URL for downloading OSM extracts."""
    return os.getenv(GEOFABRIK_MIRROR_ENV_VAR, DEFAULT_GEOFABRIK_MIRROR).strip()


def get_osm_extracts_path() -> str:
    """Get the path to the OSM extracts directory (inside container)."""
    return os.getenv(OSM_EXTRACTS_PATH_ENV_VAR, DEFAULT_OSM_EXTRACTS_PATH).strip()


def require_nominatim_base_url() -> str:
    return get_nominatim_base_url()


def require_nominatim_search_url() -> str:
    return get_nominatim_search_url()


def require_nominatim_reverse_url() -> str:
    return get_nominatim_reverse_url()


def require_nominatim_user_agent() -> str:
    return get_nominatim_user_agent()


def require_osm_data_path() -> str:
    return _require_env_var(
        OSM_DATA_PATH_ENV_VAR,
        "Expected local OSM extract path used by Valhalla/Nominatim "
        "(e.g. /data/osm/region.osm or /data/osm/region.pbf).",
    )


async def get_bouncie_config() -> dict[str, Any]:
    """
    Get Bouncie API configuration from database.

    This is a single-user app. All Bouncie credentials are stored in MongoDB
    and configured via the Settings page. No environment variable fallbacks.

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
    from setup.services.bouncie_credentials import get_bouncie_credentials

    return await get_bouncie_credentials()


__all__ = [
    "API_BASE_URL",
    "AUTH_URL",
    "get_bouncie_config",
    "get_geofabrik_mirror",
    "get_mapbox_token",
    "get_nominatim_base_url",
    "get_nominatim_reverse_url",
    "get_nominatim_search_url",
    "get_nominatim_user_agent",
    "get_osm_data_path",
    "get_osm_extracts_path",
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
    "require_osm_data_path",
    "require_valhalla_base_url",
    "require_valhalla_route_url",
    "require_valhalla_status_url",
    "require_valhalla_trace_attributes_url",
    "require_valhalla_trace_route_url",
    "validate_mapbox_token",
]
