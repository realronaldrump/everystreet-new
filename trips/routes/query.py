"""API routes for trip querying and filtering."""

import json
import logging

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from core.api import api_route
from core.date_utils import parse_timestamp
from db import build_query_from_request
from db.models import Trip
from geo_service.geometry import GeometryService
from trips.services import TripCostService, TripQueryService


def _safe_float(value, default: float = 0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_int(value, default: int = 0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/matched_trips", tags=["Trips API"])
async def get_matched_trips(request: Request):
    """
    Stream matched trips as GeoJSON.

    Returns trips that have matchedGps data, using the matched geometry
    as the primary geometry for each feature.
    """
    query = await build_query_from_request(request)

    # Only include trips with matched GPS data
    query["matchedGps"] = {"$ne": None}
    # Exclude invalid trips
    query["invalid"] = {"$ne": True}

    trip_cursor = Trip.find(query).sort(-Trip.endTime)

    # Pre-fetch gas prices for cost calculation
    price_map = await TripCostService.get_fillup_price_map()

    async def stream():
        yield '{"type":"FeatureCollection","features":['
        first = True
        async for trip in trip_cursor:
            trip_dict = trip.model_dump() if isinstance(trip, Trip) else trip
            st = parse_timestamp(trip_dict.get("startTime"))
            et = parse_timestamp(trip_dict.get("endTime"))
            duration = (et - st).total_seconds() if st and et else None

            matched_geom = GeometryService.parse_geojson(trip_dict.get("matchedGps"))
            if not matched_geom:
                continue  # Skip trips without valid matched geometry

            coords = matched_geom.get("coordinates", []) if matched_geom else []
            num_points = len(coords) if isinstance(coords, list) else 0

            props = {
                "transactionId": trip_dict.get("transactionId"),
                "imei": trip_dict.get("imei"),
                "startTime": st.isoformat() if st else None,
                "endTime": et.isoformat() if et else None,
                "duration": duration,
                "distance": _safe_float(trip_dict.get("distance"), 0),
                "maxSpeed": _safe_float(trip_dict.get("maxSpeed"), 0),
                "startLocation": trip_dict.get("startLocation"),
                "destination": trip_dict.get("destination"),
                "fuelConsumed": _safe_float(trip_dict.get("fuelConsumed"), 0),
                "source": trip_dict.get("source"),
                "pointsRecorded": num_points,
                "estimated_cost": TripCostService.calculate_trip_cost(
                    trip_dict,
                    price_map,
                ),
                "matchStatus": trip_dict.get("matchStatus"),
                "matched_at": (
                    trip_dict.get("matched_at").isoformat()
                    if trip_dict.get("matched_at")
                    else None
                ),
            }
            feature = GeometryService.feature_from_geometry(matched_geom, props)
            chunk = json.dumps(feature, separators=(",", ":"))
            if not first:
                yield ","
            yield chunk
            first = False
        yield "]}"

    return StreamingResponse(stream(), media_type="application/geo+json")


@router.get("/api/trips", tags=["Trips API"])
async def get_trips(request: Request):
    """Stream all trips as GeoJSON to improve performance."""
    query = await build_query_from_request(request)
    matched_only = request.query_params.get("matched_only", "false").lower() == "true"

    # Exclude invalid trips by default
    query["invalid"] = {"$ne": True}

    if matched_only:
        query["matchedGps"] = {"$ne": None}
    # Use Beanie cursor iteration
    trip_cursor = Trip.find(query).sort(-Trip.endTime)

    # Pre-fetch gas prices for cost calculation
    price_map = await TripCostService.get_fillup_price_map()

    async def stream():
        yield '{"type":"FeatureCollection","features":['
        first = True
        async for trip in trip_cursor:
            # Convert Beanie model to dict for processing
            trip_dict = trip.model_dump() if isinstance(trip, Trip) else trip
            st = parse_timestamp(trip_dict.get("startTime"))
            et = parse_timestamp(trip_dict.get("endTime"))
            duration = (et - st).total_seconds() if st and et else None

            geom = GeometryService.parse_geojson(trip_dict.get("gps"))
            matched_geom = GeometryService.parse_geojson(trip_dict.get("matchedGps"))

            # Use matched geometry as the main feature geometry if requested
            final_geom = geom
            if matched_only and matched_geom:
                final_geom = matched_geom

            coords = (
                final_geom.get("coordinates", [])
                if isinstance(final_geom, dict)
                else []
            )
            num_points = len(coords) if isinstance(coords, list) else 0
            total_idle_duration = trip_dict.get("totalIdleDuration")
            if total_idle_duration is None:
                total_idle_duration = trip_dict.get("totalIdlingTime")
            avg_speed = trip_dict.get("averageSpeed")
            if avg_speed is None:
                avg_speed = trip_dict.get("avgSpeed")

            props = {
                "transactionId": trip_dict.get("transactionId"),
                "imei": trip_dict.get("imei"),
                "startTime": st.isoformat() if st else None,
                "endTime": et.isoformat() if et else None,
                "duration": duration,
                "distance": _safe_float(trip_dict.get("distance"), 0),
                "maxSpeed": _safe_float(trip_dict.get("maxSpeed"), 0),
                "timeZone": trip_dict.get("timeZone"),
                "startLocation": trip_dict.get("startLocation"),
                "destination": trip_dict.get("destination"),
                "totalIdleDuration": total_idle_duration,
                "fuelConsumed": _safe_float(trip_dict.get("fuelConsumed"), 0),
                "source": trip_dict.get("source"),
                "hardBrakingCount": trip_dict.get("hardBrakingCount"),
                "hardAccelerationCount": trip_dict.get("hardAccelerationCount"),
                "startOdometer": trip_dict.get("startOdometer"),
                "endOdometer": trip_dict.get("endOdometer"),
                "averageSpeed": avg_speed,
                "avgSpeed": avg_speed,
                "pointsRecorded": num_points,
                "estimated_cost": TripCostService.calculate_trip_cost(
                    trip_dict,
                    price_map,
                ),
                "matchedGps": matched_geom,
                "matchStatus": trip_dict.get("matchStatus"),
            }
            feature = GeometryService.feature_from_geometry(final_geom, props)
            # Use standard json.dumps - Beanie models are already serializable
            chunk = json.dumps(feature, separators=(",", ":"))
            if not first:
                yield ","
            yield chunk
            first = False
        yield "]}"

    return StreamingResponse(stream(), media_type="application/geo+json")


@router.post("/api/trips/datatable", tags=["Trips API"])
@api_route(logger)
async def get_trips_datatable(request: Request):
    """Get trips data formatted for DataTables server-side processing."""
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid JSON payload for trips datatable request.",
        ) from exc

    draw = _safe_int(body.get("draw"), 1)
    start = _safe_int(body.get("start"), 0)
    length = _safe_int(body.get("length"), 10)
    search_value = body.get("search", {}).get("value", "")
    order = body.get("order", []) or []
    columns = body.get("columns", []) or []
    filters = body.get("filters", {}) or {}
    start_date = body.get("start_date") or filters.get("start_date")
    end_date = body.get("end_date") or filters.get("end_date")

    # Fetch gas prices for cost calculation
    price_map = await TripCostService.get_fillup_price_map()

    return await TripQueryService.get_trips_datatable(
        draw=draw,
        start=start,
        length=length,
        search_value=search_value,
        order=order,
        columns=columns,
        filters=filters,
        start_date=start_date,
        end_date=end_date,
        price_map=price_map,
    )


@router.get("/api/trips/invalid", tags=["Trips API"])
@api_route(logger)
async def get_invalid_trips():
    """Get all invalid trips for review."""
    return await TripQueryService.get_invalid_trips()
