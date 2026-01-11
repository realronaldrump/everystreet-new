"""GridFS operations for coverage GeoJSON storage.

Handles streaming, storing, and regenerating GeoJSON data in MongoDB GridFS.
"""

import json
import logging
from collections.abc import AsyncIterator

from bson import ObjectId
from gridfs import AsyncGridFSBucket, errors

from db.manager import db_manager
from db.models import CoverageMetadata, Street

logger = logging.getLogger(__name__)


class GridFSService:
    """Service for managing GeoJSON files in GridFS."""

    @property
    def bucket(self) -> AsyncGridFSBucket:
        """Get GridFS bucket from db_manager."""
        return db_manager.gridfs_bucket

    # We can access fs.files collection via db_manager.db for metadata queries if needed

    async def get_file_metadata(self, file_id: ObjectId) -> dict | None:
        """Get metadata for a GridFS file.

        Args:
            file_id: GridFS file ID

        Returns:
            File metadata or None if not found
        """
        try:
            metadata = await db_manager.db["fs.files"].find_one({"_id": file_id})
            return metadata
        except Exception as e:
            logger.error("Error fetching GridFS file metadata %s: %s", file_id, e)
            return None

    async def stream_geojson(
        self, file_id: ObjectId, location_id: str
    ) -> AsyncIterator[bytes]:
        """Stream GeoJSON data from GridFS.

        Args:
            file_id: GridFS file ID
            location_id: Coverage area location ID for logging

        Yields:
            Chunks of GeoJSON data

        Raises:
            errors.NoFile: If file not found in GridFS
        """
        grid_out_stream = None
        try:
            logger.debug(
                "[%s] Attempting to open download stream for %s.",
                location_id,
                file_id,
            )
            grid_out_stream = await self.bucket.open_download_stream(file_id)
            logger.info(
                "[%s] Successfully opened download stream for %s. Type: %s",
                location_id,
                file_id,
                type(grid_out_stream),
            )

            if grid_out_stream is None:
                logger.error(
                    "[%s] fs.open_download_stream unexpectedly returned None for %s.",
                    location_id,
                    file_id,
                )
                return

            chunk_size = 8192
            while True:
                logger.debug(
                    "[%s] Attempting to read chunk from stream for %s.",
                    location_id,
                    file_id,
                )
                chunk = await grid_out_stream.read(chunk_size)
                logger.debug(
                    "[%s] Read %d bytes for %s.",
                    location_id,
                    len(chunk),
                    file_id,
                )
                if not chunk:
                    logger.info(
                        "[%s] EOF reached for stream %s.",
                        location_id,
                        file_id,
                    )
                    break
                yield chunk

            logger.info(
                "[%s] Finished reading and yielding all chunks for %s.",
                location_id,
                file_id,
            )

        except errors.NoFile:
            logger.warning(
                "[%s] NoFile error during GridFS streaming for %s.",
                location_id,
                file_id,
                exc_info=True,
            )
            raise
        except Exception as e_stream:
            logger.error(
                "[%s] Exception during GridFS stream processing for %s: %s",
                location_id,
                file_id,
                e_stream,
                exc_info=True,
            )
            raise
        finally:
            if grid_out_stream is not None:
                logger.info(
                    "[%s] In finally block: Attempting to close stream for %s.",
                    location_id,
                    file_id,
                )
                try:
                    await grid_out_stream.close()
                    logger.info(
                        "[%s] Successfully closed GridFS stream %s.",
                        location_id,
                        file_id,
                    )
                except Exception as e_close:
                    logger.error(
                        "[%s] Error closing GridFS stream %s: %s",
                        location_id,
                        file_id,
                        e_close,
                        exc_info=True,
                    )
            else:
                logger.warning(
                    "[%s] In finally block: grid_out_stream was None for %s.",
                    location_id,
                    file_id,
                )

    async def delete_file(self, file_id: ObjectId, location_name: str = "") -> bool:
        """Delete a file from GridFS.

        Args:
            file_id: GridFS file ID
            location_name: Optional location name for logging

        Returns:
            True if deleted successfully, False otherwise
        """
        try:
            await self.bucket.delete(file_id)
            logger.info("Deleted GridFS file %s for %s", file_id, location_name)
            return True
        except errors.NoFile:
            logger.warning(
                "GridFS file %s not found for %s, continuing.",
                file_id,
                location_name,
            )
            return False
        except Exception as e:
            logger.warning(
                "Error deleting GridFS file %s for %s: %s",
                file_id,
                location_name,
                e,
            )
            return False

    async def delete_files_by_location(self, location_name: str) -> int:
        """Delete all GridFS files tagged with a location name.

        Args:
            location_name: Location display name

        Returns:
            Number of files deleted
        """
        deleted_count = 0
        try:
            # Query fs.files collection
            cursor = db_manager.db["fs.files"].find(
                {"metadata.location": location_name}, {"_id": 1}
            )
            async for file_doc in cursor:
                try:
                    await self.bucket.delete(file_doc["_id"])
                    deleted_count += 1
                    logger.info(
                        "Deleted GridFS file %s for %s",
                        file_doc["_id"],
                        location_name,
                    )
                except errors.NoFile:
                    pass
        except Exception as e:
            logger.warning(
                "Error purging GridFS files for %s: %s",
                location_name,
                e,
            )
        return deleted_count

    async def regenerate_streets_geojson(
        self, location_id: ObjectId
    ) -> ObjectId | None:
        """Regenerate and store streets GeoJSON in GridFS.

        Args:
            location_id: Coverage area ID

        Returns:
            New GridFS file ID or None on error
        """
        try:
            # Use Beanie to get metadata
            coverage_doc = await CoverageMetadata.get(location_id)

            if not coverage_doc or not coverage_doc.location.get("display_name"):
                logger.warning(
                    "Cannot regenerate GeoJSON: missing coverage metadata for %s",
                    location_id,
                )
                return None

            location_name = coverage_doc.location["display_name"]

            # Stream and clean features using Beanie
            # Fetch specific fields
            clean_features = []
            async for street in Street.find(
                {"properties.location": location_name}
            ).project(
                model=Street
            ):  # We can optimize query if needed, but iteration is fine
                if not street.geometry:
                    continue

                props = street.properties
                clean_props = {
                    "segment_id": props.get("segment_id"),
                    "street_name": props.get("street_name"),
                    "highway": props.get("highway"),
                    "segment_length": props.get("segment_length"),
                    "driven": props.get("driven"),
                    "undriveable": props.get("undriveable"),
                }
                clean_features.append(
                    {
                        "type": "Feature",
                        "geometry": street.geometry,
                        "properties": clean_props,
                    }
                )

            geojson = {"type": "FeatureCollection", "features": clean_features}

            # Delete old GridFS file if present
            # Access field directly from model
            old_id_str = coverage_doc.streets_geojson_id
            if old_id_str:
                try:
                    old_id = ObjectId(old_id_str)
                    await self.delete_file(old_id, location_name)
                except Exception:
                    pass

            # Serialize and upload
            data_bytes = json.dumps(geojson).encode("utf-8")
            new_id = await self.bucket.upload_from_stream(
                f"{location_name}_streets.geojson", data_bytes
            )

            # Update metadata
            coverage_doc.streets_geojson_id = str(new_id)
            await coverage_doc.save()

            logger.info("Regenerated GridFS geojson %s for %s", new_id, location_name)
            return new_id

        except Exception as e:
            logger.error(
                "Error regenerating GeoJSON for %s: %s",
                location_id,
                e,
                exc_info=True,
            )
            return None


# Global service instance
gridfs_service = GridFSService()
