"""
Map Data Management Module.

This module provides functionality for managing OSM data used by
Nominatim (geocoding) and Valhalla (routing) services.

Key features:
- Browse and download OSM extracts from Geofabrik
- Build Nominatim and Valhalla data from downloaded extracts
- Monitor service health
- Track download and build progress
- Automatic state detection from trip data
- Auto-provisioning of map data for new trip regions
"""

from map_data.models import GeoServiceHealth, MapServiceConfig

__all__ = ["GeoServiceHealth", "MapServiceConfig"]
