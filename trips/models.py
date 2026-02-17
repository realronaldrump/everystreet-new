"""Pydantic models for trip-related API and service operations."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


class TripStatusProjection(BaseModel):
    """Projection model for checking trip status."""

    transactionId: str | None = None
    status: str | None = None
    processing_state: str | None = None
    matchedGps: Any | None = None
    startLocation: Any | None = None
    destination: Any | None = None

    model_config = ConfigDict(extra="ignore")


class TripPreviewProjection(BaseModel):
    """Projection model for map matching previews."""

    transactionId: str | None = None
    startTime: Any | None = None
    endTime: Any | None = None
    distance: float | None = None
    matchStatus: str | None = None
    matchedGps: Any | None = None
    matched_at: Any | None = None

    model_config = ConfigDict(extra="ignore")


class TripProcessingProjection(BaseModel):
    """Projection model for batch trip processing."""

    transactionId: str | None = None
    gps: dict[str, Any] | None = None
    coordinates: list[dict[str, Any]] | None = None
    startTime: Any | None = None
    endTime: Any | None = None
    lastUpdate: Any | None = None
    totalIdleDuration: float | None = None
    source: str | None = None
    distance: float | None = None

    model_config = ConfigDict(extra="ignore")


class TripMapMatchProjection(BaseModel):
    """Minimal projection for map matching - only GPS data needed."""

    transactionId: str | None = None
    gps: dict[str, Any] | None = None
    coordinates: list[dict[str, Any]] | None = None
    startTime: Any | None = None
    endTime: Any | None = None
    matchedGps: dict[str, Any] | None = None

    model_config = ConfigDict(extra="ignore")


class MapMatchJobRequest(BaseModel):
    mode: Literal["unmatched", "date_range", "trip_id", "trip_ids"]
    start_date: str | None = None
    end_date: str | None = None
    interval_days: int = 0
    trip_id: str | None = None
    trip_ids: list[str] | None = None
    unmatched_only: bool = True
    rematch: bool = False


class TripSyncRequest(BaseModel):
    """Request model for trip sync actions."""

    mode: Literal["recent", "history", "range"] = "recent"
    start_date: datetime | None = None
    end_date: datetime | None = None
    selected_imeis: list[str] | None = None
    map_match: bool = False
    force: bool = False
    trigger_source: str | None = None


class TripSyncConfigUpdate(BaseModel):
    """Update model for trip sync settings."""

    auto_sync_enabled: bool | None = None
    interval_minutes: int | None = None
