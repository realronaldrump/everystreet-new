"""
Profile API endpoints for managing user configuration.

This module provides API endpoints for managing Bouncie credentials and
other user- specific settings.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core.api import api_route
from core.http.session import get_session
from db.models import Vehicle
from setup.services.bouncie_api import (
    BouncieApiError,
    BouncieRateLimitError,
    BouncieUnauthorizedError,
    fetch_all_vehicles,
)
from setup.services.bouncie_credentials import (
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
    authorization_code: str | None = None
    authorized_devices: list[str] | str | None = None


@router.get("/api/profile/bouncie-credentials", response_model=dict[str, Any])
@api_route(logger)
async def get_credentials():
    """
    Get current Bouncie credentials.

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
        credentials.pop("webhook_key", None)
    except Exception as e:
        logger.exception("Error retrieving Bouncie credentials")
        raise HTTPException(status_code=500, detail=str(e))
    else:
        return {
            "status": "success",
            "credentials": credentials,
        }


@router.post("/api/profile/bouncie-credentials", response_model=dict[str, Any])
@api_route(logger)
async def update_credentials(credentials: BouncieCredentials):
    """
    Update Bouncie credentials.

    Args:
        credentials: New credential values to store

    Returns:
        Status of the update operation
    """
    creds_dict = credentials.model_dump(exclude_none=True)

    existing = await get_bouncie_credentials()

    def _normalized(value: str | None) -> str:
        return (value or "").strip()

    credentials_changed = any(
        _normalized(existing.get(field)) != _normalized(creds_dict.get(field))
        for field in ("client_id", "client_secret", "redirect_uri")
    )
    if credentials_changed:
        creds_dict.update(
            {
                "authorization_code": None,
                "access_token": None,
                "refresh_token": None,
                "expires_at": None,
                "oauth_state": None,
                "oauth_state_expires_at": None,
            },
        )

    # Validate credentials
    is_valid, error_msg = await validate_bouncie_credentials(creds_dict)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error_msg)

    try:
        # Update credentials in database
        success = await update_bouncie_credentials(creds_dict)
    except Exception as e:
        logger.exception("Error updating Bouncie credentials")
        raise HTTPException(status_code=500, detail=str(e))

    if success:
        message = "Bouncie credentials updated successfully"
        if credentials_changed:
            message = "Bouncie credentials updated. Reconnect to authorize access."
        return {
            "status": "success",
            "message": message,
        }
    return {
        "status": "success",
        "message": "No changes made to credentials",
    }


@router.get("/api/profile/bouncie-credentials/unmask", response_model=dict[str, Any])
@api_route(logger)
async def get_credentials_unmasked():
    """
    Get current Bouncie credentials without masking.

    Use with caution - returns sensitive data.
    """
    try:
        credentials = await get_bouncie_credentials()
        credentials.pop("webhook_key", None)
    except Exception as e:
        logger.exception("Error retrieving unmasked Bouncie credentials")
        raise HTTPException(status_code=500, detail=str(e))
    else:
        return {
            "status": "success",
            "credentials": credentials,
        }


@router.post(
    "/api/profile/bouncie-credentials/sync-vehicles",
    response_model=dict[str, Any],
)
@api_route(logger)
async def sync_vehicles_from_bouncie():
    """
    Fetch all vehicles from Bouncie and update local records.

    This will:
    1. Authenticate with Bouncie using stored credentials
    2. Fetch all vehicles associated with the account
    3. Update the 'authorized_devices' list in credentials
    4. Create/Update records in the 'vehicles' collection
    """

    def _raise_http(status_code: int, detail: str) -> None:
        raise HTTPException(status_code=status_code, detail=detail)

    try:
        credentials = await get_bouncie_credentials()

        if not credentials.get("client_id") or not credentials.get("client_secret"):
            _raise_http(
                status_code=400,
                detail="Bouncie credentials (Client ID, Secret) are missing",
            )

        if not credentials.get("authorization_code"):
            _raise_http(
                status_code=400,
                detail="Not connected to Bouncie. Please click 'Connect with Bouncie' first.",
            )

        # Use centralized OAuth service to get access token
        from setup.services.bouncie_oauth import BouncieOAuth

        session = await get_session()
        token = await BouncieOAuth.get_access_token(
            session=session,
            credentials=credentials,
        )

        if not token:
            _raise_http(
                status_code=401,
                detail="Failed to authenticate with Bouncie. Please reconnect.",
            )

        # 2. Fetch Vehicles
        try:
            vehicles_data = await fetch_all_vehicles(session, token)
        except BouncieUnauthorizedError:
            logger.info("Bouncie API unauthorized; attempting token refresh")
            token = await BouncieOAuth.get_access_token(
                session=session,
                credentials=credentials,
                force_refresh=True,
            )
            if not token:
                _raise_http(
                    status_code=401,
                    detail="Failed to refresh Bouncie access token. Please reconnect.",
                )
            vehicles_data = await fetch_all_vehicles(session, token)
        except BouncieRateLimitError as exc:
            logger.exception(
                "Bouncie API rate limited while fetching vehicles: %s",
                exc,
            )
            _raise_http(
                status_code=503,
                detail="Bouncie API rate limited. Please try again shortly.",
            )
        except BouncieApiError as exc:
            logger.exception("Failed to fetch vehicles from Bouncie: %s", exc)
            _raise_http(
                status_code=502,
                detail=f"Failed to fetch vehicles from Bouncie: {exc}",
            )

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

            # Extract model info - Bouncie API returns model as either a string
            # or an object like {"make": "TOYOTA", "name": "4-Runner", "year": 2004}
            model_data = v.get("model")
            if isinstance(model_data, dict):
                model_name = model_data.get("name")
                # Use model data for make/year if not provided at top level
                make = v.get("make") or model_data.get("make")
                year = v.get("year") or model_data.get("year")
            else:
                model_name = model_data
                make = v.get("make")
                year = v.get("year")

            # Prepare vehicle document
            vehicle_doc = {
                "imei": imei,
                "vin": v.get("vin"),
                "make": make,
                "model": model_name,
                "year": year,
                "nickName": v.get("nickName"),
                "standardEngine": v.get("standardEngine"),
                # Helper field for UI display (nickName or Make Model Year)
                "custom_name": v.get("nickName")
                or f"{year or ''} {make or ''} {model_name or ''}".strip()
                or f"Vehicle {imei}",
                "is_active": True,
                "updated_at": datetime.now(UTC),
                "last_synced_at": datetime.now(UTC),
                "bouncie_data": v,  # Store raw data just in case
            }

            # Upsert into vehicles collection using Beanie
            existing_vehicle = await Vehicle.find_one({"imei": imei})
            if existing_vehicle:
                existing_vehicle.vin = vehicle_doc["vin"]
                existing_vehicle.make = vehicle_doc["make"]
                existing_vehicle.model = vehicle_doc["model"]
                existing_vehicle.year = vehicle_doc["year"]
                existing_vehicle.nickName = vehicle_doc["nickName"]
                existing_vehicle.custom_name = vehicle_doc["custom_name"]
                existing_vehicle.is_active = vehicle_doc["is_active"]
                existing_vehicle.updated_at = vehicle_doc["updated_at"]
                existing_vehicle.last_synced_at = vehicle_doc["last_synced_at"]
                existing_vehicle.bouncie_data = vehicle_doc["bouncie_data"]
                await existing_vehicle.save()
            else:
                new_vehicle = Vehicle(
                    imei=imei,
                    vin=vehicle_doc["vin"],
                    make=vehicle_doc["make"],
                    model=vehicle_doc["model"],
                    year=vehicle_doc["year"],
                    custom_name=vehicle_doc["custom_name"],
                    is_active=vehicle_doc["is_active"],
                    updated_at=vehicle_doc["updated_at"],
                )
                await new_vehicle.insert()
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
