import asyncio
import json
import logging
import os

import pymongo
from bson import ObjectId
from dotenv import load_dotenv
from pymongo.errors import BulkWriteError, OperationFailure

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger(__name__)

# Load environment variables from .env file
load_dotenv()

# Assuming db.py is in the same directory or accessible in PYTHONPATH
# and it defines DatabaseManager
try:
    from db import DatabaseManager
except ImportError:
    logger.error(
        "Failed to import DatabaseManager from db.py. "
        "Ensure db.py is in the PYTHONPATH or the same directory."
    )
    exit(1)


def is_valid_linestring(data: any) -> bool:
    """Validate if the data is a valid GeoJSON LineString."""
    if not isinstance(data, dict):
        return False
    if data.get("type") != "LineString":
        return False
    coordinates = data.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        return False
    for point in coordinates:
        if not isinstance(point, list) or len(point) != 2:
            return False
        if not all(isinstance(coord, (int, float)) for coord in point):
            return False
        # Validate longitude and latitude ranges
        lon, lat = point
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            logger.warning(f"Invalid coordinates: {[lon, lat]}")
            return False
    return True


async def migrate_gps_data():
    """Migrates the 'gps' field in the 'trips_collection' to be valid GeoJSON
    LineString objects.
    """
    db_manager = DatabaseManager()
    try:
        # Ensure client is initialized
        _ = db_manager.client
        # Corrected collection name
        trips_collection_name = "trips"
        trips_collection = db_manager.get_collection(trips_collection_name)
        logger.info(
            f"Successfully connected to MongoDB and got '{trips_collection_name}' collection."
        )

        db_instance = db_manager.db
        collection_names = await db_instance.list_collection_names()
        logger.info(
            f"Available collections in the database '{db_instance.name}': {collection_names}"
        )

    except Exception as e:
        logger.error(f"Failed to connect to MongoDB or get collection: {e}")
        return

    migrated_count = 0
    error_count = 0
    already_correct_count = 0
    documents_to_update = []

    # Fetch all documents that have a 'gps' field.
    # We process in batches to avoid loading too much data into memory.
    batch_size = 500
    cursor = trips_collection.find({"gps": {"$exists": True}})

    logger.info(f"Starting migration of 'gps' field in '{trips_collection.name}'...")

    async for doc in cursor:
        doc_id = doc["_id"]
        gps_data = doc.get("gps")

        if gps_data is None:
            continue  # Should not happen due to query, but good practice

        if is_valid_linestring(gps_data):
            already_correct_count += 1
            # logger.debug(f"Document {doc_id}: 'gps' field is already a valid GeoJSON LineString.")
            continue

        original_gps_data_type = type(gps_data).__name__
        new_gps_data = None

        if isinstance(gps_data, str):
            try:
                parsed_gps = json.loads(gps_data)
                if is_valid_linestring(parsed_gps):
                    new_gps_data = parsed_gps
                    logger.info(
                        f"Document {doc_id}: Converted string 'gps' field to GeoJSON LineString."
                    )
                else:
                    logger.error(
                        f"Document {doc_id}: Parsed string 'gps' field is not a valid GeoJSON LineString. Data: {gps_data[:200]}"
                    )
                    error_count += 1
            except json.JSONDecodeError:
                logger.error(
                    f"Document {doc_id}: Failed to parse string 'gps' field. Data: {gps_data[:200]}"
                )
                error_count += 1
            except Exception as e:
                logger.error(
                    f"Document {doc_id}: Unexpected error processing string 'gps' field. Error: {e}, Data: {gps_data[:200]}"
                )
                error_count += 1
        elif isinstance(gps_data, dict):
            # It's a dict but not a valid LineString as per the initial check
            logger.error(
                f"Document {doc_id}: 'gps' field is a dictionary but not a valid GeoJSON LineString. Data: {str(gps_data)[:200]}"
            )
            error_count += 1
        else:
            logger.error(
                f"Document {doc_id}: 'gps' field is of unexpected type '{original_gps_data_type}'. Data: {str(gps_data)[:200]}"
            )
            error_count += 1

        if new_gps_data:
            documents_to_update.append(
                (
                    {"_id": doc_id},
                    {"$set": {"gps": new_gps_data}},
                )
            )
            migrated_count += 1

            if len(documents_to_update) >= batch_size:
                logger.info(f"Writing batch of {len(documents_to_update)} updates...")
                try:
                    operations = [
                        pymongo.UpdateOne(query, update)
                        for query, update in documents_to_update
                    ]
                    await trips_collection.bulk_write(operations, ordered=False)
                    logger.info(
                        f"Successfully wrote batch of {len(documents_to_update)} updates."
                    )
                except BulkWriteError as bwe:
                    logger.error(f"Bulk write error during migration: {bwe.details}")
                    error_count += len(
                        documents_to_update
                    )  # Assuming all in batch might have failed or partially
                except Exception as e:
                    logger.error(f"Error during bulk update: {e}")
                    error_count += len(documents_to_update)
                documents_to_update = []

    # Write any remaining updates
    if documents_to_update:
        logger.info(f"Writing final batch of {len(documents_to_update)} updates...")
        try:
            operations = [
                pymongo.UpdateOne(query, update)
                for query, update in documents_to_update
            ]
            await trips_collection.bulk_write(operations, ordered=False)
            logger.info(
                f"Successfully wrote final batch of {len(documents_to_update)} updates."
            )
        except BulkWriteError as bwe:
            logger.error(
                f"Bulk write error during final migration batch: {bwe.details}"
            )
            error_count += len(documents_to_update)
        except Exception as e:
            logger.error(f"Error during final bulk update: {e}")
            error_count += len(documents_to_update)

    logger.info("Migration process finished.")
    logger.info(
        f"Total documents processed: {migrated_count + error_count + already_correct_count}"
    )
    logger.info(f"Successfully migrated: {migrated_count}")
    logger.info(f"Already correct (no action needed): {already_correct_count}")
    logger.info(f"Errors (could not migrate): {error_count}")

    if error_count == 0 and migrated_count > 0:
        logger.info("Attempting to create 2dsphere index on 'gps' field...")
        try:
            await db_manager.safe_create_index(
                trips_collection_name,
                [("gps", "2dsphere")],
                name="gps_2dsphere_index",
            )
            # safe_create_index logs success/failure internally
        except OperationFailure as e:
            logger.error(
                f"OperationFailure during index creation on 'gps': {e}. Details: {e.details}"
            )
        except Exception as e:
            logger.error(
                f"An unexpected error occurred during index creation on 'gps': {e}"
            )
    elif error_count > 0:
        logger.warning(
            "Skipping index creation due to errors during migration. "
            "Please review the logs and fix the problematic documents."
        )
    elif migrated_count == 0 and already_correct_count > 0:
        logger.info(
            "No documents needed migration. Attempting to create 2dsphere index on 'gps' field if it doesn't exist."
        )
        try:
            await db_manager.safe_create_index(
                trips_collection_name,
                [("gps", "2dsphere")],
                name="gps_2dsphere_index",
            )
        except OperationFailure as e:
            logger.error(
                f"OperationFailure during index creation on 'gps' (no migration needed scenario): {e}. Details: {e.details}"
            )
        except Exception as e:
            logger.error(
                f"An unexpected error occurred during index creation on 'gps' (no migration needed scenario): {e}"
            )
    else:
        logger.info(
            "No documents to migrate and no documents were already correct with a 'gps' field, or no 'gps' fields found at all. Index creation skipped."
        )

    # Clean up client connection
    if db_manager.client:
        db_manager.client.close()
        logger.info("MongoDB client connection closed.")


if __name__ == "__main__":
    # Set MONGO_URI if it's not already in the environment for local testing
    # Example: os.environ["MONGO_URI"] = "mongodb://user:pass@host:port"
    # Ensure MONGODB_DATABASE is also set if not 'every_street'
    # os.environ["MONGODB_DATABASE"] = "your_db_name"

    if not os.getenv("MONGO_URI"):
        logger.error(
            "MONGO_URI environment variable not set. "
            "Please set it before running the script."
        )
        exit(1)

    asyncio.run(migrate_gps_data())
