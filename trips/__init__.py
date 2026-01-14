"""
Trip tracking and management package.

This package provides modular functionality for:
- Trip querying and filtering
- Trip CRUD operations
- Trip statistics and geocoding
- Trip gas cost calculations

The package is organized into:
- routes/: API endpoint handlers organized by domain
- services/: Business logic and data processing
- serializers.py: Data transformation utilities
"""

from fastapi import APIRouter

from trips.routes import crud, pages, query, stats

# Create main router that aggregates all trip-related routes
router = APIRouter()

# Include all sub-routers
router.include_router(pages.router, tags=["pages"])
router.include_router(query.router, tags=["trips-query"])
router.include_router(crud.router, tags=["trips-crud"])
router.include_router(stats.router, tags=["trips-stats"])

__all__ = ["router"]
