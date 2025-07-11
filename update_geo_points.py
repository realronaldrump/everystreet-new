"""Utility to update missing geo-points in trip documents.

This script analyzes trip documents in MongoDB collections and adds
startGeoPoint and destinationGeoPoint fields by extracting the first and last
coordinates from the GPS data. These geo-points enable geospatial queries on
trip data.
"""

import asyncio
import json
import logging
from datetime import datetime
from typing import Any

from motor.motor_asyncio import AsyncIOMotorCollection
from pymongo import UpdateOne

from db import db_manager

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


async def update_geo_points(
    collection: AsyncIOMotorCollection,
    batch_size: int = 100,
    max_concurrent_batches: int = 5,
) -> int:
    """Update documents in the given collection to add missing geo-points.

    Analyzes all documents without startGeoPoint or destinationGeoPoint and adds
    these fields using the first and last coordinates from the GPS data.

    Args:
        collection: MongoDB collection to process
        batch_size: Number of documents to process in a single batch
        max_concurrent_batches: Maximum number of batches to process concurrently

    Returns:
        int: Number of documents updated

    """
    logger.info(
        "Starting GeoPoint update for collection: %s",
        collection.name,
    )
    updated_count = 0
    semaphore = asyncio.Semaphore(max_concurrent_batches)

    try:
        query = {
            "$or": [
                {"startGeoPoint": {"$exists": False}},
                {"destinationGeoPoint": {"$exists": False}},
            ],
        }

        async def get_count():
            return await collection.count_documents(query)

        total_docs = await db_manager.execute_with_retry(
            get_count,
            operation_name=f"count_documents in {collection.name}",
        )

        logger.info(
            "Found %d documents in %s to update with geo-points",
            total_docs,
            collection.name,
        )

        if total_docs == 0:
            return 0

        async def process_batch(
            batch_docs: list[dict[str, Any]],
            batch_num: int,
        ) -> int:
            async with semaphore:
                try:
                    batch_updates = []

                    for doc in batch_docs:
                        try:
                            gps_data = doc.get("gps")
                            if not gps_data:
                                continue

                            if isinstance(gps_data, str):
                                try:
                                    gps_data = json.loads(gps_data)
                                except json.JSONDecodeError:
                                    logger.warning(
                                        "Invalid JSON in 'gps' for document %s",
                                        doc.get(
                                            "_id",
                                            "?",
                                        ),
                                    )
                                    continue

                            coords = gps_data.get("coordinates", [])
                            if len(coords) < 2:
                                logger.debug(
                                    "Skipping document %s: insufficient coordinates",
                                    doc.get("_id", "?"),
                                )
                                continue

                            start_coord = coords[0]
                            end_coord = coords[-1]

                            update_fields = {}
                            if "startGeoPoint" not in doc:
                                update_fields["startGeoPoint"] = {
                                    "type": "Point",
                                    "coordinates": start_coord,
                                }
                            if "destinationGeoPoint" not in doc:
                                update_fields["destinationGeoPoint"] = {
                                    "type": "Point",
                                    "coordinates": end_coord,
                                }

                            if update_fields:
                                update_fields["geoPointsUpdatedAt"] = datetime.utcnow()
                                batch_updates.append(
                                    UpdateOne(
                                        {"_id": doc["_id"]},
                                        {"$set": update_fields},
                                    ),
                                )

                        except Exception as e:
                            logger.error(
                                "Error processing document %s: %s",
                                doc.get("_id", "?"),
                                e,
                            )
                            continue

                    if batch_updates:
                        try:

                            async def execute_bulk():
                                result = await collection.bulk_write(
                                    batch_updates,
                                )
                                return result.modified_count

                            modified = await db_manager.execute_with_retry(
                                execute_bulk,
                                operation_name=f"bulk_write in {collection.name}",
                            )
                            logger.info(
                                "Batch %d: Updated %d/%d documents",
                                batch_num,
                                modified,
                                len(batch_updates),
                            )
                            return modified
                        except Exception as e:
                            logger.error(
                                "Error executing batch update: %s",
                                e,
                                exc_info=True,
                            )
                            return 0

                    return 0
                except Exception as e:
                    logger.error(
                        "Unexpected error processing batch %d: %s",
                        batch_num,
                        e,
                        exc_info=True,
                    )
                    return 0

        batch_num = 0
        batch_tasks = []

        async def get_cursor():
            return collection.find(query, no_cursor_timeout=True).batch_size(
                batch_size,
            )

        cursor = await db_manager.execute_with_retry(
            get_cursor,
            operation_name=f"get cursor for {collection.name}",
        )

        current_batch = []

        try:
            async for doc in cursor:
                current_batch.append(doc)

                if len(current_batch) >= batch_size:
                    batch_num += 1
                    batch_tasks.append(
                        process_batch(
                            current_batch.copy(),
                            batch_num,
                        ),
                    )
                    current_batch = []

                    if len(batch_tasks) >= max_concurrent_batches * 2:
                        completed_batch_results = await asyncio.gather(
                            *batch_tasks,
                        )
                        updated_count += sum(completed_batch_results)
                        batch_tasks = []

                        logger.info(
                            "Progress: Updated %d/%d documents (%.1f%%)",
                            updated_count,
                            total_docs,
                            ((updated_count / total_docs * 100) if total_docs else 0),
                        )

            if current_batch:
                batch_num += 1
                batch_tasks.append(process_batch(current_batch, batch_num))

            if batch_tasks:
                completed_batch_results = await asyncio.gather(*batch_tasks)
                updated_count += sum(completed_batch_results)
        finally:
            await cursor.close()

    except Exception as e:
        logger.error(
            "Error iterating collection %s: %s",
            collection.name,
            e,
            exc_info=True,
        )

    logger.info(
        "GeoPoint update for collection %s completed. Updated %d documents.",
        collection.name,
        updated_count,
    )

    return updated_count


if __name__ == "__main__":
    import os
    import sys

    from motor.motor_asyncio import AsyncIOMotorClient

    MONGO_URI = os.environ.get("MONGO_URI")
    if not MONGO_URI:
        logger.error("MONGO_URI environment variable not set")
        sys.exit(1)

    client = AsyncIOMotorClient(MONGO_URI, tz_aware=True)
    db = client["every_street"]

    if len(sys.argv) > 1:
        collection_name = sys.argv[1]
        collections = {
            "trips": db["trips"],
        }

        if collection_name in collections:
            asyncio.run(update_geo_points(collections[collection_name]))
        else:
            logger.error(
                "Invalid collection name: %s",
                collection_name,
            )
            print(f"Valid collection names: {', '.join(collections.keys())}")
            sys.exit(1)
    else:
        logger.error("No collection name provided")
        print("Usage: python update_geo_points.py [collection_name]")
        sys.exit(1)
