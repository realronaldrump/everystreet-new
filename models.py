"""
Pydantic models for request validation in the street coverage tracking application.

This module contains all the Pydantic models used for data validation across
the application.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class LocationModel(BaseModel):
    """Model for location data."""

    display_name: str
    osm_id: int
    osm_type: str

    class Config:
        extra = "allow"


class TripUpdateModel(BaseModel):
    """Model for trip update data."""

    type: str
    geometry: Optional[Dict[str, Any]] = None
    properties: Dict[str, Any] = Field(default_factory=dict)


class DateRangeModel(BaseModel):
    """Model for date range data."""

    start_date: str
    end_date: str
    interval_days: int = 0


class BulkProcessModel(BaseModel):
    """Model for bulk processing parameters."""

    query: Dict[str, Any] = Field(default_factory=dict)
    options: Dict[str, bool] = Field(default_factory=dict)
    limit: int = 100


class BackgroundTasksConfigModel(BaseModel):
    """Model for background tasks configuration."""

    globalDisable: Optional[bool] = None
    tasks: Optional[Dict[str, Dict[str, Any]]] = None


class TaskRunModel(BaseModel):
    """Model for manual task run."""

    tasks: List[str]


class ValidateLocationModel(BaseModel):
    """Model for location validation."""

    location: str
    locationType: str


class CollectionModel(BaseModel):
    """Model for collection operations."""

    collection: str
