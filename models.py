"""Pydantic models for request validation and API responses in the street.

coverage tracking application.

This module contains Pydantic models used for data validation and defining
API response structures across the application.
"""

from datetime import datetime
from typing import Annotated, Any

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
    """Represents a single coordinate point with timestamp and optional speed."""

    timestamp: datetime
    lat: float
    lon: float
    speed: float | None = None

    class Config:
        extra = "allow"


# In models.py - Update the TripDataModel
class TripDataModel(BaseModel):
    """Represents the data structure of a trip document as returned from the database,.

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
    """Response model for when no active trip is found (or it's not newer than requested.

    sequence).
    """

    status: str = "success"
    has_active_trip: bool = False
    message: str = "No active trip"
    server_time: datetime


ActiveTripResponseUnion = ActiveTripSuccessResponse | NoActiveTripResponse


class VehicleModel(BaseModel):
    """Model for vehicle management with custom naming and status."""

    id: PyObjectId | None = Field(alias="_id", default=None)
    imei: str  # Device identifier from Bouncie
    vin: str | None = None  # Vehicle Identification Number
    custom_name: str | None = None  # User-friendly name
    make: str | None = None
    model: str | None = None
    year: int | None = None
    is_active: bool = True  # Whether vehicle is actively tracked
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        populate_by_name = True
        extra = "allow"


class GasFillupModel(BaseModel):
    """Model for gas fill-up records."""

    id: PyObjectId | None = Field(alias="_id", default=None)
    imei: str  # Device/vehicle identifier
    vin: str | None = None
    fillup_time: datetime  # When the fill-up occurred
    timezone: str | None = None

    # Location data
    latitude: float | None = None
    longitude: float | None = None
    location_address: str | None = None
    station_name: str | None = None

    # Fill-up details
    gallons: float  # Amount of gas purchased
    price_per_gallon: float | None = None  # Price per gallon
    total_cost: float | None = None  # Total cost of fill-up

    # Odometer and calculations
    odometer: float | None = None  # Odometer reading at fill-up
    previous_odometer: float | None = None  # Previous fill-up odometer
    miles_since_last_fillup: float | None = None
    calculated_mpg: float | None = None  # MPG since last fill-up

    # Metadata
    is_full_tank: bool = Field(
        True, description="Whether the tank was filled completely"
    )
    missed_previous: bool = Field(
        False,
        description="Whether a previous fill-up was missed/forgotten, resetting MPG stats",
    )
    notes: str | None = None
    detected_automatically: bool = False  # Whether detected via ML/geocoding
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    class Config:
        populate_by_name = True
        extra = "allow"


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


class GasStatisticsModel(BaseModel):
    """Model for gas consumption statistics."""

    imei: str | None = None
    total_fillups: int
    total_gallons: float
    total_cost: float
    average_mpg: float | None = None
    average_price_per_gallon: float | None = None
    cost_per_mile: float | None = None
    period_start: datetime | None = None
    period_end: datetime | None = None

    class Config:
        extra = "allow"
