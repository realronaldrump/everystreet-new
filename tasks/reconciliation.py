"""Cross-domain lifecycle reconcilers.

Each task expresses desired state. Retry, cadence, and observability remain in
the shared task runtime rather than leaking into product controls.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from config import get_bouncie_config
from core.date_utils import ensure_utc
from core.http.session import get_session
from core.jobs import create_job
from db.models import AppSettings, CoverageArea, Job, TaskHistory, Trip
from exports.services.export_service import ExportService
from gas.services.statistics_service import StatisticsService
from setup.services.bouncie_oauth import BouncieOAuth
from setup.services.bouncie_sync import sync_bouncie_vehicles
from tasks.ops import enqueue_task, run_task_with_history
from tracking.services.tracking_service import TrackingService
from trips.services.trip_batch_service import TripService
from visits.services.place_service import PlaceService

HISTORY_START = datetime(2020, 1, 1, tzinfo=UTC)
ACTIVE_JOB_STATUSES = ["queued", "pending", "running", "initializing"]


async def _reconcile_live_trips_logic() -> dict[str, Any]:
    return await TrackingService.reconcile_live_trips()


async def reconcile_live_trips(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    return await run_task_with_history(
        ctx,
        "reconcile_live_trips",
        _reconcile_live_trips_logic,
        manual_run=manual_run,
    )


async def _reconcile_setup_logic() -> dict[str, Any]:
    from setup.services.setup_service import SetupService

    status = await SetupService.get_setup_status()
    if not status.get("required_complete"):
        return {
            "status": "waiting",
            "reason": "capabilities_incomplete",
            "message": "Waiting for required setup capabilities.",
        }
    settings = await AppSettings.find_one()
    if settings and not settings.setup_completed:
        now = datetime.now(UTC)
        settings.setup_completed = True
        settings.setup_completed_at = now
        settings.updated_at = now
        await settings.save()
    return {"status": "success", "setup_complete": True}


async def reconcile_setup(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    return await run_task_with_history(
        ctx,
        "reconcile_setup",
        _reconcile_setup_logic,
        manual_run=manual_run,
    )


async def _sync_bouncie_vehicles_logic() -> dict[str, Any]:
    credentials = await get_bouncie_config()
    if not all(
        credentials.get(field)
        for field in ("client_id", "client_secret", "redirect_uri")
    ):
        return {
            "status": "waiting",
            "reason": "credentials_missing",
            "message": "Waiting for Bouncie credentials.",
        }
    if not credentials.get("authorization_code"):
        return {
            "status": "waiting",
            "reason": "authorization_required",
            "message": "Waiting for Bouncie authorization.",
        }

    session = await get_session()
    token = await BouncieOAuth.get_access_token(session, credentials)
    if not token:
        return {
            "status": "waiting",
            "reason": "authorization_required",
            "message": "Waiting for Bouncie reauthorization.",
        }

    result = await sync_bouncie_vehicles(
        session,
        token,
        credentials=credentials,
        merge_authorized_devices=False,
        update_authorized_devices=True,
    )
    trip_result = await StatisticsService.sync_vehicles_from_trips()
    return {
        "status": "success",
        "vehicles_synced": len(result.get("vehicles") or []),
        "trip_vehicles_added": trip_result.get("synced", 0),
        "trip_vehicles_updated": trip_result.get("updated", 0),
        "authorized_devices": result.get("authorized_devices") or [],
    }


async def sync_bouncie_vehicles_task(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    return await run_task_with_history(
        ctx,
        "sync_bouncie_vehicles",
        _sync_bouncie_vehicles_logic,
        manual_run=manual_run,
    )


async def _reconcile_bouncie_history_logic() -> dict[str, Any]:
    credentials = await get_bouncie_config()
    authorized = {
        str(value).strip()
        for value in credentials.get("authorized_devices") or []
        if str(value).strip()
    }
    imported = {
        str(value).strip()
        for value in credentials.get("history_imported_devices") or []
        if str(value).strip()
    }
    missing = sorted(authorized - imported)
    if not authorized:
        return {
            "status": "waiting",
            "reason": "devices_required",
            "message": "Waiting for a Bouncie device.",
        }
    if not missing:
        return {
            "status": "success",
            "devices_current": len(authorized),
        }

    active = await TaskHistory.find_one(
        {
            "task_id": {
                "$in": [
                    "periodic_fetch_trips",
                    "manual_fetch_trips_range",
                    "fetch_all_missing_trips",
                ],
            },
            "status": {"$in": ["PENDING", "RUNNING"]},
            "timestamp": {"$gte": datetime.now(UTC) - timedelta(hours=25)},
        },
    )
    if active:
        return {
            "status": "deferred",
            "reason": "trip_ingest_active",
            "message": "Waiting for the active trip ingest job.",
        }

    result = await enqueue_task(
        "fetch_all_missing_trips",
        manual_run=False,
        start_iso=HISTORY_START.isoformat(),
        selected_imeis=missing,
    )
    return {
        "status": "success",
        "job_id": result.get("job_id"),
        "devices_queued": missing,
    }


async def reconcile_bouncie_history(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    return await run_task_with_history(
        ctx,
        "reconcile_bouncie_history",
        _reconcile_bouncie_history_logic,
        manual_run=manual_run,
    )


async def _repair_trip_geocodes_logic() -> dict[str, Any]:
    query = {
        "source": "bouncie",
        "invalid": {"$ne": True},
        "$or": [
            {"geocoded_at": None},
            {"location_schema_version": {"$ne": 2}},
            {"startLocation": {"$in": [None, "", "Unknown"]}},
            {"destination": {"$in": [None, "", "Unknown"]}},
        ],
    }
    trips = await Trip.find(query).sort("startTime").limit(250).to_list()
    trip_ids = [trip.transactionId for trip in trips if trip.transactionId]
    if not trip_ids:
        return {"status": "success", "processed": 0}

    result = await TripService().refresh_geocoding(
        trip_ids,
        skip_if_exists=False,
    )
    failed = int(result.get("failed", 0) or 0)
    if failed:
        msg = f"Geocoding remained incomplete for {failed} trips."
        raise RuntimeError(msg)
    return {
        "status": "success",
        "processed": int(result.get("total", 0) or 0),
        "updated": int(result.get("updated", 0) or 0),
        "skipped": int(result.get("skipped", 0) or 0),
    }


async def repair_trip_geocodes(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    return await run_task_with_history(
        ctx,
        "repair_trip_geocodes",
        _repair_trip_geocodes_logic,
        manual_run=manual_run,
    )


async def _repair_place_previews_logic() -> dict[str, Any]:
    result = await PlaceService.backfill_place_previews(force=False)
    failed = int(result.get("failed", 0) or 0)
    if failed:
        raise RuntimeError(f"Place previews remained incomplete for {failed} places.")
    return {"status": "success", **result}


async def repair_place_previews(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    return await run_task_with_history(
        ctx,
        "repair_place_previews",
        _repair_place_previews_logic,
        manual_run=manual_run,
    )


async def _refresh_stale_optimal_routes_logic() -> dict[str, Any]:
    areas = await CoverageArea.find(
        {"status": "ready", "optimal_route": {"$ne": None}},
    ).sort("optimal_route_generated_at").to_list()
    for area in areas:
        generated_at = ensure_utc(area.optimal_route_generated_at)
        inputs_updated_at = ensure_utc(area.last_synced)
        if generated_at and (not inputs_updated_at or generated_at >= inputs_updated_at):
            continue

        active = await Job.find_one(
            {
                "job_type": "optimal_route",
                "location": str(area.id),
                "status": {"$in": ["queued", "pending", "running", "initializing"]},
            },
        )
        if active:
            continue

        route = area.optimal_route or {}
        coordinates = route.get("coordinates") or route.get("route_coordinates") or []
        start_lon = None
        start_lat = None
        if coordinates and isinstance(coordinates[0], (list, tuple)):
            first = coordinates[0]
            if len(first) >= 2:
                start_lon = float(first[0])
                start_lat = float(first[1])

        queued = await enqueue_task(
            "generate_optimal_route",
            location_id=str(area.id),
            start_lon=start_lon,
            start_lat=start_lat,
            manual_run=False,
        )
        task_id = queued.get("job_id")
        if not task_id:
            raise RuntimeError(f"Unable to queue optimal route refresh for {area.id}")
        await create_job(
            "optimal_route",
            task_id=task_id,
            area_id=area.id,
            location=str(area.id),
            status="queued",
            stage="queued",
            progress=0.0,
            message="Refreshing route after coverage changed...",
            started_at=datetime.now(UTC),
        )
        return {
            "status": "success",
            "action": "route_refresh_queued",
            "area_id": str(area.id),
            "job_id": task_id,
        }

    return {"status": "success", "action": "routes_current"}


async def refresh_stale_optimal_routes(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    return await run_task_with_history(
        ctx,
        "refresh_stale_optimal_routes",
        _refresh_stale_optimal_routes_logic,
        manual_run=manual_run,
    )


async def _cleanup_export_artifacts_logic() -> dict[str, Any]:
    return {"status": "success", **ExportService.cleanup_expired_artifacts()}


async def cleanup_export_artifacts(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    return await run_task_with_history(
        ctx,
        "cleanup_export_artifacts",
        _cleanup_export_artifacts_logic,
        manual_run=manual_run,
    )


async def _reconcile_stale_jobs_logic() -> dict[str, Any]:
    now = datetime.now(UTC)
    jobs = await Job.find({"status": {"$in": ACTIVE_JOB_STATUSES}}).sort(
        "created_at",
    ).to_list()
    for job in jobs:
        touched_at = ensure_utc(job.updated_at or job.started_at or job.created_at)
        timeout_hours = 24 if job.job_type in {"area_ingestion", "area_rebuild"} else 3
        if touched_at and now - touched_at <= timedelta(hours=timeout_hours):
            continue

        if job.job_type == "export" and job.id:
            from tasks.arq import get_arq_pool

            queue = await get_arq_pool()
            queued = await queue.enqueue_job("run_export_job", str(job.id))
            if queued is None:
                raise RuntimeError(f"Unable to recover export job {job.id}")
            job.status = "queued"
            job.stage = "queued"
            job.message = "Recovered interrupted export; queued again."
            job.error = None
            job.updated_at = now
            await job.save()
            return {"status": "success", "action": "export_requeued", "job_id": str(job.id)}

        job.status = "failed"
        job.stage = "failed"
        job.message = "Interrupted background work was released for automatic recovery."
        job.error = "Background job stopped making progress."
        job.completed_at = now
        job.updated_at = now
        job.expires_at = now + timedelta(days=30)
        await job.save()

        if job.job_type == "optimal_route" and job.location:
            metadata = job.metadata or {}
            queued = await enqueue_task(
                "generate_optimal_route",
                location_id=job.location,
                start_lon=metadata.get("start_lon"),
                start_lat=metadata.get("start_lat"),
                segment_ids=metadata.get("segment_ids"),
                manual_run=False,
            )
            task_id = queued.get("job_id")
            await create_job(
                "optimal_route",
                task_id=task_id,
                area_id=job.area_id,
                location=job.location,
                status="queued",
                stage="queued",
                progress=0.0,
                message="Recovered interrupted route generation...",
                started_at=now,
                metadata=metadata,
            )
            return {
                "status": "success",
                "action": "optimal_route_requeued",
                "job_id": task_id,
            }

        return {
            "status": "success",
            "action": "stale_job_released",
            "job_type": job.job_type,
            "job_id": str(job.id),
        }

    terminal = await Job.find_one(
        {
            "status": {"$in": ["completed", "failed", "cancelled"]},
            "expires_at": None,
        },
    )
    if terminal:
        terminal_at = ensure_utc(terminal.completed_at or terminal.updated_at or terminal.created_at)
        terminal.expires_at = (terminal_at or now) + timedelta(days=30)
        await terminal.save()
        return {
            "status": "success",
            "action": "retention_applied",
            "job_id": str(terminal.id),
        }

    return {"status": "success", "action": "jobs_current"}


async def reconcile_stale_jobs(
    ctx: dict[str, Any],
    manual_run: bool = False,
) -> dict[str, Any]:
    return await run_task_with_history(
        ctx,
        "reconcile_stale_jobs",
        _reconcile_stale_jobs_logic,
        manual_run=manual_run,
    )


__all__ = [
    "cleanup_export_artifacts",
    "reconcile_bouncie_history",
    "reconcile_live_trips",
    "reconcile_setup",
    "reconcile_stale_jobs",
    "repair_place_previews",
    "repair_trip_geocodes",
    "refresh_stale_optimal_routes",
    "sync_bouncie_vehicles_task",
]
