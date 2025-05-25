"""Route utilities for FastAPI endpoints.

This module contains common patterns, error handlers, and response builders
used across multiple API endpoints to reduce code duplication and improve
maintainability.
"""

import functools
import json
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

import bson
from bson import ObjectId
from fastapi import HTTPException, Request, status
from fastapi.responses import JSONResponse, StreamingResponse

from db import build_query_from_request, find_one_with_retry, optimized_paginate

logger = logging.getLogger(__name__)

# Common error messages
ERROR_MESSAGES = {
    "not_found": "Resource not found",
    "invalid_input": "Invalid input provided",
    "internal_error": "Internal server error",
    "unauthorized": "Unauthorized access",
    "validation_error": "Validation failed",
    "database_error": "Database operation failed",
}

# HTTP status code mappings
STATUS_MAPPINGS = {
    "not_found": status.HTTP_404_NOT_FOUND,
    "invalid_input": status.HTTP_400_BAD_REQUEST,
    "internal_error": status.HTTP_500_INTERNAL_SERVER_ERROR,
    "unauthorized": status.HTTP_401_UNAUTHORIZED,
    "validation_error": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "database_error": status.HTTP_503_SERVICE_UNAVAILABLE,
}


class RouteResponse:
    """Standardized response builder for API endpoints."""

    @staticmethod
    def success(
        data: Any = None,
        message: str = "Success",
        status_code: int = status.HTTP_200_OK,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> JSONResponse:
        """Build a successful response."""
        response_data = {
            "status": "success",
            "message": message,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        if data is not None:
            response_data["data"] = data

        if metadata:
            response_data["metadata"] = metadata

        return JSONResponse(
            content=json.loads(bson.json_util.dumps(response_data)),
            status_code=status_code,
        )

    @staticmethod
    def error(
        error_type: str = "internal_error",
        message: Optional[str] = None,
        details: Optional[str] = None,
        status_code: Optional[int] = None,
    ) -> JSONResponse:
        """Build an error response."""
        response_message = message or ERROR_MESSAGES.get(error_type, "Unknown error")
        response_status = status_code or STATUS_MAPPINGS.get(
            error_type, status.HTTP_500_INTERNAL_SERVER_ERROR
        )

        response_data = {
            "status": "error",
            "error_type": error_type,
            "message": response_message,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        if details:
            response_data["details"] = details

        return JSONResponse(content=response_data, status_code=response_status)

    @staticmethod
    def paginated(
        data: List[Any],
        pagination_info: Dict[str, Any],
        message: str = "Success",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> JSONResponse:
        """Build a paginated response."""
        response_data = {
            "status": "success",
            "message": message,
            "data": data,
            "pagination": pagination_info,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        if metadata:
            response_data["metadata"] = metadata

        return JSONResponse(content=json.loads(bson.json_util.dumps(response_data)))


def handle_exceptions(
    error_mapping: Optional[Dict[type, str]] = None,
    default_error_type: str = "internal_error",
    log_errors: bool = True,
):
    """Decorator for standardized exception handling in route handlers.

    Args:
        error_mapping: Map exception types to error_type strings
        default_error_type: Default error type for unmapped exceptions
        log_errors: Whether to log exceptions
    """

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            try:
                return await func(*args, **kwargs)
            except HTTPException:
                # Re-raise HTTPExceptions as-is
                raise
            except Exception as e:
                if log_errors:
                    logger.exception(f"Error in {func.__name__}: {str(e)}")

                # Map exception to error type
                error_type = default_error_type
                if error_mapping:
                    for exc_type, mapped_error_type in error_mapping.items():
                        if isinstance(e, exc_type):
                            error_type = mapped_error_type
                            break

                raise HTTPException(
                    status_code=STATUS_MAPPINGS.get(
                        error_type, status.HTTP_500_INTERNAL_SERVER_ERROR
                    ),
                    detail=str(e),
                )

        return wrapper

    return decorator


async def validate_location_exists(location_name: str, collection) -> Dict[str, Any]:
    """Validate that a location exists and return its metadata."""
    location_metadata = await find_one_with_retry(
        collection, {"location.display_name": location_name}
    )

    if not location_metadata:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No coverage data found for location: {location_name}",
        )

    return location_metadata


async def build_paginated_query(
    request: Request,
    collection,
    base_query: Optional[Dict[str, Any]] = None,
    default_page: int = 1,
    default_limit: int = 50,
    max_limit: int = 1000,
    sort: Optional[List] = None,
    projection: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build and execute a paginated query from request parameters."""

    # Extract pagination parameters
    page = int(request.query_params.get("page", default_page))
    limit = min(int(request.query_params.get("limit", default_limit)), max_limit)

    # Build query from request
    query = await build_query_from_request(request)
    if base_query:
        query.update(base_query)

    # Execute paginated query
    result = await optimized_paginate(
        collection=collection,
        query=query,
        page=page,
        limit=limit,
        sort=sort,
        projection=projection,
    )

    return result


class StreamingResponseBuilder:
    """Builder for streaming responses with different formats."""

    @staticmethod
    def geojson_stream(features_generator, filename: str = "export.geojson"):
        """Create a streaming GeoJSON response."""

        async def generate():
            yield '{"type": "FeatureCollection", "features": ['
            first = True
            async for feature in features_generator:
                if not first:
                    yield ","
                yield json.dumps(feature, default=str)
                first = False
            yield "]}"

        return StreamingResponse(
            generate(),
            media_type="application/geo+json",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    @staticmethod
    def csv_stream(rows_generator, headers: List[str], filename: str = "export.csv"):
        """Create a streaming CSV response."""

        async def generate():
            # Yield headers
            yield ",".join(headers) + "\n"

            # Yield data rows
            async for row in rows_generator:
                yield ",".join(str(cell) for cell in row) + "\n"

        return StreamingResponse(
            generate(),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )


def optimize_trip_query(
    date_field: str = "startTime",
    include_geometry: bool = True,
    include_metadata: bool = True,
) -> Dict[str, Any]:
    """Build an optimized query projection for trip data."""
    projection = {"_id": 1, "transactionId": 1}

    # Always include time fields
    projection.update({"startTime": 1, "endTime": 1, date_field: 1})

    if include_geometry:
        projection.update({"gps": 1, "startGeoPoint": 1, "destinationGeoPoint": 1})

    if include_metadata:
        projection.update({"distance": 1, "imei": 1, "source": 1, "status": 1})

    return projection


async def get_location_stats(location_name: str, collection) -> Dict[str, Any]:
    """Get aggregated statistics for a location."""
    pipeline = [
        {"$match": {"properties.location": location_name}},
        {
            "$group": {
                "_id": None,
                "total_segments": {"$sum": 1},
                "covered_segments": {
                    "$sum": {"$cond": [{"$eq": ["$properties.driven", True]}, 1, 0]}
                },
                "total_length": {"$sum": "$properties.length_m"},
                "covered_length": {
                    "$sum": {
                        "$cond": [
                            {"$eq": ["$properties.driven", True]},
                            "$properties.length_m",
                            0,
                        ]
                    }
                },
            }
        },
        {
            "$project": {
                "_id": 0,
                "total_segments": 1,
                "covered_segments": 1,
                "total_length": 1,
                "covered_length": 1,
                "coverage_percentage": {
                    "$multiply": [
                        {"$divide": ["$covered_length", "$total_length"]},
                        100,
                    ]
                },
            }
        },
    ]

    from db import aggregate_with_retry

    results = await aggregate_with_retry(collection, pipeline)
    return results[0] if results else {}


def validate_object_id(id_string: str, field_name: str = "id") -> ObjectId:
    """Validate and convert string to ObjectId."""
    try:
        return ObjectId(id_string)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid {field_name}: {str(e)}",
        )


def extract_coordinates_from_request(request_data: Dict[str, Any]) -> List[List[float]]:
    """Extract and validate coordinates from request data."""
    if "coordinates" not in request_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing coordinates in request",
        )

    coordinates = request_data["coordinates"]
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Coordinates must be a list with at least 2 points",
        )

    return coordinates
