"""
Mapping provider interfaces for geocoding and routing abstractions.
"""

from typing import Any, Protocol


class Geocoder(Protocol):
    """Interface for geocoding services (address <-> coordinates)."""

    async def reverse(
        self,
        lat: float,
        lon: float,
        *,
        zoom: int = 18,
    ) -> dict[str, Any] | None:
        """Reverse geocode a coordinate into an address."""
        ...

    async def search(
        self,
        query: str,
        *,
        limit: int = 5,
        proximity: tuple[float, float] | None = None,
        country_codes: str | None = "us",
        strict_bounds: bool = False,
    ) -> list[dict[str, Any]]:
        """Search for a place by name, returning standardized results."""
        ...

    async def search_raw(
        self,
        *,
        query: str,
        limit: int = 1,
        polygon_geojson: bool = False,
        addressdetails: bool = True,
    ) -> list[dict[str, Any]]:
        """Search for a place and return raw provider results."""
        ...

    async def lookup_raw(
        self,
        *,
        osm_id: int | str,
        osm_type: str,
        polygon_geojson: bool = True,
        addressdetails: bool = True,
    ) -> list[dict[str, Any]]:
        """Lookup a specific feature by its OSM ID (or provider equivalent)."""
        ...


class Router(Protocol):
    """Interface for routing services (directions and map matching)."""

    async def route(
        self,
        locations: list[tuple[float, float]] | list[list[float]],
        *,
        costing: str = "auto",
        timeout_s: float | None = None,
    ) -> dict[str, Any]:
        """Calculate a route between two or more locations."""
        ...

    async def trace_route(
        self,
        shape: list[dict[str, float | int | str]],
        *,
        costing: str = "auto",
        use_timestamps: bool | None = None,
    ) -> dict[str, Any]:
        """Snap a GPS trace to the road network (map matching)."""
        ...

    async def status(self) -> dict[str, Any]:
        """Check the health status of the routing engine."""
        ...


class MappingProvider(Protocol):
    """Factory interface for instantiating the right mapping components."""

    @property
    def geocoder(self) -> Geocoder: ...

    @property
    def router(self) -> Router: ...
