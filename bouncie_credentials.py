"""Bouncie credentials management.

This module handles storage and retrieval of Bouncie API credentials
from MongoDB, allowing runtime configuration without .env file changes.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from db import find_one_with_retry, update_one_with_retry
from db import db_manager

logger = logging.getLogger(__name__)


async def get_bouncie_credentials_collection():
    """Get the bouncie_credentials collection from db_manager."""
    return db_manager.get_collection("bouncie_credentials")


async def get_bouncie_credentials() -> dict[str, Any]:
    """Retrieve Bouncie credentials from database.
    
    Falls back to environment variables if database credentials don't exist.
    
    Returns:
        Dictionary containing:
            - client_id: str
            - client_secret: str
            - redirect_uri: str
            - authorization_code: str
            - authorized_devices: list[str]
    """
    try:
        collection = await get_bouncie_credentials_collection()
        credentials = await find_one_with_retry(
            collection,
            {"_id": "bouncie_credentials"},
        )
        
        if credentials:
            logger.debug("Retrieved Bouncie credentials from database")
            return {
                "client_id": credentials.get("client_id", ""),
                "client_secret": credentials.get("client_secret", ""),
                "redirect_uri": credentials.get("redirect_uri", ""),
                "authorization_code": credentials.get("authorization_code", ""),
                "authorized_devices": credentials.get("authorized_devices", []),
            }
        
        # Fallback to environment variables
        logger.info("No database credentials found, falling back to environment variables")
        return {
            "client_id": os.getenv("CLIENT_ID", ""),
            "client_secret": os.getenv("CLIENT_SECRET", ""),
            "redirect_uri": os.getenv("REDIRECT_URI", ""),
            "authorization_code": os.getenv("AUTHORIZATION_CODE", ""),
            "authorized_devices": [
                d for d in os.getenv("AUTHORIZED_DEVICES", "").split(",") if d
            ],
        }
    except Exception as e:
        logger.exception("Error retrieving Bouncie credentials: %s", e)
        # Fallback to environment variables on error
        return {
            "client_id": os.getenv("CLIENT_ID", ""),
            "client_secret": os.getenv("CLIENT_SECRET", ""),
            "redirect_uri": os.getenv("REDIRECT_URI", ""),
            "authorization_code": os.getenv("AUTHORIZATION_CODE", ""),
            "authorized_devices": [
                d for d in os.getenv("AUTHORIZED_DEVICES", "").split(",") if d
            ],
        }


async def update_bouncie_credentials(credentials: dict[str, Any]) -> bool:
    """Update Bouncie credentials in database.
    
    Args:
        credentials: Dictionary containing credential fields to update.
            Can include: client_id, client_secret, redirect_uri,
            authorization_code, authorized_devices (list or comma-separated string)
    
    Returns:
        True if update was successful, False otherwise.
    """
    try:
        collection = await get_bouncie_credentials_collection()
        
        # Process authorized_devices
        devices = credentials.get("authorized_devices", [])
        if isinstance(devices, str):
            devices = [d.strip() for d in devices.split(",") if d.strip()]
        elif not isinstance(devices, list):
            devices = []
        
        update_data = {
            "client_id": credentials.get("client_id", ""),
            "client_secret": credentials.get("client_secret", ""),
            "redirect_uri": credentials.get("redirect_uri", ""),
            "authorization_code": credentials.get("authorization_code", ""),
            "authorized_devices": devices,
        }
        
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
    required_fields = ["client_id", "client_secret", "redirect_uri", "authorization_code"]
    
    for field in required_fields:
        if not credentials.get(field):
            return False, f"Missing required field: {field}"
    
    if not credentials.get("authorized_devices"):
        return False, "At least one authorized device (IMEI) is required"
    
    return True, ""

