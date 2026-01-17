"""
Trip Repository Module.

This module provides the TripRepository class that handles all database
persistence operations for trips, following the Single Responsibility
Principle.
"""

import json
import logging
from datetime import datetime
from typing import Any

from date_utils import get_current_utc_time, parse_timestamp
from db.models import Trip

logger = logging.getLogger(__name__)


class TripRepository:
    """
    Repository for trip database operations.

    Handles all database persistence operations including saving trips
    to the trips collection and matched trips collection.
    """

    async def save_trip(
        self,
        trip_data: dict[str, Any],
        source: str,
        state_history: list[dict[str, Any]],
    ) -> str | None:
        """
        Save a trip to the trips collection.

        Args:
            trip_data: The processed trip data dictionary
            source: Source of the trip data (api, bouncie, etc.)
            state_history: Processing state history

        Returns:
            ObjectId of the saved document if successful, None otherwise
        """
        return await self._upsert_trip(
            trip_data,
            source=source,
            state_history=state_history,
            mark_processed=True,
        )

    async def merge_trip(
        self,
        trip_data: dict[str, Any],
        source: str | None = None,
    ) -> str | None:
        """Merge incoming trip data into an existing trip without marking processed."""
        return await self._upsert_trip(
            trip_data,
            source=source,
            state_history=None,
            mark_processed=False,
        )

    async def _upsert_trip(
        self,
        trip_data: dict[str, Any],
        source: str | None,
        state_history: list[dict[str, Any]] | None,
        mark_processed: bool,
    ) -> str | None:
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
                    logger.exception(
                        "Failed to parse stringified GPS data for trip %s. Setting GPS to null.",
                        trip_to_save.get("transactionId", "unknown"),
                    )
                    trip_to_save["gps"] = None

            # Final validation check after any potential parsing
            if trip_to_save.get(
                "gps",
            ) is not None and not self._is_valid_geojson_object(trip_to_save["gps"]):
                logger.error(
                    "Trip %s: 'gps' field is invalid at save time. Value: %s. Setting to null.",
                    trip_to_save.get("transactionId", "unknown"),
                    trip_to_save["gps"],
                )
                trip_to_save["gps"] = None

            if source:
                trip_to_save["source"] = source
            trip_to_save["saved_at"] = get_current_utc_time()

            processing_state = None
            if state_history:
                trip_to_save["processing_history"] = state_history
                processing_state = self._extract_processing_state(state_history)
                if processing_state:
                    trip_to_save["processing_state"] = processing_state

            if mark_processed:
                trip_to_save["status"] = "processed"

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

            # Use Beanie to find and update or create
            trip = await Trip.find_one(Trip.transactionId == transaction_id)
            if trip:
                self._merge_trip_fields(
                    trip,
                    trip_to_save,
                    mark_processed=mark_processed,
                    processing_state=processing_state,
                )
                await trip.save()
            else:
                trip = Trip(**trip_to_save)
                await trip.insert()

            logger.debug(
                "Saved trip %s successfully",
                transaction_id,
            )

            await self._emit_coverage_if_needed(trip)
            return str(trip.id)

        except Exception:
            logger.exception("Error saving trip")
            return None

    @staticmethod
    def _extract_processing_state(
        state_history: list[dict[str, Any]],
    ) -> str | None:
        if not state_history:
            return None
        last_entry = state_history[-1]
        if isinstance(last_entry, dict):
            return last_entry.get("to")
        return None

    @staticmethod
    def _coerce_datetime(value: Any) -> datetime | None:
        if isinstance(value, datetime):
            return value
        if isinstance(value, str):
            return parse_timestamp(value)
        return None

    @classmethod
    def _pick_earliest(cls, existing: Any, incoming: Any) -> datetime | None:
        incoming_dt = cls._coerce_datetime(incoming)
        existing_dt = cls._coerce_datetime(existing)
        if not incoming_dt:
            return existing_dt
        if not existing_dt:
            return incoming_dt
        return min(existing_dt, incoming_dt)

    @classmethod
    def _pick_latest(cls, existing: Any, incoming: Any) -> datetime | None:
        incoming_dt = cls._coerce_datetime(incoming)
        existing_dt = cls._coerce_datetime(existing)
        if not incoming_dt:
            return existing_dt
        if not existing_dt:
            return incoming_dt
        return max(existing_dt, incoming_dt)

    @staticmethod
    def _gps_quality(gps: dict[str, Any] | None) -> tuple[int, int]:
        if not isinstance(gps, dict):
            return (0, 0)
        geom_type = gps.get("type")
        coords = gps.get("coordinates")
        if geom_type == "Point" and isinstance(coords, list) and len(coords) >= 2:
            return (1, 1)
        if geom_type == "LineString" and isinstance(coords, list):
            return (2, len(coords))
        return (0, 0)

    @classmethod
    def _select_best_gps(
        cls,
        existing: dict[str, Any] | None,
        incoming: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if incoming is None:
            return existing
        if existing is None:
            return incoming
        if cls._gps_quality(incoming) > cls._gps_quality(existing):
            return incoming
        return existing

    @classmethod
    def _merge_coordinates(
        cls,
        existing: list[dict[str, Any]] | None,
        incoming: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]] | None:
        if not incoming:
            return existing
        coords_map: dict[str, dict[str, Any]] = {}
        for coord in (existing or []) + incoming:
            if isinstance(coord, dict) and "timestamp" in coord:
                ts = coord.get("timestamp")
                if isinstance(ts, str):
                    parsed = parse_timestamp(ts)
                    if parsed:
                        coord["timestamp"] = parsed
                        ts = parsed
                key = ts.isoformat() if isinstance(ts, datetime) else str(ts)
                coords_map[key] = coord

        if not coords_map:
            return existing
        return sorted(
            coords_map.values(),
            key=lambda c: (
                c["timestamp"].isoformat()
                if isinstance(c.get("timestamp"), datetime)
                else str(c.get("timestamp"))
            ),
        )

    def _merge_trip_fields(
        self,
        trip: Trip,
        incoming: dict[str, Any],
        *,
        mark_processed: bool,
        processing_state: str | None,
    ) -> None:
        existing = trip.model_dump()

        if "coordinates" in incoming:
            merged_coords = self._merge_coordinates(
                existing.get("coordinates"),
                incoming.get("coordinates"),
            )
            if merged_coords is not None:
                trip.coordinates = merged_coords

        gps_changed = False
        if "gps" in incoming:
            best_gps = self._select_best_gps(existing.get("gps"), incoming.get("gps"))
            if best_gps is not None:
                gps_changed = best_gps != existing.get("gps")
                trip.gps = best_gps

        start_time = self._pick_earliest(
            existing.get("startTime"),
            incoming.get("startTime"),
        )
        if start_time:
            trip.startTime = start_time

        end_time = self._pick_latest(
            existing.get("endTime"),
            incoming.get("endTime"),
        )
        if end_time:
            trip.endTime = end_time

        last_update = self._pick_latest(
            existing.get("lastUpdate"),
            incoming.get("lastUpdate"),
        )
        if last_update:
            trip.lastUpdate = last_update

        max_fields = {
            "distance",
            "duration",
            "pointsRecorded",
            "maxSpeed",
            "totalIdleDuration",
            "hardBrakingCounts",
            "hardAccelerationCounts",
            "fuelConsumed",
            "endOdometer",
        }
        for key in max_fields:
            if key in incoming and incoming[key] is not None:
                existing_val = existing.get(key)
                if existing_val is None or incoming[key] > existing_val:
                    setattr(trip, key, incoming[key])

        if (
            "startOdometer" in incoming
            and incoming["startOdometer"] is not None
            and existing.get("startOdometer") is None
        ):
            trip.startOdometer = incoming["startOdometer"]

        prefer_incoming = {
            "vin",
            "imei",
            "currentSpeed",
            "avgSpeed",
            "sequence",
            "matchStatus",
            "matchedGps",
            "matched_at",
            "startTimeZone",
            "endTimeZone",
            "closed_reason",
            "validation_status",
            "validation_message",
            "invalid",
            "validated_at",
            "destinationPlaceId",
            "destinationPlaceName",
            "saved_at",
        }
        for key in prefer_incoming:
            if key in incoming and incoming[key] is not None:
                setattr(trip, key, incoming[key])

        if (
            gps_changed
            or not existing.get("startGeoPoint")
            or not existing.get(
                "destinationGeoPoint",
            )
        ):
            start_geo, dest_geo = self._derive_geo_points(getattr(trip, "gps", None))
            if start_geo:
                trip.startGeoPoint = start_geo
            if dest_geo:
                trip.destinationGeoPoint = dest_geo

        incoming_status = incoming.get("status")
        if mark_processed:
            trip.status = "processed"
        elif incoming_status and existing.get("status") != "processed":
            trip.status = incoming_status
        elif existing.get("status") in {None, "active"} and (
            incoming.get("endTime") or incoming.get("gps")
        ):
            trip.status = "completed"

        if processing_state:
            trip.processing_state = processing_state
        if "processing_history" in incoming and incoming.get("processing_history"):
            trip.processing_history = incoming["processing_history"]

        if not existing.get("source") and incoming.get("source"):
            trip.source = incoming.get("source")

        if not existing.get("coverage_emitted_at") and incoming.get(
            "coverage_emitted_at",
        ):
            trip.coverage_emitted_at = incoming.get("coverage_emitted_at")

    async def _emit_coverage_if_needed(self, trip: Trip) -> None:
        should_emit = (
            getattr(trip, "gps", None) is not None
            and getattr(trip, "coverage_emitted_at", None) is None
            and getattr(trip, "status", None) in {"completed", "processed"}
        )
        if not should_emit:
            return

        try:
            from street_coverage.events import emit_trip_completed

            await emit_trip_completed(
                trip_id=str(trip.id),
                trip_data=trip.model_dump(),
            )
            trip.coverage_emitted_at = get_current_utc_time()
            await trip.save()
        except Exception as coverage_err:
            # Coverage update failure should not fail the trip save
            logger.warning(
                "Failed to emit coverage event for trip %s: %s",
                trip.transactionId,
                coverage_err,
            )

    @staticmethod
    def _derive_geo_points(
        gps: dict[str, Any] | None,
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        if not gps or not isinstance(gps, dict):
            return None, None
        gps_type = gps.get("type")
        coords = gps.get("coordinates")

        if gps_type == "Point" and coords and len(coords) >= 2:
            geo_point = {"type": "Point", "coordinates": [coords[0], coords[1]]}
            return geo_point, geo_point
        if (
            gps_type == "LineString"
            and coords
            and isinstance(coords, list)
            and len(coords) >= 2
        ):
            start_coords = coords[0]
            end_coords = coords[-1]
            if (
                isinstance(start_coords, list)
                and len(start_coords) >= 2
                and isinstance(end_coords, list)
                and len(end_coords) >= 2
            ):
                return (
                    {
                        "type": "Point",
                        "coordinates": [start_coords[0], start_coords[1]],
                    },
                    {"type": "Point", "coordinates": [end_coords[0], end_coords[1]]},
                )
        return None, None

    @staticmethod
    def _is_valid_geojson_object(geojson_data: Any) -> bool:
        """
        Checks if the input is a valid GeoJSON Point or LineString.

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
