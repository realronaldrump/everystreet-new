"""GeoJSON generation and storage for coverage data.

Generates GeoJSON FeatureCollection of streets and stores in GridFS.
"""

from __future__ import annotations

import contextlib
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING

import bson.json_util

from db import (
    batch_cursor,
    coverage_metadata_collection,
    db_manager,
    find_one_with_retry,
    progress_collection,
    streets_collection,
    update_one_with_retry,
)

if TYPE_CHECKING:
    from motor.motor_asyncio import AsyncIOMotorGridFSBucket

logger = logging.getLogger(__name__)


async def generate_and_store_geojson(
    location_name: str | None,
    task_id: str,
) -> None:
    """Generate a GeoJSON FeatureCollection of streets and store it in GridFS.

    Args:
        location_name: Display name of the location
        task_id: Task ID for progress tracking
    """
    if not location_name:
        return

    logger.info("Task %s: Generating GeoJSON for %s...", task_id, location_name)
    await progress_collection.update_one(
        {"_id": task_id},
        {"$set": {"stage": "generating_geojson", "message": "Creating map data..."}},
        upsert=True,
    )

    fs: AsyncIOMotorGridFSBucket = db_manager.gridfs_bucket
    safe_name = "".join(
        (c if c.isalnum() or c in ["_", "-"] else "_") for c in location_name
    )
    filename = f"{safe_name}_streets.geojson"

    upload_stream = None

    try:
        # Cleanup old file
        existing_meta = await find_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {"streets_geojson_gridfs_id": 1},
        )
        if existing_meta and existing_meta.get("streets_geojson_gridfs_id"):
            with contextlib.suppress(Exception):
                await fs.delete(existing_meta["streets_geojson_gridfs_id"])

        # Stream new file
        upload_stream = fs.open_upload_stream(
            filename,
            metadata={
                "contentType": "application/json",
                "location": location_name,
                "task_id": task_id,
                "generated_at": datetime.now(UTC),
            },
        )

        await upload_stream.write(b'{"type": "FeatureCollection", "features": [\n')

        cursor = streets_collection.find(
            {"properties.location": location_name},
            {"_id": 0, "geometry": 1, "properties": 1},
        )

        first = True
        async for batch in batch_cursor(cursor, 1000):
            chunk = []
            for street in batch:
                if "geometry" not in street:
                    continue

                feature = {
                    "type": "Feature",
                    "geometry": street["geometry"],
                    "properties": street.get("properties", {}),
                }
                json_str = bson.json_util.dumps(feature)
                prefix = b"" if first else b",\n"
                chunk.append(prefix + json_str.encode("utf-8"))
                first = False

            if chunk:
                await upload_stream.write(b"".join(chunk))

        # Close JSON
        await upload_stream.write(b"\n]}")
        await upload_stream.close()

        # Update Metadata with final "completed" status
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {
                "$set": {
                    "streets_geojson_gridfs_id": upload_stream._id,  # noqa: SLF001
                    "last_geojson_update": datetime.now(UTC),
                    "status": "completed",
                    "last_updated": datetime.now(UTC),
                }
            },
        )

        await progress_collection.update_one(
            {"_id": task_id},
            {"$set": {"stage": "complete", "progress": 100, "status": "complete"}},
        )
        logger.info("Task %s: GeoJSON generation complete.", task_id)

    except Exception as e:
        logger.error("Task %s: GeoJSON generation failed: %s", task_id, e)
        if upload_stream:
            await upload_stream.abort()

        # Update task status to error so frontend stops polling
        await progress_collection.update_one(
            {"_id": task_id},
            {
                "$set": {
                    "stage": "error",
                    "status": "error",
                    "error": f"GeoJSON generation failed: {e!s}",
                }
            },
        )

        # Also update coverage_metadata_collection so the table reflects the error
        await update_one_with_retry(
            coverage_metadata_collection,
            {"location.display_name": location_name},
            {
                "$set": {
                    "status": "error",
                    "last_error": f"GeoJSON generation failed: {str(e)[:200]}",
                    "last_updated": datetime.now(UTC),
                }
            },
        )
