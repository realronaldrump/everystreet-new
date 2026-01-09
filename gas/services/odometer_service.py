"""Service for odometer estimation and vehicle location resolution."""

import logging
from typing import Any

from db import (
    aggregate_with_retry,
    find_one_with_retry,
    gas_fillups_collection,
    trips_collection,
)
from gas.serializers import parse_iso_datetime
from gas.services.bouncie_service import BouncieService
from geometry_service import GeometryService

logger = logging.getLogger(__name__)


class OdometerService:
    """Service class for odometer estimation and location operations."""

    @staticmethod
    async def get_vehicle_location_at_time(
        imei: str,
        timestamp: str | None = None,
        use_now: bool = False,
    ) -> dict[str, Any]:
        """Get vehicle location and odometer at a specific time.

        Args:
            imei: Vehicle IMEI
            timestamp: ISO datetime string to lookup (required if use_now is False)
            use_now: Use last known location instead of timestamp

        Returns:
            Dict with latitude, longitude, odometer, timestamp, address
        """
        if not use_now and not timestamp:
            raise ValueError("timestamp parameter is required when use_now is false")

        if use_now:
            # Try to get real-time data from Bouncie API first
            bouncie_data = await BouncieService.fetch_vehicle_status(imei)
            if bouncie_data and bouncie_data.get("odometer"):
                logger.info("Using real-time Bouncie data for IMEI %s", imei)
                return bouncie_data

            # Fallback to most recent trip if Bouncie API fails
            logger.info("Falling back to local trip data for IMEI %s", imei)
            trip = await find_one_with_retry(
                trips_collection,
                {"imei": imei},
                sort=[("endTime", -1)],
            )
        else:
            # Parse timestamp
            target_time = parse_iso_datetime(timestamp)

            # Find the trip closest to this timestamp
            # First, try to find a trip that contains this timestamp
            trip = await find_one_with_retry(
                trips_collection,
                {
                    "imei": imei,
                    "startTime": {"$lte": target_time},
                    "endTime": {"$gte": target_time},
                },
            )

            # If no trip contains the timestamp, find the closest trip before it
            if not trip:
                trip = await find_one_with_retry(
                    trips_collection,
                    {"imei": imei, "endTime": {"$lte": target_time}},
                    sort=[("endTime", -1)],
                )

            # If still no trip, find the closest trip after it
            if not trip:
                trip = await find_one_with_retry(
                    trips_collection,
                    {"imei": imei, "startTime": {"$gte": target_time}},
                    sort=[("startTime", 1)],
                )

        if not trip:
            logger.warning(
                "No trip found for IMEI %s (use_now=%s, timestamp=%s)", imei, use_now, timestamp
            )
            return {"latitude": None, "longitude": None, "odometer": None}

        # Extract location from the end of the trip
        location_data = {
            "latitude": None,
            "longitude": None,
            "odometer": trip.get("endOdometer"),
            "timestamp": trip.get("endTime"),
            "address": trip.get("destination", {}).get("formatted_address"),
        }

        logger.info(
            "Vehicle Loc Debug: Found trip %s, EndOdo: %s",
            trip.get("transactionId"),
            location_data["odometer"],
        )

        # Try to get coordinates from various sources
        # 1. GPS Data (Most accurate)
        if trip.get("gps"):
            location_data = OdometerService._extract_gps_coordinates(
                trip["gps"], location_data
            )

        # 2. End Location (Direct lat/lon)
        if not location_data["latitude"] and trip.get("endLocation"):
            location_data = OdometerService._extract_end_location(
                trip["endLocation"], location_data
            )

        # 3. Start Location (Fallback if trip has no movement)
        if not location_data["latitude"] and trip.get("startLocation"):
            location_data = OdometerService._extract_start_location(
                trip["startLocation"], location_data
            )

        # Odometer Fallback
        if location_data["odometer"] is None:
            if trip.get("endOdometer"):
                location_data["odometer"] = trip.get("endOdometer")
            elif trip.get("startOdometer"):
                location_data["odometer"] = trip.get("startOdometer")
                logger.info(
                    "Vehicle Loc Debug: Fallback to startOdometer %s",
                    location_data["odometer"],
                )

        return location_data

    @staticmethod
    def _extract_gps_coordinates(
        gps: dict[str, Any], location_data: dict[str, Any]
    ) -> dict[str, Any]:
        """Extract coordinates from GPS data.

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
        # Handle legacy FeatureCollection if present
        elif g_type == "FeatureCollection":
            features = gps.get("features", [])
            if features and features[0].get("geometry", {}).get("coordinates"):
                fc_coords = features[0]["geometry"]["coordinates"]
                if fc_coords:
                    candidate_coord = fc_coords[-1]

        if candidate_coord:
            is_valid, validated = GeometryService.validate_coordinate_pair(
                candidate_coord
            )
            if is_valid and validated is not None:
                location_data["longitude"] = validated[0]
                location_data["latitude"] = validated[1]

        return location_data

    @staticmethod
    def _extract_end_location(
        end_location: dict[str, Any], location_data: dict[str, Any]
    ) -> dict[str, Any]:
        """Extract coordinates from end location.

        Args:
            end_location: End location object
            location_data: Location data dict to update

        Returns:
            Updated location_data dict
        """
        if "lat" in end_location and "lon" in end_location:
            is_valid, validated = GeometryService.validate_coordinate_pair(
                [end_location["lon"], end_location["lat"]]
            )
            if is_valid and validated is not None:
                location_data["longitude"] = validated[0]
                location_data["latitude"] = validated[1]
                logger.info("Vehicle Loc Debug: Used endLocation fallback")

        return location_data

    @staticmethod
    def _extract_start_location(
        start_location: dict[str, Any], location_data: dict[str, Any]
    ) -> dict[str, Any]:
        """Extract coordinates from start location.

        Args:
            start_location: Start location object
            location_data: Location data dict to update

        Returns:
            Updated location_data dict
        """
        if "lat" in start_location and "lon" in start_location:
            is_valid, validated = GeometryService.validate_coordinate_pair(
                [start_location["lon"], start_location["lat"]]
            )
            if is_valid and validated is not None:
                location_data["longitude"] = validated[0]
                location_data["latitude"] = validated[1]
                logger.info("Vehicle Loc Debug: Used startLocation fallback")

        return location_data

    @staticmethod
    async def estimate_odometer_reading(imei: str, timestamp: str) -> dict[str, Any]:
        """Estimate odometer reading by interpolating/extrapolating from nearest known anchors.

        Args:
            imei: Vehicle IMEI
            timestamp: ISO datetime string to estimate at

        Returns:
            Dict with estimated_odometer, anchor_date, anchor_odometer, distance_diff, method
        """
        target_time = parse_iso_datetime(timestamp)

        # 1. Find Anchors (Gas Fill-ups)
        # Previous trusted fill-up
        prev_fillup = await find_one_with_retry(
            gas_fillups_collection,
            {
                "imei": imei,
                "fillup_time": {"$lte": target_time},
                "odometer": {"$ne": None},
            },
            sort=[("fillup_time", -1)],
        )

        # Next trusted fill-up
        next_fillup = await find_one_with_retry(
            gas_fillups_collection,
            {
                "imei": imei,
                "fillup_time": {"$gt": target_time},
                "odometer": {"$ne": None},
            },
            sort=[("fillup_time", 1)],
        )

        best_anchor = None
        anchor_type = None  # "prev" or "next"

        # Decide which anchor to use (closest)
        if prev_fillup and next_fillup:
            diff_prev = abs((target_time - prev_fillup["fillup_time"]).total_seconds())
            diff_next = abs((next_fillup["fillup_time"] - target_time).total_seconds())
            if diff_prev < diff_next:
                best_anchor = prev_fillup
                anchor_type = "prev"
            else:
                best_anchor = next_fillup
                anchor_type = "next"
        elif prev_fillup:
            best_anchor = prev_fillup
            anchor_type = "prev"
        elif next_fillup:
            best_anchor = next_fillup
            anchor_type = "next"

        # 2. If no fill-up anchor, try to find a trip anchor
        if not best_anchor:
            prev_trip = await find_one_with_retry(
                trips_collection,
                {
                    "imei": imei,
                    "endTime": {"$lte": target_time},
                    "endOdometer": {"$ne": None},
                },
                sort=[("endTime", -1)],
            )
            if prev_trip:
                # Standardize structure to look like fillup for calc
                best_anchor = {
                    "fillup_time": prev_trip["endTime"],
                    "odometer": prev_trip["endOdometer"],
                }
                anchor_type = "prev"

        if not best_anchor:
            return {"estimated_odometer": None, "method": "no_data"}

        # 3. Sum Distance between anchor and target
        query = {"imei": imei}
        if anchor_type == "prev":
            query["startTime"] = {"$gte": best_anchor["fillup_time"]}
            query["endTime"] = {"$lte": target_time}
        else:  # next
            query["startTime"] = {"$gte": target_time}
            query["endTime"] = {"$lte": best_anchor["fillup_time"]}

        # Aggregation to sum distance
        pipeline = [
            {"$match": query},
            {"$group": {"_id": None, "total_distance": {"$sum": "$distance"}}},
        ]

        result = await aggregate_with_retry(trips_collection, pipeline)
        distance_sum = result[0]["total_distance"] if result else 0
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
