"""
tasks.py

This module contains background task functions that are scheduled via APScheduler.
Tasks include periodic trip fetching, hourly trip fetching, cleanup of stale or invalid trips,
and updating coverage for all locations.

It also contains helper functions to load/save task configuration and reinitialize the scheduler.

All scheduling is handled via a single global scheduler instance defined here.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.base import JobLookupError

from bouncie_trip_fetcher import fetch_bouncie_trips_in_range
from map_matching import process_and_map_match_trip
from utils import validate_trip_data
from street_coverage_calculation import update_coverage_for_all_locations, compute_coverage_for_location
from pymongo.errors import DuplicateKeyError

# Import your database collections from your asynchronous db module.
from db import (
    trips_collection,
    live_trips_collection,
    archived_live_trips_collection,
    task_config_collection,
    coverage_metadata_collection
)

logger = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(name)s - %(message)s"
)

# Create a single global APScheduler instance.
scheduler = AsyncIOScheduler()

# Task configuration for available background tasks.
AVAILABLE_TASKS = [
    {
        "id": "fetch_and_store_trips",
        "display_name": "Fetch & Store Trips",
        "default_interval_minutes": 30,
    },
    {
        "id": "periodic_fetch_trips",
        "display_name": "Periodic Trip Fetch",
        "default_interval_minutes": 30,
    },
    {
        "id": "update_coverage_for_all_locations",
        "display_name": "Update Coverage (All Locations)",
        "default_interval_minutes": 60,
    },
    {
        "id": "cleanup_stale_trips",
        "display_name": "Cleanup Stale Trips",
        "default_interval_minutes": 60,
    },
    {
        "id": "cleanup_invalid_trips",
        "display_name": "Cleanup Invalid Trips",
        "default_interval_minutes": 1440,  # once per day
    },
    {
        "id": "update_street_coverage",
        "display_name": "Update Street Coverage",
        "default_interval_minutes": 120,  # every 2 hours
    }
]

# --- Task Configuration Functions ---


async def get_task_config():
    """
    Retrieves the background task configuration document from MongoDB.
    If none exists, creates a default configuration.
    """
    cfg = await task_config_collection.find_one(
        {"_id": "global_background_task_config"}
    )
    if not cfg:
        cfg = {
            "_id": "global_background_task_config",
            "pausedUntil": None,
            "disabled": False,
            "tasks": {},
        }
        for t in AVAILABLE_TASKS:
            cfg["tasks"][t["id"]] = {
                "interval_minutes": t["default_interval_minutes"],
                "enabled": True,
            }
        await task_config_collection.insert_one(cfg)
    return cfg


async def save_task_config(cfg):
    """
    Saves the given configuration document to the database.
    """
    await task_config_collection.replace_one(
        {"_id": "global_background_task_config"}, cfg, upsert=True
    )


# --- Background Task Functions ---


async def periodic_fetch_trips():
    """Periodically fetch trips from the Bouncie API and store them."""
    try:
        last_trip = await trips_collection.find_one(sort=[("endTime", -1)])
        if last_trip and last_trip.get("endTime"):
            start_date = last_trip["endTime"]
        else:
            start_date = datetime.now(timezone.utc) - timedelta(days=7)
        end_date = datetime.now(timezone.utc)
        logger.info(
            f"Periodic trip fetch started from {start_date} to {end_date}")
        await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=False)
        logger.info("Periodic trip fetch completed successfully.")
    except Exception as e:
        logger.error(f"Error during periodic trip fetch: {e}", exc_info=True)


async def hourly_fetch_trips():
    """Fetch trips from the last hour and then map-match them."""
    try:
        end_date = datetime.now(timezone.utc)
        start_date = end_date - timedelta(hours=1)
        logger.info(
            f"Hourly trip fetch started for range: {start_date} to {end_date}")
        await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=True)
        logger.info("Hourly trip fetch completed successfully.")

        # Map match the newly fetched trips.
        logger.info("Starting map matching for hourly fetched trips...")
        current_hour_end = datetime.now(timezone.utc)
        current_hour_start = current_hour_end - timedelta(hours=1)
        cursor = trips_collection.find(
            {"startTime": {"$gte": current_hour_start, "$lte": current_hour_end}}
        )
        let_count = 0
        async for trip in cursor:
            await process_and_map_match_trip(trip)
            let_count += 1
        logger.info(
            f"Map matching completed for {let_count} hourly fetched trips.")
    except Exception as e:
        logger.error(f"Error during hourly trip fetch: {e}", exc_info=True)


async def cleanup_stale_trips():
    """Archive trips that haven't been updated in the last 5 minutes."""
    try:
        now = datetime.now(timezone.utc)
        stale_threshold = now - timedelta(minutes=5)
        cursor = live_trips_collection.find(
            {"lastUpdate": {"$lt": stale_threshold}, "status": "active"}
        )
        async for trip in cursor:
            trip["status"] = "stale"
            trip["endTime"] = now
            await archived_live_trips_collection.insert_one(trip)
            await live_trips_collection.delete_one({"_id": trip["_id"]})
    except Exception as e:
        logger.error(f"Error cleaning up stale trips: {e}", exc_info=True)


async def cleanup_invalid_trips():
    """Mark invalid trip documents based on validation failure."""
    try:
        all_trips = await trips_collection.find({}).to_list(length=None)
        for t in all_trips:
            ok, msg = validate_trip_data(t)
            if not ok:
                logger.warning(
                    f"Invalid trip {t.get('transactionId', '?')}: {msg}")
                await trips_collection.update_one(
                    {"_id": t["_id"]}, {"$set": {"invalid": True}}
                )
        logger.info("Trip cleanup done.")
    except Exception as e:
        logger.error(f"cleanup_invalid_trips: {e}", exc_info=True)


async def update_street_coverage():
    """Update street coverage for all locations that have stale data (>24h old)"""
    try:
        logger.info("Starting street coverage update for stale locations...")
        now = datetime.now(timezone.utc)
        stale_threshold = now - timedelta(hours=24)

        # Find locations with stale coverage data
        cursor = coverage_metadata_collection.find({
            "$or": [
                {"last_updated": {"$lt": stale_threshold}},
                {"last_updated": {"$exists": False}}
            ]
        })

        async for doc in cursor:
            location = doc.get("location")
            if not location or not isinstance(location, dict):
                logger.warning(
                    f"Skipping coverage update for document with invalid location data: {doc.get('_id')}")
                continue

            display_name = location.get("display_name", "Unknown")
            logger.info(f"Updating stale coverage data for {display_name}")
            result = await compute_coverage_for_location(location)

            if result:
                await coverage_metadata_collection.update_one(
                    {"location.display_name": display_name},
                    {
                        "$set": {
                            "location": location,
                            "total_length": result["total_length"],
                            "driven_length": result["driven_length"],
                            "coverage_percentage": result["coverage_percentage"],
                            "streets_data": result["streets_data"],
                            "last_updated": now,
                        }
                    },
                    upsert=True
                )
                logger.info(f"Updated coverage for {display_name}")

        logger.info("Completed street coverage update for stale locations")
    except Exception as e:
        logger.error(f"Error updating street coverage: {e}", exc_info=True)


# --- Scheduler Management Functions ---


async def reinitialize_scheduler_tasks():
    """
    Re-read the configuration from the database, remove existing jobs,
    and re-add them with the correct intervals unless globally disabled or paused.
    """
    for t in AVAILABLE_TASKS:
        job_id = t["id"]
        try:
            scheduler.remove_job(job_id)
        except JobLookupError:
            pass

    cfg = await get_task_config()
    if cfg.get("disabled"):
        logger.info(
            "Background tasks are globally disabled. No tasks scheduled.")
        return

    paused_until = cfg.get("pausedUntil")
    is_currently_paused = False
    if paused_until:
        now_utc = datetime.now(timezone.utc)
        if paused_until > now_utc:
            is_currently_paused = True

    for t in AVAILABLE_TASKS:
        task_id = t["id"]
        task_settings = cfg["tasks"].get(task_id, {})
        if not task_settings or not task_settings.get("enabled", True):
            continue
        interval = task_settings.get(
            "interval_minutes", t["default_interval_minutes"])
        # next_run_time = ( # REMOVED this line
        #     paused_until + timedelta(seconds=1) if is_currently_paused else None
        # )

        # Map task IDs to background functions.
        if task_id in ("fetch_and_store_trips", "periodic_fetch_trips"):
            job_func = periodic_fetch_trips
        elif task_id == "update_coverage_for_all_locations":
            job_func = update_coverage_for_all_locations
        elif task_id == "cleanup_stale_trips":
            job_func = cleanup_stale_trips
        elif task_id == "cleanup_invalid_trips":
            job_func = cleanup_invalid_trips
        elif task_id == "update_street_coverage":
            job_func = update_street_coverage
        else:
            continue

        scheduler.add_job(
            job_func,
            "interval",
            minutes=interval,
            id=task_id,
            # next_run_time=next_run_time, # REMOVED this line
            max_instances=1,
        )
    logger.info("Scheduler tasks reinitialized based on new config.")


async def create_required_indexes():
    """Create necessary indexes for optimal query performance."""
    try:
        logger.info("Creating indexes for coverage metadata collection...")
        await coverage_metadata_collection.create_index(
            [("location.display_name", 1)],
            background=True
        )
        logger.info(
            "Successfully created indexes for coverage metadata collection")
    except Exception as e:
        logger.error(f"Error creating indexes: {e}", exc_info=True)


async def start_background_tasks():
    """
    Start the scheduler if it's not running and initialize tasks.
    This should be called once at application startup.
    """
    await create_required_indexes()  # Create required indexes first
    if not scheduler.running:
        scheduler.start()
    await reinitialize_scheduler_tasks()
