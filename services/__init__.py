"""Services package for the unified coverage system.

This package contains business logic services:
- JobManager: Unified job tracking and progress updates
- AreaManager: Area CRUD and lifecycle management
- IngestionService: OSM data fetching and street segmentation
- CoverageService: Trip-to-street matching and coverage updates
- TripEventService: TripCompleted event handling
- RoutingService: On-demand route generation
- RebuildService: Area rebuild and sanity check operations
"""

from services.job_manager import JobManager

__all__ = [
    "JobManager",
]
