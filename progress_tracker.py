"""
Unified progress tracking for long-running background tasks.

This module provides a centralized ProgressTracker class that standardizes progress
updates to MongoDB, eliminating duplicate boilerplate across coverage_tasks.py,
route_solver.py, preprocess_streets.py, and trips.py.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from beanie import Document

logger = logging.getLogger(__name__)


class ProgressTracker:
    """
    Unified progress tracking for long-running background tasks.

    Usage:
        tracker = ProgressTracker(task_id, OptimalRouteProgress, location="My Location")
        await tracker.update("processing", 50, "Halfway done...")
        await tracker.complete("All done!")
        # or
        await tracker.fail("Something went wrong", "Error details here")
    """

    def __init__(
        self,
        task_id: str | None,
        document_model: type[Document],
        *,
        location: str | None = None,
        location_id: str | None = None,
        task_type: str | None = None,
        use_task_id_field: bool = False,
    ) -> None:
        """
        Initialize a progress tracker.

        Args:
            task_id: Unique identifier for the task. If None, updates are skipped.
            document_model: Beanie Document model class to store progress.
            location: Optional location display name for the task.
            location_id: Optional location ID (used by route_solver).
            task_type: Optional task type label (e.g., "geocoding").
            use_task_id_field: If True, filter by {"task_id": task_id} instead of
                {"_id": task_id}. Used for optimal_route_progress_collection.
        """
        self.task_id = task_id
        self.document_model = document_model
        self.location = location
        self.location_id = location_id
        self.task_type = task_type
        self.use_task_id_field = use_task_id_field

    def _get_filter(self) -> dict[str, Any]:
        """Build the MongoDB filter for this task."""
        # Check if model has task_id field if we are using it
        if self.use_task_id_field:
            return {"task_id": self.task_id}
        return {"_id": self.task_id}

    async def update(
        self,
        stage: str,
        progress: float,
        message: str,
        *,
        status: str = "processing",
        error: str | None = None,
        metrics: dict[str, Any] | None = None,
        upsert: bool = True,
    ) -> None:
        """
        Update task progress in MongoDB.

        Args:
            stage: Current processing stage (e.g., "fetching", "processing", "complete").
            progress: Progress percentage (0-100).
            message: Human-readable status message.
            status: Task status ("processing", "complete", "error", "running").
            error: Optional error message if status is "error".
            metrics: Optional additional metrics to store.
            upsert: If True, create the document if it doesn't exist.
        """
        if not self.task_id:
            return

        now = datetime.now(UTC)

        update_data: dict[str, Any] = {
            "stage": stage,
            "progress": round(progress, 2) if isinstance(progress, float) else progress,
            "message": message,
            "updated_at": now,
        }

        if error:
            update_data["error"] = error
            update_data["status"] = "error"
        else:
            update_data["status"] = status

        if self.location:
            update_data["location"] = self.location

        if self.location_id:
            update_data["location_id"] = self.location_id

        if self.task_type:
            update_data["task_type"] = self.task_type

        if metrics:
            update_data["metrics"] = metrics

        try:
            # Beanie find
            doc = await self.document_model.find_one(self._get_filter())

            if doc:
                await doc.update({"$set": update_data})
            elif upsert:
                # Construct initial document
                initial_data = {}
                if self.use_task_id_field:
                    initial_data["task_id"] = self.task_id
                    initial_data["started_at"] = now
                else:
                    initial_data["id"] = self.task_id

                # Merge other fields
                if self.location:
                    initial_data["location"] = self.location
                if self.location_id:
                    initial_data["location_id"] = self.location_id

                initial_data.update(
                    {
                        "stage": stage,
                        "progress": (
                            round(progress, 2)
                            if isinstance(progress, float)
                            else progress
                        ),
                        "message": message,
                        "updated_at": now,
                        "status": status if not error else "error",
                    },
                )
                if error:
                    initial_data["error"] = error
                if metrics:
                    initial_data["metrics"] = metrics
                if self.task_type:
                    initial_data["task_type"] = self.task_type

                new_doc = self.document_model(**initial_data)
                await new_doc.insert()

        except Exception as e:
            logger.exception("Task %s: Failed to update progress: %s", self.task_id, e)

    async def complete(self, message: str = "Completed") -> None:
        """
        Mark the task as completed.

        Args:
            message: Completion message to display.
        """
        if not self.task_id:
            return

        now = datetime.now(UTC)

        update_data: dict[str, Any] = {
            "stage": "complete",
            "progress": 100,
            "message": message,
            "status": "complete",
            "updated_at": now,
            "completed_at": now,
        }

        if self.location:
            update_data["location"] = self.location

        if self.location_id:
            update_data["location_id"] = self.location_id

        try:
            doc = await self.document_model.find_one(self._get_filter())
            if doc:
                await doc.update({"$set": update_data})
        except Exception as e:
            logger.exception("Task %s: Failed to mark complete: %s", self.task_id, e)

    async def fail(self, error: str, message: str | None = None) -> None:
        """
        Mark the task as failed.

        Args:
            error: Error message to store.
            message: Optional human-readable message (defaults to error).
        """
        if not self.task_id:
            return

        now = datetime.now(UTC)

        update_data: dict[str, Any] = {
            "stage": "error",
            "progress": 0,
            "message": message or f"Error: {error}",
            "status": "error",
            "error": error,
            "updated_at": now,
            "failed_at": now,
        }

        if self.location:
            update_data["location"] = self.location

        if self.location_id:
            update_data["location_id"] = self.location_id

        try:
            doc = await self.document_model.find_one(self._get_filter())
            if doc:
                await doc.update({"$set": update_data})
        except Exception as e:
            logger.exception("Task %s: Failed to mark as failed: %s", self.task_id, e)
