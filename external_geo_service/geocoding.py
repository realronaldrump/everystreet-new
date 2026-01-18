"""Geocoding services for forward and reverse geocoding."""

import logging
from typing import Any

from core.http.nominatim import NominatimClient

from .schemas import get_empty_location_schema, parse_nominatim_response

logger = logging.getLogger(__name__)


class GeocodingService:
    """Service for forward and reverse geocoding using Nominatim."""

    def __init__(self) -> None:
        self._client = NominatimClient()

    async def reverse_geocode(
        self,
        lat: float,
        lon: float,
    ) -> dict[str, Any] | None:
        """Reverse geocode coordinates using Nominatim."""
        return await self._client.reverse(lat, lon)

    def parse_geocode_response(
        self,
        response: dict[str, Any],
        coordinates: list[float],
    ) -> dict[str, Any]:
        """Parse geocoding response into structured location schema."""
        if "display_name" in response:
            return parse_nominatim_response(response, coordinates)

        structured = get_empty_location_schema()
        structured["coordinates"]["lng"] = coordinates[0]
        structured["coordinates"]["lat"] = coordinates[1]
        return structured

    async def forward_geocode(
        self,
        query: str,
        limit: int = 5,
        proximity: tuple[float, float] | None = None,
        country_codes: str = "us",
    ) -> list[dict[str, Any]]:
        return await self._client.search(
            query,
            limit=limit,
            proximity=proximity,
            country_codes=country_codes,
        )
