"""
Map Data Management Module.

This module provides functionality for managing OSM data used by
Nominatim (geocoding) and Valhalla (routing) services.

Key features:
- Browse and download OSM extracts from Geofabrik
- Build Nominatim and Valhalla data from downloaded extracts
- Monitor service health
- Track download and build progress
"""

from map_data.models import GeoServiceHealth, MapDataJob, MapRegion

__all__ = ["GeoServiceHealth", "MapDataJob", "MapRegion"]
