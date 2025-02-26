"""
Utility to update missing geo-points in trip documents.

This script analyzes trip documents in MongoDB collections and adds startGeoPoint
and destinationGeoPoint fields by extracting the first and last coordinates from
the GPS data. These geo-points enable geospatial queries on trip data.
"""

import json
import asyncio
import logging
from typing import List, Dict, Any
from motor.motor_asyncio import AsyncIOMotorCollection

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(name)s - %(message)s",
)
logger = logging.getLogger(__name__)


async def update_geo_points(collection: AsyncIOMotorCollection) -> int:
    """
    Update documents in the given collection to add missing geo-points.

    Analyzes all documents without startGeoPoint or destinationGeoPoint and adds
    these fields using the first and last coordinates from the GPS data.

    Args:
        collection: MongoDB collection to process

    Returns:
        int: Number of documents updated
    """
    logger.info("Starting GeoPoint update for collection: %s", collection.name)
    updated_count = 0

    try:
        # Find documents missing geo-points
        query = {
            "$or": [
                {"startGeoPoint": {"$exists": False}},
                {"destinationGeoPoint": {"$exists": False}},
            ]
        }

        # Process each document
        async for doc in collection.find(query, no_cursor_timeout=True):
            try:
                # Parse GPS data if needed
                gps_data = doc.get("gps")
                if not gps_data:
                    continue

                if isinstance(gps_data, str):
                    gps_data = json.loads(gps_data)

                coords = gps_data.get("coordinates", [])
                if len(coords) < 2:
                    logger.debug(
                        "Skipping document %s: insufficient coordinates",
                        doc.get("_id", "?"),
                    )
                    continue

                # Extract start and end coordinates
                start_coord = coords[0]
                end_coord = coords[-1]

                # Prepare update
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

                # Update document if needed
                if update_fields:
                    await collection.update_one(
                        {"_id": doc["_id"]}, {"$set": update_fields}
                    )
                    updated_count += 1

                    if updated_count % 100 == 0:
                        logger.info("Updated %d documents so far", updated_count)
            except json.JSONDecodeError as e:
                logger.error(
                    "Invalid JSON in 'gps' for document %s: %s", doc.get("_id", "?"), e
                )
            except (KeyError, IndexError) as e:
                logger.warning(
                    "Skipping document %s: Incomplete GPS data - %s",
                    doc.get("_id", "?"),
                    e,
                )
            except Exception as e:
                logger.error("Error updating document %s: %s", doc.get("_id", "?"), e)

    except Exception as e:
        logger.error("Error iterating collection %s: %s", collection.name, e)

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

    # Connect to database
    MONGO_URI = os.environ.get("MONGO_URI")
    if not MONGO_URI:
        logger.error("MONGO_URI environment variable not set")
        sys.exit(1)

    client = AsyncIOMotorClient(MONGO_URI, tz_aware=True)
    db = client["every_street"]

    # Process command line argument
    if len(sys.argv) > 1:
        collection_name = sys.argv[1]
        collections = {
            "trips": db["trips"],
            "historical_trips": db["historical_trips"],
            "uploaded_trips": db["uploaded_trips"],
        }

        if collection_name in collections:
            asyncio.run(update_geo_points(collections[collection_name]))
        else:
            logger.error("Invalid collection name: %s", collection_name)
            print(f"Valid collection names: {', '.join(collections.keys())}")
            sys.exit(1)
    else:
        logger.error("No collection name provided")
        print("Usage: python update_geo_points.py [collection_name]")
        sys.exit(1)
