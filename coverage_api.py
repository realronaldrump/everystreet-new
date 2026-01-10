"""Coverage API - Main router integration.

This file now serves as a thin integration layer that imports and combines
all the modular route handlers from the coverage package.
"""

import logging

from fastapi import APIRouter

from coverage.routes import areas, calculation, custom_boundary, optimal_routes, streets

logger = logging.getLogger(__name__)
router = APIRouter()

# Include all route modules
router.include_router(areas.router, tags=["coverage-areas"])
router.include_router(streets.router, tags=["streets"])
router.include_router(calculation.router, tags=["calculation"])
router.include_router(custom_boundary.router, tags=["custom-boundary"])
router.include_router(optimal_routes.router, tags=["optimal-routes"])

logger.info("Coverage API routes loaded successfully from modular structure")
