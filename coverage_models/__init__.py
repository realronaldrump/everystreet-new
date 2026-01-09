"""New unified data models for the coverage system redesign.

This package contains Pydantic models for:
- Area: Geographic areas for coverage tracking
- Street: Street segments within areas (immutable per version)
- CoverageState: Dynamic coverage status for segments
- JobStatus: Unified job tracking
"""

from coverage_models.area import (
    Area,
    AreaCreate,
    AreaStats,
    AreaStatus,
    AreaType,
)
from coverage_models.coverage_state import (
    CoverageState,
    CoverageStatus,
    Provenance,
    ProvenanceType,
)
from coverage_models.job_status import (
    Job,
    JobCreate,
    JobState,
    JobType,
)
from coverage_models.street import (
    Street,
    StreetCreate,
)

__all__ = [
    # Area
    "Area",
    "AreaCreate",
    "AreaStats",
    "AreaStatus",
    "AreaType",
    # Street
    "Street",
    "StreetCreate",
    # CoverageState
    "CoverageState",
    "CoverageStatus",
    "Provenance",
    "ProvenanceType",
    # JobStatus
    "Job",
    "JobCreate",
    "JobState",
    "JobType",
]
