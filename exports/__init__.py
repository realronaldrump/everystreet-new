"""
Exports package for export job handling and data serialization.

This package provides export job creation, progress tracking, and
artifact delivery for current trips and coverage data.
"""

from fastapi import APIRouter

from exports.routes import exports_router

# Create main router that aggregates all export-related routes
router = APIRouter()

router.include_router(exports_router, tags=["exports"])

__all__ = ["router"]
