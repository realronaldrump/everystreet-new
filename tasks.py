# tasks.py (Corrected and Complete)
"""
tasks.py

This module contains the BackgroundTaskManager class and task definitions for managing
all background operations in the application.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List, Optional
from enum import Enum
from dataclasses import dataclass
import json

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.base import JobLookupError
from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED

from bouncie_trip_fetcher import fetch_bouncie_trips_in_range
from map_matching import process_and_map_match_trip
from utils import validate_trip_data, reverse_geocode_nominatim
from street_coverage_calculation import update_coverage_for_all_locations
from update_geo_points import update_geo_points
from db import (
    trips_collection,
    live_trips_collection,
    archived_live_trips_collection,
    task_config_collection,
    matched_trips_collection,
    task_history_collection,
)

logger = logging.getLogger(__name__)


class TaskPriority(Enum):
    LOW = 1
    MEDIUM = 2
    HIGH = 3


@dataclass
class TaskDefinition:
    id: str
    display_name: str
    default_interval_minutes: int
    priority: TaskPriority
    dependencies: List[str]
    description: str


class TaskStatus(Enum):
    IDLE = "idle"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    PAUSED = "paused"


class BackgroundTaskManager:
    def __init__(self):
        self.scheduler = AsyncIOScheduler()
        self.tasks = self._initialize_tasks()
        self.task_status = {}
        self.task_progress = {}
        self.task_history = []  # This is now just an in-memory cache, db is source of truth
        self._setup_event_listeners()

    def _initialize_tasks(self) -> Dict[str, TaskDefinition]:
        return {
            # Core Data Management Tasks
            "fetch_and_store_trips": TaskDefinition(
                id="fetch_and_store_trips",
                display_name="Fetch & Store Trips",
                default_interval_minutes=30,
                priority=TaskPriority.HIGH,
                dependencies=[],
                description="Fetches new trips from Bouncie API and stores them",
            ),
            "periodic_fetch_trips": TaskDefinition(
                id="periodic_fetch_trips",
                display_name="Periodic Trip Fetch",
                default_interval_minutes=30,
                priority=TaskPriority.HIGH,
                dependencies=[],
                description="Periodically fetches trips to ensure no data gaps",
            ),
            # Coverage and Analysis Tasks
            "update_coverage_for_all_locations": TaskDefinition(
                id="update_coverage_for_all_locations",
                display_name="Update Coverage (All Locations)",
                default_interval_minutes=60,
                priority=TaskPriority.MEDIUM,
                dependencies=["fetch_and_store_trips"],
                description="Updates street coverage calculations for all locations",
            ),
            # Data Cleanup Tasks
            "cleanup_stale_trips": TaskDefinition(
                id="cleanup_stale_trips",
                display_name="Cleanup Stale Trips",
                default_interval_minutes=60,
                priority=TaskPriority.LOW,
                dependencies=[],
                description="Archives trips that haven't been updated recently",
            ),
            "cleanup_invalid_trips": TaskDefinition(
                id="cleanup_invalid_trips",
                display_name="Cleanup Invalid Trips",
                default_interval_minutes=1440,
                priority=TaskPriority.LOW,
                dependencies=[],
                description="Identifies and marks invalid trip records",
            ),
            # NEW: Geocoding Maintenance
            "update_geocoding": TaskDefinition(
                id="update_geocoding",
                display_name="Update Geocoding",
                default_interval_minutes=720,
                priority=TaskPriority.LOW,
                dependencies=[],
                description="Updates reverse geocoding for trips missing location data",
            ),
            # NEW: Database Optimization
            "optimize_database": TaskDefinition(
                id="optimize_database",
                display_name="Optimize Database",
                default_interval_minutes=1440,
                priority=TaskPriority.LOW,
                dependencies=[],
                description="Performs database maintenance and optimization",
            ),
            # NEW: Map Matching Maintenance
            "remap_unmatched_trips": TaskDefinition(
                id="remap_unmatched_trips",
                display_name="Remap Unmatched Trips",
                default_interval_minutes=360,
                priority=TaskPriority.MEDIUM,
                dependencies=["fetch_and_store_trips"],
                description="Attempts to map-match trips that previously failed",
            ),
            # NEW: Data Validation
            "validate_trip_data": TaskDefinition(
                id="validate_trip_data",
                display_name="Validate Trip Data",
                default_interval_minutes=720,
                priority=TaskPriority.LOW,
                dependencies=[],
                description="Validates and corrects trip data inconsistencies",
            ),
        }

    def _setup_event_listeners(self):
        self.scheduler.add_listener(
            self._handle_job_executed, EVENT_JOB_EXECUTED)
        self.scheduler.add_listener(self._handle_job_error, EVENT_JOB_ERROR)

    async def _handle_job_executed(self, event):
        """Handle successful job execution."""
        task_id = event.job_id
        self.task_status[task_id] = TaskStatus.COMPLETED

        # Record the execution in task history (in the database)
        history_entry = {
            "task_id": task_id,
            "status": "COMPLETED",
            "timestamp": datetime.now(timezone.utc),
            "runtime": event.runtime,
            "result": True,  # Add result field
        }
        await task_history_collection.insert_one(history_entry)

        # Update task configuration with status and next run time
        job = self.scheduler.get_job(task_id)
        next_run = job.next_run_time if job else None

        await task_config_collection.update_one(
            {"_id": "global_background_task_config"},
            {
                "$set": {
                    f"tasks.{task_id}.status": "COMPLETED",
                    f"tasks.{task_id}.last_run": datetime.now(timezone.utc),
                    f"tasks.{task_id}.next_run": next_run,
                }
            },
        )
        # Keep in-memory history up-to-date
        self._update_in_memory_history(history_entry)

    async def _handle_job_error(self, event):
        """Handle job execution error."""
        task_id = event.job_id
        self.task_status[task_id] = TaskStatus.FAILED
        error_msg = str(event.exception)

        # Record the error in task history (in the database)
        history_entry = {
            "task_id": task_id,
            "status": "FAILED",
            "timestamp": datetime.now(timezone.utc),
            "runtime": event.runtime,
            "error": error_msg,
            "result": False,  # Add result field
        }
        await task_history_collection.insert_one(history_entry)

        # Update task configuration with error status and next run time
        job = self.scheduler.get_job(task_id)
        next_run = job.next_run_time if job else None

        await task_config_collection.update_one(
            {"_id": "global_background_task_config"},
            {
                "$set": {
                    f"tasks.{task_id}.status": "FAILED",
                    f"tasks.{task_id}.last_run": datetime.now(timezone.utc),
                    f"tasks.{task_id}.last_error": error_msg,
                    f"tasks.{task_id}.next_run": next_run,
                }
            },
        )
        logger.error(f"Task {task_id} failed: {error_msg}")
        # Keep in-memory history up-to-date
        self._update_in_memory_history(history_entry)

    def _update_in_memory_history(self, entry):
        """Updates the in-memory task history (for caching purposes)."""
        self.task_history.insert(0, entry)  # Prepend to keep newest first
        # Keep only the last 50 entries
        self.task_history = self.task_history[:50]

    async def start(self):
        """Start the task manager and initialize tasks from database config."""
        if not self.scheduler.running:
            self.scheduler.start()
        await self.reinitialize_tasks()

    async def stop(self):
        """Gracefully stop all tasks and the scheduler."""
        if self.scheduler.running:
            self.scheduler.shutdown()

    async def reinitialize_tasks(self):
        """Reinitialize all tasks based on current configuration."""
        config = await self._get_config()
        if config.get("disabled"):
            logger.info("Background tasks are globally disabled")
            return

        # Remove existing jobs
        for task_id in self.tasks:
            try:
                self.scheduler.remove_job(task_id)
            except JobLookupError:
                pass

        # Add tasks based on configuration
        for task_id, task_def in self.tasks.items():
            task_config = config["tasks"].get(task_id, {})
            if task_config.get("enabled", True):
                await self.add_task(
                    task_id,
                    task_config.get(
                        "interval_minutes", task_def.default_interval_minutes
                    ),
                )

    async def add_task(self, task_id: str, interval_minutes: int):
        """Add a task to the scheduler with the specified interval."""
        if task_id not in self.tasks:
            raise ValueError(f"Unknown task ID: {task_id}")

        task_def = self.tasks[task_id]
        task_func = self._get_task_function(task_id)

        # Update task status to indicate it's being scheduled
        await task_config_collection.update_one(
            {"_id": "global_background_task_config"},
            {
                "$set": {
                    f"tasks.{task_id}.status": "IDLE",
                    f"tasks.{task_id}.interval_minutes": interval_minutes,
                    # Ensure display name is saved
                    f"tasks.{task_id}.display_name": task_def.display_name,
                    # Ensure priority is saved.
                    f"tasks.{task_id}.priority": task_def.priority.name,
                    # Ensure dependencies are saved
                    f"tasks.{task_id}.dependencies": task_def.dependencies,
                    # Ensure description is saved.
                    f"tasks.{task_id}.description": task_def.description
                }
            },
        )

        # Schedule the task
        self.scheduler.add_job(
            task_func,
            "interval",
            minutes=interval_minutes,
            id=task_id,
            max_instances=1,
            coalesce=True,
            misfire_grace_time=interval_minutes * 60,
        )

        # Update task configuration with next run time
        job = self.scheduler.get_job(task_id)
        if job and job.next_run_time:
            await task_config_collection.update_one(
                {"_id": "global_background_task_config"},
                {"$set": {f"tasks.{task_id}.next_run": job.next_run_time}},
            )

    def _get_task_function(self, task_id: str):
        """Map task IDs to their corresponding functions."""
        task_map = {
            "fetch_and_store_trips": self._fetch_and_store_trips,
            "periodic_fetch_trips": self._periodic_fetch_trips,
            "update_coverage_for_all_locations": self._update_coverage,
            "cleanup_stale_trips": self._cleanup_stale_trips,
            "cleanup_invalid_trips": self._cleanup_invalid_trips,
            "update_geocoding": self._update_geocoding,
            "optimize_database": self._optimize_database,
            "remap_unmatched_trips": self._remap_unmatched_trips,
            "validate_trip_data": self._validate_trip_data,
        }
        return task_map.get(task_id)

    async def _get_config(self) -> Dict[str, Any]:
        """Get task configuration from database."""
        cfg = await task_config_collection.find_one(
            {"_id": "global_background_task_config"}
        )
        if not cfg:
            cfg = {
                "_id": "global_background_task_config",
                "disabled": False,
                "tasks": {
                    task_id: {
                        "enabled": True,
                        "interval_minutes": task_def.default_interval_minutes,
                        "display_name": task_def.display_name,
                        "priority": task_def.priority.name,
                        "dependencies": task_def.dependencies,
                        "description": task_def.description,
                        "status": "IDLE"  # Initialize status
                    }
                    for task_id, task_def in self.tasks.items()
                },
            }
            await task_config_collection.insert_one(cfg)
        return cfg

    # Task Implementation Functions
    async def _fetch_and_store_trips(self):
        """Fetch and store new trips."""
        task_id = "fetch_and_store_trips"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)

            end_date = datetime.now(timezone.utc)
            start_date = end_date - timedelta(hours=1)
            await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=True)

        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error(f"Error in fetch_and_store_trips: {e}", exc_info=True)
            raise

    async def _periodic_fetch_trips(self):
        """Periodically fetch trips to fill gaps."""
        task_id = "periodic_fetch_trips"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            last_trip = await trips_collection.find_one(sort=[("endTime", -1)])
            if last_trip and last_trip.get("endTime"):
                start_date = last_trip["endTime"]
            else:
                start_date = datetime.now(timezone.utc) - timedelta(days=7)
            end_date = datetime.now(timezone.utc)
            await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=False)

        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error(f"Error in periodic_fetch_trips: {e}", exc_info=True)
            raise

    async def _update_coverage(self):
        """Update street coverage calculations."""
        task_id = "update_coverage_for_all_locations"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            await update_coverage_for_all_locations()

        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error(f"Error in update_coverage: {e}", exc_info=True)
            raise

    async def _cleanup_stale_trips(self):
        """Clean up stale trips."""
        task_id = "cleanup_stale_trips"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
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
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error(f"Error in cleanup_stale_trips: {e}", exc_info=True)
            raise

    async def _cleanup_invalid_trips(self):
        """Clean up invalid trips."""
        task_id = "cleanup_invalid_trips"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            async for trip in trips_collection.find({}):
                ok, msg = validate_trip_data(trip)
                if not ok:
                    await trips_collection.update_one(
                        {"_id": trip["_id"]},
                        {"$set": {"invalid": True, "validation_message": msg}},
                    )
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error(f"Error in cleanup_invalid_trips: {e}", exc_info=True)
            raise

    async def _update_geocoding(self):
        """Update geocoding for trips."""
        task_id = "update_geocoding"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            async for trip in trips_collection.find(
                {
                    "$or": [
                        {"startLocation": {"$exists": False}},
                        {"destination": {"$exists": False}},
                        {"startLocation": ""},
                        {"destination": ""},
                    ]
                }
            ):
                if trip.get("gps"):
                    gps_data = trip["gps"]
                    if isinstance(gps_data, str):
                        gps_data = json.loads(gps_data)
                    coords = gps_data.get("coordinates", [])
                    if coords:
                        start_coords = coords[0]
                        end_coords = coords[-1]
                        updates = {}

                        if not trip.get("startLocation"):
                            start_location = await reverse_geocode_nominatim(
                                start_coords[1], start_coords[0]
                            )
                            if start_location:
                                updates["startLocation"] = start_location.get(
                                    "display_name"
                                )

                        if not trip.get("destination"):
                            end_location = await reverse_geocode_nominatim(
                                end_coords[1], end_coords[0]
                            )
                            if end_location:
                                updates["destination"] = end_location.get(
                                    "display_name"
                                )

                        if updates:
                            await trips_collection.update_one(
                                {"_id": trip["_id"]}, {"$set": updates}
                            )
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error(f"Error in update_geocoding: {e}", exc_info=True)
            raise

    async def _optimize_database(self):
        """Perform database optimization tasks."""
        task_id = "optimize_database"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            # Add database optimization logic here
            # Example: Rebuild indexes
            await trips_collection.reindex()
            await live_trips_collection.reindex()
            await archived_live_trips_collection.reindex()
            await matched_trips_collection.reindex()
            # Add more optimization tasks as needed

        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error(f"Error in optimize_database: {e}", exc_info=True)
            raise

    async def _remap_unmatched_trips(self):
        """Remap trips that failed map matching."""
        task_id = "remap_unmatched_trips"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            # Find trips without matched GPS data
            async for trip in trips_collection.find(
                {"$or": [{"matchedGps": {"$exists": False}}, {"matchedGps": None}]}
            ):
                await process_and_map_match_trip(trip)
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error(f"Error in remap_unmatched_trips: {e}", exc_info=True)
            raise

    async def _validate_trip_data(self):
        """Validate and correct trip data."""
        task_id = "validate_trip_data"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            async for trip in trips_collection.find({}):
                updates = {}
                # Validate and correct timestamps
                if isinstance(trip.get("startTime"), str):
                    updates["startTime"] = datetime.fromisoformat(
                        trip["startTime"])
                if isinstance(trip.get("endTime"), str):
                    updates["endTime"] = datetime.fromisoformat(
                        trip["endTime"])

                # Validate GPS data
                if isinstance(trip.get("gps"), str):
                    try:
                        json.loads(trip["gps"])
                    except json.JSONDecodeError:
                        updates["invalid"] = True
                        updates["validation_message"] = "Invalid GPS JSON data"

                if updates:
                    await trips_collection.update_one(
                        {"_id": trip["_id"]}, {"$set": updates}
                    )
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error(f"Error in validate_trip_data: {e}", exc_info=True)
            raise

    async def _update_task_status(self, task_id: str, status: TaskStatus, error: Optional[str] = None):
        """Update task status in both memory and database."""
        self.task_status[task_id] = status

        # Get task display name
        task_def = self.tasks.get(task_id)
        display_name = task_def.display_name if task_def else task_id

        # Update task configuration
        update_data = {f"tasks.{task_id}.status": status.value}

        if status == TaskStatus.RUNNING:
            update_data[f"tasks.{task_id}.start_time"] = datetime.now(
                timezone.utc)
            update_data[f"tasks.{task_id}.last_run"] = datetime.now(
                timezone.utc)  # Update last_run when starting
        elif status in [TaskStatus.COMPLETED, TaskStatus.FAILED]:
            update_data[f"tasks.{task_id}.end_time"] = datetime.now(
                timezone.utc)

        if error:
            update_data[f"tasks.{task_id}.last_error"] = error

        # Get the job's next run time
        job = self.scheduler.get_job(task_id)
        if job and job.next_run_time:
            update_data[f"tasks.{task_id}.next_run"] = job.next_run_time

        await task_config_collection.update_one(
            {"_id": "global_background_task_config"}, {"$set": update_data}
        )

        # Add history entry
        history_entry = {
            "task_id": task_id,
            "status": status.value,
            "timestamp": datetime.now(timezone.utc),
            "result": status == TaskStatus.COMPLETED,  # Set result based on status
            "error": error,  # Include the error message
        }

        # Check if runtime exists:
        if (status == TaskStatus.COMPLETED or status == TaskStatus.FAILED):
            if 'start_time' in self.tasks[task_id].__dict__:
                history_entry["runtime"] = (datetime.now(
                    timezone.utc) - self.tasks[task_id].__dict__['start_time']).total_seconds() * 1000

        await task_history_collection.insert_one(history_entry)
        # Keep in-memory history up-to-date
        self._update_in_memory_history(history_entry)


# Create a global task manager instance
task_manager = BackgroundTaskManager()
# Corrected: Define AVAILABLE_TASKS
AVAILABLE_TASKS = list(task_manager.tasks.values())


# Startup function to be called by the application
async def start_background_tasks():
    """Start the background task manager."""
    await task_manager.start()
