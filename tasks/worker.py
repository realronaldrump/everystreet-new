"""ARQ worker settings and startup hooks."""

from __future__ import annotations

import logging
from typing import ClassVar

from arq import cron

from core.http.session import cleanup_session
from db import db_manager
from db.logging_handler import MongoDBHandler
from tasks.arq import get_redis_settings
from tasks.coverage import update_coverage_for_new_trips
from tasks.cron import (
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
from tasks.map_data import (
    build_nominatim_task,
    build_valhalla_task,
    download_region_task,
    monitor_map_data_jobs,
)
from tasks.routes import generate_optimal_route


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
    functions: ClassVar[list[object]] = [
        periodic_fetch_trips,
        fetch_trip_by_transaction_id,
        manual_fetch_trips_range,
        fetch_all_missing_trips,
        cleanup_stale_trips,
        validate_trips,
        remap_unmatched_trips,
        update_coverage_for_new_trips,
        generate_optimal_route,
        worker_heartbeat,
        # Map data management tasks
        download_region_task,
        build_nominatim_task,
        build_valhalla_task,
        monitor_map_data_jobs,
    ]
    cron_jobs: ClassVar[list[object]] = [
        cron(cron_periodic_fetch_trips),
        cron(cron_cleanup_stale_trips),
        cron(cron_validate_trips),
        cron(cron_remap_unmatched_trips),
        cron(cron_update_coverage_for_new_trips),
        cron(worker_heartbeat),
        cron(cron_monitor_map_data_jobs),
    ]
    redis_settings = get_redis_settings()
    on_startup = on_startup
    on_shutdown = on_shutdown
