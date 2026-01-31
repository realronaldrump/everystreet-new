"""Coverage API package.

Contains API route handlers organized by domain:
    - areas: Coverage area CRUD operations
    - streets: Street segment viewport-based retrieval
    - jobs: Background job status tracking
    - optimal_routes: Optimal route generation and export
"""

import logging

from fastapi import APIRouter

from . import areas, jobs, optimal_routes, streets

logger = logging.getLogger(__name__)
router = APIRouter()

router.include_router(areas.router)
router.include_router(streets.router)
router.include_router(jobs.router)
router.include_router(optimal_routes.router, tags=["optimal-routes"])

logger.info("Coverage API routes loaded successfully")

__all__ = [
    "areas",
    "jobs",
    "optimal_routes",
    "router",
    "streets",
]
