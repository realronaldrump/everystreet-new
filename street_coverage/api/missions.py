"""Coverage mission lifecycle API endpoints."""

from __future__ import annotations

import logging
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel, Field

from core.api import api_route
from street_coverage.services.missions import CoverageMissionService, serialize_mission

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/coverage", tags=["coverage-missions"])


def _coerce_oid(value: str, *, field: str) -> PydanticObjectId:
    try:
        return PydanticObjectId(str(value))
    except Exception as exc:
        msg = f"Invalid {field}"
        raise HTTPException(status_code=400, detail=msg) from exc


class CreateMissionRequest(BaseModel):
    area_id: str
    resume_if_active: bool = True
    route_snapshot: dict[str, Any] | None = None
    baseline: dict[str, Any] | None = None
    note: str | None = None


class MissionUpdateRequest(BaseModel):
    note: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


@router.post("/missions", response_model=dict[str, Any])
@api_route(logger)
async def create_coverage_mission(payload: CreateMissionRequest):
    area_oid = _coerce_oid(payload.area_id, field="area_id")
    try:
        mission, created = await CoverageMissionService.create_mission(
            area_id=area_oid,
            resume_if_active=bool(payload.resume_if_active),
            route_snapshot=payload.route_snapshot,
            baseline=payload.baseline,
            note=payload.note,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "status": "success",
        "created": created,
        "mission": serialize_mission(mission),
    }


@router.get("/missions/active", response_model=dict[str, Any])
@api_route(logger)
async def get_active_coverage_mission(
    area_id: str = Query(..., min_length=1),
):
    area_oid = _coerce_oid(area_id, field="area_id")
    mission = await CoverageMissionService.get_active_mission(area_oid)
    return {
        "status": "success",
        "mission": serialize_mission(mission) if mission else None,
    }


@router.get("/missions", response_model=dict[str, Any])
@api_route(logger)
async def list_coverage_missions(
    area_id: str | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    try:
        missions, total = await CoverageMissionService.list_missions(
            area_id=area_id,
            status=status,
            limit=limit,
            offset=offset,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "status": "success",
        "count": total,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(missions) < total,
        "missions": [
            serialize_mission(
                mission,
                include_completed_segment_ids=False,
                include_checkpoints=False,
            )
            for mission in missions
        ],
    }


@router.get("/missions/{mission_id}", response_model=dict[str, Any])
@api_route(logger)
async def get_coverage_mission(mission_id: str):
    mission_oid = _coerce_oid(mission_id, field="mission_id")
    mission = await CoverageMissionService.get_mission(mission_oid)

    if not mission:
        raise HTTPException(status_code=404, detail="Mission not found.")

    return {
        "status": "success",
        "mission": serialize_mission(mission),
    }


@router.post("/missions/{mission_id}/heartbeat", response_model=dict[str, Any])
@api_route(logger)
async def heartbeat_coverage_mission(
    mission_id: str,
    payload: MissionUpdateRequest = Body(default_factory=MissionUpdateRequest),
):
    mission_oid = _coerce_oid(mission_id, field="mission_id")
    try:
        mission = await CoverageMissionService.heartbeat(
            mission_oid,
            note=payload.note,
            metadata=payload.metadata,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "status": "success",
        "mission": serialize_mission(mission),
    }


@router.post("/missions/{mission_id}/pause", response_model=dict[str, Any])
@api_route(logger)
async def pause_coverage_mission(
    mission_id: str,
    payload: MissionUpdateRequest = Body(default_factory=MissionUpdateRequest),
):
    mission_oid = _coerce_oid(mission_id, field="mission_id")
    try:
        mission = await CoverageMissionService.transition_status(
            mission_oid,
            new_status="paused",
            note=payload.note,
            metadata=payload.metadata,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "status": "success",
        "mission": serialize_mission(mission),
    }


@router.post("/missions/{mission_id}/resume", response_model=dict[str, Any])
@api_route(logger)
async def resume_coverage_mission(
    mission_id: str,
    payload: MissionUpdateRequest = Body(default_factory=MissionUpdateRequest),
):
    mission_oid = _coerce_oid(mission_id, field="mission_id")
    try:
        mission = await CoverageMissionService.transition_status(
            mission_oid,
            new_status="active",
            note=payload.note,
            metadata=payload.metadata,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "status": "success",
        "mission": serialize_mission(mission),
    }


@router.post("/missions/{mission_id}/complete", response_model=dict[str, Any])
@api_route(logger)
async def complete_coverage_mission(
    mission_id: str,
    payload: MissionUpdateRequest = Body(default_factory=MissionUpdateRequest),
):
    mission_oid = _coerce_oid(mission_id, field="mission_id")
    try:
        mission = await CoverageMissionService.transition_status(
            mission_oid,
            new_status="completed",
            note=payload.note,
            metadata=payload.metadata,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "status": "success",
        "mission": serialize_mission(mission),
    }


@router.post("/missions/{mission_id}/cancel", response_model=dict[str, Any])
@api_route(logger)
async def cancel_coverage_mission(
    mission_id: str,
    payload: MissionUpdateRequest = Body(default_factory=MissionUpdateRequest),
):
    mission_oid = _coerce_oid(mission_id, field="mission_id")
    try:
        mission = await CoverageMissionService.transition_status(
            mission_oid,
            new_status="cancelled",
            note=payload.note,
            metadata=payload.metadata,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {
        "status": "success",
        "mission": serialize_mission(mission),
    }
