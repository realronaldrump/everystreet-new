"""Bouncie API integration service for real-time vehicle data."""

import asyncio
import logging
from typing import Any

from core.http.session import get_session
from setup.services.bouncie_api import (
    BouncieApiError,
    BouncieRateLimitError,
    BouncieUnauthorizedError,
    fetch_vehicle_by_imei,
)
from setup.services.bouncie_oauth import BouncieOAuth

logger = logging.getLogger(__name__)


class BouncieService:
    """Service class for Bouncie API integration."""

    @staticmethod
    async def fetch_vehicle_status(imei: str) -> dict[str, Any] | None:
        """
        Fetch real-time vehicle status from Bouncie API.

        Calls GET /v1/vehicles?imei={imei} to get current:
        - stats.odometer: Current odometer reading
        - stats.location: Last known lat/lon/address
        - stats.lastUpdated: When data was last refreshed

        Args:
            imei: Vehicle IMEI to look up

        Returns:
            Dict with latitude, longitude, odometer, address, timestamp or None if failed
        """
        try:
            session = await get_session()

            # Get access token using centralized OAuth (with caching)
            token = await BouncieOAuth.get_access_token(session)
            if not token:
                logger.warning("Failed to obtain Bouncie access token")
                return None

            for attempt in range(2):
                try:
                    vehicle = await fetch_vehicle_by_imei(session, token, imei)
                except BouncieUnauthorizedError:
                    if attempt > 0:
                        logger.warning("Bouncie API unauthorized for IMEI %s", imei)
                        return None
                    logger.info("Bouncie API unauthorized; refreshing token")
                    token = await BouncieOAuth.get_access_token(
                        session=session,
                        force_refresh=True,
                    )
                    if not token:
                        logger.warning("Failed to refresh Bouncie access token")
                        return None
                    continue
                except BouncieRateLimitError as exc:
                    logger.warning("Bouncie API rate limited for IMEI %s: %s", imei, exc)
                    if attempt > 0:
                        return None
                    await asyncio.sleep(1)
                    continue
                except BouncieApiError as exc:
                    logger.warning("Bouncie vehicles API failed for IMEI %s: %s", imei, exc)
                    return None

                if not vehicle:
                    logger.warning("No vehicle found for IMEI %s", imei)
                    return None

                stats = vehicle.get("stats", {})
                location = stats.get("location", {})

                result = {
                    "latitude": location.get("lat"),
                    "longitude": location.get("lon"),
                    "address": location.get("address"),
                    "odometer": stats.get("odometer"),
                    "timestamp": stats.get("lastUpdated"),
                    "source": "bouncie_api",
                }

                logger.info(
                    "Bouncie API: IMEI %s - Odo: %s, Updated: %s",
                    imei,
                    result["odometer"],
                    result["timestamp"],
                )
                return result
        except Exception:
            logger.exception("Error fetching vehicle status from Bouncie")
            return None

        return None
