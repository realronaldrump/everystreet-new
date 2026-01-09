"""Viewport-based street and coverage API endpoints.

Replaces the old GridFS-based GeoJSON blob approach with
viewport-based queries that return bounded payloads.
"""

import logging
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from db import (
    aggregate_with_retry,
    areas_collection,
    coverage_state_collection,
    find_one_with_retry,
    streets_v2_collection,
)
from coverage_models.coverage_state import CoverageStatus

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/areas", tags=["viewport"])

# Maximum features to return per viewport request
MAX_VIEWPORT_FEATURES = 5000


class ViewportParams(BaseModel):
    """Parameters for viewport queries."""

    west: float
    south: float
    east: float
    north: float
    zoom: int = 12


def _build_viewport_polygon(west: float, south: float, east: float, north: float) -> dict[str, Any]:
    """Build a GeoJSON polygon from viewport bounds."""
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
            ]
        ],
    }


@router.get("/{area_id}/streets/viewport")
async def get_streets_in_viewport(
    area_id: str,
    west: float = Query(..., ge=-180, le=180),
    south: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-180, le=180),
    north: float = Query(..., ge=-90, le=90),
    zoom: int = Query(12, ge=0, le=22),
    include_coverage: bool = Query(True),
):
    """Get streets within a viewport, with optional coverage status.

    Returns street geometries and optionally their coverage status,
    bounded to MAX_VIEWPORT_FEATURES to ensure responsive rendering.

    Args:
        area_id: Area ID
        west: Western longitude bound
        south: Southern latitude bound
        east: Eastern longitude bound
        north: Northern latitude bound
        zoom: Current map zoom level (used for potential simplification)
        include_coverage: Whether to include coverage status (default: True)

    Returns:
        GeoJSON FeatureCollection with street segments
    """
    try:
        area_oid = ObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID",
        )

    # Get area to verify it exists and get current version
    area_doc = await find_one_with_retry(
        areas_collection,
        {"_id": area_oid},
        {"current_version": 1, "display_name": 1, "status": 1},
    )

    if not area_doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Area {area_id} not found",
        )

    if area_doc.get("status") != "ready":
        return {
            "type": "FeatureCollection",
            "features": [],
            "metadata": {
                "area_id": area_id,
                "area_status": area_doc.get("status"),
                "message": "Area not ready",
            },
        }

    area_version = area_doc.get("current_version", 1)
    viewport_polygon = _build_viewport_polygon(west, south, east, north)

    # Build aggregation pipeline
    if include_coverage:
        # Join with coverage_state to get status
        pipeline = [
            {
                "$match": {
                    "area_id": area_oid,
                    "area_version": area_version,
                    "geometry": {
                        "$geoIntersects": {
                            "$geometry": viewport_polygon,
                        }
                    },
                }
            },
            {"$limit": MAX_VIEWPORT_FEATURES},
            {
                "$lookup": {
                    "from": "coverage_state",
                    "let": {"seg_id": "$segment_id"},
                    "pipeline": [
                        {
                            "$match": {
                                "$expr": {
                                    "$and": [
                                        {"$eq": ["$area_id", area_oid]},
                                        {"$eq": ["$area_version", area_version]},
                                        {"$eq": ["$segment_id", "$$seg_id"]},
                                    ]
                                }
                            }
                        },
                        {"$project": {"status": 1, "manual_override": 1, "_id": 0}},
                    ],
                    "as": "coverage",
                }
            },
            {
                "$project": {
                    "segment_id": 1,
                    "geometry": 1,
                    "street_name": 1,
                    "highway": 1,
                    "segment_length_m": 1,
                    "undriveable": 1,
                    "coverage": {"$arrayElemAt": ["$coverage", 0]},
                }
            },
        ]
    else:
        # Just get streets without coverage join
        pipeline = [
            {
                "$match": {
                    "area_id": area_oid,
                    "area_version": area_version,
                    "geometry": {
                        "$geoIntersects": {
                            "$geometry": viewport_polygon,
                        }
                    },
                }
            },
            {"$limit": MAX_VIEWPORT_FEATURES},
            {
                "$project": {
                    "segment_id": 1,
                    "geometry": 1,
                    "street_name": 1,
                    "highway": 1,
                    "segment_length_m": 1,
                    "undriveable": 1,
                }
            },
        ]

    results = await aggregate_with_retry(streets_v2_collection, pipeline)

    # Convert to GeoJSON features
    features = []
    for doc in results:
        properties = {
            "segment_id": doc.get("segment_id"),
            "street_name": doc.get("street_name"),
            "highway": doc.get("highway"),
            "segment_length_m": doc.get("segment_length_m"),
            "undriveable": doc.get("undriveable", False),
        }

        # Add coverage status if available
        if include_coverage and doc.get("coverage"):
            coverage = doc["coverage"]
            properties["status"] = coverage.get("status", "undriven")
            properties["manual_override"] = coverage.get("manual_override", False)
        elif include_coverage:
            # No coverage record found - treat as undriven
            properties["status"] = "undriven"
            properties["manual_override"] = False

        features.append(
            {
                "type": "Feature",
                "geometry": doc.get("geometry"),
                "properties": properties,
            }
        )

    return {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "area_id": area_id,
            "area_version": area_version,
            "feature_count": len(features),
            "truncated": len(features) >= MAX_VIEWPORT_FEATURES,
            "viewport": {
                "west": west,
                "south": south,
                "east": east,
                "north": north,
                "zoom": zoom,
            },
        },
    }


@router.get("/{area_id}/coverage/viewport")
async def get_coverage_in_viewport(
    area_id: str,
    west: float = Query(..., ge=-180, le=180),
    south: float = Query(..., ge=-90, le=90),
    east: float = Query(..., ge=-180, le=180),
    north: float = Query(..., ge=-90, le=90),
):
    """Get coverage status for segments in viewport.

    This is a lightweight endpoint that returns only coverage status,
    not full geometry. Useful for updating coverage styling without
    refetching geometry.

    Args:
        area_id: Area ID
        west: Western longitude bound
        south: Southern latitude bound
        east: Eastern longitude bound
        north: Northern latitude bound

    Returns:
        Dict mapping segment_id to coverage status
    """
    try:
        area_oid = ObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID",
        )

    # Get area to verify it exists and get current version
    area_doc = await find_one_with_retry(
        areas_collection,
        {"_id": area_oid},
        {"current_version": 1, "status": 1},
    )

    if not area_doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Area {area_id} not found",
        )

    if area_doc.get("status") != "ready":
        return {
            "coverage": {},
            "metadata": {
                "area_id": area_id,
                "area_status": area_doc.get("status"),
                "message": "Area not ready",
            },
        }

    area_version = area_doc.get("current_version", 1)
    viewport_polygon = _build_viewport_polygon(west, south, east, north)

    # First get segment_ids in viewport
    segment_pipeline = [
        {
            "$match": {
                "area_id": area_oid,
                "area_version": area_version,
                "geometry": {
                    "$geoIntersects": {
                        "$geometry": viewport_polygon,
                    }
                },
            }
        },
        {"$limit": MAX_VIEWPORT_FEATURES},
        {"$project": {"segment_id": 1, "_id": 0}},
    ]

    segment_docs = await aggregate_with_retry(streets_v2_collection, segment_pipeline)
    segment_ids = [doc["segment_id"] for doc in segment_docs]

    if not segment_ids:
        return {
            "coverage": {},
            "metadata": {
                "area_id": area_id,
                "area_version": area_version,
                "segment_count": 0,
            },
        }

    # Get coverage status for these segments
    coverage_pipeline = [
        {
            "$match": {
                "area_id": area_oid,
                "area_version": area_version,
                "segment_id": {"$in": segment_ids},
            }
        },
        {
            "$project": {
                "segment_id": 1,
                "status": 1,
                "manual_override": 1,
                "_id": 0,
            }
        },
    ]

    coverage_docs = await aggregate_with_retry(coverage_state_collection, coverage_pipeline)

    # Build coverage map
    coverage_map = {}
    for doc in coverage_docs:
        coverage_map[doc["segment_id"]] = {
            "status": doc.get("status", "undriven"),
            "manual_override": doc.get("manual_override", False),
        }

    # Fill in missing segments as undriven
    for segment_id in segment_ids:
        if segment_id not in coverage_map:
            coverage_map[segment_id] = {
                "status": "undriven",
                "manual_override": False,
            }

    return {
        "coverage": coverage_map,
        "metadata": {
            "area_id": area_id,
            "area_version": area_version,
            "segment_count": len(coverage_map),
            "truncated": len(segment_ids) >= MAX_VIEWPORT_FEATURES,
        },
    }


@router.get("/{area_id}/stats")
async def get_area_stats(area_id: str):
    """Get cached statistics for an area.

    Returns coverage statistics including total/driven/driveable lengths
    and coverage percentage.
    """
    try:
        area_oid = ObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID",
        )

    area_doc = await find_one_with_retry(
        areas_collection,
        {"_id": area_oid},
        {"cached_stats": 1, "display_name": 1, "status": 1, "current_version": 1},
    )

    if not area_doc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Area {area_id} not found",
        )

    stats = area_doc.get("cached_stats", {})

    return {
        "success": True,
        "area_id": area_id,
        "display_name": area_doc.get("display_name"),
        "status": area_doc.get("status"),
        "current_version": area_doc.get("current_version"),
        "stats": {
            "total_segments": stats.get("total_segments", 0),
            "covered_segments": stats.get("covered_segments", 0),
            "total_length_m": stats.get("total_length_m", 0),
            "driven_length_m": stats.get("driven_length_m", 0),
            "driveable_length_m": stats.get("driveable_length_m", 0),
            "coverage_percentage": stats.get("coverage_percentage", 0),
            "last_computed_at": stats.get("last_computed_at"),
        },
    }
