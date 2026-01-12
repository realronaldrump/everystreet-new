"""
Legacy coverage endpoints for older frontend clients.

These endpoints mirror the pre-refactor API contract while
serving data from the new coverage models when possible.
"""

from __future__ import annotations

import logging
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, Body, HTTPException, Query, status
from pydantic import BaseModel, Field

from coverage.constants import MILES_TO_METERS
from coverage.models import CoverageArea, CoverageState, Street
from coverage.worker import update_coverage_for_segments
from db.models import CoverageMetadata

logger = logging.getLogger(__name__)
router = APIRouter(tags=["coverage-legacy"])


class MarkDrivenRequest(BaseModel):
    """Request body for marking segments as driven."""

    location_id: str = Field(..., alias="location_id")
    segment_ids: list[str]


def _to_legacy_boundingbox(bounding_box: list[float] | None) -> list[float] | None:
    if not bounding_box or len(bounding_box) != 4:
        return None
    min_lon, min_lat, max_lon, max_lat = bounding_box
    return [min_lat, max_lat, min_lon, max_lon]


def _wrap_geojson(geometry: dict[str, Any] | None) -> dict[str, Any] | None:
    if not geometry:
        return None
    if geometry.get("type") == "Feature":
        return geometry
    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": {},
    }


def _build_legacy_area(area: CoverageArea) -> dict[str, Any]:
    total_length_m = area.total_length_miles * MILES_TO_METERS
    driven_length_m = area.driven_length_miles * MILES_TO_METERS

    location: dict[str, Any] = {
        "id": str(area.id),
        "display_name": area.display_name,
    }

    boundingbox = _to_legacy_boundingbox(area.bounding_box)
    if boundingbox:
        location["boundingbox"] = boundingbox

    geojson = _wrap_geojson(area.boundary)
    if geojson:
        location["geojson"] = geojson

    return {
        "_id": str(area.id),
        "id": str(area.id),
        "display_name": area.display_name,
        "location": location,
        "status": area.status,
        "total_streets": area.total_segments,
        "driven_streets": area.driven_segments,
        "total_length_miles": area.total_length_miles,
        "driven_length_miles": area.driven_length_miles,
        "total_length_m": total_length_m,
        "driven_length_m": driven_length_m,
        "total_length": total_length_m,
        "driven_length": driven_length_m,
        "coverage_percentage": area.coverage_percentage,
        "optimal_route": area.optimal_route,
        "optimal_route_generated_at": (
            area.optimal_route_generated_at.isoformat()
            if area.optimal_route_generated_at
            else None
        ),
    }


def _normalize_legacy_metadata(area: CoverageMetadata) -> dict[str, Any]:
    data = area.model_dump(by_alias=True)
    data_id = data.get("_id") or data.get("id")
    if data_id is not None:
        data_id = str(data_id)
        data["_id"] = data_id
        data.setdefault("id", data_id)

    location = data.get("location")
    if isinstance(location, dict):
        location.setdefault("id", data_id)
        data["location"] = location
        data.setdefault("display_name", location.get("display_name"))

    return data


async def _build_legacy_features(
    area: CoverageArea,
    driven: bool,
    undriven: bool,
) -> list[dict[str, Any]]:
    streets = (
        await Street.find(
            {
                "area_id": area.id,
                "area_version": area.area_version,
            }
        ).to_list()
    )

    if not streets:
        return []

    segment_ids = [street.segment_id for street in streets]
    states = await CoverageState.find(
        {
            "area_id": area.id,
            "segment_id": {"$in": segment_ids},
        }
    ).to_list()
    status_map = {state.segment_id: state.status for state in states}

    if driven and undriven:
        driven = False
        undriven = False

    features = []
    for street in streets:
        status = status_map.get(street.segment_id, "undriven")
        is_driven = status == "driven"
        is_undriveable = status == "undriveable"

        if driven and not is_driven:
            continue
        if undriven and (is_driven or is_undriveable):
            continue

        features.append(
            {
                "type": "Feature",
                "geometry": street.geometry,
                "properties": {
                    "segment_id": street.segment_id,
                    "segment_length": street.length_miles * 5280,
                    "street_name": street.street_name,
                    "osm_id": street.osm_id,
                    "highway": street.highway_type,
                    "location": area.display_name,
                    "driven": is_driven,
                    "undriveable": is_undriveable,
                },
            }
        )

    return features


@router.get("/api/coverage_areas")
async def legacy_list_areas():
    """Legacy list endpoint used by older frontend modules."""
    new_areas = await CoverageArea.find_all().to_list()
    legacy_areas = [_build_legacy_area(area) for area in new_areas]

    seen_names = {area.display_name for area in new_areas if area.display_name}

    old_areas = await CoverageMetadata.find_all().to_list()
    for old_area in old_areas:
        display_name = None
        if old_area.location:
            display_name = old_area.location.get("display_name")
        if display_name and display_name in seen_names:
            continue
        legacy_areas.append(_normalize_legacy_metadata(old_area))

    return {"success": True, "areas": legacy_areas}


@router.get("/api/coverage_areas/{area_id}")
async def legacy_get_area(area_id: str):
    """Legacy detail endpoint used by older frontend modules."""
    try:
        oid = PydanticObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID format",
        )

    area = await CoverageArea.get(oid)
    if area:
        return {"success": True, "coverage": _build_legacy_area(area)}

    old_area = await CoverageMetadata.get(oid)
    if not old_area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    return {"success": True, "coverage": _normalize_legacy_metadata(old_area)}


@router.get("/api/coverage_areas/{area_id}/streets")
async def legacy_get_streets(
    area_id: str,
    driven: bool = Query(False),
    undriven: bool = Query(False),
):
    """Legacy streets endpoint returning full GeoJSON for an area."""
    try:
        oid = PydanticObjectId(area_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID format",
        )

    area = await CoverageArea.get(oid)
    if area:
        features = await _build_legacy_features(area, driven, undriven)
    else:
        old_area = await CoverageMetadata.get(oid)
        if not old_area or not old_area.location:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Coverage area not found",
            )

        location_name = old_area.location.get("display_name")
        if not location_name:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Coverage area is missing display name",
            )

        query: dict[str, Any] = {"properties.location": location_name}
        if driven and undriven:
            driven = False
            undriven = False

        if driven:
            query["properties.driven"] = True
        elif undriven:
            query["properties.driven"] = False
            query["properties.undriveable"] = {"$ne": True}

        docs = (
            await Street.get_pymongo_collection().find(query).to_list(length=None)
        )
        features = [
            {
                "type": "Feature",
                "geometry": doc.get("geometry", {}),
                "properties": doc.get("properties", {}),
            }
            for doc in docs
        ]

    feature_collection = {
        "type": "FeatureCollection",
        "features": features,
    }

    return {
        **feature_collection,
        "geojson": feature_collection,
    }


@router.post("/api/undriven_streets")
async def legacy_undriven_streets(location: dict[str, Any] = Body(...)):
    """Legacy endpoint for exporting undriven streets."""
    location_id = location.get("id") or location.get("_id")
    display_name = location.get("display_name") or location.get("location")

    area = None
    if location_id:
        try:
            oid = PydanticObjectId(location_id)
            area = await CoverageArea.get(oid)
            if area is None:
                old_area = await CoverageMetadata.get(oid)
            else:
                old_area = None
        except Exception:
            old_area = None
    else:
        old_area = None

    if area is None and display_name:
        area = await CoverageArea.find_one({"display_name": display_name})

    if area:
        features = await _build_legacy_features(area, driven=False, undriven=True)
    else:
        if not old_area and display_name:
            old_area = await CoverageMetadata.find_one(
                {"location.display_name": display_name}
            )

        if not old_area or not old_area.location:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Coverage area not found",
            )

        location_name = old_area.location.get("display_name")
        if not location_name:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Coverage area is missing display name",
            )
        query: dict[str, Any] = {
            "properties.location": location_name,
            "properties.driven": False,
            "properties.undriveable": {"$ne": True},
        }
        docs = (
            await Street.get_pymongo_collection().find(query).to_list(length=None)
        )
        features = [
            {
                "type": "Feature",
                "geometry": doc.get("geometry", {}),
                "properties": doc.get("properties", {}),
            }
            for doc in docs
        ]

    return {
        "type": "FeatureCollection",
        "features": features,
    }


@router.post("/api/street_segments/mark_driven")
async def legacy_mark_segments_driven(request: MarkDrivenRequest):
    """Persist driven segments from turn-by-turn navigation."""
    try:
        area_id = PydanticObjectId(request.location_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid area ID format",
        )

    area = await CoverageArea.get(area_id)
    if not area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage area not found",
        )

    updated = await update_coverage_for_segments(
        area_id=area_id,
        segment_ids=request.segment_ids,
    )

    from coverage.stats import update_area_stats

    await update_area_stats(area_id)

    return {
        "success": True,
        "updated": updated,
    }
