"""
Coverage API package.

Contains API route handlers organized by domain:
    - areas: Coverage area CRUD operations
    - streets: Street segment viewport-based retrieval
    - jobs: Background job status tracking
    - optimal_routes: Optimal route generation and export
"""

import logging

from fastapi import APIRouter

from . import areas, intelligence, jobs, journal, optimal_routes, streets

logger = logging.getLogger(__name__)
router = APIRouter()

router.include_router(areas.router)
router.include_router(streets.router)
router.include_router(jobs.router)
router.include_router(optimal_routes.router, tags=["optimal-routes"])
router.include_router(journal.router)
router.include_router(intelligence.router)

logger.info("Coverage API routes loaded successfully")

__all__ = [
    "areas",
    "jobs",
    "journal",
    "intelligence",
    "optimal_routes",
    "router",
    "streets",
]
