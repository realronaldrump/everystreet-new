"""Utility functions for background task progress updates.

This module provides a streamlined interface for updating progress status
in the database, reducing boilerplate across task orchestration files.
"""

from datetime import UTC, datetime
from typing import Any

from db import progress_collection, update_one_with_retry


async def update_progress(
    task_id: str,
    stage: str,
    progress: int,
    message: str,
    *,
    status: str | None = None,
    error: str | None = None,
    location: str | None = None,
    upsert: bool = False,
    **extra: Any,
) -> None:
    """Update progress for a background task.

    Args:
        task_id: Unique identifier for the task.
        stage: Current stage name (e.g., "initializing", "processing", "error").
        progress: Progress percentage (0-100).
        message: Human-readable status message.
        status: Optional overall status (e.g., "processing", "error").
        error: Optional error message if stage is "error".
        location: Optional location/context identifier.
        upsert: If True, create the document if it doesn't exist.
        **extra: Additional fields to include in the update.
    """
    update_data: dict[str, Any] = {
        "stage": stage,
        "progress": progress,
        "message": message,
        "updated_at": datetime.now(UTC),
    }
    if status:
        update_data["status"] = status
    if error:
        update_data["error"] = error
    if location:
        update_data["location"] = location
    update_data.update(extra)

    await update_one_with_retry(
        progress_collection,
        {"_id": task_id},
        {"$set": update_data},
        upsert=upsert,
    )






