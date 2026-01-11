"""Coverage package - Modular coverage area management system.

This package contains all coverage-related functionality organized into
logical modules for better maintainability and testability.

Modules:
    - calculator: Coverage calculation engine
    - constants: Configuration constants
    - geojson_generator: GeoJSON generation and GridFS storage
    - gridfs_service: GridFS operations for GeoJSON streaming
    - serializers: Data serialization utilities
    - services: Business logic services (stats, segment marking, geometry)
    - routes: API route handlers organized by domain
"""

from coverage.calculator import (
    CoverageCalculator,
    compute_coverage_for_location,
    compute_incremental_coverage,
)
from coverage.geojson_generator import generate_and_store_geojson
from coverage.gridfs_service import gridfs_service
from coverage.services import (
    coverage_stats_service,
    geometry_service,
    segment_marking_service,
)

__all__ = [
    # Calculator
    "CoverageCalculator",
    "compute_coverage_for_location",
    "compute_incremental_coverage",
    "coverage_stats_service",
    "generate_and_store_geojson",
    "geometry_service",
    # Services
    "gridfs_service",
    "segment_marking_service",
]
