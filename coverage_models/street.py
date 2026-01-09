"""Street model for immutable street segments.

Streets are static geometry segments within an area version.
They are created during area ingestion and are immutable for a given version.
Coverage status is tracked separately in coverage_state collection.
"""

from datetime import UTC, datetime
from typing import Annotated, Any

from bson import ObjectId
from pydantic import BaseModel, BeforeValidator, Field

PyObjectId = Annotated[str, BeforeValidator(str)]


class Street(BaseModel):
    """Immutable street segment within an area version.

    Streets contain static geometry and properties from OSM.
    Dynamic coverage status is tracked in CoverageState.
    """

    id: PyObjectId | None = Field(alias="_id", default=None)
    area_id: PyObjectId
    area_version: int

    # Stable segment identifier: "{area_id}-{version}-{sequence}"
    segment_id: str

    # Geometry
    geometry: dict[str, Any]  # GeoJSON LineString
    bbox: list[float]  # [minLon, minLat, maxLon, maxLat]

    # Properties from OSM
    street_name: str | None = None
    highway: str  # OSM highway type (residential, primary, etc.)
    osm_id: int | None = None
    segment_length_m: float

    # Set at ingestion time based on highway type
    undriveable: bool = False

    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    class Config:
        populate_by_name = True


class StreetCreate(BaseModel):
    """Model for creating a new street segment during ingestion."""

    area_id: str
    area_version: int
    segment_id: str
    geometry: dict[str, Any]
    bbox: list[float]
    street_name: str | None = None
    highway: str
    osm_id: int | None = None
    segment_length_m: float
    undriveable: bool = False


def street_to_doc(street: Street) -> dict[str, Any]:
    """Convert Street model to MongoDB document."""
    doc = street.model_dump(by_alias=True, exclude_none=False)
    if doc.get("_id"):
        doc["_id"] = ObjectId(doc["_id"])
    else:
        doc.pop("_id", None)
    if doc.get("area_id"):
        doc["area_id"] = ObjectId(doc["area_id"])
    return doc


def doc_to_street(doc: dict[str, Any]) -> Street:
    """Convert MongoDB document to Street model."""
    if doc.get("_id"):
        doc["_id"] = str(doc["_id"])
    if doc.get("area_id"):
        doc["area_id"] = str(doc["area_id"])
    return Street.model_validate(doc)


def compute_bbox(geometry: dict[str, Any]) -> list[float]:
    """Compute bounding box from GeoJSON LineString geometry."""
    coords = geometry.get("coordinates", [])
    if not coords:
        return [0.0, 0.0, 0.0, 0.0]

    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]

    return [min(lons), min(lats), max(lons), max(lats)]


# Highway types that are typically not driveable
UNDRIVEABLE_HIGHWAY_TYPES = frozenset(
    {
        "footway",
        "pedestrian",
        "steps",
        "path",
        "cycleway",
        "bridleway",
        "corridor",
        "elevator",
        "escalator",
        "proposed",
        "construction",
        "abandoned",
        "platform",
        "raceway",
    }
)


def is_undriveable_highway(highway: str) -> bool:
    """Determine if a highway type is typically not driveable."""
    return highway.lower() in UNDRIVEABLE_HIGHWAY_TYPES
