"""Trip Repository Module.

This module provides the TripRepository class that handles all database
persistence operations for trips, following the Single Responsibility Principle.
"""

import json
import logging
from typing import Any

from pymongo.errors import DuplicateKeyError

from date_utils import get_current_utc_time
from db import matched_trips_collection, trips_collection

logger = logging.getLogger(__name__)


class TripRepository:
    """Repository for trip database operations.

    Handles all database persistence operations including saving trips
    to the trips collection and matched trips collection.
    """

    def __init__(
        self,
        trips_col=None,
        matched_trips_col=None,
    ):
        """Initialize the repository with optional custom collections.

        Args:
            trips_col: Optional custom trips collection (for testing)
            matched_trips_col: Optional custom matched trips collection (for testing)
        """
        self.trips_collection = trips_col or trips_collection
        self.matched_trips_collection = matched_trips_col or matched_trips_collection

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
            if trip_to_save.get("gps") is not None and not self._is_valid_geojson_object(
                trip_to_save["gps"]
            ):
                logger.error(
                    "Trip %s: 'gps' field is invalid at save time. Value: %s. Setting to null.",
                    trip_to_save.get("transactionId", "unknown"),
                    trip_to_save["gps"],
                )
                trip_to_save["gps"] = None

            trip_to_save["source"] = source
            trip_to_save["saved_at"] = get_current_utc_time()
            trip_to_save["processing_history"] = state_history

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

    async def save_matched_trip(
        self,
        transaction_id: str,
        trip_data: dict[str, Any],
    ) -> bool:
        """Save matched GPS data to the matched_trips collection.

        Args:
            transaction_id: The trip transaction ID
            trip_data: The trip data containing matchedGps and other fields

        Returns:
            True if saved successfully, False otherwise
        """
        try:
            matched_gps = trip_data.get("matchedGps")

            if matched_gps is None:
                logger.debug("No matchedGps data for trip %s", transaction_id)
                return False

            if not self._is_valid_geojson_for_matched_collection(matched_gps):
                logger.warning(
                    "Invalid GeoJSON structure in matchedGps for trip %s. Not saving. Value: %s",
                    transaction_id,
                    matched_gps,
                )
                return False

            matched_trip_data = {
                "transactionId": transaction_id,
                "startTime": trip_data.get("startTime"),
                "endTime": trip_data.get("endTime"),
                "matchedGps": matched_gps,
                "source": trip_data.get("source"),
                "matched_at": trip_data.get("matched_at"),
                "distance": trip_data.get("distance"),
                "imei": trip_data.get("imei"),
                "startLocation": trip_data.get("startLocation"),
                "destination": trip_data.get("destination"),
                "maxSpeed": trip_data.get("maxSpeed"),
                "averageSpeed": trip_data.get("averageSpeed"),
                "hardBrakingCount": trip_data.get("hardBrakingCount"),
                "hardAccelerationCount": trip_data.get("hardAccelerationCount"),
                "totalIdleDurationFormatted": trip_data.get("totalIdleDurationFormatted"),
            }

            # Filter out None values
            matched_trip_data = {k: v for k, v in matched_trip_data.items() if v is not None}

            await self.matched_trips_collection.update_one(
                {"transactionId": transaction_id},
                {"$set": matched_trip_data},
                upsert=True,
            )

            logger.debug("Saved matched trip %s successfully", transaction_id)
            return True

        except DuplicateKeyError:
            logger.info(
                "Matched trip %s already exists (concurrent update?)",
                transaction_id,
            )
            return False
        except Exception as e:
            logger.error(
                "Error saving matched trip %s: %s",
                transaction_id,
                e,
            )
            return False

    async def get_trip_by_transaction_id(
        self,
        transaction_id: str,
    ) -> dict[str, Any] | None:
        """Fetch a trip by its transaction ID.

        Args:
            transaction_id: The trip transaction ID

        Returns:
            Trip document if found, None otherwise
        """
        try:
            return await self.trips_collection.find_one(
                {"transactionId": transaction_id}
            )
        except Exception as e:
            logger.error("Error fetching trip %s: %s", transaction_id, e)
            return None

    async def trip_exists(self, transaction_id: str) -> bool:
        """Check if a trip exists by transaction ID.

        Args:
            transaction_id: The trip transaction ID

        Returns:
            True if trip exists, False otherwise
        """
        try:
            doc = await self.trips_collection.find_one(
                {"transactionId": transaction_id},
                projection={"_id": 1},
            )
            return doc is not None
        except Exception as e:
            logger.error("Error checking if trip %s exists: %s", transaction_id, e)
            return False

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

    def _is_valid_geojson_for_matched_collection(self, geojson_data: Any) -> bool:
        """Checks if the GeoJSON is suitable for the matched_trips_collection.

        Args:
            geojson_data: Data to validate

        Returns:
            True if valid for matched collection, False otherwise
        """
        return self._is_valid_geojson_object(geojson_data)
