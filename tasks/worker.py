"""ARQ worker settings and startup hooks."""

from __future__ import annotations

import logging
import os
from typing import ClassVar

from arq import cron, func

from core.startup import initialize_shared_runtime, shutdown_shared_runtime
from tasks.arq import get_redis_settings
from tasks.coverage import sync_geo_coverage, update_coverage_for_new_trips
from tasks.cron import (
    cron_auto_provision_map_data,
    cron_backfill_trip_display_geometry,
    cron_build_recurring_routes,
    cron_cleanup_export_artifacts,
    cron_monitor_map_data_jobs,
    cron_periodic_fetch_trips,
    cron_reconcile_bouncie_history,
    cron_reconcile_live_trips,
    cron_reconcile_setup,
    cron_reconcile_stale_jobs,
    cron_remap_unmatched_trips,
    cron_repair_place_previews,
    cron_repair_trip_geocodes,
    cron_refresh_stale_optimal_routes,
    cron_sync_bouncie_vehicles,
    cron_sync_geo_coverage,
    cron_sync_mobility_profiles,
    cron_update_coverage_for_new_trips,
    cron_validate_trips,
)
from tasks.fetch import (
    fetch_all_missing_trips,
    fetch_trip_by_transaction_id,
    periodic_fetch_trips,
)
from tasks.exports import run_export_job
from tasks.health import worker_heartbeat
from tasks.maintenance import (
    backfill_trip_display_geometry,
    remap_unmatched_trips,
    validate_trips,
)
from tasks.map_data import (
    SETUP_JOB_TIMEOUT_SECONDS,
    auto_provision_check,
    monitor_map_services,
    setup_map_data_task,
)
from tasks.mobility import sync_mobility_profiles
from tasks.optimal_routes import generate_optimal_route
from tasks.recurring_routes import build_recurring_routes
from tasks.reconciliation import (
    cleanup_export_artifacts,
    reconcile_bouncie_history,
    reconcile_live_trips,
    reconcile_setup,
    reconcile_stale_jobs,
    repair_place_previews,
    repair_trip_geocodes,
    refresh_stale_optimal_routes,
    sync_bouncie_vehicles_task,
)
from tasks.config import reconcile_automatic_task_configs
from tasks.street_coverage import (
    run_area_backfill_job,
    run_area_ingestion_job,
)

PERIODIC_FETCH_TIMEOUT_SECONDS = int(
    os.getenv("TRIP_FETCH_JOB_TIMEOUT_SECONDS", str(15 * 60)),
)
HISTORY_IMPORT_TIMEOUT_SECONDS = int(
    os.getenv("TRIP_HISTORY_IMPORT_JOB_TIMEOUT_SECONDS", str(24 * 60 * 60)),
)
OPTIMAL_ROUTE_TIMEOUT_SECONDS = int(
    os.getenv("OPTIMAL_ROUTE_JOB_TIMEOUT_SECONDS", str(90 * 60)),
)
MOBILITY_SYNC_TIMEOUT_SECONDS = int(
    os.getenv("MOBILITY_SYNC_JOB_TIMEOUT_SECONDS", str(20 * 60)),
)
COVERAGE_INGEST_TIMEOUT_SECONDS = int(
    os.getenv("COVERAGE_INGEST_JOB_TIMEOUT_SECONDS", str(6 * 60 * 60)),
)
COVERAGE_BACKFILL_TIMEOUT_SECONDS = int(
    os.getenv("COVERAGE_BACKFILL_JOB_TIMEOUT_SECONDS", str(4 * 60 * 60)),
)
EXPORT_JOB_TIMEOUT_SECONDS = int(os.getenv("EXPORT_JOB_TIMEOUT_SECONDS", str(2 * 60 * 60)))


async def on_startup(ctx: dict) -> None:
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    handler = await initialize_shared_runtime(handler_formatter=formatter)
    ctx["mongo_handler"] = handler
    await reconcile_automatic_task_configs()


async def on_shutdown(ctx: dict) -> None:
    await shutdown_shared_runtime(
        mongo_handler=ctx.get("mongo_handler"),
        close_http_session=True,
    )


class WorkerSettings:
    functions: ClassVar[list[object]] = [
        func(periodic_fetch_trips, timeout=PERIODIC_FETCH_TIMEOUT_SECONDS),
        reconcile_live_trips,
        cleanup_export_artifacts,
        reconcile_setup,
        reconcile_stale_jobs,
        sync_bouncie_vehicles_task,
        reconcile_bouncie_history,
        repair_trip_geocodes,
        repair_place_previews,
        refresh_stale_optimal_routes,
        fetch_trip_by_transaction_id,
        func(fetch_all_missing_trips, timeout=HISTORY_IMPORT_TIMEOUT_SECONDS),
        func(run_export_job, timeout=EXPORT_JOB_TIMEOUT_SECONDS),
        validate_trips,
        remap_unmatched_trips,
        backfill_trip_display_geometry,
        update_coverage_for_new_trips,
        sync_geo_coverage,
        func(sync_mobility_profiles, timeout=MOBILITY_SYNC_TIMEOUT_SECONDS),
        build_recurring_routes,
        func(generate_optimal_route, timeout=OPTIMAL_ROUTE_TIMEOUT_SECONDS),
        worker_heartbeat,
        func(run_area_ingestion_job, timeout=COVERAGE_INGEST_TIMEOUT_SECONDS),
        func(run_area_backfill_job, timeout=COVERAGE_BACKFILL_TIMEOUT_SECONDS),
        # Map services setup tasks
        func(setup_map_data_task, timeout=SETUP_JOB_TIMEOUT_SECONDS),
        monitor_map_services,
        auto_provision_check,
    ]
    cron_jobs: ClassVar[list[object]] = [
        cron(cron_reconcile_live_trips),
        cron(cron_cleanup_export_artifacts),
        cron(cron_reconcile_setup),
        cron(cron_reconcile_stale_jobs),
        cron(cron_periodic_fetch_trips, timeout=PERIODIC_FETCH_TIMEOUT_SECONDS),
        cron(cron_sync_bouncie_vehicles),
        cron(cron_reconcile_bouncie_history),
        cron(cron_validate_trips),
        cron(cron_repair_trip_geocodes),
        cron(cron_remap_unmatched_trips),
        cron(cron_backfill_trip_display_geometry),
        cron(cron_update_coverage_for_new_trips),
        cron(cron_sync_geo_coverage),
        cron(cron_sync_mobility_profiles),
        cron(cron_build_recurring_routes),
        cron(cron_repair_place_previews),
        cron(cron_refresh_stale_optimal_routes),
        cron(worker_heartbeat),
        cron(cron_monitor_map_data_jobs),
        cron(cron_auto_provision_map_data),
    ]
    redis_settings = get_redis_settings()
    on_startup = on_startup
    on_shutdown = on_shutdown
