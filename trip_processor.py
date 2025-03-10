"""
Unified Trip Processor

This module provides a comprehensive TripProcessor class that handles all aspects
of trip processing, including validation, parsing, geocoding, and map matching.
It uses a state machine approach to track processing status and ensures consistent
handling of all trip data.
"""

import json
import logging
import asyncio
from datetime import datetime, timezone
from enum import Enum
from typing import Dict, Any, Optional, Tuple, List, Union, Callable
import time

from shapely.geometry import LineString, Point, shape
import aiohttp
import pyproj
from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from db import (
    db_manager,
    trips_collection,
    matched_trips_collection,
    uploaded_trips_collection,
    places_collection,
)
from utils import reverse_geocode_nominatim, haversine, get_session

logger = logging.getLogger(__name__)


# Define the trip processing states
class TripState(Enum):
    NEW = "new"
    VALIDATED = "validated"
    PROCESSED = "processed"
    GEOCODED = "geocoded"
    MAP_MATCHED = "map_matched"
    COMPLETED = "completed"
    FAILED = "failed"


# Map matching configuration
MAPBOX_ACCESS_TOKEN = None
MAX_MAPBOX_COORDINATES = 100
RATE_LIMIT_WINDOW = 60  # seconds
MAX_REQUESTS_PER_MINUTE = 60
MAPBOX_REQUEST_COUNT = 0
MAPBOX_WINDOW_START = time.time()
RATE_LIMIT_LOCK = asyncio.Lock()


class TripProcessor:
    """
    Unified processor for trip data that handles all aspects of trip processing
    including validation, parsing, geocoding, and map matching using a state machine
    approach to track status.
    """

    def __init__(
            self,
            mapbox_token: Optional[str] = None,
            source: str = "api"):
        """
        Initialize the trip processor.

        Args:
            mapbox_token: The Mapbox access token for map matching
            source: Source of the trip data (api, upload, etc.)
        """
        global MAPBOX_ACCESS_TOKEN
        self.mapbox_token = mapbox_token
        MAPBOX_ACCESS_TOKEN = mapbox_token
        self.source = source

        # Mapbox rate limiting
        self.map_match_semaphore = asyncio.Semaphore(3)

        # State tracking
        self.state = TripState.NEW
        self.state_history = []
        self.errors = {}

        # Trip data
        self.trip_data = {}
        self.processed_data = {}

        # Initialize projections for map matching
        self.utm_proj = None
        self.project_to_utm = None
        self.project_to_wgs84 = None

    def _set_state(
            self,
            new_state: TripState,
            error: Optional[str] = None) -> None:
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
            "timestamp": datetime.now(timezone.utc),
        }

        if error and new_state == TripState.FAILED:
            state_change["error"] = error
            self.errors[previous_state.value] = error

        self.state_history.append(state_change)

    def set_trip_data(self, trip_data: Dict[str, Any]) -> None:
        """
        Set the raw trip data to be processed.

        Args:
            trip_data: The raw trip data dictionary
        """
        self.trip_data = trip_data
        self.processed_data = trip_data.copy()  # Start with a copy to build upon
        self.state = TripState.NEW
        self._set_state(TripState.NEW)

    def get_processing_status(self) -> Dict[str, Any]:
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

    async def process(self, do_map_match: bool = True) -> Dict[str, Any]:
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
            # Run all steps in sequence
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
            self._set_state(TripState.FAILED, f"Unexpected error: {str(e)}")
            logger.exception(
                f"Error processing trip {
                    self.trip_data.get(
                        'transactionId',
                        'unknown')}"
            )
            return {}

    async def validate(self) -> bool:
        """
        Validate the trip data.

        Returns:
            True if validation passed, False otherwise
        """
        try:
            transaction_id = self.trip_data.get("transactionId", "unknown")

            # Check required fields
            required = ["transactionId", "startTime", "endTime", "gps"]
            for field in required:
                if field not in self.trip_data:
                    self._set_state(
                        TripState.FAILED, f"Missing required field: {field}"
                    )
                    return False

            # Validate GPS data
            gps_data = self.trip_data.get("gps")
            if isinstance(gps_data, str):
                try:
                    gps_data = json.loads(gps_data)
                except json.JSONDecodeError:
                    self._set_state(
                        TripState.FAILED, "Invalid GPS data format")
                    return False

            if (
                not isinstance(gps_data, dict)
                or "type" not in gps_data
                or "coordinates" not in gps_data
            ):
                self._set_state(TripState.FAILED,
                                "GPS data missing 'type' or 'coordinates'")
                return False

            if not isinstance(gps_data["coordinates"], list):
                self._set_state(
                    TripState.FAILED,
                    "GPS coordinates must be a list")
                return False

            if len(gps_data["coordinates"]) < 2:
                self._set_state(TripState.FAILED,
                                "GPS coordinates must have at least 2 points")
                return False

            # Copy validated data to processed data
            self.processed_data = self.trip_data.copy()

            # Add validation timestamp
            self.processed_data["validated_at"] = datetime.now(timezone.utc)
            self.processed_data["validation_status"] = TripState.VALIDATED.value

            # Update state
            self._set_state(TripState.VALIDATED)
            return True

        except Exception as e:
            self._set_state(TripState.FAILED, f"Validation error: {str(e)}")
            return False

    async def process_basic(self) -> bool:
        """
        Perform basic processing on trip data (timestamps, GPS parsing, etc.).

        Returns:
            True if processing succeeded, False otherwise
        """
        try:
            if self.state != TripState.VALIDATED:
                if self.state == TripState.NEW:
                    # Try to validate first
                    await self.validate()
                    if self.state != TripState.VALIDATED:
                        return False
                else:
                    logger.warning(
                        f"Cannot process trip that hasn't been validated: {
                            self.trip_data.get(
                                'transactionId', 'unknown')}"
                    )
                    return False

            # Handle timestamps
            from dateutil import parser

            for key in ("startTime", "endTime"):
                val = self.processed_data.get(key)
                if isinstance(val, str):
                    dt = parser.isoparse(val)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    self.processed_data[key] = dt

            # Parse GPS data
            gps_data = self.processed_data.get("gps")
            if isinstance(gps_data, str):
                try:
                    gps_data = json.loads(gps_data)
                    self.processed_data["gps"] = gps_data
                except json.JSONDecodeError:
                    self._set_state(
                        TripState.FAILED, "Failed to parse GPS data")
                    return False

            # Get coordinates
            coords = gps_data.get("coordinates", [])
            if len(coords) < 2:
                self._set_state(TripState.FAILED, "Insufficient coordinates")
                return False

            # Extract start and end points for later geocoding
            start_coord = coords[0]
            end_coord = coords[-1]

            # Set geo-points for spatial queries
            self.processed_data["startGeoPoint"] = {
                "type": "Point",
                "coordinates": [start_coord[0], start_coord[1]],
            }
            self.processed_data["destinationGeoPoint"] = {
                "type": "Point",
                "coordinates": [end_coord[0], end_coord[1]],
            }

            # Calculate basic metrics if not present
            if (
                "distance" not in self.processed_data
                or not self.processed_data["distance"]
            ):
                # Calculate distance by summing segments
                total_distance = 0
                for i in range(1, len(coords)):
                    prev = coords[i - 1]
                    curr = coords[i]
                    total_distance += haversine(
                        prev[0], prev[1], curr[0], curr[1], unit="miles"
                    )
                self.processed_data["distance"] = total_distance

            # Format idle time if available
            if "totalIdleDuration" in self.processed_data:
                self.processed_data["totalIdleDurationFormatted"] = (
                    self.format_idle_time(self.processed_data["totalIdleDuration"])
                )

            # Update state
            self._set_state(TripState.PROCESSED)
            return True

        except Exception as e:
            self._set_state(TripState.FAILED, f"Processing error: {str(e)}")
            return False

    async def get_place_at_point(
            self, point: Point) -> Optional[Dict[str, Any]]:
        """
        Find a custom place that contains the given point.

        Args:
            point: A shapely Point to check

        Returns:
            Place document if found, None otherwise
        """
        point_geojson = {"type": "Point", "coordinates": [point.x, point.y]}
        query = {"geometry": {"$geoIntersects": {"$geometry": point_geojson}}}

        return await db_manager.execute_with_retry(
            lambda: places_collection.find_one(query),
            operation_name="find_place_at_point",
        )

    async def geocode(self) -> bool:
        """
        Perform geocoding for trip start and end points.

        Returns:
            True if geocoding succeeded, False otherwise
        """
        try:
            if self.state == TripState.NEW:
                # Try to validate and process first
                await self.validate()
                if self.state == TripState.VALIDATED:
                    await self.process_basic()
                if self.state != TripState.PROCESSED:
                    logger.warning(
                        f"Cannot geocode trip that hasn't been processed: {
                            self.trip_data.get(
                                'transactionId', 'unknown')}"
                    )
                    return False
            elif self.state != TripState.PROCESSED:
                logger.warning(
                    f"Cannot geocode trip that hasn't been processed: {
                        self.trip_data.get(
                            'transactionId', 'unknown')}"
                )
                return False

            # Extract coordinates from geo-points
            start_coord = self.processed_data["startGeoPoint"]["coordinates"]
            end_coord = self.processed_data["destinationGeoPoint"]["coordinates"]

            start_pt = Point(start_coord[0], start_coord[1])
            end_pt = Point(end_coord[0], end_coord[1])

            # Determine start location if not already set
            if not self.processed_data.get("startLocation"):
                # First check for custom places
                start_place = await self.get_place_at_point(start_pt)
                if start_place:
                    self.processed_data["startLocation"] = start_place.get(
                        "name", "")
                    self.processed_data["startPlaceId"] = str(
                        start_place.get("_id", "")
                    )
                else:
                    # Fall back to reverse geocoding
                    rev_start = await reverse_geocode_nominatim(
                        start_coord[1], start_coord[0]
                    )
                    if rev_start:
                        self.processed_data["startLocation"] = rev_start.get(
                            "display_name", ""
                        )

            # Determine end location if not already set
            if not self.processed_data.get("destination"):
                # First check for custom places
                end_place = await self.get_place_at_point(end_pt)
                if end_place:
                    self.processed_data["destination"] = end_place.get(
                        "name", "")
                    self.processed_data["destinationPlaceId"] = str(
                        end_place.get("_id", "")
                    )
                else:
                    # Fall back to reverse geocoding
                    rev_end = await reverse_geocode_nominatim(
                        end_coord[1], end_coord[0]
                    )
                    if rev_end:
                        self.processed_data["destination"] = rev_end.get(
                            "display_name", ""
                        )

            # Add geocoding timestamp
            self.processed_data["geocoded_at"] = datetime.now(timezone.utc)

            # Update state
            self._set_state(TripState.GEOCODED)
            return True

        except Exception as e:
            self._set_state(TripState.FAILED, f"Geocoding error: {str(e)}")
            return False

    async def map_match(self) -> bool:
        """
        Perform map matching for the trip.

        Returns:
            True if map matching succeeded, False otherwise
        """
        try:
            if self.state == TripState.NEW:
                # Try to validate, process, and geocode first
                await self.process(do_map_match=False)
                if self.state != TripState.GEOCODED:
                    logger.warning(
                        f"Cannot map match trip that hasn't been geocoded: {
                            self.trip_data.get(
                                'transactionId', 'unknown')}"
                    )
                    return False
            elif self.state != TripState.GEOCODED:
                logger.warning(
                    f"Cannot map match trip that hasn't been geocoded: {
                        self.trip_data.get(
                            'transactionId', 'unknown')}"
                )
                return False

            if not self.mapbox_token:
                logger.warning(
                    "No Mapbox token provided, skipping map matching")
                return False

            # Get coordinates
            gps_data = self.processed_data["gps"]
            if isinstance(gps_data, str):
                gps_data = json.loads(gps_data)

            coords = gps_data.get("coordinates", [])
            if len(coords) < 2:
                self._set_state(TripState.FAILED,
                                "Insufficient coordinates for map matching")
                return False

            # Perform map matching
            match_result = await self._map_match_coordinates(coords)
            if match_result.get("code") != "Ok":
                error_msg = match_result.get(
                    "message", "Unknown map matching error")
                self._set_state(
                    TripState.FAILED,
                    f"Map matching failed: {error_msg}")
                return False

            # Store matched result
            self.processed_data["matchedGps"] = match_result["matchings"][0]["geometry"]
            self.processed_data["matched_at"] = datetime.now(timezone.utc)

            # Update state
            self._set_state(TripState.MAP_MATCHED)
            return True

        except Exception as e:
            self._set_state(TripState.FAILED, f"Map matching error: {str(e)}")
            return False

    async def _check_rate_limit(self) -> Tuple[bool, float]:
        """
        Check if we're about to exceed the rate limit.

        Returns:
            (True, wait_time) if we need to wait, (False, 0) otherwise
        """
        global MAPBOX_REQUEST_COUNT, MAPBOX_WINDOW_START

        async with RATE_LIMIT_LOCK:
            current_time = time.time()
            elapsed = current_time - MAPBOX_WINDOW_START

            # Reset window if it's been longer than the window duration
            if elapsed > RATE_LIMIT_WINDOW:
                MAPBOX_REQUEST_COUNT = 0
                MAPBOX_WINDOW_START = current_time
                return False, 0

            # Check if we're about to exceed the rate limit
            if MAPBOX_REQUEST_COUNT >= MAX_REQUESTS_PER_MINUTE:
                # Calculate time to wait until the window resets
                wait_time = RATE_LIMIT_WINDOW - elapsed
                return True, max(0.1, wait_time)

            # Increment the request count
            MAPBOX_REQUEST_COUNT += 1
            return False, 0

    def _initialize_projections(self, coords: List[List[float]]) -> None:
        """
        Initialize projections for map matching.

        Args:
            coords: The coordinates to use for determining UTM zone
        """
        # Get center point
        lats = [c[1] for c in coords]
        lons = [c[0] for c in coords]
        center_lat = sum(lats) / len(lats)
        center_lon = sum(lons) / len(lons)

        # Determine UTM zone
        utm_zone = int((center_lon + 180) / 6) + 1
        hemisphere = "north" if center_lat >= 0 else "south"

        # Create projections
        self.utm_proj = pyproj.CRS(
            f"+proj=utm +zone={utm_zone} +{hemisphere} +ellps=WGS84"
        )
        self.project_to_utm = pyproj.Transformer.from_crs(
            pyproj.CRS("EPSG:4326"), self.utm_proj, always_xy=True
        ).transform
        self.project_to_wgs84 = pyproj.Transformer.from_crs(
            self.utm_proj, pyproj.CRS("EPSG:4326"), always_xy=True
        ).transform

    async def _map_match_coordinates(
        self,
        coordinates: List[List[float]],
        chunk_size: int = 100,
        overlap: int = 10,
        max_retries: int = 3,
        min_sub_chunk: int = 20,
        jump_threshold_m: float = 200.0,
    ) -> Dict[str, Any]:
        """
        Map match coordinates using the Mapbox API with advanced chunking and stitching.

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

        # Initialize projections if needed
        if not self.utm_proj:
            self._initialize_projections(coordinates)

        # Create a session with proper configuration
        timeout = aiohttp.ClientTimeout(
            total=30, connect=10, sock_connect=10, sock_read=20
        )
        async with aiohttp.ClientSession(timeout=timeout) as session:

            async def call_mapbox_api(
                coords: List[List[float]], attempt: int = 1
            ) -> Dict[str, Any]:
                base_url = "https://api.mapbox.com/matching/v5/mapbox/driving/"
                coords_str = ";".join(f"{lon},{lat}" for lon, lat in coords)
                url = base_url + coords_str
                params = {
                    "access_token": self.mapbox_token,
                    "geometries": "geojson",
                    "radiuses": ";".join("25" for _ in coords),
                }

                max_attempts_for_429 = 5
                min_backoff_seconds = 2

                async with self.map_match_semaphore:
                    for retry_attempt in range(1, max_attempts_for_429 + 1):
                        # Check rate limiting before making request
                        should_wait, wait_time = await self._check_rate_limit()
                        if should_wait:
                            logger.info(
                                "Rate limit approaching - waiting %.2f seconds before API call", wait_time, )
                            await asyncio.sleep(wait_time)

                        try:
                            async with session.get(url, params=params) as response:
                                if response.status == 429:
                                    logger.warning(
                                        "Received 429 Too Many Requests. Attempt=%d", retry_attempt, )
                                    retry_after = response.headers.get(
                                        "Retry-After")
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
                                    else:
                                        logger.error(
                                            "Gave up after %d attempts for 429 errors.", retry_attempt, )
                                        raise aiohttp.ClientResponseError(
                                            response.request_info,
                                            response.history,
                                            status=429,
                                            message="Too Many Requests (exceeded max attempts)",
                                        )

                                # Check for other error responses
                                if 400 <= response.status < 500:
                                    error_text = await response.text()
                                    logger.warning(
                                        "Mapbox API client error: %d - %s",
                                        response.status,
                                        error_text,
                                    )
                                    return {
                                        "code": "Error",
                                        "message": f"Mapbox API error: {
                                            response.status}",
                                        "details": error_text,
                                    }

                                # Handle server errors with retries
                                if response.status >= 500:
                                    if retry_attempt < max_attempts_for_429:
                                        wait_time = min_backoff_seconds * (
                                            2 ** (retry_attempt - 1)
                                        )
                                        logger.warning(
                                            "Mapbox server error %d, retrying in %f seconds", response.status, wait_time, )
                                        await asyncio.sleep(wait_time)
                                        continue
                                    else:
                                        error_text = await response.text()
                                        return {
                                            "code": "Error",
                                            "message": f"Mapbox server error: {
                                                response.status}",
                                            "details": error_text,
                                        }

                                response.raise_for_status()
                                data = await response.json()
                                return data

                        except Exception as e:
                            # Handle various exceptions with retries
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
                            else:
                                logger.error(
                                    "Failed after %d retries: %s",
                                    max_attempts_for_429,
                                    str(e),
                                )
                                return {
                                    "code": "Error",
                                    "message": f"Mapbox API error after {max_attempts_for_429} retries: {
                                        str(e)}",
                                }

                    # This should only be reached if all retry attempts failed
                    # but no exception was raised
                    return {"code": "Error",
                            "message": "All retry attempts failed"}

            async def match_chunk(
                chunk_coords: List[List[float]], depth: int = 0
            ) -> Optional[List[List[float]]]:
                if len(chunk_coords) < 2:
                    return []
                if len(chunk_coords) > 100:
                    logger.error(
                        "match_chunk received >100 coords unexpectedly.")
                    return []
                try:
                    data = await call_mapbox_api(chunk_coords)
                    if data.get("code") == "Ok" and data.get("matchings"):
                        return data["matchings"][0]["geometry"]["coordinates"]

                    # Handle different types of errors
                    msg = data.get("message", "Mapbox API error (code != Ok)")
                    logger.warning("Mapbox chunk error: %s", msg)

                    # Special handling for invalid input
                    if "invalid coordinates" in msg.lower():
                        # Try to clean up coordinates
                        filtered_coords = filter_invalid_coordinates(
                            chunk_coords)
                        if len(filtered_coords) >= 2 and len(
                                filtered_coords) < len(chunk_coords):
                            logger.info(
                                "Retrying with %d filtered coordinates",
                                len(filtered_coords),
                            )
                            return await match_chunk(filtered_coords, depth)

                except Exception as exc:
                    logger.warning(
                        "Unexpected error in mapbox chunk: %s", str(exc))

                # Fallback to splitting if needed and allowed
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
                coords: List[List[float]],
            ) -> List[List[float]]:
                """Filter out potentially invalid coordinates."""
                valid_coords = []
                for coord in coords:
                    # Check for basic validity
                    if (
                        len(coord) >= 2
                        and isinstance(coord[0], (int, float))
                        and isinstance(coord[1], (int, float))
                        and -180 <= coord[0] <= 180
                        and -90 <= coord[1] <= 90
                    ):
                        valid_coords.append(coord)

                return valid_coords

            # Split into chunks for processing
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

            # Process chunks
            final_matched: List[List[float]] = []
            for cindex, (start_i, end_i) in enumerate(chunk_indices, 1):
                chunk_coords = coordinates[start_i:end_i]
                logger.debug(
                    "Matching chunk %d/%d with %d coords",
                    cindex,
                    len(chunk_indices),
                    len(chunk_coords),
                )
                result = await match_chunk(chunk_coords, depth=0)
                if result is None:
                    msg = f"Chunk {cindex} of {
                        len(chunk_indices)} failed map matching."
                    logger.error(msg)
                    return {"code": "Error", "message": msg}
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

            # Detect and fix large jumps in the matched route
            def detect_big_jumps(
                coords: List[List[float]], threshold_m: float = 200
            ) -> List[int]:
                suspicious_indices = []
                for i in range(len(coords) - 1):
                    lon1, lat1 = coords[i]
                    lon2, lat2 = coords[i + 1]
                    distance = haversine(lon1, lat1, lon2, lat2, unit="meters")
                    if distance > threshold_m:
                        suspicious_indices.append(i)
                return suspicious_indices

            max_jump_passes = 2
            pass_count = 0
            while pass_count < max_jump_passes:
                big_jumps = detect_big_jumps(final_matched, jump_threshold_m)
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
                            "Local re-match for sub-segment around index %d failed, leaving as is", i, )
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
                    {"geometry": {"type": "LineString", "coordinates": final_matched}}
                ],
            }

    async def save(
            self,
            map_match_result: Optional[bool] = None) -> Optional[str]:
        """
        Save the processed trip to the appropriate collection.

        Args:
            map_match_result: Optional override for whether to save map matching results

        Returns:
            ObjectId of the saved document if successful, None otherwise
        """
        try:
            # Skip if not processed
            if (
                self.state != TripState.COMPLETED
                and self.state != TripState.MAP_MATCHED
                and self.state != TripState.GEOCODED
                and self.state != TripState.PROCESSED
                and self.state != TripState.VALIDATED
            ):
                logger.warning(
                    f"Cannot save trip {
                        self.trip_data.get(
                            'transactionId',
                            'unknown')} that hasn't been processed"
                )
                return None

            # Ensure proper serialization
            trip_to_save = self.processed_data.copy()

            # For GPS data, ensure it's stored as a string
            if isinstance(trip_to_save.get("gps"), dict):
                trip_to_save["gps"] = json.dumps(trip_to_save["gps"])

            # Add source metadata
            trip_to_save["source"] = self.source
            trip_to_save["saved_at"] = datetime.now(timezone.utc)
            trip_to_save["processing_history"] = self.state_history

            # Remove _id field if present (for upsert)
            if "_id" in trip_to_save:
                del trip_to_save["_id"]

            # Determine which collection to use
            collection = trips_collection
            if self.source == "upload":
                collection = uploaded_trips_collection

            # Save the trip
            transaction_id = trip_to_save.get("transactionId")

            # Upsert the trip
            result = await db_manager.execute_with_retry(
                lambda: collection.update_one(
                    {"transactionId": transaction_id},
                    {"$set": trip_to_save},
                    upsert=True,
                ),
                operation_name=f"save_trip_{transaction_id}",
            )

            # If map matched and we have matched data, also save to
            # matched_trips collection
            if (
                map_match_result or self.state == TripState.MAP_MATCHED
            ) and "matchedGps" in trip_to_save:
                matched_trip = trip_to_save.copy()

                # Try to insert, ignoring duplicate key errors
                try:
                    await db_manager.execute_with_retry(
                        lambda: matched_trips_collection.update_one(
                            {"transactionId": transaction_id},
                            {"$set": matched_trip},
                            upsert=True,
                        ),
                        operation_name=f"save_matched_trip_{transaction_id}",
                    )
                except DuplicateKeyError:
                    logger.info(
                        f"Matched trip {transaction_id} already exists")

            logger.info(f"Saved trip {transaction_id} successfully")

            # Find the saved document to get the _id
            saved_doc = await db_manager.execute_with_retry(
                lambda: collection.find_one({"transactionId": transaction_id}),
                operation_name=f"find_saved_trip_{transaction_id}",
            )

            return str(saved_doc["_id"]) if saved_doc else None

        except Exception as e:
            logger.error(f"Error saving trip: {str(e)}")
            return None

    # Utility methods moved from trip_processing.py
    def format_idle_time(self, seconds: Any) -> str:
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

    @classmethod
    async def process_from_coordinates(
        cls,
        coords_data: List[Dict[str, Any]],
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        transaction_id: Optional[str] = None,
        imei: str = "UPLOADED",
        source: str = "upload",
        mapbox_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Create and process a trip from raw coordinates data.

        Args:
            coords_data: List of coordinate data (with timestamp, lat, lon)
            start_time: Optional start time, will use first timestamp if not provided
            end_time: Optional end time, will use last timestamp if not provided
            transaction_id: Optional transaction ID, will generate one if not provided
            imei: Device identifier
            source: Source of the trip data
            mapbox_token: Mapbox token for map matching

        Returns:
            Processed trip data
        """
        from datetime import datetime, timezone
        import uuid
        import json

        # Sort coordinates by timestamp
        if len(coords_data) > 0 and "timestamp" in coords_data[0]:
            coords_data.sort(key=lambda x: x["timestamp"])

        # Extract timestamps if not provided
        if not start_time and len(coords_data) > 0:
            start_time = coords_data[0].get(
                "timestamp", datetime.now(timezone.utc))
        if not end_time and len(coords_data) > 0:
            end_time = coords_data[-1].get("timestamp",
                                           datetime.now(timezone.utc))

        # Generate transaction ID if not provided
        if not transaction_id:
            transaction_id = f"{source}-{uuid.uuid4()}"

        # Create coordinates for GeoJSON
        coordinates = [[c["lon"], c["lat"]] for c in coords_data]

        # Calculate distance
        total_distance = 0.0
        for i in range(1, len(coordinates)):
            prev = coordinates[i - 1]
            curr = coordinates[i]
            total_distance += haversine(
                prev[0], prev[1], curr[0], curr[1], unit="miles"
            )

        # Create trip data
        trip_data = {
            "transactionId": transaction_id,
            "startTime": start_time,
            "endTime": end_time,
            "gps": json.dumps({"type": "LineString", "coordinates": coordinates}),
            "distance": total_distance,
            "imei": imei,
            "source": source,
        }

        # Create processor and process trip
        processor = cls(mapbox_token=mapbox_token, source=source)
        processor.set_trip_data(trip_data)
        # Skip map matching by default
        await processor.process(do_map_match=False)

        return processor.processed_data

    @classmethod
    async def process_trip_by_id(
        cls,
        trip_id: str,
        do_map_match: bool = False,
        mapbox_token: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """
        Process an existing trip by its ID.

        Args:
            trip_id: Trip ID to process
            do_map_match: Whether to perform map matching
            mapbox_token: Mapbox token for map matching

        Returns:
            Processed trip data if successful, None otherwise
        """
        from db import get_trip_from_all_collections

        # Find the trip in all collections
        trip, collection = await get_trip_from_all_collections(trip_id)

        if not trip:
            logger.warning(f"Trip not found: {trip_id}")
            return None

        # Determine source based on collection
        source = "api"
        if collection.name == "uploaded_trips":
            source = "upload"

        # Create processor and process trip
        processor = cls(mapbox_token=mapbox_token, source=source)
        processor.set_trip_data(trip)
        await processor.process(do_map_match=do_map_match)
        await processor.save(map_match_result=do_map_match)

        return processor.processed_data
