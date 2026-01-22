"""Bouncie API integration service for real-time vehicle data."""

import asyncio
import logging
from typing import Any

from config import API_BASE_URL
from core.http.session import get_session
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

            # Call vehicles endpoint
            headers = {
                "Authorization": token,
                "Content-Type": "application/json",
            }
            url = f"{API_BASE_URL}/vehicles"
            params = {"imei": imei}

            for attempt in range(2):
                async with session.get(url, headers=headers, params=params) as response:
                    if response.status in {401, 403} and attempt == 0:
                        logger.info("Bouncie API unauthorized; refreshing token")
                        token = await BouncieOAuth.get_access_token(
                            session=session,
                            force_refresh=True,
                        )
                        if not token:
                            logger.warning("Failed to refresh Bouncie access token")
                            return None
                        headers["Authorization"] = token
                        continue
                    if response.status == 429 and attempt == 0:
                        retry_after = response.headers.get("Retry-After")
                        delay = 1
                        if retry_after:
                            try:
                                delay = max(1, int(retry_after))
                            except ValueError:
                                delay = 1
                        logger.warning(
                            "Bouncie API rate limited. Retrying in %d seconds.",
                            delay,
                        )
                        await asyncio.sleep(delay)
                        continue
                    if response.status != 200:
                        logger.warning(
                            "Bouncie vehicles API failed: %s",
                            response.status,
                        )
                        return None

                    vehicles = await response.json()
                    if not vehicles:
                        logger.warning("No vehicle found for IMEI %s", imei)
                        return None

                    vehicle = vehicles[0]  # API returns array
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
            return None

        except Exception:
            logger.exception("Error fetching vehicle status from Bouncie")
            return None
