"""Pydantic models for request validation and API responses in the street.

coverage tracking application.

This module contains Pydantic models used for data validation and defining
API response structures across the application.
"""

from datetime import datetime
from typing import Annotated, Any

from pydantic import BaseModel, BeforeValidator, Field, field_validator

from date_utils import parse_timestamp
from geometry_service import GeometryService

PyObjectId = Annotated[str, BeforeValidator(str)]


def validate_geojson_point_or_linestring(
    gps_data: Any,
    transaction_id: str | None = None,
) -> tuple[bool, dict[str, Any] | None]:
    """Validate GeoJSON Point or LineString structure and coordinate ranges.

    This is a standalone validation function for use outside of Pydantic models.

    Args:
        gps_data: GeoJSON dict with 'type' and 'coordinates' keys
        transaction_id: Optional id for contextual logging (unused, kept for compatibility)

    Returns:
        Tuple of (is_valid, validated_geojson_dict or None)
    """
    _ = transaction_id

    if not isinstance(gps_data, dict):
        return False, None

    geom_type = gps_data.get("type")
    coordinates = gps_data.get("coordinates")

    if geom_type not in ["Point", "LineString"]:
        return False, None

    if not isinstance(coordinates, list):
        return False, None

    def _validate_coord(coord_pair: Any) -> tuple[bool, list[float] | None]:
        return GeometryService.validate_coordinate_pair(coord_pair)

    if geom_type == "Point":
        is_valid, validated_coord = _validate_coord(coordinates)
        if not is_valid or validated_coord is None:
            return False, None
        return True, {"type": "Point", "coordinates": validated_coord}

    if geom_type == "LineString":
        if len(coordinates) < 2:
            return False, None

        validated_coords: list[list[float]] = []
        for coord_pair in coordinates:
            is_valid, validated_coord = _validate_coord(coord_pair)
            if not is_valid or validated_coord is None:
                return False, None
            validated_coords.append(validated_coord)

        # Remove consecutive duplicates
        unique_coords: list[list[float]] = []
        for coord in validated_coords:
            if not unique_coords or coord != unique_coords[-1]:
                unique_coords.append(coord)

        if len(unique_coords) < 2:
            if len(unique_coords) == 1:
                return True, {"type": "Point", "coordinates": unique_coords[0]}
            return False, None

        return True, {"type": "LineString", "coordinates": unique_coords}

    return False, None


class LocationModel(BaseModel):
    """Model for location data."""

    display_name: str
    osm_id: int
    osm_type: str
    # Relaxed type to float | None to prevent 422 errors if frontend sends floats
    osm_id: int
    osm_type: str

    # New fields for feet-based configuration
    segment_length_feet: float | None = None
    match_buffer_feet: float | None = None
    min_match_length_feet: float | None = None

    class Config:
        extra = "allow"


class CustomBoundaryModel(BaseModel):
    """Model for custom drawn boundary data."""

    display_name: str
    boundary_type: str = "custom"
    geometry: dict[str, Any]  # GeoJSON geometry
    area_name: str
    geometry: dict[str, Any]  # GeoJSON geometry
    area_name: str

    # New fields for feet-based configuration
    segment_length_feet: float | None = None
    match_buffer_feet: float | None = None
    min_match_length_feet: float | None = None

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

    id: PyObjectId | None = Field(alias="_id", default=None)
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

    @field_validator("startTime", "endTime", "lastUpdate", mode="before")
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
                raise ValueError("Invalid JSON string for GPS data")

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
                c_list = [float(c[0]), float(c[1])]  # Ensure float
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
                raise ValueError("GPS data missing 'type' or 'coordinates'")

            geom_type = v["type"]
            coords = v["coordinates"]

            if geom_type not in ["Point", "LineString"]:
                raise ValueError(f"Unsupported geometry type: {geom_type}")

            if not isinstance(coords, list):
                raise ValueError("Coordinates must be a list")

            # Validate based on type
            if geom_type == "Point":
                if len(coords) < 2:
                    raise ValueError("Point must have at least 2 coordinates")
                try:
                    lon, lat = float(coords[0]), float(coords[1])
                    if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                        raise ValueError(f"Invalid coordinates: {lon}, {lat}")
                    v["coordinates"] = [lon, lat]
                except (ValueError, TypeError):
                    raise ValueError("Invalid coordinate values")

            elif geom_type == "LineString":
                if len(coords) < 2:
                    raise ValueError("LineString must have at least 2 points")

                validated = []
                for point in coords:
                    if not isinstance(point, list) or len(point) < 2:
                        continue  # Skip invalid points, or could raise
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

                if len(final_coords) < 2:
                    # If simplified to 1 point, downgrade to Point?
                    # Or fail? Existing logic allowed downgrade or fail.
                    # Let's return Point if 1, or None if 0
                    if len(final_coords) == 1:
                        return {"type": "Point", "coordinates": final_coords[0]}
                    raise ValueError("LineString has insufficient valid coordinates")

                v["coordinates"] = final_coords

            return v

        return None

    class Config:
        populate_by_name = True
        extra = "allow"

    def validate_meaningful(self) -> tuple[bool, str | None]:
        """Validate that a trip represents actual driving.

        Flags trips as invalid if:
        - Very short distance AND same start/end AND low speed AND short duration
        - OR extremely short duration (< 2 min) and zero distance
        """
        # Distances are in miles, speeds in mph, durations in seconds (or processed minutes)

        # Self.distance is float | None
        dist = self.distance if self.distance is not None else 0.0

        # Self.maxSpeed
        max_speed = self.maxSpeed if self.maxSpeed is not None else 0.0

        # Calculate duration in minutes
        duration_minutes = 0.0
        if self.startTime and self.endTime:
            # Pydantic has already ensured these are datetime objects (aware)
            diff = (self.endTime - self.startTime).total_seconds()
            duration_minutes = diff / 60.0

        # Check if locations are same
        same_location = False
        if self.gps and self.gps.get("type") == "LineString":
            coords = self.gps.get("coordinates")
            if coords and len(coords) >= 2:
                first = coords[0]
                last = coords[-1]
                # approx 50m tolerance ~0.0005 deg
                if (
                    abs(first[0] - last[0]) < 0.0005
                    and abs(first[1] - last[1]) < 0.0005
                ):
                    same_location = True
        elif self.gps and self.gps.get("type") == "Point":
            same_location = True  # Start and end are definitely same

        is_stationary = False

        # Condition 1: Standard stationary check
        # Distance <= 0.05 miles, Same location, Max Speed <= 0.5 mph, Duration < 10 mins
        if (
            dist <= 0.05
            and same_location
            and max_speed <= 0.5
            and duration_minutes < 10
        ):
            is_stationary = True

        # Condition 2: Extremely short/zero distance (e.g. < 2 mins)
        if dist <= 0.01 and duration_minutes < 2:
            is_stationary = True

        if is_stationary:
            msg = (
                f"Stationary trip: car turned on possibly without driving "
                f"(distance: {dist:.2f} mi, duration: {duration_minutes:.1f} min)"
            )
            return False, msg

        return True, None


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
