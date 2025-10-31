"""Profile API endpoints for managing user configuration.

This module provides API endpoints for managing Bouncie credentials
and other user-specific settings.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from bouncie_credentials import (
    get_bouncie_credentials,
    update_bouncie_credentials,
    validate_bouncie_credentials,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class BouncieCredentials(BaseModel):
    """Model for Bouncie API credentials."""

    client_id: str
    client_secret: str
    redirect_uri: str
    authorization_code: str
    authorized_devices: list[str] | str


@router.get("/api/profile/bouncie-credentials")
async def get_credentials():
    """Get current Bouncie credentials.

    Returns credentials with masked secrets for display purposes.
    """
    try:
        credentials = await get_bouncie_credentials()

        # Mask sensitive fields for display
        if credentials.get("client_secret"):
            credentials["client_secret"] = (
                "***" + credentials["client_secret"][-4:]
                if len(credentials["client_secret"]) > 4
                else "***"
            )
        if credentials.get("authorization_code"):
            credentials["authorization_code"] = (
                "***" + credentials["authorization_code"][-4:]
                if len(credentials["authorization_code"]) > 4
                else "***"
            )

        return {
            "status": "success",
            "credentials": credentials,
        }
    except Exception as e:
        logger.exception("Error retrieving Bouncie credentials")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/profile/bouncie-credentials")
async def update_credentials(credentials: BouncieCredentials):
    """Update Bouncie credentials.

    Args:
        credentials: New credential values to store

    Returns:
        Status of the update operation
    """
    try:
        creds_dict = credentials.model_dump()

        # Validate credentials
        is_valid, error_msg = await validate_bouncie_credentials(creds_dict)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error_msg)

        # Update credentials in database
        success = await update_bouncie_credentials(creds_dict)

        if success:
            return {
                "status": "success",
                "message": "Bouncie credentials updated successfully",
            }
        else:
            return {
                "status": "success",
                "message": "No changes made to credentials",
            }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Error updating Bouncie credentials")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/profile/bouncie-credentials/unmask")
async def get_credentials_unmasked():
    """Get current Bouncie credentials without masking.

    Use with caution - returns sensitive data.
    """
    try:
        credentials = await get_bouncie_credentials()
        return {
            "status": "success",
            "credentials": credentials,
        }
    except Exception as e:
        logger.exception("Error retrieving unmasked Bouncie credentials")
        raise HTTPException(status_code=500, detail=str(e))
