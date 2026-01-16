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

# New coverage system models
from coverage.models import (
    CoverageArea,
    CoverageState,
    Job,
)
from coverage.models import Street as NewStreet
from db.manager import DatabaseManager, db_manager

# ============================================================================
# Beanie Document Models
# ============================================================================
from db.models import (
    ALL_DOCUMENT_MODELS,
    AppSettings,
    BouncieCredentials,
    ExportJob,
    GasFillup,
    MatchedTrip,
    OptimalRouteProgress,
    OsmData,
    Place,
    ProgressStatus,
    ServerLog,
    Street,
    TaskConfig,
    TaskHistory,
    Trip,
    Vehicle,
)

# ============================================================================
# Query Building
# ============================================================================
from db.query import (
    build_calendar_date_expr,
    build_query_from_request,
    parse_query_date,
)

logger = logging.getLogger(__name__)


# ============================================================================
# Public API
# ============================================================================

__all__ = [
    "ALL_DOCUMENT_MODELS",
    "AppSettings",
    "BouncieCredentials",
    # New coverage system models
    "CoverageArea",
    "CoverageState",
    # Manager
    "DatabaseManager",
    "GasFillup",
    "ExportJob",
    "Job",
    "MatchedTrip",
    "NewStreet",
    "OptimalRouteProgress",
    "OsmData",
    "Place",
    "ProgressStatus",
    "ServerLog",
    "Street",
    "TaskConfig",
    "TaskHistory",
    # Beanie Models
    "Trip",
    "Vehicle",
    "build_calendar_date_expr",
    "build_query_from_request",
    "db_manager",
    # Query Building
    "parse_query_date",
]
