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
from pydantic import Field, field_validator
from pymongo import ASCENDING, DESCENDING, IndexModel

from date_utils import parse_timestamp


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

    # Validation fields
    invalid: bool | None = None
    validated_at: datetime | None = None
    validation_status: str | None = None
    validation_message: str | None = None

    # Frontend compatibility
    coordinates: list[dict[str, Any]] | None = Field(default_factory=list)

    @field_validator(
        "startTime",
        "endTime",
        "lastUpdate",
        "matched_at",
        "validated_at",
        mode="before",
    )
    @classmethod
    def parse_datetime_fields(cls, v: Any) -> datetime | None:
        """Parse datetime fields using the centralized date_utils."""
        if v is None:
            return None
        return parse_timestamp(v)

    @field_validator("gps", mode="before")
    @classmethod
    def validate_gps_data(cls, v: Any) -> dict[str, Any] | None:
        """Validate and standardize GPS data."""
        if v is None:
            return None

        # Handle string input
        if isinstance(v, str):
            try:
                import json

                v = json.loads(v)
            except json.JSONDecodeError:
                return None

        # Handle list input (convert to GeoJSON)
        if isinstance(v, list):
            # Basic coordinate validation helper
            def valid_coord(c):
                if not isinstance(c, list | tuple) or len(c) < 2:
                    return False
                try:
                    lon, lat = float(c[0]), float(c[1])
                    return -180 <= lon <= 180 and -90 <= lat <= 90
                except (ValueError, TypeError):
                    return False

            # Filter valid coordinates
            valid_coords = [c for c in v if valid_coord(c)]

            # Deduplicate consecutive points
            unique_coords = []
            for c in valid_coords:
                c_list = [float(c[0]), float(c[1])]
                if not unique_coords or c_list != unique_coords[-1]:
                    unique_coords.append(c_list)

            if not unique_coords:
                return None

            if len(unique_coords) == 1:
                return {"type": "Point", "coordinates": unique_coords[0]}
            return {"type": "LineString", "coordinates": unique_coords}

        # Handle dict input (GeoJSON)
        if isinstance(v, dict):
            if "type" not in v or "coordinates" not in v:
                return v  # Return as is, let Pydantic handle or skip

            geom_type = v["type"]
            coords = v["coordinates"]

            if geom_type not in ["Point", "LineString"]:
                return v

            if not isinstance(coords, list):
                return v

            # Validate based on type
            if geom_type == "Point":
                if len(coords) >= 2:
                    try:
                        lon, lat = float(coords[0]), float(coords[1])
                        if -180 <= lon <= 180 and -90 <= lat <= 90:
                            v["coordinates"] = [lon, lat]
                    except (ValueError, TypeError):
                        pass
            elif geom_type == "LineString":
                validated = []
                for point in coords:
                    if not isinstance(point, list) or len(point) < 2:
                        continue
                    try:
                        lon, lat = float(point[0]), float(point[1])
                        if -180 <= lon <= 180 and -90 <= lat <= 90:
                            validated.append([lon, lat])
                    except (ValueError, TypeError):
                        continue

                # Deduplicate
                final_coords = []
                for p in validated:
                    if not final_coords or p != final_coords[-1]:
                        final_coords.append(p)

                if final_coords:
                    if len(final_coords) == 1:
                        return {"type": "Point", "coordinates": final_coords[0]}
                    v["coordinates"] = final_coords

            return v

        return None

    def validate_meaningful(self) -> tuple[bool, str | None]:
        """Validate that a trip represents actual driving."""
        dist = self.distance if self.distance is not None else 0.0
        max_speed = self.maxSpeed if self.maxSpeed is not None else 0.0

        duration_minutes = 0.0
        if self.startTime and self.endTime:
            diff = (self.endTime - self.startTime).total_seconds()
            duration_minutes = diff / 60.0

        same_location = False
        if self.gps and self.gps.get("type") == "LineString":
            coords = self.gps.get("coordinates")
            if coords and len(coords) >= 2:
                first = coords[0]
                last = coords[-1]
                if (
                    abs(first[0] - last[0]) < 0.0005
                    and abs(first[1] - last[1]) < 0.0005
                ):
                    same_location = True
        elif self.gps and self.gps.get("type") == "Point":
            same_location = True

        is_stationary = False
        if (
            dist <= 0.05
            and same_location
            and max_speed <= 0.5
            and duration_minutes < 10
        ):
            is_stationary = True
        if dist <= 0.01 and duration_minutes < 2:
            is_stationary = True

        if is_stationary:
            msg = f"Stationary trip (distance: {dist:.2f} mi, duration: {duration_minutes:.1f} min)"
            return False, msg

        return True, None

    class Settings:
        name = "trips"
        use_state_management = True
        indexes = [
            IndexModel([("startTime", ASCENDING)], name="trips_startTime_asc_idx"),
            IndexModel([("endTime", ASCENDING)], name="trips_endTime_asc_idx"),
            IndexModel([("endTime", DESCENDING)], name="trips_endTime_desc_idx"),
            IndexModel([("gps", "2dsphere")], name="trips_gps_2dsphere_idx"),
            IndexModel(
                [("startGeoPoint", "2dsphere")], name="trips_startGeoPoint_2dsphere_idx"
            ),
            IndexModel(
                [("destinationGeoPoint", "2dsphere")],
                name="trips_destinationGeoPoint_2dsphere_idx",
            ),
            IndexModel(
                [
                    ("startGeoPoint", "2dsphere"),
                    ("destinationGeoPoint", "2dsphere"),
                    ("_id", 1),
                ],
                name="trips_coverage_query_idx",
            ),
            IndexModel(
                [("destinationPlaceId", ASCENDING)],
                name="trips_destinationPlaceId_idx",
                sparse=True,
            ),
            IndexModel(
                [("destinationPlaceName", ASCENDING)],
                name="trips_destinationPlaceName_idx",
                sparse=True,
            ),
        ]

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
        indexes = [
            IndexModel([("gps", "2dsphere")], name="archived_gps_2dsphere_idx"),
            IndexModel(
                [("transactionId", ASCENDING)],
                name="archived_transactionId_idx",
                unique=True,
            ),
            IndexModel([("endTime", ASCENDING)], name="archived_endTime_idx"),
        ]

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
        indexes = [
            IndexModel(
                [("location.display_name", ASCENDING)],
                name="coverage_metadata_display_name_idx",
                unique=True,
            ),
            IndexModel(
                [("status", ASCENDING), ("last_updated", ASCENDING)],
                name="coverage_metadata_status_updated_idx",
            ),
        ]

    class Config:
        extra = "allow"


class Street(Document):
    """Street segment document with GeoJSON geometry."""

    properties: dict[str, Any] = Field(default_factory=dict)
    geometry: dict[str, Any] = Field(default_factory=dict)
    type: str = "Feature"

    class Settings:
        name = "streets"
        indexes = [
            IndexModel(
                [("properties.location", ASCENDING), ("geometry", "2dsphere")],
                name="streets_location_geo_idx",
            ),
            IndexModel(
                [
                    ("properties.location", ASCENDING),
                    ("properties.segment_id", ASCENDING),
                ],
                name="streets_location_segment_id_unique_idx",
                unique=True,
            ),
        ]

    class Config:
        extra = "allow"


class OsmData(Document):
    """OpenStreetMap data cache document."""

    location: dict[str, Any] | None = None
    type: str | None = None
    geojson: dict[str, Any] | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    data: dict[str, Any] | None = None  # Legacy support if needed
    fetched_at: datetime | None = None

    class Settings:
        name = "osm_data"
        indexes = [
            IndexModel(
                [("location", ASCENDING), ("type", ASCENDING)],
                name="osm_data_location_type_idx",
            )
        ]

    class Config:
        extra = "allow"


class Place(Document):
    """Place/location document for visit tracking."""

    name: str | None = None
    geometry: dict[str, Any] | None = None  # GeoJSON geometry for custom places
    location: dict[str, Any] | None = None  # Legacy/alternative location field
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

    # Use string ID for celery task IDs (UUID strings)
    id: str | None = Field(default=None, alias="_id")
    task_id: Indexed(str) | None = None
    timestamp: Indexed(datetime, index_type=DESCENDING) | None = None
    status: str | None = None
    duration_seconds: float | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    manual_run: bool | None = None
    start_time: datetime | None = None
    end_time: datetime | None = None
    runtime: float | None = None

    class Settings:
        name = "task_history"
        indexes = [
            IndexModel(
                [("task_id", ASCENDING), ("timestamp", DESCENDING)],
                name="task_history_task_timestamp_idx",
            )
        ]

    class Config:
        extra = "allow"


class ProgressStatus(Document):
    """Progress status document for long-running operations."""

    # Use string ID for task_id (UUID strings)
    id: str | None = Field(default=None, alias="_id")
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
        indexes = [
            IndexModel(
                [("imei", ASCENDING), ("fillup_time", DESCENDING)],
                name="gas_fillups_imei_time_idx",
            ),
            IndexModel(
                [("fillup_time", DESCENDING)], name="gas_fillups_fillup_time_idx"
            ),
            IndexModel([("vin", ASCENDING)], name="gas_fillups_vin_idx", sparse=True),
        ]

    class Config:
        extra = "allow"


class Vehicle(Document):
    """Vehicle document for fleet management."""

    imei: str  # Removed Indexed wrapper to avoid default index creation
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
        indexes = [
            IndexModel([("imei", ASCENDING)], name="vehicles_imei_idx", unique=True),
            IndexModel([("vin", ASCENDING)], name="vehicles_vin_idx", sparse=True),
            IndexModel([("is_active", ASCENDING)], name="vehicles_is_active_idx"),
        ]

    class Config:
        extra = "allow"


class AppSettings(Document):
    """Application settings document."""

    # Use string ID to support legacy documents with string _id values
    id: str | None = Field(default=None, alias="_id")

    # We define specific fields for known settings to allow validation,
    # but allow extra fields for extensibility.
    mapbox_access_token: str | None = None
    clarity_project_id: str | None = None
    updated_at: datetime | None = None

    # Legacy key/value support if needed (optional)
    key: Indexed(str, unique=True) | None = None
    value: Any = None

    class Settings:
        name = "app_settings"
        use_state_management = True

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
        indexes = [
            IndexModel([("level", ASCENDING)], name="server_logs_level_idx"),
            IndexModel(
                [("timestamp", ASCENDING)],
                name="server_logs_ttl_idx",
                expireAfterSeconds=30 * 24 * 60 * 60,
            ),
        ]

    class Config:
        extra = "allow"


class BouncieCredentials(Document):
    """Bouncie API credentials document."""

    id: str = "bouncie_credentials"
    client_id: str | None = None
    client_secret: str | None = None
    redirect_uri: str | None = None
    authorization_code: str | None = None
    authorized_devices: list[str] = Field(default_factory=list)
    fetch_concurrency: int = 12
    access_token: str | None = None
    refresh_token: str | None = None
    expires_at: float | None = None

    class Settings:
        name = "bouncie_credentials"
        indexes = [IndexModel([("id", ASCENDING)], unique=True)]

    class Config:
        extra = "allow"


class CountyVisitedCache(Document):
    """Cache document for visited county data."""

    # Use string ID to match the existing pattern with "visited_counties" as _id
    id: str = Field(default="visited_counties", alias="_id")
    counties: dict[str, Any] = Field(default_factory=dict)
    stopped_counties: dict[str, Any] = Field(default_factory=dict)
    trips_analyzed: int = 0
    updated_at: datetime | None = None
    calculation_time_seconds: float | None = None

    class Settings:
        name = "county_visited_cache"

    class Config:
        extra = "allow"


class CountyTopology(Document):
    """County TopoJSON topology data document."""

    # Use string ID for topology variant IDs like "counties_10m"
    id: str = Field(..., alias="_id")
    projection: str | None = None
    source: str | None = None
    topology: dict[str, Any] = Field(default_factory=dict)
    updated_at: datetime | None = None

    class Settings:
        name = "county_topology"

    class Config:
        extra = "allow"
        populate_by_name = True


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
    BouncieCredentials,
    CountyVisitedCache,
    CountyTopology,
]
