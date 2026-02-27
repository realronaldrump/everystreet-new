"""
Database package for MongoDB operations using Beanie ODM.

This package provides a clean interface for all database operations
using Beanie ODM with Pydantic models.

Modules:
    manager: DatabaseManager singleton for connection handling
    models: Beanie Document models for all collections
    query: Query building utilities
    indexes: Index definitions and initialization

Usage:
    from db.models import Trip, Vehicle

    # Find a trip
    trip = await Trip.find_one(Trip.transactionId == "abc123")

    # Insert
    new_trip = Trip(transactionId="xyz", ...)
    await new_trip.insert()

    # Update
    trip.status = "completed"
    await trip.save()

    # Query with conditions
    vehicles = await Vehicle.find(Vehicle.is_active == True).to_list()
"""

from __future__ import annotations

import logging

from db.manager import DatabaseManager, db_manager

# ============================================================================
# Beanie Document Models
# ============================================================================
# New coverage system models
from db.models import (
    ALL_DOCUMENT_MODELS,
    AppSettings,
    BouncieCredentials,
    CoverageArea,
    CoverageState,
    GasFillup,
    H3StreetLabelCache,
    Job,
    OsmData,
    Place,
    ServerLog,
    Street,
    TaskConfig,
    TaskHistory,
    Trip,
    TripIngestIssue,
    TripMobilityProfile,
    Vehicle,
)

# ============================================================================
# Query Building
# ============================================================================
from db.query import (
    build_calendar_date_expr,
    build_query_from_request,
)

logger = logging.getLogger(__name__)


# ============================================================================
# Public API
# ============================================================================

__all__ = [
    "ALL_DOCUMENT_MODELS",
    "AppSettings",
    "BouncieCredentials",
    "CoverageArea",
    "CoverageState",
    "DatabaseManager",
    "GasFillup",
    "H3StreetLabelCache",
    "Job",
    "OsmData",
    "Place",
    "ServerLog",
    "Street",
    "TaskConfig",
    "TaskHistory",
    "Trip",
    "TripIngestIssue",
    "TripMobilityProfile",
    "Vehicle",
    "build_calendar_date_expr",
    "build_query_from_request",
    "db_manager",
]
