"""
Nominatim HTTP client utilities.

Centralizes geocoding against the self-hosted Nominatim US9 instance.
"""

from __future__ import annotations

import logging
from typing import Any

from core.exceptions import ExternalServiceException
from core.http.retry import retry_async
from core.http.session import get_session
from config import (
    require_nominatim_search_url,
    require_nominatim_reverse_url,
    require_nominatim_user_agent,
)

logger = logging.getLogger(__name__)


class NominatimClient:
    def __init__(self) -> None:
        self._search_url = require_nominatim_search_url()
        self._reverse_url = require_nominatim_reverse_url()
        self._user_agent = require_nominatim_user_agent()

    def _headers(self) -> dict[str, str]:
        return {"User-Agent": self._user_agent}

    @retry_async()
    async def search(
        self,
        query: str,
        *,
        limit: int = 5,
        proximity: tuple[float, float] | None = None,
        country_codes: str = "us",
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "q": query,
            "format": "json",
            "limit": limit,
            "addressdetails": 1,
            "countrycodes": country_codes,
        }
        if proximity:
            lon, lat = proximity
            params["viewbox"] = f"{lon - 2},{lat + 2},{lon + 2},{lat - 2}"
            params["bounded"] = 1
        else:
            params["viewbox"] = "-125,49,-66,24"

        session = await get_session()
        async with session.get(
            self._search_url,
            params=params,
            headers=self._headers(),
        ) as response:
            if response.status != 200:
                body = await response.text()
                raise ExternalServiceException(
                    f"Nominatim search error: {response.status}",
                    {"body": body},
                )
            results = await response.json()

        normalized: list[dict[str, Any]] = []
        for result in results:
            normalized.append(
                {
                    "place_name": result.get("display_name", ""),
                    "center": [float(result["lon"]), float(result["lat"])],
                    "place_type": [result.get("type", "unknown")],
                    "text": result.get("name", ""),
                    "osm_id": result.get("osm_id"),
                    "osm_type": result.get("osm_type"),
                    "type": result.get("type"),
                    "lat": result.get("lat"),
                    "lon": result.get("lon"),
                    "display_name": result.get("display_name"),
                    "address": result.get("address", {}),
                    "importance": result.get("importance", 0),
                    "bbox": result.get("boundingbox"),
                },
            )
        return normalized

    @retry_async(max_retries=3, retry_delay=2.0)
    async def reverse(
        self,
        lat: float,
        lon: float,
        *,
        zoom: int = 18,
    ) -> dict[str, Any] | None:
        params = {
            "format": "jsonv2",
            "lat": lat,
            "lon": lon,
            "zoom": zoom,
            "addressdetails": 1,
        }
        session = await get_session()
        async with session.get(
            self._reverse_url,
            params=params,
            headers=self._headers(),
        ) as response:
            if response.status == 200:
                return await response.json()
            if response.status == 404:
                return None
            body = await response.text()
            raise ExternalServiceException(
                f"Nominatim reverse error: {response.status}",
                {"body": body},
            )
