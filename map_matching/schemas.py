"""Schemas for map matching job requests and responses."""

from typing import Literal

from pydantic import BaseModel


class MapMatchJobRequest(BaseModel):
    mode: Literal["unmatched", "date_range", "trip_id", "trip_ids"]
    start_date: str | None = None
    end_date: str | None = None
    interval_days: int = 0
    trip_id: str | None = None
    trip_ids: list[str] | None = None
    unmatched_only: bool = True
    rematch: bool = False
