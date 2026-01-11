"""Main ExternalGeoService class combining geocoding and map matching functionality."""

from typing import Any

from .geocoding import GeocodingService
from .map_matching import MapMatchingService
from .schemas import get_empty_location_schema
from .timestamp_utils import extract_timestamps_for_coordinates


class ExternalGeoService:
    """
    Service for external geocoding and map matching APIs.

    Handles all external API calls to Mapbox and Nominatim for geocoding and map
    matching operations. This is a facade that combines GeocodingService and
    MapMatchingService for backwards compatibility.
    """

    def __init__(self, mapbox_token: str | None = None):
        """
        Initialize the geo service.

        Args:
            mapbox_token: Optional Mapbox access token for geocoding and map matching
        """
        self.mapbox_token = mapbox_token
        self._geocoding = GeocodingService(mapbox_token)
        self._map_matching = MapMatchingService(mapbox_token)

    # Geocoding methods (delegated)

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
        return await self._geocoding.reverse_geocode(lat, lon)

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
        return self._geocoding.parse_geocode_response(response, coordinates)

    @staticmethod
    def get_empty_location_schema() -> dict[str, Any]:
        """
        Get empty location schema structure.

        Returns:
            Empty location schema dictionary
        """
        return get_empty_location_schema()

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
        return await GeocodingService.forward_geocode_nominatim(
            query,
            limit,
            proximity,
            country_codes,
        )

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
        return await self._geocoding.forward_geocode_mapbox(
            query,
            limit,
            proximity,
            country,
        )

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
        return await self._geocoding.forward_geocode(
            query,
            limit,
            proximity,
            prefer_mapbox,
        )

    # Map matching methods (delegated)

    async def map_match_coordinates(
        self,
        coordinates: list[list[float]],
        timestamps: list[int | None] | None = None,
        chunk_size: int = 100,
        overlap: int = 15,
        max_retries: int = 3,
        min_sub_chunk: int = 20,
        jump_threshold_m: float = 200.0,
    ) -> dict[str, Any]:
        """
        Map match coordinates using the Mapbox API.

        Args:
            coordinates: List of [lon, lat] coordinates
            timestamps: Optional list of Unix timestamps
            chunk_size: Maximum coordinates per API request (max 100)
            overlap: Overlap between chunks for better stitching
            max_retries: Maximum retries for failed chunks
            min_sub_chunk: Minimum coordinates for recursive splitting
            jump_threshold_m: Threshold for detecting jumps in meters

        Returns:
            Dictionary with map matching results
        """
        return await self._map_matching.map_match_coordinates(
            coordinates,
            timestamps,
            chunk_size,
            overlap,
            max_retries,
            min_sub_chunk,
            jump_threshold_m,
        )

    @staticmethod
    def extract_timestamps_for_coordinates(
        coordinates: list[list[float]],
        trip_data: dict[str, Any],
    ) -> list[int | None]:
        """
        Extract timestamps for coordinates, interpolating if necessary.

        Args:
            coordinates: List of [lon, lat] coordinates
            trip_data: Trip data containing optional timestamp info

        Returns:
            List of Unix timestamps or None values
        """
        return extract_timestamps_for_coordinates(coordinates, trip_data)
