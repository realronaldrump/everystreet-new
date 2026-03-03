"""ARQ task wrappers for street coverage ingestion/backfill pipelines."""

from __future__ import annotations

from typing import Any

from beanie import PydanticObjectId

from street_coverage.ingestion import _run_backfill_pipeline, _run_ingestion_pipeline


def _parse_object_id(raw_id: str, field_name: str) -> PydanticObjectId:
    try:
        return PydanticObjectId(str(raw_id))
    except Exception as exc:  # pragma: no cover - defensive validation path
        msg = f"Invalid {field_name}: {raw_id}"
        raise ValueError(msg) from exc


async def run_area_ingestion_job(
    _ctx: dict[str, Any],
    area_id: str,
    job_id: str,
    trip_mode: str | None = None,
) -> dict[str, str]:
    """Run the full area ingestion pipeline for an existing job."""
    area_obj_id = _parse_object_id(area_id, "area_id")
    job_obj_id = _parse_object_id(job_id, "job_id")
    await _run_ingestion_pipeline(area_obj_id, job_obj_id, trip_mode=trip_mode)
    return {
        "status": "ok",
        "area_id": str(area_obj_id),
        "job_id": str(job_obj_id),
    }


async def run_area_backfill_job(
    _ctx: dict[str, Any],
    area_id: str,
    job_id: str,
    trip_mode: str | None = None,
) -> dict[str, str]:
    """Run the standalone area backfill pipeline for an existing job."""
    area_obj_id = _parse_object_id(area_id, "area_id")
    job_obj_id = _parse_object_id(job_id, "job_id")
    await _run_backfill_pipeline(area_obj_id, job_obj_id, trip_mode=trip_mode)
    return {
        "status": "ok",
        "area_id": str(area_obj_id),
        "job_id": str(job_obj_id),
    }
