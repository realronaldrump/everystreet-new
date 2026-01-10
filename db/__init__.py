"""Database package for MongoDB operations using Beanie ODM.

This package provides a well-organized interface for all database operations
including connection management, Beanie document models, and utilities.

Modules:
    manager: DatabaseManager singleton for connection handling
    models: Beanie Document models for all collections
    collections: Collection proxies for backward compatibility
    operations: CRUD operations (compatibility layer)
    serializers: JSON serialization utilities
    query: Query building utilities
    indexes: Index definitions and initialization

Usage with Beanie (preferred):
    from db.models import Trip, CoverageMetadata

    # Find a trip
    trip = await Trip.find_one(Trip.transactionId == "abc123")

    # Insert
    new_trip = Trip(transactionId="xyz", ...)
    await new_trip.insert()

    # Update
    trip.status = "completed"
    await trip.save()

Legacy usage (compatibility):
    from db import db_manager, trips_collection, find_one_with_retry

    doc = await find_one_with_retry(trips_collection, {"_id": some_id})
"""

# ============================================================================
# Manager and Core
# ============================================================================
from db.manager import DatabaseManager, db_manager

# ============================================================================
# Beanie Document Models
# ============================================================================
from db.models import (
    ALL_DOCUMENT_MODELS,
    AppSettings,
    ArchivedLiveTrip,
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
# Collection Proxies (Backward Compatibility)
# ============================================================================
from db.collections import (
    CollectionProxy,
    app_settings_collection,
    archived_live_trips_collection,
    bouncie_credentials_collection,
    county_topology_collection,
    county_visited_cache_collection,
    coverage_metadata_collection,
    gas_fillups_collection,
    get_collection,
    live_trips_collection,
    matched_trips_collection,
    optimal_route_progress_collection,
    osm_data_collection,
    places_collection,
    progress_collection,
    server_logs_collection,
    streets_collection,
    task_config_collection,
    task_history_collection,
    trips_collection,
    vehicles_collection,
)

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

# ============================================================================
# CRUD Operations (Compatibility Layer)
# ============================================================================
from db.operations import (
    aggregate_with_retry,
    batch_cursor,
    count_documents_with_retry,
    delete_many_with_retry,
    delete_one_with_retry,
    find_one_with_retry,
    find_with_retry,
    get_trip_by_id,
    insert_many_with_retry,
    insert_one_with_retry,
    update_many_with_retry,
    update_one_with_retry,
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
# Serialization
# ============================================================================
from db.serializers import (
    json_dumps,
    safe_float,
    safe_int,
    serialize_datetime,
    serialize_document,
    serialize_for_json,
)

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
    # Collections (backward compatibility)
    "CollectionProxy",
    "get_collection",
    "trips_collection",
    "matched_trips_collection",
    "live_trips_collection",
    "archived_live_trips_collection",
    "coverage_metadata_collection",
    "streets_collection",
    "osm_data_collection",
    "places_collection",
    "task_config_collection",
    "task_history_collection",
    "progress_collection",
    "optimal_route_progress_collection",
    "gas_fillups_collection",
    "vehicles_collection",
    "app_settings_collection",
    "bouncie_credentials_collection",
    "server_logs_collection",
    "county_visited_cache_collection",
    "county_topology_collection",
    # Operations
    "batch_cursor",
    "find_one_with_retry",
    "find_with_retry",
    "update_one_with_retry",
    "update_many_with_retry",
    "insert_one_with_retry",
    "insert_many_with_retry",
    "delete_one_with_retry",
    "delete_many_with_retry",
    "aggregate_with_retry",
    "count_documents_with_retry",
    "get_trip_by_id",
    # Serialization
    "serialize_datetime",
    "serialize_for_json",
    "serialize_document",
    "json_dumps",
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
