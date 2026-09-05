"""Revisioned coverage reads and explicit owner decisions."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
from typing import Annotated, Any, Literal

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field
from starlette.responses import Response

from db.models import CoverageArea, CoverageDriveEvent, CoverageState, Street
from street_coverage.projection import area_metrics, set_manual_status

router = APIRouter(prefix="/api/coverage", tags=["coverage-streets"])
VIEWPORT_LIMIT = 2000


class StreetFeature(BaseModel):
    type: str = "Feature"
    id: str | None = None
    properties: dict[str, Any]
    geometry: dict[str, Any]


class StreetsResponse(BaseModel):
    success: bool = True
    features: list[StreetFeature]
    total_in_viewport: int
    truncated: bool = False
    coverage_revision: int
    area_version: int


class MarkSegmentRequest(BaseModel):
    status: Literal["undriveable", "undriven", "driven", "automatic"]
    source: Literal["manual"] = "manual"


class MarkDrivenSegmentsRequest(BaseModel):
    segment_ids: list[str] = Field(min_length=1, max_length=1000)
    source: Literal["manual"]


class SimulateDriveRequest(BaseModel):
    segment_ids: list[str] = Field(max_length=5000)


async def _area(area_id):
    area = await CoverageArea.get(area_id)
    if area is None:
        raise HTTPException(404, "Coverage area not found")
    if not area.total_segments and area.status != "ready":
        raise HTTPException(409, "The street inventory is being prepared")
    return area


def viewport_polygon(min_lon, min_lat, max_lon, max_lat):
    if not all(math.isfinite(v) for v in [min_lon, min_lat, max_lon, max_lat]) or not (
        -180 <= min_lon < max_lon <= 180 and -90 <= min_lat < max_lat <= 90
    ):
        raise HTTPException(422, "Use a finite, ordered longitude/latitude viewport")
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [min_lon, min_lat],
                [max_lon, min_lat],
                [max_lon, max_lat],
                [min_lon, max_lat],
                [min_lon, min_lat],
            ]
        ],
    }


def _feature(street, state):
    covered = state.covered_length_miles if state else 0.0
    status = state.status if state else "undriven"
    return StreetFeature(
        id=street.segment_id,
        geometry=street.geometry,
        properties={
            "segment_id": street.segment_id,
            "street_name": street.street_name,
            "highway_type": street.highway_type,
            "length_miles": street.length_miles,
            "status": status,
            "covered_length_miles": covered,
            "remaining_length_miles": 0.0
            if status == "undriveable"
            else max(0.0, street.length_miles - covered),
            "coverage_fraction": state.coverage_fraction if state else 0.0,
            "first_driven_at": state.first_driven_at if state else None,
            "last_driven_at": state.last_driven_at if state else None,
            "manually_marked": bool(state.manually_marked) if state else False,
            "evidence_source": state.evidence_source if state else None,
            "trip_count": state.trip_count if state else 0,
            "max_offset_meters": state.max_offset_meters if state else None,
            "intervals": state.intervals if state else [],
            "discovery_intervals": state.discovery_intervals if state else [],
            "section_length_miles": street.length_miles,
        },
    )


async def _features(area, streets, *, parts=False):
    states = await CoverageState.find(
        {
            "area_id": area.id,
            "segment_id": {"$in": [street.segment_id for street in streets]},
        }
    ).to_list()
    by_id = {state.segment_id: state for state in states}
    features = [_feature(street, by_id.get(street.segment_id)) for street in streets]
    if not parts:
        return features
    from street_coverage.rendering import feature_parts

    def split():
        return [
            StreetFeature(**part)
            for feature in features
            for part in feature_parts(feature.model_dump(mode="json"))
        ]

    return await asyncio.to_thread(split)


def _geojson_response(features, *, etag, **extra):
    return Response(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [feature.model_dump(mode="json") for feature in features],
                **extra,
            },
            separators=(",", ":"),
        ),
        media_type="application/geo+json",
        headers={"ETag": etag, "Cache-Control": "private, max-age=0, must-revalidate"},
    )


@router.get("/areas/{area_id}/streets", response_model=StreetsResponse)
async def get_streets_in_viewport(
    area_id: PydanticObjectId,
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
):
    area = await _area(area_id)
    polygon = viewport_polygon(min_lon, min_lat, max_lon, max_lat)
    streets = (
        await Street.find(
            {
                "area_id": area_id,
                "area_version": area.area_version,
                "geometry": {"$geoIntersects": {"$geometry": polygon}},
            }
        )
        .sort("segment_id")
        .limit(VIEWPORT_LIMIT + 1)
        .to_list()
    )
    truncated = len(streets) > VIEWPORT_LIMIT
    features = await _features(area, streets[:VIEWPORT_LIMIT], parts=True)
    return StreetsResponse(
        features=features,
        total_in_viewport=len(features),
        truncated=truncated,
        coverage_revision=area.journal_revision,
        area_version=area.area_version,
    )


@router.get("/areas/{area_id}/streets/geojson")
async def get_streets_geojson(
    area_id: PydanticObjectId,
    min_lon: float,
    min_lat: float,
    max_lon: float,
    max_lat: float,
):
    result = await get_streets_in_viewport(area_id, min_lon, min_lat, max_lon, max_lat)
    return {
        "type": "FeatureCollection",
        "features": [feature.model_dump(mode="json") for feature in result.features],
        "truncated": result.truncated,
        "coverage_revision": result.coverage_revision,
        "area_version": result.area_version,
        "total_in_viewport": result.total_in_viewport,
    }


@router.get("/areas/{area_id}/streets/all")
async def get_all_streets(
    request: Request,
    area_id: PydanticObjectId,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    render_parts: bool = False,
):
    area = await _area(area_id)
    if status_filter not in {None, "undriven", "driven", "undriveable"}:
        raise HTTPException(422, "Unknown street status")
    etag = (
        '"'
        + hashlib.sha256(
            f"{area_id}:{area.area_version}:{area.journal_revision}:{status_filter}:{render_parts}".encode()
        ).hexdigest()[:24]
        + '"'
    )
    if request.headers.get("if-none-match") == etag:
        return Response(
            status_code=304,
            headers={
                "ETag": etag,
                "Cache-Control": "private, max-age=0, must-revalidate",
            },
        )
    streets = await Street.find(
        {"area_id": area_id, "area_version": area.area_version}
    ).to_list()
    features = await _features(area, streets, parts=render_parts)
    if status_filter:
        features = [
            feature
            for feature in features
            if feature.properties["status"] == status_filter
        ]
    return _geojson_response(
        features,
        etag=etag,
        coverage_revision=area.journal_revision,
        area_version=area.area_version,
    )


@router.get("/areas/{area_id}/streets/selection")
async def selected_streets(
    area_id: PydanticObjectId, ids: Annotated[list[str], Query(max_length=300)]
):
    area = await _area(area_id)
    streets = await Street.find(
        {
            "area_id": area_id,
            "area_version": area.area_version,
            "segment_id": {"$in": ids},
        }
    ).to_list()
    return {
        "type": "FeatureCollection",
        "features": [
            feature.model_dump(mode="json")
            for feature in await _features(area, streets)
        ],
        "coverage_revision": area.journal_revision,
    }


@router.get("/areas/{area_id}/streets/summary")
async def get_streets_summary(area_id: PydanticObjectId):
    area = await _area(area_id)
    return {
        "success": True,
        "area_id": str(area_id),
        "display_name": area.display_name,
        "status": area.status,
        "segment_counts": {
            "driven": area.driven_segments,
            "undriveable": area.undriveable_segments,
            "undriven": area.remaining_segments,
        },
        "coverage_revision": area.journal_revision,
        **{
            name: getattr(area, name)
            for name in [
                "total_segments",
                "driven_segments",
                "total_length_miles",
                "driveable_length_miles",
                "driven_length_miles",
                "remaining_length_miles",
                "remaining_segments",
                "is_complete",
                "coverage_percentage",
            ]
        },
    }


@router.get("/areas/{area_id}/streets/{segment_id}")
async def get_street_detail(area_id: PydanticObjectId, segment_id: str):
    area = await _area(area_id)
    street = await Street.find_one(
        {
            "area_id": area_id,
            "area_version": area.area_version,
            "segment_id": segment_id,
        }
    )
    if street is None:
        raise HTTPException(404, "Street no longer belongs to this inventory")
    features = await _features(area, [street])
    events = (
        await CoverageDriveEvent.find(
            {
                "area_id": area_id,
                "area_version": area.area_version,
                "segment_ids": segment_id,
            }
        )
        .sort("-driven_at")
        .limit(5)
        .to_list()
    )
    return {
        "success": True,
        "feature": features[0].model_dump(mode="json"),
        "coverage_revision": area.journal_revision,
        "road_tags": street.road_tags,
        "evidence": [
            {
                "trip_id": str(event.trip_id),
                "driven_at": event.driven_at,
                "source": event.geometry_source,
                "intervals": event.segment_intervals.get(segment_id, []),
                "max_offset_meters": event.segment_offsets.get(segment_id),
            }
            for event in events
        ],
    }


@router.patch("/areas/{area_id}/streets/{segment_id}")
async def update_segment_status(
    area_id: PydanticObjectId, segment_id: str, request: MarkSegmentRequest
):
    try:
        return await set_manual_status(area_id, [segment_id], request.status)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/areas/{area_id}/streets/mark-driven")
async def mark_segments_driven(
    area_id: PydanticObjectId, request: MarkDrivenSegmentsRequest
):
    try:
        return await set_manual_status(area_id, request.segment_ids, "driven")
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/areas/{area_id}/streets/simulate")
async def simulate_drive(area_id: PydanticObjectId, request: SimulateDriveRequest):
    area = await _area(area_id)
    ids = sorted(set(request.segment_ids))
    streets = await Street.find(
        {
            "area_id": area_id,
            "area_version": area.area_version,
            "segment_id": {"$in": ids},
        }
    ).to_list()
    if len(streets) != len(ids):
        raise HTTPException(409, "Selected streets changed; refresh the map")
    features = await _features(area, streets)
    new = [
        feature
        for feature in features
        if feature.properties["remaining_length_miles"] > 0
    ]
    miles = math.fsum(feature.properties["remaining_length_miles"] for feature in new)
    projected = area_metrics(
        total_segments=area.total_segments,
        total_length_miles=area.total_length_miles,
        driven_segments=area.driven_segments + len(new),
        driven_length_miles=area.driven_length_miles + miles,
        undriveable_segments=area.undriveable_segments,
        undriveable_length_miles=area.undriveable_length_miles,
    )
    return {
        "success": True,
        "simulated_segments": len(new),
        "simulated_length_miles": miles,
        "current": {
            name: getattr(area, name)
            for name in [
                "driven_segments",
                "driven_length_miles",
                "coverage_percentage",
            ]
        },
        "projected": projected,
        "coverage_revision": area.journal_revision,
    }
