"""Service layer for trip sync actions and status."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from fastapi import HTTPException, status

from config import get_bouncie_config
from core.serialization import serialize_datetime
from db.models import Job, TaskHistory, Trip
from tasks.config import (
    get_global_disable,
    get_task_config_entry,
    update_task_history_entry,
    update_task_schedule,
)
from tasks.ops import abort_job, enqueue_task
from trips.services.trip_history_import_service import (
    build_import_plan,
    resolve_import_start_dt_from_db,
)

if TYPE_CHECKING:
    from trips.models import TripSyncConfigUpdate, TripSyncRequest

logger = logging.getLogger(__name__)

SYNC_TASK_IDS = (
    "periodic_fetch_trips",
    "manual_fetch_trips_range",
    "fetch_all_missing_trips",
)


def _credentials_configured(credentials: dict[str, Any]) -> bool:
    required = [
        "client_id",
        "client_secret",
        "redirect_uri",
    ]
    return all(credentials.get(field) for field in required)


def _auth_connected(credentials: dict[str, Any]) -> bool:
    return _credentials_configured(credentials) and bool(
        credentials.get("authorization_code"),
    )


def _devices_configured(credentials: dict[str, Any]) -> bool:
    return bool(credentials.get("authorized_devices"))


class TripSyncService:
    """Trips-first sync orchestration and status."""

    @staticmethod
    async def get_sync_status() -> dict[str, Any]:
        credentials = await get_bouncie_config()
        credentials_ready = _credentials_configured(credentials)
        auth_connected = _auth_connected(credentials)
        devices_ready = _devices_configured(credentials)
        last_auth_error = credentials.get("last_auth_error")
        global_disabled = await get_global_disable()
        trip_count = await Trip.count()

        task_config = await get_task_config_entry("periodic_fetch_trips")
        auto_sync_enabled = bool(task_config.enabled)
        auto_sync_interval_minutes = task_config.interval_minutes

        active = (
            await TaskHistory.find(
                {
                    "task_id": {"$in": list(SYNC_TASK_IDS)},
                    "status": {"$in": ["RUNNING", "PENDING"]},
                },
            )
            .sort("-timestamp")
            .first_or_none()
        )

        last_attempt = (
            await TaskHistory.find(
                {"task_id": {"$in": list(SYNC_TASK_IDS)}},
            )
            .sort("-timestamp")
            .first_or_none()
        )

        last_success = (
            await TaskHistory.find(
                {"task_id": {"$in": list(SYNC_TASK_IDS)}, "status": "COMPLETED"},
            )
            .sort("-timestamp")
            .first_or_none()
        )

        last_failure = (
            await TaskHistory.find(
                {"task_id": {"$in": list(SYNC_TASK_IDS)}, "status": "FAILED"},
            )
            .sort("-timestamp")
            .first_or_none()
        )

        last_success_at = (
            last_success.end_time
            if last_success and last_success.end_time
            else (last_success.timestamp if last_success else None)
        )
        if not last_success_at:
            last_success_at = task_config.config.get("last_success_time")

        last_success_dt: datetime | None = None
        if isinstance(last_success_at, datetime):
            last_success_dt = last_success_at
        elif isinstance(last_success_at, str):
            try:
                last_success_dt = datetime.fromisoformat(last_success_at)
            except ValueError:
                last_success_dt = None

        last_attempt_at = last_attempt.timestamp if last_attempt else None

        status_payload: dict[str, Any] = {
            "state": "idle",
            "last_success_at": serialize_datetime(last_success_at),
            "last_attempt_at": serialize_datetime(last_attempt_at),
            "current_job_id": str(active.id) if active and active.id else None,
            "active_task_id": active.task_id if active else None,
            "active_task_status": active.status if active else None,
            "started_at": serialize_datetime(
                active.start_time if active and active.start_time else None,
            ),
            "auto_sync_enabled": auto_sync_enabled,
            "auto_sync_interval_minutes": auto_sync_interval_minutes,
            "global_disabled": global_disabled,
            "trip_count": trip_count,
            "pause_reason": None,
            "error": None,
        }

        if (
            active
            and active.task_id == "fetch_all_missing_trips"
            and active.id
        ):
            progress_job = await Job.find_one(
                {
                    "job_type": "trip_history_import",
                    "operation_id": str(active.id),
                    "status": {"$in": ["pending", "running"]},
                },
            )
            if progress_job and progress_job.id:
                progress_job_id = str(progress_job.id)
                status_payload.update(
                    {
                        "history_import_progress_job_id": progress_job_id,
                        "history_import_progress_url": (
                            f"/api/actions/trips/sync/history_import/{progress_job_id}"
                        ),
                        "history_import_progress_sse_url": (
                            f"/api/actions/trips/sync/history_import/{progress_job_id}/sse"
                        ),
                    },
                )

        if not credentials_ready:
            status_payload.update(
                {
                    "state": "paused",
                    "pause_reason": "credentials_missing",
                    "error": {
                        "code": "credentials_missing",
                        "message": "Bouncie credentials are incomplete.",
                        "cta_label": "Update credentials",
                        "cta_href": "/profile",
                    },
                },
            )
            return status_payload

        if last_auth_error in {
            "auth_invalid",
            "token_exchange_failed",
            "redirect_uri_mismatch",
        }:
            status_payload.update(
                {
                    "state": "paused",
                    "pause_reason": "auth_invalid",
                    "error": {
                        "code": "auth_invalid",
                        "message": "Bouncie authorization expired. Reconnect to continue syncing.",
                        "cta_label": "Reconnect",
                        "cta_href": "/api/bouncie/authorize",
                    },
                },
            )
            return status_payload

        if not auth_connected:
            status_payload.update(
                {
                    "state": "paused",
                    "pause_reason": "auth_required",
                    "error": {
                        "code": "auth_required",
                        "message": "Connect Bouncie to sync trips.",
                        "cta_label": "Connect",
                        "cta_href": "/api/bouncie/authorize",
                    },
                },
            )
            return status_payload

        if not devices_ready:
            status_payload.update(
                {
                    "state": "paused",
                    "pause_reason": "devices_required",
                    "error": {
                        "code": "devices_required",
                        "message": "Sync vehicles to enable trip fetching.",
                        "cta_label": "Sync vehicles",
                        "cta_href": "/profile",
                    },
                },
            )
            return status_payload

        if global_disabled:
            status_payload.update(
                {
                    "state": "paused",
                    "pause_reason": "disabled",
                    "error": {
                        "code": "sync_paused",
                        "message": "Trip sync is paused in settings.",
                        "cta_label": "Sync settings",
                        "cta_href": "/settings#sync-settings",
                    },
                },
            )
            return status_payload

        if active:
            status_payload.update({"state": "syncing"})
            return status_payload

        if last_failure:
            last_failure_at = last_failure.timestamp
            if not last_success_dt or (
                last_failure_at
                and last_success_dt
                and last_failure_at > last_success_dt
            ):
                status_payload.update(
                    {
                        "state": "error",
                        "error": {
                            "code": "sync_failed",
                            "message": last_failure.error or "Trip sync failed.",
                            "cta_label": "View activity",
                            "cta_href": "/settings#sync-settings",
                        },
                    },
                )

        return status_payload

    @staticmethod
    async def get_sync_config() -> dict[str, Any]:
        task_config = await get_task_config_entry("periodic_fetch_trips")
        return {
            "auto_sync_enabled": bool(task_config.enabled),
            "interval_minutes": task_config.interval_minutes,
            "global_disabled": await get_global_disable(),
            "last_success_at": serialize_datetime(
                task_config.config.get("last_success_time"),
            ),
        }

    @staticmethod
    async def update_sync_config(config: TripSyncConfigUpdate) -> dict[str, Any]:
        payload: dict[str, Any] = {"tasks": {"periodic_fetch_trips": {}}}
        changes = payload["tasks"]["periodic_fetch_trips"]

        if config.auto_sync_enabled is not None:
            changes["enabled"] = config.auto_sync_enabled
        if config.interval_minutes is not None:
            changes["interval_minutes"] = config.interval_minutes

        if not changes:
            return await TripSyncService.get_sync_config()

        result = await update_task_schedule(payload)
        if result.get("status") != "success":
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get("message", "Failed to update sync settings"),
            )

        return await TripSyncService.get_sync_config()

    @staticmethod
    async def start_sync(request: TripSyncRequest) -> dict[str, Any]:
        status_snapshot = await TripSyncService.get_sync_status()
        if status_snapshot.get("state") == "paused":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Trip sync is unavailable. Check credentials or settings.",
            )

        if status_snapshot.get("state") == "syncing" and not request.force:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Trip sync is already in progress.",
            )

        if request.mode == "recent":
            result = await enqueue_task(
                "periodic_fetch_trips",
                manual_run=True,
                trigger_source=request.trigger_source or "manual",
            )
            return {"status": "success", "job_id": result.get("job_id")}

        if request.mode == "history":
            active = (
                await Job.find(
                    {"job_type": "trip_history_import", "status": {"$in": ["pending", "running"]}},
                )
                .sort("-created_at")
                .first_or_none()
            )
            if active and not request.force:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Trip history import is already in progress.",
                )

            start_dt = await resolve_import_start_dt_from_db(request.start_date)
            end_dt = datetime.now(UTC)

            plan = await build_import_plan(start_dt=start_dt, end_dt=end_dt)
            devices = list(plan.get("devices") or [])

            now = datetime.now(UTC)
            job = Job(
                job_type="trip_history_import",
                task_id="fetch_all_missing_trips",
                status="pending",
                stage="queued",
                progress=0.0,
                message="Queued",
                created_at=now,
                updated_at=now,
                metadata={
                    "start_iso": plan.get("start_iso"),
                    "end_iso": plan.get("end_iso"),
                    "window_days": plan.get("window_days"),
                    "overlap_hours": plan.get("overlap_hours"),
                    "step_hours": plan.get("step_hours"),
                    "devices": devices,
                    "windows_total": plan.get("windows_total", 0),
                    "windows_completed": 0,
                    "current_window": None,
                    "counters": {
                        "found_raw": 0,
                        "found_unique": 0,
                        "skipped_existing": 0,
                        "skipped_missing_end_time": 0,
                        "new_candidates": 0,
                        "inserted": 0,
                        "fetch_errors": 0,
                        "process_errors": 0,
                    },
                    "per_device": {
                        d.get("imei"): {
                            "windows_completed": 0,
                            "found_raw": 0,
                            "found_unique": 0,
                            "skipped_existing": 0,
                            "new_candidates": 0,
                            "inserted": 0,
                            "errors": 0,
                        }
                        for d in devices
                        if d.get("imei")
                    },
                    "events": [],
                },
            )
            await job.insert()
            if not job.id:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to create progress job.",
                )

            result = await enqueue_task(
                "fetch_all_missing_trips",
                manual_run=True,
                start_iso=start_dt.isoformat(),
                progress_job_id=str(job.id),
            )

            job.operation_id = result.get("job_id")
            job.updated_at = datetime.now(UTC)
            await job.save()

            progress_job_id = str(job.id)
            return {
                "status": "success",
                "job_id": result.get("job_id"),
                "progress_job_id": progress_job_id,
                "progress_url": f"/api/actions/trips/sync/history_import/{progress_job_id}",
                "progress_sse_url": f"/api/actions/trips/sync/history_import/{progress_job_id}/sse",
            }

        if request.mode == "range":
            if not request.start_date or not request.end_date:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Start and end dates are required for range sync.",
                )
            if request.end_date <= request.start_date:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="End date must be after start date.",
                )
            result = await enqueue_task(
                "manual_fetch_trips_range",
                start_iso=request.start_date.isoformat(),
                end_iso=request.end_date.isoformat(),
                map_match=request.map_match,
                manual_run=True,
            )
            return {"status": "success", "job_id": result.get("job_id")}

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported sync mode.",
        )

    @staticmethod
    async def cancel_sync(job_id: str) -> dict[str, Any]:
        if not job_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="job_id is required.",
            )

        history = await TaskHistory.get(job_id)
        if not history:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Sync job not found.",
            )

        await abort_job(job_id)
        await update_task_history_entry(
            job_id=job_id,
            task_name=history.task_id or "trip_sync",
            status="CANCELLED",
            manual_run=bool(history.manual_run),
            error="Cancelled by user",
            end_time=datetime.now(UTC),
        )
        return {"status": "success", "message": "Sync cancelled"}
