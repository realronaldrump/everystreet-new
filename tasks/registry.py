"""Task registry and metadata for background jobs."""

from __future__ import annotations

import os

TASK_DEFINITIONS: dict[str, dict[str, object]] = {
    "periodic_fetch_trips": {
        "display_name": "Periodic Trip Fetch",
        "default_interval_minutes": int(
            os.environ.get(
                "TRIP_FETCH_INTERVAL_MINUTES",
                "720",
            ),
        ),
        "enabled_by_default": True,
        "dependencies": [],
        "description": "Fetches trips from the Bouncie API periodically",
    },
    "validate_trips": {
        "display_name": "Validate Trips",
        "default_interval_minutes": 720,
        "dependencies": [],
        "description": (
            "Scans all trips and validates their data. A trip is marked invalid if: "
            "(1) it's missing required data like GPS coordinates, start time, or end "
            "time, (2) it has malformed or out-of-range GPS data, OR (3) the car was "
            "turned on briefly without actually driving (zero distance, same start/end "
            "location, no movement, and lasted less than 5 minutes). Longer idle "
            "sessions are preserved. This task also updates validation timestamps "
            "and syncs invalid status to matched trips."
        ),
    },
    "remap_unmatched_trips": {
        "display_name": "Remap Unmatched Trips",
        "default_interval_minutes": 360,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Attempts to map-match trips that previously failed",
    },
    "map_match_trips": {
        "display_name": "Map Match Trips",
        "default_interval_minutes": 0,
        "dependencies": [],
        "description": "Runs map matching jobs created from the Map Matching page",
        "manual_only": True,
    },
    "build_recurring_routes": {
        "display_name": "Build Recurring Routes",
        "default_interval_minutes": 0,
        "dependencies": [],
        "description": (
            "Derives recurring route templates by clustering stored trips with similar "
            "start/end areas and path fingerprints. This does not call Bouncie; it "
            "only uses locally stored trip data and assigns each trip a route template "
            "id for browsing and analysis."
        ),
        "manual_only": True,
    },
    "update_coverage_for_new_trips": {
        "display_name": "Incremental Progress Updates",
        "default_interval_minutes": 180,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Updates coverage calculations incrementally for new trips",
    },
    "sync_mobility_profiles": {
        "display_name": "Sync Mobility Profiles",
        "default_interval_minutes": int(
            os.environ.get(
                "MOBILITY_INSIGHTS_SYNC_INTERVAL_MINUTES",
                "30",
            ),
        ),
        "enabled_by_default": True,
        "dependencies": [],
        "description": (
            "Continuously backfills and refreshes H3 mobility profiles for trips so "
            "street and segment insights stay current without manual recalculation."
        ),
    },
    "monitor_map_data_jobs": {
        "display_name": "Monitor Map Services",
        "default_interval_minutes": 15,
        "dependencies": [],
        "description": (
            "Detects stalled map setup runs and triggers automatic retries."
        ),
    },
    "setup_map_data_task": {
        "display_name": "Setup Map Services",
        "default_interval_minutes": 0,
        "dependencies": [],
        "description": "Downloads state extracts, merges data, and builds Nominatim/Valhalla.",
        "manual_only": True,
    },
    "manual_fetch_trips_range": {
        "display_name": "Fetch Trips (Custom Range)",
        "default_interval_minutes": 0,
        "dependencies": [],
        "description": "Fetches Bouncie trips for a specific date range on-demand",
        "manual_only": True,
    },
    "generate_optimal_route": {
        "display_name": "Generate Optimal Route",
        "default_interval_minutes": 0,
        "dependencies": [],
        "description": "Computes optimal completion route for a coverage area using RPP algorithm",
        "manual_only": True,
    },
}


def is_manual_only(task_id: str) -> bool:
    return bool(TASK_DEFINITIONS.get(task_id, {}).get("manual_only", False))


def is_enabled_by_default(task_id: str) -> bool:
    definition = TASK_DEFINITIONS.get(task_id, {})
    if "enabled_by_default" in definition:
        return bool(definition.get("enabled_by_default"))
    return task_id == "periodic_fetch_trips"


def get_dependencies(task_id: str) -> list[str]:
    definition = TASK_DEFINITIONS.get(task_id, {})
    return list(definition.get("dependencies", []))
