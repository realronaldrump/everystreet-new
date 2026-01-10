"""Database index definitions and initialization.

Provides functions to ensure all application indexes are created
with proper handling of conflicts and duplicates.
"""

from __future__ import annotations

import logging

import pymongo

from db.manager import db_manager

logger = logging.getLogger(__name__)


# ============================================================================
# Task History Indexes
# ============================================================================


async def init_task_history_collection() -> None:
    """Initialize indexes for the task_history collection.

    Creates indexes for:
    - task_id lookup
    - timestamp ordering
    - combined task_id + timestamp queries
    """
    logger.debug("Initializing task history collection and indexes...")
    try:
        await db_manager.safe_create_index(
            "task_history",
            [("task_id", pymongo.ASCENDING)],
            name="task_history_task_id_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "task_history",
            [("timestamp", pymongo.DESCENDING)],
            name="task_history_timestamp_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "task_history",
            [
                ("task_id", pymongo.ASCENDING),
                ("timestamp", pymongo.DESCENDING),
            ],
            name="task_history_task_timestamp_idx",
            background=True,
        )
        logger.info("Task history collection indexes ensured/created successfully")
    except Exception as e:
        logger.error("Error creating task history indexes: %s", str(e))


# ============================================================================
# Street Coverage Indexes
# ============================================================================


async def ensure_street_coverage_indexes() -> None:
    """Ensure all necessary indexes exist for street coverage functionality.

    Creates indexes for:
    - coverage_metadata: display_name, status + last_updated
    - streets: location + geometry (2dsphere), location + segment_id (unique)
    - trips: time-based queries, geospatial queries, transactionId
    - matched_trips: transactionId, startTime
    """
    logger.debug("Ensuring all application indexes exist...")

    try:
        # Coverage metadata indexes
        logger.debug(
            "Ensuring indexes for 'coverage_metadata' and 'streets' collections..."
        )
        await db_manager.safe_create_index(
            "coverage_metadata",
            [("location.display_name", pymongo.ASCENDING)],
            name="coverage_metadata_display_name_idx",
            unique=True,
            background=True,
        )
        await db_manager.safe_create_index(
            "coverage_metadata",
            [("status", pymongo.ASCENDING), ("last_updated", pymongo.ASCENDING)],
            name="coverage_metadata_status_updated_idx",
            background=True,
        )

        # Streets indexes with geospatial support
        await db_manager.safe_create_index(
            "streets",
            [("properties.location", pymongo.ASCENDING), ("geometry", "2dsphere")],
            name="streets_location_geo_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "streets",
            [
                ("properties.location", pymongo.ASCENDING),
                ("properties.segment_id", pymongo.ASCENDING),
            ],
            name="streets_location_segment_id_unique_idx",
            unique=True,
            background=True,
        )

        # Trips indexes
        logger.debug("Ensuring indexes for 'trips' and 'places' functionality...")
        await db_manager.safe_create_index(
            "trips",
            [("startTime", pymongo.ASCENDING)],
            name="trips_startTime_asc_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("endTime", pymongo.ASCENDING)],
            name="trips_endTime_asc_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("destinationPlaceId", pymongo.ASCENDING)],
            name="trips_destinationPlaceId_idx",
            background=True,
            sparse=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("destinationPlaceName", pymongo.ASCENDING)],
            name="trips_destinationPlaceName_idx",
            background=True,
            sparse=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("startGeoPoint", "2dsphere")],
            name="trips_startGeoPoint_2dsphere_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("destinationGeoPoint", "2dsphere")],
            name="trips_destinationGeoPoint_2dsphere_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [
                ("startGeoPoint", "2dsphere"),
                ("destinationGeoPoint", "2dsphere"),
                ("_id", 1),
            ],
            name="trips_coverage_query_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("transactionId", pymongo.ASCENDING)],
            name="trips_transactionId_idx",
            unique=True,
            background=True,
        )
        await db_manager.safe_create_index(
            "trips",
            [("endTime", pymongo.DESCENDING)],
            name="trips_endTime_desc_idx",
            background=True,
        )

        # Matched trips indexes
        logger.debug("Ensuring indexes for 'matched_trips' collection...")
        await db_manager.safe_create_index(
            "matched_trips",
            [("transactionId", pymongo.ASCENDING)],
            name="matched_trips_transactionId_idx",
            unique=True,
            background=True,
        )
        await db_manager.safe_create_index(
            "matched_trips",
            [("startTime", pymongo.ASCENDING)],
            name="matched_trips_startTime_asc_idx",
            background=True,
        )

        logger.info("All application indexes have been ensured/created successfully.")
    except Exception as e:
        logger.error(
            "A critical error occurred while creating application indexes: %s",
            str(e),
        )
        raise


# ============================================================================
# Location Structure Indexes
# ============================================================================


async def ensure_location_indexes() -> None:
    """Ensure indexes for location-based queries on trips and matched_trips.

    Creates indexes for:
    - City-based queries on start and destination
    - State-based queries on start and destination
    - GPS 2dsphere index for geospatial queries
    """
    logger.debug("Ensuring location structure indexes exist...")
    try:
        collections = ["trips", "matched_trips"]
        for collection_name in collections:
            await db_manager.safe_create_index(
                collection_name,
                [("startLocation.address_components.city", 1)],
                name=f"{collection_name}_start_city_idx",
                background=True,
                sparse=True,
            )
            await db_manager.safe_create_index(
                collection_name,
                [("destination.address_components.city", 1)],
                name=f"{collection_name}_dest_city_idx",
                background=True,
                sparse=True,
            )
            await db_manager.safe_create_index(
                collection_name,
                [("startLocation.address_components.state", 1)],
                name=f"{collection_name}_start_state_idx",
                background=True,
                sparse=True,
            )
            await db_manager.safe_create_index(
                collection_name,
                [("destination.address_components.state", 1)],
                name=f"{collection_name}_dest_state_idx",
                background=True,
                sparse=True,
            )

        # GeoJSON 2dsphere index for trips
        await db_manager.safe_create_index(
            "trips",
            [("gps", pymongo.GEOSPHERE)],
            name="trips_gps_2dsphere_idx",
            background=True,
        )

        logger.info("Location structure indexes ensured/created successfully")
    except Exception as e:
        logger.error("Error creating location structure indexes: %s", str(e))


# ============================================================================
# Archived Trip Indexes
# ============================================================================


async def ensure_archived_trip_indexes() -> None:
    """Ensure indexes for the archived_live_trips collection.

    Creates indexes for:
    - GPS 2dsphere for geospatial queries
    - transactionId for lookup (unique)
    - endTime for time-based queries
    """
    collection_name = "archived_live_trips"

    await db_manager.safe_create_index(
        collection_name,
        [("gps", pymongo.GEOSPHERE)],
        name="archived_gps_2dsphere_idx",
        background=True,
    )
    await db_manager.safe_create_index(
        collection_name,
        "transactionId",
        name="archived_transactionId_idx",
        unique=True,
        background=True,
    )
    await db_manager.safe_create_index(
        collection_name,
        "endTime",
        name="archived_endTime_idx",
        background=True,
    )
    logger.info("Indexes ensured for '%s'.", collection_name)


# ============================================================================
# Gas Tracking Indexes
# ============================================================================


async def ensure_gas_tracking_indexes() -> None:
    """Ensure indexes for gas tracking functionality.

    Creates indexes for:
    - gas_fillups: imei + fillup_time, fillup_time, vin
    - vehicles: imei (unique), vin, is_active
    """
    logger.debug("Ensuring gas tracking indexes exist...")
    try:
        await db_manager.safe_create_index(
            "gas_fillups",
            [("imei", pymongo.ASCENDING), ("fillup_time", pymongo.DESCENDING)],
            name="gas_fillups_imei_time_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "gas_fillups",
            [("fillup_time", pymongo.DESCENDING)],
            name="gas_fillups_fillup_time_idx",
            background=True,
        )
        await db_manager.safe_create_index(
            "gas_fillups",
            [("vin", pymongo.ASCENDING)],
            name="gas_fillups_vin_idx",
            background=True,
            sparse=True,
        )
        await db_manager.safe_create_index(
            "vehicles",
            [("imei", pymongo.ASCENDING)],
            name="vehicles_imei_idx",
            unique=True,
            background=True,
        )
        await db_manager.safe_create_index(
            "vehicles",
            [("vin", pymongo.ASCENDING)],
            name="vehicles_vin_idx",
            background=True,
            sparse=True,
        )
        await db_manager.safe_create_index(
            "vehicles",
            [("is_active", pymongo.ASCENDING)],
            name="vehicles_is_active_idx",
            background=True,
        )
        logger.info("Gas tracking indexes ensured/created successfully")
    except Exception as e:
        logger.error("Error creating gas tracking indexes: %s", str(e))


# ============================================================================
# Places Indexes
# ============================================================================


async def ensure_places_indexes() -> None:
    """Ensure indexes for the places collection.

    Creates indexes for:
    - geometry 2dsphere for $geoIntersects queries in trip_processor
    """
    logger.debug("Ensuring places collection indexes exist...")
    try:
        await db_manager.safe_create_index(
            "places",
            [("geometry", pymongo.GEOSPHERE)],
            name="places_geometry_2dsphere_idx",
            background=True,
        )
        logger.info("Places collection indexes ensured/created successfully")
    except Exception as e:
        logger.error("Error creating places indexes: %s", str(e))


# ============================================================================
# Database Initialization
# ============================================================================


async def init_database() -> None:
    """Initialize the database with all required indexes and collections.

    This is the main entry point for database initialization.
    Should be called at application startup.
    """
    logger.info("Initializing database...")

    # Create all indexes
    await init_task_history_collection()
    await ensure_street_coverage_indexes()
    await ensure_location_indexes()
    await ensure_archived_trip_indexes()
    await ensure_gas_tracking_indexes()
    await ensure_places_indexes()

    # Touch collections to ensure they exist
    _ = db_manager.get_collection("places")
    _ = db_manager.get_collection("task_config")
    _ = db_manager.get_collection("progress_status")
    _ = db_manager.get_collection("osm_data")
    _ = db_manager.get_collection("live_trips")
    _ = db_manager.get_collection("archived_live_trips")
    _ = db_manager.get_collection("gas_fillups")
    _ = db_manager.get_collection("vehicles")

    logger.info("Database initialization complete.")
