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
        logger.exception("Bouncie API rate limited during vehicle sync")
        msg = "rate_limited"
        raise BouncieVehicleSyncError(msg) from exc
    except BouncieApiError as exc:
        logger.exception("Bouncie API error during vehicle sync")
        msg = "api_error"
        raise BouncieVehicleSyncError(msg) from exc


async def sync_bouncie_vehicles(
    session: Any,
    token: str,
    *,
    credentials: dict[str, Any] | None = None,
) -> dict[str, Any]:
    vehicles_data = await _fetch_vehicles(
        session,
        token,
        credentials=credentials,
    )

    if not vehicles_data:
        return {"vehicles": [], "imeis": []}

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

        default_name = (
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
            "bouncie_nickname": v.get("nickName"),
            "standard_engine": v.get("standardEngine"),
            "is_active": True,
            "updated_at": datetime.now(UTC),
            "last_synced_at": datetime.now(UTC),
            "bouncie_data": v,
        }

        # A Bouncie Device is identified by IMEI. VIN describes the physical
        # vehicle and can legitimately recur after a tracker is replaced.
        existing_vehicle = await Vehicle.find_one({"imei": imei})
        vin_val = vehicle_doc.get("vin")
        if not existing_vehicle and vin_val:
            previous_assignment = await Vehicle.find_one({"vin": vin_val})
            if previous_assignment and previous_assignment.imei != imei:
                previous_assignment.vin = None
                previous_assignment.updated_at = datetime.now(UTC)
                await previous_assignment.save()

        if existing_vehicle:
            existing_vehicle.imei = vehicle_doc["imei"]
            existing_vehicle.vin = vehicle_doc["vin"]
            existing_vehicle.make = vehicle_doc["make"]
            existing_vehicle.model = vehicle_doc["model"]
            existing_vehicle.year = vehicle_doc["year"]
            existing_vehicle.bouncie_nickname = vehicle_doc["bouncie_nickname"]
            existing_vehicle.standard_engine = vehicle_doc["standard_engine"]
            if not (existing_vehicle.custom_name or "").strip():
                existing_vehicle.custom_name = default_name
            existing_vehicle.updated_at = vehicle_doc["updated_at"]
            existing_vehicle.last_synced_at = vehicle_doc["last_synced_at"]
            existing_vehicle.bouncie_data = vehicle_doc["bouncie_data"]
            await existing_vehicle.save()
        else:
            new_vehicle = Vehicle(
                **{
                    **vehicle_doc,
                    "custom_name": default_name,
                    "created_at": datetime.now(UTC),
                },
            )
            await new_vehicle.insert()

        synced_vehicles.append(vehicle_doc)

    return {
        "vehicles": synced_vehicles,
        "imeis": found_imeis,
    }
