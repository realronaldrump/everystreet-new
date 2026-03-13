"""Pydantic models for recurring route APIs and jobs."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class BuildRecurringRoutesRequest(BaseModel):
    algorithm_version: int = 2
    start_end_cell_size_m: int = 200
    waypoint_cell_size_m: int = 650
    waypoint_count: int = 4
    distance_bucket_miles: float = 1.0
    min_assign_trips: int = 1
    min_recurring_trips: int = 3

    model_config = ConfigDict(extra="ignore")


class PatchRecurringRouteRequest(BaseModel):
    name: str | None = Field(default=None, description="Display name override")
    color: str | None = Field(default=None, description="Hex color like #RRGGBB")
    is_pinned: bool | None = None
    is_hidden: bool | None = None

    model_config = ConfigDict(extra="ignore")
