"""ARQ cron wrappers for scheduled tasks."""

from __future__ import annotations

from tasks.coverage import update_coverage_for_new_trips
from tasks.fetch import periodic_fetch_trips
from tasks.maintenance import cleanup_stale_trips, remap_unmatched_trips, validate_trips
from tasks.map_data import monitor_map_data_jobs
from tasks.ops import run_task_if_due


async def cron_periodic_fetch_trips(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "periodic_fetch_trips",
        lambda: periodic_fetch_trips(ctx, trigger_source="scheduled"),
    )


async def cron_cleanup_stale_trips(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "cleanup_stale_trips",
        lambda: cleanup_stale_trips(ctx),
    )


async def cron_validate_trips(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "validate_trips",
        lambda: validate_trips(ctx),
    )


async def cron_remap_unmatched_trips(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "remap_unmatched_trips",
        lambda: remap_unmatched_trips(ctx),
    )


async def cron_update_coverage_for_new_trips(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "update_coverage_for_new_trips",
        lambda: update_coverage_for_new_trips(ctx),
    )


async def cron_monitor_map_data_jobs(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "monitor_map_data_jobs",
        lambda: monitor_map_data_jobs(ctx),
    )
