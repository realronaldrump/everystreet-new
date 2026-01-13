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
