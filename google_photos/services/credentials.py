"""Google Photos credentials persistence helpers."""

from __future__ import annotations

import logging
from typing import Any

from db.models import GooglePhotosCredentials

logger = logging.getLogger(__name__)


def _default_credentials() -> dict[str, Any]:
    return {
        "client_id": "",
        "client_secret": "",
        "redirect_uri": "",
        "access_token": None,
        "refresh_token": None,
        "expires_at": None,
        "oauth_state": None,
        "oauth_state_expires_at": None,
        "granted_scopes": [],
        "postcard_export_enabled": False,
        "last_auth_error": None,
        "last_auth_error_detail": None,
        "last_auth_error_at": None,
    }


async def get_google_photos_credentials() -> dict[str, Any]:
    """Get Google Photos credentials document as a mutable dictionary."""
    try:
        doc = await GooglePhotosCredentials.find_one(
            GooglePhotosCredentials.id == "google_photos_credentials",
        )
        if doc is None:
            doc = await GooglePhotosCredentials.find_one()
            if doc is not None:
                logger.warning(
                    "Google Photos credentials found without expected id; using fallback document",
                )
    except Exception:
        logger.exception("Error retrieving Google Photos credentials")
        return _default_credentials()

    if doc is None:
        return _default_credentials()

    return {
        "client_id": doc.client_id or "",
        "client_secret": doc.client_secret or "",
        "redirect_uri": doc.redirect_uri or "",
        "access_token": doc.access_token,
        "refresh_token": doc.refresh_token,
        "expires_at": doc.expires_at,
        "oauth_state": doc.oauth_state,
        "oauth_state_expires_at": doc.oauth_state_expires_at,
        "granted_scopes": list(doc.granted_scopes or []),
        "postcard_export_enabled": bool(doc.postcard_export_enabled),
        "last_auth_error": doc.last_auth_error,
        "last_auth_error_detail": doc.last_auth_error_detail,
        "last_auth_error_at": doc.last_auth_error_at,
    }


async def update_google_photos_credentials(payload: dict[str, Any]) -> bool:
    """Patch Google Photos credentials document fields."""
    try:
        doc = await GooglePhotosCredentials.find_one(
            GooglePhotosCredentials.id == "google_photos_credentials",
        )
        if doc is None:
            doc = await GooglePhotosCredentials.find_one()
            if doc is None:
                doc = GooglePhotosCredentials(id="google_photos_credentials")

        for key, value in payload.items():
            if key == "client_id":
                doc.client_id = value
            elif key == "client_secret":
                doc.client_secret = value
            elif key == "redirect_uri":
                doc.redirect_uri = value
            elif key == "access_token":
                doc.access_token = value
            elif key == "refresh_token":
                doc.refresh_token = value
            elif key == "expires_at":
                doc.expires_at = value
            elif key == "oauth_state":
                doc.oauth_state = value
            elif key == "oauth_state_expires_at":
                doc.oauth_state_expires_at = value
            elif key == "granted_scopes":
                if value is None:
                    doc.granted_scopes = []
                elif isinstance(value, str):
                    doc.granted_scopes = [v for v in value.split() if v]
                elif isinstance(value, list):
                    doc.granted_scopes = [str(v) for v in value if str(v).strip()]
            elif key == "postcard_export_enabled":
                doc.postcard_export_enabled = bool(value)
            elif key == "last_auth_error":
                doc.last_auth_error = value
            elif key == "last_auth_error_detail":
                doc.last_auth_error_detail = value
            elif key == "last_auth_error_at":
                doc.last_auth_error_at = value

        if doc.id != "google_photos_credentials":
            doc.id = "google_photos_credentials"
        if doc.id:
            await doc.save()
        else:
            await doc.insert()
    except Exception:
        logger.exception("Failed to update Google Photos credentials")
        return False
    return True


__all__ = [
    "get_google_photos_credentials",
    "update_google_photos_credentials",
]

