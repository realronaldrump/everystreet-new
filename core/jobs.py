from __future__ import annotations

import logging
import time
from datetime import UTC, datetime
from typing import Any

from db.models import Job

logger = logging.getLogger(__name__)


class JobHandle:
    """Helper to update job progress with optional throttling."""

    def __init__(self, job: Job, *, throttle_ms: int = 2000) -> None:
        self.job = job
        self._throttle_ms = max(0, int(throttle_ms))
        self._last_saved = 0.0

    def _should_write(self, important: bool) -> bool:
        if important or self._throttle_ms == 0:
            return True
        now = time.monotonic()
        if now - self._last_saved >= (self._throttle_ms / 1000.0):
            return True
        return False

    async def update(
        self,
        *,
        stage: str | None = None,
        progress: float | None = None,
        message: str | None = None,
        status: str | None = None,
        metadata_patch: dict[str, Any] | None = None,
        metrics: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
        error: str | None = None,
        started_at: datetime | None = None,
        completed_at: datetime | None = None,
        expires_at: datetime | None = None,
    ) -> None:
        if not self.job:
            return

        important = False
        if stage is not None:
            if stage != self.job.stage:
                important = True
            self.job.stage = stage
        if status is not None:
            if status != self.job.status:
                important = True
            self.job.status = status
        if message is not None:
            if message != self.job.message:
                important = True
            self.job.message = message
        if error is not None:
            important = True
            self.job.error = error
        if progress is not None:
            self.job.progress = float(progress)
        if metadata_patch:
            metadata = dict(self.job.metadata or {})
            metadata.update(metadata_patch)
            self.job.metadata = metadata
        if metrics is not None:
            self.job.metrics = metrics
        if result is not None:
            self.job.result = result
        if started_at is not None:
            self.job.started_at = started_at
        if completed_at is not None:
            self.job.completed_at = completed_at
        if expires_at is not None:
            self.job.expires_at = expires_at

        if not self._should_write(important):
            return

        self.job.updated_at = datetime.now(UTC)
        try:
            await self.job.save()
            self._last_saved = time.monotonic()
        except Exception:
            logger.exception("Failed to update job %s", self.job.id)

    async def complete(
        self,
        message: str | None = None,
        result: dict[str, Any] | None = None,
        metadata_patch: dict[str, Any] | None = None,
    ) -> None:
        if not self.job:
            return
        self.job.status = "completed"
        self.job.stage = "completed"
        self.job.progress = 100.0
        if message is not None:
            self.job.message = message
        if result is not None:
            self.job.result = result
        if metadata_patch:
            metadata = dict(self.job.metadata or {})
            metadata.update(metadata_patch)
            self.job.metadata = metadata
        now = datetime.now(UTC)
        self.job.completed_at = now
        self.job.updated_at = now
        try:
            await self.job.save()
            self._last_saved = time.monotonic()
        except Exception:
            logger.exception("Failed to complete job %s", self.job.id)

    async def fail(
        self,
        error: str,
        *,
        message: str | None = None,
        retryable: bool = False,
    ) -> None:
        if not self.job:
            return
        self.job.status = "failed"
        self.job.stage = "error"
        self.job.error = error
        if message is not None:
            self.job.message = message
        if retryable:
            self.job.retry_count = (self.job.retry_count or 0) + 1
        now = datetime.now(UTC)
        self.job.completed_at = now
        self.job.updated_at = now
        try:
            await self.job.save()
            self._last_saved = time.monotonic()
        except Exception:
            logger.exception("Failed to mark job %s as failed", self.job.id)


async def create_job(
    job_type: str,
    *,
    area_id: Any | None = None,
    owner_key: str | None = None,
    operation_id: str | None = None,
    task_id: str | None = None,
    metadata: dict[str, Any] | None = None,
    spec: dict[str, Any] | None = None,
    location: str | None = None,
    location_id: str | None = None,
    status: str = "pending",
    stage: str = "queued",
    message: str = "Queued",
    progress: float = 0.0,
    started_at: datetime | None = None,
    expires_at: datetime | None = None,
) -> JobHandle:
    job = Job(
        job_type=job_type,
        area_id=area_id,
        owner_key=owner_key,
        operation_id=operation_id,
        task_id=task_id,
        status=status,
        stage=stage,
        progress=progress,
        message=message,
        created_at=datetime.now(UTC),
        started_at=started_at,
        updated_at=datetime.now(UTC),
        expires_at=expires_at,
        metadata=metadata or {},
        spec=spec or {},
        location=location,
        location_id=location_id,
    )
    await job.insert()
    return JobHandle(job)


async def find_job(
    job_type: str,
    *,
    operation_id: str | None = None,
    task_id: str | None = None,
    job_id: Any | None = None,
) -> Job | None:
    if job_id is not None:
        return await Job.get(job_id)
    query: dict[str, Any] = {"job_type": job_type}
    if operation_id is not None:
        query["operation_id"] = operation_id
    if task_id is not None:
        query["task_id"] = task_id
    return await Job.find_one(query)
