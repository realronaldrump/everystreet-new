"""CoverageState model for dynamic coverage tracking.

CoverageState tracks the mutable coverage status of street segments.
It is keyed by (area_id, area_version, segment_id) and updated
when trips are processed or manual overrides are applied.
"""

from datetime import UTC, datetime
from enum import Enum
from typing import Annotated, Any

from bson import ObjectId
from pydantic import BaseModel, BeforeValidator, Field

PyObjectId = Annotated[str, BeforeValidator(str)]


class CoverageStatus(str, Enum):
    """Status of a street segment."""

    UNDRIVEN = "undriven"
    DRIVEN = "driven"
    UNDRIVEABLE = "undriveable"


class ProvenanceType(str, Enum):
    """Source of the coverage status update."""

    TRIP = "trip"
    MANUAL = "manual"
    SYSTEM = "system"


class Provenance(BaseModel):
    """Tracks the source of a coverage status update."""

    type: ProvenanceType
    trip_id: str | None = None  # If type="trip"
    user_note: str | None = None  # If type="manual"
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    class Config:
        use_enum_values = True


class CoverageState(BaseModel):
    """Dynamic coverage status for a street segment.

    Tracks whether a segment has been driven, when, and by which trip.
    Supports manual overrides that persist across automated updates.
    """

    id: PyObjectId | None = Field(alias="_id", default=None)
    area_id: PyObjectId
    area_version: int
    segment_id: str  # Links to streets.segment_id

    status: CoverageStatus = CoverageStatus.UNDRIVEN
    last_driven_at: datetime | None = None

    # Provenance tracking
    provenance: Provenance | None = None

    # Manual override protection
    manual_override: bool = False
    manual_override_at: datetime | None = None

    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    class Config:
        populate_by_name = True
        use_enum_values = True


class CoverageStateCreate(BaseModel):
    """Model for creating a new coverage state entry."""

    area_id: str
    area_version: int
    segment_id: str
    status: CoverageStatus = CoverageStatus.UNDRIVEN
    undriveable: bool = False  # If true, status is set to UNDRIVEABLE

    class Config:
        use_enum_values = True


class CoverageStateUpdate(BaseModel):
    """Model for updating coverage state."""

    status: CoverageStatus
    trip_id: str | None = None
    user_note: str | None = None
    is_manual: bool = False

    class Config:
        use_enum_values = True


def coverage_state_to_doc(state: CoverageState) -> dict[str, Any]:
    """Convert CoverageState model to MongoDB document."""
    doc = state.model_dump(by_alias=True, exclude_none=False)
    if doc.get("_id"):
        doc["_id"] = ObjectId(doc["_id"])
    else:
        doc.pop("_id", None)
    if doc.get("area_id"):
        doc["area_id"] = ObjectId(doc["area_id"])
    return doc


def doc_to_coverage_state(doc: dict[str, Any]) -> CoverageState:
    """Convert MongoDB document to CoverageState model."""
    if doc.get("_id"):
        doc["_id"] = str(doc["_id"])
    if doc.get("area_id"):
        doc["area_id"] = str(doc["area_id"])
    return CoverageState.model_validate(doc)


def create_initial_coverage_state(
    area_id: str,
    area_version: int,
    segment_id: str,
    undriveable: bool = False,
) -> dict[str, Any]:
    """Create initial coverage state document for a new segment."""
    now = datetime.now(UTC)
    status = CoverageStatus.UNDRIVEABLE if undriveable else CoverageStatus.UNDRIVEN

    return {
        "area_id": ObjectId(area_id),
        "area_version": area_version,
        "segment_id": segment_id,
        "status": status.value,
        "last_driven_at": None,
        "provenance": {
            "type": ProvenanceType.SYSTEM.value,
            "trip_id": None,
            "user_note": "Initial state from ingestion",
            "updated_at": now,
        },
        "manual_override": False,
        "manual_override_at": None,
        "updated_at": now,
    }
