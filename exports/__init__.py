"""
Exports package for trip and coverage data export functionality.

This package provides streamlined export functionality including:
- Trip exports (GeoJSON, CSV with field filtering)
- Streets exports with coverage status
- Boundary exports
- Undriven streets exports
- Streaming support for large datasets

The package is organized into:
- routes/: API endpoint handlers
- services/: Streaming and data transformation services
"""

from fastapi import APIRouter

from exports.routes.domain_exports import router as domain_router
from exports.routes.trips import router as trips_router

# Create main router that aggregates all export-related routes
router = APIRouter()

router.include_router(trips_router, tags=["trip-exports"])
router.include_router(domain_router, tags=["coverage-exports"])

__all__ = ["router"]
