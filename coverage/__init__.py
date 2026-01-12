"""Coverage package - Event-driven street coverage tracking system.

This package provides automatic coverage tracking when trips are completed.
It uses an event-driven architecture where trip completion triggers coverage
updates automatically.

Key modules:
    - models: Data models (CoverageArea, Street, CoverageState, Job)
    - constants: Fixed system constants (segment length, buffers, etc.)
    - ingestion: Area creation and OSM data fetching
    - matching: Trip-to-street geometric matching
    - events: Event system for trip/coverage coordination
    - worker: Event handlers that process coverage updates
    - stats: Statistics aggregation
    - routes: API endpoints

Usage:
    # Register event handlers on app startup
    from coverage.events import register_handlers
    register_handlers()

    # Create a new coverage area
    from coverage.ingestion import create_area
    area, job = await create_area("Waco, TX", user_id)

    # Trip completion triggers automatic coverage update via events
    from coverage.events import emit_trip_completed
    await emit_trip_completed(trip_id, user_id)
"""

from coverage.constants import (
    MATCH_BUFFER_METERS,
    MIN_OVERLAP_METERS,
    SEGMENT_LENGTH_METERS,
)
from coverage.events import emit_trip_completed, register_handlers
from coverage.ingestion import create_area, delete_area, rebuild_area
from coverage.models import CoverageArea, CoverageState, Job, Street
from coverage.stats import update_area_stats

__all__ = [
    "MATCH_BUFFER_METERS",
    "MIN_OVERLAP_METERS",
    # Constants
    "SEGMENT_LENGTH_METERS",
    # Models
    "CoverageArea",
    "CoverageState",
    "Job",
    "Street",
    # Ingestion
    "create_area",
    "delete_area",
    "emit_trip_completed",
    "rebuild_area",
    # Events
    "register_handlers",
    # Stats
    "update_area_stats",
]
