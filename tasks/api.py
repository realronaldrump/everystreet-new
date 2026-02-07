import asyncio
import json
import logging
import math
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from beanie.operators import In
from fastapi import APIRouter, Body, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from core.api import api_route
from core.date_utils import normalize_to_utc_datetime
from core.serialization import serialize_datetime
from db.models import TaskHistory
from db.schemas import BackgroundTasksConfigModel
from tasks.config import (
    check_dependencies,
    get_task_config,
    get_task_config_entry,
    set_global_disable,
    update_task_failure,
    update_task_history_entry,
    update_task_schedule,
)
from tasks.ops import abort_job, enqueue_task
from tasks.registry import TASK_DEFINITIONS

logger = logging.getLogger(__name__)
router = APIRouter()


class FetchTripsRangeRequest(BaseModel):
    start_date: datetime
    end_date: datetime
    map_match: bool = False


async def _get_latest_history(task_ids: list[str]) -> dict[str, TaskHistory]:
    if not task_ids:
        return {}
    entries = (
        await TaskHistory.find(In(TaskHistory.task_id, task_ids))
        .sort(-TaskHistory.timestamp)
        .to_list()
    )
    latest: dict[str, TaskHistory] = {}
    for entry in entries:
        if entry.task_id and entry.task_id not in latest:
            latest[entry.task_id] = entry
    return latest


async def _build_task_snapshot() -> dict[str, Any]:
    config = await get_task_config()
    task_ids = list(config.get("tasks", {}).keys())
    latest_history = await _get_latest_history(task_ids)

    for task_id, task_config in config.get("tasks", {}).items():
        task_def = TASK_DEFINITIONS.get(task_id, {})
        history = latest_history.get(task_id)

        task_config["display_name"] = task_def.get("display_name", task_id)
        task_config["description"] = task_def.get("description", "")
        task_config["manual_only"] = bool(task_def.get("manual_only", False))

        task_config["status"] = history.status if history and history.status else "IDLE"
        task_config["last_error"] = task_config.get("last_error") or (
            history.error if history else None
        )

        last_run_dt = normalize_to_utc_datetime(task_config.get("last_run"))
        interval = task_config.get("interval_minutes")
        enabled = task_config.get("enabled", True)

        next_run = None
        if enabled and interval and interval > 0 and last_run_dt:
            next_run = last_run_dt + timedelta(minutes=int(interval))

        task_config["next_run"] = next_run

        for ts_field in [
            "last_run",
            "next_run",
            "last_success_time",
            "last_finished_at",
            "last_updated",
        ]:
            if task_config.get(ts_field):
                task_config[ts_field] = serialize_datetime(task_config[ts_field])

    return config


async def _task_schedule_action(
    payload: dict[str, object],
    *,
    success_message: str,
    default_error: str,
    action: str,
) -> dict[str, str]:
    """Apply a task schedule update and standardize success/error handling."""
    try:
        result = await update_task_schedule(payload)
    except Exception as exc:
        logger.exception("Error attempting to %s", action)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    if result.get("status") != "success":
        detail = result.get("message", default_error)
        logger.error("Failed to %s: %s", action, detail)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=detail,
        )

    logger.info("Successfully completed task schedule action: %s", action)
    return {"status": "success", "message": success_message}


async def _enqueue_with_dependencies(
    task_id: str,
    *,
    kwargs: dict[str, Any] | None = None,
    manual_run: bool = True,
) -> dict[str, Any]:
    dependency_check = await check_dependencies(task_id)
    if not dependency_check.get("can_run", False):
        return {
            "task": task_id,
            "success": False,
            "message": dependency_check.get("reason", "Dependencies not met"),
        }

    enqueue_result = await enqueue_task(
        task_id,
        manual_run=manual_run,
        **(kwargs or {}),
    )
    return {
        "task": task_id,
        "success": True,
        "message": f"Task {task_id} scheduled successfully.",
        "job_id": enqueue_result.get("job_id"),
    }


async def _stop_task_instances(task_id: str, reason: str) -> int:
    now = datetime.now(UTC)
    cursor = TaskHistory.find(
        {
            "task_id": task_id,
            "status": {"$in": ["RUNNING", "PENDING"]},
        },
    )

    stopped = 0
    async for entry in cursor:
        job_id = entry.id
        if not job_id:
            continue
        try:
            await abort_job(job_id)
        except Exception as exc:
            logger.warning("Failed to abort job %s: %s", job_id, exc)

        await update_task_history_entry(
            job_id=job_id,
            task_name=task_id,
            status="CANCELLED",
            manual_run=bool(entry.manual_run),
            error=reason,
            end_time=now,
        )
        stopped += 1

    if stopped:
        await update_task_failure(task_id, reason, now)

    return stopped


@router.post("/api/background_tasks/config", response_model=dict[str, str])
@api_route(logger)
async def update_background_tasks_config(
    data: BackgroundTasksConfigModel,
):
    """Update configuration of background tasks."""
    payload = data.dict(exclude_unset=True)
    return await _task_schedule_action(
        payload,
        success_message="Configuration updated",
        default_error="Failed to update task configuration",
        action="update background task configuration",
    )


@router.get("/api/background_tasks/config", response_model=dict[str, Any])
@api_route(logger)
async def get_background_tasks_config():
    """Get current configuration of background tasks."""
    try:
        return await _build_task_snapshot()
    except Exception as e:
        logger.exception(
            "Error getting task configuration",
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/background_tasks/pause", response_model=dict[str, Any])
@api_route(logger)
async def pause_background_tasks(
    data: Annotated[dict[str, object] | None, Body()] = None,
):
    """Pause all background tasks for a specified duration."""
    if data is None:
        data = {"duration": 30}
    minutes = int(data.get("duration", 30))
    await set_global_disable(True)
    return {
        "status": "success",
        "message": f"Background tasks paused for {minutes} minutes",
    }


@router.post("/api/background_tasks/resume", response_model=dict[str, Any])
@api_route(logger)
async def resume_background_tasks():
    """Resume all background tasks."""
    await set_global_disable(False)
    return {"status": "success", "message": "Background tasks resumed"}


@router.post("/api/background_tasks/enable", response_model=dict[str, Any])
@api_route(logger)
async def enable_all_tasks():
    """Enable all scheduled tasks."""
    payload = {"tasks": {task_id: {"enabled": True} for task_id in TASK_DEFINITIONS}}
    return await _task_schedule_action(
        payload,
        success_message="All tasks enabled",
        default_error="Failed to enable tasks",
        action="enable all tasks",
    )


@router.post("/api/background_tasks/disable", response_model=dict[str, Any])
@api_route(logger)
async def disable_all_tasks():
    """Disable all scheduled tasks."""
    payload = {"tasks": {task_id: {"enabled": False} for task_id in TASK_DEFINITIONS}}
    return await _task_schedule_action(
        payload,
        success_message="All tasks disabled",
        default_error="Failed to disable tasks",
        action="disable all tasks",
    )


@router.post("/api/background_tasks/run", response_model=dict[str, Any])
@api_route(logger)
async def run_background_task(
    data: Annotated[dict, Body()],
):
    """Manually trigger a background task."""
    task_id = data.get("task_id")

    if task_id == "ALL":
        config = await get_task_config()
        enabled_tasks = [
            t_name
            for t_name, t_config in config.get("tasks", {}).items()
            if t_config.get("enabled", True)
            and not TASK_DEFINITIONS.get(t_name, {}).get("manual_only", False)
        ]

        results = []
        for task_name in enabled_tasks:
            result = await _enqueue_with_dependencies(task_name, manual_run=True)
            results.append(result)
            await asyncio.sleep(0.05)

        success = all(r.get("success", False) for r in results)
        return {
            "status": ("success" if success else "partial_error"),
            "message": f"Triggered {len(results)} tasks.",
            "results": results,
        }

    if task_id not in TASK_DEFINITIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown or non-runnable task ID: {task_id}",
        )

    if task_id in {"manual_fetch_trips_range", "generate_optimal_route"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This task requires parameters; use the dedicated UI flow.",
        )

    result = await _enqueue_with_dependencies(task_id, manual_run=True)
    return {
        "status": ("success" if result.get("success") else "error"),
        "message": result.get("message", f"Failed to schedule task {task_id}"),
        "task_id": task_id,
        "job_id": result.get("job_id"),
    }


@router.get("/api/background_tasks/details/{task_id}", response_model=dict[str, Any])
@api_route(logger)
async def get_task_details(task_id: str):
    """Get detailed task configuration and recent history."""
    if task_id not in TASK_DEFINITIONS:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown task",
        )

    config = await get_task_config_entry(task_id)
    latest = (
        await TaskHistory.find(TaskHistory.task_id == task_id)
        .sort(-TaskHistory.timestamp)
        .first_or_none()
    )
    run_count = await TaskHistory.find(TaskHistory.task_id == task_id).count()

    next_run = None
    if (
        config.enabled
        and config.interval_minutes
        and config.interval_minutes > 0
        and config.last_run
    ):
        next_run = config.last_run + timedelta(minutes=int(config.interval_minutes))

    return {
        "task_id": task_id,
        "display_name": TASK_DEFINITIONS[task_id].get("display_name"),
        "description": TASK_DEFINITIONS[task_id].get("description"),
        "status": latest.status if latest and latest.status else "IDLE",
        "enabled": config.enabled,
        "interval_minutes": config.interval_minutes,
        "last_run": serialize_datetime(config.last_run),
        "next_run": serialize_datetime(next_run),
        "last_error": config.config.get("last_error"),
        "run_count": run_count,
    }


@router.get("/api/background_tasks/history", response_model=dict[str, Any])
@api_route(logger)
async def get_task_history(page: int = 1, limit: int = 10):
    """Get paginated task execution history."""
    try:
        total_count = await TaskHistory.count()
        total_pages = max(1, math.ceil(total_count / limit))

        skip = (page - 1) * limit
        entries = (
            await TaskHistory.find()
            .sort(-TaskHistory.timestamp)
            .skip(skip)
            .limit(limit)
            .to_list()
        )

        history = []
        for entry in entries:
            entry_dict = {
                "id": str(entry.id),
                "timestamp": entry.timestamp.isoformat() if entry.timestamp else None,
                "task_id": entry.task_id,
                "status": entry.status,
                "result": entry.result,
                "error": entry.error,
            }
            if entry.runtime is not None:
                entry_dict["runtime"] = float(entry.runtime)
            history.append(entry_dict)

        return {
            "history": history,
            "total_count": total_count,
            "total_pages": total_pages,
            "returned_count": len(history),
            "limit": limit,
        }
    except Exception as e:
        logger.exception("Error getting task history")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.delete("/api/background_tasks/history", response_model=dict[str, Any])
@api_route(logger)
async def clear_task_history():
    """Clear all task history."""
    try:
        result = await TaskHistory.delete_many({})
        logger.info(
            "Cleared %d task history entries",
            result.deleted_count,
        )
    except Exception as e:
        logger.exception("Error clearing task history")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
    else:
        return {
            "message": f"Successfully cleared {result.deleted_count} task history entries",
            "deleted_count": result.deleted_count,
        }


@router.post("/api/background_tasks/force_stop", response_model=dict[str, Any])
@api_route(logger)
async def force_stop_task(data: Annotated[dict, Body()]):
    """Force stop a running task."""
    task_id = data.get("task_id")
    if not task_id:
        raise HTTPException(status_code=400, detail="task_id is required")

    if task_id not in TASK_DEFINITIONS:
        raise HTTPException(status_code=404, detail="Unknown task")

    stopped = await _stop_task_instances(task_id, "Task force-stopped by user")
    return {
        "status": "success",
        "message": f"Task {task_id} force-stopped. Cancelled {stopped} instances.",
        "task_id": task_id,
        "cancelled_count": stopped,
    }


@router.post("/api/background_tasks/stop", response_model=dict[str, Any])
@api_route(logger)
async def stop_all_tasks():
    """Stop all running or pending tasks."""
    stopped_total = 0
    for task_id in TASK_DEFINITIONS:
        stopped_total += await _stop_task_instances(
            task_id,
            "Task force-stopped by user",
        )
    return {
        "status": "success",
        "message": f"Stopped {stopped_total} task instance(s).",
        "cancelled_count": stopped_total,
    }


@router.post("/api/background_tasks/reset", response_model=dict[str, Any])
@api_route(logger)
async def reset_task_state():
    """Reset task errors and stop all running tasks."""
    stopped_total = 0
    for task_id in TASK_DEFINITIONS:
        stopped_total += await _stop_task_instances(
            task_id,
            "Task reset by user",
        )
        config = await get_task_config_entry(task_id)
        config.config["last_error"] = None
        config.config["last_finished_at"] = None
        config.last_updated = datetime.now(UTC)
        await config.save()

    return {
        "status": "success",
        "message": f"Reset task state and stopped {stopped_total} task instance(s).",
        "cancelled_count": stopped_total,
    }


@router.post("/api/background_tasks/fetch_trips_range", response_model=dict[str, Any])
@api_route(logger)
async def fetch_trips_manual(data: FetchTripsRangeRequest):
    """Manually trigger trip fetching for a date range."""
    try:
        result = await enqueue_task(
            "manual_fetch_trips_range",
            start_iso=data.start_date.isoformat(),
            end_iso=data.end_date.isoformat(),
            map_match=data.map_match,
            manual_run=True,
        )
        return {
            "status": "success",
            "message": f"Manual fetch scheduled (Job ID: {result.get('job_id')})",
            "job_id": result.get("job_id"),
        }
    except Exception as e:
        logger.exception("Error fetching trips manually")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/background_tasks/sse", response_model=None)
@api_route(logger)
async def stream_background_tasks_updates():
    """Stream real-time background task updates via Server-Sent Events."""

    async def event_generator():
        last_config = None
        poll_count = 0
        max_polls = 3600  # 1 hour at 1 second intervals

        while poll_count < max_polls:
            poll_count += 1

            try:
                current_config = await _build_task_snapshot()
                current_tasks = current_config.get("tasks", {})

                if last_config is not None:
                    updates = {}
                    for task_id, task_data in current_tasks.items():
                        if task_id not in last_config.get("tasks", {}):
                            updates[task_id] = task_data
                            continue

                        prev_data = last_config["tasks"][task_id]
                        changed = False
                        for key in [
                            "status",
                            "last_run",
                            "next_run",
                            "last_error",
                        ]:
                            if task_data.get(key) != prev_data.get(key):
                                changed = True
                                break
                        if changed:
                            updates[task_id] = task_data

                    if updates:
                        yield f"data: {json.dumps(updates)}\n\n"
                    elif poll_count % 15 == 0:
                        yield ": keepalive\n\n"

                last_config = current_config
                await asyncio.sleep(1)

            except Exception:
                logger.exception("Error in background tasks SSE")
                await asyncio.sleep(1)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
