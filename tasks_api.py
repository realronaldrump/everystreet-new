import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from math import ceil

from fastapi import APIRouter, Body, HTTPException, Request, status
from fastapi.responses import StreamingResponse

from db import (
    SerializationHelper,
    count_documents_with_retry,
    db_manager,
    delete_many_with_retry,
    find_with_retry,
    update_many_with_retry,
    update_one_with_retry,
)
from models import BackgroundTasksConfigModel
from tasks import (
    TASK_METADATA,
    TaskPriority,
    TaskStatus,
    get_all_task_metadata,
    get_task_config,
    manual_run_task,
    update_task_schedule,
)

logger = logging.getLogger(__name__)
router = APIRouter()

task_config_collection = db_manager.db["task_config"]
task_history_collection = db_manager.db["task_history"]


@router.post("/api/background_tasks/config")
async def update_background_tasks_config(
    data: BackgroundTasksConfigModel,
):
    """Update the configuration of background tasks."""
    try:
        result = await update_task_schedule(data.dict(exclude_unset=True))

        if result.get("status") != "success":
            logger.error(
                "Failed to update task schedule: %r",
                result,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get("message", "Unknown error"),
            )
        return {
            "status": "success",
            "message": "Configuration updated",
        }

    except HTTPException as exc:
        logger.warning(
            "HTTPException in update_background_tasks_config: %s",
            exc,
            exc_info=True,
        )
        raise
    except Exception as e:
        logger.exception(
            "Error updating task configuration: %s",
            e,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/background_tasks/config")
async def get_background_tasks_config():
    """Get the current configuration of background tasks."""
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
            task_config["priority"] = task_def.get(
                "priority",
                TaskPriority.MEDIUM.name,
            )

            task_config["status"] = task_config.get("status", "IDLE")
            task_config["interval_minutes"] = task_config.get(
                "interval_minutes",
                task_def.get("default_interval_minutes"),
            )

            last_run = task_config.get("last_run")
            interval = task_config.get("interval_minutes")
            enabled = task_config.get("enabled", True)
            next_run = None
            if enabled and interval and interval > 0 and last_run:
                try:
                    if isinstance(last_run, str):
                        last_run_dt = datetime.fromisoformat(
                            last_run.replace("Z", "+00:00"),
                        )
                    else:
                        last_run_dt = last_run
                    if last_run_dt.tzinfo is None:
                        last_run_dt = last_run_dt.replace(
                            tzinfo=timezone.utc
                        )  # Make sure timezone is set
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
    minutes: int = 30,
):
    """Pause all background tasks for a specified duration."""
    try:
        result = await update_task_schedule(
            {
                "globalDisable": True,
                "pauseMinutes": minutes,
            },
        )
        if result.get("status") != "success":
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get(
                    "message",
                    "Failed to pause tasks",
                ),
            )
        return {
            "status": "success",
            "message": f"Background tasks paused for {minutes} minutes",
        }
    except HTTPException as exc:
        logger.warning(
            "HTTPException in pause_background_tasks: %s",
            exc,
            exc_info=True,
        )
        raise
    except Exception as e:
        logger.exception("Error pausing tasks: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/background_tasks/resume")
async def resume_background_tasks():
    """Resume all paused background tasks."""
    try:
        await update_task_schedule({"globalDisable": False})
        return {
            "status": "success",
            "message": "Background tasks resumed",
        }
    except Exception as e:
        logger.exception("Error resuming tasks: %s", str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/background_tasks/stop")
async def stop_all_background_tasks():
    """Stop all currently running background tasks."""
    try:
        result = await update_task_schedule({"globalDisable": True})
        if result.get("status") != "success":
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get(
                    "message",
                    "Failed to stop tasks",
                ),
            )
        return {
            "status": "success",
            "message": "All background tasks stopped",
        }
    except HTTPException as exc:
        logger.warning(
            "HTTPException in stop_all_background_tasks: %s",
            exc,
            exc_info=True,
        )
        raise
    except Exception as e:
        logger.exception("Error stopping all tasks: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/background_tasks/enable")
async def enable_all_background_tasks():
    """Enable all background tasks."""
    try:
        tasks_update = {tid: {"enabled": True} for tid in TASK_METADATA}
        result = await update_task_schedule({"tasks": tasks_update})
        if result.get("status") != "success":
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get(
                    "message",
                    "Failed to enable tasks",
                ),
            )
        return {
            "status": "success",
            "message": "All background tasks enabled",
        }
    except HTTPException as exc:
        logger.warning(
            "HTTPException in enable_all_background_tasks: %s",
            exc,
            exc_info=True,
        )
        raise
    except Exception as e:
        logger.exception("Error enabling all tasks: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/background_tasks/disable")
async def disable_all_background_tasks():
    """Disable all background tasks."""
    try:
        tasks_update = {tid: {"enabled": False} for tid in TASK_METADATA}
        result = await update_task_schedule({"tasks": tasks_update})
        if result.get("status") != "success":
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get(
                    "message",
                    "Failed to disable tasks",
                ),
            )
        return {
            "status": "success",
            "message": "All background tasks disabled",
        }
    except HTTPException as exc:
        logger.warning(
            "HTTPException in disable_all_background_tasks: %s",
            exc,
            exc_info=True,
        )
        raise
    except Exception as e:
        logger.exception("Error disabling all tasks: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/background_tasks/run")
async def manual_run_tasks(
    tasks_to_run: list[str] = Body(...),
):
    """Manually trigger one or more background tasks."""
    if not tasks_to_run:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No tasks specified to run",
        )
    results = []
    for task_id in tasks_to_run:
        if task_id == "ALL":
            res = await manual_run_task("ALL")
        elif task_id in TASK_METADATA:
            res = await manual_run_task(task_id)
        else:
            res = {
                "status": "error",
                "message": "Unknown task",
            }
        success = res.get("status") == "success"
        results.append(
            {
                "task": task_id,
                "success": success,
                "message": res.get("message"),
                "task_id": res.get("task_id"),
            },
        )
    return {
        "status": "success",
        "results": results,
    }


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

        history_docs = await find_with_retry(
            task_history_collection,
            {"task_id": task_id},
            sort=[("timestamp", -1)],
            limit=5,
        )

        history = []
        for entry in history_docs:
            entry["_id"] = str(entry["_id"])
            history.append(
                {
                    "timestamp": SerializationHelper.serialize_datetime(
                        entry.get("timestamp"),
                    ),
                    "status": entry["status"],
                    "runtime": entry.get("runtime"),
                    "error": entry.get("error"),
                },
            )

        return {
            "id": task_id,
            "display_name": task_def["display_name"],
            "description": task_def["description"],
            "priority": (
                task_def["priority"].name
                if hasattr(task_def["priority"], "name")
                else str(task_def["priority"])
            ),
            "dependencies": task_def["dependencies"],
            "status": task_config.get("status", "IDLE"),
            "enabled": task_config.get("enabled", True),
            "interval_minutes": task_config.get(
                "interval_minutes",
                task_def["default_interval_minutes"],
            ),
            "last_run": SerializationHelper.serialize_datetime(
                task_config.get("last_run"),
            ),
            "next_run": SerializationHelper.serialize_datetime(
                task_config.get("next_run"),
            ),
            "start_time": SerializationHelper.serialize_datetime(
                task_config.get("start_time"),
            ),
            "end_time": SerializationHelper.serialize_datetime(
                task_config.get("end_time"),
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
        total_count = await count_documents_with_retry(
            task_history_collection,
            {},
        )
        skip = (page - 1) * limit
        entries = await find_with_retry(
            task_history_collection,
            {},
            sort=[("timestamp", -1)],
            skip=skip,
            limit=limit,
        )

        history = []
        for entry in entries:
            entry["_id"] = str(entry["_id"])
            entry["timestamp"] = SerializationHelper.serialize_datetime(
                entry.get("timestamp"),
            )
            if "runtime" in entry:
                entry["runtime"] = float(entry["runtime"]) if entry["runtime"] else None
            history.append(entry)

        return {
            "history": history,
            "total": total_count,
            "page": page,
            "limit": limit,
            "total_pages": ceil(total_count / limit),
        }
    except Exception as e:
        logger.exception(
            "Error fetching task history: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/background_tasks/history/clear")
async def clear_task_history():
    """Clear all task execution history."""
    try:
        result = await delete_many_with_retry(task_history_collection, {})
        return {
            "status": "success",
            "message": f"Cleared {result.deleted_count} task history entries",
        }
    except Exception as e:
        logger.exception(
            "Error clearing task history: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.post("/api/background_tasks/reset")
async def reset_task_states():
    """Reset any stuck 'RUNNING' tasks to 'FAILED' state with safeguards."""
    try:
        now = datetime.now(timezone.utc)
        stuck_threshold = timedelta(hours=2)
        reset_count = 0
        skipped_count = 0

        config = await get_task_config()
        tasks_config = config.get("tasks", {})
        updates = {}

        for (
            task_id,
            task_info,
        ) in tasks_config.items():
            if task_info.get("status") != TaskStatus.RUNNING.value:
                continue

            start_time_any = task_info.get("start_time")
            start_time = None

            if isinstance(start_time_any, datetime):
                start_time = start_time_any
            elif isinstance(start_time_any, str):
                try:
                    start_time = datetime.fromisoformat(
                        start_time_any.replace("Z", "+00:00"),
                    )
                except ValueError:
                    for fmt in (
                        "%Y-%m-%dT%H:%M:%S.%f%z",
                        "%Y-%m-%dT%H:%M:%S%z",
                        "%Y-%m-%dT%H:%M:%S.%f",
                        "%Y-%m-%dT%H:%M:%S",
                    ):
                        try:
                            start_time = datetime.strptime(
                                start_time_any,
                                fmt,
                            )
                            break
                        except ValueError:
                            continue
                    if not start_time:
                        logger.warning(
                            "Could not parse start_time string '%s' for task %s",
                            start_time_any,
                            task_id,
                        )

            if not start_time:
                updates[f"tasks.{task_id}.status"] = TaskStatus.FAILED.value
                updates[f"tasks.{task_id}.last_error"] = (
                    "Task reset: status RUNNING, invalid/missing start_time"
                )
                updates[f"tasks.{task_id}.end_time"] = now
                reset_count += 1
                logger.warning(
                    "Resetting task %s due to missing/invalid start_time.",
                    task_id,
                )
            else:
                if start_time.tzinfo is None:
                    start_time = start_time.replace(
                        tzinfo=timezone.utc
                    )  # Make sure timezone is set

                runtime = now - start_time
                if runtime > stuck_threshold:
                    updates[f"tasks.{task_id}.status"] = TaskStatus.FAILED.value
                    updates[f"tasks.{task_id}.last_error"] = (
                        f"Task reset: ran for > {stuck_threshold}"
                    )
                    updates[f"tasks.{task_id}.end_time"] = now
                    reset_count += 1
                    logger.warning(
                        "Resetting task %s running since %s.",
                        task_id,
                        start_time,
                    )
                else:
                    skipped_count += 1
                    logger.info(
                        "Task %s running for %s, not stuck yet.",
                        task_id,
                        runtime,
                    )

        history_result = await update_many_with_retry(
            task_history_collection,
            {
                "status": TaskStatus.RUNNING.value,
                "start_time": {"$lt": now - stuck_threshold},
            },
            {
                "$set": {
                    "status": TaskStatus.FAILED.value,
                    "error": "Task reset: history entry stuck in RUNNING state",
                    "end_time": now,
                },
            },
        )
        history_reset_count = history_result.modified_count if history_result else 0

        if updates:
            config_update_result = await update_one_with_retry(
                task_config_collection,
                {"_id": "global_background_task_config"},
                {"$set": updates},
            )
            if not config_update_result or config_update_result.modified_count == 0:
                logger.warning(
                    "Attempted to reset task states in config, but no document was modified.",
                )

        return {
            "status": "success",
            "message": f"Reset {reset_count} stuck tasks, skipped {skipped_count}. Reset {history_reset_count} history entries.",
            "reset_count": reset_count,
            "skipped_count": skipped_count,
            "history_reset_count": history_reset_count,
        }
    except Exception as e:
        logger.exception(
            "Error resetting task states: %s",
            str(e),
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )


@router.get("/api/background_tasks/sse")
async def background_tasks_sse(request: Request):
    """Provides server-sent events for real-time task status updates."""

    async def event_generator():
        try:
            while True:
                if await request.is_disconnected():
                    logger.info("SSE client disconnected")
                    break

                config = await get_task_config()

                updates = {}
                for (
                    task_id,
                    task_config,
                ) in config.get("tasks", {}).items():
                    status = task_config.get("status", "IDLE")
                    updates[task_id] = {
                        "status": status,
                        "last_updated": SerializationHelper.serialize_datetime(
                            task_config.get("last_updated"),
                        ),
                        "last_run": SerializationHelper.serialize_datetime(
                            task_config.get("last_run"),
                        ),
                        "next_run": SerializationHelper.serialize_datetime(
                            task_config.get("next_run"),
                        ),
                        "last_error": task_config.get("last_error"),
                    }

                yield f"data: {json.dumps(updates)}\\n\\n"

                await asyncio.sleep(2)
        except asyncio.CancelledError:
            logger.info("SSE connection closed")
        except Exception as e:
            logger.error("Error in SSE generator: %s", e)
            yield f"data: {json.dumps({'error': str(e)})}\\n\\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )
