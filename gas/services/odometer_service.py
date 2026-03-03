"""Service for odometer estimation and vehicle location resolution."""

import logging
from datetime import datetime
from typing import Any

from core.date_utils import parse_timestamp
from core.exceptions import ValidationException
from core.spatial import GeometryService
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
                await Trip.find(enforce_bouncie_source({"imei": imei}))
                .sort(-Trip.endTime)
                .first_or_none()
            )
        else:
            # Find the trip closest to this timestamp
            # First, try to find a trip that contains this timestamp
            trip = await Trip.find_one(
                enforce_bouncie_source(
                    {
                        "imei": imei,
                        "startTime": {"$lte": target_time},
                        "endTime": {"$gte": target_time},
                    },
                ),
            )

            # If no trip contains the timestamp, find the closest trip before it
            if not trip:
                trip = (
                    await Trip.find(
                        enforce_bouncie_source(
                            {
                                "imei": imei,
                                "endTime": {"$lte": target_time},
                            },
                        ),
                    )
                    .sort(-Trip.endTime)
                    .first_or_none()
                )

            # If still no trip, find the closest trip after it
            if not trip:
                trip = (
                    await Trip.find(
                        enforce_bouncie_source(
                            {
                                "imei": imei,
                                "startTime": {"$gte": target_time},
                            },
                        ),
                    )
                    .sort(Trip.startTime)
                    .first_or_none()
                )

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

        resolved_odometer = trip.endOdometer
        resolved_timestamp = trip.endTime

        if (
            inside_trip_window
            and target_time is not None
            and trip.startTime is not None
            and trip.endTime is not None
            and trip.endTime > trip.startTime
            and trip.startOdometer is not None
            and trip.endOdometer is not None
        ):
            total_seconds = (trip.endTime - trip.startTime).total_seconds()
            elapsed_seconds = (target_time - trip.startTime).total_seconds()
            progress = min(max(elapsed_seconds / total_seconds, 0.0), 1.0)
            resolved_odometer = trip.startOdometer + (
                (trip.endOdometer - trip.startOdometer) * progress
            )
            resolved_timestamp = target_time

        # Extract location from the end of the trip
        destination_address = None
        destination = getattr(trip, "destination", None)
        if isinstance(destination, dict):
            destination_address = destination.get("formatted_address")

        location_data = {
            "latitude": None,
            "longitude": None,
            "odometer": resolved_odometer,
            "timestamp": resolved_timestamp,
            "address": destination_address,
        }

        logger.info(
            "Vehicle Loc Debug: Found trip %s, EndOdo: %s",
            trip.transactionId,
            location_data["odometer"],
        )

        # Try to get coordinates from various sources
        # 1. GPS Data (Most accurate)
        if isinstance(trip.gps, dict) and trip.gps:
            location_data = OdometerService._extract_gps_coordinates(
                trip.gps,
                location_data,
            )

        # 2. End Location (Direct lat/lon)
        end_location = getattr(trip, "endLocation", None)
        if location_data["latitude"] is None and isinstance(end_location, dict):
            location_data = OdometerService._extract_end_location(
                end_location,
                location_data,
            )

        # 3. Start Location (if trip has no movement)
        start_location = getattr(trip, "startLocation", None)
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
    def _extract_gps_coordinates(
        gps: dict[str, Any],
        location_data: dict[str, Any],
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
                    {
                        "imei": imei,
                        "startTime": {"$lt": end_time},
                        "endTime": {"$gt": start_time},
                    },
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
    async def estimate_odometer_reading(imei: str, timestamp: str) -> dict[str, Any]:
        """
        Estimate odometer reading by interpolating/extrapolating from nearest known
        anchors.

        Args:
            imei: Vehicle IMEI
            timestamp: ISO datetime string to estimate at

        Returns:
            Dict with estimated_odometer, anchor_date, anchor_odometer, distance_diff, method
        """
        target_time = parse_timestamp(timestamp)
        if not target_time:
            msg = "Invalid timestamp format"
            raise ValidationException(msg)

        # 1. Find Anchors (Gas Fill-ups)
        # Previous trusted fill-up
        prev_fillup = await (
            GasFillup.find(
                GasFillup.imei == imei,
                GasFillup.fillup_time <= target_time,
                GasFillup.odometer != None,  # noqa: E711
            )
            .sort(-GasFillup.fillup_time)
            .first_or_none()
        )

        prev_fillup_time = (
            parse_timestamp(prev_fillup.fillup_time)
            if prev_fillup and prev_fillup.fillup_time is not None
            else None
        )

        # Next trusted fill-up
        next_fillup = await (
            GasFillup.find(
                GasFillup.imei == imei,
                GasFillup.fillup_time > target_time,
                GasFillup.odometer != None,  # noqa: E711
            )
            .sort(GasFillup.fillup_time)
            .first_or_none()
        )

        next_fillup_time = (
            parse_timestamp(next_fillup.fillup_time)
            if next_fillup and next_fillup.fillup_time is not None
            else None
        )

        best_anchor = None
        anchor_type = None  # "prev" or "next"

        # Decide which anchor to use (closest)
        if (
            prev_fillup
            and next_fillup
            and prev_fillup_time is not None
            and next_fillup_time is not None
        ):
            diff_prev = abs((target_time - prev_fillup_time).total_seconds())
            diff_next = abs((next_fillup_time - target_time).total_seconds())
            if diff_prev < diff_next:
                best_anchor = {
                    "fillup_time": prev_fillup_time,
                    "odometer": prev_fillup.odometer,
                }
                anchor_type = "prev"
            else:
                best_anchor = {
                    "fillup_time": next_fillup_time,
                    "odometer": next_fillup.odometer,
                }
                anchor_type = "next"
        elif prev_fillup and prev_fillup_time is not None:
            best_anchor = {
                "fillup_time": prev_fillup_time,
                "odometer": prev_fillup.odometer,
            }
            anchor_type = "prev"
        elif next_fillup and next_fillup_time is not None:
            best_anchor = {
                "fillup_time": next_fillup_time,
                "odometer": next_fillup.odometer,
            }
            anchor_type = "next"

        # 2. If no fill-up anchor, try to find a trip anchor
        if not best_anchor:
            prev_trip = await (
                Trip.find(
                    enforce_bouncie_source(
                        {
                            "imei": imei,
                            "endTime": {"$lte": target_time},
                            "endOdometer": {"$ne": None},
                        },
                    ),
                )
                .sort(-Trip.endTime)
                .first_or_none()
            )
            if prev_trip:
                # Standardize structure to look like fillup for calc
                prev_trip_end = parse_timestamp(prev_trip.endTime)
                if prev_trip_end is None:
                    return {"estimated_odometer": None, "method": "no_data"}
                best_anchor = {
                    "fillup_time": prev_trip_end,
                    "odometer": prev_trip.endOdometer,
                }
                anchor_type = "prev"

        if not best_anchor:
            return {"estimated_odometer": None, "method": "no_data"}

        anchor_time = best_anchor.get("fillup_time")
        if anchor_time is None:
            return {"estimated_odometer": None, "method": "no_data"}

        # 3. Sum Distance between anchor and target (including partial overlap)
        if anchor_type == "prev":
            interval_start = anchor_time
            interval_end = target_time
        else:  # next
            interval_start = target_time
            interval_end = anchor_time

        distance_sum = await OdometerService._sum_trip_distance_over_interval(
            imei,
            interval_start,
            interval_end,
        )
        distance_sum = round(distance_sum, 1)

        # 4. Calculate estimated odometer
        if anchor_type == "prev":
            estimated_odometer = best_anchor["odometer"] + distance_sum
        else:
            estimated_odometer = best_anchor["odometer"] - distance_sum

        return {
            "estimated_odometer": round(estimated_odometer, 1),
            "anchor_date": best_anchor["fillup_time"],
            "anchor_odometer": best_anchor["odometer"],
            "distance_diff": distance_sum,
            "method": f"calculated_from_{anchor_type}",
        }
