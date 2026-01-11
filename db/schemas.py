"""
Pydantic schemas for request validation and API responses.

This module contains Pydantic models used for data validation across the application,
separating API-specific schemas from Beanie database documents.
"""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from db.models import Trip


class LocationModel(BaseModel):
    """Model for location data."""

    display_name: str
    osm_id: int
    osm_type: str

    # New fields for feet-based configuration
    segment_length_feet: float | None = None
    segment_length_meters: float | None = None
    match_buffer_feet: float | None = None
    match_buffer_meters: float | None = None
    min_match_length_feet: float | None = None
    min_match_length_meters: float | None = None

    class Config:
        extra = "allow"


class CustomBoundaryModel(BaseModel):
    """Model for custom drawn boundary data."""

    display_name: str
    boundary_type: str = "custom"
    geometry: dict[str, Any]  # GeoJSON geometry
    area_name: str

    # New fields for feet-based configuration
    segment_length_feet: float | None = None
    segment_length_meters: float | None = None
    match_buffer_feet: float | None = None
    match_buffer_meters: float | None = None
    min_match_length_feet: float | None = None
    min_match_length_meters: float | None = None

    class Config:
        extra = "allow"


class DeleteCoverageAreaModel(BaseModel):
    """Model for deleting a coverage area, requiring only the display name."""

    display_name: str


class DateRangeModel(BaseModel):
    """Model for date range data."""

    start_date: str = ""
    end_date: str = ""
    interval_days: int = 0


class BulkProcessModel(BaseModel):
    """Model for bulk processing parameters."""

    query: dict[str, Any] = Field(default_factory=dict)
    options: dict[str, bool] = Field(default_factory=dict)
    limit: int = 100


class BackgroundTasksConfigModel(BaseModel):
    """Model for background tasks configuration."""

    globalDisable: bool | None = None
    tasks: dict[str, dict[str, Any]] | None = None


class ValidateLocationModel(BaseModel):
    """Model for location validation."""

    location: str
    locationType: str


class ValidateCustomBoundaryModel(BaseModel):
    """Model for custom boundary validation."""

    area_name: str
    geometry: dict[str, Any]  # GeoJSON geometry


class CollectionModel(BaseModel):
    """Model for collection operations."""

    collection: str


class CoordinatePointModel(BaseModel):
    """Represents a single coordinate point with timestamp and optional speed."""

    timestamp: datetime
    lat: float
    lon: float
    speed: float | None = None

    class Config:
        extra = "allow"


class ActiveTripSuccessResponse(BaseModel):
    """Response model for when an active trip is successfully found."""

    status: str = "success"
    has_active_trip: bool = True
    trip: Trip  # Use Beanie Trip model directly
    server_time: datetime


class NoActiveTripResponse(BaseModel):
    """Response model for when no active trip is found."""

    status: str = "success"
    has_active_trip: bool = False
    message: str = "No active trip"
    server_time: datetime


ActiveTripResponseUnion = ActiveTripSuccessResponse | NoActiveTripResponse


class GasFillupCreateModel(BaseModel):
    """Model for creating a new gas fill-up record."""

    imei: str
    fillup_time: datetime | str  # Accept ISO string or datetime
    gallons: float
    price_per_gallon: float | None = None
    total_cost: float | None = None
    odometer: float | None = None
    latitude: float | None = None
    longitude: float | None = None
    is_full_tank: bool = True
    notes: str | None = None

    class Config:
        extra = "allow"


# ============================================================================
# Place Response Models - Beanie-compatible with automatic datetime serialization
# ============================================================================


class PlaceResponse(BaseModel):
    """Response model for a single place."""

    id: str = Field(..., description="Place ID")
    name: str
    geometry: dict[str, Any] | None = None
    created_at: datetime | None = None

    class Config:
        from_attributes = True


class PlaceStatisticsResponse(BaseModel):
    """Response model for place statistics."""

    id: str = Field(..., description="Place ID")
    name: str
    totalVisits: int = 0
    averageTimeSpent: str | None = None
    firstVisit: datetime | None = None
    lastVisit: datetime | None = None
    averageTimeSinceLastVisit: str | None = None


class VisitResponse(BaseModel):
    """Response model for a single visit."""

    id: str
    transactionId: str | None = None
    endTime: datetime | None = None
    departureTime: datetime | None = None
    timeSpent: str | None = None
    timeSinceLastVisit: str | None = None
    source: str | None = None
    distance: float | None = None


class PlaceVisitsResponse(BaseModel):
    """Response model for place visits."""

    trips: list[VisitResponse]
    name: str


class NonCustomPlaceVisit(BaseModel):
    """Response model for non-custom place visit statistics."""

    name: str
    totalVisits: int
    firstVisit: datetime | None = None
    lastVisit: datetime | None = None


class VisitSuggestion(BaseModel):
    """Response model for visit suggestions."""

    suggestedName: str
    totalVisits: int
    firstVisit: datetime | None = None
    lastVisit: datetime | None = None
    centroid: list[float]
    boundary: dict[str, Any]


class VehicleModel(BaseModel):
    """Model for vehicle data."""

    imei: str
    vin: str | None = None
    custom_name: str | None = None
    make: str | None = None
    model: str | None = None
    year: int | None = None
    is_active: bool = True

    class Config:
        extra = "allow"
