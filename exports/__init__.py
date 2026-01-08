"""Exports package for trip and geo data export functionality.

This package provides modular export functionality including:
- Trip exports (GeoJSON, GPX, CSV, JSON, Shapefile)
- Streets and boundary exports
- Streaming support for large datasets
- Advanced configurable exports

The package is organized into:
- routes/: API endpoint handlers
- services/: Streaming and data transformation services
"""

from fastapi import APIRouter

from exports.routes import geo_router, trips_router

# Create main router that aggregates all export-related routes
router = APIRouter()

router.include_router(trips_router, tags=["trip-exports"])
router.include_router(geo_router, tags=["geo-exports"])

__all__ = ["router"]
