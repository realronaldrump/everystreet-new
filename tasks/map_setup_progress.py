"""Progress adapter for map setup workflows."""

from __future__ import annotations

from datetime import UTC, datetime

from map_data.models import MapServiceConfig
from map_data.progress import MapBuildProgress


class MapSetupCancelledError(RuntimeError):
    """Raised when map setup is cancelled."""


class MapSetupProgress:
    """Persist map setup progress behind a small workflow interface."""

    def __init__(
        self,
        config: MapServiceConfig,
        progress: MapBuildProgress,
    ) -> None:
        self.config = config
        self.progress = progress

    async def sync_cancellation(self, *, raise_on_cancel: bool = False) -> None:
        latest = await MapBuildProgress.get_or_create()
        self.progress.cancellation_requested = bool(latest.cancellation_requested)
        if raise_on_cancel and self.progress.cancellation_requested:
            msg = "Setup cancelled"
            raise MapSetupCancelledError(msg)

    async def check_cancelled(self) -> None:
        await self.sync_cancellation(raise_on_cancel=True)

    async def update(
        self,
        *,
        status: str | None = None,
        message: str | None = None,
        overall_progress: float | None = None,
        phase: str | None = None,
        phase_progress: float | None = None,
        geocoding_ready: bool | None = None,
        routing_ready: bool | None = None,
        last_error: str | None = None,
        allow_cancel: bool = True,
    ) -> None:
        await self.sync_cancellation(raise_on_cancel=allow_cancel)
        now = datetime.now(UTC)
        if status is not None:
            self.config.status = status
        if message is not None:
            self.config.message = message
        if overall_progress is not None:
            self.config.progress = float(overall_progress)
            self.progress.total_progress = float(overall_progress)
        if geocoding_ready is not None:
            self.config.geocoding_ready = geocoding_ready
        if routing_ready is not None:
            self.config.routing_ready = routing_ready
        if last_error is not None:
            self.config.last_error = last_error
            self.config.last_error_at = now
        self.config.last_updated = now

        if phase is not None:
            self.progress.phase = phase
        if phase_progress is not None:
            self.progress.phase_progress = float(phase_progress)
        self.progress.last_progress_at = now

        await self.config.save()
        await self.progress.save()


__all__ = ["MapSetupCancelledError", "MapSetupProgress"]
