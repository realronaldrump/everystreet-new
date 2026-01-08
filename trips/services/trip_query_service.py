"""Business logic for trip querying and filtering."""

import logging
from typing import Any

from date_utils import parse_timestamp
from db import (
    build_calendar_date_expr,
    trips_collection,
    vehicles_collection,
)
from geometry_service import GeometryService
from trips.serializers import _safe_float, _safe_int

logger = logging.getLogger(__name__)


class TripQueryService:
    """Service class for trip querying and filtering operations."""

    @staticmethod
    async def get_trips_datatable(
        draw: int,
        start: int,
        length: int,
        search_value: str,
        order: list,
        columns: list,
        filters: dict,
        start_date: str | None,
        end_date: str | None,
        price_map: dict,
    ) -> dict[str, Any]:
        """Get trips data formatted for DataTables server-side processing.

        Args:
            draw: DataTables draw counter
            start: Starting record index
            length: Number of records to return
            search_value: Global search value
            order: Sort order specification
            columns: Column definitions
            filters: Additional filters
            start_date: Optional start date filter
            end_date: Optional end date filter
            price_map: Gas price map for cost calculation

        Returns:
            DataTables formatted response
        """
        start = max(0, start)
        length = max(0, min(length, 500))  # prevent unbounded queries
        if not isinstance(columns, list):
            columns = []

        query = {"invalid": {"$ne": True}}

        if start_date or end_date:
            range_expr = build_calendar_date_expr(start_date, end_date)
            if range_expr:
                query["$expr"] = range_expr

        # Vehicle filter
        imei_filter = filters.get("imei")
        if imei_filter:
            query["imei"] = imei_filter

        def _parse_number(value):
            if value is None or value == "":
                return None
            try:
                return float(value)
            except (TypeError, ValueError):
                return None

        # Numeric filters
        def _apply_range(field: str, min_val, max_val):
            if min_val is None and max_val is None:
                return
            range_query = {}
            if min_val is not None:
                range_query["$gte"] = min_val
            if max_val is not None:
                range_query["$lte"] = max_val
            if range_query:
                query[field] = range_query

        _apply_range(
            "distance",
            _parse_number(filters.get("distance_min")),
            _parse_number(filters.get("distance_max")),
        )
        _apply_range(
            "maxSpeed",
            _parse_number(filters.get("speed_min")),
            _parse_number(filters.get("speed_max")),
        )
        _apply_range(
            "fuelConsumed",
            _parse_number(filters.get("fuel_min")),
            _parse_number(filters.get("fuel_max")),
        )

        # Presence filters
        if filters.get("has_fuel"):
            existing = query.get("fuelConsumed") or {}
            if not isinstance(existing, dict):
                existing = {}
            existing["$gt"] = 0
            query["fuelConsumed"] = existing

        if search_value:
            search_regex = {"$regex": search_value, "$options": "i"}
            query["$or"] = [
                {"transactionId": search_regex},
                {"imei": search_regex},
                {"startLocation.formatted_address": search_regex},
                {"destination.formatted_address": search_regex},
            ]

        total_count = await trips_collection.count_documents({})
        filtered_count = await trips_collection.count_documents(query)

        sort_column = None
        sort_direction = -1
        if isinstance(order, list) and order and isinstance(columns, list):
            first_order = order[0] if isinstance(order[0], dict) else {}
            column_index = first_order.get("column")
            column_dir = first_order.get("dir", "asc")
            if (
                column_index is not None
                and isinstance(column_index, int)
                and 0 <= column_index < len(columns)
                and isinstance(columns[column_index], dict)
            ):
                sort_column = columns[column_index].get("data")
                sort_direction = -1 if column_dir == "desc" else 1

        if not sort_column:
            sort_column = "startTime"
            sort_direction = -1
        elif sort_column == "vehicleLabel":
            # Sort by IMEI to approximate vehicle ordering
            sort_column = "imei"

        if sort_column == "duration":
            pipeline = [
                {"$match": query},
                {"$addFields": {"duration": {"$subtract": ["$endTime", "$startTime"]}}},
                {"$sort": {"duration": sort_direction}},
                {"$skip": start},
                {"$limit": length},
            ]
            trips_list = await trips_collection.aggregate(pipeline).to_list(
                length=length
            )
        else:
            cursor = (
                trips_collection.find(query)
                .sort([(sort_column, sort_direction)])
                .skip(start)
                .limit(length)
            )
            trips_list = await cursor.to_list(length=length)

        formatted_data = []
        for trip in trips_list:
            start_time = parse_timestamp(trip.get("startTime"))
            end_time = parse_timestamp(trip.get("endTime"))
            duration = (
                (end_time - start_time).total_seconds()
                if start_time and end_time
                else None
            )

            imei = trip.get("imei", "")
            start_location = trip.get("startLocation", "Unknown")
            if isinstance(start_location, dict):
                start_location = start_location.get("formatted_address", "Unknown")

            destination = trip.get("destination", "Unknown")
            if isinstance(destination, dict):
                destination = destination.get("formatted_address", "Unknown")

            # Import here to avoid circular dependency
            from trips.services.trip_cost_service import TripCostService

            formatted_trip = {
                "transactionId": trip.get("transactionId", ""),
                "imei": imei,
                "startTime": start_time.isoformat() if start_time else None,
                "endTime": end_time.isoformat() if end_time else None,
                "duration": duration,
                "distance": _safe_float(trip.get("distance"), 0),
                "startLocation": start_location,
                "destination": destination,
                "maxSpeed": _safe_float(trip.get("maxSpeed"), 0),
                "totalIdleDuration": trip.get("totalIdleDuration", 0),
                "fuelConsumed": _safe_float(trip.get("fuelConsumed"), 0),
                "estimated_cost": TripCostService.calculate_trip_cost(trip, price_map),
            }
            formatted_data.append(formatted_trip)

        # Enrich with vehicle metadata if available
        imeis = {trip.get("imei") for trip in formatted_data if trip.get("imei")}
        vehicle_map: dict[str, dict] = {}
        if imeis:
            vehicles = await vehicles_collection.find(
                {"imei": {"$in": list(imeis)}}
            ).to_list(None)
            for vehicle in vehicles:
                vehicle_map[vehicle.get("imei")] = vehicle

        for trip in formatted_data:
            imei = trip.get("imei")
            vehicle = vehicle_map.get(imei) if imei else None
            vin = vehicle.get("vin") if vehicle else None
            custom_name = vehicle.get("custom_name") if vehicle else None
            make = (vehicle or {}).get("make")
            model = (vehicle or {}).get("model")
            year = (vehicle or {}).get("year")

            if custom_name:
                vehicle_label = custom_name
            elif make or model or year:
                vehicle_label = " ".join(
                    str(part) for part in [year, make, model] if part
                ).strip()
            elif vin:
                vehicle_label = f"VIN {vin}"
            elif imei:
                vehicle_label = f"IMEI {imei}"
            else:
                vehicle_label = "Unknown vehicle"

            trip["vehicleLabel"] = vehicle_label
            trip["vin"] = vin

        return {
            "draw": draw,
            "recordsTotal": total_count,
            "recordsFiltered": filtered_count,
            "data": formatted_data,
        }

    @staticmethod
    async def get_invalid_trips():
        """Get all invalid trips for review.

        Returns:
            dict with status, trips list, and count
        """
        from db import serialize_document

        cursor = trips_collection.find(
            {"invalid": True},
            {
                "transactionId": 1,
                "startTime": 1,
                "endTime": 1,
                "distance": 1,
                "validation_message": 1,
                "source": 1,
                "validated_at": 1,
            },
        ).sort("validated_at", -1)

        trips = await cursor.to_list(length=1000)
        return {
            "status": "success",
            "trips": [serialize_document(t) for t in trips],
            "count": len(trips),
        }

    @staticmethod
    async def get_trips_in_bounds(
        min_lat: float, min_lon: float, max_lat: float, max_lon: float
    ):
        """Get trip coordinates within a given bounding box.

        Args:
            min_lat: Minimum latitude
            min_lon: Minimum longitude
            max_lat: Maximum latitude
            max_lon: Maximum longitude

        Returns:
            GeoJSON FeatureCollection
        """
        if not GeometryService.validate_bounding_box(
            min_lat,
            min_lon,
            max_lat,
            max_lon,
        ):
            raise ValueError(
                "Invalid bounding box coordinates (lat must be -90 to 90, lon -180 to 180)."
            )

        bounding_box_geometry = GeometryService.bounding_box_polygon(
            min_lat,
            min_lon,
            max_lat,
            max_lon,
        )
        if bounding_box_geometry is None:
            raise ValueError("Invalid bounding box coordinates.")

        query = {
            "matchedGps": {
                "$geoIntersects": {
                    "$geometry": bounding_box_geometry,
                },
            },
            "invalid": {"$ne": True},
        }

        projection = {
            "_id": 0,
            "matchedGps.coordinates": 1,
            "transactionId": 1,
        }

        cursor = trips_collection.find(query, projection)

        trip_features = []
        async for trip_doc in cursor:
            if trip_doc.get("matchedGps") and trip_doc["matchedGps"].get("coordinates"):
                coords = trip_doc["matchedGps"]["coordinates"]
                geometry = GeometryService.geometry_from_coordinate_pairs(
                    coords,
                    allow_point=False,
                    dedupe=False,
                    validate=False,
                )
                if geometry is not None:
                    feature = GeometryService.feature_from_geometry(
                        geometry,
                        properties={
                            "transactionId": trip_doc.get("transactionId", "N/A")
                        },
                    )
                    trip_features.append(feature)

        return GeometryService.feature_collection(trip_features)
