"""
Trip Geocoding Module.

Handles geocoding of trip start and end points using external services
and custom places.
"""

import logging
from typing import Any

from shapely.geometry import Point

from db import Place
from external_geo_service import GeocodingService, get_empty_location_schema
from trip_processor.state import TripState, TripStateMachine

logger = logging.getLogger(__name__)


class TripGeocoder:
    """
    Handles geocoding for trip start and end points.

    Uses custom places database and falls back to external geocoding
    services.
    """

    def __init__(self, geocoding_service: GeocodingService) -> None:
        """
        Initialize the geocoder.

        Args:
            geocoding_service: Geocoding service instance
        """
        self.geocoding_service = geocoding_service

    async def geocode(
        self,
        processed_data: dict[str, Any],
        state_machine: TripStateMachine,
    ) -> tuple[bool, dict[str, Any]]:
        """
        Perform geocoding for trip start and end points.

        Args:
            processed_data: The trip data being processed
            state_machine: State machine to update on success/failure

        Returns:
            Tuple of (success, updated_data)
        """
        try:
            transaction_id = processed_data.get("transactionId", "unknown")
            logger.debug("Geocoding trip %s", transaction_id)

            # Clear any previous location data for fresh geocoding
            for field in (
                "startLocation",
                "destination",
                "startPlaceId",
                "destinationPlaceId",
            ):
                processed_data.pop(field, None)

            # Extract start and end coordinates from gps field
            gps_data = processed_data.get("gps")
            if not gps_data or "coordinates" not in gps_data:
                state_machine.set_state(
                    TripState.FAILED,
                    "Missing GPS data for geocoding",
                )
                return False, processed_data

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
                state_machine.set_state(
                    TripState.FAILED,
                    f"Invalid GPS type or coordinates for geocoding: {gps_type}",
                )
                return False, processed_data

            start_pt = Point(start_coord[0], start_coord[1])
            end_pt = Point(end_coord[0], end_coord[1])

            # Geocode start location
            if not processed_data.get("startLocation"):
                start_place = await self.get_place_at_point(start_pt)
                if start_place:
                    processed_data["startLocation"] = self._build_location_from_place(
                        start_place.model_dump(),
                        start_coord,
                        transaction_id,
                    )
                    processed_data["startPlaceId"] = str(start_place.id)
                else:
                    # Use external geocoding service
                    rev_start = await self.geocoding_service.reverse_geocode(
                        start_coord[1],
                        start_coord[0],
                    )
                    if rev_start:
                        processed_data["startLocation"] = (
                            self.geocoding_service.parse_geocode_response(
                                rev_start,
                                start_coord,
                            )
                        )

            # Geocode destination
            if not processed_data.get("destination"):
                end_place = await self.get_place_at_point(end_pt)
                if end_place:
                    processed_data["destination"] = self._build_location_from_place(
                        end_place.model_dump(),
                        end_coord,
                        transaction_id,
                    )
                    processed_data["destinationPlaceId"] = str(end_place.id)
                else:
                    rev_end = await self.geocoding_service.reverse_geocode(
                        end_coord[1],
                        end_coord[0],
                    )
                    if rev_end:
                        processed_data["destination"] = (
                            self.geocoding_service.parse_geocode_response(
                                rev_end,
                                end_coord,
                            )
                        )
                    else:
                        logger.warning(
                            "Trip %s: Failed to geocode destination",
                            transaction_id,
                        )

            from date_utils import get_current_utc_time

            processed_data["location_schema_version"] = 2
            processed_data["geocoded_at"] = get_current_utc_time()

            state_machine.set_state(TripState.GEOCODED)
            logger.debug("Geocoded trip %s", transaction_id)
            return True, processed_data

        except Exception as e:
            error_message = f"Geocoding error: {e!s}"
            logger.exception(
                "Error geocoding trip %s",
                processed_data.get("transactionId", "unknown"),
            )
            state_machine.set_state(TripState.FAILED, error_message)
            return False, processed_data

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
        structured = get_empty_location_schema()
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
