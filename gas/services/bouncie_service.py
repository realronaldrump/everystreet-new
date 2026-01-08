"""Bouncie API integration service for real-time vehicle data."""

import logging
from typing import Any

from config import API_BASE_URL, AUTH_URL, get_bouncie_config
from utils import get_session

logger = logging.getLogger(__name__)


class BouncieService:
    """Service class for Bouncie API integration."""

    @staticmethod
    async def fetch_vehicle_status(imei: str) -> dict[str, Any] | None:
        """Fetch real-time vehicle status from Bouncie API.

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
            credentials = await get_bouncie_config()
            session = await get_session()

            # Get access token
            payload = {
                "client_id": credentials.get("client_id"),
                "client_secret": credentials.get("client_secret"),
                "grant_type": "authorization_code",
                "code": credentials.get("authorization_code"),
                "redirect_uri": credentials.get("redirect_uri"),
            }

            async with session.post(AUTH_URL, data=payload) as auth_response:
                if auth_response.status != 200:
                    logger.warning(f"Bouncie auth failed: {auth_response.status}")
                    return None
                auth_data = await auth_response.json()
                token = auth_data.get("access_token")
                if not token:
                    logger.warning("No access token in Bouncie response")
                    return None

            # Call vehicles endpoint
            headers = {
                "Authorization": token,
                "Content-Type": "application/json",
            }
            url = f"{API_BASE_URL}/vehicles"
            params = {"imei": imei}

            async with session.get(url, headers=headers, params=params) as response:
                if response.status != 200:
                    logger.warning(f"Bouncie vehicles API failed: {response.status}")
                    return None

                vehicles = await response.json()
                if not vehicles:
                    logger.warning(f"No vehicle found for IMEI {imei}")
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
                    f"Bouncie API: IMEI {imei} - Odo: {result['odometer']}, "
                    f"Updated: {result['timestamp']}"
                )
                return result

        except Exception as e:
            logger.error(f"Error fetching vehicle status from Bouncie: {e}")
            return None
