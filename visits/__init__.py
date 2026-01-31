"""
Visits and places module for the street coverage application.

This module provides modular functionality for:
- Custom place management (CRUD operations)
- Visit detection and tracking
- Visit statistics and analytics
- Visit suggestions based on frequently visited areas

The package is organized into:
- api/: API endpoint handlers organized by domain
- services/: Business logic and data processing
"""

from fastapi import APIRouter

from visits.api import places, stats, visits

# Create main router that aggregates all visit-related routes
# Note: No prefix here since individual routes already have /api/ paths
router = APIRouter(tags=["visits"])

# Include all sub-routers
# Note: We don't add prefix here since each route already has /api/ prefix
router.include_router(places.router, tags=["places"])
router.include_router(visits.router, tags=["visits"])
router.include_router(stats.router, tags=["statistics"])
