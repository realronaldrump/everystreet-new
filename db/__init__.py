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

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Any

from bson import ObjectId
from motor.motor_asyncio import AsyncIOMotorCollection

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

if TYPE_CHECKING:
    from motor.motor_asyncio import AsyncIOMotorCursor

logger = logging.getLogger(__name__)


# ============================================================================
# Legacy Helper Functions (for gradual migration)
# These wrap raw Motor operations for code that hasn't been migrated to Beanie
# ============================================================================


async def find_one_with_retry(
    collection: AsyncIOMotorCollection,
    filter_dict: dict[str, Any],
    projection: dict[str, Any] | None = None,
    sort: list[tuple[str, int]] | None = None,
    max_attempts: int = 3,
) -> dict | None:
    """Find one document with retry logic.

    Args:
        collection: Motor collection
        filter_dict: MongoDB filter
        projection: Optional projection
        sort: Optional sort specification
        max_attempts: Max retry attempts

    Returns:
        Document dict or None
    """
    return await db_manager.execute_with_retry(
        lambda: collection.find_one(filter_dict, projection, sort=sort),
        max_attempts=max_attempts,
        operation_name="find_one",
    )


async def find_with_retry(
    collection: AsyncIOMotorCollection,
    filter_dict: dict[str, Any],
    projection: dict[str, Any] | None = None,
    max_attempts: int = 3,
) -> list[dict]:
    """Find documents with retry logic.

    Args:
        collection: Motor collection
        filter_dict: MongoDB filter
        projection: Optional projection
        max_attempts: Max retry attempts

    Returns:
        List of document dicts
    """

    async def _find() -> list[dict]:
        cursor = collection.find(filter_dict, projection)
        return await cursor.to_list(length=None)

    return await db_manager.execute_with_retry(
        _find,
        max_attempts=max_attempts,
        operation_name="find",
    )


async def update_one_with_retry(
    collection: AsyncIOMotorCollection,
    filter_dict: dict[str, Any],
    update: dict[str, Any],
    upsert: bool = False,
    max_attempts: int = 3,
) -> Any:
    """Update one document with retry logic.

    Args:
        collection: Motor collection
        filter_dict: MongoDB filter
        update: Update specification
        upsert: Whether to insert if not found
        max_attempts: Max retry attempts

    Returns:
        UpdateResult
    """
    return await db_manager.execute_with_retry(
        lambda: collection.update_one(filter_dict, update, upsert=upsert),
        max_attempts=max_attempts,
        operation_name="update_one",
    )


async def update_many_with_retry(
    collection: AsyncIOMotorCollection,
    filter_dict: dict[str, Any],
    update: dict[str, Any],
    max_attempts: int = 3,
) -> Any:
    """Update many documents with retry logic.

    Args:
        collection: Motor collection
        filter_dict: MongoDB filter
        update: Update specification
        max_attempts: Max retry attempts

    Returns:
        UpdateResult
    """
    return await db_manager.execute_with_retry(
        lambda: collection.update_many(filter_dict, update),
        max_attempts=max_attempts,
        operation_name="update_many",
    )


async def delete_one_with_retry(
    collection: AsyncIOMotorCollection,
    filter_dict: dict[str, Any],
    max_attempts: int = 3,
) -> Any:
    """Delete one document with retry logic.

    Args:
        collection: Motor collection
        filter_dict: MongoDB filter
        max_attempts: Max retry attempts

    Returns:
        DeleteResult
    """
    return await db_manager.execute_with_retry(
        lambda: collection.delete_one(filter_dict),
        max_attempts=max_attempts,
        operation_name="delete_one",
    )


async def delete_many_with_retry(
    collection: AsyncIOMotorCollection,
    filter_dict: dict[str, Any],
    max_attempts: int = 3,
) -> Any:
    """Delete many documents with retry logic.

    Args:
        collection: Motor collection
        filter_dict: MongoDB filter
        max_attempts: Max retry attempts

    Returns:
        DeleteResult
    """
    return await db_manager.execute_with_retry(
        lambda: collection.delete_many(filter_dict),
        max_attempts=max_attempts,
        operation_name="delete_many",
    )


async def insert_one_with_retry(
    collection: AsyncIOMotorCollection,
    document: dict[str, Any],
    max_attempts: int = 3,
) -> Any:
    """Insert one document with retry logic.

    Args:
        collection: Motor collection
        document: Document to insert
        max_attempts: Max retry attempts

    Returns:
        InsertOneResult
    """
    return await db_manager.execute_with_retry(
        lambda: collection.insert_one(document),
        max_attempts=max_attempts,
        operation_name="insert_one",
    )


async def insert_many_with_retry(
    collection: AsyncIOMotorCollection,
    documents: list[dict[str, Any]],
    max_attempts: int = 3,
    ordered: bool = True,
) -> Any:
    """Insert many documents with retry logic.

    Args:
        collection: Motor collection
        documents: List of documents to insert
        max_attempts: Max retry attempts
        ordered: Whether to stop on first error

    Returns:
        InsertManyResult
    """
    return await db_manager.execute_with_retry(
        lambda: collection.insert_many(documents, ordered=ordered),
        max_attempts=max_attempts,
        operation_name="insert_many",
    )


async def count_documents_with_retry(
    collection: AsyncIOMotorCollection,
    filter_dict: dict[str, Any],
    max_attempts: int = 3,
) -> int:
    """Count documents with retry logic.

    Args:
        collection: Motor collection
        filter_dict: MongoDB filter
        max_attempts: Max retry attempts

    Returns:
        Document count
    """
    return await db_manager.execute_with_retry(
        lambda: collection.count_documents(filter_dict),
        max_attempts=max_attempts,
        operation_name="count_documents",
    )


async def aggregate_with_retry(
    collection: AsyncIOMotorCollection,
    pipeline: list[dict[str, Any]],
    max_attempts: int = 3,
) -> list[dict]:
    """Run aggregation pipeline with retry logic.

    Args:
        collection: Motor collection
        pipeline: Aggregation pipeline
        max_attempts: Max retry attempts

    Returns:
        List of result documents
    """

    async def _aggregate() -> list[dict]:
        cursor = collection.aggregate(pipeline)
        return await cursor.to_list(length=None)

    return await db_manager.execute_with_retry(
        _aggregate,
        max_attempts=max_attempts,
        operation_name="aggregate",
    )


async def batch_cursor(
    cursor: "AsyncIOMotorCursor",
    batch_size: int = 1000,
):
    """Async generator that yields batches from a cursor.

    Args:
        cursor: Motor cursor
        batch_size: Size of each batch

    Yields:
        Lists of documents
    """
    batch = []
    async for doc in cursor:
        batch.append(doc)
        if len(batch) >= batch_size:
            yield batch
            batch = []
    if batch:
        yield batch


async def get_trip_by_id(trip_id: str) -> dict | None:
    """Get a trip by its transaction ID.

    Args:
        trip_id: Trip transaction ID

    Returns:
        Trip document dict or None
    """
    trip = await Trip.find_one(Trip.transactionId == trip_id)
    return trip.model_dump() if trip else None


def serialize_datetime(dt: datetime | None) -> str | None:
    """Serialize datetime to ISO format string.

    Args:
        dt: Datetime object

    Returns:
        ISO format string or None
    """
    if dt is None:
        return None
    return dt.isoformat()


def json_dumps(obj: Any, **kwargs) -> str:
    """JSON serialize with ObjectId and datetime support.

    Args:
        obj: Object to serialize
        **kwargs: Additional json.dumps arguments

    Returns:
        JSON string
    """

    def default_serializer(o: Any) -> Any:
        if isinstance(o, ObjectId):
            return str(o)
        if isinstance(o, datetime):
            return o.isoformat()
        raise TypeError(f"Object of type {type(o)} is not JSON serializable")

    return json.dumps(obj, default=default_serializer, **kwargs)


# ============================================================================
# Collection Accessors (for code that still uses raw collections)
# ============================================================================


def get_collection(name: str) -> AsyncIOMotorCollection:
    """Get a collection by name.

    Args:
        name: Collection name

    Returns:
        Motor collection
    """
    return db_manager.get_collection(name)


# Pre-defined collection accessors for common collections
trips_collection = property(lambda self: db_manager.db["trips"])
vehicles_collection = property(lambda self: db_manager.db["vehicles"])
places_collection = property(lambda self: db_manager.db["places"])
task_config_collection = property(lambda self: db_manager.db["task_config"])
coverage_metadata_collection = property(lambda self: db_manager.db["coverage_metadata"])
streets_collection = property(lambda self: db_manager.db["streets"])
progress_collection = property(lambda self: db_manager.db["progress_status"])
optimal_route_progress_collection = property(
    lambda self: db_manager.db["optimal_route_progress"]
)
osm_data_collection = property(lambda self: db_manager.db["osm_data"])


# Create actual collection accessors (not properties)
def _get_trips_collection() -> AsyncIOMotorCollection:
    return db_manager.db["trips"]


def _get_vehicles_collection() -> AsyncIOMotorCollection:
    return db_manager.db["vehicles"]


def _get_places_collection() -> AsyncIOMotorCollection:
    return db_manager.db["places"]


def _get_task_config_collection() -> AsyncIOMotorCollection:
    return db_manager.db["task_config"]


def _get_optimal_route_progress_collection() -> AsyncIOMotorCollection:
    return db_manager.db["optimal_route_progress"]


def _get_osm_data_collection() -> AsyncIOMotorCollection:
    return db_manager.db["osm_data"]


# Make collection accessors available as module-level callables
trips_collection = _get_trips_collection
vehicles_collection = _get_vehicles_collection
places_collection = _get_places_collection
task_config_collection = _get_task_config_collection
optimal_route_progress_collection = _get_optimal_route_progress_collection
osm_data_collection = _get_osm_data_collection


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
    "BouncieCredentials",
    "ALL_DOCUMENT_MODELS",
    # Utilities
    "safe_float",
    "safe_int",
    "serialize_datetime",
    "json_dumps",
    "get_trip_by_id",
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
    # Legacy helpers (for gradual migration)
    "find_one_with_retry",
    "find_with_retry",
    "update_one_with_retry",
    "update_many_with_retry",
    "delete_one_with_retry",
    "delete_many_with_retry",
    "insert_one_with_retry",
    "insert_many_with_retry",
    "count_documents_with_retry",
    "aggregate_with_retry",
    "batch_cursor",
    "get_collection",
    # Collection accessors
    "trips_collection",
    "vehicles_collection",
    "places_collection",
    "task_config_collection",
    "optimal_route_progress_collection",
    "osm_data_collection",
]
