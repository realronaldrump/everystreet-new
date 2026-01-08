"""Visits and places module for the street coverage application.

This module provides modular functionality for:
- Custom place management (CRUD operations)
- Visit detection and tracking
- Visit statistics and analytics
- Visit suggestions based on frequently visited areas

The package is organized into:
- routes/: API endpoint handlers organized by domain
- services/: Business logic and data processing
"""

from fastapi import APIRouter

from visits.routes import places, stats, visits
from visits.services.place_service import Collections

# Create main router that aggregates all visit-related routes
router = APIRouter(tags=["visits"])

# Include all sub-routers
# Note: We don't add prefix here since each route already has /api/ prefix
router.include_router(places.router, tags=["places"])
router.include_router(visits.router, tags=["visits"])
router.include_router(stats.router, tags=["statistics"])


def init_collections(places_coll, trips_coll):
    """Initialize the database collections for this module.

    Args:
        places_coll: MongoDB collection for places
        trips_coll: MongoDB collection for trips
    """
    Collections.places = places_coll
    Collections.trips = trips_coll


__all__ = ["router", "init_collections"]
