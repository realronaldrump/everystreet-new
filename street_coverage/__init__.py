"""
Coverage package for street coverage tracking.

Coverage updates are executed in-process during trip ingestion via the
TripPipeline and core.coverage utilities. This package focuses on:
    - models: Data models (CoverageArea, Street, CoverageState, Job)
    - constants: Fixed system constants (segment length, buffers, etc.)
    - ingestion: Area creation and OSM data fetching
    - stats: Statistics aggregation
    - api: API endpoints

Usage:
    # Create a new coverage area
    from street_coverage.ingestion import create_area
    area = await create_area("Waco, TX")
"""

from __future__ import annotations

from importlib import import_module

from db.models import CoverageArea, CoverageState, Job, Street
from street_coverage.constants import (
    MATCH_BUFFER_METERS,
    MIN_OVERLAP_METERS,
    SEGMENT_LENGTH_METERS,
)

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
    "rebuild_area",
    # Stats
    "update_area_stats",
]

_LAZY_IMPORTS: dict[str, tuple[str, str | None]] = {
    "create_area": ("street_coverage.ingestion", "create_area"),
    "delete_area": ("street_coverage.ingestion", "delete_area"),
    "rebuild_area": ("street_coverage.ingestion", "rebuild_area"),
    "update_area_stats": ("street_coverage.stats", "update_area_stats"),
    "ingestion": ("street_coverage.ingestion", None),
    "stats": ("street_coverage.stats", None),
    "api": ("street_coverage.api", None),
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
