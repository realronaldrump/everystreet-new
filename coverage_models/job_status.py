"""JobStatus model for unified job tracking.

Provides a single schema for tracking all background jobs:
- Area ingestion
- Trip coverage updates
- Rebuilds
- Sanity checks
"""

from datetime import UTC, datetime
from enum import Enum
from typing import Annotated, Any

from bson import ObjectId
from pydantic import BaseModel, BeforeValidator, Field

PyObjectId = Annotated[str, BeforeValidator(str)]


class JobType(str, Enum):
    """Type of background job."""

    AREA_INGESTION = "area_ingestion"
    TRIP_COVERAGE = "trip_coverage"
    REBUILD = "rebuild"
    SANITY_CHECK = "sanity_check"
    ROUTE_GENERATION = "route_generation"


class JobState(str, Enum):
    """Job execution state."""

    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Job(BaseModel):
    """Unified job status tracking.

    Tracks progress, state, and errors for all background jobs.
    """

    id: PyObjectId | None = Field(alias="_id", default=None)

    job_type: JobType
    area_id: PyObjectId | None = None
    trip_id: str | None = None

    # State machine
    state: JobState = JobState.QUEUED
    stage: str = "queued"
    percent: float = 0.0
    message: str = ""

    # Timing
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    completed_at: datetime | None = None

    # Error handling
    error: str | None = None
    retry_count: int = 0
    max_retries: int = 3

    # Metrics (job-type specific)
    metrics: dict[str, Any] = Field(default_factory=dict)

    class Config:
        populate_by_name = True
        use_enum_values = True


class JobCreate(BaseModel):
    """Model for creating a new job."""

    job_type: JobType
    area_id: str | None = None
    trip_id: str | None = None
    max_retries: int = 3

    class Config:
        use_enum_values = True


class JobUpdate(BaseModel):
    """Model for updating job status."""

    state: JobState | None = None
    stage: str | None = None
    percent: float | None = None
    message: str | None = None
    error: str | None = None
    metrics: dict[str, Any] | None = None

    class Config:
        use_enum_values = True


def job_to_doc(job: Job) -> dict[str, Any]:
    """Convert Job model to MongoDB document."""
    doc = job.model_dump(by_alias=True, exclude_none=False)
    if doc.get("_id"):
        doc["_id"] = ObjectId(doc["_id"])
    else:
        doc.pop("_id", None)
    if doc.get("area_id"):
        doc["area_id"] = ObjectId(doc["area_id"])
    return doc


def doc_to_job(doc: dict[str, Any]) -> Job:
    """Convert MongoDB document to Job model."""
    if doc.get("_id"):
        doc["_id"] = str(doc["_id"])
    if doc.get("area_id"):
        doc["area_id"] = str(doc["area_id"])
    return Job.model_validate(doc)


def create_job_doc(
    job_type: JobType,
    area_id: str | None = None,
    trip_id: str | None = None,
    max_retries: int = 3,
) -> dict[str, Any]:
    """Create a new job document."""
    now = datetime.now(UTC)

    doc: dict[str, Any] = {
        "_id": ObjectId(),
        "job_type": job_type.value if isinstance(job_type, JobType) else job_type,
        "state": JobState.QUEUED.value,
        "stage": "queued",
        "percent": 0.0,
        "message": "Job queued",
        "created_at": now,
        "started_at": None,
        "completed_at": None,
        "error": None,
        "retry_count": 0,
        "max_retries": max_retries,
        "metrics": {},
    }

    if area_id:
        doc["area_id"] = ObjectId(area_id)
    if trip_id:
        doc["trip_id"] = trip_id

    return doc
