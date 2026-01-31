"""Bouncie API client for trip data."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import aiohttp

from config import API_BASE_URL, get_bouncie_config
from core.date_utils import parse_timestamp
from core.http.retry import retry_async
from core.http.session import get_session
from setup.services.bouncie_oauth import BouncieOAuth

logger = logging.getLogger(__name__)


class BouncieClient:
    """Client for Bouncie trip endpoints."""

    def __init__(self, session: aiohttp.ClientSession | None = None) -> None:
        self._session = session

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = await get_session()
        return self._session

    async def get_access_token(
        self, credentials: dict[str, Any] | None = None
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
            "starts-after": start_dt.isoformat(),
            "ends-before": end_dt.isoformat(),
        }
        url = f"{API_BASE_URL}/trips"

        session = await self._get_session()
        try:
            async with session.get(url, headers=headers, params=params) as response:
                response.raise_for_status()
                trips = await response.json()

                for trip in trips:
                    if "startTime" in trip:
                        trip["startTime"] = parse_timestamp(trip["startTime"])
                    if "endTime" in trip:
                        trip["endTime"] = parse_timestamp(trip["endTime"])

                return trips
        except Exception:
            logger.exception("Error fetching trips for device %s", imei)
            return []

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

                for trip in trips:
                    if "startTime" in trip:
                        trip["startTime"] = parse_timestamp(trip["startTime"])
                    if "endTime" in trip:
                        trip["endTime"] = parse_timestamp(trip["endTime"])

                return trips
        except Exception:
            logger.exception("Error fetching trip for transactionId %s", transaction_id)
            return []


__all__ = ["BouncieClient"]
