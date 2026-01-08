"""Business logic for trip statistics and geocoding operations."""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from date_utils import normalize_calendar_date
from db import (
    build_calendar_date_expr,
    find_with_retry,
    progress_collection,
    trips_collection,
    update_one_with_retry,
)
from trip_service import TripService

logger = logging.getLogger(__name__)


class TripStatsService:
    """Service class for trip statistics and geocoding operations."""

    def __init__(self, trip_service: TripService):
        """Initialize the stats service with a TripService instance.

        Args:
            trip_service: TripService instance for geocoding operations
        """
        self.trip_service = trip_service

    async def geocode_trips(
        self,
        start_date: str | None = None,
        end_date: str | None = None,
        interval_days: int = 0,
    ):
        """Re-geocode trips within a date range with progress tracking.

        Args:
            start_date: Optional start date (ISO format)
            end_date: Optional end date (ISO format)
            interval_days: Optional interval in days from now

        Returns:
            dict with task_id and geocoding results

        Raises:
            ValueError: If invalid date range
        """
        task_id = str(uuid.uuid4())

        try:
            # Determine date range
            if not start_date and not end_date and interval_days == 0:
                # Default to all trips
                query = {}
                start_iso = None
                end_iso = None
            elif interval_days > 0:
                end_dt = datetime.now(UTC)
                start_dt = end_dt - timedelta(days=interval_days)
                start_iso = start_dt.date().isoformat()
                end_iso = end_dt.date().isoformat()
                range_expr = build_calendar_date_expr(start_iso, end_iso)
                if not range_expr:
                    raise ValueError("Invalid date range")
                query = {"$expr": range_expr}
            else:
                start_iso = normalize_calendar_date(start_date)
                end_iso = normalize_calendar_date(end_date)

                if not start_iso or not end_iso:
                    raise ValueError("Invalid date range")

                range_expr = build_calendar_date_expr(start_iso, end_iso)
                if not range_expr:
                    raise ValueError("Invalid date range")
                query = {"$expr": range_expr}

            # Initialize progress tracking
            await update_one_with_retry(
                progress_collection,
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "initializing",
                        "progress": 0,
                        "message": "Finding trips to geocode...",
                        "updated_at": datetime.now(UTC),
                        "task_type": "geocoding",
                        "metrics": {
                            "total": 0,
                            "processed": 0,
                            "updated": 0,
                            "skipped": 0,
                            "failed": 0,
                        },
                    }
                },
                upsert=True,
            )

            # Find trips matching query
            trips_list = await find_with_retry(trips_collection, query)
            trip_ids = [
                trip.get("transactionId")
                for trip in trips_list
                if trip.get("transactionId")
            ]

            total_trips = len(trip_ids)

            # Update progress with total count
            await update_one_with_retry(
                progress_collection,
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "processing",
                        "progress": 0,
                        "message": f"Found {total_trips} trips to process",
                        "metrics.total": total_trips,
                    }
                },
            )

            if total_trips == 0:
                await update_one_with_retry(
                    progress_collection,
                    {"_id": task_id},
                    {
                        "$set": {
                            "stage": "completed",
                            "progress": 100,
                            "message": "No trips found matching criteria",
                        }
                    },
                )
                return {
                    "task_id": task_id,
                    "message": "No trips found matching criteria",
                    "total": 0,
                }

            # Define progress callback
            async def progress_callback(current: int, total: int, trip_id: str):
                progress_pct = int((current / total) * 100) if total > 0 else 0
                await update_one_with_retry(
                    progress_collection,
                    {"_id": task_id},
                    {
                        "$set": {
                            "progress": progress_pct,
                            "message": f"Geocoding trip {current} of {total}",
                            "current_trip_id": trip_id,
                            "updated_at": datetime.now(UTC),
                        },
                        "$inc": {
                            "metrics.processed": 1,
                        },
                    },
                )

            # Process geocoding
            result = await self.trip_service.refresh_geocoding(
                trip_ids,
                skip_if_exists=True,
                progress_callback=progress_callback,
            )

            # Update final progress
            await update_one_with_retry(
                progress_collection,
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "completed",
                        "progress": 100,
                        "message": (
                            f"Completed: {result['updated']} updated, "
                            f"{result['skipped']} skipped, "
                            f"{result['failed']} failed"
                        ),
                        "metrics": {
                            "total": result["total"],
                            "processed": result["total"],
                            "updated": result["updated"],
                            "skipped": result["skipped"],
                            "failed": result["failed"],
                        },
                        "updated_at": datetime.now(UTC),
                    }
                },
            )

            return {
                "task_id": task_id,
                "message": (
                    f"Geocoding completed: {result['updated']} updated, "
                    f"{result['skipped']} skipped, {result['failed']} failed"
                ),
                "total": result["total"],
                "updated": result["updated"],
                "skipped": result["skipped"],
                "failed": result["failed"],
            }

        except Exception as e:
            logger.exception("Error in geocode_trips: %s", e)
            # Update progress with error
            await update_one_with_retry(
                progress_collection,
                {"_id": task_id},
                {
                    "$set": {
                        "stage": "error",
                        "progress": 0,
                        "message": f"Error: {str(e)}",
                        "error": str(e),
                        "updated_at": datetime.now(UTC),
                    }
                },
            )
            raise

    async def get_geocode_progress(self, task_id: str):
        """Get progress for a geocoding task.

        Args:
            task_id: UUID of the geocoding task

        Returns:
            Progress information dict

        Raises:
            ValueError: If task not found
        """
        from db import find_one_with_retry, serialize_datetime

        progress = await find_one_with_retry(
            progress_collection,
            {"_id": task_id, "task_type": "geocoding"},
        )

        if not progress:
            raise ValueError("Task not found")

        return {
            "task_id": task_id,
            "stage": progress.get("stage", "unknown"),
            "progress": progress.get("progress", 0),
            "message": progress.get("message", ""),
            "metrics": progress.get("metrics", {}),
            "current_trip_id": progress.get("current_trip_id"),
            "error": progress.get("error"),
            "updated_at": serialize_datetime(progress.get("updated_at")),
        }

    async def regeocode_single_trip(self, trip_id: str):
        """Re-run geocoding for a single trip.

        Args:
            trip_id: Transaction ID of the trip

        Returns:
            Success result

        Raises:
            ValueError: If trip not found or geocoding failed
        """
        trip = await self.trip_service.get_trip_by_id(trip_id)
        if not trip:
            raise ValueError("Trip not found")

        result = await self.trip_service.refresh_geocoding(
            [trip_id], skip_if_exists=False
        )

        if result["updated"] > 0:
            return {
                "status": "success",
                "message": f"Trip {trip_id} re-geocoded successfully.",
            }
        raise ValueError(
            f"Failed to re-geocode trip {trip_id}. Check logs for details."
        )
