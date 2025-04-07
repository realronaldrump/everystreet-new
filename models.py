"""Pydantic models for request validation and API responses in the street
coverage tracking application.

This module contains Pydantic models used for data validation and defining
API response structures across the application.
"""

from datetime import datetime
from typing import Annotated, Any, Dict, List, Optional, Union

from pydantic import BaseModel, BeforeValidator, Field

PyObjectId = Annotated[str, BeforeValidator(str)]


class LocationModel(BaseModel):
    """Model for location data."""

    display_name: str
    osm_id: int
    osm_type: str

    class Config:
        extra = "allow"


class TripUpdateModel(BaseModel):
    """Model for trip update data."""

    type: str
    geometry: Optional[Dict[str, Any]] = None
    properties: Dict[str, Any] = Field(default_factory=dict)


class DateRangeModel(BaseModel):
    """Model for date range data."""

    start_date: str
    end_date: str
    interval_days: int = 0


class BulkProcessModel(BaseModel):
    """Model for bulk processing parameters."""

    query: Dict[str, Any] = Field(default_factory=dict)
    options: Dict[str, bool] = Field(default_factory=dict)
    limit: int = 100


class BackgroundTasksConfigModel(BaseModel):
    """Model for background tasks configuration."""

    globalDisable: Optional[bool] = None
    tasks: Optional[Dict[str, Dict[str, Any]]] = None


class TaskRunModel(BaseModel):
    """Model for manual task run."""

    tasks: List[str]


class ValidateLocationModel(BaseModel):
    """Model for location validation."""

    location: str
    locationType: str


class CollectionModel(BaseModel):
    """Model for collection operations."""

    collection: str


class CoordinatePointModel(BaseModel):
    """Represents a single coordinate point with timestamp and optional speed"""

    timestamp: datetime
    lat: float
    lon: float
    speed: Optional[float] = None

    class Config:
        extra = "allow"


class TripDataModel(BaseModel):
    """
    Represents the data structure of a trip document as returned from the database,
    prepared for API responses. Includes fields observed in live_tracking.py.
    """

    id: PyObjectId = Field(alias="_id")
    transactionId: Optional[str] = None
    vin: Optional[str] = None
    imei: Optional[str] = None
    status: Optional[str] = None
    startTime: Optional[datetime] = None
    startTimeZone: Optional[str] = None
    startOdometer: Optional[float] = None
    endTime: Optional[datetime] = None
    endTimeZone: Optional[str] = None
    endOdometer: Optional[float] = None
    coordinates: List[CoordinatePointModel] = Field(default_factory=list)
    lastUpdate: Optional[datetime] = None
    distance: Optional[float] = None
    currentSpeed: Optional[float] = None
    maxSpeed: Optional[float] = None
    avgSpeed: Optional[float] = None
    duration: Optional[float] = None
    pointsRecorded: Optional[int] = None
    sequence: Optional[int] = None
    totalIdlingTime: Optional[int] = None
    hardBrakingCounts: Optional[int] = None
    hardAccelerationCounts: Optional[int] = None
    fuelConsumed: Optional[float] = None
    closed_reason: Optional[str] = None

    class Config:
        populate_by_name = True
        extra = "allow"


class ActiveTripSuccessResponse(BaseModel):
    """
    Response model for when an active trip is successfully found.
    """

    status: str = "success"
    has_active_trip: bool = True
    trip: TripDataModel
    server_time: datetime


class NoActiveTripResponse(BaseModel):
    """
    Response model for when no active trip is found (or it's not newer than requested sequence).
    """

    status: str = "success"
    has_active_trip: bool = False
    message: str = "No active trip"
    server_time: datetime


ActiveTripResponseUnion = Union[
    ActiveTripSuccessResponse, NoActiveTripResponse
]
