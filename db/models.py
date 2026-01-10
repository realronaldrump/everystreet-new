"""Beanie ODM document models for MongoDB collections.

This module defines all document models using Beanie ODM, which provides:
- Automatic Pydantic validation
- Built-in async CRUD operations
- Proper ObjectId/datetime serialization
- Index definitions at the model level

Usage:
    from db.models import Trip, CoverageMetadata, Street

    # Find a trip
    trip = await Trip.find_one(Trip.transactionId == "abc123")

    # Insert a new document
    trip = Trip(transactionId="abc", ...)
    await trip.insert()

    # Update
    trip.status = "completed"
    await trip.save()
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from beanie import Document, Indexed
from pydantic import Field
from pymongo import DESCENDING


class Trip(Document):
    """Trip document representing a driving trip record."""

    transactionId: Indexed(str, unique=True) | None = None
    vin: str | None = None
    imei: str | None = None
    status: str | None = None
    startTime: datetime | None = None
    startTimeZone: str | None = None
    startOdometer: float | None = None
    endTime: datetime | None = None
    endTimeZone: str | None = None
    endOdometer: float | None = None
    gps: dict[str, Any] | None = None
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

    # Matched GPS data (consolidated from matched_trips)
    matchedGps: dict[str, Any] | None = None
    matchStatus: str | None = None
    matched_at: datetime | None = None

    # Place associations
    startGeoPoint: dict[str, Any] | None = None
    destinationGeoPoint: dict[str, Any] | None = None
    destinationPlaceId: str | None = None
    destinationPlaceName: str | None = None

    class Settings:
        name = "trips"
        use_state_management = True

    class Config:
        extra = "allow"


class MatchedTrip(Document):
    """Matched trip document with map-matched GPS coordinates."""

    transactionId: Indexed(str, unique=True) | None = None
    startTime: Indexed(datetime) | None = None
    matchedGps: dict[str, Any] | None = None
    matchStatus: str | None = None
    matched_at: datetime | None = None

    class Settings:
        name = "matched_trips"

    class Config:
        extra = "allow"


class LiveTrip(Document):
    """Live trip document for real-time tracking."""

    transactionId: str | None = None
    imei: str | None = None
    status: str | None = None
    startTime: datetime | None = None
    endTime: datetime | None = None
    gps: dict[str, Any] | None = None
    lastUpdate: datetime | None = None
    currentSpeed: float | None = None
    sequence: int | None = None

    class Settings:
        name = "live_trips"

    class Config:
        extra = "allow"


class ArchivedLiveTrip(Document):
    """Archived live trip document."""

    transactionId: str | None = None
    imei: str | None = None
    status: str | None = None
    startTime: datetime | None = None
    endTime: datetime | None = None
    gps: dict[str, Any] | None = None
    archived_at: datetime | None = None

    class Settings:
        name = "archived_live_trips"

    class Config:
        extra = "allow"


class CoverageMetadata(Document):
    """Coverage area metadata document."""

    location: dict[str, Any] = Field(default_factory=dict)
    display_name: str | None = None
    status: str | None = None
    total_streets: int | None = None
    driven_streets: int | None = None
    coverage_percentage: float | None = None
    total_length_miles: float | None = None
    driven_length_miles: float | None = None
    last_updated: datetime | None = None
    last_calculated: datetime | None = None
    boundary: dict[str, Any] | None = None
    streets_geojson_id: str | None = None

    # Configuration fields
    segment_length_feet: float | None = None
    segment_length_meters: float | None = None
    match_buffer_feet: float | None = None
    match_buffer_meters: float | None = None
    min_match_length_feet: float | None = None
    min_match_length_meters: float | None = None

    class Settings:
        name = "coverage_metadata"

    class Config:
        extra = "allow"


class Street(Document):
    """Street segment document with GeoJSON geometry."""

    properties: dict[str, Any] = Field(default_factory=dict)
    geometry: dict[str, Any] = Field(default_factory=dict)
    type: str = "Feature"

    class Settings:
        name = "streets"

    class Config:
        extra = "allow"


class OsmData(Document):
    """OpenStreetMap data cache document."""

    location: str | None = None
    data: dict[str, Any] | None = None
    fetched_at: datetime | None = None

    class Settings:
        name = "osm_data"

    class Config:
        extra = "allow"


class Place(Document):
    """Place/location document for visit tracking."""

    name: str | None = None
    location: dict[str, Any] | None = None
    address: str | None = None
    category: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    visit_count: int = 0

    class Settings:
        name = "places"

    class Config:
        extra = "allow"


class TaskConfig(Document):
    """Task configuration document for scheduled tasks."""

    task_id: Indexed(str) | None = None
    enabled: bool = True
    interval_minutes: int | None = None
    last_run: datetime | None = None
    next_run: datetime | None = None
    status: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)

    class Settings:
        name = "task_config"

    class Config:
        extra = "allow"


class TaskHistory(Document):
    """Task execution history document."""

    task_id: Indexed(str) | None = None
    timestamp: Indexed(datetime, index_type=DESCENDING) | None = None
    status: str | None = None
    duration_seconds: float | None = None
    result: dict[str, Any] | None = None
    error: str | None = None

    class Settings:
        name = "task_history"

    class Config:
        extra = "allow"


class ProgressStatus(Document):
    """Progress status document for long-running operations."""

    operation_id: str | None = None
    operation_type: str | None = None
    status: str | None = None
    progress: float = 0.0
    message: str | None = None
    started_at: datetime | None = None
    updated_at: datetime | None = None
    completed_at: datetime | None = None
    result: dict[str, Any] | None = None

    class Settings:
        name = "progress_status"

    class Config:
        extra = "allow"


class OptimalRouteProgress(Document):
    """Optimal route calculation progress document."""

    location: str | None = None
    status: str | None = None
    progress: float = 0.0
    route: dict[str, Any] | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    class Settings:
        name = "optimal_route_progress"

    class Config:
        extra = "allow"


class GasFillup(Document):
    """Gas fillup record document."""

    imei: Indexed(str) | None = None
    fillup_time: Indexed(datetime) | None = None
    gallons: float | None = None
    price_per_gallon: float | None = None
    total_cost: float | None = None
    odometer: float | None = None
    latitude: float | None = None
    longitude: float | None = None
    is_full_tank: bool = True
    notes: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None

    class Settings:
        name = "gas_fillups"

    class Config:
        extra = "allow"


class Vehicle(Document):
    """Vehicle document for fleet management."""

    imei: Indexed(str, unique=True)
    vin: str | None = None
    custom_name: str | None = None
    make: str | None = None
    model: str | None = None
    year: int | None = None
    is_active: bool = True
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    class Settings:
        name = "vehicles"

    class Config:
        extra = "allow"


class AppSettings(Document):
    """Application settings document."""

    key: Indexed(str, unique=True)
    value: Any = None
    updated_at: datetime | None = None

    class Settings:
        name = "app_settings"

    class Config:
        extra = "allow"


class ServerLog(Document):
    """Server log document for MongoDB logging handler."""

    timestamp: Indexed(datetime, index_type=DESCENDING) | None = None
    level: str | None = None
    logger_name: str | None = None
    message: str | None = None
    pathname: str | None = None
    lineno: int | None = None
    funcName: str | None = None
    exc_info: str | None = None

    class Settings:
        name = "server_logs"

    class Config:
        extra = "allow"


# List of all document models for Beanie initialization
ALL_DOCUMENT_MODELS = [
    Trip,
    MatchedTrip,
    LiveTrip,
    ArchivedLiveTrip,
    CoverageMetadata,
    Street,
    OsmData,
    Place,
    TaskConfig,
    TaskHistory,
    ProgressStatus,
    OptimalRouteProgress,
    GasFillup,
    Vehicle,
    AppSettings,
    ServerLog,
]
