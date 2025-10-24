"""Unified Trip Processor.

This module provides a comprehensive TripProcessor class that handles all
aspects of trip processing, including validation, parsing, geocoding, and map
matching. It uses a state machine approach to track processing status and
ensures consistent handling of all trip data.
"""

import asyncio
import json
import logging
import time
import uuid
from enum import Enum
from typing import Any

import aiohttp
import pyproj
from pymongo.errors import DuplicateKeyError
from shapely.geometry import Point

from date_utils import get_current_utc_time, parse_timestamp
from db import matched_trips_collection, places_collection, trips_collection
from utils import haversine, reverse_geocode_nominatim

logger = logging.getLogger(__name__)


class TripState(Enum):
    NEW = "new"
    VALIDATED = "validated"
    PROCESSED = "processed"
    GEOCODED = "geocoded"
    MAP_MATCHED = "map_matched"
    COMPLETED = "completed"
    FAILED = "failed"


class Config:
    """Singleton for application configuration."""

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance.mapbox_access_token = None

        return cls._instance

    @property
    def mapbox_access_token(self):
        return self._mapbox_access_token

    @mapbox_access_token.setter
    def mapbox_access_token(self, value):
        self._mapbox_access_token = value


class RateLimiter:
    """Rate limiter for API requests with thread-safe design."""

    def __init__(
        self,
        max_requests: int,
        window_seconds: int,
    ):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.window_start = time.time()
        self.request_count = 0
        self.lock = asyncio.Lock()

    async def check_rate_limit(
        self,
    ) -> tuple[bool, float]:
        """Check if we're about to exceed rate limit.

        Returns (need_to_wait, wait_time_seconds)
        """
        async with self.lock:
            current_time = time.time()
            elapsed = current_time - self.window_start

            if elapsed > self.window_seconds:
                self.request_count = 0
                self.window_start = current_time
                return False, 0

            if self.request_count >= self.max_requests:
                wait_time = self.window_seconds - elapsed
                return True, max(0.1, wait_time)

            self.request_count += 1
            return False, 0


config = Config()
mapbox_rate_limiter = RateLimiter(60, 60)
map_match_semaphore = asyncio.Semaphore(3)


class TripProcessor:
    """Unified processor for trip data that handles all aspects of trip
    processing including validation, parsing, geocoding, and map matching using
    a state machine approach to track status.
    """

    def __init__(
        self,
        mapbox_token: str | None = None,
        source: str = "api",
    ):
        """Initialize the trip processor.

        Args:
            mapbox_token: The Mapbox access token for map matching
            source: Source of the trip data (api, upload, upload_gpx, upload_geojson,
            bouncie etc.)

        """
        if mapbox_token:
            config.mapbox_access_token = mapbox_token

        self.source = source

        self.state = TripState.NEW
        self.state_history = []
        self.errors: dict[str, str] = {}

        self.trip_data: dict[str, Any] = {}
        self.processed_data: dict[str, Any] = {}

        self.utm_proj = None
        self.project_to_utm = None

    def _standardize_and_validate_gps_data(
        self, gps_input: Any, transaction_id: str
    ) -> dict | None:
        """
        Standardizes and validates GPS data into a GeoJSON Point or LineString object.

        Args:
            gps_input: The raw GPS data (string, list of coords, or dict).
            transaction_id: The transaction ID for logging.

        Returns:
            A valid GeoJSON dictionary (Point or LineString) or None if invalid.
        """
        processed_coords = []

        if isinstance(gps_input, str):
            try:
                gps_data = json.loads(gps_input)
            except json.JSONDecodeError:
                logger.warning(
                    "Trip %s: Invalid JSON string in GPS data. Input: %s",
                    transaction_id,
                    gps_input[:100],  # Log a snippet
                )
                return None
        elif isinstance(gps_input, (list, dict)):
            gps_data = gps_input
        else:
            logger.warning(
                "Trip %s: GPS data is of unexpected type: %s",
                transaction_id,
                type(gps_input).__name__,
            )
            return None

        if isinstance(gps_data, list):  # Assumed to be a list of coordinate pairs
            raw_coords = gps_data
        elif isinstance(gps_data, dict):
            if (
                gps_data.get("type") in ["Point", "LineString"]
                and "coordinates" in gps_data
            ):
                # It might already be GeoJSON, extract coordinates for validation/standardization
                raw_coords = gps_data.get("coordinates")
                if gps_data["type"] == "Point":
                    # Wrap single point coordinates in a list to use the common processing loop
                    if (
                        isinstance(raw_coords, list)
                        and len(raw_coords) == 2
                        and all(isinstance(c, (int, float)) for c in raw_coords)
                    ):
                        raw_coords = [
                            raw_coords
                        ]  # Make it a list of a single coordinate pair
                    else:  # Invalid point coordinates structure
                        logger.warning(
                            "Trip %s: GPS data (dict, Point) has invalid coordinates: %s",
                            transaction_id,
                            raw_coords,
                        )
                        return None
            else:  # Dictionary but not in expected GeoJSON structure
                logger.warning(
                    "Trip %s: GPS data (dict) is not a valid GeoJSON Point or LineString: %s",
                    transaction_id,
                    gps_data,
                )
                return None
        else:  # Should have been caught by initial type check, but as a safeguard
            logger.warning(
                "Trip %s: GPS data format is unrecognized after initial parsing. Type: %s",
                transaction_id,
                type(gps_data).__name__,
            )
            return None

        if not isinstance(raw_coords, list):
            logger.warning(
                "Trip %s: Parsed GPS coordinates are not a list: %s",
                transaction_id,
                raw_coords,
            )
            return None

        # Validate and extract coordinate pairs
        for coord_pair in raw_coords:
            if (
                isinstance(coord_pair, list)
                and len(coord_pair) == 2
                and isinstance(coord_pair[0], (int, float))
                and isinstance(coord_pair[1], (int, float))
                and -180 <= coord_pair[0] <= 180  # Longitude
                and -90 <= coord_pair[1] <= 90  # Latitude
            ):
                processed_coords.append([coord_pair[0], coord_pair[1]])
            else:
                logger.debug(  # More verbose logging for individual bad points
                    "Trip %s: Skipping invalid coordinate pair: %s",
                    transaction_id,
                    coord_pair,
                )

        if not processed_coords:
            logger.warning(
                "Trip %s: No valid coordinate pairs found after validation.",
                transaction_id,
            )
            return None

        # Deduplicate coordinates while preserving order
        unique_coords = []
        if processed_coords:
            unique_coords.append(processed_coords[0])
            for i in range(1, len(processed_coords)):
                if processed_coords[i] != processed_coords[i - 1]:
                    unique_coords.append(processed_coords[i])

        if (
            not unique_coords
        ):  # Should not happen if processed_coords had items, but defensive
            logger.warning(
                "Trip %s: No unique coordinates after deduplication (unexpected).",
                transaction_id,
            )
            return None

        if len(unique_coords) == 1:
            return {"type": "Point", "coordinates": unique_coords[0]}
        elif len(unique_coords) >= 2:
            return {"type": "LineString", "coordinates": unique_coords}
        else:  # Should be len 0 if initial processed_coords was empty
            logger.warning(
                "Trip %s: Not enough unique coordinates to form Point or LineString.",
                transaction_id,
            )
            return None

    def _set_state(
        self,
        new_state: TripState,
        error: str | None = None,
    ) -> None:
        """Update the processing state and record it in history.

        Args:
            new_state: The new state to set
            error: Optional error message if transitioning to FAILED state

        """
        previous_state = self.state
        self.state = new_state

        state_change = {
            "from": previous_state.value,
            "to": new_state.value,
            "timestamp": get_current_utc_time(),
        }

        if error and new_state == TripState.FAILED:
            state_change["error"] = error
            self.errors[previous_state.value] = error

        self.state_history.append(state_change)

    def set_trip_data(self, trip_data: dict[str, Any]) -> None:
        """Set the raw trip data to be processed.

        Args:
            trip_data: The raw trip data dictionary

        """
        self.trip_data = trip_data
        self.processed_data = (
            trip_data.copy()
        )  # Keep a copy of original for reference if needed

        # Standardize GPS data early
        raw_gps = self.processed_data.get("gps")
        transaction_id = self.processed_data.get(
            "transactionId", f"unknown-{uuid.uuid4()}"
        )

        standardized_gps = self._standardize_and_validate_gps_data(
            raw_gps, transaction_id
        )

        if standardized_gps is None:
            logger.warning(
                "Trip %s: GPS data could not be standardized and is invalid. Setting to None.",
                transaction_id,
            )
            # Depending on strictness, you might fail early here or let validation catch it.
            # For now, set to None and let validation handle if it's missing/invalid.
        self.processed_data["gps"] = (
            standardized_gps  # Replace with standardized version or None
        )

        self.state = TripState.NEW
        self._set_state(TripState.NEW)

    def get_processing_status(
        self,
    ) -> dict[str, Any]:
        """Get the current processing status.

        Returns:
            Dict with current state, history, and any errors

        """
        return {
            "state": self.state.value,
            "history": self.state_history,
            "errors": self.errors,
            "transaction_id": self.trip_data.get("transactionId", "unknown"),
        }

    async def process(self, do_map_match: bool = True) -> dict[str, Any]:
        """Process the trip through all appropriate stages based on current
        state.

        Args:
            do_map_match: Whether to perform map matching

        Returns:
            The processed trip data

        """
        if not self.trip_data:
            self._set_state(
                TripState.FAILED,
                "No trip data provided",
            )
            return {}

        try:
            await self.validate()
            if self.state == TripState.FAILED:
                return {}

            await self.process_basic()
            if self.state == TripState.FAILED:
                return {}

            await self.geocode()
            if self.state == TripState.FAILED:
                return {}

            if do_map_match:
                await self.map_match()

            if self.state != TripState.FAILED:
                self._set_state(TripState.COMPLETED)

            return self.processed_data

        except Exception as e:
            error_message = f"Unexpected error: {e!s}"
            logger.exception(
                "Error processing trip %s",
                self.trip_data.get("transactionId", "unknown"),
            )
            self._set_state(TripState.FAILED, error_message)
            return {}

    async def validate(self) -> bool:
        """Validate the trip data.

        Returns:
            True if validation passed, False otherwise

        """
        try:
            transaction_id = self.trip_data.get("transactionId", "unknown")
            logger.debug(
                "Validating trip %s",
                transaction_id,
            )

            required = [
                "transactionId",
                "startTime",
                "endTime",
                "gps",
            ]
            for field in required:
                if field not in self.trip_data:
                    error_message = f"Missing required field: {field}"
                    logger.warning(
                        "Trip %s: %s",
                        transaction_id,
                        error_message,
                    )
                    self._set_state(
                        TripState.FAILED,
                        error_message,
                    )
                    return False

            gps_data = self.processed_data.get(
                "gps"
            )  # Use already standardized GPS data

            # Validation of the standardized GPS data
            if gps_data is None:  # Was set to None by standardization if invalid
                error_message = "GPS data is missing or invalid after standardization"
                logger.warning(
                    "Trip %s: %s",
                    transaction_id,
                    error_message,
                )
                self._set_state(
                    TripState.FAILED,
                    error_message,
                )
                return False

            # Further checks if gps_data is not None (i.e., it's a dict from standardization)
            if (
                not isinstance(gps_data, dict)
                or gps_data.get("type") not in ["Point", "LineString"]
                or not isinstance(gps_data.get("coordinates"), list)
            ):
                error_message = (
                    "Standardized GPS data is not a valid GeoJSON Point or LineString"
                )
                logger.warning(
                    "Trip %s: %s",
                    transaction_id,
                    error_message,
                )
                self._set_state(
                    TripState.FAILED,
                    error_message,
                )
                return False

            # Check for minimum points based on type
            gps_type = gps_data.get("type")
            gps_coords_list = gps_data.get("coordinates")

            if gps_type == "Point":
                # For a Point, coordinates should be a list of 2 numbers.
                # The _standardize_and_validate_gps_data should ensure this.
                if not (
                    isinstance(gps_coords_list, list)
                    and len(gps_coords_list) == 2
                    and all(isinstance(c, (float, int)) for c in gps_coords_list)
                ):
                    error_message = "GeoJSON Point 'coordinates' must be a list of two numbers [lon, lat]"
                    logger.warning("Trip %s: %s", transaction_id, error_message)
                    self._set_state(TripState.FAILED, error_message)
                    return False
            elif gps_type == "LineString":
                # For a LineString, coordinates should be a list of at least two coordinate pairs.
                if not (
                    isinstance(gps_coords_list, list) and len(gps_coords_list) >= 2
                ):
                    error_message = "GeoJSON LineString 'coordinates' must be a list of at least two points"
                    logger.warning("Trip %s: %s", transaction_id, error_message)
                    self._set_state(TripState.FAILED, error_message)
                    return False
                # Further check each point in LineString is valid pair (already done by standardize, but good for defense)
                for point_pair in gps_coords_list:
                    if not (
                        isinstance(point_pair, list)
                        and len(point_pair) == 2
                        and all(isinstance(c, (float, int)) for c in point_pair)
                    ):
                        error_message = (
                            "Invalid point found in GeoJSON LineString coordinates"
                        )
                        logger.warning("Trip %s: %s", transaction_id, error_message)
                        self._set_state(TripState.FAILED, error_message)
                        return False
            else:  # Should not happen if standardization worked
                error_message = (
                    f"Unexpected GeoJSON type after standardization: {gps_type}"
                )
                logger.warning("Trip %s: %s", transaction_id, error_message)
                self._set_state(TripState.FAILED, error_message)
                return False

            # self.processed_data is already a copy from set_trip_data and gps field is standardized

            self.processed_data["validated_at"] = get_current_utc_time()
            self.processed_data["validation_status"] = TripState.VALIDATED.value
            # Clear previous invalid state
            self.processed_data["invalid"] = False
            self.processed_data["validation_message"] = None

            self._set_state(TripState.VALIDATED)
            logger.debug(
                "Trip %s validated successfully",
                transaction_id,
            )
            return True

        except Exception as e:
            error_message = f"Validation error: {e!s}"
            logger.exception(
                "Error validating trip %s",
                self.trip_data.get("transactionId", "unknown"),
            )
            self._set_state(TripState.FAILED, error_message)
            return False

    async def process_basic(self) -> bool:
        """Perform basic processing on trip data (timestamps, GPS parsing,
        etc.).

        Returns:
            True if processing succeeded, False otherwise

        """
        try:
            transaction_id = self.trip_data.get("transactionId", "unknown")

            if self.state != TripState.VALIDATED:
                if self.state == TripState.NEW:
                    await self.validate()
                    if self.state != TripState.VALIDATED:
                        return False
                else:
                    logger.warning(
                        "Cannot process trip that hasn't been validated: %s",
                        transaction_id,
                    )
                    return False

            logger.debug(
                "Processing basic data for trip %s",
                transaction_id,
            )

            for key in ("startTime", "endTime"):
                val = self.processed_data.get(key)
                if isinstance(val, str):
                    self.processed_data[key] = parse_timestamp(val)

            gps_data = self.processed_data.get("gps")
            if isinstance(gps_data, str):
                try:
                    # gps_data is already standardized GeoJSON dict or None
                    gps_data = self.processed_data.get("gps")

                    if (
                        not gps_data
                    ):  # Should have been caught by validate, but defensive
                        self._set_state(
                            TripState.FAILED,
                            "Missing GPS data for basic processing",
                        )
                        return False
                except Exception as e:
                    self._set_state(
                        TripState.FAILED, f"Error processing GPS data: {e!s}"
                    )
                    return False

            gps_type = gps_data.get("type")
            gps_coords = gps_data.get("coordinates")

            if gps_type == "Point":
                if not (
                    gps_coords and isinstance(gps_coords, list) and len(gps_coords) == 2
                ):
                    self._set_state(
                        TripState.FAILED,
                        "Point GeoJSON has invalid coordinates for processing",
                    )
                    return False
                start_coord = gps_coords
                end_coord = gps_coords
                self.processed_data["distance"] = (
                    0.0  # Distance is 0 for a single point trip
                )
            elif gps_type == "LineString":
                if not (
                    gps_coords and isinstance(gps_coords, list) and len(gps_coords) >= 2
                ):
                    self._set_state(
                        TripState.FAILED,
                        "LineString GeoJSON has insufficient coordinates for processing",
                    )
                    return False
                start_coord = gps_coords[0]
                end_coord = gps_coords[-1]
                # Calculate distance if not already provided and it's a LineString
                if (
                    "distance" not in self.processed_data
                    or not self.processed_data["distance"]
                ):
                    total_distance = 0.0
                    for i in range(1, len(gps_coords)):
                        prev = gps_coords[i - 1]
                        curr = gps_coords[i]
                        if (
                            isinstance(prev, list)
                            and len(prev) == 2
                            and isinstance(curr, list)
                            and len(curr) == 2
                        ):
                            total_distance += haversine(
                                prev[0],
                                prev[1],
                                curr[0],
                                curr[1],
                                unit="miles",
                            )
                        else:
                            logger.warning(
                                "Trip %s: Skipping distance calculation for invalid segment in LineString: %s to %s",
                                transaction_id,
                                prev,
                                curr,
                            )
                    self.processed_data["distance"] = total_distance
            else:  # Should not happen due to standardization
                self._set_state(
                    TripState.FAILED,
                    f"Unsupported GPS type '{gps_type}' for basic processing",
                )
                return False

            # Ensure start_coord and end_coord are valid before creating GeoPoints
            if not (
                isinstance(start_coord, list)
                and len(start_coord) == 2
                and isinstance(end_coord, list)
                and len(end_coord) == 2
            ):
                self._set_state(
                    TripState.FAILED,
                    "Invalid start or end coordinates derived for GeoPoint creation.",
                )
                return False

            self.processed_data["startGeoPoint"] = {
                "type": "Point",
                "coordinates": [start_coord[0], start_coord[1]],
            }
            self.processed_data["destinationGeoPoint"] = {
                "type": "Point",
                "coordinates": [end_coord[0], end_coord[1]],
            }

            if "totalIdleDuration" in self.processed_data:
                self.processed_data["totalIdleDurationFormatted"] = (
                    self.format_idle_time(
                        self.processed_data["totalIdleDuration"],
                    )
                )

            self._set_state(TripState.PROCESSED)
            logger.debug(
                "Completed basic processing for trip %s",
                transaction_id,
            )
            return True

        except Exception as e:
            error_message = f"Processing error: {e!s}"
            logger.exception(
                "Error in basic processing for trip %s",
                self.trip_data.get("transactionId", "unknown"),
            )
            self._set_state(TripState.FAILED, error_message)
            return False

    @staticmethod
    async def get_place_at_point(
        point: Point,
    ) -> dict[str, Any] | None:
        """Find a custom place that contains the given point.

        Args:
            point: A shapely Point to check

        Returns:
            Place document if found, None otherwise

        """
        point_geojson = {
            "type": "Point",
            "coordinates": [point.x, point.y],
        }
        query = {"geometry": {"$geoIntersects": {"$geometry": point_geojson}}}

        try:
            return await places_collection.find_one(query)
        except Exception as e:
            logger.error(
                "Error finding place at point: %s",
                str(e),
            )
            return None

    @staticmethod
    def _extract_coords_from_geometry(
        geometry,
        fallback_coords,
        transaction_id,
    ):
        """Extract a simple [lng, lat] point from various geometry types."""
        if not geometry or "coordinates" not in geometry:
            return fallback_coords

        geom_type = geometry.get("type", "Point")
        coords = geometry["coordinates"]

        if geom_type == "Point":
            if isinstance(coords, list) and len(coords) >= 2:
                return coords
        elif geom_type == "Polygon":
            if (
                isinstance(coords, list)
                and coords
                and isinstance(coords[0], list)
                and coords[0]
                and isinstance(coords[0][0], list)
                and len(coords[0][0]) >= 2
            ):
                return coords[0][0]
            logger.warning(
                "Invalid polygon format in geometry for trip %s: %s",
                transaction_id,
                coords,
            )
        else:
            logger.warning(
                "Unsupported geometry type '%s' in place for trip %s",
                geom_type,
                transaction_id,
            )

        return fallback_coords

    async def geocode(self) -> bool:
        """Perform geocoding for trip start and end points. Stores location
        data in structured format optimized for analytics.

        Returns:
            True if geocoding succeeded, False otherwise

        """
        try:
            transaction_id = self.trip_data.get("transactionId", "unknown")

            if self.state == TripState.NEW:
                await self.validate()
                if self.state == TripState.VALIDATED:
                    await self.process_basic()
                if self.state != TripState.PROCESSED:
                    logger.warning(
                        "Cannot geocode trip that hasn't been processed: %s",
                        transaction_id,
                    )
                    return False
            elif self.state != TripState.PROCESSED:
                logger.warning(
                    "Cannot geocode trip that hasn't been processed: %s",
                    transaction_id,
                )
                return False

            logger.debug(
                "Geocoding trip %s",
                transaction_id,
            )

            # Force a fresh geocoding pass each time this method is called by
            # clearing any previously stored location/place fields.  This allows
            # newly-created custom places to be picked up when a user requests a
            # geocoding refresh from the UI.
            for _field in (
                "startLocation",
                "destination",
                "startPlaceId",
                "destinationPlaceId",
            ):
                self.processed_data.pop(_field, None)

            start_coord = self.processed_data["startGeoPoint"]["coordinates"]
            end_coord = self.processed_data["destinationGeoPoint"]["coordinates"]

            start_pt = Point(start_coord[0], start_coord[1])
            end_pt = Point(end_coord[0], end_coord[1])

            LOCATION_SCHEMA = {
                "formatted_address": "",
                "address_components": {
                    "street_number": "",
                    "street": "",
                    "city": "",
                    "county": "",
                    "state": "",
                    "postal_code": "",
                    "country": "",
                },
                "coordinates": {
                    "lat": 0.0,
                    "lng": 0.0,
                },
            }

            if not self.processed_data.get("startLocation"):
                start_place = await self.get_place_at_point(start_pt)
                if start_place:
                    structured_start = LOCATION_SCHEMA.copy()
                    structured_start["formatted_address"] = start_place.get(
                        "name",
                        "",
                    )

                    for component in [
                        "address",
                        "city",
                        "state",
                        "postal_code",
                        "country",
                    ]:
                        if component in start_place:
                            if component == "address":
                                structured_start["address_components"]["street"] = (
                                    start_place[component]
                                )
                            else:
                                structured_start["address_components"][component] = (
                                    start_place[component]
                                )

                    if "geometry" in start_place:
                        extracted_coords = self._extract_coords_from_geometry(
                            start_place["geometry"],
                            [
                                start_coord[0],
                                start_coord[1],
                            ],
                            transaction_id,
                        )
                        structured_start["coordinates"]["lng"] = extracted_coords[0]
                        structured_start["coordinates"]["lat"] = extracted_coords[1]
                    else:
                        structured_start["coordinates"]["lng"] = start_coord[0]
                        structured_start["coordinates"]["lat"] = start_coord[1]

                    self.processed_data["startLocation"] = structured_start
                    self.processed_data["startPlaceId"] = str(
                        start_place.get("_id", ""),
                    )
                else:
                    rev_start = await reverse_geocode_nominatim(
                        start_coord[1],
                        start_coord[0],
                    )
                    if rev_start:
                        structured_start = LOCATION_SCHEMA.copy()
                        structured_start["formatted_address"] = rev_start.get(
                            "display_name",
                            "",
                        )

                        if "address" in rev_start:
                            addr = rev_start["address"]
                            component_mapping = {
                                "house_number": "street_number",
                                "road": "street",
                                "city": "city",
                                "town": "city",
                                "village": "city",
                                "county": "county",
                                "state": "state",
                                "postcode": "postal_code",
                                "country": "country",
                            }

                            for (
                                nominatim_key,
                                our_key,
                            ) in component_mapping.items():
                                if nominatim_key in addr:
                                    structured_start["address_components"][our_key] = (
                                        addr[nominatim_key]
                                    )

                        structured_start["coordinates"]["lng"] = start_coord[0]
                        structured_start["coordinates"]["lat"] = start_coord[1]

                        self.processed_data["startLocation"] = structured_start

            if not self.processed_data.get("destination"):
                end_place = await self.get_place_at_point(end_pt)
                if end_place:
                    structured_dest = LOCATION_SCHEMA.copy()
                    structured_dest["formatted_address"] = end_place.get(
                        "name",
                        "",
                    )

                    for component in [
                        "address",
                        "city",
                        "state",
                        "postal_code",
                        "country",
                    ]:
                        if component in end_place:
                            if component == "address":
                                structured_dest["address_components"]["street"] = (
                                    end_place[component]
                                )
                            else:
                                structured_dest["address_components"][component] = (
                                    end_place[component]
                                )

                    if "geometry" in end_place:
                        extracted_coords = self._extract_coords_from_geometry(
                            end_place["geometry"],
                            [
                                end_coord[0],
                                end_coord[1],
                            ],
                            transaction_id,
                        )
                        structured_dest["coordinates"]["lng"] = extracted_coords[0]
                        structured_dest["coordinates"]["lat"] = extracted_coords[1]
                    else:
                        structured_dest["coordinates"]["lng"] = end_coord[0]
                        structured_dest["coordinates"]["lat"] = end_coord[1]

                    self.processed_data["destination"] = structured_dest
                    self.processed_data["destinationPlaceId"] = str(
                        end_place.get("_id", ""),
                    )
                else:
                    rev_end = await reverse_geocode_nominatim(
                        end_coord[1],
                        end_coord[0],
                    )
                    if rev_end:
                        structured_dest = LOCATION_SCHEMA.copy()
                        structured_dest["formatted_address"] = rev_end.get(
                            "display_name",
                            "",
                        )

                        if "address" in rev_end:
                            addr = rev_end["address"]
                            component_mapping = {
                                "house_number": "street_number",
                                "road": "street",
                                "city": "city",
                                "town": "city",
                                "village": "city",
                                "county": "county",
                                "state": "state",
                                "postcode": "postal_code",
                                "country": "country",
                            }

                            for (
                                nominatim_key,
                                our_key,
                            ) in component_mapping.items():
                                if nominatim_key in addr:
                                    structured_dest["address_components"][our_key] = (
                                        addr[nominatim_key]
                                    )

                        structured_dest["coordinates"]["lng"] = end_coord[0]
                        structured_dest["coordinates"]["lat"] = end_coord[1]

                        self.processed_data["destination"] = structured_dest

            self.processed_data["location_schema_version"] = 2

            self.processed_data["geocoded_at"] = get_current_utc_time()

            self._set_state(TripState.GEOCODED)
            logger.debug("Geocoded trip %s", transaction_id)
            return True

        except Exception as e:
            error_message = f"Geocoding error: {e!s}"
            logger.exception(
                "Error geocoding trip %s",
                self.trip_data.get("transactionId", "unknown"),
            )
            self._set_state(TripState.FAILED, error_message)
            return False

    async def map_match(self) -> bool:
        """Perform map matching for the trip.

        Returns:
            True if map matching succeeded or was appropriately handled, False otherwise

        """
        try:
            transaction_id = self.trip_data.get("transactionId", "unknown")

            if self.state not in [
                TripState.GEOCODED,
                TripState.PROCESSED,
                TripState.VALIDATED,
            ]:
                if self.state in [
                    TripState.NEW,
                    TripState.VALIDATED,
                    TripState.PROCESSED,
                ]:
                    logger.info(
                        "Trip %s not geocoded, attempting pre-processing before map matching.",
                        transaction_id,
                    )
                    await self.geocode()
                    if self.state != TripState.GEOCODED:
                        logger.warning(
                            "Cannot map match trip %s: Failed pre-requisite geocoding step (Current state: %s)",
                            transaction_id,
                            self.state.value,
                        )
                        return False
                else:
                    logger.warning(
                        "Cannot map match trip %s in current state: %s",
                        transaction_id,
                        self.state.value,
                    )
                    return False

            logger.debug(
                "Starting map matching for trip %s",
                transaction_id,
            )

            if not config.mapbox_access_token:
                logger.warning(
                    "No Mapbox token provided, skipping map matching for trip %s",
                    transaction_id,
                )
                return True

            gps_data = self.processed_data.get(
                "gps"
            )  # Should be a GeoJSON dict or None

            if not gps_data or not isinstance(gps_data, dict):
                self._set_state(
                    TripState.FAILED,
                    "Invalid or missing GPS data for map matching",
                )
                return False

            gps_type = gps_data.get("type")
            map_match_input_coords = []

            if gps_type == "Point":
                # Map matching a single point doesn't make sense with Mapbox Matching API
                # which expects a path. We can skip or treat it as already "matched".
                logger.info(
                    "Trip %s: GPS data is a single Point, skipping Mapbox map matching.",
                    transaction_id,
                )
                # Optionally, set matchedGps to be the same as gps if it's a Point
                # self.processed_data["matchedGps"] = gps_data
                # self._set_state(TripState.MAP_MATCHED) # Or just return True
                return True
            elif gps_type == "LineString":
                map_match_input_coords = gps_data.get("coordinates", [])
                if len(map_match_input_coords) < 2:
                    logger.warning(
                        "Trip %s: LineString has insufficient coordinates (%d) for map matching. Skipping.",
                        transaction_id,
                        len(map_match_input_coords),
                    )
                    return True  # Not a failure of the process, just unmatchable
            else:
                logger.warning(
                    "Trip %s: GPS data has unexpected type '%s' for map matching. Skipping.",
                    transaction_id,
                    gps_type,
                )
                return True  # Not a failure, but can't match

            match_result_api = await self._map_match_coordinates(map_match_input_coords)

            if match_result_api.get("code") != "Ok":
                error_msg = match_result_api.get(
                    "message",
                    "Unknown map matching error from API",
                )
                logger.error(
                    "Map matching API failed for trip %s: %s",
                    transaction_id,
                    error_msg,
                )
                self.errors["map_match"] = f"Map matching API failed: {error_msg}"
                return True

            validated_matched_gps = None
            if match_result_api.get("matchings") and match_result_api["matchings"][
                0
            ].get("geometry"):
                matched_geometry = match_result_api["matchings"][0]["geometry"]
                geom_type = matched_geometry.get("type")
                geom_coords = matched_geometry.get("coordinates")

                if geom_type == "LineString":
                    if not isinstance(geom_coords, list) or len(geom_coords) < 2:
                        logger.warning(
                            "Map match for trip %s returned LineString with < 2 points. Discarding matchedGps.",
                            transaction_id,
                        )
                    else:
                        start_point = tuple(geom_coords[0])

                        all_identical = all(
                            tuple(p) == start_point for p in geom_coords[1:]
                        )

                        if all_identical:
                            logger.warning(
                                "Map match for trip %s resulted in LineString with identical points. Converting to Point.",
                                transaction_id,
                            )
                            validated_matched_gps = {
                                "type": "Point",
                                "coordinates": geom_coords[0],
                            }
                        elif len(geom_coords) >= 2:
                            validated_matched_gps = matched_geometry
                        else:
                            logger.warning(
                                "Map match for trip %s returned ambiguous LineString. Discarding. Coords: %s",
                                transaction_id,
                                geom_coords[:5],
                            )

                elif geom_type == "Point":
                    if isinstance(geom_coords, list) and len(geom_coords) == 2:
                        validated_matched_gps = matched_geometry
                    else:
                        logger.warning(
                            "Map match for trip %s returned Point with invalid coordinates format. Discarding. Coords: %s",
                            transaction_id,
                            geom_coords,
                        )
                else:
                    logger.warning(
                        "Map match for trip %s returned unexpected geometry type: %s. Discarding.",
                        transaction_id,
                        geom_type,
                    )
            else:
                logger.warning(
                    "Map match result for trip %s missing 'matchings' or 'geometry'.",
                    transaction_id,
                )

            if validated_matched_gps:
                self.processed_data["matchedGps"] = validated_matched_gps
                self.processed_data["matched_at"] = get_current_utc_time()
                self._set_state(TripState.MAP_MATCHED)
                logger.debug(
                    "Map matched trip %s successfully (Type: %s)",
                    transaction_id,
                    validated_matched_gps["type"],
                )
            else:
                logger.info(
                    "No valid matchedGps data to save for trip %s.",
                    transaction_id,
                )

            return True

        except Exception as e:
            error_message = f"Unexpected map matching error: {e!s}"
            logger.exception(
                "Error map matching trip %s",
                self.trip_data.get("transactionId", "unknown"),
            )
            self._set_state(TripState.FAILED, error_message)
            return False

    def _initialize_projections(self, coords: list[list[float]]) -> None:
        """Initialize projections for map matching.

        Args:
            coords: The coordinates to use for determining UTM zone

        """
        lats = [c[1] for c in coords]
        lons = [c[0] for c in coords]
        center_lat = sum(lats) / len(lats)
        center_lon = sum(lons) / len(lons)

        utm_zone = int((center_lon + 180) / 6) + 1
        hemisphere = "north" if center_lat >= 0 else "south"

        self.utm_proj = pyproj.CRS(
            f"+proj=utm +zone={utm_zone} +{hemisphere} +ellps=WGS84",
        )
        self.project_to_utm = pyproj.Transformer.from_crs(
            pyproj.CRS("EPSG:4326"),
            self.utm_proj,
            always_xy=True,
        ).transform

    async def _map_match_coordinates(
        self,
        coordinates: list[list[float]],
        chunk_size: int = 100,
        overlap: int = 10,
        max_retries: int = 3,
        min_sub_chunk: int = 20,
        jump_threshold_m: float = 200.0,
    ) -> dict[str, Any]:
        """Map match coordinates using the Mapbox API with advanced chunking
        and stitching.

        Args:
            coordinates: List of [lon, lat] coordinates
            chunk_size: Maximum number of coordinates per Mapbox API request
            overlap: Number of coordinates to overlap between chunks
            max_retries: Maximum number of retries for failed chunks
            min_sub_chunk: Minimum number of coordinates for recursive splitting
            jump_threshold_m: Threshold for detecting jumps in meters

        Returns:
            Dictionary with map matching results

        """
        if len(coordinates) < 2:
            return {
                "code": "Error",
                "message": "At least two coordinates are required for map matching.",
            }

        if not self.utm_proj:
            self._initialize_projections(coordinates)

        timeout = aiohttp.ClientTimeout(
            total=30,
            connect=10,
            sock_connect=10,
            sock_read=20,
        )

        async with aiohttp.ClientSession(timeout=timeout) as session:

            async def call_mapbox_api(
                coords: list[list[float]],
            ) -> dict[str, Any]:
                base_url = "https://api.mapbox.com/matching/v5/mapbox/driving/"
                coords_str = ";".join(f"{lon},{lat}" for lon, lat in coords)
                url = base_url + coords_str
                params = {
                    "access_token": config.mapbox_access_token,
                    "geometries": "geojson",
                    "radiuses": ";".join("25" for _ in coords),
                }

                max_attempts_for_429 = 5
                min_backoff_seconds = 2

                async with map_match_semaphore:
                    for retry_attempt in range(
                        1,
                        max_attempts_for_429 + 1,
                    ):
                        (
                            should_wait,
                            wait_time,
                        ) = await mapbox_rate_limiter.check_rate_limit()
                        if should_wait:
                            logger.info(
                                "Rate limit approaching - waiting %.2f seconds before API call",
                                wait_time,
                            )
                            await asyncio.sleep(wait_time)

                        try:
                            async with session.get(
                                url,
                                params=params,
                            ) as response:
                                if response.status == 429:
                                    logger.warning(
                                        "Received 429 Too Many Requests. Attempt=%d",
                                        retry_attempt,
                                    )
                                    retry_after = response.headers.get(
                                        "Retry-After",
                                    )
                                    wait_time = (
                                        float(retry_after)
                                        if retry_after is not None
                                        else min_backoff_seconds
                                        * (2 ** (retry_attempt - 1))
                                    )
                                    if retry_attempt < max_attempts_for_429:
                                        logger.info(
                                            "Sleeping %.1f seconds before retry... (attempt %d/%d)",
                                            wait_time,
                                            retry_attempt,
                                            max_attempts_for_429,
                                        )
                                        await asyncio.sleep(wait_time)
                                        continue
                                    logger.error(
                                        "Gave up after %d attempts for 429 errors.",
                                        retry_attempt,
                                    )
                                    raise aiohttp.ClientResponseError(
                                        response.request_info,
                                        response.history,
                                        status=429,
                                        message="Too Many Requests (exceeded max attempts)",
                                    )

                                if 400 <= response.status < 500:
                                    error_text = await response.text()
                                    logger.warning(
                                        f"Mapbox API client error: {response.status} - {error_text}"
                                    )
                                    return {
                                        "code": "Error",
                                        "message": f"Mapbox API error: {response.status}",
                                        "details": error_text,
                                    }

                                if response.status >= 500:
                                    if retry_attempt < max_attempts_for_429:
                                        wait_time = min_backoff_seconds * (
                                            2 ** (retry_attempt - 1)
                                        )
                                        logger.warning(
                                            "Mapbox server error %d, retrying in %f seconds",
                                            response.status,
                                            wait_time,
                                        )
                                        await asyncio.sleep(wait_time)
                                        continue
                                    error_text = await response.text()
                                    return {
                                        "code": "Error",
                                        "message": f"Mapbox server error: {response.status}",
                                        "details": error_text,
                                    }

                                response.raise_for_status()
                                data = await response.json()
                                return data

                        except Exception as e:
                            if retry_attempt < max_attempts_for_429:
                                wait_time = min_backoff_seconds * (
                                    2 ** (retry_attempt - 1)
                                )
                                logger.warning(
                                    "Mapbox API error: %s. Retrying in %f seconds (attempt %d/%d)",
                                    str(e),
                                    wait_time,
                                    retry_attempt,
                                    max_attempts_for_429,
                                )
                                await asyncio.sleep(wait_time)
                                continue
                            logger.error(
                                "Failed after %d retries: %s",
                                max_attempts_for_429,
                                str(e),
                            )
                            return {
                                "code": "Error",
                                "message": f"Mapbox API error after {max_attempts_for_429} retries: {e!s}",
                            }

                    return {
                        "code": "Error",
                        "message": "All retry attempts failed",
                    }

            async def match_chunk(
                chunk_coords: list[list[float]],
                depth: int = 0,
            ) -> list[list[float]] | None:
                if len(chunk_coords) < 2:
                    return []
                if len(chunk_coords) > 100:
                    logger.error(
                        "match_chunk received >100 coords unexpectedly.",
                    )
                    return []
                try:
                    data = await call_mapbox_api(chunk_coords)
                    if data.get("code") == "Ok" and data.get("matchings"):
                        return data["matchings"][0]["geometry"]["coordinates"]

                    msg = data.get(
                        "message",
                        "Mapbox API error (code != Ok)",
                    )
                    logger.warning(
                        "Mapbox chunk error: %s",
                        msg,
                    )

                    if "invalid coordinates" in msg.lower():
                        filtered_coords = filter_invalid_coordinates(
                            chunk_coords,
                        )
                        if len(filtered_coords) >= 2 and len(
                            filtered_coords,
                        ) < len(chunk_coords):
                            logger.info(
                                "Retrying with %d filtered coordinates",
                                len(filtered_coords),
                            )
                            return await match_chunk(
                                filtered_coords,
                                depth,
                            )

                except Exception as exc:
                    logger.warning(
                        "Unexpected error in mapbox chunk: %s",
                        str(exc),
                    )

                if depth < max_retries and len(chunk_coords) > min_sub_chunk:
                    mid = len(chunk_coords) // 2
                    first_half = chunk_coords[:mid]
                    second_half = chunk_coords[mid:]
                    logger.info(
                        "Retry chunk of size %d by splitting into halves (%d, %d) at depth %d",
                        len(chunk_coords),
                        len(first_half),
                        len(second_half),
                        depth,
                    )
                    matched_first = await match_chunk(first_half, depth + 1)
                    matched_second = await match_chunk(second_half, depth + 1)
                    if matched_first is not None and matched_second is not None:
                        if (
                            matched_first
                            and matched_second
                            and matched_first[-1] == matched_second[0]
                        ):
                            matched_second = matched_second[1:]
                        return matched_first + matched_second

                logger.error(
                    "Chunk of size %d failed after %d retries, giving up.",
                    len(chunk_coords),
                    depth,
                )
                return None

            def filter_invalid_coordinates(
                coords: list[list[float]],
            ) -> list[list[float]]:
                """Filter out potentially invalid coordinates."""
                valid_coords = []
                for coord in coords:
                    if (
                        len(coord) >= 2
                        and isinstance(coord[0], (int, float))
                        and isinstance(coord[1], (int, float))
                        and -180 <= coord[0] <= 180
                        and -90 <= coord[1] <= 90
                    ):
                        valid_coords.append(coord)

                return valid_coords

            n = len(coordinates)
            chunk_indices = []
            start_idx = 0
            while start_idx < n:
                end_idx = min(start_idx + chunk_size, n)
                chunk_indices.append((start_idx, end_idx))
                if end_idx == n:
                    break
                start_idx = end_idx - overlap

            logger.info(
                "Splitting %d coords into %d chunks (chunk_size=%d, overlap=%d)",
                n,
                len(chunk_indices),
                chunk_size,
                overlap,
            )

            final_matched: list[list[float]] = []
            for cindex, (
                start_i,
                end_i,
            ) in enumerate(chunk_indices, 1):
                chunk_coords = coordinates[start_i:end_i]
                logger.debug(
                    "Matching chunk %d/%d with %d coords",
                    cindex,
                    len(chunk_indices),
                    len(chunk_coords),
                )
                result = await match_chunk(chunk_coords, depth=0)
                if result is None:
                    msg = f"Chunk {cindex} of {len(chunk_indices)} failed map matching."
                    logger.error(msg)
                    return {
                        "code": "Error",
                        "message": msg,
                    }
                if not final_matched:
                    final_matched = result
                else:
                    if final_matched[-1] == result[0]:
                        result = result[1:]
                    final_matched.extend(result)

            logger.info(
                "Stitched matched coords from all chunks, total points=%d",
                len(final_matched),
            )

            def detect_big_jumps(
                coords: list[list[float]],
                threshold_m: float = 200,
            ) -> list[int]:
                suspicious_indices = []
                for i in range(len(coords) - 1):
                    lon1, lat1 = coords[i]
                    lon2, lat2 = coords[i + 1]
                    distance = haversine(
                        lon1,
                        lat1,
                        lon2,
                        lat2,
                        unit="meters",
                    )
                    if distance > threshold_m:
                        suspicious_indices.append(i)
                return suspicious_indices

            max_jump_passes = 2
            pass_count = 0
            while pass_count < max_jump_passes:
                big_jumps = detect_big_jumps(
                    final_matched,
                    jump_threshold_m,
                )
                if not big_jumps:
                    break
                logger.info(
                    "Found %d suspicious jump(s) on pass %d",
                    len(big_jumps),
                    pass_count + 1,
                )
                fix_count = 0
                new_coords = final_matched[:]
                offset = 0
                for j_idx in big_jumps:
                    i = j_idx + offset
                    if i < 1 or i >= len(new_coords) - 1:
                        continue
                    start_sub = i - 1
                    end_sub = i + 2
                    sub_coords = new_coords[start_sub:end_sub]
                    if len(sub_coords) < 2:
                        continue
                    local_match = await match_chunk(sub_coords, depth=0)
                    if local_match and len(local_match) >= 2:
                        logger.info(
                            "Re-matched sub-segment around index %d, replaced %d points",
                            i,
                            (end_sub - start_sub),
                        )
                        new_coords = (
                            new_coords[:start_sub] + local_match + new_coords[end_sub:]
                        )
                        offset += len(local_match) - (end_sub - start_sub)
                        fix_count += 1
                    else:
                        logger.info(
                            "Local re-match for sub-segment around index %d failed, leaving as is",
                            i,
                        )
                final_matched = new_coords
                pass_count += 1
                if fix_count == 0:
                    break

            logger.info(
                "Final matched coords after jump detection: %d points",
                len(final_matched),
            )

            return {
                "code": "Ok",
                "matchings": [
                    {
                        "geometry": {
                            "type": "LineString",
                            "coordinates": final_matched,
                        },
                    },
                ],
            }

    async def save(
        self,
        map_match_result: bool | None = None,
    ) -> str | None:
        """Save the processed trip to the trips collection.

        Args:
            map_match_result: Optional override for whether to save map matching results

        Returns:
            ObjectId of the saved document if successful, None otherwise

        """
        try:
            if self.state not in [
                TripState.VALIDATED,
                TripState.PROCESSED,
                TripState.GEOCODED,
                TripState.MAP_MATCHED,
                TripState.COMPLETED,
            ]:
                logger.warning(
                    "Cannot save trip %s that hasn't been processed (State: %s)",
                    self.trip_data.get("transactionId", "unknown"),
                    self.state.value,
                )
                return None

            trip_to_save = self.processed_data.copy()

            # Final safeguard: convert stringified GPS to object and validate before save
            gps_to_save = trip_to_save.get("gps")
            if isinstance(gps_to_save, str):
                logger.warning(
                    "Attempted to save trip %s with stringified GPS data. Parsing it back to an object.",
                    trip_to_save.get("transactionId", "unknown"),
                )
                try:
                    trip_to_save["gps"] = json.loads(gps_to_save)
                except json.JSONDecodeError:
                    logger.error(
                        "Failed to parse stringified GPS data for trip %s. Setting GPS to null to prevent saving bad data.",
                        trip_to_save.get("transactionId", "unknown"),
                    )
                    trip_to_save["gps"] = None

            # Final validation check after any potential parsing
            if trip_to_save.get("gps") is not None and not self._is_valid_geojson_object(
                trip_to_save["gps"]
            ):
                logger.error(
                    "Trip %s: 'gps' field is invalid at save time. Value: %s. Setting to null.",
                    trip_to_save.get("transactionId", "unknown"),
                    trip_to_save["gps"],
                )
                trip_to_save["gps"] = None

            trip_to_save["source"] = self.source
            trip_to_save["saved_at"] = get_current_utc_time()
            trip_to_save["processing_history"] = self.state_history

            if "_id" in trip_to_save:
                del trip_to_save["_id"]

            collection = trips_collection
            transaction_id = trip_to_save.get("transactionId")

            await collection.update_one(
                {"transactionId": transaction_id},
                {"$set": trip_to_save},
                upsert=True,
            )

            if (
                map_match_result or self.state == TripState.MAP_MATCHED
            ) and "matchedGps" in trip_to_save:
                # `matchedGps` should also be a GeoJSON dict (Point or LineString) or None.
                matched_gps_to_save = trip_to_save.get("matchedGps")
                if matched_gps_to_save is not None and not (
                    isinstance(matched_gps_to_save, dict)
                    and matched_gps_to_save.get("type") in ["Point", "LineString"]
                    and "coordinates" in matched_gps_to_save
                ):
                    logger.warning(
                        "Invalid GeoJSON structure in matchedGps for trip %s. Not saving to matched_trips_collection. Value: %s",
                        transaction_id,
                        matched_gps_to_save,
                    )
                elif matched_gps_to_save:  # It's a valid GeoJSON dict
                    # Ensure it's a LineString for matched_trips_collection as per original logic,
                    # For `matchedGps`, use `_is_valid_geojson_for_matched_collection`
                    # which might have specific rules (e.g. must be LineString).
                    if not self._is_valid_geojson_for_matched_collection(
                        matched_gps_to_save
                    ):
                        logger.warning(
                            "matchedGps for trip %s is not suitable for matched_trips_collection. Value: %s. Not saving to matched_trips.",
                            transaction_id,
                            matched_gps_to_save,
                        )
                        # Do not proceed to save this to matched_trips_collection
                    else:
                        # Ensure that matchedGps is also explicitly set to null if it becomes invalid,
                        # though _is_valid_geojson_for_matched_collection should catch it.
                        # This 'else' branch means it IS valid for the matched collection.
                        matched_trip_data = {
                            "transactionId": transaction_id,
                            "startTime": trip_to_save.get("startTime"),
                            "endTime": trip_to_save.get("endTime"),
                            "matchedGps": matched_gps_to_save,
                            "source": self.source,
                            "matched_at": trip_to_save.get("matched_at"),
                            "distance": trip_to_save.get("distance"),
                            "imei": trip_to_save.get("imei"),
                            "startLocation": trip_to_save.get("startLocation"),
                            "destination": trip_to_save.get("destination"),
                            "maxSpeed": trip_to_save.get("maxSpeed"),
                            "averageSpeed": trip_to_save.get("averageSpeed"),
                            "hardBrakingCount": trip_to_save.get(
                                "hardBrakingCount",
                            ),
                            "hardAccelerationCount": trip_to_save.get(
                                "hardAccelerationCount",
                            ),
                            "totalIdleDurationFormatted": trip_to_save.get(
                                "totalIdleDurationFormatted",
                            ),
                        }

                    matched_trip_data = {
                        k: v for k, v in matched_trip_data.items() if v is not None
                    }

                    try:
                        await matched_trips_collection.update_one(
                            {"transactionId": transaction_id},
                            {"$set": matched_trip_data},
                            upsert=True,
                        )
                    except DuplicateKeyError:
                        logger.info(
                            "Matched trip %s already exists (concurrent update?)",
                            transaction_id,
                        )
                    except Exception as matched_save_err:
                        logger.error(
                            "Error saving matched trip %s: %s",
                            transaction_id,
                            matched_save_err,
                        )

            logger.info(
                "Saved trip %s to %s successfully",
                transaction_id,
                collection.name,
            )

            saved_doc = await collection.find_one(
                {"transactionId": transaction_id},
            )

            return str(saved_doc["_id"]) if saved_doc else None

        except Exception as e:
            logger.error("Error saving trip: %s", str(e))
            return None

    @staticmethod
    def _is_valid_geojson_object(geojson_data: Any) -> bool:  # Renamed
        """Checks if the input is a structurally valid GeoJSON Point or LineString
        dictionary suitable for MongoDB 2dsphere indexing, including WGS84 range checks.
        """
        if not isinstance(geojson_data, dict):
            return False

        geom_type = geojson_data.get("type")
        coordinates = geojson_data.get("coordinates")

        if geom_type == "Point":
            if not isinstance(coordinates, list) or len(coordinates) != 2:
                return False
            if not all(isinstance(coord, (int, float)) for coord in coordinates):
                return False
            lon, lat = coordinates
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                logger.debug("Point coordinates out of WGS84 range: %s", [lon, lat])
                return False
            return True

        elif geom_type == "LineString":
            if not isinstance(coordinates, list) or len(coordinates) < 2:
                # LineString must have at least 2 points.
                # Note: _standardize_and_validate_gps_data might produce LineString with 1 point temporarily
                # if input was e.g. a list containing one point, but it should be converted to Point type.
                # This validator enforces GeoJSON spec for LineString.
                logger.debug(
                    f"LineString must have at least 2 coordinate pairs. Found: {len(coordinates)}"
                )
                return False
            for point in coordinates:
                if not isinstance(point, list) or len(point) != 2:
                    return False
                if not all(isinstance(coord, (int, float)) for coord in point):
                    return False
                lon, lat = point
                if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                    logger.debug("LineString point out of WGS84 range: %s", [lon, lat])
                    return False
            return True

        return False  # Not a Point or LineString

    def _is_valid_geojson_for_matched_collection(self, geojson_data: Any) -> bool:
        """
        Checks if the GeoJSON is suitable for the matched_trips_collection.
        This primarily ensures it's a valid GeoJSON Point or LineString,
        deferring to specific business logic (e.g. must be LineString) if any.
        Currently, map_match can produce Points for degenerate LineStrings.
        """
        if not self._is_valid_geojson_object(geojson_data):
            return False

        # Example: If matched_trips_collection *must* contain LineStrings only:
        # if geojson_data.get("type") != "LineString":
        #     logger.debug(f"Data for matched_trips_collection is not a LineString: type {geojson_data.get('type')}")
        #     return False
        return True

    @staticmethod
    def format_idle_time(seconds: Any) -> str:
        """Convert idle time in seconds to a HH:MM:SS string."""
        if not seconds:
            return "00:00:00"

        try:
            total_seconds = int(seconds)
            hrs = total_seconds // 3600
            mins = (total_seconds % 3600) // 60
            secs = total_seconds % 60
            return f"{hrs:02d}:{mins:02d}:{secs:02d}"
        except (TypeError, ValueError):
            logger.error("Invalid input for format_idle_time: %s", seconds)
            return "00:00:00"


# REMOVED: process_from_coordinates class method
# This functionality has been moved to TripService to consolidate
# trip processing logic and eliminate duplications
