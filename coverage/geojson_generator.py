"""
GeoJSON generation and storage for coverage data.

Generates GeoJSON FeatureCollection of streets and stores in GridFS.
"""

from __future__ import annotations

import contextlib
import json
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from bson import ObjectId

from db.manager import db_manager
from db.models import CoverageMetadata, ProgressStatus, Street

if TYPE_CHECKING:
    from gridfs import AsyncGridFSBucket

logger = logging.getLogger(__name__)


async def generate_and_store_geojson(
    location_name: str | None,
    task_id: str,
) -> None:
    """
    Generate a GeoJSON FeatureCollection of streets and store it in GridFS.

    Args:
        location_name: Display name of the location
        task_id: Task ID for progress tracking
    """
    if not location_name:
        return

    logger.info("Task %s: Generating GeoJSON for %s...", task_id, location_name)

    # Update progress
    await _update_progress(
        task_id,
        {"stage": "generating_geojson", "message": "Creating map data..."},
    )

    fs: AsyncGridFSBucket = db_manager.gridfs_bucket
    safe_name = "".join(
        (c if c.isalnum() or c in ["_", "-"] else "_") for c in location_name
    )
    filename = f"{safe_name}_streets.geojson"

    upload_stream = None

    try:
        # Cleanup old file

        # We can just fetch the doc, it's not huge.
        existing_meta_doc = await CoverageMetadata.find_one(
            {"location.display_name": location_name},
        )

        if existing_meta_doc and existing_meta_doc.streets_geojson_id:
            with contextlib.suppress(Exception):
                # Ensure it's an ObjectId if needed, or string depending on what GridFS expects.
                # GridFS usually uses ObjectId. The model has it as str?
                # Check model: streets_geojson_id: str | None
                # If it's stored as str, we might need ObjectId(str) if GridFS expects that.
                # Usually standard GridFS uses ObjectId.
                try:
                    oid = ObjectId(existing_meta_doc.streets_geojson_id)
                    await fs.delete(oid)
                except Exception:
                    # Maybe it wasn't an ObjectId or file missing
                    pass

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

        # Find streets using Beanie
        # Only fetch geometry and properties
        # Beanie doesn't strictly enforce projection to dict unless .project() is used.
        # But we can just iterate the docs.
        # Using a projection model or just iterating full docs (they are loaded anyway)
        # Raw iteration via find() is fine.

        # We will use manual batching logic inline or just async iterator
        first = True

        # Beanie cursor
        async for street in Street.find({"properties.location": location_name}):
            if not street.geometry:
                continue

            feature = {
                "type": "Feature",
                "geometry": street.geometry,
                "properties": street.properties,
            }
            json_str = json.dumps(feature)
            prefix = b"" if first else b",\n"
            await upload_stream.write(prefix + json_str.encode("utf-8"))
            first = False

        # Close JSON
        await upload_stream.write(b"\n]}")
        await upload_stream.close()

        # Update Metadata with final "completed" status
        gridfs_id_str = str(upload_stream._id)

        await CoverageMetadata.find_one(
            {"location.display_name": location_name},
        ).update(
            {
                "$set": {
                    "streets_geojson_id": gridfs_id_str,  # Model field name
                    "status": "completed",
                    "last_updated": datetime.now(UTC),
                },
            },
        )

        await _update_progress(
            task_id,
            {"stage": "complete", "progress": 100, "status": "complete"},
        )

        logger.info("Task %s: GeoJSON generation complete.", task_id)

    except Exception as e:
        logger.exception("Task %s: GeoJSON generation failed: %s", task_id, e)
        if upload_stream:
            await upload_stream.abort()

        # Update task status to error
        await _update_progress(
            task_id,
            {
                "stage": "error",
                "status": "error",
                "error": f"GeoJSON generation failed: {e!s}",
            },
        )

        # Update metadata
        await CoverageMetadata.find_one(
            {"location.display_name": location_name},
        ).update(
            {
                "$set": {
                    "status": "error",
                    "last_updated": datetime.now(UTC),
                },
            },
        )


async def _update_progress(task_id: str, update_data: dict[str, Any]) -> None:
    """Helper to upsert progress."""
    status_doc = await ProgressStatus.get(task_id)
    if status_doc:
        await status_doc.set(update_data)
    else:
        status_doc = ProgressStatus(id=task_id, **update_data)
        await status_doc.insert()
