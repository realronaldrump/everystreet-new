# trips.py

import json
import logging
import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from db import (
    SerializationHelper,
    build_query_from_request,
    delete_many_with_retry,
    delete_one_with_retry,
    find_with_retry,
    get_trip_by_id,
    matched_trips_collection,
    trips_collection,
)
from trip_service import TripService

# ==============================================================================
# Setup
# ==============================================================================

logger = logging.getLogger(__name__)
router = APIRouter()
templates = Jinja2Templates(directory="templates")

MAPBOX_ACCESS_TOKEN = os.getenv("MAPBOX_ACCESS_TOKEN", "")

# Initialize TripService
trip_service = TripService(MAPBOX_ACCESS_TOKEN)

# ==============================================================================
# Pydantic Models for this file
# ==============================================================================


class TripUpdateRequest(BaseModel):
    """A flexible model to handle trip updates from different parts of the UI."""

    geometry: dict | None = None
    properties: dict | None = None

    class Config:
        extra = "allow"


# ==============================================================================
# Page Rendering
# ==============================================================================


@router.get("/trips", response_class=HTMLResponse, tags=["Pages"])
async def trips_page(request: Request):
    """Render the main trips data table page."""
    return templates.TemplateResponse("trips.html", {"request": request})


# ==============================================================================
# API Endpoints
# ==============================================================================


@router.get("/api/trips", tags=["Trips API"])
async def get_trips(request: Request):
    """Stream all trips as GeoJSON to improve performance."""
    query = await build_query_from_request(request)
    projection = {
        "gps": 1,
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
        trips_collection.find(query, projection).sort("endTime", -1).batch_size(500)
    )

    async def stream():
        yield '{"type":"FeatureCollection","features":['
        first = True
        async for trip in cursor:
            st = trip.get("startTime")
            et = trip.get("endTime")
            duration = (et - st).total_seconds() if st and et else None
            geom = trip.get("gps")
            num_points = (
                len(geom.get("coordinates", []))
                if isinstance(geom, dict) and isinstance(geom.get("coordinates"), list)
                else 0
            )
            props = {
                "transactionId": trip.get("transactionId"),
                "imei": trip.get("imei"),
                "startTime": st.isoformat() if hasattr(st, "isoformat") else None,
                "endTime": et.isoformat() if hasattr(et, "isoformat") else None,
                "duration": duration,
                "distance": float(trip.get("distance", 0)),
                "maxSpeed": float(trip.get("maxSpeed", 0)),
                "timeZone": trip.get("timeZone"),
                "startLocation": trip.get("startLocation"),
                "destination": trip.get("destination"),
                "totalIdleDuration": trip.get("totalIdleDuration"),
                "fuelConsumed": float(trip.get("fuelConsumed", 0)),
                "source": trip.get("source"),
                "hardBrakingCount": trip.get("hardBrakingCount"),
                "hardAccelerationCount": trip.get("hardAccelerationCount"),
                "startOdometer": trip.get("startOdometer"),
                "endOdometer": trip.get("endOdometer"),
                "averageSpeed": trip.get("averageSpeed"),
                "pointsRecorded": num_points,
            }
            feature = {
                "type": "Feature",
                "geometry": geom,
                "properties": props,
            }
            chunk = json.dumps(
                feature,
                separators=(",", ":"),
                default=lambda o: o.isoformat() if hasattr(o, "isoformat") else str(o),
            )
            if not first:
                yield ","
            yield chunk
            first = False
        yield "]}"

    return StreamingResponse(stream(), media_type="application/geo+json")


@router.post("/api/trips/datatable", tags=["Trips API"])
async def get_trips_datatable(request: Request):
    """Get trips data formatted for DataTables server-side processing."""
    try:
        body = await request.json()
        draw = body.get("draw", 1)
        start = body.get("start", 0)
        length = body.get("length", 10)
        search_value = body.get("search", {}).get("value", "")
        order = body.get("order", [])
        columns = body.get("columns", [])
        start_date = body.get("start_date")
        end_date = body.get("end_date")

        # ------------------------------------------------------------------
        # Date filtering – use **each trip's own time zone**
        # ------------------------------------------------------------------
        # The client sends calendar dates (YYYY-MM-DD). We need trips whose
        # local start date – when converted to that trip's timeZone field –
        # falls inside the selected range.  We can do this entirely inside
        # MongoDB using a $dateToString+$expr filter so there is no Python-side
        # timezone math and no helper utilities.

        query = {}

        if start_date or end_date:
            # Build an expression that converts startTime to the trip's local
            # calendar date string ("YYYY-MM-DD") using the timeZone stored on
            # the document (or UTC if missing) and then compares that string
            # to the supplied start/end date strings.
            tz_expr = {
                "$switch": {
                    "branches": [
                        {
                            "case": {"$in": ["$timeZone", ["", "0000"]]},
                            "then": "UTC",
                        }
                    ],
                    "default": {"$ifNull": ["$timeZone", "UTC"]},
                }
            }

            date_expr = {
                "$dateToString": {
                    "format": "%Y-%m-%d",
                    "date": "$startTime",
                    "timezone": tz_expr,
                }
            }

            expr_clauses = []
            if start_date:
                expr_clauses.append({"$gte": [date_expr, start_date]})
            if end_date:
                expr_clauses.append({"$lte": [date_expr, end_date]})

            if expr_clauses:
                query["$expr"] = (
                    {"$and": expr_clauses} if len(expr_clauses) > 1 else expr_clauses[0]
                )

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

        sort_params = []
        if order and columns:
            column_index = order[0].get("column")
            column_dir = order[0].get("dir", "asc")
            if column_index is not None and column_index < len(columns):
                column_name = columns[column_index].get("data")
                if column_name:
                    sort_params.append((column_name, -1 if column_dir == "desc" else 1))

        if not sort_params:
            sort_params = [("startTime", -1)]

        cursor = (
            trips_collection.find(query).sort(sort_params).skip(start).limit(length)
        )
        trips_list = await cursor.to_list(length=length)

        formatted_data = []
        for trip in trips_list:
            start_time = trip.get("startTime")
            end_time = trip.get("endTime")
            duration = (
                (end_time - start_time).total_seconds()
                if start_time and end_time
                else None
            )

            start_location = trip.get("startLocation", "Unknown")
            if isinstance(start_location, dict):
                start_location = start_location.get("formatted_address", "Unknown")

            destination = trip.get("destination", "Unknown")
            if isinstance(destination, dict):
                destination = destination.get("formatted_address", "Unknown")

            formatted_trip = {
                "transactionId": trip.get("transactionId", ""),
                "imei": trip.get("imei", ""),
                "startTime": SerializationHelper.serialize_datetime(start_time),
                "endTime": SerializationHelper.serialize_datetime(end_time),
                "duration": duration,
                "distance": float(trip.get("distance", 0)),
                "startLocation": start_location,
                "destination": destination,
                "maxSpeed": float(trip.get("maxSpeed", 0)),
                "totalIdleDuration": trip.get("totalIdleDuration", 0),
                "fuelConsumed": float(trip.get("fuelConsumed", 0)),
            }
            formatted_data.append(formatted_trip)

        return {
            "draw": draw,
            "recordsTotal": total_count,
            "recordsFiltered": filtered_count,
            "data": formatted_data,
        }
    except Exception as e:
        logger.exception("Error in get_trips_datatable: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.post("/api/trips/bulk_delete", tags=["Trips API"])
async def bulk_delete_trips(request: Request):
    """Bulk delete trips by their transaction IDs."""
    try:
        body = await request.json()
        trip_ids = body.get("trip_ids", [])
        if not trip_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="No trip IDs provided"
            )

        result = await delete_many_with_retry(
            trips_collection, {"transactionId": {"$in": trip_ids}}
        )
        matched_result = await delete_many_with_retry(
            matched_trips_collection, {"transactionId": {"$in": trip_ids}}
        )

        return {
            "status": "success",
            "deleted_trips": result.deleted_count,
            "deleted_matched_trips": matched_result.deleted_count,
            "message": f"Deleted {result.deleted_count} trips and {matched_result.deleted_count} matched trips",
        }
    except Exception as e:
        logger.exception("Error in bulk_delete_trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.get("/api/trips/{trip_id}", tags=["Trips API"])
async def get_single_trip(trip_id: str):
    """Get a single trip by its transaction ID."""
    try:
        trip = await get_trip_by_id(trip_id, trips_collection)
        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found"
            )
        return {
            "status": "success",
            "trip": SerializationHelper.serialize_trip(trip),
        }
    except Exception as e:
        logger.exception("get_single_trip error: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error",
        )


@router.delete("/api/trips/{trip_id}", tags=["Trips API"])
async def delete_trip(trip_id: str):
    """Delete a trip by its transaction ID."""
    try:
        trip = await get_trip_by_id(trip_id, trips_collection)
        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found"
            )

        result = await delete_one_with_retry(trips_collection, {"_id": trip["_id"]})

        actual_transaction_id = trip.get("transactionId")
        matched_delete_result = None
        if actual_transaction_id:
            matched_delete_result = await delete_one_with_retry(
                matched_trips_collection, {"transactionId": actual_transaction_id}
            )

        if result.deleted_count >= 1:
            return {
                "status": "success",
                "message": "Trip deleted successfully",
                "deleted_trips": result.deleted_count,
                "deleted_matched_trips": (
                    matched_delete_result.deleted_count if matched_delete_result else 0
                ),
            }

        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete trip after finding it.",
        )
    except Exception as e:
        logger.exception("Error deleting trip: %s", str(e))
        if isinstance(e, HTTPException):
            raise
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error",
        )


@router.put("/api/trips/{trip_id}", tags=["Trips API"])
async def update_trip(trip_id: str, update_data: TripUpdateRequest):
    """Update a trip's details, such as its geometry or properties."""
    try:
        trip_to_update = await get_trip_by_id(trip_id, trips_collection)
        if not trip_to_update:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found"
            )

        update_payload = {}
        if update_data.geometry:
            update_payload["gps"] = update_data.geometry

        if update_data.properties:
            for key, value in update_data.properties.items():
                if key not in [
                    "_id",
                    "transactionId",
                ]:  # Avoid updating immutable fields
                    update_payload[key] = value

        if not update_payload:
            return {"status": "no_change", "message": "No data provided to update."}

        update_payload["last_modified"] = datetime.now(timezone.utc)

        result = await trips_collection.update_one(
            {"transactionId": trip_id}, {"$set": update_payload}
        )

        if result.modified_count > 0:
            return {"status": "success", "message": "Trip updated successfully."}

        return {"status": "no_change", "message": "Trip data was already up-to-date."}

    except Exception as e:
        logger.exception("Error updating trip %s: %s", trip_id, str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update trip: {str(e)}",
        )


@router.post("/api/regeocode_all_trips", tags=["Trips API"])
async def regeocode_all_trips():
    """Re-run geocoding for all trips to check against custom places."""
    try:
        trips_list = await find_with_retry(trips_collection, {})
        trip_ids = [
            trip.get("transactionId")
            for trip in trips_list
            if trip.get("transactionId")
        ]

        result = await trip_service.refresh_geocoding(trip_ids)

        return {
            "message": f"Re-geocoded {result['updated']} trips successfully. Failed: {result['failed']}",
            "updated_count": result["updated"],
            "failed_count": result["failed"],
        }
    except Exception as e:
        logger.exception("Error in regeocode_all_trips: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error re-geocoding trips: {e}",
        )


@router.post("/api/trips/{trip_id}/regeocode", tags=["Trips API"])
async def regeocode_single_trip(trip_id: str):
    """Re-run geocoding for a single trip. Used by the Trips UI when a user clicks
    the per-trip "Refresh Geocoding" button so the trip is re-evaluated against
    any newly-created custom places.
    """
    try:
        trip = await trip_service.get_trip_by_id(trip_id)
        if not trip:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Trip not found",
            )

        result = await trip_service.refresh_geocoding([trip_id])

        if result["updated"] > 0:
            return {
                "status": "success",
                "message": f"Trip {trip_id} re-geocoded successfully.",
            }
        else:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to re-geocode trip {trip_id}. Check logs for details.",
            )
    except HTTPException:
        raise  # Bubble up intact so FastAPI handles
    except Exception as e:
        logger.exception("Error in regeocode_single_trip: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Error re-geocoding trip {trip_id}: {e}",
        )
