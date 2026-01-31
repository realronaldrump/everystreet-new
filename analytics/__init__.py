"""
Analytics package for trip and dashboard analytics.

This package provides modular functionality for:
- Trip analytics and aggregations
- Time-based analytics and filtering
- Dashboard insights and metrics
- Driver behavior statistics

The package is organized into:
- api/: API endpoint handlers organized by domain
- services/: Business logic and data processing
"""

from fastapi import APIRouter

from analytics.api import dashboard, trips

# Create main router that aggregates all analytics-related routes
router = APIRouter()

# Include all sub-routers
router.include_router(trips.router, tags=["trip-analytics"])
router.include_router(dashboard.router, tags=["dashboard"])

__all__ = ["router"]
