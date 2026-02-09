from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from db.models import Vehicle
from setup.services.bouncie_api import (
    BouncieApiError,
    BouncieRateLimitError,
    BouncieUnauthorizedError,
    fetch_all_vehicles,
)
from setup.services.bouncie_credentials import update_bouncie_credentials
from setup.services.bouncie_oauth import BouncieOAuth

logger = logging.getLogger(__name__)


class BouncieVehicleSyncError(RuntimeError):
    """Raised when automatic vehicle sync fails."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


async def _fetch_vehicles(
    session: Any,
    token: str,
    *,
    credentials: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    try:
        return await fetch_all_vehicles(session, token)
    except BouncieUnauthorizedError as exc:
        if not credentials:
            logger.warning("Vehicle sync unauthorized and no credentials to refresh")
            msg = "unauthorized"
            raise BouncieVehicleSyncError(msg) from exc
        logger.info("Refreshing access token after 401/403 during vehicle sync")
        refreshed_token = await BouncieOAuth.get_access_token(
            session=session,
            credentials=credentials,
            force_refresh=True,
        )
        if not refreshed_token:
            logger.exception("Failed to refresh access token during vehicle sync")
            msg = "unauthorized"
            raise BouncieVehicleSyncError(msg) from exc
        return await fetch_all_vehicles(session, refreshed_token)
    except BouncieRateLimitError as exc:
        logger.exception("Bouncie API rate limited during vehicle sync: %s", exc)
        msg = "rate_limited"
        raise BouncieVehicleSyncError(msg) from exc
    except BouncieApiError as exc:
        logger.exception("Bouncie API error during vehicle sync: %s", exc)
        msg = "api_error"
        raise BouncieVehicleSyncError(msg) from exc


async def sync_bouncie_vehicles(
    session: Any,
    token: str,
    *,
    credentials: dict[str, Any] | None = None,
    merge_authorized_devices: bool = False,
    update_authorized_devices: bool = True,
) -> dict[str, Any]:
    vehicles_data = await _fetch_vehicles(
        session,
        token,
        credentials=credentials,
    )

    if not vehicles_data:
        return {"vehicles": [], "authorized_devices": [], "imeis": []}

    synced_vehicles: list[dict[str, Any]] = []
    found_imeis: list[str] = []

    for v in vehicles_data:
        imei = v.get("imei")
        if not imei:
            continue

        found_imeis.append(imei)

        model_data = v.get("model")
        if isinstance(model_data, dict):
            model_name = model_data.get("name")
            make = v.get("make") or model_data.get("make")
            year = v.get("year") or model_data.get("year")
        else:
            model_name = model_data
            make = v.get("make")
            year = v.get("year")

        custom_name = (
            v.get("nickName")
            or f"{year or ''} {make or ''} {model_name or ''}".strip()
            or f"Vehicle {imei}"
        )

        vehicle_doc = {
            "imei": imei,
            "vin": v.get("vin"),
            "make": make,
            "model": model_name,
            "year": year,
            "nickName": v.get("nickName"),
            "standardEngine": v.get("standardEngine"),
            "custom_name": custom_name,
            "is_active": True,
            "updated_at": datetime.now(UTC),
            "last_synced_at": datetime.now(UTC),
            "bouncie_data": v,
        }

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
                **{
                    **vehicle_doc,
                    "created_at": datetime.now(UTC),
                },
            )
            await new_vehicle.insert()

        synced_vehicles.append(vehicle_doc)

    authorized_devices: list[str] = []
    if update_authorized_devices and found_imeis:
        if merge_authorized_devices and credentials:
            current_devices = credentials.get("authorized_devices", [])
            if isinstance(current_devices, str):
                current_devices = [
                    d.strip() for d in current_devices.split(",") if d.strip()
                ]
            authorized_devices = list(set(current_devices + found_imeis))
        else:
            authorized_devices = list(found_imeis)

        await update_bouncie_credentials({"authorized_devices": authorized_devices})

    return {
        "vehicles": synced_vehicles,
        "authorized_devices": authorized_devices,
        "imeis": found_imeis,
    }
