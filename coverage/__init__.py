"""Coverage package - Modular coverage area management system.

This package contains all coverage-related functionality organized into
logical modules for better maintainability and testability.

Modules:
    - serializers: Data serialization utilities
    - gridfs_service: GridFS operations for GeoJSON storage
    - services: Business logic services (stats, segment marking, geometry)
    - routes: API route handlers organized by domain
"""

from coverage.gridfs_service import gridfs_service
from coverage.services import (coverage_stats_service, geometry_service,
                               segment_marking_service)

__all__ = [
    "gridfs_service",
    "coverage_stats_service",
    "segment_marking_service",
    "geometry_service",
]
