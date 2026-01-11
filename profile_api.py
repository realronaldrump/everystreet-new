"""Profile API endpoints for managing user configuration.

This module provides API endpoints for managing Bouncie credentials
and other user-specific settings.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app_settings import get_app_settings, update_app_settings
from bouncie_credentials import (
    get_bouncie_credentials,
    update_bouncie_credentials,
    validate_bouncie_credentials,
)
from config import API_BASE_URL, AUTH_URL
from core.http.session import get_session
from db.models import Vehicle

logger = logging.getLogger(__name__)

router = APIRouter()


class BouncieCredentials(BaseModel):
    """Model for Bouncie API credentials."""

    client_id: str
    client_secret: str
    redirect_uri: str
    authorization_code: str
    authorized_devices: list[str] | str
    fetch_concurrency: int | None = None


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
                f"***{credentials['client_secret'][-4:]}"
                if len(credentials["client_secret"]) > 4
                else "***"
            )
        if credentials.get("authorization_code"):
            credentials["authorization_code"] = (
                f"***{credentials['authorization_code'][-4:]}"
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
        return {
            "status": "success",
            "message": "No changes made to credentials",
        }
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


@router.post("/api/profile/bouncie-credentials/sync-vehicles")
async def sync_vehicles_from_bouncie():
    """Fetch all vehicles from Bouncie and update local records.

    This will:
    1. Authenticate with Bouncie using stored credentials
    2. Fetch all vehicles associated with the account
    3. Update the 'authorized_devices' list in credentials
    4. Create/Update records in the 'vehicles' collection
    """
    try:
        credentials = await get_bouncie_credentials()
        client_id = credentials.get("client_id")
        client_secret = credentials.get("client_secret")
        auth_code = credentials.get("authorization_code")
        redirect_uri = credentials.get("redirect_uri")

        if not all([client_id, client_secret, auth_code]):
            raise HTTPException(
                status_code=400,
                detail="Bouncie credentials (Client ID, Secret, Auth Code) are missing",
            )

        session = await get_session()

        # 1. Get Access Token
        payload = {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "authorization_code",
            "code": auth_code,
            "redirect_uri": redirect_uri,
        }

        # Handle optional redirect_uri
        if not redirect_uri:
            payload.pop("redirect_uri", None)

        token = None
        async with session.post(AUTH_URL, data=payload) as auth_response:
            if auth_response.status != 200:
                error_text = await auth_response.text()
                logger.error(
                    "Bouncie auth failed: %s - %s",
                    auth_response.status,
                    error_text,
                )
                raise HTTPException(
                    status_code=400,
                    detail=f"Failed to authenticate with Bouncie: {error_text}",
                )
            auth_data = await auth_response.json()
            token = auth_data.get("access_token")

        if not token:
            raise HTTPException(
                status_code=500, detail="No access token received from Bouncie"
            )

        # 2. Fetch Vehicles
        headers = {
            "Authorization": token,
            "Content-Type": "application/json",
        }
        # Call without params to get all vehicles
        async with session.get(f"{API_BASE_URL}/vehicles", headers=headers) as resp:
            if resp.status != 200:
                error_text = await resp.text()
                logger.error(
                    "Failed to fetch vehicles: %s - %s", resp.status, error_text
                )
                raise HTTPException(
                    status_code=502,
                    detail=f"Failed to fetch vehicles from Bouncie: {error_text}",
                )

            vehicles_data = await resp.json()

        if not vehicles_data:
            return {
                "status": "success",
                "message": "No vehicles found in Bouncie account",
                "vehicles": [],
            }

        # 3. Process Vehicles
        synced_vehicles = []
        found_imeis = []

        for v in vehicles_data:
            imei = v.get("imei")
            if not imei:
                continue

            found_imeis.append(imei)

            # Prepare vehicle document
            vehicle_doc = {
                "imei": imei,
                "vin": v.get("vin"),
                "make": v.get("make"),
                "model": v.get("model"),
                "year": v.get("year"),
                "nickName": v.get("nickName"),
                "standardEngine": v.get("standardEngine"),
                # Helper field for UI display (nickName or Make Model Year)
                "custom_name": v.get("nickName")
                or f"{v.get('year', '')} {v.get('make', '')} {v.get('model', '')}".strip()
                or f"Vehicle {imei}",
                "is_active": True,
                "updated_at": datetime.now(UTC),
                "last_synced_at": datetime.now(UTC),
                "bouncie_data": v,  # Store raw data just in case
            }

            # Upsert into vehicles collection
            vehicles_coll = Vehicle.get_motor_collection()
            await vehicles_coll.update_one(
                {"imei": imei},
                {"$set": vehicle_doc},
                upsert=True,
            )
            synced_vehicles.append(vehicle_doc)

        # 4. Update Authorized Devices in Credentials
        # We merge with existing to avoid removing manually added ones if any (though usually we want to match Bouncie)
        # But if the user went through the trouble of syncing, they expect these to be authorized.
        current_devices = credentials.get("authorized_devices", [])
        if isinstance(current_devices, str):
            current_devices = [
                d.strip() for d in current_devices.split(",") if d.strip()
            ]

        # Merge and dedup
        updated_devices = list(set(current_devices + found_imeis))

        # Update credentials
        await update_bouncie_credentials({"authorized_devices": updated_devices})

        logger.info(
            "Synced %d vehicles from Bouncie. Updated authorized devices.",
            len(synced_vehicles),
        )

        return {
            "status": "success",
            "message": f"Successfully synced {len(synced_vehicles)} vehicles",
            "vehicles": list(synced_vehicles),
            "authorized_devices": updated_devices,
        }

    except Exception as e:
        # Re-raise HTTPException as-is without logging or wrapping
        if isinstance(e, HTTPException):
            raise
        logger.exception("Error syncing vehicles from Bouncie")
        raise HTTPException(status_code=500, detail=str(e))


# --- App Settings (Mapbox, Clarity) ---


class AppSettingsModel(BaseModel):
    """Model for app-wide settings."""

    mapbox_access_token: str | None = None
    clarity_project_id: str | None = None


@router.get("/api/profile/app-settings")
async def get_settings():
    """Get current app settings.

    Returns settings with masked Mapbox token for display purposes.
    """
    try:
        settings = await get_app_settings()

        # Mask Mapbox token for display
        mapbox_token = settings.get("mapbox_access_token", "")
        if mapbox_token:
            if len(mapbox_token) > 8:
                settings["mapbox_access_token_masked"] = (
                    f"{mapbox_token[:4]}***{mapbox_token[-4:]}"
                )
            else:
                settings["mapbox_access_token_masked"] = "***"
        else:
            settings["mapbox_access_token_masked"] = ""

        return {
            "status": "success",
            "settings": settings,
        }
    except Exception as e:
        logger.exception("Error retrieving app settings")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/profile/app-settings")
async def update_settings(settings: AppSettingsModel):
    """Update app settings.

    Args:
        settings: New settings values to store

    Returns:
        Status of the update operation
    """
    try:
        settings_dict = {}

        # Only include fields that were explicitly provided
        if settings.mapbox_access_token is not None:
            settings_dict["mapbox_access_token"] = settings.mapbox_access_token
        if settings.clarity_project_id is not None:
            settings_dict["clarity_project_id"] = settings.clarity_project_id

        if not settings_dict:
            return {
                "status": "success",
                "message": "No settings provided to update",
            }

        success = await update_app_settings(settings_dict)

        if success:
            # Reload settings cache so changes take effect immediately
            from app_settings import ensure_settings_cached

            await ensure_settings_cached()

            return {
                "status": "success",
                "message": "App settings updated successfully",
            }
        return {
            "status": "success",
            "message": "No changes made to settings",
        }
    except Exception as e:
        logger.exception("Error updating app settings")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/api/profile/app-settings/unmask")
async def get_settings_unmasked():
    """Get current app settings without masking.

    Use with caution - returns sensitive data.
    """
    try:
        settings = await get_app_settings()
        return {
            "status": "success",
            "settings": settings,
        }
    except Exception as e:
        logger.exception("Error retrieving unmasked app settings")
        raise HTTPException(status_code=500, detail=str(e))
