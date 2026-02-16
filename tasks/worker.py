"""ARQ worker settings and startup hooks."""

from __future__ import annotations

import logging
import os
from typing import ClassVar

from arq import cron, func

from core.startup import initialize_shared_runtime, shutdown_shared_runtime
from tasks.arq import get_redis_settings
from tasks.coverage import update_coverage_for_new_trips
from tasks.cron import (
    cron_auto_provision_map_data,
    cron_monitor_map_data_jobs,
    cron_periodic_fetch_trips,
    cron_remap_unmatched_trips,
    cron_update_coverage_for_new_trips,
    cron_validate_trips,
)
from tasks.fetch import (
    fetch_all_missing_trips,
    fetch_trip_by_transaction_id,
    manual_fetch_trips_range,
    periodic_fetch_trips,
)
from tasks.health import worker_heartbeat
from tasks.logs import purge_server_logs_before
from tasks.maintenance import remap_unmatched_trips, validate_trips
from tasks.map_data import (
    SETUP_JOB_TIMEOUT_SECONDS,
    auto_provision_check,
    monitor_map_services,
    setup_map_data_task,
)
from tasks.map_matching import map_match_trips
from tasks.optimal_routes import generate_optimal_route
from tasks.recurring_routes import build_recurring_routes

PERIODIC_FETCH_TIMEOUT_SECONDS = int(
    os.getenv("TRIP_FETCH_JOB_TIMEOUT_SECONDS", str(15 * 60)),
)
HISTORY_IMPORT_TIMEOUT_SECONDS = int(
    os.getenv("TRIP_HISTORY_IMPORT_JOB_TIMEOUT_SECONDS", str(24 * 60 * 60)),
)
LOG_PURGE_TIMEOUT_SECONDS = int(
    os.getenv("LOG_PURGE_JOB_TIMEOUT_SECONDS", str(30 * 60)),
)
OPTIMAL_ROUTE_TIMEOUT_SECONDS = int(
    os.getenv("OPTIMAL_ROUTE_JOB_TIMEOUT_SECONDS", str(90 * 60)),
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
    functions: ClassVar[list[object]] = [
        func(periodic_fetch_trips, timeout=PERIODIC_FETCH_TIMEOUT_SECONDS),
        fetch_trip_by_transaction_id,
        manual_fetch_trips_range,
        func(fetch_all_missing_trips, timeout=HISTORY_IMPORT_TIMEOUT_SECONDS),
        validate_trips,
        remap_unmatched_trips,
        map_match_trips,
        update_coverage_for_new_trips,
        build_recurring_routes,
        func(generate_optimal_route, timeout=OPTIMAL_ROUTE_TIMEOUT_SECONDS),
        worker_heartbeat,
        func(purge_server_logs_before, timeout=LOG_PURGE_TIMEOUT_SECONDS),
        # Map services setup tasks
        func(setup_map_data_task, timeout=SETUP_JOB_TIMEOUT_SECONDS),
        monitor_map_services,
        auto_provision_check,
    ]
    cron_jobs: ClassVar[list[object]] = [
        cron(cron_periodic_fetch_trips, timeout=PERIODIC_FETCH_TIMEOUT_SECONDS),
        cron(cron_validate_trips),
        cron(cron_remap_unmatched_trips),
        cron(cron_update_coverage_for_new_trips),
        cron(worker_heartbeat),
        cron(cron_monitor_map_data_jobs),
        cron(cron_auto_provision_map_data),
    ]
    redis_settings = get_redis_settings()
    on_startup = on_startup
    on_shutdown = on_shutdown
