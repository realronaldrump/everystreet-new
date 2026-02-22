"""Bouncie API client for trip data."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from config import API_BASE_URL, get_bouncie_config
from core.date_utils import ensure_utc, parse_timestamp
from core.http.retry import retry_async
from core.http.session import get_session
from setup.services.bouncie_oauth import BouncieOAuth

if TYPE_CHECKING:
    from datetime import datetime

    import aiohttp

logger = logging.getLogger(__name__)


def format_bouncie_datetime_param(dt: datetime) -> str:
    """
    Format datetimes for Bouncie query params.

    Bouncie expects RFC3339/ISO-8601 "date-time" strings. Use explicit
    UTC + 'Z' with second precision.
    """

    utc = ensure_utc(dt) or dt
    utc = utc.replace(microsecond=0)
    return utc.isoformat().replace("+00:00", "Z")


class BouncieClient:
    """Client for Bouncie trip endpoints."""

    def __init__(self, session: aiohttp.ClientSession | None = None) -> None:
        self._session = session

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = await get_session()
        return self._session

    async def get_access_token(
        self,
        credentials: dict[str, Any] | None = None,
    ) -> str | None:
        if credentials is None:
            credentials = await get_bouncie_config()
        session = await self._get_session()
        return await BouncieOAuth.get_access_token(session, credentials)

    @retry_async(max_retries=3, retry_delay=1.5)
    async def fetch_trips_for_device(
        self,
        token: str,
        imei: str,
        start_dt: datetime,
        end_dt: datetime,
    ) -> list[dict[str, Any]]:
        headers = {
            "Authorization": token,
            "Content-Type": "application/json",
        }
        params = {
            "imei": imei,
            "gps-format": "geojson",
            "starts-after": format_bouncie_datetime_param(start_dt),
            "ends-before": format_bouncie_datetime_param(end_dt),
        }
        url = f"{API_BASE_URL}/trips"

        session = await self._get_session()
        try:
            async with session.get(url, headers=headers, params=params) as response:
                response.raise_for_status()
                trips = await response.json()
        except Exception:
            logger.exception("Error fetching trips for device %s", imei)
            raise

        if not isinstance(trips, list):
            msg = f"Unexpected /trips response type: {type(trips).__name__}"
            raise TypeError(msg)

        for trip in trips:
            if not isinstance(trip, dict):
                continue
            if "startTime" in trip:
                trip["startTime"] = parse_timestamp(trip["startTime"])
            if "endTime" in trip:
                trip["endTime"] = parse_timestamp(trip["endTime"])
            # Keep historical attribution stable even if upstream omits IMEI.
            if not trip.get("imei"):
                trip["imei"] = imei

        return trips

    @retry_async(max_retries=0, retry_delay=1.5)
    async def fetch_trips_for_device_resilient(
        self,
        token: str,
        imei: str,
        start_dt: datetime,
        end_dt: datetime,
    ) -> list[dict[str, Any]]:
        """
        Fetch trips with light retry for history import / backfill.

        History import already uses recursive window-splitting. Avoid
        client-side retries here so failing windows split immediately
        instead of burning time on repeated requests.
        """
        headers = {
            "Authorization": token,
            "Content-Type": "application/json",
        }
        params = {
            "imei": imei,
            "gps-format": "geojson",
            "starts-after": format_bouncie_datetime_param(start_dt),
            "ends-before": format_bouncie_datetime_param(end_dt),
        }
        url = f"{API_BASE_URL}/trips"

        session = await self._get_session()
        try:
            async with session.get(url, headers=headers, params=params) as response:
                response.raise_for_status()
                trips = await response.json()
        except Exception:
            logger.exception("Error fetching trips for device %s (resilient)", imei)
            raise

        if not isinstance(trips, list):
            msg = f"Unexpected /trips response type: {type(trips).__name__}"
            raise TypeError(msg)

        for trip in trips:
            if not isinstance(trip, dict):
                continue
            if "startTime" in trip:
                trip["startTime"] = parse_timestamp(trip["startTime"])
            if "endTime" in trip:
                trip["endTime"] = parse_timestamp(trip["endTime"])
            if not trip.get("imei"):
                trip["imei"] = imei

        return trips

    @retry_async(max_retries=3, retry_delay=1.5)
    async def fetch_trip_by_transaction_id(
        self,
        token: str,
        transaction_id: str,
    ) -> list[dict[str, Any]]:
        headers = {
            "Authorization": token,
            "Content-Type": "application/json",
        }
        params = {
            "transaction-id": transaction_id,
            "gps-format": "geojson",
        }
        url = f"{API_BASE_URL}/trips"

        session = await self._get_session()
        try:
            async with session.get(url, headers=headers, params=params) as response:
                response.raise_for_status()
                trips = await response.json()
        except Exception:
            logger.exception("Error fetching trip for transactionId %s", transaction_id)
            raise

        if not isinstance(trips, list):
            msg = f"Unexpected /trips response type: {type(trips).__name__}"
            raise TypeError(msg)

        for trip in trips:
            if isinstance(trip, dict) and "startTime" in trip:
                trip["startTime"] = parse_timestamp(trip["startTime"])
            if isinstance(trip, dict) and "endTime" in trip:
                trip["endTime"] = parse_timestamp(trip["endTime"])

        return trips


__all__ = ["BouncieClient"]
