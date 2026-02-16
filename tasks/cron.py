"""ARQ cron wrappers for scheduled tasks."""

from __future__ import annotations

from tasks.coverage import update_coverage_for_new_trips
from tasks.fetch import periodic_fetch_trips
from tasks.maintenance import remap_unmatched_trips, validate_trips
from tasks.map_data import auto_provision_check, monitor_map_services
from tasks.mobility import sync_mobility_profiles
from tasks.ops import run_task_if_due


async def cron_periodic_fetch_trips(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "periodic_fetch_trips",
        lambda: periodic_fetch_trips(ctx, trigger_source="scheduled"),
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


async def cron_sync_mobility_profiles(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "sync_mobility_profiles",
        lambda: sync_mobility_profiles(ctx),
    )


async def cron_monitor_map_data_jobs(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "monitor_map_data_jobs",
        lambda: monitor_map_services(ctx),
    )


async def cron_auto_provision_map_data(ctx: dict) -> dict | None:
    """
    Periodically check for trips in unconfigured states.

    If trips are found in states without map data, automatically
    triggers provisioning to download and build map data.
    """
    return await run_task_if_due(
        ctx,
        "auto_provision_map_data",
        lambda: auto_provision_check(ctx),
    )
