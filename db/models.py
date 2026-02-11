"""
Beanie ODM document models for MongoDB collections.

This module defines all document models using Beanie ODM, which provides:
- Automatic Pydantic validation
- Built-in async CRUD operations
- Proper ObjectId/datetime serialization
- Index definitions at the model level

Usage:
    from db.models import Trip, Vehicle

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

from datetime import UTC, datetime
from typing import Any, ClassVar

from beanie import Document, Indexed, PydanticObjectId
from beanie.odm.fields import IndexModel
from pydantic import BaseModel, ConfigDict, Field, field_validator

from core.date_utils import parse_timestamp
from core.spatial import GeometryService
from map_data.models import GeoServiceHealth, MapServiceConfig


class Trip(Document):
    """Trip document representing a driving trip record."""

    transactionId: Indexed(str, unique=True) | None = None

    @field_validator("transactionId", mode="before")
    @classmethod
    def convert_object_id_to_string(cls, v: Any) -> str | None:
        """Convert ObjectId to string for transactionId field."""
        if v is None:
            return None
        # Handle ObjectId (from bson or PydanticObjectId)
        if hasattr(v, "__str__") and not isinstance(v, str):
            return str(v)
        return v

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
    coordinates: list[dict[str, Any]] | None = None
    lastUpdate: datetime | None = None
    distance: float | None = None
    currentSpeed: float | None = None
    maxSpeed: float | None = None
    avgSpeed: float | None = None
    duration: float | None = None
    pointsRecorded: int | None = None
    sequence: int | None = None
    totalIdleDuration: float | None = None
    hardBrakingCounts: int | None = None
    hardAccelerationCounts: int | None = None
    fuelConsumed: float | None = None
    closed_reason: str | None = None
    source: str | None = None
    saved_at: datetime | None = None
    processing_state: str | None = None
    processing_history: list[dict[str, Any]] | None = None
    coverage_emitted_at: datetime | None = None

    # Matched GPS data (consolidated from matched_trips)
    matchedGps: dict[str, Any] | None = None
    matchStatus: str | None = None
    matched_at: datetime | None = None

    # Place associations
    startGeoPoint: dict[str, Any] | None = None
    destinationGeoPoint: dict[str, Any] | None = None
    destinationPlaceId: str | None = None
    destinationPlaceName: str | None = None

    # Recurring route association (computed locally from stored trip data)
    recurringRouteId: PydanticObjectId | None = None

    # Validation fields
    invalid: bool | None = None
    validated_at: datetime | None = None
    validation_status: str | None = None
    validation_message: str | None = None

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
        """Validate GPS data is valid GeoJSON - store as-is from Bouncie."""
        if v is None:
            return None

        # Handle string input (parse JSON)
        if isinstance(v, str):
            try:
                import json

                v = json.loads(v)
            except json.JSONDecodeError:
                return None

        # Handle list input (convert to GeoJSON Point/LineString)
        if isinstance(v, list):
            if not v:
                return None
            return GeometryService.geometry_from_coordinate_pairs(
                v,
                allow_point=True,
                dedupe=True,
                validate=True,
            )

        # Handle dict input (GeoJSON) - store as-is
        if isinstance(v, dict):
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
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel([("startTime", 1)], name="trips_startTime_asc_idx"),
            IndexModel([("endTime", 1)], name="trips_endTime_asc_idx"),
            IndexModel([("endTime", -1)], name="trips_endTime_desc_idx"),
            IndexModel([("gps", "2dsphere")], name="trips_gps_2dsphere_idx"),
            IndexModel(
                [("startGeoPoint", "2dsphere")],
                name="trips_startGeoPoint_2dsphere_idx",
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
                [("destinationPlaceId", 1)],
                name="trips_destinationPlaceId_idx",
                sparse=True,
            ),
            IndexModel(
                [("destinationPlaceName", 1)],
                name="trips_destinationPlaceName_idx",
                sparse=True,
            ),
            IndexModel(
                [("recurringRouteId", 1), ("startTime", -1)],
                name="trips_recurringRoute_startTime_desc_idx",
                sparse=True,
            ),
        ]

    model_config = ConfigDict(extra="allow")


class RecurringRoute(Document):
    """Locally-derived route template grouping multiple similar trips."""

    route_key: Indexed(str, unique=True)
    route_signature: str
    algorithm_version: int = 1
    params: dict[str, Any] = Field(default_factory=dict)

    # Display/edit fields
    name: str | None = None
    auto_name: str = ""
    start_label: str = ""
    end_label: str = ""
    start_place_id: str | None = None
    end_place_id: str | None = None

    # Geometry summary
    start_centroid: list[float] = Field(default_factory=list)  # [lon, lat]
    end_centroid: list[float] = Field(default_factory=list)  # [lon, lat]
    geometry: dict[str, Any] | None = None
    preview_svg_path: str | None = None

    # Aggregates
    trip_count: int = 0
    is_recurring: bool = False
    first_start_time: datetime | None = None
    last_start_time: datetime | None = None
    vehicle_imeis: list[str] = Field(default_factory=list)
    distance_miles_median: float | None = None
    distance_miles_avg: float | None = None
    duration_sec_median: float | None = None
    duration_sec_avg: float | None = None
    fuel_gal_avg: float | None = None
    cost_usd_avg: float | None = None
    max_speed_mph_max: float | None = None
    representative_trip_id: str | None = None

    # User customization
    color: str | None = None
    is_pinned: bool = False
    is_hidden: bool = False

    # Lifecycle
    is_active: bool = True
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    class Settings:
        name = "recurring_routes"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel(
                [("is_pinned", -1), ("trip_count", -1), ("last_start_time", -1)],
                name="recurring_routes_pinned_count_last_idx",
            ),
            IndexModel(
                [("is_recurring", -1), ("trip_count", -1)],
                name="recurring_routes_recurring_count_idx",
            ),
        ]

    model_config = ConfigDict(extra="allow")


class TripIngestIssue(Document):
    """
    Persistent record of trip fetch/validation/processing issues.

    This is a user-facing diagnostics log shown in Settings -> Data.
    It is intentionally lightweight (counts + latest details) and time-bounded.
    """

    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    last_seen_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    # "fetch_error" | "validation_failed" | "process_error" | ...
    issue_type: Indexed(str)
    source: str | None = None

    transactionId: str | None = None
    imei: str | None = None

    message: str | None = None
    details: dict[str, Any] | None = None

    occurrences: int = 1
    resolved: bool = False
    resolved_at: datetime | None = None

    # Deterministic identifier used for dedupe/upsert semantics.
    fingerprint: Indexed(str, unique=True) | None = None

    class Settings:
        name = "trip_ingest_issues"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel(
                [("last_seen_at", 1)],
                name="trip_ingest_issues_ttl_idx",
                expireAfterSeconds=30 * 24 * 60 * 60,
            ),
            IndexModel(
                [("resolved", 1), ("issue_type", 1), ("last_seen_at", -1)],
                name="trip_ingest_issues_status_type_seen_idx",
            ),
            IndexModel(
                [("transactionId", 1)],
                name="trip_ingest_issues_tx_idx",
            ),
            IndexModel(
                [("imei", 1)],
                name="trip_ingest_issues_imei_idx",
            ),
            IndexModel(
                [("source", 1), ("last_seen_at", -1)],
                name="trip_ingest_issues_source_seen_idx",
            ),
        ]

    model_config = ConfigDict(extra="allow")


class OsmData(Document):
    """OSM data cache document."""

    location: dict[str, Any] | None = None
    type: str | None = None
    geojson: dict[str, Any] | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    fetched_at: datetime | None = None

    class Settings:
        name = "osm_data"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel(
                [("location", 1), ("type", 1)],
                name="osm_data_location_type_idx",
            ),
        ]

    model_config = ConfigDict(extra="allow")


class Place(Document):
    """Place/location document for visit tracking."""

    name: str | None = None
    geometry: dict[str, Any] | None = None  # GeoJSON geometry for custom places
    address: str | None = None
    category: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    visit_count: int = 0

    class Settings:
        name = "places"

    model_config = ConfigDict(extra="allow")


class CoverageArea(Document):
    """
    A geographic area for street coverage tracking.

    Represents a coverage area with user-facing status and cached
    statistics.
    """

    display_name: Indexed(str, unique=True)
    area_type: str = "city"
    boundary: dict[str, Any] = Field(default_factory=dict)
    bounding_box: list[float] = Field(default_factory=list)
    status: str = "initializing"
    health: str = "unavailable"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    last_synced: datetime | None = None
    total_length_miles: float = 0.0
    driveable_length_miles: float = 0.0
    driven_length_miles: float = 0.0
    coverage_percentage: float = 0.0
    total_segments: int = 0
    driven_segments: int = 0
    undriveable_segments: int = 0
    undriveable_length_miles: float = 0.0
    area_version: int = 1
    osm_fetched_at: datetime | None = None
    last_error: str | None = None
    optimal_route: dict[str, Any] | None = None
    optimal_route_generated_at: datetime | None = None

    class Settings:
        name = "coverage_areas"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel([("status", 1)], name="coverage_areas_status_idx"),
            IndexModel(
                [("osm_fetched_at", 1)],
                name="coverage_areas_osm_fetched_idx",
            ),
        ]

    model_config = ConfigDict(extra="allow")


class Street(Document):
    """
    Static street segment geometry derived from OSM.

    This is immutable for a given area version. Geometry and properties
    don't change unless the area is rebuilt with new OSM data.
    """

    segment_id: str
    area_id: Indexed(PydanticObjectId)
    area_version: int
    geometry: dict[str, Any] = Field(default_factory=dict)
    street_name: str | None = None
    highway_type: str = "unclassified"
    osm_id: int | None = None
    length_miles: float = 0.0

    class Settings:
        name = "streets"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel(
                [("area_id", 1), ("segment_id", 1)],
                name="streets_area_segment_unique_idx",
                unique=True,
            ),
            IndexModel(
                [("area_id", 1), ("geometry", "2dsphere")],
                name="streets_area_geo_idx",
            ),
            IndexModel(
                [("area_id", 1), ("area_version", 1)],
                name="streets_area_version_idx",
            ),
        ]

    model_config = ConfigDict(extra="allow")


class CoverageState(Document):
    """
    Dynamic coverage status for a street segment.

    This is the mutable state that changes when trips are driven or when
    users manually mark segments. Geometry is NOT stored here.
    """

    area_id: Indexed(PydanticObjectId)
    segment_id: str
    status: str = "undriven"
    last_driven_at: datetime | None = None
    first_driven_at: datetime | None = None
    driven_by_trip_id: PydanticObjectId | None = None
    manually_marked: bool = False
    marked_at: datetime | None = None

    @field_validator(
        "last_driven_at",
        "first_driven_at",
        "marked_at",
        mode="before",
    )
    @classmethod
    def parse_datetime_fields(cls, v: Any) -> datetime | None:
        """Normalize CoverageState datetimes to explicit UTC-aware values."""
        if v is None:
            return None
        return parse_timestamp(v)

    class Settings:
        name = "coverage_state"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel(
                [("area_id", 1), ("segment_id", 1)],
                name="coverage_state_area_segment_unique_idx",
                unique=True,
            ),
            IndexModel(
                [("area_id", 1), ("status", 1)],
                name="coverage_state_area_status_idx",
            ),
            IndexModel(
                [("status", 1)],
                name="coverage_state_status_idx",
            ),
            IndexModel(
                [("first_driven_at", 1)],
                name="coverage_state_first_driven_at_idx",
            ),
        ]

    model_config = ConfigDict(extra="allow")


class Job(Document):
    """Unified job status tracking for all background work."""

    # Identity
    job_type: str
    operation_id: str | None = None
    task_id: str | None = None
    owner_key: str | None = None
    area_id: PydanticObjectId | None = None
    location: str | None = None
    location_id: str | None = None

    # State
    status: str = "pending"
    stage: str = "Queued"
    progress: float = 0.0
    message: str = ""

    # Timing
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    completed_at: datetime | None = None
    updated_at: datetime | None = None
    expires_at: datetime | None = None

    # Error handling
    error: str | None = None
    retry_count: int = 0
    max_retries: int = 3

    # Extra payloads
    metadata: dict[str, Any] = Field(default_factory=dict)
    metrics: dict[str, Any] | None = None
    spec: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] | None = None

    class Settings:
        name = "jobs"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel([("job_type", 1)], name="jobs_type_idx"),
            IndexModel([("operation_id", 1)], name="jobs_operation_idx"),
            IndexModel([("task_id", 1)], name="jobs_task_idx"),
            IndexModel([("owner_key", 1)], name="jobs_owner_idx"),
            IndexModel(
                [("area_id", 1), ("job_type", 1)],
                name="jobs_area_type_idx",
            ),
            IndexModel([("status", 1)], name="jobs_status_idx"),
            IndexModel([("created_at", -1)], name="jobs_created_idx"),
        ]

    model_config = ConfigDict(extra="allow")


class TaskConfig(Document):
    """Task configuration document for scheduled tasks."""

    id: str | PydanticObjectId | None = Field(default=None, alias="_id")
    task_id: Indexed(str) | None = None
    enabled: bool = True
    interval_minutes: int | None = None
    last_run: datetime | None = None
    next_run: datetime | None = None
    status: str | None = None
    last_updated: datetime | None = None
    config: dict[str, Any] = Field(default_factory=dict)

    class Settings:
        name = "task_config"

    model_config = ConfigDict(extra="allow")


class TaskHistory(Document):
    """Task execution history document."""

    # Use string ID for celery task IDs (UUID strings)
    id: str | None = Field(default=None, alias="_id")
    task_id: Indexed(str) | None = None
    timestamp: Indexed(datetime, index_type=-1) | None = None
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
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel(
                [("task_id", 1), ("timestamp", -1)],
                name="task_history_task_timestamp_idx",
            ),
        ]

    model_config = ConfigDict(extra="allow")


class GasFillup(Document):
    """Gas fillup record document."""

    imei: Indexed(str) | None = None
    vin: str | None = None
    fillup_time: Indexed(datetime) | None = None
    gallons: float | None = None
    price_per_gallon: float | None = None
    total_cost: float | None = None
    odometer: float | None = None
    latitude: float | None = None
    longitude: float | None = None
    is_full_tank: bool | None = True
    missed_previous: bool | None = False

    # Derived MPG fields (maintained by FillupService).
    previous_odometer: float | None = None
    miles_since_last_fillup: float | None = None
    calculated_mpg: float | None = None

    detected_automatically: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None

    class Settings:
        name = "gas_fillups"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel(
                [("imei", 1), ("fillup_time", -1)],
                name="gas_fillups_imei_time_idx",
            ),
            IndexModel(
                [("fillup_time", -1)],
                name="gas_fillups_fillup_time_idx",
            ),
            IndexModel([("vin", 1)], name="gas_fillups_vin_idx", sparse=True),
        ]

    model_config = ConfigDict(extra="allow")


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

    # Odometer tracking
    odometer_reading: float | None = None  # Current/last known odometer reading
    odometer_source: str | None = None  # 'bouncie', 'manual', 'trip'
    odometer_updated_at: datetime | None = None  # When odometer was last updated

    class Settings:
        name = "vehicles"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel([("imei", 1)], name="vehicles_imei_idx", unique=True),
            IndexModel([("vin", 1)], name="vehicles_vin_idx", sparse=True),
            IndexModel([("is_active", 1)], name="vehicles_is_active_idx"),
        ]

    model_config = ConfigDict(extra="allow")


class SetupStepState(BaseModel):
    """State tracking for each setup wizard step."""

    status: str = "not_started"
    progress: float = 0.0
    interruptible: bool = True
    in_flight: bool = False
    lock_owner: str | None = None
    idempotency_key: str | None = None
    started_at: datetime | None = None
    updated_at: datetime | None = None
    completed_at: datetime | None = None
    last_error: str | None = None
    last_error_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="allow")


class SetupSession(Document):
    """Persistent setup wizard session state."""

    scope_key: Indexed(str, unique=True)
    status: str = "not_started"
    current_step: str = "welcome"
    step_states: dict[str, SetupStepState] = Field(default_factory=dict)
    idempotency_keys: dict[str, str] = Field(default_factory=dict)
    version: int = 1

    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    last_seen_at: datetime | None = None

    active_client_id: str | None = None
    active_client_last_seen_at: datetime | None = None

    class Settings:
        name = "setup_sessions"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel([("status", 1)], name="setup_sessions_status_idx"),
            IndexModel([("updated_at", -1)], name="setup_sessions_updated_idx"),
        ]

    model_config = ConfigDict(extra="allow")


class AppSettings(Document):
    """
    Application settings document.

    Stores UI preferences and user-facing configuration.
    """

    id: str = Field(default="default", alias="_id")
    updated_at: datetime | None = None
    setup_completed: bool = False
    setup_completed_at: datetime | None = None

    # UI Preferences
    highlightRecentTrips: bool = True
    autoCenter: bool = True
    geocodeTripsOnFetch: bool = True
    mapMatchTripsOnFetch: bool = False

    # Map Configuration
    mapbox_token: str | None = None

    # Nominatim (Geocoding) Configuration
    nominatim_user_agent: str = "EveryStreet/1.0"

    # OSM Data Configuration
    geofabrik_mirror: str = "https://download.geofabrik.de"
    osm_extracts_path: str = "/osm"

    # Map Coverage Configuration (imperial units)
    mapCoverageMode: str = "trips"
    mapCoverageBufferMiles: float = 10.0
    mapCoverageSimplifyFeet: float = 150.0
    mapCoverageMaxPointsPerTrip: int = 2000
    mapCoverageBatchSize: int = 200

    # Logs
    # When set, server log queries should hide entries older than this cutoff.
    serverLogsCutoff: datetime | None = None

    class Settings:
        name = "app_settings"
        use_state_management = True

    model_config = ConfigDict(extra="allow")


class ServerLog(Document):
    """Server log document for MongoDB logging handler."""

    timestamp: Indexed(datetime, index_type=-1) | None = None
    level: str | None = None
    logger_name: str | None = None
    message: str | None = None
    pathname: str | None = None
    lineno: int | None = None
    funcName: str | None = None
    exc_info: str | None = None

    class Settings:
        name = "server_logs"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel([("level", 1)], name="server_logs_level_idx"),
            IndexModel(
                [("timestamp", 1)],
                name="server_logs_ttl_idx",
                expireAfterSeconds=30 * 24 * 60 * 60,
            ),
        ]

    model_config = ConfigDict(extra="allow")


class BouncieCredentials(Document):
    """Bouncie API credentials document."""

    id: str = "bouncie_credentials"
    client_id: str | None = None
    client_secret: str | None = None
    redirect_uri: str | None = None
    authorization_code: str | None = None
    oauth_state: str | None = None
    oauth_state_expires_at: float | None = None
    last_auth_error: str | None = None
    last_auth_error_detail: str | None = None
    last_auth_error_at: float | None = None
    webhook_key: str | None = None
    last_webhook_at: datetime | None = None
    last_webhook_event_type: str | None = None
    authorized_devices: list[str] = Field(default_factory=list)
    fetch_concurrency: int = 12
    access_token: str | None = None
    refresh_token: str | None = None
    expires_at: float | None = None

    class Settings:
        name = "bouncie_credentials"
        indexes: ClassVar[list[IndexModel]] = [IndexModel([("id", 1)], unique=True)]

    model_config = ConfigDict(extra="allow")


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

    model_config = ConfigDict(extra="allow")


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

    model_config = ConfigDict(
        extra="allow",
        populate_by_name=True,
    )


# List of all document models for Beanie initialization
ALL_DOCUMENT_MODELS = [
    Trip,
    RecurringRoute,
    TripIngestIssue,
    OsmData,
    Place,
    TaskConfig,
    TaskHistory,
    GasFillup,
    Vehicle,
    SetupSession,
    AppSettings,
    ServerLog,
    BouncieCredentials,
    CountyVisitedCache,
    CountyTopology,
    # Coverage system models
    CoverageArea,
    CoverageState,
    Job,
    Street,
    # Map data management models
    MapServiceConfig,
    GeoServiceHealth,
]
