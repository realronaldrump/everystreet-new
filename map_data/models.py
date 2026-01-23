"""Map services models for simplified setup and health tracking."""

from __future__ import annotations

from typing import ClassVar

from beanie import Document
from pydantic import ConfigDict, Field


from datetime import datetime


class MapServiceConfig(Document):
    """Singleton configuration for map services."""

    id: str = Field(default="map_service_config", alias="_id")

    selected_states: list[str] = Field(default_factory=list)
    status: str = "not_configured"
    progress: float = 0.0
    message: str = ""
    geocoding_ready: bool = False
    routing_ready: bool = False
    last_error: str | None = None
    retry_count: int = 0
    last_updated: datetime | None = None
    last_error_at: datetime | None = None

    STATUS_NOT_CONFIGURED: ClassVar[str] = "not_configured"
    STATUS_DOWNLOADING: ClassVar[str] = "downloading"
    STATUS_BUILDING: ClassVar[str] = "building"
    STATUS_READY: ClassVar[str] = "ready"
    STATUS_ERROR: ClassVar[str] = "error"

    class Settings:
        name = "map_service_config"

    model_config = ConfigDict(extra="allow")

    @property
    def is_ready(self) -> bool:
        return self.status == self.STATUS_READY

    @classmethod
    async def get_or_create(cls) -> MapServiceConfig:
        config = await cls.find_one({"_id": "map_service_config"})
        if not config:
            config = cls()
            await config.insert()
        return config


class MapBuildProgress(Document):
    """Singleton progress tracker for active map builds."""

    id: str = Field(default="map_build_progress", alias="_id")

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

    class Settings:
        name = "map_build_progress"

    model_config = ConfigDict(extra="allow")

    @classmethod
    async def get_or_create(cls) -> MapBuildProgress:
        progress = await cls.find_one({"_id": "map_build_progress"})
        if not progress:
            progress = cls()
            await progress.insert()
        return progress


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
    nominatim_container_running: bool = False
    nominatim_has_data: bool = False

    # Valhalla health
    valhalla_healthy: bool = False
    valhalla_last_check: datetime | None = None
    valhalla_response_time_ms: float | None = None
    valhalla_error: str | None = None
    valhalla_version: str | None = None
    valhalla_tile_count: int | None = None
    valhalla_container_running: bool = False
    valhalla_has_data: bool = False

    # Overall status
    last_updated: datetime | None = None

    class Settings:
        name = "geo_service_health"

    model_config = ConfigDict(extra="allow")

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
