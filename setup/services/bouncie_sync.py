from __future__ import annotations

import logging
from typing import Any

from fleet.registry import FleetRegistry, normalize_bouncie_vehicle
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
        metadata = normalize_bouncie_vehicle(v)
        if metadata is None:
            continue

        found_imeis.append(metadata.imei)
        vehicle = await FleetRegistry.apply_bouncie_metadata(metadata)

        synced_vehicles.append(
            {
                "imei": vehicle.imei,
                "vin": vehicle.vin,
                "make": vehicle.make,
                "model": vehicle.model,
                "year": vehicle.year,
                "bouncie_nickname": vehicle.bouncie_nickname,
                "standard_engine": vehicle.standard_engine,
                "is_active": vehicle.is_active,
                "updated_at": vehicle.updated_at,
                "last_synced_at": vehicle.last_synced_at,
                "bouncie_data": vehicle.bouncie_data,
            },
        )

    return {
        "vehicles": synced_vehicles,
        "imeis": found_imeis,
    }
