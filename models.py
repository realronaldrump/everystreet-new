"""Pydantic models for request validation and API responses.

This module contains Pydantic models used for data validation and defining
API response structures across the street coverage tracking application.
"""

from datetime import datetime
from typing import Annotated, Any, Union

from pydantic import BaseModel, BeforeValidator, Field, validator

PyObjectId = Annotated[str, BeforeValidator(str)]


class BaseConfigMixin:
    """Common configuration for all models."""

    extra = "allow"
    populate_by_name = True


class LocationModel(BaseModel):
    """Model for location data with validation."""

    display_name: str = Field(..., min_length=1, description="Location display name")
    osm_id: int = Field(..., gt=0, description="OpenStreetMap ID")
    osm_type: str = Field(..., description="OpenStreetMap type")

    class Config(BaseConfigMixin):
        pass

    @validator("osm_type")
    def validate_osm_type(cls, v):
        """Validate OSM type is one of the expected values."""
        valid_types = {"node", "way", "relation"}
        if v not in valid_types:
            raise ValueError(f"osm_type must be one of {valid_types}")
        return v


class DeleteCoverageAreaModel(BaseModel):
    """Model for deleting a coverage area."""

    display_name: str = Field(..., min_length=1, description="Location display name")

    class Config(BaseConfigMixin):
        pass


class TripUpdateModel(BaseModel):
    """Model for trip update data with geometry validation."""

    type: str = Field(..., description="Update type")
    geometry: dict[str, Any] | None = Field(None, description="GeoJSON geometry")
    properties: dict[str, Any] = Field(
        default_factory=dict, description="Trip properties"
    )

    class Config(BaseConfigMixin):
        pass

    @validator("geometry")
    def validate_geometry(cls, v):
        """Validate GeoJSON geometry structure if provided."""
        if v is not None:
            required_fields = {"type", "coordinates"}
            if not isinstance(v, dict) or not required_fields.issubset(v.keys()):
                raise ValueError("geometry must be a valid GeoJSON geometry object")
        return v


class DateRangeModel(BaseModel):
    """Model for date range queries with validation."""

    start_date: str = Field(..., description="Start date (ISO format)")
    end_date: str = Field(..., description="End date (ISO format)")
    interval_days: int = Field(0, ge=0, description="Interval in days")

    class Config(BaseConfigMixin):
        pass

    @validator("start_date", "end_date")
    def validate_date_format(cls, v):
        """Validate date format."""
        try:
            datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("Date must be in ISO format")
        return v

    @validator("end_date")
    def validate_date_range(cls, v, values):
        """Validate that end_date is after start_date."""
        if "start_date" in values:
            try:
                start = datetime.fromisoformat(
                    values["start_date"].replace("Z", "+00:00")
                )
                end = datetime.fromisoformat(v.replace("Z", "+00:00"))
                if end <= start:
                    raise ValueError("end_date must be after start_date")
            except ValueError as e:
                if "after start_date" in str(e):
                    raise
        return v


class BulkProcessModel(BaseModel):
    """Model for bulk processing parameters with constraints."""

    query: dict[str, Any] = Field(default_factory=dict, description="MongoDB query")
    options: dict[str, bool] = Field(
        default_factory=dict, description="Processing options"
    )
    limit: int = Field(100, gt=0, le=10000, description="Maximum items to process")

    class Config(BaseConfigMixin):
        pass


class TaskConfigModel(BaseModel):
    """Base model for task configuration."""

    enabled: bool = Field(True, description="Whether task is enabled")
    interval_minutes: int = Field(60, gt=0, description="Task interval in minutes")

    class Config(BaseConfigMixin):
        pass


class BackgroundTasksConfigModel(BaseModel):
    """Model for background tasks configuration."""

    global_disable: bool | None = Field(
        None, alias="globalDisable", description="Global disable flag"
    )
    tasks: dict[str, dict[str, Any]] | None = Field(
        None, description="Task-specific configurations"
    )

    class Config(BaseConfigMixin):
        pass


class TaskRunModel(BaseModel):
    """Model for manual task execution."""

    tasks: list[str] = Field(..., min_items=1, description="List of task IDs to run")

    class Config(BaseConfigMixin):
        pass

    @validator("tasks")
    def validate_task_list(cls, v):
        """Validate task list contains no duplicates."""
        if len(v) != len(set(v)):
            raise ValueError("Task list must not contain duplicates")
        return v


class ValidateLocationModel(BaseModel):
    """Model for location validation requests."""

    location: str = Field(..., min_length=1, description="Location name")
    location_type: str = Field(..., alias="locationType", description="Location type")

    class Config(BaseConfigMixin):
        pass


class CollectionModel(BaseModel):
    """Model for collection operations."""

    collection: str = Field(..., min_length=1, description="Collection name")

    class Config(BaseConfigMixin):
        pass


class CoordinatePointModel(BaseModel):
    """Represents a single coordinate point with validation."""

    timestamp: datetime = Field(..., description="Point timestamp")
    lat: float = Field(..., ge=-90, le=90, description="Latitude")
    lon: float = Field(..., ge=-180, le=180, description="Longitude")
    speed: float | None = Field(None, ge=0, description="Speed in appropriate units")

    class Config(BaseConfigMixin):
        pass


class TripDataModel(BaseModel):
    """Comprehensive trip data model with validation."""

    id: PyObjectId = Field(alias="_id", description="Trip ID")
    transaction_id: str | None = Field(
        None, alias="transactionId", description="Transaction ID"
    )
    vin: str | None = Field(None, description="Vehicle identification number")
    imei: str | None = Field(None, description="Device IMEI")
    status: str | None = Field(None, description="Trip status")

    # Time fields
    start_time: datetime | None = Field(
        None, alias="startTime", description="Trip start time"
    )
    start_time_zone: str | None = Field(
        None, alias="startTimeZone", description="Start timezone"
    )
    end_time: datetime | None = Field(
        None, alias="endTime", description="Trip end time"
    )
    end_time_zone: str | None = Field(
        None, alias="endTimeZone", description="End timezone"
    )
    last_update: datetime | None = Field(
        None, alias="lastUpdate", description="Last update time"
    )

    # Odometer readings
    start_odometer: float | None = Field(
        None, alias="startOdometer", ge=0, description="Start odometer reading"
    )
    end_odometer: float | None = Field(
        None, alias="endOdometer", ge=0, description="End odometer reading"
    )

    # Coordinate data
    coordinates: list[CoordinatePointModel] = Field(
        default_factory=list, description="Trip coordinates"
    )

    # Metrics
    distance: float | None = Field(None, ge=0, description="Trip distance")
    current_speed: float | None = Field(
        None, alias="currentSpeed", ge=0, description="Current speed"
    )
    max_speed: float | None = Field(
        None, alias="maxSpeed", ge=0, description="Maximum speed"
    )
    avg_speed: float | None = Field(
        None, alias="avgSpeed", ge=0, description="Average speed"
    )
    duration: float | None = Field(None, ge=0, description="Trip duration")
    points_recorded: int | None = Field(
        None, alias="pointsRecorded", ge=0, description="Number of points"
    )
    sequence: int | None = Field(None, ge=0, description="Sequence number")

    # Additional metrics
    total_idling_time: float | None = Field(
        None, alias="totalIdlingTime", ge=0, description="Total idling time"
    )
    hard_braking_counts: int | None = Field(
        None,
        alias="hardBrakingCounts",
        ge=0,
        description="Hard braking events",
    )
    hard_acceleration_counts: int | None = Field(
        None,
        alias="hardAccelerationCounts",
        ge=0,
        description="Hard acceleration events",
    )
    fuel_consumed: float | None = Field(
        None, alias="fuelConsumed", ge=0, description="Fuel consumed"
    )
    closed_reason: str | None = Field(
        None, alias="closed_reason", description="Trip closure reason"
    )

    class Config(BaseConfigMixin):
        pass

    @validator("end_odometer")
    def validate_odometer_readings(cls, v, values):
        """Validate that end odometer is greater than start odometer."""
        if (
            v is not None
            and "start_odometer" in values
            and values["start_odometer"] is not None
        ):
            if v < values["start_odometer"]:
                raise ValueError(
                    "end_odometer must be greater than or equal to start_odometer"
                )
        return v


class BaseResponseModel(BaseModel):
    """Base response model with common fields."""

    status: str = Field(..., description="Response status")
    server_time: datetime = Field(
        default_factory=lambda: datetime.now(), description="Server timestamp"
    )

    class Config(BaseConfigMixin):
        pass


class ActiveTripSuccessResponse(BaseResponseModel):
    """Response model for successful active trip retrieval."""

    status: str = Field("success", description="Response status")
    has_active_trip: bool = Field(True, description="Whether active trip exists")
    trip: TripDataModel = Field(..., description="Active trip data")


class NoActiveTripResponse(BaseResponseModel):
    """Response model for no active trip found."""

    status: str = Field("success", description="Response status")
    has_active_trip: bool = Field(False, description="Whether active trip exists")
    message: str = Field("No active trip", description="Status message")


# Union type for active trip responses
ActiveTripResponseUnion = Union[ActiveTripSuccessResponse, NoActiveTripResponse]
