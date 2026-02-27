"""
Local mapping provider wrapping the self-hosted Nominatim and Valhalla containers.
"""

from typing import Any

from core.http.nominatim import NominatimClient
from core.http.valhalla import ValhallaClient
from core.mapping.interfaces import Geocoder, MappingProvider, Router


class LocalProvider(MappingProvider):
    """Mapping provider utilizing self-hosted OSM data."""

    def __init__(self) -> None:
        self._geocoder = NominatimClient()
        self._router = ValhallaClient()

    @property
    def geocoder(self) -> Geocoder:
        return self._geocoder

    @property
    def router(self) -> Router:
        return self._router
