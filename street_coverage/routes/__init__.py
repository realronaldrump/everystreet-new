"""
Coverage routes package.

Contains all API route handlers organized by domain:
    - areas: Coverage area CRUD operations
    - streets: Street segment viewport-based retrieval
    - jobs: Background job status tracking
    - optimal_routes: Optimal route generation and export
"""

from street_coverage.routes import areas, jobs, optimal_routes, streets

__all__ = [
    "areas",
    "jobs",
    "optimal_routes",
    "streets",
]
