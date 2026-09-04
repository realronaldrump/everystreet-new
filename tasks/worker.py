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
    cron_monitor_map_data_jobs,
    cron_periodic_fetch_trips,
    cron_remap_unmatched_trips,
    cron_sync_geo_coverage,
    cron_sync_mobility_profiles,
    cron_update_coverage_for_new_trips,
    cron_validate_trips,
)
from tasks.fetch import (
    fetch_all_missing_trips,
    fetch_trip_by_transaction_id,
    manual_fetch_trips_range,
    periodic_fetch_trips,
    retry_bouncie_history_windows,
)
from tasks.health import worker_heartbeat
from tasks.logs import purge_server_logs_before
from tasks.maintenance import (
    backfill_trip_display_geometry,
    dedupe_mobility_profiles,
    remap_unmatched_trips,
    validate_trips,
)
from tasks.map_data import (
    SETUP_JOB_TIMEOUT_SECONDS,
    auto_provision_check,
    monitor_map_services,
    setup_map_data_task,
)
from tasks.map_matching import map_match_trips
from tasks.mobility import sync_mobility_profiles
from tasks.optimal_routes import generate_optimal_route
from tasks.recurring_routes import build_recurring_routes
from tasks.street_coverage import (
    run_area_backfill_job,
    run_area_ingestion_job,
    run_area_recalculate_batch_job,
)
from trips.services.completed_trip_sync import sync_completed_trip
from trips.services.coverage_processing import drain_pending_coverage

PERIODIC_FETCH_TIMEOUT_SECONDS = int(
    os.getenv("TRIP_FETCH_JOB_TIMEOUT_SECONDS", str(15 * 60)),
)
HISTORY_IMPORT_TIMEOUT_SECONDS = int(
    os.getenv("TRIP_HISTORY_IMPORT_JOB_TIMEOUT_SECONDS", str(24 * 60 * 60)),
)
HISTORY_RETRY_TIMEOUT_SECONDS = int(
    os.getenv("TRIP_HISTORY_RETRY_JOB_TIMEOUT_SECONDS", str(15 * 60)),
)
LOG_PURGE_TIMEOUT_SECONDS = int(
    os.getenv("LOG_PURGE_JOB_TIMEOUT_SECONDS", str(30 * 60)),
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
COVERAGE_BATCH_TIMEOUT_SECONDS = int(
    os.getenv("COVERAGE_BATCH_JOB_TIMEOUT_SECONDS", str(12 * 60 * 60)),
)
MAP_MATCHING_JOB_TIMEOUT_SECONDS = int(
    os.getenv("MAP_MATCHING_JOB_TIMEOUT_SECONDS", str(12 * 60 * 60)),
)


async def on_startup(ctx: dict) -> None:
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    handler = await initialize_shared_runtime(handler_formatter=formatter)
    ctx["mongo_handler"] = handler


async def on_shutdown(ctx: dict) -> None:
    await shutdown_shared_runtime(
        mongo_handler=ctx.get("mongo_handler"),
        close_http_session=True,
    )


class WorkerSettings:
    allow_abort_jobs = True
    functions: ClassVar[list[object]] = [
        func(sync_completed_trip, timeout=120, max_tries=8, keep_result=24 * 60 * 60),
        func(periodic_fetch_trips, timeout=PERIODIC_FETCH_TIMEOUT_SECONDS),
        fetch_trip_by_transaction_id,
        manual_fetch_trips_range,
        func(fetch_all_missing_trips, timeout=HISTORY_IMPORT_TIMEOUT_SECONDS),
        validate_trips,
        remap_unmatched_trips,
        backfill_trip_display_geometry,
        dedupe_mobility_profiles,
        func(map_match_trips, timeout=MAP_MATCHING_JOB_TIMEOUT_SECONDS),
        update_coverage_for_new_trips,
        sync_geo_coverage,
        func(sync_mobility_profiles, timeout=MOBILITY_SYNC_TIMEOUT_SECONDS),
        build_recurring_routes,
        func(generate_optimal_route, timeout=OPTIMAL_ROUTE_TIMEOUT_SECONDS),
        worker_heartbeat,
        func(purge_server_logs_before, timeout=LOG_PURGE_TIMEOUT_SECONDS),
        func(run_area_ingestion_job, timeout=COVERAGE_INGEST_TIMEOUT_SECONDS),
        func(run_area_backfill_job, timeout=COVERAGE_BACKFILL_TIMEOUT_SECONDS),
        func(run_area_recalculate_batch_job, timeout=COVERAGE_BATCH_TIMEOUT_SECONDS),
        # Map services setup tasks
        func(setup_map_data_task, timeout=SETUP_JOB_TIMEOUT_SECONDS),
        monitor_map_services,
        auto_provision_check,
    ]
    cron_jobs: ClassVar[list[object]] = [
        cron(drain_pending_coverage, second={10, 40}, timeout=20 * 60),
        cron(cron_periodic_fetch_trips, timeout=PERIODIC_FETCH_TIMEOUT_SECONDS),
        cron(
            retry_bouncie_history_windows,
            second={5, 15, 25, 35, 45, 55},
            timeout=HISTORY_RETRY_TIMEOUT_SECONDS,
        ),
        cron(cron_validate_trips),
        cron(cron_remap_unmatched_trips),
        cron(cron_update_coverage_for_new_trips),
        cron(cron_sync_geo_coverage),
        cron(cron_sync_mobility_profiles),
        cron(worker_heartbeat),
        cron(cron_monitor_map_data_jobs),
        cron(cron_auto_provision_map_data),
    ]
    redis_settings = get_redis_settings()
    on_startup = on_startup
    on_shutdown = on_shutdown
