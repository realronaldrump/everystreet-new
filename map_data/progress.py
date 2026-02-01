from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import ClassVar

from db.models import Job

DEFAULT_OPERATION_ID = "map_build"


@dataclass
class MapBuildProgress:
    """Job-backed progress tracker for map build operations."""

    job: Job
    phase: str = "idle"
    phase_progress: float = 0.0
    total_progress: float = 0.0
    started_at: datetime | None = None
    cancellation_requested: bool = False
    last_progress_at: datetime | None = None
    active_job_id: str | None = None

    PHASE_IDLE: ClassVar[str] = "idle"
    PHASE_DOWNLOADING: ClassVar[str] = "downloading"
    PHASE_BUILDING_GEOCODER: ClassVar[str] = "building_geocoder"
    PHASE_BUILDING_ROUTER: ClassVar[str] = "building_router"

    @classmethod
    async def get_or_create(cls) -> MapBuildProgress:
        job = await Job.find_one(
            {"job_type": "map_build", "operation_id": DEFAULT_OPERATION_ID},
        )
        if not job:
            job = Job(
                job_type="map_build",
                operation_id=DEFAULT_OPERATION_ID,
                status="idle",
                stage=cls.PHASE_IDLE,
                progress=0.0,
                message="Idle",
                created_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
                metadata={},
            )
            await job.insert()
        return cls.from_job(job)

    @classmethod
    def from_job(cls, job: Job) -> MapBuildProgress:
        metadata = job.metadata or {}
        phase = metadata.get("phase") or cls.PHASE_IDLE
        return cls(
            job=job,
            phase=str(phase),
            phase_progress=float(metadata.get("phase_progress", 0.0) or 0.0),
            total_progress=float(
                metadata.get("total_progress", job.progress or 0.0) or 0.0,
            ),
            started_at=metadata.get("started_at") or job.started_at,
            cancellation_requested=bool(metadata.get("cancellation_requested", False)),
            last_progress_at=metadata.get("last_progress_at") or job.updated_at,
            active_job_id=metadata.get("active_job_id"),
        )

    async def save(self) -> None:
        metadata = dict(self.job.metadata or {})
        metadata.update(
            {
                "phase": self.phase,
                "phase_progress": float(self.phase_progress),
                "total_progress": float(self.total_progress),
                "started_at": self.started_at,
                "cancellation_requested": bool(self.cancellation_requested),
                "last_progress_at": self.last_progress_at,
                "active_job_id": self.active_job_id,
            },
        )
        self.job.metadata = metadata
        self.job.stage = self.phase
        self.job.progress = float(self.total_progress)
        if self.cancellation_requested:
            self.job.status = "cancelled"
        elif self.phase == self.PHASE_IDLE:
            self.job.status = "idle"
        else:
            self.job.status = "running"
        if self.started_at and not self.job.started_at:
            self.job.started_at = self.started_at
        self.job.updated_at = datetime.now(UTC)
        await self.job.save()
