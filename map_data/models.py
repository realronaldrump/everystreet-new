"""
Map data management models.

Tracks geographic regions, their OSM data status, and build jobs
for Nominatim and Valhalla services.

Key models:
- MapRegion: A geographic region with downloadable OSM data
- MapDataJob: Job tracking for downloads and builds
- GeoServiceHealth: Health status for Nominatim and Valhalla
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, ClassVar

from beanie import Document, Indexed, PydanticObjectId
from beanie.odm.fields import IndexModel
from pydantic import Field


class MapRegion(Document):
    """
    A geographic region for map data management.

    Represents a downloadable OSM region from Geofabrik or other
    sources. Tracks download status and build status for both Nominatim
    and Valhalla.
    """

    # Identity
    name: Indexed(str, unique=True)  # Geofabrik ID, e.g., "north-america/us/texas"
    display_name: str  # Human-readable name, e.g., "Texas, United States"
    source: str = "geofabrik"  # "geofabrik", "planet", "custom"

    # Source metadata
    source_url: str | None = None  # Full download URL
    source_size_mb: float | None = None  # Size reported by source
    source_last_modified: datetime | None = None  # Last modified date from source

    # Download status
    status: str = "not_downloaded"  # See STATUS_* constants below
    pbf_path: str | None = None  # Path relative to osm_extracts volume
    download_progress: float = 0.0  # 0-100 during download
    downloaded_at: datetime | None = None
    file_size_mb: float | None = None  # Actual downloaded file size

    # Nominatim build status
    nominatim_status: str = "not_built"  # "not_built", "building", "ready", "error"
    nominatim_built_at: datetime | None = None
    nominatim_error: str | None = None

    # Valhalla build status
    valhalla_status: str = "not_built"  # "not_built", "building", "ready", "error"
    valhalla_built_at: datetime | None = None
    valhalla_error: str | None = None

    # Geographic bounds [min_lon, min_lat, max_lon, max_lat]
    bounding_box: list[float] = Field(default_factory=list)

    # Timestamps
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime | None = None

    # Error tracking
    last_error: str | None = None

    # Status constants
    STATUS_NOT_DOWNLOADED: ClassVar[str] = "not_downloaded"
    STATUS_DOWNLOADING: ClassVar[str] = "downloading"
    STATUS_DOWNLOADED: ClassVar[str] = "downloaded"
    STATUS_BUILDING_NOMINATIM: ClassVar[str] = "building_nominatim"
    STATUS_BUILDING_VALHALLA: ClassVar[str] = "building_valhalla"
    STATUS_READY: ClassVar[str] = "ready"
    STATUS_ERROR: ClassVar[str] = "error"

    class Settings:
        name = "map_regions"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel([("status", 1)], name="map_regions_status_idx"),
            IndexModel([("source", 1)], name="map_regions_source_idx"),
            IndexModel([("created_at", -1)], name="map_regions_created_idx"),
        ]

    class Config:
        extra = "allow"

    @property
    def is_ready(self) -> bool:
        """Check if region is fully ready (downloaded and both services built)."""
        return (
            self.status == self.STATUS_DOWNLOADED
            and self.nominatim_status == "ready"
            and self.valhalla_status == "ready"
        )

    @property
    def has_error(self) -> bool:
        """Check if region has any errors."""
        return (
            self.status == self.STATUS_ERROR
            or self.nominatim_status == "error"
            or self.valhalla_status == "error"
        )


class MapDataJob(Document):
    """
    Job tracking for map data operations.

    Tracks progress of downloads and builds with detailed status
    information.
    """

    # Identity
    job_type: str  # "download", "build_nominatim", "build_valhalla", "build_all"
    region_id: PydanticObjectId | None = None

    # State
    status: str = "pending"  # "pending", "running", "completed", "failed", "cancelled"
    stage: str = "Queued"  # User-friendly stage description
    progress: float = 0.0  # 0-100
    message: str = ""

    # Timing
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    started_at: datetime | None = None
    completed_at: datetime | None = None

    # Error handling
    error: str | None = None
    retry_count: int = 0
    max_retries: int = 3

    # Metrics (for download/build tracking)
    metrics: dict[str, Any] = Field(default_factory=dict)
    # Example metrics:
    # - download: {"bytes_downloaded": 0, "total_bytes": 0, "speed_mbps": 0}
    # - build: {"records_processed": 0, "total_records": 0}

    # Job type constants
    JOB_DOWNLOAD: ClassVar[str] = "download"
    JOB_BUILD_NOMINATIM: ClassVar[str] = "build_nominatim"
    JOB_BUILD_VALHALLA: ClassVar[str] = "build_valhalla"
    JOB_BUILD_ALL: ClassVar[str] = "build_all"

    # Status constants
    STATUS_PENDING: ClassVar[str] = "pending"
    STATUS_RUNNING: ClassVar[str] = "running"
    STATUS_COMPLETED: ClassVar[str] = "completed"
    STATUS_FAILED: ClassVar[str] = "failed"
    STATUS_CANCELLED: ClassVar[str] = "cancelled"

    class Settings:
        name = "map_data_jobs"
        indexes: ClassVar[list[IndexModel]] = [
            IndexModel(
                [("region_id", 1), ("job_type", 1)],
                name="map_jobs_region_type_idx",
            ),
            IndexModel([("status", 1)], name="map_jobs_status_idx"),
            IndexModel([("created_at", -1)], name="map_jobs_created_idx"),
        ]

    class Config:
        extra = "allow"

    @property
    def is_active(self) -> bool:
        """Check if job is currently active (pending or running)."""
        return self.status in (self.STATUS_PENDING, self.STATUS_RUNNING)

    @property
    def duration_seconds(self) -> float | None:
        """Calculate job duration in seconds."""
        if not self.started_at:
            return None
        end_time = self.completed_at or datetime.now(UTC)
        return (end_time - self.started_at).total_seconds()


class GeoServiceHealth(Document):
    """
    Health status tracking for geo services (Nominatim, Valhalla).

    Uses single document pattern - always has id="service_health".
    """

    id: str = Field(default="service_health", alias="_id")

    # Nominatim health
    nominatim_healthy: bool = False
    nominatim_last_check: datetime | None = None
    nominatim_response_time_ms: float | None = None
    nominatim_error: str | None = None
    nominatim_version: str | None = None
    nominatim_data_timestamp: datetime | None = None

    # Valhalla health
    valhalla_healthy: bool = False
    valhalla_last_check: datetime | None = None
    valhalla_response_time_ms: float | None = None
    valhalla_error: str | None = None
    valhalla_version: str | None = None
    valhalla_tile_count: int | None = None

    # Overall status
    last_updated: datetime | None = None

    class Settings:
        name = "geo_service_health"

    class Config:
        extra = "allow"

    @property
    def overall_healthy(self) -> bool:
        """Check if all services are healthy."""
        return self.nominatim_healthy and self.valhalla_healthy

    @classmethod
    async def get_or_create(cls) -> GeoServiceHealth:
        """Get the singleton health document, creating if necessary."""
        health = await cls.find_one({"_id": "service_health"})
        if not health:
            health = cls()
            await health.insert()
        return health
