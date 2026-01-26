"""
Trip Geocoding Module.

Handles geocoding of trip start and end points using external services
and custom places.
"""

import logging
from typing import Any, cast

from shapely.geometry import Point

from db import Place
from geo_service import GeocodingService, get_empty_location_schema
from map_data.models import GeoServiceHealth
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

            # Extract start and end coordinates from gps field
            gps_data = processed_data.get("gps")
            if not gps_data or "coordinates" not in gps_data:
                # No GPS data - just mark as geocoded and continue
                logger.debug("Trip %s has no GPS data for geocoding", transaction_id)
                state_machine.set_state(TripState.GEOCODED)
                return True, processed_data

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
                # Invalid GPS type - just mark as geocoded and continue
                logger.debug(
                    "Trip %s has invalid GPS type for geocoding: %s",
                    transaction_id,
                    gps_type,
                )
                state_machine.set_state(TripState.GEOCODED)
                return True, processed_data

            start_pt = Point(start_coord[0], start_coord[1])
            end_pt = Point(end_coord[0], end_coord[1])

            # Check if Nominatim service is healthy before attempting external geocoding
            health = await GeoServiceHealth.get_or_create()
            nominatim_available = health.nominatim_healthy

            # Geocode start location
            if not processed_data.get("startLocation"):
                start_place = await self.get_place_at_point(start_pt)
                if start_place:
                    place_obj = cast("Any", start_place)
                    start_place_data = (
                        place_obj.model_dump()
                        if hasattr(place_obj, "model_dump")
                        else dict(place_obj)
                    )
                    processed_data["startLocation"] = self._build_location_from_place(
                        start_place_data,
                        start_coord,
                        transaction_id,
                    )
                    processed_data["startPlaceId"] = str(getattr(place_obj, "id", ""))
                else:
                    # Use external geocoding service
                    rev_start = None
                    if nominatim_available:
                        rev_start = await self.geocoding_service.reverse_geocode(
                            start_coord[1],
                            start_coord[0],
                        )
                    else:
                        logger.warning(
                            "Trip %s: Nominatim unavailable, skipping start geocode",
                            transaction_id,
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
                    place_obj = cast("Any", end_place)
                    end_place_data = (
                        place_obj.model_dump()
                        if hasattr(place_obj, "model_dump")
                        else dict(place_obj)
                    )
                    processed_data["destination"] = self._build_location_from_place(
                        end_place_data,
                        end_coord,
                        transaction_id,
                    )
                    processed_data["destinationPlaceId"] = str(
                        getattr(place_obj, "id", ""),
                    )
                else:
                    rev_end = None
                    if nominatim_available:
                        rev_end = await self.geocoding_service.reverse_geocode(
                            end_coord[1],
                            end_coord[0],
                        )
                    else:
                        logger.warning(
                            "Trip %s: Nominatim unavailable, skipping destination geocode",
                            transaction_id,
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

            from core.date_utils import get_current_utc_time

            processed_data["location_schema_version"] = 2
            processed_data["geocoded_at"] = get_current_utc_time()

            state_machine.set_state(TripState.GEOCODED)
            logger.debug("Geocoded trip %s", transaction_id)
            result = (True, processed_data)

        except Exception as e:
            # Geocoding errors should not fail the trip - just log and continue
            logger.warning(
                "Geocoding error for trip %s (continuing): %s",
                processed_data.get("transactionId", "unknown"),
                e,
            )
            state_machine.set_state(TripState.GEOCODED)
            return True, processed_data
        else:
            return result

    @staticmethod
    async def get_place_at_point(point: Point) -> Place | None:
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
        except Exception:
            logger.exception("Error finding place at point")
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
