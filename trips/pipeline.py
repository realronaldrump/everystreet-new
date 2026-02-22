"""Trip lifecycle processing pipeline."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any

from beanie import PydanticObjectId
from pydantic import ValidationError

from analytics.services.mobility_insights_service import MobilityInsightsService
from core.coverage import update_coverage_for_trip
from core.date_utils import get_current_utc_time, parse_timestamp
from core.spatial import GeometryService, derive_geo_points, is_valid_geojson_geometry
from core.trip_source_policy import BOUNCIE_SOURCE
from db.models import Trip
from trips.services.geocoding import TripGeocoder
from trips.services.matching import TripMapMatcher

if TYPE_CHECKING:
    from collections.abc import Callable

logger = logging.getLogger(__name__)

ProcessingHistoryEntry = dict[str, Any]


class TripPipeline:
    """Linear pipeline for trip ingestion and processing."""

    def __init__(
        self,
        geo_service: TripGeocoder | None = None,
        matcher: TripMapMatcher | None = None,
        coverage_service: (
            Callable[[dict[str, Any], PydanticObjectId | str | None], Any] | None
        ) = None,
    ) -> None:
        self.geo_service = geo_service or TripGeocoder()
        self.matcher = matcher or TripMapMatcher()
        self.coverage_service = coverage_service or update_coverage_for_trip

    async def validate_raw_trip(self, raw_data: dict[str, Any]) -> dict[str, Any]:
        """Validate and run basic processing without persistence."""
        success, processed_data, history, state, error = self._validate_only(raw_data)
        return {
            "success": success,
            "processed_data": processed_data,
            "processing_status": {
                "state": state,
                "history": history,
                "errors": {"validation": error} if error else {},
                "transaction_id": (
                    processed_data.get("transactionId", "unknown")
                    if processed_data
                    else raw_data.get("transactionId", "unknown")
                ),
            },
        }

    async def validate_raw_trip_with_basic(
        self,
        raw_data: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Validate a raw trip with basic processing checks, without persistence.

        This matches the same validation+basic processing done by
        process_raw_trip[_insert_only], but does not geocode, map-match,
        or write.
        """
        success, processed_data, history, state, error = self._validate_and_basic(
            raw_data,
        )
        return {
            "success": success,
            "processed_data": processed_data,
            "processing_status": {
                "state": state,
                "history": history,
                "errors": {"validation": error} if error else {},
                "transaction_id": (
                    processed_data.get("transactionId", "unknown")
                    if processed_data
                    else raw_data.get("transactionId", "unknown")
                ),
            },
        }

    async def process_raw_trip(
        self,
        raw_data: dict[str, Any],
        *,
        source: str = "api",
        do_map_match: bool = True,
        do_geocode: bool = True,
        do_coverage: bool = True,
        force_map_match: bool = False,
    ) -> Trip | None:
        """Process a raw trip through validation, matching, geocoding, coverage, and
        save.
        """
        if not raw_data:
            logger.warning("No trip data provided to pipeline")
            return None

        success, processed_data, history, state, error = self._validate_and_basic(
            raw_data,
        )
        if not success:
            logger.warning(
                "Trip %s failed validation: %s",
                raw_data.get("transactionId", "unknown"),
                error,
            )
            return None

        transaction_id = processed_data.get("transactionId")
        if not transaction_id:
            logger.warning("Trip missing transactionId, skipping")
            return None

        existing_trip = await Trip.find_one(Trip.transactionId == transaction_id)

        if existing_trip:
            existing_dict = existing_trip.model_dump()
            if self._has_meaningful_location(existing_dict.get("startLocation")):
                processed_data.setdefault(
                    "startLocation",
                    existing_dict.get("startLocation"),
                )
                processed_data.setdefault(
                    "startPlaceId",
                    existing_dict.get("startPlaceId"),
                )
            if self._has_meaningful_location(existing_dict.get("destination")):
                processed_data.setdefault(
                    "destination",
                    existing_dict.get("destination"),
                )
                processed_data.setdefault(
                    "destinationPlaceId",
                    existing_dict.get("destinationPlaceId"),
                )
            if existing_dict.get("matchedGps") and not force_map_match:
                processed_data.setdefault("matchedGps", existing_dict.get("matchedGps"))
                processed_data.setdefault(
                    "matchStatus",
                    existing_dict.get("matchStatus"),
                )
                processed_data.setdefault("matched_at", existing_dict.get("matched_at"))

        matched = False
        if do_map_match and not processed_data.get("matchedGps"):
            status, processed_data = await self.matcher.map_match(processed_data)
            if status == "matched":
                matched = True
                state = self._record_state(history, state, "map_matched")
        else:
            matched = bool(processed_data.get("matchedGps"))

        if do_geocode:
            processed_data = await self.geo_service.geocode(processed_data)
            if not matched:
                state = self._record_state(history, state, "geocoded")

        if not matched:
            state = self._record_state(history, state, "completed")

        processing_state = "map_matched" if matched else "completed"

        processed_data["processing_state"] = processing_state
        processed_data["processing_history"] = history
        processed_data["source"] = source
        processed_data["saved_at"] = get_current_utc_time()
        processed_data["status"] = "processed"

        gps = processed_data.get("gps")
        if gps is not None and not is_valid_geojson_geometry(gps):
            logger.error(
                "Trip %s: invalid gps geometry at save time; setting gps to null",
                transaction_id,
            )
            processed_data["gps"] = None

        start_geo, dest_geo = derive_geo_points(processed_data.get("gps"))
        if start_geo:
            processed_data["startGeoPoint"] = start_geo
        if dest_geo:
            processed_data["destinationGeoPoint"] = dest_geo

        if "_id" in processed_data:
            processed_data.pop("_id", None)

        if existing_trip:
            self._merge_trip_fields(
                existing_trip,
                processed_data,
                mark_processed=True,
                processing_state=processing_state,
            )
            final_trip = existing_trip
        else:
            final_trip = Trip(**processed_data)
            if final_trip.id is None:
                final_trip.id = PydanticObjectId()

        coverage_emitted_at = None
        if do_coverage and getattr(final_trip, "coverage_emitted_at", None) is None:
            try:
                if processed_data.get("gps"):
                    await self.coverage_service(
                        processed_data,
                        getattr(final_trip, "id", None),
                    )
                    coverage_emitted_at = get_current_utc_time()
            except Exception as exc:
                logger.warning(
                    "Failed to update coverage for trip %s: %s",
                    transaction_id,
                    exc,
                )

        if coverage_emitted_at:
            final_trip.coverage_emitted_at = coverage_emitted_at

        if existing_trip:
            await final_trip.save()
        else:
            await final_trip.insert()

        try:
            await MobilityInsightsService.sync_trip(final_trip)
        except Exception as exc:
            logger.warning(
                "Failed to sync mobility insights for trip %s: %s",
                transaction_id,
                exc,
            )

        logger.debug("Saved trip %s successfully", transaction_id)
        return final_trip

    async def process_raw_trip_insert_only(
        self,
        raw_data: dict[str, Any],
        *,
        source: str = "api",
        do_map_match: bool = False,
        do_geocode: bool = True,
        do_coverage: bool = True,
        skip_existing_check: bool = False,
    ) -> Trip | None:
        """
        Process a raw trip and insert it only if it does not already exist.

        This is intentionally "insert-only": if a trip with the same
        transactionId exists, this returns None and does not modify the
        stored trip in any way.
        """
        if not raw_data:
            logger.warning("No trip data provided to pipeline")
            return None

        success, processed_data, history, state, error = self._validate_and_basic(
            raw_data,
        )
        if not success:
            logger.warning(
                "Trip %s failed validation: %s",
                raw_data.get("transactionId", "unknown"),
                error,
            )
            return None

        transaction_id = processed_data.get("transactionId")
        if not transaction_id:
            logger.warning("Trip missing transactionId, skipping")
            return None

        if not skip_existing_check:
            existing_trip = await Trip.find_one(Trip.transactionId == transaction_id)
            if existing_trip:
                logger.debug(
                    "Trip %s already exists; skipping insert-only processing",
                    transaction_id,
                )
                return None

        matched = False
        if do_map_match and not processed_data.get("matchedGps"):
            status, processed_data = await self.matcher.map_match(processed_data)
            if status == "matched":
                matched = True
                state = self._record_state(history, state, "map_matched")
        else:
            matched = bool(processed_data.get("matchedGps"))

        if do_geocode:
            processed_data = await self.geo_service.geocode(processed_data)
            if not matched:
                state = self._record_state(history, state, "geocoded")

        if not matched:
            state = self._record_state(history, state, "completed")

        processing_state = "map_matched" if matched else "completed"

        processed_data["processing_state"] = processing_state
        processed_data["processing_history"] = history
        processed_data["source"] = source
        processed_data["saved_at"] = get_current_utc_time()
        processed_data["status"] = "processed"

        gps = processed_data.get("gps")
        if gps is not None and not is_valid_geojson_geometry(gps):
            logger.error(
                "Trip %s: invalid gps geometry at save time; setting gps to null",
                transaction_id,
            )
            processed_data["gps"] = None

        start_geo, dest_geo = derive_geo_points(processed_data.get("gps"))
        if start_geo:
            processed_data["startGeoPoint"] = start_geo
        if dest_geo:
            processed_data["destinationGeoPoint"] = dest_geo

        if "_id" in processed_data:
            processed_data.pop("_id", None)

        final_trip = Trip(**processed_data)
        if final_trip.id is None:
            final_trip.id = PydanticObjectId()

        try:
            await final_trip.insert()
        except Exception as exc:
            # If a concurrent importer inserted the same trip, skip silently.
            if exc.__class__.__name__ == "DuplicateKeyError":
                logger.info(
                    "Trip %s inserted concurrently; skipping insert-only processing",
                    transaction_id,
                )
                return None
            raise

        if do_coverage and getattr(final_trip, "coverage_emitted_at", None) is None:
            try:
                if processed_data.get("gps"):
                    await self.coverage_service(
                        processed_data,
                        getattr(final_trip, "id", None),
                    )
                    final_trip.coverage_emitted_at = get_current_utc_time()
                    await final_trip.save()
            except Exception as exc:
                logger.warning(
                    "Failed to update coverage for trip %s: %s",
                    transaction_id,
                    exc,
                )

        try:
            await MobilityInsightsService.sync_trip(final_trip)
        except Exception as exc:
            logger.warning(
                "Failed to sync mobility insights for trip %s: %s",
                transaction_id,
                exc,
            )

        logger.debug("Inserted trip %s successfully (insert-only)", transaction_id)
        return final_trip

    def _validate_and_basic(
        self,
        raw_data: dict[str, Any],
    ) -> tuple[bool, dict[str, Any], list[ProcessingHistoryEntry], str, str | None]:
        history: list[ProcessingHistoryEntry] = []
        state = "new"
        error = None
        processed_data: dict[str, Any] = {}
        transaction_id = raw_data.get("transactionId", "unknown")

        try:
            validated_trip = Trip(**raw_data)
            processed_data = validated_trip.model_dump(exclude_unset=True)

            processed_data["validated_at"] = get_current_utc_time()
            processed_data["validation_status"] = "validated"
            processed_data["invalid"] = False
            processed_data["validation_message"] = None

            state = self._record_state(history, state, "validated")

            basic_ok, error = self._basic_process(processed_data)
            if not basic_ok:
                state = self._record_state(history, state, "failed", error)
                return False, processed_data, history, state, error

            state = self._record_state(history, state, "processed")

        except ValidationError as exc:
            error = f"Validation error: {exc}"
            logger.warning("Trip %s failed validation: %s", transaction_id, error)
        except Exception as exc:
            error = f"Unexpected validation error: {exc!s}"
            logger.exception("Error validating trip %s", raw_data.get("transactionId"))
        else:
            return True, processed_data, history, state, None

        state = self._record_state(history, state, "failed", error)
        return False, processed_data, history, state, error

    def _validate_only(
        self,
        raw_data: dict[str, Any],
    ) -> tuple[bool, dict[str, Any], list[ProcessingHistoryEntry], str, str | None]:
        history: list[ProcessingHistoryEntry] = []
        state = "new"
        error = None
        processed_data: dict[str, Any] = {}
        transaction_id = raw_data.get("transactionId", "unknown")

        try:
            validated_trip = Trip(**raw_data)
            processed_data = validated_trip.model_dump(exclude_unset=True)

            processed_data["validated_at"] = get_current_utc_time()
            processed_data["validation_status"] = "validated"
            processed_data["invalid"] = False
            processed_data["validation_message"] = None

            state = self._record_state(history, state, "validated")

        except ValidationError as exc:
            error = f"Validation error: {exc}"
            logger.warning("Trip %s failed validation: %s", transaction_id, error)
        except Exception as exc:
            error = f"Unexpected validation error: {exc!s}"
            logger.exception("Error validating trip %s", raw_data.get("transactionId"))
        else:
            return True, processed_data, history, state, None

        state = self._record_state(history, state, "failed", error)
        return False, processed_data, history, state, error

    @staticmethod
    def _record_state(
        history: list[ProcessingHistoryEntry],
        from_state: str,
        to_state: str,
        error: str | None = None,
    ) -> str:
        entry: dict[str, Any] = {
            "from": from_state,
            "to": to_state,
            "timestamp": get_current_utc_time(),
        }
        if error and to_state == "failed":
            entry["error"] = error
        history.append(entry)
        return to_state

    @staticmethod
    def _basic_process(processed_data: dict[str, Any]) -> tuple[bool, str | None]:
        gps_data = processed_data.get("gps")
        processed_data.get("transactionId", "unknown")
        if not gps_data:
            return False, "Missing GPS data for basic processing"

        gps_type = gps_data.get("type")
        gps_coords = gps_data.get("coordinates")

        if gps_type == "Point":
            if not (
                gps_coords and isinstance(gps_coords, list) and len(gps_coords) == 2
            ):
                return False, "Point GeoJSON has invalid coordinates"
            start_coord = gps_coords
            end_coord = gps_coords
            processed_data["distance"] = 0.0
        elif gps_type == "LineString":
            if not (
                gps_coords and isinstance(gps_coords, list) and len(gps_coords) >= 2
            ):
                return False, "LineString has insufficient coordinates"
            start_coord = gps_coords[0]
            end_coord = gps_coords[-1]

            if not processed_data.get("distance"):
                processed_data["distance"] = TripPipeline._calculate_distance(
                    gps_coords,
                )
        else:
            return False, f"Unsupported GPS type '{gps_type}'"

        valid_start, _ = GeometryService.validate_coordinate_pair(start_coord)
        valid_end, _ = GeometryService.validate_coordinate_pair(end_coord)
        if not valid_start or not valid_end:
            return False, "Invalid start or end coordinates"

        if "totalIdleDuration" in processed_data:
            processed_data["totalIdleDurationFormatted"] = (
                TripPipeline._format_idle_time(
                    processed_data["totalIdleDuration"],
                )
            )

        return True, None

    @staticmethod
    def _calculate_distance(gps_coords: list[list[float]]) -> float:
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

    @staticmethod
    def _format_idle_time(seconds: Any) -> str:
        if not seconds:
            return "00:00:00"

        try:
            total_seconds = int(seconds)
            hrs = total_seconds // 3600
            mins = (total_seconds % 3600) // 60
            secs = total_seconds % 60
        except (TypeError, ValueError):
            logger.exception("Invalid input for format_idle_time: %s", seconds)
            return "00:00:00"
        else:
            return f"{hrs:02d}:{mins:02d}:{secs:02d}"

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
            "startPlaceId",
            "location_schema_version",
            "geocoded_at",
            "saved_at",
            "processing_state",
            "processing_history",
        }
        for key in prefer_incoming:
            if key in incoming and incoming[key] is not None:
                setattr(trip, key, incoming[key])

        for field in ("startLocation", "destination"):
            if field not in incoming:
                continue
            incoming_val = incoming.get(field)
            if incoming_val is None:
                continue
            existing_val = existing.get(field)
            if self._has_meaningful_location(
                incoming_val,
            ) or not self._has_meaningful_location(existing_val):
                setattr(trip, field, incoming_val)

        if (
            gps_changed
            or not existing.get("startGeoPoint")
            or not existing.get("destinationGeoPoint")
        ):
            start_geo, dest_geo = derive_geo_points(getattr(trip, "gps", None))
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

        incoming_source = incoming.get("source")
        existing_source = existing.get("source")
        if incoming_source and (
            not existing_source or incoming_source == BOUNCIE_SOURCE
        ):
            trip.source = incoming_source

        if not existing.get("coverage_emitted_at") and incoming.get(
            "coverage_emitted_at",
        ):
            trip.coverage_emitted_at = incoming.get("coverage_emitted_at")

    @staticmethod
    def _has_meaningful_location(value: Any) -> bool:
        if value is None:
            return False
        if isinstance(value, str):
            normalized = value.strip().lower()
            return normalized not in {"", "unknown", "n/a", "na"}
        if isinstance(value, dict):
            formatted = str(value.get("formatted_address") or "").strip()
            if formatted:
                return True
            name = str(value.get("name") or "").strip()
            if name:
                return True
            components = value.get("address_components")
            if isinstance(components, dict):
                return any(str(item).strip() for item in components.values())
            return False
        return False


__all__ = ["TripPipeline"]
