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
"""

# Import task modules so Celery registers @shared_task decorators on startup.
from tasks.webhook import process_webhook_event_task
from tasks.scheduler import run_task_scheduler
from tasks.fetch import (
    periodic_fetch_trips,
    fetch_trip_by_transaction_id,
    manual_fetch_trips_range,
    fetch_all_missing_trips,
)
from tasks.coverage import update_coverage_for_new_trips
from tasks.maintenance import (
    cleanup_stale_trips,
    validate_trips,
    remap_unmatched_trips,
)
from tasks.routes import generate_optimal_route_task

__all__ = [
    "process_webhook_event_task",
    "run_task_scheduler",
    "periodic_fetch_trips",
    "fetch_trip_by_transaction_id",
    "manual_fetch_trips_range",
    "fetch_all_missing_trips",
    "update_coverage_for_new_trips",
    "cleanup_stale_trips",
    "validate_trips",
    "remap_unmatched_trips",
    "generate_optimal_route_task",
]
