"""Pydantic models for request validation and API responses in the street
coverage tracking application.

This module contains Pydantic models used for data validation and defining
API response structures across the application.
"""

from datetime import datetime
from typing import Annotated, Any, Union

from pydantic import BaseModel, BeforeValidator, Field

PyObjectId = Annotated[str, BeforeValidator(str)]


class LocationModel(BaseModel):
    """Model for location data."""

    display_name: str
    osm_id: int
    osm_type: str
    segment_length_meters: int | None = (
        None  # Optional override for street segmentation length
    )
    match_buffer_meters: float | None = (
        None  # Optional buffer radius for trip→street match
    )
    min_match_length_meters: float | None = None  # Optional minimum overlap length

    class Config:
        extra = "allow"


class CustomBoundaryModel(BaseModel):
    """Model for custom drawn boundary data."""

    display_name: str
    boundary_type: str = "custom"
    geometry: dict[str, Any]  # GeoJSON geometry
    area_name: str
    segment_length_meters: int | None = None  # Optional segmentation length override
    match_buffer_meters: float | None = None
    min_match_length_meters: float | None = None

    class Config:
        extra = "allow"


class DeleteCoverageAreaModel(BaseModel):
    """Model for deleting a coverage area, requiring only the display name."""

    display_name: str


class DateRangeModel(BaseModel):
    """Model for date range data."""

    start_date: str
    end_date: str
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
    """Represents a single coordinate point with timestamp and optional speed"""

    timestamp: datetime
    lat: float
    lon: float
    speed: float | None = None

    class Config:
        extra = "allow"


# In models.py - Update the TripDataModel
class TripDataModel(BaseModel):
    """Represents the data structure of a trip document as returned from the database,
    prepared for API responses. Includes fields observed in live_tracking.py.
    """

    id: PyObjectId = Field(alias="_id")
    transactionId: str | None = None
    vin: str | None = None
    imei: str | None = None
    status: str | None = None
    startTime: datetime | None = None
    startTimeZone: str | None = None
    startOdometer: float | None = None
    endTime: datetime | None = None
    endTimeZone: str | None = None
    endOdometer: float | None = None
    # Support both formats
    gps: dict[str, Any] | None = None  # GeoJSON format
    coordinates: list[CoordinatePointModel] = Field(
        default_factory=list
    )  # Frontend format
    lastUpdate: datetime | None = None
    distance: float | None = None
    currentSpeed: float | None = None
    maxSpeed: float | None = None
    avgSpeed: float | None = None
    duration: float | None = None
    pointsRecorded: int | None = None
    sequence: int | None = None
    totalIdlingTime: float | None = None
    hardBrakingCounts: int | None = None
    hardAccelerationCounts: int | None = None
    fuelConsumed: float | None = None
    closed_reason: str | None = None

    class Config:
        populate_by_name = True
        extra = "allow"


class ActiveTripSuccessResponse(BaseModel):
    """Response model for when an active trip is successfully found."""

    status: str = "success"
    has_active_trip: bool = True
    trip: TripDataModel
    server_time: datetime


class NoActiveTripResponse(BaseModel):
    """Response model for when no active trip is found (or it's not newer than requested
    sequence).
    """

    status: str = "success"
    has_active_trip: bool = False
    message: str = "No active trip"
    server_time: datetime


ActiveTripResponseUnion = Union[
    ActiveTripSuccessResponse,
    NoActiveTripResponse,
]

# Add new model for app settings


class AppSettingsModel(BaseModel):
    """Persistent application settings stored on the server.

    Currently only stores the WebSocket preference but can be extended.
    """

    disableWebSockets: bool = Field(
        False, description="Disable WebSocket live updates and use polling instead."
    )

    class Config:
        extra = "allow"
        schema_extra = {
            "example": {
                "disableWebSockets": False,
            },
        }
