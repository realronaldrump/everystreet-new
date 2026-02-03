"""
Nominatim HTTP client utilities.

Centralizes geocoding against the self-hosted Nominatim US9 instance.
"""

from __future__ import annotations

import logging
from typing import Any

from config import (
    require_nominatim_base_url,
    require_nominatim_reverse_url,
    require_nominatim_search_url,
    require_nominatim_user_agent,
)
from core.exceptions import ExternalServiceException
from core.http.request import request_json
from core.http.retry import retry_async
from core.http.session import get_session

logger = logging.getLogger(__name__)


class NominatimClient:
    def __init__(self) -> None:
        self._base_url = require_nominatim_base_url()
        self._search_url = require_nominatim_search_url()
        self._reverse_url = require_nominatim_reverse_url()
        self._user_agent = require_nominatim_user_agent()
        self._lookup_url = f"{self._base_url}/lookup"

    def _headers(self) -> dict[str, str]:
        return {"User-Agent": self._user_agent}

    @staticmethod
    def _lookup_prefix(osm_type: str) -> str | None:
        type_value = str(osm_type or "").strip().lower()
        if not type_value:
            return None
        mapping = {
            "node": "N",
            "n": "N",
            "way": "W",
            "w": "W",
            "relation": "R",
            "rel": "R",
            "r": "R",
        }
        return mapping.get(type_value)

    async def lookup_raw(
        self,
        *,
        osm_id: int | str,
        osm_type: str,
        polygon_geojson: bool = True,
        addressdetails: bool = True,
    ) -> list[dict[str, Any]]:
        prefix = self._lookup_prefix(osm_type)
        if not prefix:
            msg = "Nominatim lookup error: invalid osm_type"
            raise ExternalServiceException(msg, {"osm_type": osm_type})
        try:
            osm_id_value = int(osm_id)
        except (TypeError, ValueError) as exc:
            msg = "Nominatim lookup error: invalid osm_id"
            raise ExternalServiceException(msg, {"osm_id": osm_id}) from exc

        params: dict[str, Any] = {
            "osm_ids": f"{prefix}{osm_id_value}",
            "format": "json",
            "addressdetails": int(addressdetails),
        }
        if polygon_geojson:
            params["polygon_geojson"] = 1

        session = await get_session()
        results = await request_json(
            "GET",
            self._lookup_url,
            session=session,
            params=params,
            headers=self._headers(),
            service_name="Nominatim lookup",
        )
        if not isinstance(results, list):
            msg = "Nominatim lookup error: unexpected response"
            raise ExternalServiceException(msg, {"url": self._lookup_url})
        return results

    @retry_async()
    async def search_raw(
        self,
        *,
        query: str,
        limit: int = 1,
        polygon_geojson: bool = False,
        addressdetails: bool = True,
    ) -> list[dict[str, Any]]:
        params = {
            "q": query,
            "format": "json",
            "limit": limit,
            "addressdetails": int(addressdetails),
        }
        if polygon_geojson:
            params["polygon_geojson"] = 1

        session = await get_session()
        results = await request_json(
            "GET",
            self._search_url,
            session=session,
            params=params,
            headers=self._headers(),
            service_name="Nominatim search",
        )
        if not isinstance(results, list):
            msg = "Nominatim search error: unexpected response"
            raise ExternalServiceException(msg, {"url": self._search_url})
        return results

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
        results = await request_json(
            "GET",
            self._search_url,
            session=session,
            params=params,
            headers=self._headers(),
            service_name="Nominatim search",
        )
        if not isinstance(results, list):
            msg = "Nominatim search error: unexpected response"
            raise ExternalServiceException(msg, {"url": self._search_url})

        return [
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
            }
            for result in results
        ]

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
        data = await request_json(
            "GET",
            self._reverse_url,
            session=session,
            params=params,
            headers=self._headers(),
            service_name="Nominatim reverse",
            none_on=(404,),
        )
        if data is None:
            return None
        if not isinstance(data, dict):
            msg = "Nominatim reverse error: unexpected response"
            raise ExternalServiceException(msg, {"url": self._reverse_url})
        return data
