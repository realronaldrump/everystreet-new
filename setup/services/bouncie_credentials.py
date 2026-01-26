"""
Bouncie credentials management.

This module handles storage and retrieval of Bouncie API credentials
using Beanie ODM.
"""

from __future__ import annotations

import logging
from typing import Any

from db import BouncieCredentials

logger = logging.getLogger(__name__)


async def get_bouncie_credentials() -> dict[str, Any]:
    """
    Retrieve Bouncie credentials from database.

    This is a single-user app. All credentials are stored in MongoDB and
    configured via Settings. No environment variable fallbacks.

    Returns:
        Dictionary containing:
            - client_id: str
            - client_secret: str
            - redirect_uri: str
            - authorization_code: str
            - webhook_key: str
            - authorized_devices: list[str]
            - fetch_concurrency: int (defaults to 12)
            - access_token: str | None
            - refresh_token: str | None
            - expires_at: float | None (timestamp)
    """
    default_credentials = {
        "client_id": "",
        "client_secret": "",
        "redirect_uri": "",
        "authorization_code": "",
        "oauth_state": None,
        "oauth_state_expires_at": None,
        "last_auth_error": None,
        "last_auth_error_detail": None,
        "last_auth_error_at": None,
        "webhook_key": "",
        "authorized_devices": [],
        "fetch_concurrency": 12,
        "access_token": None,
        "refresh_token": None,
        "expires_at": None,
    }

    try:
        credentials = await BouncieCredentials.find_one(
            BouncieCredentials.id == "bouncie_credentials",
        )
    except Exception:
        logger.exception("Error retrieving Bouncie credentials")
        return default_credentials

    if credentials:
        logger.debug("Retrieved Bouncie credentials from database")

        fetch_concurrency = credentials.fetch_concurrency or 12

        return {
            "client_id": credentials.client_id or "",
            "client_secret": credentials.client_secret or "",
            "redirect_uri": credentials.redirect_uri or "",
            "authorization_code": credentials.authorization_code or "",
            "oauth_state": credentials.oauth_state,
            "oauth_state_expires_at": credentials.oauth_state_expires_at,
            "last_auth_error": credentials.last_auth_error,
            "last_auth_error_detail": credentials.last_auth_error_detail,
            "last_auth_error_at": credentials.last_auth_error_at,
            "webhook_key": credentials.webhook_key or "",
            "authorized_devices": credentials.authorized_devices or [],
            "fetch_concurrency": fetch_concurrency,
            "access_token": credentials.access_token,
            "refresh_token": credentials.refresh_token,
            "expires_at": credentials.expires_at,
        }

    logger.warning(
        "No Bouncie credentials found in database. Please configure via Settings.",
    )
    return default_credentials


async def update_bouncie_credentials(credentials: dict[str, Any]) -> bool:
    """
    Update Bouncie credentials in database.

    Args:
        credentials: Dictionary containing credential fields to update.
            Only fields present in this dict will be updated.
            Can include: client_id, client_secret, redirect_uri,
            authorization_code, authorized_devices (list or comma-separated string),
            fetch_concurrency (int, optional), access_token, refresh_token, expires_at,
            webhook_key, last_auth_error, last_auth_error_detail, last_auth_error_at

    Returns:
        True if update was successful, False otherwise.
    """
    created = False

    try:
        existing = await BouncieCredentials.find_one(
            BouncieCredentials.id == "bouncie_credentials",
        )

        if existing:
            for key, value in credentials.items():
                if key == "client_id":
                    existing.client_id = value
                elif key == "client_secret":
                    existing.client_secret = value
                elif key == "redirect_uri":
                    existing.redirect_uri = value
                elif key == "authorization_code":
                    existing.authorization_code = value
                elif key == "oauth_state":
                    existing.oauth_state = value
                elif key == "oauth_state_expires_at":
                    existing.oauth_state_expires_at = value
                elif key == "last_auth_error":
                    existing.last_auth_error = value
                elif key == "last_auth_error_detail":
                    existing.last_auth_error_detail = value
                elif key == "last_auth_error_at":
                    existing.last_auth_error_at = value
                elif key == "webhook_key":
                    if value is None:
                        continue
                    webhook_key = str(value).strip()
                    existing.webhook_key = webhook_key or None
                elif key == "authorized_devices":
                    if value is None:
                        continue
                    devices = value
                    if isinstance(devices, str):
                        devices = [d.strip() for d in devices.split(",") if d.strip()]
                    elif not isinstance(devices, list):
                        devices = []
                    existing.authorized_devices = devices
                elif key == "access_token":
                    existing.access_token = value
                elif key == "refresh_token":
                    existing.refresh_token = value
                elif key == "expires_at":
                    existing.expires_at = value

            await existing.save()
        else:
            new_creds = BouncieCredentials(id="bouncie_credentials")

            if "client_id" in credentials:
                new_creds.client_id = credentials["client_id"]
            if "client_secret" in credentials:
                new_creds.client_secret = credentials["client_secret"]
            if "redirect_uri" in credentials:
                new_creds.redirect_uri = credentials["redirect_uri"]
            if "authorization_code" in credentials:
                new_creds.authorization_code = credentials["authorization_code"]
            if "oauth_state" in credentials:
                new_creds.oauth_state = credentials["oauth_state"]
            if "oauth_state_expires_at" in credentials:
                new_creds.oauth_state_expires_at = credentials["oauth_state_expires_at"]
            if "last_auth_error" in credentials:
                new_creds.last_auth_error = credentials["last_auth_error"]
            if "last_auth_error_detail" in credentials:
                new_creds.last_auth_error_detail = credentials["last_auth_error_detail"]
            if "last_auth_error_at" in credentials:
                new_creds.last_auth_error_at = credentials["last_auth_error_at"]
            if "webhook_key" in credentials and credentials["webhook_key"] is not None:
                webhook_key = str(credentials["webhook_key"]).strip()
                new_creds.webhook_key = webhook_key or None
            if "authorized_devices" in credentials:
                devices = credentials["authorized_devices"]
                if devices is None:
                    devices = []
                if isinstance(devices, str):
                    devices = [d.strip() for d in devices.split(",") if d.strip()]
                elif not isinstance(devices, list):
                    devices = []
                new_creds.authorized_devices = devices
            new_creds.fetch_concurrency = 12

            if "access_token" in credentials:
                new_creds.access_token = credentials["access_token"]
            if "refresh_token" in credentials:
                new_creds.refresh_token = credentials["refresh_token"]
            if "expires_at" in credentials:
                new_creds.expires_at = credentials["expires_at"]

            await new_creds.insert()
            created = True

    except Exception:
        logger.exception("Error updating Bouncie credentials")
        return False
    else:
        if created:
            logger.info("Successfully created Bouncie credentials in database")
        else:
            logger.info("Successfully updated Bouncie credentials in database")
        return True


async def validate_bouncie_credentials(credentials: dict[str, Any]) -> tuple[bool, str]:
    """
    Validate that required Bouncie credentials are present.

    Args:
        credentials: Dictionary of credentials to validate

    Returns:
        Tuple of (is_valid, error_message)
    """
    required_fields = [
        "client_id",
        "client_secret",
        "redirect_uri",
    ]

    for field in required_fields:
        if not credentials.get(field):
            return False, f"Missing required field: {field}"

    return True, ""


class BouncieCredentialsService:
    """Service wrapper for Bouncie credential operations."""

    @staticmethod
    async def get_bouncie_credentials() -> dict[str, Any]:
        return await get_bouncie_credentials()

    @staticmethod
    async def update_bouncie_credentials(credentials: dict[str, Any]) -> bool:
        return await update_bouncie_credentials(credentials)

    @staticmethod
    async def validate_bouncie_credentials(
        credentials: dict[str, Any],
    ) -> tuple[bool, str]:
        return await validate_bouncie_credentials(credentials)


__all__ = [
    "BouncieCredentialsService",
    "get_bouncie_credentials",
    "update_bouncie_credentials",
    "validate_bouncie_credentials",
]
