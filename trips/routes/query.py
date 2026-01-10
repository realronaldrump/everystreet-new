"""API routes for trip querying and filtering."""

import logging

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from core.api import api_route
from date_utils import parse_timestamp
from db import build_query_from_request, json_dumps, trips_collection
from geometry_service import GeometryService
from trips.serializers import _safe_float, _safe_int
from trips.services import TripCostService, TripQueryService

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/trips", tags=["Trips API"])
async def get_trips(request: Request):
    """Stream all trips as GeoJSON to improve performance."""
    query = await build_query_from_request(request)
    matched_only = request.query_params.get("matched_only", "false").lower() == "true"

    # Exclude invalid trips by default
    query["invalid"] = {"$ne": True}

    if matched_only:
        query["matchedGps"] = {"$ne": None}
    projection = {
        "gps": 1,
        "matchedGps": 1,
        "matchStatus": 1,
        "startTime": 1,
        "endTime": 1,
        "distance": 1,
        "maxSpeed": 1,
        "transactionId": 1,
        "imei": 1,
        "startLocation": 1,
        "destination": 1,
        "totalIdleDuration": 1,
        "fuelConsumed": 1,
        "source": 1,
        "hardBrakingCount": 1,
        "hardAccelerationCount": 1,
        "startOdometer": 1,
        "endOdometer": 1,
        "averageSpeed": 1,
    }
    cursor = (
        trips_collection.find(query, projection).sort("endTime", -1).batch_size(1000)
    )

    # Pre-fetch has prices for cost calculation
    price_map = await TripCostService.get_fillup_price_map()

    async def stream():
        yield '{"type":"FeatureCollection","features":['
        first = True
        async for trip in cursor:
            st = parse_timestamp(trip.get("startTime"))
            et = parse_timestamp(trip.get("endTime"))
            duration = (et - st).total_seconds() if st and et else None

            geom = GeometryService.parse_geojson(trip.get("gps"))
            matched_geom = GeometryService.parse_geojson(trip.get("matchedGps"))

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
            props = {
                "transactionId": trip.get("transactionId"),
                "imei": trip.get("imei"),
                "startTime": st.isoformat() if st else None,
                "endTime": et.isoformat() if et else None,
                "duration": duration,
                "distance": _safe_float(trip.get("distance"), 0),
                "maxSpeed": _safe_float(trip.get("maxSpeed"), 0),
                "timeZone": trip.get("timeZone"),
                "startLocation": trip.get("startLocation"),
                "destination": trip.get("destination"),
                "totalIdleDuration": trip.get("totalIdleDuration"),
                "fuelConsumed": _safe_float(trip.get("fuelConsumed"), 0),
                "source": trip.get("source"),
                "hardBrakingCount": trip.get("hardBrakingCount"),
                "hardAccelerationCount": trip.get("hardAccelerationCount"),
                "startOdometer": trip.get("startOdometer"),
                "endOdometer": trip.get("endOdometer"),
                "averageSpeed": trip.get("averageSpeed"),
                "pointsRecorded": num_points,
                "estimated_cost": TripCostService.calculate_trip_cost(trip, price_map),
                "matchedGps": matched_geom,
                "matchStatus": trip.get("matchStatus"),
            }
            feature = GeometryService.feature_from_geometry(final_geom, props)
            chunk = json_dumps(feature, separators=(",", ":"))
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
    except Exception as exc:  # noqa: BLE001
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

    result = await TripQueryService.get_trips_datatable(
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

    return result


@router.get("/api/trips/invalid", tags=["Trips API"])
@api_route(logger)
async def get_invalid_trips():
    """Get all invalid trips for review."""
    return await TripQueryService.get_invalid_trips()
