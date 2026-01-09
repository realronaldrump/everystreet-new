"""Area model for geographic coverage tracking.

An Area represents a geographic region for street coverage tracking.
It can be created from an OSM location search or a custom-drawn boundary.
"""

from datetime import UTC, datetime
from enum import Enum
from typing import Annotated, Any

from bson import ObjectId
from pydantic import BaseModel, BeforeValidator, Field

PyObjectId = Annotated[str, BeforeValidator(str)]


class AreaType(str, Enum):
    """Type of area source."""

    OSM = "osm"
    CUSTOM = "custom"


class AreaStatus(str, Enum):
    """Area processing status."""

    INITIALIZING = "initializing"
    INGESTING = "ingesting"
    READY = "ready"
    ERROR = "error"


class AreaStats(BaseModel):
    """Cached statistics for an area.

    These are denormalized for fast reads and recomputed
    from coverage_state during sanity checks.
    """

    total_segments: int = 0
    covered_segments: int = 0
    total_length_m: float = 0.0
    driven_length_m: float = 0.0
    driveable_length_m: float = 0.0
    coverage_percentage: float = 0.0
    street_types: list[dict[str, Any]] = Field(default_factory=list)
    last_computed_at: datetime | None = None


class Area(BaseModel):
    """Geographic area for coverage tracking.

    Represents a unified area that can be either an OSM location
    or a custom-drawn boundary. All areas go through the same
    ingestion, indexing, and coverage tracking pipeline.
    """

    id: PyObjectId | None = Field(alias="_id", default=None)
    display_name: str
    area_type: AreaType

    # Boundary geometry
    boundary: dict[str, Any]  # GeoJSON Polygon or MultiPolygon
    bbox: list[float]  # [minLon, minLat, maxLon, maxLat]

    # OSM-specific fields (optional)
    osm_id: int | None = None
    osm_type: str | None = None

    # Configuration
    segment_length_m: float = 46.0  # ~150 feet
    match_buffer_m: float = 15.0  # ~50 feet
    min_match_length_m: float = 4.5  # ~15 feet

    # Versioning
    current_version: int = 1
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    # Health tracking
    status: AreaStatus = AreaStatus.INITIALIZING
    last_error: str | None = None
    last_ingestion_at: datetime | None = None
    last_coverage_sync_at: datetime | None = None

    # Cached aggregates
    cached_stats: AreaStats = Field(default_factory=AreaStats)

    class Config:
        populate_by_name = True
        use_enum_values = True


class AreaCreate(BaseModel):
    """Request model for creating a new area.

    Accepts either OSM location data or custom boundary geometry.
    """

    display_name: str
    area_type: AreaType

    # For OSM areas
    osm_id: int | None = None
    osm_type: str | None = None

    # For custom areas - GeoJSON geometry
    geometry: dict[str, Any] | None = None

    # Optional configuration overrides (feet or meters)
    segment_length_feet: float | None = None
    segment_length_meters: float | None = None
    match_buffer_feet: float | None = None
    match_buffer_meters: float | None = None
    min_match_length_feet: float | None = None
    min_match_length_meters: float | None = None

    class Config:
        use_enum_values = True

    def get_segment_length_m(self) -> float:
        """Get segment length in meters, with feet taking priority."""
        if self.segment_length_feet is not None:
            return self.segment_length_feet * 0.3048
        if self.segment_length_meters is not None:
            return self.segment_length_meters
        return 46.0  # Default ~150 feet

    def get_match_buffer_m(self) -> float:
        """Get match buffer in meters, with feet taking priority."""
        if self.match_buffer_feet is not None:
            return self.match_buffer_feet * 0.3048
        if self.match_buffer_meters is not None:
            return self.match_buffer_meters
        return 15.0  # Default ~50 feet

    def get_min_match_length_m(self) -> float:
        """Get min match length in meters, with feet taking priority."""
        if self.min_match_length_feet is not None:
            return self.min_match_length_feet * 0.3048
        if self.min_match_length_meters is not None:
            return self.min_match_length_meters
        return 4.5  # Default ~15 feet


def area_to_doc(area: Area) -> dict[str, Any]:
    """Convert Area model to MongoDB document."""
    doc = area.model_dump(by_alias=True, exclude_none=False)
    if doc.get("_id"):
        doc["_id"] = ObjectId(doc["_id"])
    else:
        doc.pop("_id", None)
    return doc


def doc_to_area(doc: dict[str, Any]) -> Area:
    """Convert MongoDB document to Area model."""
    if doc.get("_id"):
        doc["_id"] = str(doc["_id"])
    return Area.model_validate(doc)
