"""
Trip Basic Processing Module.

Handles basic processing of trip data including GPS parsing and distance calculation.
"""

import logging
from typing import Any

from geometry_service import GeometryService
from trip_processor.state import TripState, TripStateMachine

logger = logging.getLogger(__name__)


class TripBasicProcessor:
    """
    Handles basic processing of trip data.

    Performs GPS coordinate validation, distance calculation, and data enrichment.
    """

    async def process(
        self,
        processed_data: dict[str, Any],
        state_machine: TripStateMachine,
    ) -> tuple[bool, dict[str, Any]]:
        """
        Perform basic processing on trip data.

        Args:
            processed_data: The trip data being processed
            state_machine: State machine to update on success/failure

        Returns:
            Tuple of (success, updated_data)
        """
        try:
            transaction_id = processed_data.get("transactionId", "unknown")
            logger.debug("Processing basic data for trip %s", transaction_id)

            gps_data = processed_data.get("gps")
            if not gps_data:
                state_machine.set_state(
                    TripState.FAILED,
                    "Missing GPS data for basic processing",
                )
                return False, processed_data

            gps_type = gps_data.get("type")
            gps_coords = gps_data.get("coordinates")

            if gps_type == "Point":
                if not self._validate_point_coordinates(gps_coords):
                    state_machine.set_state(
                        TripState.FAILED,
                        "Point GeoJSON has invalid coordinates",
                    )
                    return False, processed_data
                start_coord = gps_coords
                end_coord = gps_coords
                processed_data["distance"] = 0.0
            elif gps_type == "LineString":
                if not self._validate_linestring_coordinates(gps_coords):
                    state_machine.set_state(
                        TripState.FAILED,
                        "LineString has insufficient coordinates",
                    )
                    return False, processed_data
                start_coord = gps_coords[0]
                end_coord = gps_coords[-1]

                # Calculate distance if not provided
                if "distance" not in processed_data or not processed_data["distance"]:
                    processed_data["distance"] = self._calculate_distance(gps_coords)
            else:
                state_machine.set_state(
                    TripState.FAILED,
                    f"Unsupported GPS type '{gps_type}'",
                )
                return False, processed_data

            # Validate coordinates
            if not self._validate_coordinate_pair(start_coord, end_coord):
                state_machine.set_state(
                    TripState.FAILED,
                    "Invalid start or end coordinates",
                )
                return False, processed_data

            if (
                "totalIdleDuration" not in processed_data
                and "totalIdlingTime" in processed_data
            ):
                processed_data["totalIdleDuration"] = processed_data[
                    "totalIdlingTime"
                ]

            # Format idle time if present
            if "totalIdleDuration" in processed_data:
                processed_data["totalIdleDurationFormatted"] = format_idle_time(
                    processed_data["totalIdleDuration"],
                )

            state_machine.set_state(TripState.PROCESSED)
            logger.debug("Completed basic processing for trip %s", transaction_id)
            return True, processed_data

        except Exception as e:
            error_message = f"Processing error: {e!s}"
            logger.exception(
                "Error in basic processing for trip %s",
                processed_data.get("transactionId", "unknown"),
            )
            state_machine.set_state(TripState.FAILED, error_message)
            return False, processed_data

    @staticmethod
    def _validate_point_coordinates(gps_coords: Any) -> bool:
        """Validate Point GeoJSON coordinates."""
        return gps_coords and isinstance(gps_coords, list) and len(gps_coords) == 2

    @staticmethod
    def _validate_linestring_coordinates(gps_coords: Any) -> bool:
        """Validate LineString GeoJSON coordinates."""
        return gps_coords and isinstance(gps_coords, list) and len(gps_coords) >= 2

    @staticmethod
    def _validate_coordinate_pair(
        start_coord: Any,
        end_coord: Any,
    ) -> bool:
        """Validate that start and end coordinates are valid."""
        return (
            isinstance(start_coord, list)
            and len(start_coord) == 2
            and isinstance(end_coord, list)
            and len(end_coord) == 2
        )

    @staticmethod
    def _calculate_distance(gps_coords: list[list[float]]) -> float:
        """
        Calculate total distance from GPS coordinates.

        Args:
            gps_coords: List of [lon, lat] coordinate pairs

        Returns:
            Total distance in miles
        """
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
        return total_distance


def format_idle_time(seconds: Any) -> str:
    """
    Convert idle time in seconds to a HH:MM:SS string.

    Args:
        seconds: Idle time in seconds

    Returns:
        Formatted time string
    """
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
