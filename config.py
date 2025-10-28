"""Centralized configuration for environment variables and external APIs.

This module is the single source of truth for configuration used across the
application. Import constants from here rather than calling os.getenv directly
in multiple places.
"""

from __future__ import annotations

import os
from typing import Final, List

from dotenv import load_dotenv

# Load environment variables from .env if present
load_dotenv()


# --- Bouncie API Configuration ---
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


__all__ = [
    "CLIENT_ID",
    "CLIENT_SECRET",
    "REDIRECT_URI",
    "AUTHORIZATION_CODE",
    "AUTH_URL",
    "API_BASE_URL",
    "AUTHORIZED_DEVICES",
    "MAPBOX_ACCESS_TOKEN",
]
