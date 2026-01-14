import asyncio
import json
import logging
from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Body, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from date_utils import normalize_to_utc_datetime
from db.models import TaskHistory
from db.schemas import BackgroundTasksConfigModel
from tasks.config import get_task_config
from tasks.management import (
    force_reset_task,
    get_all_task_metadata,
    trigger_manual_fetch_trips_range,
    update_task_schedule,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class FetchTripsRangeRequest(BaseModel):
    start_date: datetime
    end_date: datetime
    map_match: bool = False


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
        logger.exception("Error attempting to %s: %s", action, exc)
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


@router.post("/api/background_tasks/config")
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


@router.get("/api/background_tasks/config")
async def get_background_tasks_config():
    """Get current configuration of background tasks."""
    try:
        config = await get_task_config()
        task_metadata = await get_all_task_metadata()

        for (
            task_id,
            task_def,
        ) in task_metadata.items():
            if task_id not in config.get("tasks", {}):
                config.setdefault("tasks", {})[task_id] = {}

            task_config = config["tasks"][task_id]

            task_config["display_name"] = task_def.get(
                "display_name",
                "Unknown Task",
            )
            task_config["description"] = task_def.get("description", "")
            task_config["manual_only"] = task_def.get("manual_only", False)

            task_config["status"] = task_config.get("status", "IDLE")
            task_config["interval_minutes"] = task_config.get(
                "interval_minutes",
                task_def.get("default_interval_minutes"),
            )

            last_run = task_config.get("last_run")
            interval = task_config.get("interval_minutes")
            enabled = task_config.get("enabled", True)
            next_run = None
            last_run_dt = normalize_to_utc_datetime(last_run) if last_run else None
            if enabled and interval and interval > 0 and last_run_dt:
                try:
                    next_run_dt = last_run_dt + timedelta(minutes=interval)
                    next_run = next_run_dt.isoformat()
                except Exception:
                    next_run = None
            task_config["next_run"] = next_run

            for ts_field in [
                "last_run",
                "next_run",
                "start_time",
                "end_time",
                "last_updated",
            ]:
                if task_config.get(ts_field):
                    task_config[ts_field] = (
                        task_config[ts_field]
                        if isinstance(
                            task_config[ts_field],
                            str,
                        )
                        else task_config[ts_field].isoformat()
                    )

        return config
    except Exception as e:
        logger.exception(
            "Error getting task configuration: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/background_tasks/pause")
async def pause_background_tasks(
    data: Annotated[dict[str, object] | None, Body()] = None,
):
    """Pause all background tasks for a specified duration."""
    if data is None:
        data = {"duration": 30}
    minutes = int(data.get("duration", 30))
    return await _task_schedule_action(
        {"globalDisable": True},
        success_message=f"Background tasks paused for {minutes} minutes",
        default_error="Failed to pause tasks",
        action=f"pause background tasks for {minutes} minutes",
    )


@router.post("/api/background_tasks/resume")
async def resume_background_tasks():
    """Resume all background tasks."""
    return await _task_schedule_action(
        {"globalDisable": False},
        success_message="Background tasks resumed",
        default_error="Failed to resume tasks",
        action="resume background tasks",
    )


@router.post("/api/background_tasks/run")
async def run_background_task(
    data: Annotated[dict, Body()],
):
    """Manually trigger a background task."""
    task_id = data.get("task_id")
    return await _task_schedule_action(
        {"task_id": task_id, "trigger": "manual"},
        success_message=f"Task {task_id} triggered successfully",
        default_error=f"Failed to trigger task {task_id}",
        action=f"manually run task {task_id}",
    )


@router.get("/api/background_tasks/history")
async def get_task_history(page: int = 1, limit: int = 10):
    """Get paginated task execution history."""
    try:
        total_count = await TaskHistory.count()

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
                "timestamp": entry.timestamp.isoformat(),
                "task_id": entry.task_id,
                "status": entry.status,
                "result": entry.result,
                "error": entry.error,
            }
            if entry.runtime:
                entry_dict["runtime"] = float(entry.runtime)
            history.append(entry_dict)

        return {
            "history": history,
            "total_count": total_count,
            "returned_count": len(history),
            "limit": limit,
        }
    except Exception as e:
        logger.exception("Error getting task history: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.delete("/api/background_tasks/history")
async def clear_task_history():
    """Clear all task history."""
    try:
        result = await TaskHistory.delete_many({})
        logger.info(
            "Cleared %d task history entries",
            result.deleted_count,
        )
        return {
            "message": f"Successfully cleared {result.deleted_count} task history entries",
            "deleted_count": result.deleted_count,
        }
    except Exception as e:
        logger.exception("Error clearing task history: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/background_tasks/reset")
async def reset_task(data: Annotated[dict, Body()]):
    """Force reset a stuck task."""
    task_id = data.get("task_id")
    return await force_reset_task(task_id)


@router.post("/api/background_tasks/fetch_trips")
async def fetch_trips_manual(data: FetchTripsRangeRequest):
    """Manually trigger trip fetching for a date range."""
    try:
        return await trigger_manual_fetch_trips_range(
            data.start_date,
            data.end_date,
            data.map_match,
        )
    except Exception as e:
        logger.exception("Error fetching trips manually: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/background_tasks/sse")
async def stream_background_tasks_updates():
    """Stream real-time background task updates via Server-Sent Events."""

    async def event_generator():
        last_config = None
        poll_count = 0
        max_polls = 3600  # 1 hour at 1 second intervals

        while poll_count < max_polls:
            poll_count += 1

            try:
                current_config = await get_task_config()
                current_tasks = current_config.get("tasks", {})

                if last_config is not None:
                    # Find changes
                    updates = {}
                    for task_id, task_data in current_tasks.items():
                        if task_id not in last_config.get("tasks", {}):
                            # New task
                            updates[task_id] = task_data
                        else:
                            # Check for changes
                            prev_data = last_config["tasks"][task_id]
                            changed = False
                            for key in ["status", "last_run", "next_run", "last_error"]:
                                if task_data.get(key) != prev_data.get(key):
                                    changed = True
                                    break
                            if changed:
                                updates[task_id] = task_data

                    # Send updates if any
                    if updates:
                        yield f"data: {json.dumps(updates)}\n\n"

                last_config = current_config

                await asyncio.sleep(1)

            except Exception as e:
                logger.exception("Error in background tasks SSE: %s", e)
                await asyncio.sleep(1)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
