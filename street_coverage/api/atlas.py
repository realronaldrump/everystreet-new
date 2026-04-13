"""Self-maintaining Atlas API endpoints."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId
from fastapi import APIRouter, HTTPException, status

from core.coverage import get_effective_coverage_trip_mode
from core.serialization import serialize_datetime
from db.models import CoverageArea, Job
from street_coverage.ingestion import backfill_area, rebuild_area

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/coverage", tags=["atlas"])


def _now() -> datetime:
    return datetime.now(UTC)


def _area_score(area: CoverageArea) -> tuple[int, float, datetime]:
    ready_score = 1 if area.status == "ready" else 0
    synced_at = area.last_synced or area.created_at
    if synced_at.tzinfo is None:
        synced_at = synced_at.replace(tzinfo=UTC)
    return (ready_score, float(area.coverage_percentage or 0), synced_at)


def _serialize_job(job: Job) -> dict[str, Any]:
    return {
        "id": str(job.id),
        "type": job.job_type,
        "status": job.status,
        "stage": job.stage,
        "progress": round(float(job.progress or 0), 1),
        "message": job.message,
        "area_id": str(job.area_id) if job.area_id else None,
        "updated_at": serialize_datetime(job.updated_at or job.created_at),
    }


def _serialize_area(area: CoverageArea) -> dict[str, Any]:
    driveable = float(area.driveable_length_miles or area.total_length_miles or 0)
    driven = float(area.driven_length_miles or 0)
    remaining = max(0.0, driveable - driven)
    return {
        "id": str(area.id),
        "name": area.display_name,
        "type": area.area_type,
        "status": area.status,
        "health": area.health,
        "coverage_percent": round(float(area.coverage_percentage or 0), 1),
        "driven_miles": round(driven, 1),
        "remaining_miles": round(remaining, 1),
        "driveable_miles": round(driveable, 1),
        "total_segments": int(area.total_segments or 0),
        "driven_segments": int(area.driven_segments or 0),
        "last_refreshed_at": serialize_datetime(area.last_synced),
        "has_optimal_route": area.optimal_route is not None,
        "last_error": area.last_error,
    }


async def _active_jobs(area_id: PydanticObjectId | None = None) -> list[Job]:
    query: dict[str, Any] = {
        "job_type": {"$in": ["area_ingestion", "area_rebuild", "area_backfill"]},
        "status": {"$in": ["pending", "running"]},
    }
    if area_id is not None:
        query["area_id"] = area_id
    try:
        return await Job.find(query).sort("-created_at").limit(10).to_list()
    except Exception:
        logger.exception("Failed to load active atlas jobs")
        return []


def _recommended_next_action(
    selected: CoverageArea | None,
    territories: list[CoverageArea],
    active_jobs: list[Job],
) -> dict[str, Any]:
    if active_jobs:
        job = active_jobs[0]
        return {
            "kind": "working",
            "title": "Atlas is refreshing",
            "message": job.message or "Coverage is being updated in the background.",
            "cta_label": None,
            "cta_href": None,
        }
    if not territories:
        return {
            "kind": "create_territory",
            "title": "Choose your first territory",
            "message": "Add a city or county once, then Every Street keeps it current.",
            "cta_label": "Add territory",
            "cta_href": "/coverage-management",
        }
    if selected and selected.status == "error":
        return {
            "kind": "attention",
            "title": "Territory needs attention",
            "message": selected.last_error
            or "Atlas automation paused for this territory.",
            "cta_label": "Open diagnostics",
            "cta_href": "/control-center#diagnostics",
        }
    if selected and float(selected.coverage_percentage or 0) >= 99.5:
        return {
            "kind": "celebrate",
            "title": "Territory nearly complete",
            "message": "The remaining streets are small enough for a final review.",
            "cta_label": "Open planner",
            "cta_href": "/coverage-route-planner",
        }
    return {
        "kind": "next_drive",
        "title": "Next best drive is ready",
        "message": "Open the planner when you want a refined route through remaining streets.",
        "cta_label": "Open planner",
        "cta_href": "/coverage-route-planner",
    }


@router.get("/atlas", response_model=dict[str, Any])
async def get_coverage_atlas() -> dict[str, Any]:
    """Return the self-maintaining Atlas summary for coverage UI."""
    try:
        territories = await CoverageArea.find_all().to_list()
    except Exception:
        logger.exception("Failed to load coverage territories")
        territories = []

    selected = max(territories, key=_area_score, default=None)
    jobs = await _active_jobs()
    total_driveable = sum(
        float(area.driveable_length_miles or area.total_length_miles or 0)
        for area in territories
    )
    total_driven = sum(float(area.driven_length_miles or 0) for area in territories)
    coverage_percent = (
        (total_driven / total_driveable * 100) if total_driveable else 0.0
    )

    return {
        "generated_at": serialize_datetime(_now()),
        "summary": {
            "state": "refreshing" if jobs else ("ready" if territories else "empty"),
            "territory_count": len(territories),
            "ready_territory_count": sum(
                1 for area in territories if area.status == "ready"
            ),
            "coverage_percent": round(coverage_percent, 1),
            "driven_miles": round(total_driven, 1),
            "remaining_miles": round(max(0.0, total_driveable - total_driven), 1),
        },
        "selected_territory": _serialize_area(selected) if selected else None,
        "territories": [_serialize_area(area) for area in territories],
        "active_automation": [_serialize_job(job) for job in jobs],
        "recommended_next_action": _recommended_next_action(
            selected,
            territories,
            jobs,
        ),
    }


@router.post("/areas/{area_id}/refresh-policy", response_model=dict[str, Any])
async def refresh_area_policy(area_id: PydanticObjectId) -> dict[str, Any]:
    """
    Schedule the correct Atlas refresh for a territory.

    A full rebuild is chosen when the territory has no usable road policy or
    is not ready. Ready territories receive a backfill so new historical trip
    data can refresh coverage without forcing the user to choose internals.
    """
    area = await CoverageArea.get(area_id)
    if not area:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Coverage territory not found.",
        )

    active = await _active_jobs(area_id)
    if active:
        return {
            "status": "already_running",
            "message": "Atlas refresh is already in progress.",
            "job": _serialize_job(active[0]),
        }

    trip_mode = await get_effective_coverage_trip_mode(None)
    should_rebuild = area.status != "ready" or not area.road_filter_version
    try:
        job = (
            await rebuild_area(area_id, trip_mode=trip_mode)
            if should_rebuild
            else await backfill_area(area_id, trip_mode=trip_mode)
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc

    return {
        "status": "scheduled",
        "mode": "rebuild" if should_rebuild else "backfill",
        "message": "Atlas refresh has been scheduled.",
        "job": _serialize_job(job),
    }
