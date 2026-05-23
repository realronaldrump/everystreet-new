"""Service for odometer estimation and vehicle location resolution."""

import logging
from datetime import datetime
from itertools import pairwise
from typing import Any

from core.date_utils import parse_timestamp
from core.exceptions import ValidationException
from core.spatial import GeometryService
from core.trip_query_spec import apply_trip_record_filters
from core.trip_source_policy import enforce_bouncie_source
from db.models import GasFillup, Trip
from gas.services.bouncie_service import BouncieService

logger = logging.getLogger(__name__)


class OdometerService:
    """Service class for odometer estimation and location operations."""

    @staticmethod
    async def get_vehicle_location_at_time(
        imei: str,
        timestamp: str | None = None,
        use_now: bool = False,
    ) -> dict[str, Any]:
        """
        Get vehicle location and odometer at a specific time.

        Args:
            imei: Vehicle IMEI
            timestamp: ISO datetime string to lookup (required if use_now is False)
            use_now: Use last known location instead of timestamp

        Returns:
            Dict with latitude, longitude, odometer, timestamp, address
        """
        target_time: datetime | None = None
        if not use_now:
            if not timestamp:
                msg = "timestamp parameter is required when use_now is false"
                raise ValidationException(
                    msg,
                )
            target_time = parse_timestamp(timestamp)
            if not target_time:
                msg = "Invalid timestamp format"
                raise ValidationException(msg)

        if use_now:
            # Try to get real-time data from Bouncie API first
            bouncie_data = await BouncieService.fetch_vehicle_status(imei)
            if bouncie_data and bouncie_data.get("odometer") is not None:
                logger.info("Using real-time Bouncie data for IMEI %s", imei)
                return bouncie_data

            # Use most recent trip data if real-time data is unavailable.
            logger.info("Using local trip data for IMEI %s", imei)
            trip = (
                await Trip.find(
                    enforce_bouncie_source(
                        apply_trip_record_filters({"imei": imei}),
                    )
                )
                .sort(-Trip.endTime)
                .first_or_none()
            )
        else:
            location_position = "interpolate"
            # Find the trip closest to this timestamp
            # First, try to find a trip that contains this timestamp
            trip = await Trip.find_one(
                enforce_bouncie_source(
                    apply_trip_record_filters(
                        {
                        "imei": imei,
                        "startTime": {"$lte": target_time},
                        "endTime": {"$gte": target_time},
                        }
                    ),
                ),
            )

            # If no trip contains the timestamp, compare the nearest trip before
            # and after the target time instead of always preferring the prior trip.
            if not trip:
                previous_trip = (
                    await Trip.find(
                        enforce_bouncie_source(
                            apply_trip_record_filters(
                                {
                                "imei": imei,
                                "endTime": {"$lte": target_time},
                                }
                            ),
                        ),
                    )
                    .sort(-Trip.endTime)
                    .first_or_none()
                )

                next_trip = (
                    await Trip.find(
                        enforce_bouncie_source(
                            apply_trip_record_filters(
                                {
                                "imei": imei,
                                "startTime": {"$gte": target_time},
                                }
                            ),
                        ),
                    )
                    .sort(Trip.startTime)
                    .first_or_none()
                )

                previous_end = parse_timestamp(previous_trip.endTime) if previous_trip else None
                next_start = parse_timestamp(next_trip.startTime) if next_trip else None

                if previous_trip and next_trip and previous_end and next_start:
                    previous_gap = abs((target_time - previous_end).total_seconds())
                    next_gap = abs((next_start - target_time).total_seconds())
                    if next_gap < previous_gap:
                        trip = next_trip
                        location_position = "start"
                    else:
                        trip = previous_trip
                        location_position = "end"
                elif next_trip and next_start:
                    trip = next_trip
                    location_position = "start"
                elif previous_trip and previous_end:
                    trip = previous_trip
                    location_position = "end"
                else:
                    trip = previous_trip or next_trip
                    location_position = "end" if previous_trip else "start"
        if use_now:
            location_position = "end"

        if not trip:
            logger.warning(
                "No trip found for IMEI %s (use_now=%s, timestamp=%s)",
                imei,
                use_now,
                timestamp,
            )
            return {"latitude": None, "longitude": None, "odometer": None}

        inside_trip_window = (
            not use_now
            and target_time is not None
            and trip.startTime is not None
            and trip.endTime is not None
            and trip.startTime <= target_time <= trip.endTime
        )

        if location_position == "start":
            resolved_odometer = trip.startOdometer
            resolved_timestamp = trip.startTime
            odometer_source = "trip_start"
        else:
            resolved_odometer = trip.endOdometer
            resolved_timestamp = trip.endTime
            odometer_source = "trip_end"
        trip_progress: float | None = None

        if (
            inside_trip_window
            and target_time is not None
            and trip.startTime is not None
            and trip.endTime is not None
            and trip.endTime > trip.startTime
        ):
            total_seconds = (trip.endTime - trip.startTime).total_seconds()
            elapsed_seconds = (target_time - trip.startTime).total_seconds()
            trip_progress = min(max(elapsed_seconds / total_seconds, 0.0), 1.0)
            resolved_timestamp = target_time

        if (
            inside_trip_window
            and target_time is not None
            and trip.startTime is not None
            and trip.endTime is not None
            and trip.endTime > trip.startTime
            and trip.startOdometer is not None
            and trip.endOdometer is not None
            and trip_progress is not None
        ):
            resolved_odometer = trip.startOdometer + (
                (trip.endOdometer - trip.startOdometer) * trip_progress
            )
            resolved_timestamp = target_time
            odometer_source = "trip_interpolated"

        # Extract location from the end of the trip
        location_address = None
        if location_position == "start":
            start_location = getattr(trip, "startLocation", None)
            if isinstance(start_location, dict):
                location_address = start_location.get("formatted_address")
        else:
            destination = getattr(trip, "destination", None)
            if isinstance(destination, dict):
                location_address = destination.get("formatted_address")

        location_data = {
            "latitude": None,
            "longitude": None,
            "odometer": resolved_odometer,
            "odometer_source": odometer_source if resolved_odometer is not None else None,
            "odometer_is_estimated": (
                resolved_odometer is not None and odometer_source == "trip_interpolated"
            ),
            "timestamp": resolved_timestamp,
            "address": location_address,
        }

        logger.info(
            "Vehicle Loc Debug: Found trip %s, EndOdo: %s",
            trip.transactionId,
            location_data["odometer"],
        )

        # Try to get coordinates from various sources.
        if (
            location_position == "interpolate"
            and target_time is not None
            and isinstance(trip.coordinates, list)
        ):
            location_data = OdometerService._extract_coordinate_at_time(
                trip.coordinates,
                target_time,
                location_data,
            )

        # 1. GPS Data
        if location_data["latitude"] is None and isinstance(trip.gps, dict) and trip.gps:
            location_data = OdometerService._extract_gps_coordinates(
                trip.gps,
                location_data,
                position=location_position,
                progress=trip_progress,
            )

        start_location = getattr(trip, "startLocation", None)
        end_location = getattr(trip, "endLocation", None)
        if (
            location_data["latitude"] is None
            and location_position == "start"
            and isinstance(start_location, dict)
        ):
            location_data = OdometerService._extract_start_location(
                start_location,
                location_data,
            )
        if location_data["latitude"] is None and isinstance(end_location, dict):
            location_data = OdometerService._extract_end_location(
                end_location,
                location_data,
            )
        if location_data["latitude"] is None and isinstance(start_location, dict):
            location_data = OdometerService._extract_start_location(
                start_location,
                location_data,
            )

        # Odometer defaults
        if location_data["odometer"] is None:
            if trip.endOdometer is not None:
                location_data["odometer"] = trip.endOdometer
            elif trip.startOdometer is not None:
                location_data["odometer"] = trip.startOdometer
                logger.info(
                    "Vehicle Loc Debug: Using startOdometer %s",
                    location_data["odometer"],
                )

        return location_data

    @staticmethod
    def _extract_coordinate_at_time(
        coordinate_entries: list[dict[str, Any]],
        target_time: datetime,
        location_data: dict[str, Any],
    ) -> dict[str, Any]:
        """Interpolate a lat/lon from timestamped coordinate entries."""

        valid_entries: list[tuple[datetime, float, float]] = []
        for entry in coordinate_entries:
            if not isinstance(entry, dict):
                continue
            timestamp = parse_timestamp(entry.get("timestamp"))
            lat = entry.get("lat")
            lon = entry.get("lon")
            if timestamp is None or lat is None or lon is None:
                continue
            is_valid, validated = GeometryService.validate_coordinate_pair([lon, lat])
            if is_valid and validated is not None:
                valid_entries.append((timestamp, validated[0], validated[1]))

        if not valid_entries:
            return location_data

        valid_entries.sort(key=lambda item: item[0])

        if target_time <= valid_entries[0][0]:
            _, lon, lat = valid_entries[0]
        elif target_time >= valid_entries[-1][0]:
            _, lon, lat = valid_entries[-1]
        else:
            lon = valid_entries[-1][1]
            lat = valid_entries[-1][2]
            for previous, current in pairwise(valid_entries):
                prev_time, prev_lon, prev_lat = previous
                curr_time, curr_lon, curr_lat = current
                if prev_time <= target_time <= curr_time:
                    duration = (curr_time - prev_time).total_seconds()
                    if duration <= 0:
                        lon = curr_lon
                        lat = curr_lat
                    else:
                        progress = (target_time - prev_time).total_seconds() / duration
                        lon = prev_lon + ((curr_lon - prev_lon) * progress)
                        lat = prev_lat + ((curr_lat - prev_lat) * progress)
                    break

        location_data["longitude"] = lon
        location_data["latitude"] = lat
        return location_data

    @staticmethod
    def _extract_gps_coordinates(
        gps: dict[str, Any],
        location_data: dict[str, Any],
        *,
        position: str = "end",
        progress: float | None = None,
    ) -> dict[str, Any]:
        """
        Extract coordinates from GPS data.

        Args:
            gps: GPS geometry object
            location_data: Location data dict to update

        Returns:
            Updated location_data dict
        """
        g_type = gps.get("type")
        coords = gps.get("coordinates")

        candidate_coord = None
        if g_type == "Point" and coords:
            candidate_coord = coords
        elif g_type == "LineString" and coords:
            if position == "start":
                candidate_coord = coords[0]
            elif progress is not None and len(coords) > 1:
                coord_index = round(progress * (len(coords) - 1))
                coord_index = min(max(coord_index, 0), len(coords) - 1)
                candidate_coord = coords[coord_index]
            else:
                candidate_coord = coords[-1]
        if candidate_coord:
            is_valid, validated = GeometryService.validate_coordinate_pair(
                candidate_coord,
            )
            if is_valid and validated is not None:
                location_data["longitude"] = validated[0]
                location_data["latitude"] = validated[1]

        return location_data

    @staticmethod
    def _extract_end_location(
        end_location: dict[str, Any],
        location_data: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Extract coordinates from end location.

        Args:
            end_location: End location object
            location_data: Location data dict to update

        Returns:
            Updated location_data dict
        """
        if "lat" in end_location and "lon" in end_location:
            is_valid, validated = GeometryService.validate_coordinate_pair(
                [end_location["lon"], end_location["lat"]],
            )
            if is_valid and validated is not None:
                location_data["longitude"] = validated[0]
                location_data["latitude"] = validated[1]
                logger.info("Vehicle Loc Debug: Used endLocation value")

        return location_data

    @staticmethod
    def _extract_start_location(
        start_location: dict[str, Any],
        location_data: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Extract coordinates from start location.

        Args:
            start_location: Start location object
            location_data: Location data dict to update

        Returns:
            Updated location_data dict
        """
        if "lat" in start_location and "lon" in start_location:
            is_valid, validated = GeometryService.validate_coordinate_pair(
                [start_location["lon"], start_location["lat"]],
            )
            if is_valid and validated is not None:
                location_data["longitude"] = validated[0]
                location_data["latitude"] = validated[1]
                logger.info("Vehicle Loc Debug: Used startLocation value")

        return location_data

    @staticmethod
    async def _sum_trip_distance_over_interval(
        imei: str,
        start_time: datetime,
        end_time: datetime,
    ) -> float:
        """Sum distance across an interval, prorating partially overlapping trips."""
        start_time = parse_timestamp(start_time)
        end_time = parse_timestamp(end_time)
        if start_time is None or end_time is None:
            return 0.0

        if start_time >= end_time:
            return 0.0

        overlapping_trips = await (
            Trip.find(
                enforce_bouncie_source(
                    apply_trip_record_filters(
                        {
                        "imei": imei,
                        "startTime": {"$lt": end_time},
                        "endTime": {"$gt": start_time},
                        }
                    ),
                ),
            )
            .sort(Trip.startTime)
            .to_list()
        )

        distance_sum = 0.0
        for trip in overlapping_trips:
            trip_start = parse_timestamp(trip.startTime)
            trip_end = parse_timestamp(trip.endTime)
            trip_distance = trip.distance

            if (
                trip_start is None
                or trip_end is None
                or trip_end <= trip_start
                or trip_distance is None
                or trip_distance <= 0
            ):
                continue

            overlap_start = max(trip_start, start_time)
            overlap_end = min(trip_end, end_time)
            if overlap_end <= overlap_start:
                continue

            trip_duration_s = (trip_end - trip_start).total_seconds()
            overlap_s = (overlap_end - overlap_start).total_seconds()
            if trip_duration_s <= 0 or overlap_s <= 0:
                continue

            distance_sum += float(trip_distance) * (overlap_s / trip_duration_s)

        return distance_sum

    @staticmethod
    def _anchor_response(fillup: GasFillup | None) -> dict[str, Any] | None:
        if fillup is None:
            return None
        anchor_time = parse_timestamp(fillup.fillup_time)
        if anchor_time is None or fillup.odometer is None:
            return None
        return {
            "timestamp": anchor_time,
            "odometer": fillup.odometer,
        }

    @staticmethod
    def _no_estimate_response() -> dict[str, Any]:
        return {
            "estimated_odometer": None,
            "method": "no_data",
            "confidence": "none",
            "distance_diff": 0.0,
            "previous_anchor": None,
            "next_anchor": None,
        }

    @staticmethod
    async def estimate_odometer_reading(imei: str, timestamp: str) -> dict[str, Any]:
        """
        Estimate odometer reading by interpolating/extrapolating from nearest known
        anchors.

        Args:
            imei: Vehicle IMEI
            timestamp: ISO datetime string to estimate at

        Returns:
            Dict with estimated_odometer, method, confidence, distance_diff, and
            trusted manual anchors when available.
        """
        target_time = parse_timestamp(timestamp)
        if not target_time:
            msg = "Invalid timestamp format"
            raise ValidationException(msg)

        trusted_anchor_filter = {
            "imei": imei,
            "odometer": {"$ne": None},
            "odometer_source": "manual",
            "odometer_is_estimated": {"$ne": True},
        }

        prev_fillup = await (
            GasFillup.find(
                {
                    **trusted_anchor_filter,
                    "fillup_time": {"$lte": target_time},
                },
            )
            .sort(-GasFillup.fillup_time)
            .first_or_none()
        )

        prev_fillup_time = (
            parse_timestamp(prev_fillup.fillup_time)
            if prev_fillup and prev_fillup.fillup_time is not None
            else None
        )

        next_fillup = await (
            GasFillup.find(
                {
                    **trusted_anchor_filter,
                    "fillup_time": {"$gt": target_time},
                },
            )
            .sort(GasFillup.fillup_time)
            .first_or_none()
        )

        next_fillup_time = (
            parse_timestamp(next_fillup.fillup_time)
            if next_fillup and next_fillup.fillup_time is not None
            else None
        )

        previous_anchor = OdometerService._anchor_response(prev_fillup)
        next_anchor = OdometerService._anchor_response(next_fillup)

        if (
            prev_fillup
            and next_fillup
            and prev_fillup_time is not None
            and next_fillup_time is not None
            and prev_fillup.odometer is not None
            and next_fillup.odometer is not None
        ):
            if target_time == prev_fillup_time:
                return {
                    "estimated_odometer": round(prev_fillup.odometer, 1),
                    "method": "calibrated_between_manual_anchors",
                    "confidence": "calibrated",
                    "distance_diff": 0.0,
                    "previous_anchor": previous_anchor,
                    "next_anchor": next_anchor,
                }

            raw_distance_to_target = (
                await OdometerService._sum_trip_distance_over_interval(
                    imei,
                    prev_fillup_time,
                    target_time,
                )
            )
            raw_distance_between_anchors = (
                await OdometerService._sum_trip_distance_over_interval(
                    imei,
                    prev_fillup_time,
                    next_fillup_time,
                )
            )

            odometer_delta = next_fillup.odometer - prev_fillup.odometer
            if raw_distance_between_anchors <= 0 or odometer_delta < 0:
                response = OdometerService._no_estimate_response()
                response["previous_anchor"] = previous_anchor
                response["next_anchor"] = next_anchor
                return response

            ratio = min(
                max(raw_distance_to_target / raw_distance_between_anchors, 0.0),
                1.0,
            )
            estimated_odometer = prev_fillup.odometer + (odometer_delta * ratio)
            return {
                "estimated_odometer": round(estimated_odometer, 1),
                "method": "calibrated_between_manual_anchors",
                "confidence": "calibrated",
                "distance_diff": round(raw_distance_to_target, 1),
                "previous_anchor": previous_anchor,
                "next_anchor": next_anchor,
            }

        if (
            prev_fillup
            and prev_fillup_time is not None
            and prev_fillup.odometer is not None
        ):
            distance_sum = await OdometerService._sum_trip_distance_over_interval(
                imei,
                prev_fillup_time,
                target_time,
            )
            distance_sum = round(distance_sum, 1)
            return {
                "estimated_odometer": round(prev_fillup.odometer + distance_sum, 1),
                "method": "calculated_from_prev_manual",
                "confidence": "low",
                "distance_diff": distance_sum,
                "previous_anchor": previous_anchor,
                "next_anchor": None,
            }

        if (
            next_fillup
            and next_fillup_time is not None
            and next_fillup.odometer is not None
        ):
            distance_sum = await OdometerService._sum_trip_distance_over_interval(
                imei,
                target_time,
                next_fillup_time,
            )
            distance_sum = round(distance_sum, 1)
            return {
                "estimated_odometer": round(next_fillup.odometer - distance_sum, 1),
                "method": "calculated_from_next_manual",
                "confidence": "low",
                "distance_diff": distance_sum,
                "previous_anchor": None,
                "next_anchor": next_anchor,
            }

        return OdometerService._no_estimate_response()
