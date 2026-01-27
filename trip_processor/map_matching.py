"""
Trip Map Matching Module.

Handles map matching of trip GPS coordinates to road networks.
"""

import logging
from typing import Any

from core.date_utils import get_current_utc_time
from geo_service import MapMatchingService, extract_timestamps_for_coordinates
from trip_processor.state import TripState, TripStateMachine

logger = logging.getLogger(__name__)


class TripMapMatcher:
    """
    Handles map matching for trip GPS coordinates.

    Uses the local map matching service to snap GPS coordinates to road
    networks.
    """

    def __init__(self, map_matching_service: MapMatchingService) -> None:
        """
        Initialize the map matcher.

        Args:
            map_matching_service: Map matching service instance
        """
        self.map_matching_service = map_matching_service

    async def map_match(
        self,
        processed_data: dict[str, Any],
        state_machine: TripStateMachine,
    ) -> tuple[bool, dict[str, Any]]:
        """
        Perform map matching for the trip.

        Args:
            processed_data: The trip data being processed
            state_machine: State machine to update on success/failure

        Returns:
            Tuple of (success, updated_data)
        """
        try:
            transaction_id = processed_data.get("transactionId", "unknown")
            logger.debug("Starting map matching for trip %s", transaction_id)

            def set_match_status(value: str) -> None:
                processed_data["matchStatus"] = value

            gps_data = processed_data.get("gps")
            if not gps_data or not isinstance(gps_data, dict):
                # No GPS data - just continue without map matching
                logger.debug(
                    "Trip %s has no GPS data for map matching",
                    transaction_id,
                )
                set_match_status("skipped:no-gps")
                return True, processed_data

            gps_type = gps_data.get("type")

            if gps_type == "Point":
                logger.info(
                    "Trip %s: GPS is a single Point, skipping map matching",
                    transaction_id,
                )
                set_match_status("skipped:single-point")
                return True, processed_data

            if gps_type == "LineString":
                coords = gps_data.get("coordinates", [])
                if len(coords) < 2:
                    logger.warning(
                        "Trip %s: Insufficient coordinates for map matching",
                        transaction_id,
                    )
                    set_match_status("skipped:insufficient-coordinates")
                    return True, processed_data
            else:
                logger.warning(
                    "Trip %s: Unexpected GPS type '%s'",
                    transaction_id,
                    gps_type,
                )
                set_match_status(f"skipped:unsupported-gps-type:{gps_type}")
                return True, processed_data

            # Extract timestamps and call map matching service
            timestamps = extract_timestamps_for_coordinates(
                coords,
                processed_data,
            )
            match_result = await self.map_matching_service.map_match_coordinates(
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
                state_machine.errors["map_match"] = (
                    f"Map matching API failed: {error_msg}"
                )
                set_match_status(f"error:{error_msg}")
                return (
                    True,
                    processed_data,
                )  # Not a processing failure, just couldn't match

            # Validate and store matched geometry
            validated_matched_gps = self._validate_matched_geometry(
                match_result,
                transaction_id,
            )

            if validated_matched_gps:
                processed_data["matchedGps"] = validated_matched_gps
                processed_data["matched_at"] = get_current_utc_time()
                geom_type = validated_matched_gps.get("type", "unknown")
                set_match_status(f"matched:{str(geom_type).lower()}")
                state_machine.set_state(TripState.MAP_MATCHED)
                logger.debug("Map matched trip %s successfully", transaction_id)
            else:
                logger.info("No valid matchedGps data for trip %s", transaction_id)
                set_match_status("no-valid-geometry")

            result = (True, processed_data)

        except Exception as e:
            # Map matching errors should not fail the trip - just log and continue
            logger.warning(
                "Map matching error for trip %s (continuing): %s",
                processed_data.get("transactionId", "unknown"),
                e,
            )
            processed_data["matchStatus"] = "error:exception"
            return True, processed_data
        else:
            return result

    def _validate_matched_geometry(
        self,
        match_result: dict[str, Any],
        transaction_id: str,
    ) -> dict[str, Any] | None:
        """
        Validate and extract matched geometry from map matching result.

        Args:
            match_result: Result from map matching API
            transaction_id: Trip transaction ID for logging

        Returns:
            Validated GeoJSON geometry or None
        """
        if not match_result.get("matchings") or not match_result["matchings"][0].get(
            "geometry",
        ):
            return None

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
                    return {
                        "type": "Point",
                        "coordinates": geom_coords[0],
                    }
                return matched_geometry
        elif (
            geom_type == "Point"
            and isinstance(geom_coords, list)
            and len(geom_coords) == 2
        ):
            return matched_geometry

        return None
