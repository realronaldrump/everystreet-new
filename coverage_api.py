"""Coverage API - Main router integration.

This file serves as the integration layer that imports and combines
all the modular route handlers from the coverage package.

The new coverage system is event-driven with automatic updates:
- Areas are added by name, automatically ingested
- Coverage updates automatically when trips complete
- Street data is retrieved via viewport-based queries
"""

import logging

from fastapi import APIRouter

from coverage.routes import areas, jobs, legacy, optimal_routes, streets

logger = logging.getLogger(__name__)
router = APIRouter()

# Include all route modules
router.include_router(areas.router)
router.include_router(streets.router)
router.include_router(jobs.router)
router.include_router(optimal_routes.router, tags=["optimal-routes"])
router.include_router(legacy.router)

logger.info("Coverage API routes loaded successfully")
