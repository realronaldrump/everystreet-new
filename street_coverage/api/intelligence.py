"""Owner-facing coverage goals, forecasts, and mission lifecycle APIs."""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from typing import Literal

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from street_coverage.intelligence import CoverageIntelligenceService

router = APIRouter(prefix="/api/coverage", tags=["coverage-intelligence"])


class CoverageGoalRequest(BaseModel):
    target_percentage: float = Field(default=100.0, ge=1.0, le=100.0)
    target_date: date | None = None
    preferred_mission_minutes: int = Field(default=90, ge=15, le=480)


class CoverageMissionRequest(BaseModel):
    area_id: PydanticObjectId
    segment_ids: list[str] = Field(min_length=1, max_length=500)
    expected_area_version: int = Field(ge=1)
    expected_journal_revision: int = Field(ge=0)
    requested_minutes: int = Field(default=90, ge=15, le=480)
    start_lat: float | None = Field(default=None, ge=-90, le=90)
    start_lon: float | None = Field(default=None, ge=-180, le=180)


def _http_error(exc: Exception) -> HTTPException:
    code = (
        status.HTTP_409_CONFLICT
        if "changed" in str(exc).lower() or "stale" in str(exc).lower()
        else status.HTTP_400_BAD_REQUEST
    )
    if "not found" in str(exc).lower():
        code = status.HTTP_404_NOT_FOUND
    return HTTPException(status_code=code, detail=str(exc))


@router.get("/areas/{area_id}/intelligence")
async def get_coverage_intelligence(
    area_id: PydanticObjectId, timezone: str = "America/Denver"
):
    try:
        return await CoverageIntelligenceService.get_intelligence(
            area_id, timezone=timezone
        )
    except ValueError as exc:
        raise _http_error(exc) from exc


@router.put("/areas/{area_id}/goal")
async def save_coverage_goal(
    area_id: PydanticObjectId,
    payload: CoverageGoalRequest,
):
    try:
        goal = await CoverageIntelligenceService.save_goal(
            area_id,
            target_percentage=payload.target_percentage,
            target_date=(
                datetime.combine(payload.target_date, time.max, tzinfo=UTC)
                if payload.target_date
                else None
            ),
            preferred_mission_minutes=payload.preferred_mission_minutes,
        )
    except ValueError as exc:
        raise _http_error(exc) from exc
    else:
        return {"success": True, "goal": goal}


@router.get("/areas/{area_id}/mission-recommendations")
async def recommend_coverage_missions(
    area_id: PydanticObjectId,
    start_lat: float | None = Query(default=None, ge=-90, le=90),
    start_lon: float | None = Query(default=None, ge=-180, le=180),
    preferred_minutes: int | None = Query(default=None, ge=15, le=480),
    limit: int = Query(default=5, ge=1, le=5),
):
    try:
        return await CoverageIntelligenceService.recommend_missions(
            area_id,
            start_lat=start_lat,
            start_lon=start_lon,
            preferred_minutes=preferred_minutes,
            limit=limit,
        )
    except ValueError as exc:
        raise _http_error(exc) from exc


@router.get("/areas/{area_id}/missions")
async def list_coverage_missions(
    area_id: PydanticObjectId,
    limit: int = Query(default=20, ge=1, le=100),
    include_route: bool = False,
):
    return {
        "success": True,
        "missions": await CoverageIntelligenceService.list_missions(
            area_id,
            limit=limit,
            include_route=include_route,
        ),
    }


@router.post("/missions", status_code=status.HTTP_202_ACCEPTED)
async def create_coverage_mission(payload: CoverageMissionRequest):
    try:
        mission = await CoverageIntelligenceService.create_mission(
            payload.area_id,
            segment_ids=payload.segment_ids,
            expected_area_version=payload.expected_area_version,
            expected_journal_revision=payload.expected_journal_revision,
            requested_minutes=payload.requested_minutes,
            start_lat=payload.start_lat,
            start_lon=payload.start_lon,
        )
    except (ValueError, RuntimeError) as exc:
        raise _http_error(exc) from exc
    else:
        return {"success": True, "mission": mission}


@router.get("/missions/{mission_id}")
async def get_coverage_mission(mission_id: PydanticObjectId):
    try:
        mission = await CoverageIntelligenceService.get_mission(
            mission_id,
            include_route=True,
        )
    except ValueError as exc:
        raise _http_error(exc) from exc
    return {"success": True, "mission": mission}


@router.post("/missions/{mission_id}/{action}")
async def transition_coverage_mission(
    mission_id: PydanticObjectId,
    action: Literal["start", "finish", "cancel"],
):
    try:
        mission = await CoverageIntelligenceService.transition_mission(
            mission_id,
            action,
        )
    except ValueError as exc:
        raise _http_error(exc) from exc
    else:
        return {"success": True, "mission": mission}
