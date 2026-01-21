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
    from street_coverage.events import register_handlers
    register_handlers()

    # Create a new coverage area
    from street_coverage.ingestion import create_area
    area, job = await create_area("Waco, TX", user_id)

    # Trip completion triggers automatic coverage update via events
    from street_coverage.events import emit_trip_completed
    await emit_trip_completed(trip_id, user_id)
"""

from __future__ import annotations

from importlib import import_module

from street_coverage.constants import (
    MATCH_BUFFER_METERS,
    MIN_OVERLAP_METERS,
    SEGMENT_LENGTH_METERS,
)
from street_coverage.models import CoverageArea, CoverageState, Job, Street

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

_LAZY_IMPORTS: dict[str, tuple[str, str | None]] = {
    "create_area": ("street_coverage.ingestion", "create_area"),
    "delete_area": ("street_coverage.ingestion", "delete_area"),
    "rebuild_area": ("street_coverage.ingestion", "rebuild_area"),
    "emit_trip_completed": ("street_coverage.events", "emit_trip_completed"),
    "register_handlers": ("street_coverage.events", "register_handlers"),
    "update_area_stats": ("street_coverage.stats", "update_area_stats"),
    "ingestion": ("street_coverage.ingestion", None),
    "worker": ("street_coverage.worker", None),
    "stats": ("street_coverage.stats", None),
    "routes": ("street_coverage.routes", None),
}


def __getattr__(name: str):
    target = _LAZY_IMPORTS.get(name)
    if not target:
        msg = f"module {__name__!r} has no attribute {name!r}"
        raise AttributeError(msg)

    module_name, attr_name = target
    module = import_module(module_name)
    return module if attr_name is None else getattr(module, attr_name)


def __dir__():
    return sorted(set(globals()) | set(_LAZY_IMPORTS))
