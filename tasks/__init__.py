"""
Background tasks implementation using Celery.

This package provides task definitions for all background tasks performed by the
application. It handles proper integration between Celery's synchronous tasks and
FastAPI's asynchronous code patterns, using the centralized db_manager.

Tasks are organized into modules by function:
- core: TaskStatus, TASK_METADATA, TaskStatusManager, task_runner decorator
- config: Task configuration and history management
- fetch: Trip fetching tasks
- coverage: Coverage calculation tasks
- maintenance: Cleanup, validation, and remapping tasks
- scheduler: Task scheduler
- management: Task management API functions
- webhook: Webhook processing task
- routes: Optimal route generation task

All public APIs are re-exported here for backwards compatibility.
"""

# Core components
# Configuration functions
from tasks.config import check_dependencies, get_task_config, update_task_history_entry
from tasks.core import TASK_METADATA, TaskStatus, TaskStatusManager, task_runner

# Coverage tasks
from tasks.coverage import (
    update_coverage_for_new_trips,
    update_coverage_for_new_trips_async,
)

# Trip fetching tasks
from tasks.fetch import (
    fetch_all_missing_trips,
    fetch_all_missing_trips_async,
    get_earliest_trip_date,
    manual_fetch_trips_range,
    manual_fetch_trips_range_async,
    periodic_fetch_trips,
    periodic_fetch_trips_async,
)

# Maintenance tasks
from tasks.maintenance import (
    cleanup_stale_trips,
    cleanup_stale_trips_async,
    remap_unmatched_trips,
    remap_unmatched_trips_async,
    validate_trips,
    validate_trips_async,
)

# Management API functions
from tasks.management import (
    force_reset_task,
    get_all_task_metadata,
    manual_run_task,
    trigger_fetch_all_missing_trips,
    trigger_manual_fetch_trips_range,
    update_task_schedule,
)

# Route generation
from tasks.routes import generate_optimal_route_async, generate_optimal_route_task

# Scheduler
from tasks.scheduler import run_task_scheduler, run_task_scheduler_async

# Webhook processing
from tasks.webhook import process_webhook_event_task

__all__ = [
    "TASK_METADATA",
    # Core
    "TaskStatus",
    "TaskStatusManager",
    "check_dependencies",
    # Maintenance tasks
    "cleanup_stale_trips",
    "cleanup_stale_trips_async",
    "fetch_all_missing_trips",
    "fetch_all_missing_trips_async",
    "force_reset_task",
    # Routes
    "generate_optimal_route_async",
    "generate_optimal_route_task",
    # Management API
    "get_all_task_metadata",
    "get_earliest_trip_date",
    # Config
    "get_task_config",
    "manual_fetch_trips_range",
    "manual_fetch_trips_range_async",
    "manual_run_task",
    # Fetch tasks
    "periodic_fetch_trips",
    "periodic_fetch_trips_async",
    # Webhook
    "process_webhook_event_task",
    "remap_unmatched_trips",
    "remap_unmatched_trips_async",
    # Scheduler
    "run_task_scheduler",
    "run_task_scheduler_async",
    "task_runner",
    "trigger_fetch_all_missing_trips",
    "trigger_manual_fetch_trips_range",
    # Coverage tasks
    "update_coverage_for_new_trips",
    "update_coverage_for_new_trips_async",
    "update_task_history_entry",
    "update_task_schedule",
    "validate_trips",
    "validate_trips_async",
]
