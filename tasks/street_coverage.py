"""ARQ task wrappers for street coverage ingestion/backfill pipelines."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId

from db.models import CoverageArea, Job
from street_coverage.ingestion import (
    _run_backfill_pipeline,
    _run_ingestion_pipeline,
    reset_area_for_rebuild,
)

logger = logging.getLogger(__name__)


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


async def _set_job_fields(job_id: PydanticObjectId, fields: dict[str, Any]) -> None:
    fields.setdefault("updated_at", datetime.now(UTC))
    job = await Job.get(job_id)
    if job:
        await job.set(fields)


async def _is_cancelled(job_id: PydanticObjectId) -> bool:
    job = await Job.get(job_id)
    return job is None or job.status == "cancelled"


async def _mark_child_failed(
    job_id: PydanticObjectId,
    *,
    message: str,
    error: str,
) -> None:
    now = datetime.now(UTC)
    await _set_job_fields(
        job_id,
        {
            "status": "failed",
            "stage": "Failed",
            "progress": 100.0,
            "message": message,
            "error": error,
            "completed_at": now,
        },
    )


async def run_area_recalculate_batch_job(
    _ctx: dict[str, Any],
    batch_job_id: str,
    items: list[dict[str, Any]],
    trip_mode: str | None = None,
) -> dict[str, Any]:
    """Run queued area recalculation jobs one at a time."""
    batch_obj_id = _parse_object_id(batch_job_id, "batch_job_id")
    batch_job = await Job.get(batch_obj_id)
    if not batch_job:
        return {"status": "missing_batch_job", "batch_job_id": str(batch_obj_id)}

    total = len(items)
    now = datetime.now(UTC)
    await batch_job.set(
        {
            "status": "running",
            "stage": "Starting",
            "progress": 0.0,
            "message": f"Starting sequential coverage recalculation for {total} areas.",
            "started_at": now,
            "updated_at": now,
        },
    )

    outcomes: list[dict[str, Any]] = []
    operation_counts = {"backfill": 0, "rebuild": 0}

    for index, item in enumerate(items):
        if await _is_cancelled(batch_obj_id):
            logger.info("Coverage recalculation batch %s cancelled", batch_obj_id)
            break

        area_id = _parse_object_id(str(item.get("area_id")), "area_id")
        child_job_id = _parse_object_id(str(item.get("job_id")), "job_id")
        operation = str(item.get("operation") or "backfill").strip().lower()
        if operation not in operation_counts:
            operation = "backfill"

        area = await CoverageArea.get(area_id)
        area_name = area.display_name if area else str(area_id)
        position = index + 1
        operation_counts[operation] += 1

        await _set_job_fields(
            batch_obj_id,
            {
                "stage": f"{position}/{total}: {area_name}",
                "progress": (index / max(1, total)) * 100.0,
                "message": f"Running {operation} for {area_name}.",
            },
        )

        child_job = await Job.get(child_job_id)
        if not area or not child_job:
            error = "Coverage area or child job was not found."
            await _mark_child_failed(
                child_job_id,
                message="Coverage recalculation skipped.",
                error=error,
            )
            outcomes.append(
                {
                    "area_id": str(area_id),
                    "job_id": str(child_job_id),
                    "operation": operation,
                    "status": "failed",
                    "error": error,
                },
            )
            continue

        if child_job.status == "cancelled":
            outcomes.append(
                {
                    "area_id": str(area_id),
                    "job_id": str(child_job_id),
                    "operation": operation,
                    "status": "cancelled",
                },
            )
            continue

        try:
            if operation == "rebuild":
                await reset_area_for_rebuild(area_id)
                await _run_ingestion_pipeline(
                    area_id,
                    child_job_id,
                    trip_mode=trip_mode,
                    allow_retries=False,
                )
            else:
                await _run_backfill_pipeline(
                    area_id,
                    child_job_id,
                    trip_mode=trip_mode,
                )
        except Exception as exc:  # pragma: no cover - pipeline guards most failures
            logger.exception(
                "Sequential coverage recalculation failed for area %s",
                area_id,
            )
            await _mark_child_failed(
                child_job_id,
                message="Coverage recalculation failed.",
                error=str(exc),
            )

        refreshed_child = await Job.get(child_job_id)
        outcomes.append(
            {
                "area_id": str(area_id),
                "job_id": str(child_job_id),
                "operation": operation,
                "status": refreshed_child.status if refreshed_child else "missing",
                "error": refreshed_child.error if refreshed_child else None,
            },
        )

        await _set_job_fields(
            batch_obj_id,
            {
                "progress": (position / max(1, total)) * 100.0,
                "message": f"Finished {position} of {total} coverage recalculations.",
            },
        )

    final_job = await Job.get(batch_obj_id)
    if final_job and final_job.status == "cancelled":
        return {
            "status": "cancelled",
            "batch_job_id": str(batch_obj_id),
            "outcomes": outcomes,
        }

    failed_count = sum(
        1
        for outcome in outcomes
        if outcome.get("status") not in {"completed", "cancelled"}
    )
    cancelled_count = sum(
        1 for outcome in outcomes if outcome.get("status") == "cancelled"
    )
    completed_count = sum(
        1 for outcome in outcomes if outcome.get("status") == "completed"
    )
    status = "completed" if failed_count == 0 else "needs_attention"
    completed_at = datetime.now(UTC)
    result = {
        "total": total,
        "completed": completed_count,
        "failed": failed_count,
        "cancelled": cancelled_count,
        "operation_counts": operation_counts,
        "outcomes": outcomes,
    }
    final_message = (
        "Sequential coverage recalculation finished for "
        f"{completed_count}/{total} areas."
        if status == "completed"
        else f"Coverage batch finished with {failed_count} area issues."
    )

    await batch_job.set(
        {
            "status": status,
            "stage": "Complete" if status == "completed" else "Needs attention",
            "progress": 100.0,
            "message": final_message,
            "completed_at": completed_at,
            "updated_at": completed_at,
            "result": result,
        },
    )

    return {
        "status": status,
        "batch_job_id": str(batch_obj_id),
        **result,
    }
