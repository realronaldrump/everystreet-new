"""ARQ cron wrappers for scheduled tasks."""

from __future__ import annotations

from tasks.coverage import sync_geo_coverage, update_coverage_for_new_trips
from tasks.fetch import periodic_fetch_trips
from tasks.maintenance import (
    backfill_trip_display_geometry,
    remap_unmatched_trips,
    validate_trips,
)
from tasks.map_data import auto_provision_check, monitor_map_services
from tasks.mobility import sync_mobility_profiles
from tasks.ops import run_task_if_due
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
from tasks.recurring_routes import build_recurring_routes


async def cron_reconcile_live_trips(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "reconcile_live_trips",
        lambda: reconcile_live_trips(ctx),
    )


async def cron_cleanup_export_artifacts(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "cleanup_export_artifacts",
        lambda: cleanup_export_artifacts(ctx),
    )


async def cron_reconcile_setup(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "reconcile_setup",
        lambda: reconcile_setup(ctx),
    )


async def cron_reconcile_stale_jobs(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "reconcile_stale_jobs",
        lambda: reconcile_stale_jobs(ctx),
    )


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


async def cron_sync_bouncie_vehicles(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "sync_bouncie_vehicles",
        lambda: sync_bouncie_vehicles_task(ctx),
    )


async def cron_reconcile_bouncie_history(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "reconcile_bouncie_history",
        lambda: reconcile_bouncie_history(ctx),
    )


async def cron_repair_trip_geocodes(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "repair_trip_geocodes",
        lambda: repair_trip_geocodes(ctx),
    )


async def cron_remap_unmatched_trips(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "remap_unmatched_trips",
        lambda: remap_unmatched_trips(ctx),
    )


async def cron_backfill_trip_display_geometry(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "backfill_trip_display_geometry",
        lambda: backfill_trip_display_geometry(ctx),
    )


async def cron_build_recurring_routes(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "build_recurring_routes",
        lambda: build_recurring_routes(ctx),
    )


async def cron_repair_place_previews(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "repair_place_previews",
        lambda: repair_place_previews(ctx),
    )


async def cron_refresh_stale_optimal_routes(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "refresh_stale_optimal_routes",
        lambda: refresh_stale_optimal_routes(ctx),
    )


async def cron_update_coverage_for_new_trips(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "update_coverage_for_new_trips",
        lambda: update_coverage_for_new_trips(ctx),
    )


async def cron_sync_geo_coverage(ctx: dict) -> dict | None:
    return await run_task_if_due(
        ctx,
        "sync_geo_coverage",
        lambda: sync_geo_coverage(ctx),
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
