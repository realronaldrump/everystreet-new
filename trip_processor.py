"""
Unified Trip Processor.

This module provides a TripProcessor class that orchestrates trip processing including
validation, parsing, geocoding, and map matching. It uses a state machine approach to
track processing status and delegates to specialized services for external API calls and
database persistence.
"""

import logging
from enum import Enum
from typing import Any

from pydantic import ValidationError
from shapely.geometry import Point

from date_utils import get_current_utc_time
from db import Place
from db.models import Trip
from external_geo_service import ExternalGeoService
from geometry_service import GeometryService
from trip_repository import TripRepository

logger = logging.getLogger(__name__)


class TripState(Enum):
    """Enumeration of trip processing states."""

    NEW = "new"
    VALIDATED = "validated"
    PROCESSED = "processed"
    GEOCODED = "geocoded"
    MAP_MATCHED = "map_matched"
    COMPLETED = "completed"
    FAILED = "failed"


class TripProcessor:
    """
    Orchestrates trip processing including validation, geocoding, and map matching.

    Uses a state machine approach to track processing status and delegates to
    specialized services for external API calls and database persistence.
    """

    def __init__(
        self,
        mapbox_token: str | None = None,
        source: str = "api",
        geo_service: ExternalGeoService | None = None,
        repository: TripRepository | None = None,
    ):
        """
        Initialize the trip processor.

        Args:
            mapbox_token: The Mapbox access token for map matching and geocoding
            source: Source of the trip data (api, upload, upload_gpx, bouncie, etc.)
            geo_service: Optional ExternalGeoService instance (for testing/DI)
            repository: Optional TripRepository instance (for testing/DI)
        """
        self.source = source
        self.mapbox_token = mapbox_token

        # Injected dependencies (lazy-initialize if not provided)
        self._geo_service = geo_service
        self._repository = repository

        # State machine
        self.state = TripState.NEW
        self.state_history: list[dict[str, Any]] = []
        self.errors: dict[str, str] = {}

        # Trip data
        self.trip_data: dict[str, Any] = {}
        self.processed_data: dict[str, Any] = {}

    @property
    def geo_service(self) -> ExternalGeoService:
        """Lazy-initialize geo service."""
        if self._geo_service is None:
            self._geo_service = ExternalGeoService(self.mapbox_token)
        return self._geo_service

    @property
    def repository(self) -> TripRepository:
        """Lazy-initialize repository."""
        if self._repository is None:
            self._repository = TripRepository()
        return self._repository

    def _set_state(
        self,
        new_state: TripState,
        error: str | None = None,
    ) -> None:
        """
        Update the processing state and record it in history.

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
        """
        Set the raw trip data to be processed.

        Args:
            trip_data: The raw trip data dictionary
        """
        self.trip_data = trip_data
        self.processed_data = trip_data.copy()
        self.state = TripState.NEW
        self._set_state(TripState.NEW)

    def get_processing_status(self) -> dict[str, Any]:
        """
        Get the current processing status.

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
        """
        Process the trip through all appropriate stages based on current state.

        Args:
            do_map_match: Whether to perform map matching

        Returns:
            The processed trip data
        """
        if not self.trip_data:
            self._set_state(TripState.FAILED, "No trip data provided")
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
        """
        Validate the trip data using Pydantic model.

        Returns:
            True if validation passed, False otherwise
        """
        try:
            transaction_id = self.trip_data.get("transactionId", "unknown")
            # Validate using Beanie model (which is also a Pydantic model)
            # and already contains the validation logic.
            validated_trip = Trip(**self.trip_data)
            self.processed_data = validated_trip.model_dump(exclude_unset=True)

            self.processed_data["validated_at"] = get_current_utc_time()
            self.processed_data["validation_status"] = TripState.VALIDATED.value
            self.processed_data["invalid"] = False
            self.processed_data["validation_message"] = None

            self._set_state(TripState.VALIDATED)
            logger.debug("Trip %s validated successfully", transaction_id)
            return True

        except ValidationError as e:
            error_message = f"Validation error: {e}"
            logger.warning(
                "Trip %s failed validation: %s",
                self.trip_data.get("transactionId", "unknown"),
                error_message,
            )
            self._set_state(TripState.FAILED, error_message)
            return False

        except Exception as e:
            error_message = f"Unexpected validation error: {e!s}"
            logger.exception(
                "Error validating trip %s",
                self.trip_data.get("transactionId", "unknown"),
            )
            self._set_state(TripState.FAILED, error_message)
            return False

    async def process_basic(self) -> bool:
        """
        Perform basic processing on trip data (timestamps, GPS parsing, etc.).

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

            logger.debug("Processing basic data for trip %s", transaction_id)

            gps_data = self.processed_data.get("gps")
            if not gps_data:
                self._set_state(
                    TripState.FAILED,
                    "Missing GPS data for basic processing",
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
                        "Point GeoJSON has invalid coordinates",
                    )
                    return False
                start_coord = gps_coords
                end_coord = gps_coords
                self.processed_data["distance"] = 0.0
            elif gps_type == "LineString":
                if not (
                    gps_coords and isinstance(gps_coords, list) and len(gps_coords) >= 2
                ):
                    self._set_state(
                        TripState.FAILED,
                        "LineString has insufficient coordinates",
                    )
                    return False
                start_coord = gps_coords[0]
                end_coord = gps_coords[-1]

                # Calculate distance if not provided
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
                            total_distance += GeometryService.haversine_distance(
                                prev[0],
                                prev[1],
                                curr[0],
                                curr[1],
                                unit="miles",
                            )
                    self.processed_data["distance"] = total_distance
            else:
                self._set_state(TripState.FAILED, f"Unsupported GPS type '{gps_type}'")
                return False

            # Validate coordinates
            if not (
                isinstance(start_coord, list)
                and len(start_coord) == 2
                and isinstance(end_coord, list)
                and len(end_coord) == 2
            ):
                self._set_state(TripState.FAILED, "Invalid start or end coordinates")
                return False

            if "totalIdleDuration" in self.processed_data:
                self.processed_data["totalIdleDurationFormatted"] = (
                    self.format_idle_time(
                        self.processed_data["totalIdleDuration"],
                    )
                )

            self._set_state(TripState.PROCESSED)
            logger.debug("Completed basic processing for trip %s", transaction_id)
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
    async def get_place_at_point(point: Point) -> dict[str, Any] | None:
        """
        Find a custom place that contains the given point.

        Args:
            point: A shapely Point to check

        Returns:
            Place document if found, None otherwise
        """
        point_geojson = {"type": "Point", "coordinates": [point.x, point.y]}
        query = {"geometry": {"$geoIntersects": {"$geometry": point_geojson}}}

        try:
            return await Place.find_one(query)
        except Exception as e:
            logger.exception("Error finding place at point: %s", str(e))
            return None

    @staticmethod
    def _extract_coords_from_geometry(
        geometry: dict[str, Any] | None,
        fallback_coords: list[float],
        transaction_id: str,
    ) -> list[float]:
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
            logger.warning("Invalid polygon format for trip %s", transaction_id)
        else:
            logger.warning(
                "Unsupported geometry type '%s' for trip %s",
                geom_type,
                transaction_id,
            )

        return fallback_coords

    async def geocode(self) -> bool:
        """
        Perform geocoding for trip start and end points.

        Returns:
            True if geocoding succeeded, False otherwise
        """
        try:
            transaction_id = self.trip_data.get("transactionId", "unknown")

            # Ensure trip is processed
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

            logger.debug("Geocoding trip %s", transaction_id)

            # Clear any previous location data for fresh geocoding
            for field in (
                "startLocation",
                "destination",
                "startPlaceId",
                "destinationPlaceId",
            ):
                self.processed_data.pop(field, None)

            # Extract start and end coordinates from gps field
            gps_data = self.processed_data.get("gps")
            if not gps_data or "coordinates" not in gps_data:
                self._set_state(TripState.FAILED, "Missing GPS data for geocoding")
                return False

            gps_type = gps_data.get("type")
            gps_coords = gps_data["coordinates"]

            if gps_type == "Point":
                start_coord = gps_coords
                end_coord = gps_coords
            elif (
                gps_type == "LineString"
                and isinstance(gps_coords, list)
                and len(gps_coords) >= 2
            ):
                start_coord = gps_coords[0]
                end_coord = gps_coords[-1]
            else:
                self._set_state(
                    TripState.FAILED,
                    f"Invalid GPS type or coordinates for geocoding: {gps_type}",
                )
                return False

            start_pt = Point(start_coord[0], start_coord[1])
            end_pt = Point(end_coord[0], end_coord[1])

            # Geocode start location
            if not self.processed_data.get("startLocation"):
                start_place = await self.get_place_at_point(start_pt)
                if start_place:
                    self.processed_data["startLocation"] = (
                        self._build_location_from_place(
                            start_place,
                            start_coord,
                            transaction_id,
                        )
                    )
                    self.processed_data["startPlaceId"] = str(
                        start_place.get("_id", ""),
                    )
                else:
                    # Use external geocoding service
                    rev_start = await self.geo_service.reverse_geocode(
                        start_coord[1],
                        start_coord[0],
                    )
                    if rev_start:
                        self.processed_data["startLocation"] = (
                            self.geo_service.parse_geocode_response(
                                rev_start,
                                start_coord,
                            )
                        )

            # Geocode destination
            if not self.processed_data.get("destination"):
                end_place = await self.get_place_at_point(end_pt)
                if end_place:
                    self.processed_data["destination"] = (
                        self._build_location_from_place(
                            end_place,
                            end_coord,
                            transaction_id,
                        )
                    )
                    self.processed_data["destinationPlaceId"] = str(
                        end_place.get("_id", ""),
                    )
                else:
                    rev_end = await self.geo_service.reverse_geocode(
                        end_coord[1],
                        end_coord[0],
                    )
                    if rev_end:
                        self.processed_data["destination"] = (
                            self.geo_service.parse_geocode_response(rev_end, end_coord)
                        )
                    else:
                        logger.warning(
                            "Trip %s: Failed to geocode destination",
                            transaction_id,
                        )

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

    def _build_location_from_place(
        self,
        place: dict[str, Any],
        coords: list[float],
        transaction_id: str,
    ) -> dict[str, Any]:
        """
        Build structured location data from a custom place.

        Args:
            place: The place document
            coords: Fallback coordinates [lon, lat]
            transaction_id: Transaction ID for logging

        Returns:
            Structured location dictionary
        """
        structured = ExternalGeoService.get_empty_location_schema()
        structured["formatted_address"] = place.get("name", "")

        for component in ["address", "city", "state", "postal_code", "country"]:
            if component in place:
                if component == "address":
                    structured["address_components"]["street"] = place[component]
                else:
                    structured["address_components"][component] = place[component]

        if "geometry" in place:
            extracted = self._extract_coords_from_geometry(
                place["geometry"],
                [coords[0], coords[1]],
                transaction_id,
            )
            structured["coordinates"]["lng"] = extracted[0]
            structured["coordinates"]["lat"] = extracted[1]
        else:
            structured["coordinates"]["lng"] = coords[0]
            structured["coordinates"]["lat"] = coords[1]

        return structured

    async def map_match(self) -> bool:
        """
        Perform map matching for the trip.

        Returns:
            True if map matching succeeded or was appropriately handled, False otherwise
        """
        try:
            transaction_id = self.trip_data.get("transactionId", "unknown")

            # Ensure proper state
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
                    await self.geocode()
                    if self.state != TripState.GEOCODED:
                        logger.warning(
                            "Cannot map match trip %s: pre-requisite steps failed",
                            transaction_id,
                        )
                        return False
                else:
                    logger.warning(
                        "Cannot map match trip %s in state: %s",
                        transaction_id,
                        self.state.value,
                    )
                    return False

            logger.debug("Starting map matching for trip %s", transaction_id)

            if not self.mapbox_token:
                logger.warning(
                    "No Mapbox token provided, skipping map matching for trip %s",
                    transaction_id,
                )
                return True

            gps_data = self.processed_data.get("gps")
            if not gps_data or not isinstance(gps_data, dict):
                self._set_state(
                    TripState.FAILED,
                    "Invalid or missing GPS data for map matching",
                )
                return False

            gps_type = gps_data.get("type")

            if gps_type == "Point":
                logger.info(
                    "Trip %s: GPS is a single Point, skipping map matching",
                    transaction_id,
                )
                return True

            if gps_type == "LineString":
                coords = gps_data.get("coordinates", [])
                if len(coords) < 2:
                    logger.warning(
                        "Trip %s: Insufficient coordinates for map matching",
                        transaction_id,
                    )
                    return True
            else:
                logger.warning(
                    "Trip %s: Unexpected GPS type '%s'",
                    transaction_id,
                    gps_type,
                )
                return True

            # Extract timestamps and call map matching service
            timestamps = self.geo_service.extract_timestamps_for_coordinates(
                coords,
                self.processed_data,
            )
            match_result = await self.geo_service.map_match_coordinates(
                coords,
                timestamps,
            )

            if match_result.get("code") != "Ok":
                error_msg = match_result.get("message", "Unknown map matching error")
                logger.error(
                    "Map matching failed for trip %s: %s",
                    transaction_id,
                    error_msg,
                )
                self.errors["map_match"] = f"Map matching API failed: {error_msg}"
                return True  # Not a processing failure, just couldn't match

            # Validate and store matched geometry
            validated_matched_gps = None
            if match_result.get("matchings") and match_result["matchings"][0].get(
                "geometry",
            ):
                matched_geometry = match_result["matchings"][0]["geometry"]
                geom_type = matched_geometry.get("type")
                geom_coords = matched_geometry.get("coordinates")

                if geom_type == "LineString":
                    if isinstance(geom_coords, list) and len(geom_coords) >= 2:
                        # Check for degenerate LineString (all identical points)
                        start_point = tuple(geom_coords[0])
                        if all(tuple(p) == start_point for p in geom_coords[1:]):
                            logger.warning(
                                "Trip %s: Matched LineString has identical points",
                                transaction_id,
                            )
                            validated_matched_gps = {
                                "type": "Point",
                                "coordinates": geom_coords[0],
                            }
                        else:
                            validated_matched_gps = matched_geometry
                elif (
                    geom_type == "Point"
                    and isinstance(geom_coords, list)
                    and len(geom_coords) == 2
                ):
                    validated_matched_gps = matched_geometry

            if validated_matched_gps:
                self.processed_data["matchedGps"] = validated_matched_gps
                self.processed_data["matched_at"] = get_current_utc_time()
                self._set_state(TripState.MAP_MATCHED)
                logger.debug("Map matched trip %s successfully", transaction_id)
            else:
                logger.info("No valid matchedGps data for trip %s", transaction_id)

            return True

        except Exception as e:
            error_message = f"Unexpected map matching error: {e!s}"
            logger.exception(
                "Error map matching trip %s",
                self.trip_data.get("transactionId", "unknown"),
            )
            self._set_state(TripState.FAILED, error_message)
            return False

    async def save(self, _map_match_result: bool | None = None) -> str | None:
        """
        Save the processed trip to the database.

        Args:
            map_match_result: Optional override for whether to save map matching results

        Returns:
            ObjectId of the saved document if successful, None otherwise
        """
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

        # Save to trips collection (includes matchedGps if present)
        return await self.repository.save_trip(
            self.processed_data,
            self.source,
            self.state_history,
        )

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
            logger.exception("Invalid input for format_idle_time: %s", seconds)
            return "00:00:00"
