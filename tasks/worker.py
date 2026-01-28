"""ARQ worker settings and startup hooks."""

from __future__ import annotations

import logging
import os
from typing import ClassVar

from arq import cron, func

from core.http.session import cleanup_session
from db import db_manager
from db.logging_handler import MongoDBHandler
from tasks.arq import get_redis_settings
from tasks.coverage import update_coverage_for_new_trips
from tasks.cron import (
    cron_auto_provision_map_data,
    cron_cleanup_stale_trips,
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
from tasks.maintenance import cleanup_stale_trips, remap_unmatched_trips, validate_trips
from tasks.map_matching import map_match_trips
from tasks.map_data import (
    SETUP_JOB_TIMEOUT_SECONDS,
    auto_provision_check,
    monitor_map_services,
    setup_map_data_task,
)
from tasks.routes import generate_optimal_route

PERIODIC_FETCH_TIMEOUT_SECONDS = int(
    os.getenv("TRIP_FETCH_JOB_TIMEOUT_SECONDS", str(15 * 60)),
)


async def on_startup(ctx: dict) -> None:
    await db_manager.init_beanie()

    from core.service_config import get_service_config

    await get_service_config()

    handler = MongoDBHandler()
    await handler.setup_indexes()
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    )
    handler.setFormatter(formatter)
    handler.setLevel(logging.INFO)

    root_logger = logging.getLogger()
    root_logger.addHandler(handler)
    ctx["mongo_handler"] = handler


async def on_shutdown(ctx: dict) -> None:
    handler = ctx.get("mongo_handler")
    if handler:
        root_logger = logging.getLogger()
        root_logger.removeHandler(handler)
        handler.close()

    await cleanup_session()
    await db_manager.cleanup_connections()


class WorkerSettings:
    functions: ClassVar[list[object]] = [  # noqa: V107
        func(periodic_fetch_trips, timeout=PERIODIC_FETCH_TIMEOUT_SECONDS),
        fetch_trip_by_transaction_id,
        manual_fetch_trips_range,
        fetch_all_missing_trips,
        cleanup_stale_trips,
        validate_trips,
        remap_unmatched_trips,
        map_match_trips,
        update_coverage_for_new_trips,
        generate_optimal_route,
        worker_heartbeat,
        # Map services setup tasks
        func(setup_map_data_task, timeout=SETUP_JOB_TIMEOUT_SECONDS),
        monitor_map_services,
        auto_provision_check,
    ]
    cron_jobs: ClassVar[list[object]] = [  # noqa: V107
        cron(cron_periodic_fetch_trips, timeout=PERIODIC_FETCH_TIMEOUT_SECONDS),
        cron(cron_cleanup_stale_trips),
        cron(cron_validate_trips),
        cron(cron_remap_unmatched_trips),
        cron(cron_update_coverage_for_new_trips),
        cron(worker_heartbeat),
        cron(cron_monitor_map_data_jobs),
        cron(cron_auto_provision_map_data),
    ]
    redis_settings = get_redis_settings()  # noqa: V107
    on_startup = on_startup
    on_shutdown = on_shutdown
