"""Nominatim client and geocoding helpers."""

from __future__ import annotations

import logging
from typing import Any

from core.http.nominatim import NominatimClient

logger = logging.getLogger(__name__)


def get_empty_location_schema() -> dict[str, Any]:
    """Get empty location schema structure."""
    return {
        "formatted_address": "",
        "address_components": {
            "street_number": "",
            "street": "",
            "city": "",
            "county": "",
            "state": "",
            "postal_code": "",
            "country": "",
        },
        "coordinates": {
            "lat": 0.0,
            "lng": 0.0,
        },
    }


def parse_nominatim_response(
    response: dict[str, Any],
    coordinates: list[float],
) -> dict[str, Any]:
    """Parse Nominatim geocoding response into structured location schema."""
    structured = get_empty_location_schema()
    structured["coordinates"]["lng"] = coordinates[0]
    structured["coordinates"]["lat"] = coordinates[1]
    structured["formatted_address"] = response.get("display_name", "")

    if "address" in response:
        addr = response["address"]
        component_mapping = {
            "house_number": "street_number",
            "road": "street",
            "city": "city",
            "town": "city",
            "village": "city",
            "county": "county",
            "state": "state",
            "postcode": "postal_code",
            "country": "country",
        }

        for nominatim_key, our_key in component_mapping.items():
            if nominatim_key in addr:
                structured["address_components"][our_key] = addr[nominatim_key]

    return structured


class GeocodingService:
    """Service for forward and reverse geocoding using Nominatim."""

    def __init__(self) -> None:
        self._client = NominatimClient()

    async def reverse_geocode(
        self,
        lat: float,
        lon: float,
    ) -> dict[str, Any] | None:
        return await self._client.reverse(lat, lon)

    def parse_geocode_response(
        self,
        response: dict[str, Any],
        coordinates: list[float],
    ) -> dict[str, Any]:
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
        country_codes: str | None = "us",
        strict_bounds: bool = False,
    ) -> list[dict[str, Any]]:
        return await self._client.search(
            query,
            limit=limit,
            proximity=proximity,
            country_codes=country_codes,
            strict_bounds=strict_bounds,
        )


__all__ = [
    "GeocodingService",
    "NominatimClient",
    "get_empty_location_schema",
    "parse_nominatim_response",
]
