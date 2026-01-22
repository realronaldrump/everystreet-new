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
        "dependencies": [],
        "description": "Fetches trips from the Bouncie API periodically",
    },
    "cleanup_stale_trips": {
        "display_name": "Cleanup Stale Trips",
        "default_interval_minutes": 60,
        "dependencies": [],
        "description": "Completes active trips that haven't been updated recently",
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
    "update_coverage_for_new_trips": {
        "display_name": "Incremental Progress Updates",
        "default_interval_minutes": 180,
        "dependencies": ["periodic_fetch_trips"],
        "description": "Updates coverage calculations incrementally for new trips",
    },
    "monitor_map_data_jobs": {
        "display_name": "Monitor Map Data Jobs",
        "default_interval_minutes": 15,
        "dependencies": [],
        "description": (
            "Detects stalled map data downloads/builds and marks them as failed so they "
            "can be retried."
        ),
    },
    "manual_fetch_trips_range": {
        "display_name": "Fetch Trips (Custom Range)",
        "default_interval_minutes": 0,
        "dependencies": [],
        "description": "Fetches Bouncie trips for a specific date range on-demand",
        "manual_only": True,
    },
    "fetch_all_missing_trips": {
        "display_name": "Fetch All Missing Trips",
        "default_interval_minutes": 0,
        "dependencies": [],
        "description": "Fetches all trips from 2020-01-01 to now to fill gaps",
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


def get_default_interval(task_id: str) -> int:
    definition = TASK_DEFINITIONS.get(task_id, {})
    return int(definition.get("default_interval_minutes", 0) or 0)


def get_dependencies(task_id: str) -> list[str]:
    definition = TASK_DEFINITIONS.get(task_id, {})
    return list(definition.get("dependencies", []))
