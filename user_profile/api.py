"""
Profile API endpoints for managing user configuration.

This module provides API endpoints for managing Bouncie credentials and
other user- specific settings.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from config import (
    BOUNCIE_FETCH_CONCURRENCY_MAX,
    BOUNCIE_FETCH_CONCURRENCY_MIN,
    parse_bouncie_fetch_concurrency,
)
from core.api import api_route
from core.http.session import get_session
from fleet.registry import FleetRegistry, normalize_bouncie_vehicle
from setup.services.bouncie_credentials import (
    get_bouncie_credentials,
    update_bouncie_credentials,
    validate_bouncie_credentials,
)
from setup.services.bouncie_sync import BouncieVehicleSyncError, sync_bouncie_vehicles

logger = logging.getLogger(__name__)

router = APIRouter(tags=["profile"])


class BouncieCredentials(BaseModel):
    """Model for Bouncie API credentials."""

    client_id: str
    client_secret: str
    redirect_uri: str
    authorization_code: str | None = None
    fetch_concurrency: int | None = None


class BouncieVehicleCreate(BaseModel):
    """Model for adding an active Bouncie Device to the Fleet Registry."""

    imei: str
    custom_name: str | None = None
    sync_trips: bool = True


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

    fetch_concurrency = creds_dict.get("fetch_concurrency")
    if fetch_concurrency is not None:
        if not isinstance(fetch_concurrency, int):
            raise HTTPException(
                status_code=400,
                detail="Fetch concurrency must be an integer.",
            )
        if parse_bouncie_fetch_concurrency(fetch_concurrency) is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Fetch concurrency must be between "
                    f"{BOUNCIE_FETCH_CONCURRENCY_MIN} and "
                    f"{BOUNCIE_FETCH_CONCURRENCY_MAX}."
                ),
            )

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
                "expires_at": None,
                "oauth_state": None,
                "oauth_state_expires_at": None,
                "last_auth_error": None,
                "last_auth_error_detail": None,
                "last_auth_error_at": None,
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
    3. Create/update active Fleet Registry records
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

        try:
            sync_result = await sync_bouncie_vehicles(
                session,
                token,
                credentials=credentials,
            )
        except BouncieVehicleSyncError as exc:
            if exc.code == "unauthorized":
                _raise_http(
                    status_code=401,
                    detail="Failed to authenticate with Bouncie. Please reconnect.",
                )
            if exc.code == "rate_limited":
                _raise_http(
                    status_code=503,
                    detail="Bouncie API rate limited. Please try again shortly.",
                )
            _raise_http(
                status_code=502,
                detail="Failed to fetch vehicles from Bouncie.",
            )

        synced_vehicles = sync_result.get("vehicles", [])
        if not synced_vehicles:
            return {
                "status": "success",
                "message": "No vehicles found in Bouncie account",
                "vehicles": [],
            }

        logger.info(
            "Synced %d vehicles from Bouncie into the Fleet Registry.",
            len(synced_vehicles),
        )

        return {
            "status": "success",
            "message": f"Successfully synced {len(synced_vehicles)} vehicles",
            "vehicles": list(synced_vehicles),
        }

    except Exception as e:
        # Re-raise HTTPException as-is without logging or wrapping
        if isinstance(e, HTTPException):
            raise
        logger.exception("Error syncing vehicles from Bouncie")
        raise HTTPException(status_code=500, detail=str(e))


@router.post(
    "/api/profile/bouncie-credentials/vehicles",
    response_model=dict[str, Any],
)
@api_route(logger)
async def add_bouncie_vehicle(payload: BouncieVehicleCreate):
    """
    Add an active Bouncie device to the Fleet Registry.

    Note: The Bouncie REST API exposes vehicle search (`GET /v1/vehicles`) but does
    not support creating vehicles in the user's Bouncie account. Some connected
    devices may not appear in `/v1/vehicles` (for example IMEI-only/manual devices).
    This endpoint always supports IMEI-only add, stores/updates a local vehicle
    record, which makes it eligible for trip fetch while active.
    """
    imei = (payload.imei or "").strip()
    if not imei:
        raise HTTPException(status_code=400, detail="IMEI is required.")

    custom_name = (payload.custom_name or "").strip() or None

    credentials = await get_bouncie_credentials()
    if not credentials.get("authorization_code"):
        raise HTTPException(
            status_code=400,
            detail="Not connected to Bouncie. Please click 'Connect/Authorize' first.",
        )

    from setup.services.bouncie_api import (
        BouncieApiError,
        BouncieRateLimitError,
        BouncieUnauthorizedError,
        fetch_vehicle_by_imei,
    )
    from setup.services.bouncie_oauth import BouncieOAuth

    session = await get_session()
    token = await BouncieOAuth.get_access_token(
        session=session,
        credentials=credentials,
    )
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Failed to authenticate with Bouncie. Please reconnect.",
        )

    try:
        bouncie_vehicle = await fetch_vehicle_by_imei(session, token, imei)
    except BouncieUnauthorizedError:
        token = await BouncieOAuth.get_access_token(
            session=session,
            credentials=credentials,
            force_refresh=True,
        )
        if not token:
            raise HTTPException(
                status_code=401,
                detail="Failed to authenticate with Bouncie. Please reconnect.",
            )
        bouncie_vehicle = await fetch_vehicle_by_imei(session, token, imei)
    except BouncieRateLimitError as exc:
        logger.warning(
            "Bouncie API rate limited while adding vehicle %s: %s",
            imei,
            exc,
        )
        raise HTTPException(
            status_code=503,
            detail="Bouncie API rate limited. Please try again shortly.",
        ) from exc
    except BouncieApiError as exc:
        logger.exception("Bouncie API error while adding vehicle %s", imei)
        raise HTTPException(
            status_code=502,
            detail="Failed to fetch vehicle details from Bouncie.",
        ) from exc

    vehicle_found = isinstance(bouncie_vehicle, dict) and bool(bouncie_vehicle)
    vehicle_payload: dict[str, Any] = bouncie_vehicle if vehicle_found else {}
    if not vehicle_found:
        logger.info(
            "Vehicle %s not returned by /v1/vehicles; creating/updating IMEI-only local record",
            imei,
        )

    created = await FleetRegistry.get_device(imei) is None

    metadata = normalize_bouncie_vehicle({**vehicle_payload, "imei": imei})
    if vehicle_found and metadata is not None:
        # The user asked for this device explicitly, so activate it.
        vehicle = await FleetRegistry.apply_bouncie_metadata(
            metadata,
            custom_name=custom_name,
            activate=True,
        )
    else:
        vehicle = await FleetRegistry.register_device(
            imei,
            custom_name=custom_name or f"Vehicle {imei}",
        )

    trip_sync_job_id: str | None = None
    trip_sync_note: str | None = None
    if payload.sync_trips:
        try:
            from trips.models import TripSyncRequest
            from trips.services.trip_sync_service import TripSyncService

            result = await TripSyncService.start_sync(
                TripSyncRequest(
                    mode="recent",
                    trigger_source="vehicle_added",
                ),
            )
            trip_sync_job_id = result.get("job_id")
        except HTTPException as exc:
            # Don't fail vehicle creation if a sync can't be queued.
            trip_sync_note = (
                str(exc.detail) if getattr(exc, "detail", None) else str(exc)
            )
        except Exception as exc:
            logger.exception(
                "Failed to enqueue trip sync after adding vehicle %s",
                imei,
            )
            trip_sync_note = str(exc)

    message = "Vehicle added."
    if created:
        message = "Vehicle added."
    if not vehicle_found:
        message = (
            "Vehicle added as IMEI-only (device not listed by Bouncie vehicles API)."
        )

    if trip_sync_job_id:
        message = f"{message} Trip sync queued."
    elif payload.sync_trips and trip_sync_note:
        message = f"{message} Trip sync not started: {trip_sync_note}"

    return {
        "status": "success",
        "message": message,
        "vehicle": vehicle,
        "trip_sync_job_id": trip_sync_job_id,
    }
