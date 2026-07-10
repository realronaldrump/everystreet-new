"""Immutable operating policy for EveryStreet background reconciliation.

These jobs maintain application correctness. Their cadence is product policy,
not a user preference: callers may observe the policy, but cannot disable or
retime it from the application UI.
"""

from __future__ import annotations

import os


def _interval(env_name: str, default: int) -> int:
    return max(1, int(os.environ.get(env_name, str(default))))


TASK_DEFINITIONS: dict[str, dict[str, object]] = {
    "reconcile_live_trips": {
        "display_name": "Live Trip Reconciliation",
        "default_interval_minutes": 1,
        "dependencies": [],
        "description": "Publishes and clears stale Redis-backed live trips.",
    },
    "reconcile_setup": {
        "display_name": "Setup Reconciliation",
        "default_interval_minutes": 5,
        "dependencies": [],
        "description": "Completes desired-state setup when capabilities are ready.",
    },
    "reconcile_stale_jobs": {
        "display_name": "Background Job Reconciliation",
        "default_interval_minutes": 15,
        "dependencies": [],
        "description": "Releases or requeues background work that stopped progressing.",
    },
    "periodic_fetch_trips": {
        "display_name": "Historical Trip Reconciliation",
        "default_interval_minutes": _interval("TRIP_FETCH_INTERVAL_MINUTES", 5),
        "dependencies": [],
        "description": "Continuously reconciles recent Bouncie trip history.",
    },
    "sync_bouncie_vehicles": {
        "display_name": "Fleet Reconciliation",
        "default_interval_minutes": _interval("BOUNCIE_VEHICLE_SYNC_INTERVAL_MINUTES", 720),
        "dependencies": [],
        "description": "Keeps provider-owned vehicle metadata current.",
    },
    "reconcile_bouncie_history": {
        "display_name": "Trip History Reconciliation",
        "default_interval_minutes": _interval("TRIP_HISTORY_RECONCILE_INTERVAL_MINUTES", 30),
        "dependencies": ["sync_bouncie_vehicles"],
        "description": "Backfills complete history for newly discovered devices.",
    },
    "validate_trips": {
        "display_name": "Trip Validation",
        "default_interval_minutes": 360,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Quarantines structurally invalid historical trips.",
    },
    "repair_trip_geocodes": {
        "display_name": "Trip Geocode Reconciliation",
        "default_interval_minutes": 15,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Repairs missing or outdated trip locations.",
    },
    "remap_unmatched_trips": {
        "display_name": "Trip Match Reconciliation",
        "default_interval_minutes": 30,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Retries historical trips that still need road matching.",
    },
    "backfill_trip_display_geometry": {
        "display_name": "Display Geometry Reconciliation",
        "default_interval_minutes": 30,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Brings display-only trip geometry to the current version.",
    },
    "update_coverage_for_new_trips": {
        "display_name": "Street Coverage Reconciliation",
        "default_interval_minutes": 15,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Rebuilds or backfills coverage areas when their inputs change.",
    },
    "sync_geo_coverage": {
        "display_name": "Region Explorer Reconciliation",
        "default_interval_minutes": _interval("GEO_COVERAGE_SYNC_INTERVAL_MINUTES", 10),
        "dependencies": ["periodic_fetch_trips"],
        "description": "Keeps county, state, and city projections current.",
    },
    "sync_mobility_profiles": {
        "display_name": "Mobility Profile Reconciliation",
        "default_interval_minutes": _interval("MOBILITY_INSIGHTS_SYNC_INTERVAL_MINUTES", 30),
        "dependencies": ["periodic_fetch_trips"],
        "description": "Keeps H3 mobility projections current.",
    },
    "build_recurring_routes": {
        "display_name": "Recurring Route Reconciliation",
        "default_interval_minutes": 60,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Keeps recurring route templates aligned with trip history.",
    },
    "refresh_stale_optimal_routes": {
        "display_name": "Optimal Route Reconciliation",
        "default_interval_minutes": 15,
        "dependencies": ["update_coverage_for_new_trips"],
        "description": "Refreshes saved completion routes when coverage changes.",
    },
    "repair_place_previews": {
        "display_name": "Place Preview Reconciliation",
        "default_interval_minutes": 360,
        "dependencies": [],
        "description": "Repairs missing place preview images.",
    },
    "cleanup_export_artifacts": {
        "display_name": "Export Retention",
        "default_interval_minutes": 1440,
        "dependencies": [],
        "description": "Removes expired export artifacts automatically.",
    },
    "monitor_map_data_jobs": {
        "display_name": "Map Setup Reconciliation",
        "default_interval_minutes": 5,
        "dependencies": [],
        "description": "Recovers stalled map builds and unhealthy map services.",
    },
    "auto_provision_map_data": {
        "display_name": "Map Coverage Reconciliation",
        "default_interval_minutes": 15,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Provisions map data for states discovered from trips.",
    },
}


def is_manual_only(_task_id: str) -> bool:
    """Scheduled tasks are never user-managed."""
    return False


def is_enabled_by_default(task_id: str) -> bool:
    return task_id in TASK_DEFINITIONS


def get_dependencies(task_id: str) -> list[str]:
    definition = TASK_DEFINITIONS.get(task_id, {})
    return list(definition.get("dependencies", []))


__all__ = [
    "TASK_DEFINITIONS",
    "get_dependencies",
    "is_enabled_by_default",
    "is_manual_only",
]
