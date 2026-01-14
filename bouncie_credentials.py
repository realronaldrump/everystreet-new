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
    configured via profile page. No environment variable fallbacks.

    Returns:
        Dictionary containing:
            - client_id: str
            - client_secret: str
            - redirect_uri: str
            - authorization_code: str
            - authorized_devices: list[str]
            - fetch_concurrency: int (defaults to 12)
            - access_token: str | None
            - refresh_token: str | None
            - expires_at: float | None (timestamp)
    """
    try:
        credentials = await BouncieCredentials.find_one(
            BouncieCredentials.id == "bouncie_credentials",
        )

        if credentials:
            logger.debug("Retrieved Bouncie credentials from database")

            fetch_concurrency = credentials.fetch_concurrency or 12

            return {
                "client_id": credentials.client_id or "",
                "client_secret": credentials.client_secret or "",
                "redirect_uri": credentials.redirect_uri or "",
                "authorization_code": credentials.authorization_code or "",
                "authorized_devices": credentials.authorized_devices or [],
                "fetch_concurrency": fetch_concurrency,
                "access_token": credentials.access_token,
                "refresh_token": credentials.refresh_token,
                "expires_at": credentials.expires_at,
            }

        logger.warning(
            "No Bouncie credentials found in database. "
            "Please configure via profile page.",
        )
        return {
            "client_id": "",
            "client_secret": "",
            "redirect_uri": "",
            "authorization_code": "",
            "authorized_devices": [],
            "fetch_concurrency": 12,
            "access_token": None,
            "refresh_token": None,
            "expires_at": None,
        }
    except Exception as e:
        logger.exception("Error retrieving Bouncie credentials: %s", e)
        return {
            "client_id": "",
            "client_secret": "",
            "redirect_uri": "",
            "authorization_code": "",
            "authorized_devices": [],
            "fetch_concurrency": 12,
            "access_token": None,
            "refresh_token": None,
            "expires_at": None,
        }


async def update_bouncie_credentials(credentials: dict[str, Any]) -> bool:
    """
    Update Bouncie credentials in database.

    Args:
        credentials: Dictionary containing credential fields to update.
            Only fields present in this dict will be updated.
            Can include: client_id, client_secret, redirect_uri,
            authorization_code, authorized_devices (list or comma-separated string),
            fetch_concurrency (int, optional), access_token, refresh_token, expires_at

    Returns:
        True if update was successful, False otherwise.
    """
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
                elif key == "authorized_devices":
                    devices = value
                    if isinstance(devices, str):
                        devices = [d.strip() for d in devices.split(",") if d.strip()]
                    elif not isinstance(devices, list):
                        devices = []
                    existing.authorized_devices = devices
                elif key == "fetch_concurrency":
                    try:
                        fetch_concurrency = int(value)
                        if fetch_concurrency < 1:
                            fetch_concurrency = 1
                        elif fetch_concurrency > 50:
                            fetch_concurrency = 50
                        existing.fetch_concurrency = fetch_concurrency
                    except (ValueError, TypeError):
                        pass
                elif key == "access_token":
                    existing.access_token = value
                elif key == "refresh_token":
                    existing.refresh_token = value
                elif key == "expires_at":
                    existing.expires_at = value

            await existing.save()
            logger.info("Successfully updated Bouncie credentials in database")
            return True
        new_creds = BouncieCredentials(id="bouncie_credentials")

        if "client_id" in credentials:
            new_creds.client_id = credentials["client_id"]
        if "client_secret" in credentials:
            new_creds.client_secret = credentials["client_secret"]
        if "redirect_uri" in credentials:
            new_creds.redirect_uri = credentials["redirect_uri"]
        if "authorization_code" in credentials:
            new_creds.authorization_code = credentials["authorization_code"]
        if "authorized_devices" in credentials:
            devices = credentials["authorized_devices"]
            if isinstance(devices, str):
                devices = [d.strip() for d in devices.split(",") if d.strip()]
            elif not isinstance(devices, list):
                devices = []
            new_creds.authorized_devices = devices
        if "fetch_concurrency" in credentials:
            try:
                fetch_concurrency = int(credentials["fetch_concurrency"])
                if fetch_concurrency < 1:
                    fetch_concurrency = 1
                elif fetch_concurrency > 50:
                    fetch_concurrency = 50
                new_creds.fetch_concurrency = fetch_concurrency
            except (ValueError, TypeError):
                new_creds.fetch_concurrency = 12
        else:
            new_creds.fetch_concurrency = 12

        if "access_token" in credentials:
            new_creds.access_token = credentials["access_token"]
        if "refresh_token" in credentials:
            new_creds.refresh_token = credentials["refresh_token"]
        if "expires_at" in credentials:
            new_creds.expires_at = credentials["expires_at"]

        await new_creds.insert()
        logger.info("Successfully created Bouncie credentials in database")
        return True

    except Exception as e:
        logger.exception("Error updating Bouncie credentials: %s", e)
        return False


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
        "authorization_code",
    ]

    for field in required_fields:
        if not credentials.get(field):
            return False, f"Missing required field: {field}"

    if not credentials.get("authorized_devices"):
        return False, "At least one authorized device (IMEI) is required"

    return True, ""
