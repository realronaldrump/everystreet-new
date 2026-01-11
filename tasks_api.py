import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, Body, HTTPException, status
from pydantic import BaseModel

from date_utils import normalize_to_utc_datetime
from db.models import TaskHistory
from models import BackgroundTasksConfigModel
from tasks import (
    TASK_METADATA,
    force_reset_task,
    get_all_task_metadata,
    get_task_config,
    trigger_fetch_all_missing_trips,
    trigger_manual_fetch_trips_range,
    update_task_schedule,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class ForceStopRequest(BaseModel):
    task_id: str
    reason: str | None = None


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
    data: dict[str, object] = Body(default={"duration": 30}),
):
    """Pause all background tasks for a specified duration."""
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
    data: dict = Body(...),
):
    """Manually trigger a background task."""
    task_id = data.get("task_id")
    return await _task_schedule_action(
        {"task_id": task_id, "trigger": "manual"},
        success_message=f"Task {task_id} triggered successfully",
        default_error=f"Failed to trigger task {task_id}",
        action=f"manually run task {task_id}",
    )


@router.get("/api/background_tasks/status/{task_id}")
async def get_task_status(task_id: str):
    """Get current status of a background task."""
    from celery.result import AsyncResult

    from celery_app import app as celery_app

    try:
        if task_id not in TASK_METADATA:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Task {task_id} not found",
            )

        history = (
            await TaskHistory.find(TaskHistory.id == task_id)
            .sort(-TaskHistory.timestamp)
            .limit(1)
            .to_list()
        )

        if history:
            history_entry = history[0]
            return {
                "task_id": task_id,
                "status": history_entry.status,
                "result": history_entry.result,
                "error": history_entry.error,
                "start_time": (
                    history_entry.start_time.isoformat()
                    if history_entry.start_time
                    else None
                ),
                "end_time": (
                    history_entry.end_time.isoformat()
                    if history_entry.end_time
                    else None
                ),
                "runtime_ms": history_entry.runtime,
            }

        result = AsyncResult(task_id, app=celery_app)
        response = {
            "task_id": task_id,
            "status": result.status,
            "result": None,
            "error": None,
        }

        if result.ready():
            if result.successful():
                response["result"] = result.result
            elif result.failed():
                response["error"] = str(result.result)

        return response
    except Exception as exc:
        logger.exception("Error getting task status for %s: %s", task_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get task status: {exc}",
        ) from exc


@router.get("/api/background_tasks/task/{task_id}")
async def get_task_details(task_id: str):
    """Get detailed information about a specific task."""
    try:
        if task_id not in TASK_METADATA:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Task {task_id} not found",
            )

        task_def = TASK_METADATA[task_id]
        config = await get_task_config()
        task_config = config.get("tasks", {}).get(task_id, {})

        history_docs = (
            await TaskHistory.find(TaskHistory.task_id == task_id)
            .sort(-TaskHistory.timestamp)
            .limit(5)
            .to_list()
        )

        history = []
        for entry in history_docs:
            history.append(
                {
                    "id": str(entry.id),
                    "timestamp": entry.timestamp.isoformat(),
                    "status": entry.status,
                    "runtime": entry.runtime,
                    "error": entry.error,
                },
            )

        return {
            "id": task_id,
            "display_name": task_def["display_name"],
            "description": task_def["description"],
            "dependencies": task_def["dependencies"],
            "status": task_config.get("status", "IDLE"),
            "enabled": task_config.get("enabled", True),
            "interval_minutes": task_config.get(
                "interval_minutes",
                task_def["default_interval_minutes"],
            ),
            "last_run": (
                task_config.get("last_run").isoformat()
                if task_config.get("last_run")
                else None
            ),
            "next_run": (
                task_config.get("next_run").isoformat()
                if task_config.get("next_run")
                else None
            ),
            "start_time": (
                task_config.get("start_time").isoformat()
                if task_config.get("start_time")
                else None
            ),
            "end_time": (
                task_config.get("end_time").isoformat()
                if task_config.get("end_time")
                else None
            ),
            "last_error": task_config.get("last_error"),
            "history": history,
        }
    except Exception as e:
        logger.exception(
            "Error getting task details for %s: %s",
            task_id,
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
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
async def reset_task(data: dict = Body(...)):
    """Force reset a stuck task."""
    task_id = data.get("task_id")
    result = await force_reset_task(task_id)
    return result


@router.post("/api/background_tasks/update_schedule")
async def update_task_schedule_endpoint(data: dict = Body(...)):
    """Update a single task's schedule."""
    task_id = data.get("task_id")
    if not task_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing task_id",
        )
    payload = {k: v for k, v in data.items() if k != "task_id"}
    return await _task_schedule_action(
        payload,
        success_message=f"Schedule updated for task {task_id}",
        default_error=f"Failed to update schedule for task {task_id}",
        action=f"update schedule for task {task_id}",
    )


@router.post("/api/background_tasks/fetch_trips")
async def fetch_trips_manual(data: FetchTripsRangeRequest):
    """Manually trigger trip fetching for a date range."""
    try:
        result = await trigger_manual_fetch_trips_range(
            data.start_date,
            data.end_date,
            data.map_match,
        )
        return result
    except Exception as e:
        logger.exception("Error fetching trips manually: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/background_tasks/fetch_missing_trips")
async def fetch_missing_trips():
    """Manually trigger fetch all missing trips task."""
    try:
        result = await trigger_fetch_all_missing_trips()
        return result
    except Exception as e:
        logger.exception("Error fetching missing trips: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
