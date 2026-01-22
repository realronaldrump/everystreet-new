"""Pydantic models for trip-related API and service operations."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class TripUpdateRequest(BaseModel):
    """A flexible model to handle trip updates from different parts of the UI."""

    geometry: dict | str | None = None
    properties: dict | None = None


class TripStatusProjection(BaseModel):
    """Projection model for checking trip status."""

    transactionId: str | None = None
    status: str | None = None
    processing_state: str | None = None
    matchedGps: Any | None = None

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
    totalIdlingTime: float | None = None
    source: str | None = None
    distance: float | None = None

    model_config = ConfigDict(extra="ignore")
