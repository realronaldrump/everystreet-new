"""Serialization utilities for coverage data.

Handles conversion of MongoDB types (ObjectId, datetime) and sanitization
of JSON data (NaN, Infinity values).
"""

import logging
import math
from datetime import datetime
from typing import Any

from bson import ObjectId

logger = logging.getLogger(__name__)


def sanitize_value(value: Any) -> Any:
    """Sanitize a value to be JSON-compliant (handle NaN, Infinity).

    Args:
        value: Any value that might contain NaN or Infinity

    Returns:
        Sanitized value safe for JSON serialization
    """
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return 0.0
    elif isinstance(value, dict):
        return {k: sanitize_value(v) for k, v in value.items()}
    elif isinstance(value, list):
        return [sanitize_value(v) for v in value]
    return value


def sanitize_features(features: list) -> list:
    """Sanitize a list of GeoJSON features to ensure valid JSON.

    Args:
        features: List of GeoJSON feature dictionaries

    Returns:
        List of sanitized features
    """
    return [sanitize_value(feature) for feature in features]


def serialize_datetime(dt: datetime | None) -> str | None:
    """Convert datetime to ISO format string.

    Args:
        dt: Datetime object or None

    Returns:
        ISO format string or None
    """
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return dt.isoformat()
    return dt


def serialize_object_id(obj_id: ObjectId | str | None) -> str | None:
    """Convert ObjectId to string.

    Args:
        obj_id: ObjectId, string, or None

    Returns:
        String representation or None
    """
    if obj_id is None:
        return None
    if isinstance(obj_id, ObjectId):
        return str(obj_id)
    return obj_id


def serialize_coverage_area(area: dict) -> dict:
    """Serialize a coverage area document for JSON response.

    Args:
        area: Raw coverage area document from MongoDB

    Returns:
        Serialized coverage area safe for JSON response
    """
    processed = {
        "_id": serialize_object_id(area.get("_id")),
        "location": area.get("location", {}),
        "total_length": area.get("total_length_m", area.get("total_length", 0)),
        "driven_length": area.get("driven_length_m", area.get("driven_length", 0)),
        "coverage_percentage": area.get("coverage_percentage", 0),
        "last_updated": serialize_datetime(area.get("last_updated")),
        "total_segments": area.get("total_segments", 0),
        "status": area.get("status", "completed"),
        "last_error": area.get("last_error"),
    }

    # Handle optimal route metadata
    route_meta = area.get("optimal_route_metadata")
    if isinstance(route_meta, dict):
        processed["optimal_route"] = {
            "generated_at": serialize_datetime(route_meta.get("generated_at")),
            "distance_meters": route_meta.get("distance_meters"),
            "required_edge_count": route_meta.get("required_edge_count"),
        }
    elif isinstance(area.get("optimal_route"), dict):
        processed["optimal_route"] = {
            "generated_at": serialize_datetime(
                area["optimal_route"].get("generated_at")
            )
        }

    return processed


def serialize_coverage_details(coverage_doc: dict) -> dict:
    """Serialize detailed coverage area information.

    Args:
        coverage_doc: Raw coverage document from MongoDB

    Returns:
        Serialized coverage details
    """
    location_info = coverage_doc.get("location", {})

    return {
        "_id": serialize_object_id(coverage_doc.get("_id")),
        "location": location_info,
        "location_name": location_info.get("display_name"),
        "total_length": coverage_doc.get(
            "total_length_m",
            coverage_doc.get("total_length", 0),
        ),
        "driven_length": coverage_doc.get(
            "driven_length_m",
            coverage_doc.get("driven_length", 0),
        ),
        "coverage_percentage": coverage_doc.get("coverage_percentage", 0.0),
        "last_updated": serialize_datetime(coverage_doc.get("last_updated")),
        "total_segments": coverage_doc.get("total_segments", 0),
        "streets_geojson_gridfs_id": serialize_object_id(
            coverage_doc.get("streets_geojson_gridfs_id")
        ),
        "street_types": coverage_doc.get("street_types", []),
        "status": coverage_doc.get("status", "completed"),
        "has_error": coverage_doc.get("status") == "error",
        "error_message": (
            coverage_doc.get("last_error")
            if coverage_doc.get("status") == "error"
            else None
        ),
        "needs_reprocessing": coverage_doc.get("needs_stats_update", False),
    }


def serialize_progress(progress: dict) -> dict:
    """Serialize task progress information.

    Args:
        progress: Raw progress document from MongoDB

    Returns:
        Serialized progress data
    """
    return {
        "_id": serialize_object_id(progress.get("_id")),
        "stage": progress.get("stage", "unknown"),
        "progress": progress.get("progress", 0),
        "message": progress.get("message", ""),
        "error": progress.get("error"),
        "result": progress.get("result"),
        "metrics": progress.get("metrics", {}),
        "updated_at": serialize_datetime(progress.get("updated_at")),
        "location": progress.get("location"),
    }


def serialize_optimal_route(route: dict) -> dict:
    """Serialize optimal route data.

    Args:
        route: Raw route document from MongoDB

    Returns:
        Serialized route data
    """
    result = dict(route)

    # Serialize datetime
    if isinstance(result.get("generated_at"), datetime):
        result["generated_at"] = result["generated_at"].isoformat()

    # Normalize coordinates field
    if not result.get("coordinates") and result.get("route_coordinates"):
        result["coordinates"] = result["route_coordinates"]

    return result
