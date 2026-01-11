"""Database package for MongoDB operations using Beanie ODM.

This package provides a clean interface for all database operations
using Beanie ODM with Pydantic models.

Modules:
    manager: DatabaseManager singleton for connection handling
    models: Beanie Document models for all collections
    query: Query building utilities
    indexes: Index definitions and initialization

Usage:
    from db.models import Trip, CoverageMetadata, Vehicle

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

# ============================================================================
# Manager and Core
# ============================================================================
# ============================================================================
# Index Management
# ============================================================================
from db.indexes import (
    ensure_archived_trip_indexes,
    ensure_gas_tracking_indexes,
    ensure_location_indexes,
    ensure_places_indexes,
    ensure_street_coverage_indexes,
    init_database,
    init_task_history_collection,
)
from db.manager import DatabaseManager, db_manager

# ============================================================================
# Beanie Document Models
# ============================================================================
from db.models import (
    ALL_DOCUMENT_MODELS,
    AppSettings,
    ArchivedLiveTrip,
    BouncieCredentials,
    CoverageMetadata,
    GasFillup,
    LiveTrip,
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

# ============================================================================
# Utilities
# ============================================================================
from db.serializers import safe_float, safe_int

# ============================================================================
# Public API
# ============================================================================

__all__ = [
    # Manager
    "DatabaseManager",
    "db_manager",
    # Beanie Models
    "Trip",
    "MatchedTrip",
    "LiveTrip",
    "ArchivedLiveTrip",
    "CoverageMetadata",
    "Street",
    "OsmData",
    "Place",
    "TaskConfig",
    "TaskHistory",
    "ProgressStatus",
    "OptimalRouteProgress",
    "GasFillup",
    "Vehicle",
    "AppSettings",
    "ServerLog",
    "ALL_DOCUMENT_MODELS",
    # Utilities
    "safe_float",
    "safe_int",
    # Query Building
    "parse_query_date",
    "build_calendar_date_expr",
    "build_query_from_request",
    # Index Management
    "init_task_history_collection",
    "ensure_street_coverage_indexes",
    "ensure_location_indexes",
    "ensure_archived_trip_indexes",
    "ensure_gas_tracking_indexes",
    "ensure_places_indexes",
    "init_database",
]
