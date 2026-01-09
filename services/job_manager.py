"""JobManager service for unified job tracking.

Provides a single interface for creating, updating, and querying
background jobs across all job types (ingestion, coverage, rebuild, etc.).
"""

import logging
from datetime import UTC, datetime
from typing import Any

from bson import ObjectId

from coverage_models.job_status import (
    Job,
    JobCreate,
    JobState,
    JobType,
    create_job_doc,
    doc_to_job,
)
from db import (
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    insert_one_with_retry,
    job_status_collection,
    update_one_with_retry,
)

logger = logging.getLogger(__name__)


class JobManager:
    """Manages job lifecycle and progress tracking."""

    async def create_job(
        self,
        job_type: JobType | str,
        area_id: str | None = None,
        trip_id: str | None = None,
        max_retries: int = 3,
    ) -> Job:
        """Create a new job and return it.

        Args:
            job_type: Type of job to create
            area_id: Optional area ID this job is associated with
            trip_id: Optional trip ID this job is associated with
            max_retries: Maximum retry attempts before failure

        Returns:
            The created Job object
        """
        if isinstance(job_type, str):
            job_type = JobType(job_type)

        doc = create_job_doc(
            job_type=job_type,
            area_id=area_id,
            trip_id=trip_id,
            max_retries=max_retries,
        )

        await insert_one_with_retry(job_status_collection, doc)
        logger.info(
            "Created job %s of type %s for area=%s, trip=%s",
            doc["_id"],
            job_type.value,
            area_id,
            trip_id,
        )

        return doc_to_job(doc)

    async def get_job(self, job_id: str | ObjectId) -> Job | None:
        """Get a job by ID.

        Args:
            job_id: Job ID (string or ObjectId)

        Returns:
            Job object or None if not found
        """
        if isinstance(job_id, str):
            try:
                job_id = ObjectId(job_id)
            except Exception:
                return None

        doc = await find_one_with_retry(job_status_collection, {"_id": job_id})
        if doc:
            return doc_to_job(doc)
        return None

    async def update_job(
        self,
        job_id: str | ObjectId,
        state: JobState | str | None = None,
        stage: str | None = None,
        percent: float | None = None,
        message: str | None = None,
        error: str | None = None,
        metrics: dict[str, Any] | None = None,
    ) -> bool:
        """Update job status and progress.

        Args:
            job_id: Job ID to update
            state: New state (optional)
            stage: Current stage description (optional)
            percent: Progress percentage 0-100 (optional)
            message: Status message (optional)
            error: Error message if failed (optional)
            metrics: Job-specific metrics to merge (optional)

        Returns:
            True if update succeeded, False otherwise
        """
        if isinstance(job_id, str):
            try:
                job_id = ObjectId(job_id)
            except Exception:
                return False

        update: dict[str, Any] = {}
        now = datetime.now(UTC)

        if state is not None:
            if isinstance(state, str):
                state = JobState(state)
            update["state"] = state.value

            # Set timing fields based on state transitions
            if state == JobState.RUNNING:
                update["started_at"] = now
            elif state in (JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED):
                update["completed_at"] = now

        if stage is not None:
            update["stage"] = stage
        if percent is not None:
            update["percent"] = min(100.0, max(0.0, percent))
        if message is not None:
            update["message"] = message
        if error is not None:
            update["error"] = error

        if not update and metrics is None:
            return True  # Nothing to update

        set_ops: dict[str, Any] = update
        update_doc: dict[str, Any] = {"$set": set_ops}

        if metrics:
            # Merge metrics using dot notation
            for key, value in metrics.items():
                set_ops[f"metrics.{key}"] = value

        result = await update_one_with_retry(
            job_status_collection,
            {"_id": job_id},
            update_doc,
        )

        return result.modified_count > 0 or result.matched_count > 0

    async def start_job(
        self,
        job_id: str | ObjectId,
        stage: str = "starting",
        message: str = "Job started",
    ) -> bool:
        """Mark a job as running.

        Args:
            job_id: Job ID to start
            stage: Initial stage name
            message: Initial status message

        Returns:
            True if update succeeded
        """
        return await self.update_job(
            job_id,
            state=JobState.RUNNING,
            stage=stage,
            percent=0,
            message=message,
        )

    async def complete_job(
        self,
        job_id: str | ObjectId,
        message: str = "Job completed successfully",
        metrics: dict[str, Any] | None = None,
    ) -> bool:
        """Mark a job as completed.

        Args:
            job_id: Job ID to complete
            message: Completion message
            metrics: Final metrics to record

        Returns:
            True if update succeeded
        """
        return await self.update_job(
            job_id,
            state=JobState.COMPLETED,
            stage="completed",
            percent=100,
            message=message,
            metrics=metrics,
        )

    async def fail_job(
        self,
        job_id: str | ObjectId,
        error: str,
        message: str | None = None,
        increment_retry: bool = True,
    ) -> bool:
        """Mark a job as failed.

        Args:
            job_id: Job ID to fail
            error: Error description
            message: Optional status message
            increment_retry: Whether to increment retry count

        Returns:
            True if update succeeded
        """
        if isinstance(job_id, str):
            try:
                job_id = ObjectId(job_id)
            except Exception:
                return False

        update: dict[str, Any] = {
            "$set": {
                "state": JobState.FAILED.value,
                "stage": "failed",
                "error": error,
                "completed_at": datetime.now(UTC),
            }
        }

        if message:
            update["$set"]["message"] = message
        else:
            update["$set"]["message"] = f"Job failed: {error[:100]}"

        if increment_retry:
            update["$inc"] = {"retry_count": 1}

        result = await update_one_with_retry(
            job_status_collection,
            {"_id": job_id},
            update,
        )

        logger.error("Job %s failed: %s", job_id, error)
        return result.modified_count > 0 or result.matched_count > 0

    async def cancel_job(
        self,
        job_id: str | ObjectId,
        message: str = "Job cancelled",
    ) -> bool:
        """Cancel a job.

        Args:
            job_id: Job ID to cancel
            message: Cancellation message

        Returns:
            True if update succeeded
        """
        return await self.update_job(
            job_id,
            state=JobState.CANCELLED,
            stage="cancelled",
            message=message,
        )

    async def get_jobs_for_area(
        self,
        area_id: str | ObjectId,
        state: JobState | str | None = None,
        limit: int = 10,
    ) -> list[Job]:
        """Get jobs for a specific area.

        Args:
            area_id: Area ID to filter by
            state: Optional state filter
            limit: Maximum number of jobs to return

        Returns:
            List of Job objects
        """
        if isinstance(area_id, str):
            area_id = ObjectId(area_id)

        query: dict[str, Any] = {"area_id": area_id}
        if state is not None:
            if isinstance(state, str):
                state = JobState(state)
            query["state"] = state.value

        docs = await find_with_retry(
            job_status_collection,
            query,
            sort=[("created_at", -1)],
            limit=limit,
        )

        return [doc_to_job(doc) for doc in docs]

    async def get_active_job_for_area(
        self,
        area_id: str | ObjectId,
        job_type: JobType | str | None = None,
    ) -> Job | None:
        """Get the currently running job for an area.

        Args:
            area_id: Area ID to check
            job_type: Optional job type filter

        Returns:
            Active Job or None
        """
        if isinstance(area_id, str):
            area_id = ObjectId(area_id)

        query: dict[str, Any] = {
            "area_id": area_id,
            "state": {"$in": [JobState.QUEUED.value, JobState.RUNNING.value]},
        }

        if job_type is not None:
            if isinstance(job_type, str):
                job_type = JobType(job_type)
            query["job_type"] = job_type.value

        doc = await find_one_with_retry(
            job_status_collection,
            query,
            sort=[("created_at", -1)],
        )

        if doc:
            return doc_to_job(doc)
        return None

    async def get_jobs_by_type(
        self,
        job_type: JobType | str,
        state: JobState | str | None = None,
        limit: int = 50,
    ) -> list[Job]:
        """Get jobs by type.

        Args:
            job_type: Job type to filter by
            state: Optional state filter
            limit: Maximum number of jobs to return

        Returns:
            List of Job objects
        """
        if isinstance(job_type, str):
            job_type = JobType(job_type)

        query: dict[str, Any] = {"job_type": job_type.value}
        if state is not None:
            if isinstance(state, str):
                state = JobState(state)
            query["state"] = state.value

        docs = await find_with_retry(
            job_status_collection,
            query,
            sort=[("created_at", -1)],
            limit=limit,
        )

        return [doc_to_job(doc) for doc in docs]

    async def delete_job(self, job_id: str | ObjectId) -> bool:
        """Delete a job.

        Args:
            job_id: Job ID to delete

        Returns:
            True if deletion succeeded
        """
        if isinstance(job_id, str):
            try:
                job_id = ObjectId(job_id)
            except Exception:
                return False

        result = await delete_one_with_retry(job_status_collection, {"_id": job_id})
        return result.deleted_count > 0

    async def cleanup_old_jobs(
        self,
        days_old: int = 7,
        states: list[JobState] | None = None,
    ) -> int:
        """Clean up old completed/failed jobs.

        Args:
            days_old: Delete jobs older than this many days
            states: States to clean up (default: completed, failed, cancelled)

        Returns:
            Number of jobs deleted
        """
        from datetime import timedelta

        if states is None:
            states = [JobState.COMPLETED, JobState.FAILED, JobState.CANCELLED]

        cutoff = datetime.now(UTC) - timedelta(days=days_old)

        from db import delete_many_with_retry

        result = await delete_many_with_retry(
            job_status_collection,
            {
                "state": {"$in": [s.value for s in states]},
                "completed_at": {"$lt": cutoff},
            },
        )

        if result.deleted_count > 0:
            logger.info("Cleaned up %d old jobs", result.deleted_count)

        return result.deleted_count


# Singleton instance
job_manager = JobManager()
