import asyncio
import json
import logging
import os
from typing import Any, Dict, Optional, Tuple

import pymongo
from bson import ObjectId
from dotenv import load_dotenv
from pymongo.errors import BulkWriteError, OperationFailure

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(filename)s:%(lineno)d - %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger(__name__)

# Load environment variables from .env file
load_dotenv()

try:
    from db import DatabaseManager  # Assuming db.py defines DatabaseManager
except ImportError:
    logger.error(
        "Failed to import DatabaseManager from db.py. "
        "Ensure db.py is in the PYTHONPATH or the same directory."
    )
    exit(1)


# --- GeoJSON Validation Helper ---
def is_valid_geojson_object(data: Any) -> bool:
    """
    Validates if the data is a structurally valid GeoJSON Point or LineString
    with coordinates within WGS84 bounds.
    """
    if not isinstance(data, dict):
        return False

    geom_type = data.get("type")
    coordinates = data.get("coordinates")

    if geom_type == "Point":
        if not isinstance(coordinates, list) or len(coordinates) != 2:
            return False
        if not all(isinstance(coord, (int, float)) for coord in coordinates):
            return False
        lon, lat = coordinates
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            # logger.debug(f"Point coordinates out of WGS84 range: {[lon, lat]}")
            return False
        return True

    elif geom_type == "LineString":
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            # logger.debug(f"LineString must have at least 2 coordinate pairs. Found: {len(coordinates) if isinstance(coordinates, list) else 'N/A'}")
            return False
        for point in coordinates:
            if not isinstance(point, list) or len(point) != 2:
                return False
            if not all(isinstance(coord, (int, float)) for coord in point):
                return False
            lon, lat = point
            if not (-180 <= lon <= 180 and -90 <= lat <= 90):
                # logger.debug(f"LineString point out of WGS84 range: {[lon, lat]}")
                return False
        return True

    return False


# --- Data Processing Helper ---
async def process_gps_data_field(
    gps_data_raw: Any, doc_id: ObjectId, field_name_logging_tag: str
) -> Tuple[Optional[Dict[str, Any]], bool, bool]:
    """
    Processes raw GPS data from a document field into a valid GeoJSON Point/LineString or None.

    Args:
        gps_data_raw: The raw data from the document's field.
        doc_id: The ObjectId of the document for logging.
        field_name_logging_tag: A string tag (e.g., "trips.gps") for logging.

    Returns:
        A tuple: (processed_geojson_dict_or_none, needs_update_bool, is_error_bool)
        - processed_geojson_dict_or_none: The valid GeoJSON object or None if invalid/to be unset.
        - needs_update_bool: True if the document needs an update (either set or unset).
        - is_error_bool: True if a significant error occurred during processing that implies data loss or fundamental unfixable issue.
    """
    current_data = gps_data_raw
    # is_error = False  # Becomes true for fundamental issues like JSON parsing errors on strings.

    # 1. Handle Stringified JSON
    if isinstance(current_data, str):
        try:
            current_data = json.loads(current_data)
            # logger.debug(f"Doc {doc_id} ({field_name_logging_tag}): Parsed string to {type(current_data).__name__}")
        except json.JSONDecodeError:
            logger.error(
                f"Doc {doc_id} ({field_name_logging_tag}): Failed to parse string field. Data: {current_data[:200]}"
            )
            return None, True, True  # Error, needs update (to unset)

    # 2. Handle Raw Coordinate Arrays or parsed arrays
    processed_coords_for_geojson = []
    if isinstance(current_data, list):
        # logger.debug(f"Doc {doc_id} ({field_name_logging_tag}): Processing as list.")
        for i, item in enumerate(current_data):
            lon, lat = None, None
            if isinstance(item, list) and len(item) == 2:
                lon, lat = item[0], item[1]
            elif isinstance(item, dict):
                # Try common keys for lat/lon
                if "lon" in item and "lat" in item:
                    lon, lat = item["lon"], item["lat"]
                elif "longitude" in item and "latitude" in item:
                    lon, lat = item["longitude"], item["latitude"]
                elif "lng" in item and "lat" in item:  # common in some JS contexts
                    lon, lat = item["lng"], item["lat"]
                # Add other variations if necessary

            if lon is not None and lat is not None:
                try:
                    lon_f, lat_f = float(lon), float(lat)
                    if -180 <= lon_f <= 180 and -90 <= lat_f <= 90:
                        processed_coords_for_geojson.append([lon_f, lat_f])
                    else:
                        logger.warning(
                            f"Doc {doc_id} ({field_name_logging_tag}): Coordinate out of WGS84 range: {[lon_f, lat_f]} from item {item}. Skipping."
                        )
                except (ValueError, TypeError):
                    logger.warning(
                        f"Doc {doc_id} ({field_name_logging_tag}): Invalid numeric data in coordinate item: {item}. Skipping."
                    )
            # else:
            # logger.debug(f"Doc {doc_id} ({field_name_logging_tag}): Could not extract lon/lat from list item: {item}")

        # Deduplicate and form GeoJSON from processed_coords_for_geojson
        unique_coords = []
        if processed_coords_for_geojson:
            seen_tuples = set()
            for coord_pair in processed_coords_for_geojson:
                coord_tuple = tuple(coord_pair)
                if coord_tuple not in seen_tuples:
                    unique_coords.append(coord_pair)
                    seen_tuples.add(coord_tuple)

        if len(unique_coords) == 1:
            return {"type": "Point", "coordinates": unique_coords[0]}, True, False
        elif len(unique_coords) >= 2:
            return {"type": "LineString", "coordinates": unique_coords}, True, False
        else:
            logger.warning(
                f"Doc {doc_id} ({field_name_logging_tag}): List input resulted in no valid unique points."
            )
            return None, True, False  # No error, but needs update (to unset)

    # 3. Handle Existing Dictionary (Potentially Malformed or Correct GeoJSON)
    elif isinstance(current_data, dict):
        # logger.debug(f"Doc {doc_id} ({field_name_logging_tag}): Processing as dict.")
        # Check if it's already valid (idempotency check was done outside this function)
        # This part focuses on trying to fix a dict if it's not already valid.

        geom_type = current_data.get("type")
        coordinates_raw = current_data.get("coordinates")

        valid_coords_for_dict = []

        if geom_type == "Point":
            if isinstance(coordinates_raw, list) and len(coordinates_raw) == 2:
                try:
                    lon_f, lat_f = float(coordinates_raw[0]), float(coordinates_raw[1])
                    if -180 <= lon_f <= 180 and -90 <= lat_f <= 90:
                        valid_coords_for_dict.append(
                            [lon_f, lat_f]
                        )  # For Point, this list will have 1 item
                    else:
                        logger.warning(
                            f"Doc {doc_id} ({field_name_logging_tag}): Point coordinates {coordinates_raw} out of WGS84 range."
                        )
                except (ValueError, TypeError):
                    logger.warning(
                        f"Doc {doc_id} ({field_name_logging_tag}): Point coordinates {coordinates_raw} not valid numbers."
                    )
            else:
                logger.warning(
                    f"Doc {doc_id} ({field_name_logging_tag}): Point 'coordinates' field malformed: {coordinates_raw}"
                )

            if valid_coords_for_dict:  # Should be exactly one pair
                return (
                    {"type": "Point", "coordinates": valid_coords_for_dict[0]},
                    True,
                    False,
                )
            else:
                logger.warning(
                    f"Doc {doc_id} ({field_name_logging_tag}): Could not form valid Point from dict: {current_data}"
                )
                return None, True, False

        elif geom_type == "LineString":
            if (
                isinstance(coordinates_raw, list) and len(coordinates_raw) >= 1
            ):  # Allow LineString with 1 point for now, will be converted
                seen_tuples = set()
                for p_coord in coordinates_raw:
                    if isinstance(p_coord, list) and len(p_coord) == 2:
                        try:
                            lon_f, lat_f = float(p_coord[0]), float(p_coord[1])
                            if -180 <= lon_f <= 180 and -90 <= lat_f <= 90:
                                coord_tuple_temp = tuple([lon_f, lat_f])
                                if coord_tuple_temp not in seen_tuples:
                                    valid_coords_for_dict.append([lon_f, lat_f])
                                    seen_tuples.add(coord_tuple_temp)
                            else:
                                logger.warning(
                                    f"Doc {doc_id} ({field_name_logging_tag}): LineString coord {p_coord} out of WGS84 range."
                                )
                        except (ValueError, TypeError):
                            logger.warning(
                                f"Doc {doc_id} ({field_name_logging_tag}): LineString coord {p_coord} not valid numbers."
                            )
                    else:
                        logger.warning(
                            f"Doc {doc_id} ({field_name_logging_tag}): Malformed point in LineString coordinates: {p_coord}"
                        )
            else:
                logger.warning(
                    f"Doc {doc_id} ({field_name_logging_tag}): LineString 'coordinates' field malformed or empty: {coordinates_raw}"
                )

            if len(valid_coords_for_dict) == 1:
                return (
                    {"type": "Point", "coordinates": valid_coords_for_dict[0]},
                    True,
                    False,
                )
            elif len(valid_coords_for_dict) >= 2:
                return (
                    {"type": "LineString", "coordinates": valid_coords_for_dict},
                    True,
                    False,
                )
            else:
                logger.warning(
                    f"Doc {doc_id} ({field_name_logging_tag}): Could not form valid LineString/Point from dict: {current_data}"
                )
                return None, True, False

        else:  # Dict but not Point/LineString type or type is missing.
            # Try to see if 'coordinates' field itself can be processed as a list of coordinates
            logger.warning(
                f"Doc {doc_id} ({field_name_logging_tag}): Dict is not Point/LineString (type: {geom_type}). Trying to process its 'coordinates' field if present."
            )
            if coordinates_raw and isinstance(coordinates_raw, list):
                # Fallback: treat the 'coordinates' field as a raw coordinate array
                # This recursive call is safe because it will now enter the "isinstance(current_data, list)" block
                return await process_gps_data_field(
                    coordinates_raw,
                    doc_id,
                    f"{field_name_logging_tag}[coordinates_fallback]",
                )
            logger.error(
                f"Doc {doc_id} ({field_name_logging_tag}): Dict is not Point/LineString and 'coordinates' field is not a processable list."
            )
            return None, True, True  # Error, needs update (to unset)

    # 4. Handle other unexpected types
    else:
        logger.error(
            f"Doc {doc_id} ({field_name_logging_tag}): Field is of unexpected type '{type(current_data).__name__}'. Data: {str(current_data)[:200]}"
        )
        return None, True, True  # Error, needs update (to unset)


# --- Main Migration Logic ---
async def migrate_collections_gps_data():
    db_manager = DatabaseManager()
    try:
        _ = db_manager.client  # Ensure client is initialized
        db_instance = db_manager.db
        logger.info(f"Successfully connected to MongoDB database '{db_instance.name}'.")
    except Exception as e:
        logger.error(f"Failed to connect to MongoDB or get database: {e}")
        return

    CONFIGURATIONS = [
        {
            "collection_name": "trips",
            "field_name": "gps",
            "index_name": "gps_2dsphere_index",
        },
        {
            "collection_name": "matched_trips",
            "field_name": "matchedGps",
            "index_name": "matchedGps_2dsphere_index",
        },
    ]

    overall_summary = []

    for config in CONFIGURATIONS:
        collection_name = config["collection_name"]
        field_name = config["field_name"]
        index_name = config["index_name"]

        logger.info(
            f"\n--- Processing Collection: '{collection_name}', Field: '{field_name}' ---"
        )

        try:
            collection = db_manager.get_collection(collection_name)
        except Exception as e:
            logger.error(f"Failed to get collection '{collection_name}': {e}")
            overall_summary.append(
                {
                    "collection": collection_name,
                    "field": field_name,
                    "status": "Failed to get collection",
                    "error": str(e),
                }
            )
            continue

        migrated_count = 0
        error_count = 0
        already_correct_count = 0
        unset_count = 0
        documents_to_update_ops = []
        total_docs_inspected = 0

        batch_size = 500
        # Query for documents where the field exists and is not null (None)
        # We handle null explicitly if data becomes None after processing.
        query = {field_name: {"$exists": True, "$ne": None}}

        cursor = collection.find(query)

        async for doc in cursor:
            total_docs_inspected += 1
            doc_id = doc["_id"]
            gps_data_raw = doc.get(field_name)

            if is_valid_geojson_object(gps_data_raw):
                already_correct_count += 1
                continue

            # If not already correct, process it
            logging_tag = f"{collection_name}.{field_name}"
            processed_gps_data, needs_update, is_error_flag = (
                await process_gps_data_field(gps_data_raw, doc_id, logging_tag)
            )

            if needs_update:
                if processed_gps_data is not None:
                    # Check if the processed data is actually different from raw, if raw was dict
                    # This avoids unnecessary updates if correction resulted in identical valid structure.
                    if (
                        isinstance(gps_data_raw, dict)
                        and processed_gps_data == gps_data_raw
                        and is_valid_geojson_object(processed_gps_data)
                    ):
                        already_correct_count += 1  # Considered correct after processing led to same valid state
                        # logger.debug(f"Doc {doc_id} ({logging_tag}): Processed data is same as original and valid. No update needed.")
                        continue

                    documents_to_update_ops.append(
                        pymongo.UpdateOne(
                            {"_id": doc_id}, {"$set": {field_name: processed_gps_data}}
                        )
                    )
                    migrated_count += 1
                else:  # processed_gps_data is None, field should be unset
                    documents_to_update_ops.append(
                        pymongo.UpdateOne({"_id": doc_id}, {"$unset": {field_name: ""}})
                    )
                    unset_count += 1
                    if is_error_flag:  # If it was an error that led to unsetting
                        error_count += 1
                    # logger.info(f"Doc {doc_id} ({logging_tag}): Marked for field unset. Original type: {type(gps_data_raw).__name__}")
            elif (
                is_error_flag
            ):  # Needs no update (e.g. already valid by some path not caught by initial check) but was an error
                error_count += 1

            if len(documents_to_update_ops) >= batch_size:
                logger.info(
                    f"Collection '{collection_name}': Writing batch of {len(documents_to_update_ops)} updates..."
                )
                try:
                    await collection.bulk_write(documents_to_update_ops, ordered=False)
                except BulkWriteError as bwe:
                    logger.error(
                        f"Bulk write error for '{collection_name}': {bwe.details}"
                    )
                    # Increment error_count by the number of failed operations if possible,
                    # or at least mark that a batch had errors. For simplicity, let's assume some ops might have succeeded.
                except Exception as e:
                    logger.error(
                        f"Error during bulk update for '{collection_name}': {e}"
                    )
                documents_to_update_ops = []

        # Write any remaining updates for the current collection
        if documents_to_update_ops:
            logger.info(
                f"Collection '{collection_name}': Writing final batch of {len(documents_to_update_ops)} updates..."
            )
            try:
                await collection.bulk_write(documents_to_update_ops, ordered=False)
            except BulkWriteError as bwe:
                logger.error(
                    f"Bulk write error for '{collection_name}' (final batch): {bwe.details}"
                )
            except Exception as e:
                logger.error(
                    f"Error during final bulk update for '{collection_name}': {e}"
                )

        logger.info(
            f"--- Summary for Collection: '{collection_name}', Field: '{field_name}' ---"
        )
        logger.info(
            f"Total documents inspected with field '{field_name}': {total_docs_inspected}"
        )
        logger.info(f"Successfully migrated/corrected: {migrated_count}")
        logger.info(f"Already valid GeoJSON: {already_correct_count}")
        logger.info(f"Fields unset due to invalid/unfixable data: {unset_count}")
        logger.info(f"Errors encountered (leading to unset or skipped): {error_count}")

        current_config_summary = {
            "collection": collection_name,
            "field": field_name,
            "status": "Completed",
            "total_inspected": total_docs_inspected,
            "migrated_corrected": migrated_count,
            "already_valid": already_correct_count,
            "unset_due_to_errors": unset_count,
            "processing_errors": error_count,
        }

        # Attempt to create 2dsphere index
        # Create index if there were migrations, or if data was already correct (meaning field exists and is good)
        # and no new errors were generated that specifically prevented index creation (error_count here refers to data processing errors).
        if migrated_count > 0 or (
            already_correct_count > 0 and total_docs_inspected > 0
        ):
            logger.info(
                f"Attempting to create/ensure 2dsphere index '{index_name}' on '{collection_name}.{field_name}'..."
            )
            try:
                await db_manager.safe_create_index(
                    collection_name,
                    [(field_name, "2dsphere")],
                    name=index_name,
                )
                current_config_summary["index_status"] = (
                    f"Successfully created/ensured '{index_name}'."
                )
            except OperationFailure as e:
                logger.error(
                    f"OperationFailure during index creation on '{collection_name}.{field_name}': {e}. Details: {e.details}"
                )
                current_config_summary["index_status"] = f"Failed: {e.details}"
            except Exception as e:
                logger.error(
                    f"An unexpected error occurred during index creation on '{collection_name}.{field_name}': {e}"
                )
                current_config_summary["index_status"] = f"Failed: {e}"
        elif total_docs_inspected == 0:
            logger.info(
                f"No documents with field '{field_name}' found in '{collection_name}'. Index creation skipped."
            )
            current_config_summary["index_status"] = "Skipped (no relevant documents)."
        else:  # No migrations, no already correct, or errors during processing.
            logger.warning(
                f"Skipping index creation on '{collection_name}.{field_name}' due to processing state "
                f"(migrated: {migrated_count}, already_correct: {already_correct_count}, errors: {error_count})."
            )
            current_config_summary["index_status"] = "Skipped (processing state)."

        overall_summary.append(current_config_summary)

    logger.info("\n--- Overall Migration Summary ---")
    for summary_item in overall_summary:
        logger.info(f"Collection: {summary_item['collection']}.{summary_item['field']}")
        logger.info(f"  Status: {summary_item['status']}")
        if "error" in summary_item:
            logger.info(f"  Error: {summary_item['error']}")
        else:
            logger.info(f"  Total Inspected: {summary_item['total_inspected']}")
            logger.info(f"  Migrated/Corrected: {summary_item['migrated_corrected']}")
            logger.info(f"  Already Valid: {summary_item['already_valid']}")
            logger.info(f"  Unset due to Errors: {summary_item['unset_due_to_errors']}")
            logger.info(f"  Processing Errors: {summary_item['processing_errors']}")
            logger.info(f"  Index Status: {summary_item.get('index_status', 'N/A')}")
        logger.info("-" * 20)

    # Clean up client connection
    if db_manager.client:
        db_manager.client.close()
        logger.info("MongoDB client connection closed.")


if __name__ == "__main__":
    if not os.getenv("MONGO_URI"):
        logger.error(
            "MONGO_URI environment variable not set. Please set it before running the script."
        )
        # Attempt to load from .env one more time specifically for local run
        if os.path.exists(".env"):
            logger.info(
                "Found .env file, attempting to load MONGO_URI from it for local run."
            )
            load_dotenv(
                dotenv_path=".env", override=True
            )  # Override to ensure it's picked up
            if not os.getenv("MONGO_URI"):
                logger.error(
                    "MONGO_URI still not set after attempting to load .env. Exiting."
                )
                exit(1)
            else:
                logger.info("MONGO_URI loaded successfully from .env for local run.")
        else:
            logger.error(".env file not found and MONGO_URI not set. Exiting.")
            exit(1)

    asyncio.run(migrate_collections_gps_data())
