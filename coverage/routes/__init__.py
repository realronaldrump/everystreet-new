"""Coverage routes package.

Contains all API route handlers organized by domain:
    - areas: Coverage area CRUD operations
    - streets: Street segment operations and queries
    - calculation: Coverage calculation triggering and status
    - custom_boundary: Custom boundary validation and processing
    - optimal_routes: Optimal route generation and export
"""

from coverage.routes import (
    areas,
    calculation,
    custom_boundary,
    optimal_routes,
    streets,
)

__all__ = [
    "areas",
    "streets",
    "calculation",
    "custom_boundary",
    "optimal_routes",
]
