"""Business logic for trip querying and filtering."""

import logging
from typing import Any

from beanie.operators import In

from core.casting import safe_float
from core.date_utils import parse_timestamp
from core.spatial import GeometryService
from db import build_calendar_date_expr
from db.aggregation import aggregate_to_list
from db.models import Trip, Vehicle

logger = logging.getLogger(__name__)


def _extract_preview_geometry(trip_dict: dict[str, Any]) -> dict[str, Any] | None:
    geom = GeometryService.parse_geojson(
        trip_dict.get("matchedGps") or trip_dict.get("gps"),
    )
    if geom:
        return geom

    coords = trip_dict.get("coordinates")
    if isinstance(coords, list):
        return GeometryService.geometry_from_coordinate_dicts(coords)

    return None


def _build_preview_path(
    trip_dict: dict[str, Any],
    *,
    width: float = 100.0,
    height: float = 40.0,
    padding: float = 4.0,
    max_points: int = 64,
) -> str | None:
    geom = _extract_preview_geometry(trip_dict)
    if not geom:
        return None

    coords = geom.get("coordinates")
    if not isinstance(coords, list) or not coords:
        return None

    raw_coords: list[Any] = []
    if geom.get("type") == "LineString":
        raw_coords = coords
    elif geom.get("type") == "MultiLineString":
        for line in coords:
            if isinstance(line, list):
                raw_coords.extend(line)
    else:
        return None

    cleaned: list[list[float]] = []
    for coord in raw_coords:
        valid, pair = GeometryService.validate_coordinate_pair(coord)
        if valid and pair:
            cleaned.append(pair)

    if len(cleaned) < 2:
        return None

    if len(cleaned) > max_points:
        step = max(1, len(cleaned) // max_points)
        sampled = cleaned[::step]
        if sampled[-1] != cleaned[-1]:
            sampled.append(cleaned[-1])
        cleaned = sampled

    lons = [pt[0] for pt in cleaned]
    lats = [pt[1] for pt in cleaned]
    min_lon = min(lons)
    max_lon = max(lons)
    min_lat = min(lats)
    max_lat = max(lats)

    if min_lon == max_lon:
        min_lon -= 0.0001
        max_lon += 0.0001
    if min_lat == max_lat:
        min_lat -= 0.0001
        max_lat += 0.0001

    span_lon = max_lon - min_lon
    span_lat = max_lat - min_lat
    if span_lon <= 0 or span_lat <= 0:
        return None

    scale_x = (width - (padding * 2)) / span_lon
    scale_y = (height - (padding * 2)) / span_lat

    def project(coord: list[float]) -> tuple[float, float]:
        x = padding + (coord[0] - min_lon) * scale_x
        y = padding + (max_lat - coord[1]) * scale_y
        return x, y

    points = [project(coord) for coord in cleaned]
    path_parts = [f"M {points[0][0]:.1f},{points[0][1]:.1f}"]
    path_parts.extend(f"L {x:.1f},{y:.1f}" for x, y in points[1:])
    return " ".join(path_parts)


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
        """
        Get trips data formatted for DataTables server-side processing.

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

        base_query = {"invalid": {"$ne": True}}
        query = dict(base_query)

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
        def _apply_range(field: str, min_val, max_val) -> None:
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

        # Use Beanie count methods
        total_count = await Trip.find(base_query).count()
        filtered_count = await Trip.find(query).count()

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

        # Determine if we need to use aggregation for sorting
        use_aggregation = False
        pipeline = [{"$match": query}]

        if sort_column == "vehicleLabel":
            use_aggregation = True
            # Join with vehicles to get the label
            pipeline.extend(
                [
                    {
                        "$lookup": {
                            "from": "vehicles",
                            "localField": "imei",
                            "foreignField": "imei",
                            "as": "vehicle_docs",
                        },
                    },
                    {
                        "$addFields": {
                            "vehicle_doc": {"$arrayElemAt": ["$vehicle_docs", 0]},
                        },
                    },
                    {
                        "$addFields": {
                            "vehicleLabelSort": {
                                "$cond": {
                                    "if": {
                                        "$ifNull": ["$vehicle_doc.custom_name", False],
                                    },
                                    "then": "$vehicle_doc.custom_name",
                                    "else": {
                                        "$cond": {
                                            "if": {
                                                "$or": [
                                                    {
                                                        "$ifNull": [
                                                            "$vehicle_doc.make",
                                                            False,
                                                        ],
                                                    },
                                                    {
                                                        "$ifNull": [
                                                            "$vehicle_doc.model",
                                                            False,
                                                        ],
                                                    },
                                                ],
                                            },
                                            "then": {
                                                "$concat": [
                                                    {
                                                        "$ifNull": [
                                                            {
                                                                "$toString": "$vehicle_doc.year",
                                                            },
                                                            "",
                                                        ],
                                                    },
                                                    " ",
                                                    {
                                                        "$ifNull": [
                                                            "$vehicle_doc.make",
                                                            "",
                                                        ],
                                                    },
                                                    " ",
                                                    {
                                                        "$ifNull": [
                                                            "$vehicle_doc.model",
                                                            "",
                                                        ],
                                                    },
                                                ],
                                            },
                                            "else": {
                                                "$ifNull": [
                                                    "$vehicle_doc.vin",
                                                    "$imei",
                                                ],
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    {"$sort": {"vehicleLabelSort": sort_direction, "startTime": -1}},
                ],
            )

        elif sort_column == "duration":
            use_aggregation = True
            pipeline.extend(
                [
                    {
                        "$addFields": {
                            "duration": {"$subtract": ["$endTime", "$startTime"]},
                        },
                    },
                    {"$sort": {"duration": sort_direction, "startTime": -1}},
                ],
            )

        elif sort_column in ["distance", "maxSpeed", "fuelConsumed"]:
            use_aggregation = True
            pipeline.extend(
                [
                    {
                        "$addFields": {
                            "sortVal": {
                                "$switch": {
                                    "branches": [
                                        {
                                            "case": {
                                                "$eq": [
                                                    {"$type": f"${sort_column}"},
                                                    "string",
                                                ],
                                            },
                                            "then": {"$toDouble": f"${sort_column}"},
                                        },
                                        {
                                            "case": {
                                                "$eq": [
                                                    {"$type": f"${sort_column}"},
                                                    "missing",
                                                ],
                                            },
                                            "then": 0,
                                        },
                                        {
                                            "case": {"$eq": [f"${sort_column}", None]},
                                            "then": 0,
                                        },
                                    ],
                                    "default": f"${sort_column}",
                                },
                            },
                        },
                    },
                    {"$sort": {"sortVal": sort_direction, "startTime": -1}},
                ],
            )

        if use_aggregation:
            pipeline.extend(
                [
                    {"$skip": start},
                    {"$limit": length},
                ],
            )
            trips_list = await aggregate_to_list(Trip, pipeline)
        else:
            # Use Beanie query builder for standard sorts
            trips_query = Trip.find(query)
            if sort_column == "vehicleLabel":
                # Fallback if somehow we get here without aggregation logic (pre-refactor safety)
                sort_column = "imei"

            if sort_direction == -1:
                trips_query = trips_query.sort(f"-{sort_column}")
            else:
                trips_query = trips_query.sort(sort_column)
            trips_list = await trips_query.skip(start).limit(length).to_list()

        formatted_data = []
        for trip in trips_list:
            # Handle both Beanie models and aggregation dicts
            trip_dict = trip.model_dump() if isinstance(trip, Trip) else trip

            start_time = parse_timestamp(trip_dict.get("startTime"))
            end_time = parse_timestamp(trip_dict.get("endTime"))
            duration = (
                (end_time - start_time).total_seconds()
                if start_time and end_time
                else None
            )

            imei = trip_dict.get("imei", "")
            start_location = trip_dict.get("startLocation", "Unknown")
            if isinstance(start_location, dict):
                start_location = start_location.get("formatted_address", "Unknown")

            destination = trip_dict.get("destination", "Unknown")
            if isinstance(destination, dict):
                destination = destination.get("formatted_address", "Unknown")

            # Import here to avoid circular dependency
            from trips.services.trip_cost_service import TripCostService

            total_idle_duration = trip_dict.get("totalIdleDuration")
            if total_idle_duration is None:
                total_idle_duration = trip_dict.get("totalIdlingTime", 0)

            formatted_trip = {
                "transactionId": trip_dict.get("transactionId", ""),
                "imei": imei,
                "startTime": start_time.isoformat() if start_time else None,
                "endTime": end_time.isoformat() if end_time else None,
                "duration": duration,
                "distance": safe_float(trip_dict.get("distance"), 0),
                "startLocation": start_location,
                "destination": destination,
                "maxSpeed": safe_float(trip_dict.get("maxSpeed"), 0),
                "totalIdleDuration": total_idle_duration,
                "fuelConsumed": safe_float(trip_dict.get("fuelConsumed"), 0),
                "estimated_cost": TripCostService.calculate_trip_cost(
                    trip_dict,
                    price_map,
                ),
                "previewPath": _build_preview_path(trip_dict),
            }
            formatted_data.append(formatted_trip)

        # Enrich with vehicle metadata if available
        imeis = {trip.get("imei") for trip in formatted_data if trip.get("imei")}
        vehicle_map: dict[str, dict] = {}
        if imeis:
            vehicles = await Vehicle.find(In(Vehicle.imei, list(imeis))).to_list()
            for vehicle in vehicles:
                vehicle_map[vehicle.imei] = vehicle.model_dump()

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
        """
        Get all invalid trips for review.

        Returns:
            dict with status, trips list, and count
        """
        # Use Beanie projection
        trips = (
            await Trip.find(
                Trip.invalid == True,  # noqa: E712
                projection_model=None,  # Use dict projection
            )
            .sort(-Trip.validated_at)
            .limit(1000)
            .to_list()
        )

        # Convert Beanie models to dicts for response
        trips_data = []
        for trip in trips:
            if isinstance(trip, Trip):
                trip_id = str(trip.id)
                data = trip.model_dump()
            else:
                trip_id = str(trip.get("_id"))
                data = trip

            trip_dict = {
                "id": trip_id,
                "transaction_id": data.get("transactionId"),
                "start_time": data.get("startTime"),
                "end_time": data.get("endTime"),
                "distance": data.get("distance"),
                "invalidation_reason": data.get("validation_message"),
                "source": data.get("source"),
                "validated_at": data.get("validated_at"),
            }
            trips_data.append(trip_dict)

        return {
            "status": "success",
            "trips": trips_data,
            "count": len(trips_data),
        }
