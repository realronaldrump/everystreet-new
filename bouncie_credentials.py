"""Bouncie credentials management.

This module handles storage and retrieval of Bouncie API credentials
from MongoDB, allowing runtime configuration without .env file changes.
"""

from __future__ import annotations

import logging
from typing import Any

from db import db_manager, find_one_with_retry, update_one_with_retry

logger = logging.getLogger(__name__)


async def get_bouncie_credentials() -> dict[str, Any]:
    """Retrieve Bouncie credentials from database.

    This is a single-user app. All credentials are stored in MongoDB and
    configured via the profile page. No environment variable fallbacks.

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

    def get_empty_credentials() -> dict[str, Any]:
        """Return empty credential structure when none configured."""
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

    try:
        collection = db_manager.get_collection("bouncie_credentials")
        credentials = await find_one_with_retry(
            collection,
            {"_id": "bouncie_credentials"},
        )

        if credentials:
            logger.debug("Retrieved Bouncie credentials from database")
            # Handle fetch_concurrency - convert to int, default to 12
            fetch_concurrency = credentials.get("fetch_concurrency")
            if fetch_concurrency is None:
                fetch_concurrency = 12
            else:
                try:
                    fetch_concurrency = int(fetch_concurrency)
                except (ValueError, TypeError):
                    fetch_concurrency = 12

            return {
                "client_id": credentials.get("client_id", ""),
                "client_secret": credentials.get("client_secret", ""),
                "redirect_uri": credentials.get("redirect_uri", ""),
                "authorization_code": credentials.get("authorization_code", ""),
                "authorized_devices": credentials.get("authorized_devices", []),
                "fetch_concurrency": fetch_concurrency,
                "access_token": credentials.get("access_token"),
                "refresh_token": credentials.get("refresh_token"),
                "expires_at": credentials.get("expires_at"),
            }

        # No database credentials found - return empty structure
        logger.warning(
            "No Bouncie credentials found in database. "
            "Please configure via the profile page."
        )
        return get_empty_credentials()
    except Exception as e:
        logger.exception("Error retrieving Bouncie credentials: %s", e)
        return get_empty_credentials()


async def update_bouncie_credentials(credentials: dict[str, Any]) -> bool:
    """Update Bouncie credentials in database.

    Args:
        credentials: Dictionary containing credential fields to update.
            Only the fields present in this dict will be updated.
            Can include: client_id, client_secret, redirect_uri,
            authorization_code, authorized_devices (list or comma-separated string),
            fetch_concurrency (int, optional), access_token, refresh_token, expires_at

    Returns:
        True if update was successful, False otherwise.
    """
    try:
        collection = db_manager.get_collection("bouncie_credentials")

        # Build update_data with ONLY the fields that were explicitly provided
        update_data = {}

        # Core credential fields - only update if provided
        if "client_id" in credentials:
            update_data["client_id"] = credentials["client_id"]
        if "client_secret" in credentials:
            update_data["client_secret"] = credentials["client_secret"]
        if "redirect_uri" in credentials:
            update_data["redirect_uri"] = credentials["redirect_uri"]
        if "authorization_code" in credentials:
            update_data["authorization_code"] = credentials["authorization_code"]

        # Process authorized_devices only if provided
        if "authorized_devices" in credentials:
            devices = credentials["authorized_devices"]
            if isinstance(devices, str):
                devices = [d.strip() for d in devices.split(",") if d.strip()]
            elif not isinstance(devices, list):
                devices = []
            update_data["authorized_devices"] = devices

        # Process fetch_concurrency only if provided
        if "fetch_concurrency" in credentials:
            fetch_concurrency = credentials.get("fetch_concurrency")
            try:
                fetch_concurrency = int(fetch_concurrency)
                # Validate reasonable range
                if fetch_concurrency < 1:
                    fetch_concurrency = 1
                elif fetch_concurrency > 50:
                    fetch_concurrency = 50
            except (ValueError, TypeError):
                # If invalid, keep existing or use default
                existing = await find_one_with_retry(
                    collection,
                    {"_id": "bouncie_credentials"},
                )
                fetch_concurrency = existing.get("fetch_concurrency", 12) if existing else 12
                try:
                    fetch_concurrency = int(fetch_concurrency) if fetch_concurrency else 12
                except (ValueError, TypeError):
                    fetch_concurrency = 12
            update_data["fetch_concurrency"] = fetch_concurrency

        # Token fields - only update if provided
        if "access_token" in credentials:
            update_data["access_token"] = credentials["access_token"]
        if "refresh_token" in credentials:
            update_data["refresh_token"] = credentials["refresh_token"]
        if "expires_at" in credentials:
            update_data["expires_at"] = credentials["expires_at"]

        if not update_data:
            logger.warning("No fields to update in credentials")
            return False

        result = await update_one_with_retry(
            collection,
            {"_id": "bouncie_credentials"},
            {"$set": update_data},
            upsert=True,
        )

        success = result.modified_count > 0 or result.upserted_id is not None
        if success:
            logger.info("Successfully updated Bouncie credentials in database")
        else:
            logger.warning("No changes made to Bouncie credentials")

        return success
    except Exception as e:
        logger.exception("Error updating Bouncie credentials: %s", e)
        return False


async def validate_bouncie_credentials(credentials: dict[str, Any]) -> tuple[bool, str]:
    """Validate that required Bouncie credentials are present.

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
