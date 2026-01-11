"""Geocoding services for forward and reverse geocoding."""

import logging
import urllib.parse
from typing import Any

from core.http.geocoding import reverse_geocode_mapbox, reverse_geocode_nominatim
from core.http.session import get_session

from .rate_limiting import mapbox_rate_limiter
from .schemas import (
    get_empty_location_schema,
    parse_mapbox_response,
    parse_nominatim_response,
)

logger = logging.getLogger(__name__)


class GeocodingService:
    """Service for forward and reverse geocoding using Mapbox and Nominatim APIs."""

    def __init__(self, mapbox_token: str | None = None):
        """
        Initialize the geocoding service.

        Args:
            mapbox_token: Optional Mapbox access token for geocoding
        """
        self.mapbox_token = mapbox_token

    async def reverse_geocode(
        self,
        lat: float,
        lon: float,
    ) -> dict[str, Any] | None:
        """
        Reverse geocode coordinates using Mapbox or Nominatim fallback.

        Args:
            lat: Latitude
            lon: Longitude

        Returns:
            Geocoding result dictionary or None if failed
        """
        result = None

        if self.mapbox_token:
            async with mapbox_rate_limiter:
                result = await reverse_geocode_mapbox(
                    lat,
                    lon,
                    self.mapbox_token,
                )

        # Fallback to Nominatim if Mapbox failed or not configured
        if not result:
            result = await reverse_geocode_nominatim(lat, lon)

        return result

    def parse_geocode_response(
        self,
        response: dict[str, Any],
        coordinates: list[float],
    ) -> dict[str, Any]:
        """
        Parse geocoding response into structured location schema.

        Args:
            response: Raw geocoding API response
            coordinates: [lon, lat] coordinates

        Returns:
            Structured location data
        """
        # Handle Mapbox response format
        if self.mapbox_token and "place_name" in response:
            return parse_mapbox_response(response, coordinates)

        # Handle Nominatim response format
        if "display_name" in response:
            return parse_nominatim_response(response, coordinates)

        # Return empty schema if format not recognized
        structured = get_empty_location_schema()
        structured["coordinates"]["lng"] = coordinates[0]
        structured["coordinates"]["lat"] = coordinates[1]
        return structured

    @staticmethod
    async def forward_geocode_nominatim(
        query: str,
        limit: int = 5,
        proximity: tuple[float, float] | None = None,
        country_codes: str = "us",
    ) -> list[dict[str, Any]]:
        """
        Forward geocode a query using Nominatim (OSM) API.

        Args:
            query: Search query string
            limit: Maximum number of results
            proximity: Optional (longitude, latitude) tuple to bias results
            country_codes: Comma-separated country codes to limit results

        Returns:
            List of normalized geocoding results
        """
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

        headers = {"User-Agent": "EveryStreet/1.0"}
        session = await get_session()

        try:
            async with session.get(
                "https://nominatim.openstreetmap.org/search",
                params=params,
                headers=headers,
                timeout=10,
            ) as response:
                response.raise_for_status()
                results = await response.json()

                normalized = []
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
        except Exception as e:
            logger.warning("Nominatim forward geocoding error: %s", e)
            return []

    async def forward_geocode_mapbox(
        self,
        query: str,
        limit: int = 5,
        proximity: tuple[float, float] | None = None,
        country: str = "US",
    ) -> list[dict[str, Any]]:
        """
        Forward geocode a query using Mapbox Geocoding API.

        Args:
            query: Search query string
            limit: Maximum number of results
            proximity: Optional (longitude, latitude) tuple to bias results
            country: Country code to limit results

        Returns:
            List of normalized geocoding results
        """
        if not self.mapbox_token:
            logger.warning("Mapbox token not configured for forward geocoding")
            return []

        encoded_query = urllib.parse.quote(query)
        url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{encoded_query}.json"
        params: dict[str, Any] = {
            "access_token": self.mapbox_token,
            "limit": limit,
            "country": country,
        }

        if proximity:
            params["proximity"] = f"{proximity[0]},{proximity[1]}"
        else:
            params["proximity"] = "-99.9018,31.9686"

        session = await get_session()

        try:
            async with (
                mapbox_rate_limiter,
                session.get(url, params=params, timeout=10) as response,
            ):
                response.raise_for_status()
                data = await response.json()

                results = []
                for feature in data.get("features", []):
                    results.append(
                        {
                            "place_name": feature.get("place_name", ""),
                            "center": feature.get("center", []),
                            "place_type": feature.get("place_type", []),
                            "text": feature.get("text", ""),
                            "bbox": feature.get("bbox"),
                            "context": feature.get("context", []),
                        },
                    )
                return results
        except Exception as e:
            logger.warning("Mapbox forward geocoding error: %s", e)
            return []

    async def forward_geocode(
        self,
        query: str,
        limit: int = 5,
        proximity: tuple[float, float] | None = None,
        prefer_mapbox: bool | None = None,
    ) -> list[dict[str, Any]]:
        """
        Forward geocode with automatic fallback (Mapbox -> Nominatim).

        Args:
            query: Search query string
            limit: Maximum number of results
            proximity: Optional (longitude, latitude) tuple to bias results
            prefer_mapbox: If True, use Mapbox; if False, use Nominatim;
                          if None, use Mapbox if token is configured

        Returns:
            List of normalized geocoding results
        """
        use_mapbox = self.mapbox_token and (
            prefer_mapbox is None or prefer_mapbox is True
        )

        if use_mapbox:
            results = await self.forward_geocode_mapbox(query, limit, proximity)
            if results:
                return results
            # Fallback to Nominatim if Mapbox returns empty
            logger.info("Mapbox returned no results, falling back to Nominatim")

        return await self.forward_geocode_nominatim(query, limit, proximity)
