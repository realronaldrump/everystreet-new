"""Owner-facing coverage goals, forecasts, and mission history APIs."""

from __future__ import annotations

from datetime import UTC, date, datetime, time

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from street_coverage.intelligence import CoverageIntelligenceService

router = APIRouter(prefix="/api/coverage", tags=["coverage-intelligence"])


class CoverageGoalRequest(BaseModel):
    target_percentage: float = Field(default=100.0, ge=1.0, le=100.0)
    target_date: date | None = None
    preferred_mission_minutes: int = Field(default=90, ge=15, le=480)


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
