"""
Coverage system data models.

This module defines the new unified coverage data model with clear separation
between static (Street) and dynamic (CoverageState) concerns.

Key models:
- CoverageArea: Geographic area for coverage tracking
- Street: Static street geometry (immutable per area version)
- CoverageState: Dynamic coverage status per segment
- Job: Unified job tracking for all background work
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from beanie import Document, Indexed, PydanticObjectId
from beanie.odm.fields import IndexModel
from pydantic import Field


class CoverageArea(Document):
    """
    A geographic area for street coverage tracking.

    Represents a coverage area with user-facing status and cached
    statistics.
    """

    # Identity
    display_name: Indexed(str, unique=True)
    area_type: str = "city"  # "city", "county", "state", "custom"

    # Boundary
    boundary: dict[str, Any] = Field(default_factory=dict)  # GeoJSON Polygon
    bounding_box: list[float] = Field(
        default_factory=list,
    )  # [min_lon, min_lat, max_lon, max_lat]

    # User-facing status (simple, non-technical)
    status: str = "initializing"  # "initializing", "ready", "error", "rebuilding"
    health: str = "unavailable"  # "healthy", "degraded", "unavailable"

    # Timestamps
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    last_synced: datetime | None = None  # Last time coverage was updated from a trip

    # Cached Statistics (always in miles for user display)
    total_length_miles: float = 0.0
    driveable_length_miles: float = 0.0
    driven_length_miles: float = 0.0
    coverage_percentage: float = 0.0
    total_segments: int = 0
    driven_segments: int = 0

    # Internal tracking
    area_version: int = 1  # Incremented on OSM refresh/rebuild
    osm_fetched_at: datetime | None = None
    last_error: str | None = None

    # Optimal route (cached, on-demand)
    optimal_route: dict[str, Any] | None = None
    optimal_route_generated_at: datetime | None = None

    class Settings:
        name = "coverage_areas"
        indexes = [
            IndexModel(
                [("status", 1)],
                name="coverage_areas_status_idx",
            ),
            IndexModel(
                [("osm_fetched_at", 1)],
                name="coverage_areas_osm_fetched_idx",
            ),
        ]

    class Config:
        extra = "allow"


class Street(Document):
    """
    Static street segment geometry derived from OSM.

    This is immutable for a given area version. Geometry and properties
    don't change unless the area is rebuilt with new OSM data.

    Coverage status is NOT stored here - see CoverageState for that.
    """

    # Identity
    segment_id: str  # "{area_id}-{version}-{seq}" - unique within area
    area_id: Indexed(PydanticObjectId)
    area_version: int

    # Static Geometry
    geometry: dict[str, Any] = Field(default_factory=dict)  # GeoJSON LineString

    # Static Properties (from OSM, immutable per version)
    street_name: str | None = None
    highway_type: str = "unclassified"  # residential, primary, secondary, etc.
    osm_id: int | None = None
    length_miles: float = 0.0

    class Settings:
        name = "streets"
        indexes = [
            IndexModel(
                [("area_id", 1), ("segment_id", 1)],
                name="streets_area_segment_unique_idx",
                unique=True,
            ),
            IndexModel(
                [("area_id", 1), ("geometry", "2dsphere")],
                name="streets_area_geo_idx",
            ),
            IndexModel(
                [("area_id", 1), ("area_version", 1)],
                name="streets_area_version_idx",
            ),
        ]

    class Config:
        extra = "allow"


class CoverageState(Document):
    """
    Dynamic coverage status for a street segment.

    This is the mutable state that changes when trips are driven or when
    users manually mark segments. Geometry is NOT stored here.
    """

    # Keys
    area_id: Indexed(PydanticObjectId)
    segment_id: str  # References Street.segment_id

    # Status
    status: str = "undriven"  # "undriven", "driven", "undriveable"

    # Provenance - how did this segment get marked?
    last_driven_at: datetime | None = None
    first_driven_at: datetime | None = None
    driven_by_trip_id: PydanticObjectId | None = None

    # Manual override tracking
    manually_marked: bool = False
    marked_at: datetime | None = None

    class Settings:
        name = "coverage_state"
        indexes = [
            IndexModel(
                [("area_id", 1), ("segment_id", 1)],
                name="coverage_state_area_segment_unique_idx",
                unique=True,
            ),
            IndexModel(
                [("area_id", 1), ("status", 1)],
                name="coverage_state_area_status_idx",
            ),
        ]

    class Config:
        extra = "allow"


class Job(Document):
    """
    Unified job status tracking for all background work.

    This replaces ProgressStatus and OptimalRouteProgress with a single
    consistent model for all job types.
    """

    # Identity
    job_type: (
        str  # "area_ingestion", "coverage_update", "route_generation", "area_rebuild"
    )
    area_id: PydanticObjectId | None = None

    # State
    status: str = (
        "pending"  # "pending", "running", "completed", "failed", "needs_attention"
    )
    stage: str = "Queued"  # User-friendly stage name
    progress: float = 0.0  # 0-100
    message: str = ""

    # Timing
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    completed_at: datetime | None = None

    # Error handling with retry
    error: str | None = None
    retry_count: int = 0
    max_retries: int = 3

    class Settings:
        name = "jobs"
        indexes = [
            IndexModel(
                [("area_id", 1), ("job_type", 1)],
                name="jobs_area_type_idx",
            ),
            IndexModel(
                [("status", 1)],
                name="jobs_status_idx",
            ),
            IndexModel(
                [("created_at", -1)],
                name="jobs_created_idx",
            ),
        ]

    class Config:
        extra = "allow"
