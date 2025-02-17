import asyncio
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from enum import Enum
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.base import JobLookupError
from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED

# Local imports
from bouncie_trip_fetcher import fetch_bouncie_trips_in_range
from map_matching import process_and_map_match_trip
from utils import validate_trip_data, reverse_geocode_nominatim
from street_coverage_calculation import update_coverage_for_all_locations
from preprocess_streets import preprocess_streets as async_preprocess_streets

# Instead of building a new Motor client, use db.py
from db import db, task_history_collection

logger = logging.getLogger(__name__)


class TaskPriority(Enum):
    LOW = 1
    MEDIUM = 2
    HIGH = 3


class TaskStatus(Enum):
    IDLE = "IDLE"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    PAUSED = "PAUSED"


@dataclass
class TaskDefinition:
    id: str
    display_name: str
    default_interval_minutes: int
    priority: TaskPriority
    dependencies: List[str]
    description: str


class BackgroundTaskManager:
    """
    Manager for background tasks using APScheduler.
    """

    def __init__(self) -> None:
        self.scheduler = AsyncIOScheduler()
        self.tasks: Dict[str, TaskDefinition] = self._initialize_tasks()
        self.task_status: Dict[str, TaskStatus] = {}
        self.task_history: List[Dict[str, Any]] = []

        self.db = db  # Reuse from db.py
        self._setup_event_listeners()

    @staticmethod
    def _initialize_tasks() -> Dict[str, TaskDefinition]:
        return {
            "periodic_fetch_trips": TaskDefinition(
                id="periodic_fetch_trips",
                display_name="Periodic Trip Fetch",
                default_interval_minutes=60,
                priority=TaskPriority.HIGH,
                dependencies=[],
                description="Fetches trips from the Bouncie API periodically",
            ),
            "preprocess_streets": TaskDefinition(
                id="preprocess_streets",
                display_name="Preprocess Streets",
                default_interval_minutes=1440,
                priority=TaskPriority.LOW,
                dependencies=[],
                description="Preprocess street data for coverage calculation",
            ),
            "update_coverage_for_all_locations": TaskDefinition(
                id="update_coverage_for_all_locations",
                display_name="Update Coverage (All Locations)",
                default_interval_minutes=60,
                priority=TaskPriority.MEDIUM,
                dependencies=["periodic_fetch_trips"],
                description="Updates street coverage calculations for all locations",
            ),
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
            "update_geocoding": TaskDefinition(
                id="update_geocoding",
                display_name="Update Geocoding",
                default_interval_minutes=720,
                priority=TaskPriority.LOW,
                dependencies=[],
                description="Updates reverse geocoding for trips missing location data",
            ),
            "optimize_database": TaskDefinition(
                id="optimize_database",
                display_name="Optimize Database",
                default_interval_minutes=1440,
                priority=TaskPriority.LOW,
                dependencies=[],
                description="Performs database maintenance and optimization",
            ),
            "remap_unmatched_trips": TaskDefinition(
                id="remap_unmatched_trips",
                display_name="Remap Unmatched Trips",
                default_interval_minutes=360,
                priority=TaskPriority.MEDIUM,
                dependencies=["periodic_fetch_trips"],
                description="Attempts to map-match trips that previously failed",
            ),
            "validate_trip_data": TaskDefinition(
                id="validate_trip_data",
                display_name="Validate Trip Data",
                default_interval_minutes=720,
                priority=TaskPriority.LOW,
                dependencies=[],
                description="Validates and corrects trip data inconsistencies",
            ),
        }

    def _setup_event_listeners(self) -> None:
        def job_executed_callback(event):
            asyncio.create_task(self._handle_job_executed(event))

        def job_error_callback(event):
            asyncio.create_task(self._handle_job_error(event))

        self.scheduler.add_listener(job_executed_callback, EVENT_JOB_EXECUTED)
        self.scheduler.add_listener(job_error_callback, EVENT_JOB_ERROR)

    async def _handle_job_executed(self, event):
        try:
            task_id = (
                event.job_id.split("_manual_")[0]
                if "_manual_" in event.job_id
                else event.job_id
            )
            self.task_status[task_id] = TaskStatus.COMPLETED
            runtime = getattr(event, "runtime", None)

            history_entry = {
                "task_id": task_id,
                "status": TaskStatus.COMPLETED.value,
                "timestamp": datetime.now(timezone.utc),
                "runtime": runtime,
                "result": True,
            }
            await self.db["task_history"].insert_one(history_entry)

            job = self.scheduler.get_job(event.job_id)
            next_run = job.next_run_time if job else None
            await self._update_task_config(
                task_id,
                {
                    "status": TaskStatus.COMPLETED.value,
                    "last_run": datetime.now(timezone.utc),
                    "next_run": next_run,
                },
            )
            self._update_in_memory_history(history_entry)
        except Exception as e:
            logger.error("Error in _handle_job_executed: %s", e, exc_info=True)
            raise

    async def _handle_job_error(self, event):
        try:
            task_id = (
                event.job_id.split("_manual_")[0]
                if "_manual_" in event.job_id
                else event.job_id
            )
            self.task_status[task_id] = TaskStatus.FAILED
            error_msg = str(event.exception)
            runtime = getattr(event, "runtime", None)

            history_entry = {
                "task_id": task_id,
                "status": TaskStatus.FAILED.value,
                "timestamp": datetime.now(timezone.utc),
                "runtime": runtime,
                "error": error_msg,
                "result": False,
            }
            await self.db["task_history"].insert_one(history_entry)

            job = self.scheduler.get_job(event.job_id)
            next_run = job.next_run_time if job else None
            await self._update_task_config(
                task_id,
                {
                    "status": TaskStatus.FAILED.value,
                    "last_run": datetime.now(timezone.utc),
                    "last_error": error_msg,
                    "next_run": next_run,
                },
            )
            logger.error("Task %s failed: %s", task_id, error_msg)
            self._update_in_memory_history(history_entry)
        except Exception as e:
            logger.error("Error in _handle_job_error: %s", e, exc_info=True)
            raise

    async def _update_task_config(self, task_id: str, updates: Dict[str, Any]):
        update_dict = {f"tasks.{task_id}.{k}": v for k, v in updates.items()}
        await self.db["task_config"].update_one(
            {"_id": "global_background_task_config"}, {"$set": update_dict}
        )

    def _update_in_memory_history(self, entry: Dict[str, Any]):
        self.task_history.insert(0, entry)
        self.task_history = self.task_history[:50]

    async def start(self) -> None:
        try:
            if not self.scheduler.running:
                self.scheduler.start()
            await self.reinitialize_tasks()
            logger.info("Task manager started successfully")
        except Exception as e:
            logger.error("Error starting task manager: %s", e, exc_info=True)
            raise

    async def stop(self) -> None:
        try:
            if self.scheduler.running:
                self.scheduler.remove_all_jobs()
                self.scheduler.shutdown()
            logger.info("Task manager stopped successfully")
        except Exception as e:
            logger.error("Error stopping task manager: %s", e, exc_info=True)
            raise

    async def add_task(
        self,
        task_id: str,
        interval_minutes: int,
        enabled: bool = True,
        replace_existing: bool = True,
    ) -> None:
        try:
            if not enabled:
                logger.info("Task %s is disabled, skipping scheduling", task_id)
                return
            task_def = self.tasks.get(task_id)
            if not task_def:
                raise ValueError(f"Unknown task ID: {task_id}")
            try:
                self.scheduler.remove_job(task_id)
            except JobLookupError:
                pass

            self.scheduler.add_job(
                self.get_task_function(task_id),
                "interval",
                minutes=interval_minutes,
                id=task_id,
                replace_existing=replace_existing,
                next_run_time=datetime.now(timezone.utc),
                max_instances=1,
                coalesce=True,
                misfire_grace_time=interval_minutes * 60,
            )

            await self._update_task_config(
                task_id,
                {
                    "status": TaskStatus.IDLE.value,
                    "interval_minutes": interval_minutes,
                    "enabled": enabled,
                },
            )
            logger.info(
                "Added task %s with %d minute interval",
                task_id,
                interval_minutes,
            )

        except Exception as e:
            logger.error("Error adding task %s: %s", task_id, e, exc_info=True)
            raise

    async def reinitialize_tasks(self) -> None:
        try:
            config = await self.get_config()
            if config.get("disabled"):
                logger.info("Background tasks are globally disabled.")
                return
            self.scheduler.remove_all_jobs()
            for task_id, task_def in self.tasks.items():
                task_cfg = config["tasks"].get(task_id, {})
                if task_cfg.get("enabled", True):
                    await self.add_task(
                        task_id,
                        task_cfg.get(
                            "interval_minutes",
                            task_def.default_interval_minutes,
                        ),
                        enabled=True,
                        replace_existing=True,
                    )
            logger.info("Tasks reinitialized successfully")
        except Exception as e:
            logger.error("Error reinitializing tasks: %s", e, exc_info=True)
            raise

    def get_task_function(self, task_id: str) -> Callable:
        task_function_map = {
            "periodic_fetch_trips": self._periodic_fetch_trips,
            "preprocess_streets": self._preprocess_streets,
            "update_coverage_for_all_locations": self._update_coverage,
            "cleanup_stale_trips": self._cleanup_stale_trips,
            "cleanup_invalid_trips": self._cleanup_invalid_trips,
            "update_geocoding": self._update_geocoding,
            "optimize_database": self._optimize_database,
            "remap_unmatched_trips": self._remap_unmatched_trips,
            "validate_trip_data": self._validate_trip_data,
        }
        task_func = task_function_map.get(task_id)
        if not task_func:
            raise ValueError(f"No function found for task ID: {task_id}")
        return task_func

    async def get_config(self) -> Dict[str, Any]:
        cfg = await self.db["task_config"].find_one(
            {"_id": "global_background_task_config"}
        )
        if not cfg:
            cfg = {
                "_id": "global_background_task_config",
                "disabled": False,
                "tasks": {
                    t_id: {
                        "enabled": True,
                        "interval_minutes": t_def.default_interval_minutes,
                        "status": TaskStatus.IDLE.value,
                    }
                    for t_id, t_def in self.tasks.items()
                },
            }
            await self.db["task_config"].insert_one(cfg)
        return cfg

    # -------------------------------------------------------------------------
    # Actual Task Implementations
    # -------------------------------------------------------------------------
    async def _periodic_fetch_trips(self):
        task_id = "periodic_fetch_trips"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            last_trip = await self.db["trips"].find_one(sort=[("endTime", -1)])
            start_date = (
                last_trip["endTime"]
                if last_trip and last_trip.get("endTime")
                else datetime.now(timezone.utc) - timedelta(days=7)
            )
            end_date = datetime.now(timezone.utc)
            logger.info("Periodic fetch: from %s to %s", start_date, end_date)
            await fetch_bouncie_trips_in_range(start_date, end_date, do_map_match=False)
            await self._update_task_status(task_id, TaskStatus.COMPLETED)
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error("Error in periodic_fetch_trips: %s", e, exc_info=True)
            raise

    async def _update_coverage(self):
        task_id = "update_coverage_for_all_locations"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            logger.info("Starting coverage update for all locations")
            await update_coverage_for_all_locations()
            await self._update_task_status(task_id, TaskStatus.COMPLETED)
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error("Error in _update_coverage: %s", e, exc_info=True)
            raise

    async def _preprocess_streets(self):
        task_id = "preprocess_streets"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            processing_areas = (
                await self.db["coverage_metadata"]
                .find({"status": "processing"})
                .to_list(length=None)
            )
            for area in processing_areas:
                try:
                    await async_preprocess_streets(area["location"])
                except Exception as e:
                    logger.error(
                        "Error preprocessing streets for %s: %s",
                        area["location"].get("display_name"),
                        e,
                        exc_info=True,
                    )
                    await self.db["coverage_metadata"].update_one(
                        {"_id": area["_id"]},
                        {
                            "$set": {
                                "status": "error",
                                "last_error": str(e),
                                "last_updated": datetime.now(timezone.utc),
                            }
                        },
                    )
            await self._update_task_status(task_id, TaskStatus.COMPLETED)
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error("Error in preprocess_streets: %s", e, exc_info=True)
            raise

    async def _cleanup_stale_trips(self):
        task_id = "cleanup_stale_trips"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            now = datetime.now(timezone.utc)
            stale_threshold = now - timedelta(minutes=5)
            cleanup_count = 0
            cursor = self.db["live_trips"].find(
                {"lastUpdate": {"$lt": stale_threshold}, "status": "active"}
            )
            async for trip in cursor:
                trip["status"] = "stale"
                trip["endTime"] = now
                await self.db["archived_live_trips"].insert_one(trip)
                await self.db["live_trips"].delete_one({"_id": trip["_id"]})
                cleanup_count += 1
            logger.info("Cleaned up %d stale trips", cleanup_count)
            await self._update_task_status(task_id, TaskStatus.COMPLETED)
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error("Error in cleanup_stale_trips: %s", e, exc_info=True)
            raise

    async def _cleanup_invalid_trips(self):
        task_id = "cleanup_invalid_trips"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            invalid_count = 0
            async for trip in self.db["trips"].find({}):
                valid, message = validate_trip_data(trip)
                if not valid:
                    await self.db["trips"].update_one(
                        {"_id": trip["_id"]},
                        {
                            "$set": {
                                "invalid": True,
                                "validation_message": message,
                                "validated_at": datetime.now(timezone.utc),
                            }
                        },
                    )
                    invalid_count += 1
            logger.info("Marked %d invalid trips", invalid_count)
            await self._update_task_status(task_id, TaskStatus.COMPLETED)
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error("Error in cleanup_invalid_trips: %s", e, exc_info=True)
            raise

    async def _update_geocoding(self):
        task_id = "update_geocoding"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            update_count = 0
            query = {
                "$or": [
                    {"startLocation": {"$exists": False}},
                    {"destination": {"$exists": False}},
                    {"startLocation": ""},
                    {"destination": ""},
                ]
            }
            async for trip in self.db["trips"].find(query):
                gps = trip.get("gps")
                if not gps:
                    continue

                if isinstance(gps, str):
                    try:
                        gps = json.loads(gps)
                    except json.JSONDecodeError:
                        continue
                coords = gps.get("coordinates", [])
                if not coords:
                    continue

                updates = {}
                start_coords = coords[0]
                end_coords = coords[-1]
                if not trip.get("startLocation"):
                    loc_start = await reverse_geocode_nominatim(
                        start_coords[1], start_coords[0]
                    )
                    if loc_start:
                        updates["startLocation"] = loc_start.get("display_name")
                if not trip.get("destination"):
                    loc_end = await reverse_geocode_nominatim(
                        end_coords[1], end_coords[0]
                    )
                    if loc_end:
                        updates["destination"] = loc_end.get("display_name")

                if updates:
                    updates["geocoded_at"] = datetime.now(timezone.utc)
                    await self.db["trips"].update_one(
                        {"_id": trip["_id"]}, {"$set": updates}
                    )
                    update_count += 1
            logger.info("Updated geocoding for %d trips", update_count)
            await self._update_task_status(task_id, TaskStatus.COMPLETED)
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error("Error in update_geocoding: %s", e, exc_info=True)
            raise

    async def _optimize_database(self):
        task_id = "optimize_database"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            collections = [
                self.db["trips"],
                self.db["live_trips"],
                self.db["archived_live_trips"],
                self.db["matched_trips"],
            ]
            for coll in collections:
                await coll.reindex()
            logger.info("Database optimization completed")
            await self._update_task_status(task_id, TaskStatus.COMPLETED)
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error("Error in optimize_database: %s", e, exc_info=True)
            raise

    async def _remap_unmatched_trips(self):
        task_id = "remap_unmatched_trips"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            remap_count = 0
            query = {
                "$or": [
                    {"matchedGps": {"$exists": False}},
                    {"matchedGps": None},
                ]
            }
            async for trip in self.db["trips"].find(query):
                try:
                    await process_and_map_match_trip(trip)
                    remap_count += 1
                except Exception as e:
                    logger.warning("Failed to remap trip %s: %s", trip.get("_id"), e)
            logger.info("Remapped %d trips", remap_count)
            await self._update_task_status(task_id, TaskStatus.COMPLETED)
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error("Error in remap_unmatched_trips: %s", e, exc_info=True)
            raise

    async def _validate_trip_data(self):
        task_id = "validate_trip_data"
        try:
            await self._update_task_status(task_id, TaskStatus.RUNNING)
            update_count = 0
            async for trip in self.db["trips"].find({}):
                updates = {}
                for field in ["startTime", "endTime"]:
                    val = trip.get(field)
                    if isinstance(val, str):
                        try:
                            dt_parsed = datetime.fromisoformat(val)
                            updates[field] = dt_parsed
                        except ValueError:
                            updates["invalid"] = True
                            updates["validation_message"] = f"Invalid {field} format"

                if isinstance(trip.get("gps"), str):
                    try:
                        json.loads(trip["gps"])
                    except json.JSONDecodeError:
                        updates["invalid"] = True
                        updates["validation_message"] = "Invalid GPS JSON"

                if updates:
                    updates["validated_at"] = datetime.now(timezone.utc)
                    await self.db["trips"].update_one(
                        {"_id": trip["_id"]}, {"$set": updates}
                    )
                    update_count += 1
            logger.info("Validated and updated %d trips", update_count)
            await self._update_task_status(task_id, TaskStatus.COMPLETED)
        except Exception as e:
            await self._update_task_status(task_id, TaskStatus.FAILED, error=str(e))
            logger.error("Error in validate_trip_data: %s", e, exc_info=True)
            raise

    async def _update_task_status(
        self, task_id: str, status: TaskStatus, error: Optional[str] = None
    ) -> None:
        self.task_status[task_id] = status
        update_data = {
            f"tasks.{task_id}.status": status.value,
            f"tasks.{task_id}.last_updated": datetime.now(timezone.utc),
        }
        if status == TaskStatus.RUNNING:
            update_data[f"tasks.{task_id}.start_time"] = datetime.now(timezone.utc)
        elif status in [TaskStatus.COMPLETED, TaskStatus.FAILED]:
            update_data[f"tasks.{task_id}.end_time"] = datetime.now(timezone.utc)
        if error:
            update_data[f"tasks.{task_id}.last_error"] = error

        await self._update_task_config(task_id, update_data)


task_manager = BackgroundTaskManager()
AVAILABLE_TASKS: List[TaskDefinition] = list(task_manager.tasks.values())


async def start_background_tasks() -> None:
    try:
        await task_manager.start()
        logger.info("Background tasks started successfully.")
    except Exception as e:
        logger.error("Error starting background tasks: %s", e, exc_info=True)
        raise
