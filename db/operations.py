"""Database operations module.

With Beanie ODM, most CRUD operations are now handled directly on Document models.
This module provides compatibility functions for code that still uses the old patterns,
and utility functions for cursor/aggregation operations.

These functions now delegate directly to Motor without custom retry logic,
as Motor's retryWrites/retryReads handles transient failures automatically.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

import bson
from bson import ObjectId

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from motor.motor_asyncio import AsyncIOMotorCollection, AsyncIOMotorCursor
    from pymongo.results import (
        DeleteResult,
        InsertManyResult,
        InsertOneResult,
        UpdateResult,
    )

logger = logging.getLogger(__name__)


# ============================================================================
# Cursor Utilities
# ============================================================================


async def batch_cursor(
    cursor: AsyncIOMotorCursor,
    batch_size: int = 100,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Iterate over a cursor in batches.

    Yields documents in batches to reduce memory usage and improve
    performance for large result sets.

    Args:
        cursor: The MongoDB cursor to iterate.
        batch_size: Number of documents per batch.

    Yields:
        Lists of documents, each containing up to batch_size documents.
    """
    batch: list[dict[str, Any]] = []
    try:
        async for document in cursor:
            batch.append(document)
            if len(batch) >= batch_size:
                yield batch
                batch = []
                await asyncio.sleep(0)  # Yield control

        if batch:
            yield batch
    finally:
        pass


# ============================================================================
# Find Operations (Compatibility Layer)
# ============================================================================


async def find_one_with_retry(
    collection: AsyncIOMotorCollection,
    query: dict[str, Any],
    projection: Any = None,
    sort: Any = None,
) -> dict[str, Any] | None:
    """Find a single document.

    Note: Retry logic is now handled by Motor's retryReads.
    This function is kept for backward compatibility.

    Args:
        collection: The MongoDB collection.
        query: Query filter.
        projection: Fields to include/exclude.
        sort: Sort specification.

    Returns:
        The matching document or None.
    """
    if sort:
        return await collection.find_one(query, projection, sort=sort)
    return await collection.find_one(query, projection)


async def find_with_retry(
    collection: AsyncIOMotorCollection,
    query: dict[str, Any],
    projection: Any = None,
    sort: Any = None,
    limit: int | None = None,
    skip: int | None = None,
    batch_size: int = 100,
) -> list[dict[str, Any]]:
    """Find multiple documents.

    Note: Retry logic is now handled by Motor's retryReads.

    Args:
        collection: The MongoDB collection.
        query: Query filter.
        projection: Fields to include/exclude.
        sort: Sort specification.
        limit: Maximum documents to return.
        skip: Number of documents to skip.
        batch_size: Batch size for cursor iteration.

    Returns:
        List of matching documents.
    """
    cursor = collection.find(query, projection)
    if sort:
        cursor = cursor.sort(sort)
    if skip:
        cursor = cursor.skip(skip)
    if limit:
        cursor = cursor.limit(limit)

    results: list[dict[str, Any]] = []
    async for batch in batch_cursor(cursor, batch_size):
        results.extend(batch)
        if limit and len(results) >= limit:
            return results[:limit]
    return results


# ============================================================================
# Update Operations (Compatibility Layer)
# ============================================================================


async def update_one_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: dict[str, Any],
    update: dict[str, Any],
    upsert: bool = False,
) -> UpdateResult:
    """Update a single document.

    Note: Retry logic is now handled by Motor's retryWrites.

    Args:
        collection: The MongoDB collection.
        filter_query: Query filter.
        update: Update operations.
        upsert: Whether to insert if not found.

    Returns:
        The UpdateResult from MongoDB.
    """
    return await collection.update_one(filter_query, update, upsert=upsert)


async def update_many_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: dict[str, Any],
    update: dict[str, Any],
    upsert: bool = False,
) -> UpdateResult:
    """Update multiple documents.

    Note: Retry logic is now handled by Motor's retryWrites.

    Args:
        collection: The MongoDB collection.
        filter_query: Query filter.
        update: Update operations.
        upsert: Whether to insert if not found.

    Returns:
        The UpdateResult from MongoDB.
    """
    return await collection.update_many(filter_query, update, upsert=upsert)


# ============================================================================
# Insert Operations (Compatibility Layer)
# ============================================================================


async def insert_one_with_retry(
    collection: AsyncIOMotorCollection,
    document: dict[str, Any],
) -> InsertOneResult:
    """Insert a single document.

    Note: Retry logic is now handled by Motor's retryWrites.

    Args:
        collection: The MongoDB collection.
        document: Document to insert.

    Returns:
        The InsertOneResult from MongoDB.
    """
    return await collection.insert_one(document)


async def insert_many_with_retry(
    collection: AsyncIOMotorCollection,
    documents: list[dict[str, Any]],
    *,
    ordered: bool = False,
) -> InsertManyResult:
    """Insert multiple documents.

    Note: Retry logic is now handled by Motor's retryWrites.

    Args:
        collection: The MongoDB collection.
        documents: Documents to insert.
        ordered: Whether to stop on first error.

    Returns:
        The InsertManyResult from MongoDB.
    """
    return await collection.insert_many(documents, ordered=ordered)


# ============================================================================
# Delete Operations (Compatibility Layer)
# ============================================================================


async def delete_one_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: dict[str, Any],
) -> DeleteResult:
    """Delete a single document.

    Note: Retry logic is now handled by Motor's retryWrites.

    Args:
        collection: The MongoDB collection.
        filter_query: Query filter.

    Returns:
        The DeleteResult from MongoDB.
    """
    return await collection.delete_one(filter_query)


async def delete_many_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: dict[str, Any],
) -> DeleteResult:
    """Delete multiple documents.

    Note: Retry logic is now handled by Motor's retryWrites.

    Args:
        collection: The MongoDB collection.
        filter_query: Query filter.

    Returns:
        The DeleteResult from MongoDB.
    """
    return await collection.delete_many(filter_query)


# ============================================================================
# Aggregation Operations (Compatibility Layer)
# ============================================================================


async def aggregate_with_retry(
    collection: AsyncIOMotorCollection,
    pipeline: list[dict[str, Any]],
    batch_size: int = 100,
    allow_disk_use: bool = True,
) -> list[dict[str, Any]]:
    """Execute an aggregation pipeline.

    Note: Retry logic is now handled by Motor's retryReads.

    Args:
        collection: The MongoDB collection.
        pipeline: Aggregation pipeline stages.
        batch_size: Batch size for cursor iteration.
        allow_disk_use: Whether to allow disk use for large aggregations.

    Returns:
        List of aggregation results.
    """
    result: list[dict[str, Any]] = []
    cursor = collection.aggregate(pipeline, allowDiskUse=allow_disk_use)
    async for batch in batch_cursor(cursor, batch_size):
        result.extend(batch)
    return result


async def count_documents_with_retry(
    collection: AsyncIOMotorCollection,
    filter_query: dict[str, Any],
    **kwargs: Any,
) -> int:
    """Count documents matching a filter.

    Note: Retry logic is now handled by Motor's retryReads.

    Args:
        collection: The MongoDB collection.
        filter_query: Query filter.
        **kwargs: Additional count options.

    Returns:
        Number of matching documents.
    """
    return await collection.count_documents(filter_query, **kwargs)


# ============================================================================
# Trip-Specific Operations
# ============================================================================


async def get_trip_by_id(
    trip_id: str,
    collection: AsyncIOMotorCollection | None = None,
    check_both_id_types: bool = True,
) -> dict[str, Any] | None:
    """Get a trip by either transactionId or ObjectId.

    Args:
        trip_id: The trip identifier (transactionId or ObjectId string).
        collection: Optional collection override (defaults to trips_collection).
        check_both_id_types: Whether to check both transactionId and _id.

    Returns:
        The trip document or None if not found.
    """
    from db.collections import trips_collection

    if collection is None:
        collection = trips_collection

    # First try by transactionId
    trip = await find_one_with_retry(collection, {"transactionId": trip_id})

    # If not found and enabled, try by ObjectId
    if not trip and check_both_id_types and ObjectId.is_valid(trip_id):
        try:
            object_id = ObjectId(trip_id)
            trip = await find_one_with_retry(collection, {"_id": object_id})
        except bson.errors.InvalidId:
            pass
        except Exception as e:
            logger.warning(
                "Unexpected error finding trip by ObjectId %s: %s",
                trip_id,
                e,
            )

    return trip
