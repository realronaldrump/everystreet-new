"""Gas tracking and vehicle management package.

This package provides modular functionality for:
- Vehicle management (CRUD operations)
- Gas fill-up tracking with automatic MPG calculations
- Vehicle location and odometer estimation
- Gas consumption statistics
- Bouncie API integration for real-time vehicle data

The package is organized into:
- routes/: API endpoint handlers organized by domain
- services/: Business logic and data processing
- serializers.py: Data transformation utilities
"""

from fastapi import APIRouter

from gas.routes import fillups, location, statistics, vehicles

# Create main router that aggregates all gas-related routes
router = APIRouter()

# Include all sub-routers
router.include_router(vehicles.router, tags=["vehicles"])
router.include_router(fillups.router, tags=["gas-fillups"])
router.include_router(location.router, tags=["vehicle-location"])
router.include_router(statistics.router, tags=["gas-statistics"])

__all__ = ["router"]
