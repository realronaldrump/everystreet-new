"""Trip Repository Module.

This module provides the TripRepository class that handles all database
persistence operations for trips, following the Single Responsibility Principle.
"""

import json
import logging
from typing import Any

from date_utils import get_current_utc_time
from db.models import Trip

logger = logging.getLogger(__name__)


class TripRepository:
    """Repository for trip database operations.

    Handles all database persistence operations including saving trips
    to the trips collection and matched trips collection.
    """

    def __init__(
        self,
        trips_col=None,
    ):
        """Initialize the repository with optional custom collections.

        Args:
            trips_col: Optional custom trips collection (for testing)
        """
        # Retrieve collection from Beanie model if not provided
        self.trips_collection = trips_col or Trip.get_motor_collection()

    async def save_trip(
        self,
        trip_data: dict[str, Any],
        source: str,
        state_history: list[dict[str, Any]],
    ) -> str | None:
        """Save a trip to the trips collection.

        Args:
            trip_data: The processed trip data dictionary
            source: Source of the trip data (api, upload, bouncie, etc.)
            state_history: Processing state history

        Returns:
            ObjectId of the saved document if successful, None otherwise
        """
        try:
            trip_to_save = trip_data.copy()

            # Final safeguard: convert stringified GPS to object
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
                        "Failed to parse stringified GPS data for trip %s. Setting GPS to null.",
                        trip_to_save.get("transactionId", "unknown"),
                    )
                    trip_to_save["gps"] = None

            # Final validation check after any potential parsing
            if trip_to_save.get(
                "gps"
            ) is not None and not self._is_valid_geojson_object(trip_to_save["gps"]):
                logger.error(
                    "Trip %s: 'gps' field is invalid at save time. Value: %s. Setting to null.",
                    trip_to_save.get("transactionId", "unknown"),
                    trip_to_save["gps"],
                )
                trip_to_save["gps"] = None

            trip_to_save["source"] = source
            trip_to_save["saved_at"] = get_current_utc_time()
            trip_to_save["processing_history"] = state_history

            # Extract start and destination GeoPoints from GPS data for spatial indexing
            gps_data = trip_to_save.get("gps")
            if gps_data and isinstance(gps_data, dict):
                gps_type = gps_data.get("type")
                coords = gps_data.get("coordinates")

                if gps_type == "Point" and coords and len(coords) >= 2:
                    # For Point, start and destination are the same
                    geo_point = {"type": "Point", "coordinates": [coords[0], coords[1]]}
                    trip_to_save["startGeoPoint"] = geo_point
                    trip_to_save["destinationGeoPoint"] = geo_point
                elif (
                    gps_type == "LineString"
                    and coords
                    and isinstance(coords, list)
                    and len(coords) >= 2
                ):
                    # For LineString, first point is start, last point is destination
                    start_coords = coords[0]
                    end_coords = coords[-1]
                    if (
                        isinstance(start_coords, list)
                        and len(start_coords) >= 2
                        and isinstance(end_coords, list)
                        and len(end_coords) >= 2
                    ):
                        trip_to_save["startGeoPoint"] = {
                            "type": "Point",
                            "coordinates": [start_coords[0], start_coords[1]],
                        }
                        trip_to_save["destinationGeoPoint"] = {
                            "type": "Point",
                            "coordinates": [end_coords[0], end_coords[1]],
                        }

            if "_id" in trip_to_save:
                del trip_to_save["_id"]

            transaction_id = trip_to_save.get("transactionId")

            await self.trips_collection.update_one(
                {"transactionId": transaction_id},
                {"$set": trip_to_save},
                upsert=True,
            )

            logger.debug(
                "Saved trip %s to %s successfully",
                transaction_id,
                self.trips_collection.name,
            )

            saved_doc = await self.trips_collection.find_one(
                {"transactionId": transaction_id},
            )

            return str(saved_doc["_id"]) if saved_doc else None

        except Exception as e:
            logger.error("Error saving trip: %s", e)
            return None

    @staticmethod
    def _is_valid_geojson_object(geojson_data: Any) -> bool:
        """Checks if the input is a valid GeoJSON Point or LineString.

        Args:
            geojson_data: Data to validate

        Returns:
            True if valid GeoJSON Point or LineString, False otherwise
        """
        if not isinstance(geojson_data, dict):
            return False

        geom_type = geojson_data.get("type")
        coordinates = geojson_data.get("coordinates")

        if geom_type == "Point":
            if not isinstance(coordinates, list) or len(coordinates) != 2:
                return False
            if not all(isinstance(coord, int | float) for coord in coordinates):
                return False
            lon, lat = coordinates
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                logger.debug("Point coordinates out of WGS84 range: %s", [lon, lat])
                return False
            return True

        if geom_type == "LineString":
            if not isinstance(coordinates, list) or len(coordinates) < 2:
                logger.debug(
                    "LineString must have at least 2 coordinate pairs. Found: %d",
                    len(coordinates) if isinstance(coordinates, list) else 0,
                )
                return False
            for point in coordinates:
                if not isinstance(point, list) or len(point) != 2:
                    return False
                if not all(isinstance(coord, int | float) for coord in point):
                    return False
                lon, lat = point
                if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                    logger.debug("LineString point out of WGS84 range: %s", [lon, lat])
                    return False
            return True

        return False
