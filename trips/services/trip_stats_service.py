"""Business logic for trip statistics and geocoding operations."""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from core.date_utils import normalize_calendar_date
from core.jobs import create_job, find_job
from db import build_calendar_date_expr
from db.models import Trip
from trips.services.trip_batch_service import TripService

logger = logging.getLogger(__name__)


class TripStatsService:
    """Service class for trip statistics and geocoding operations."""

    def __init__(self, trip_service: TripService) -> None:
        """
        Initialize the stats service with a TripService instance.

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
        """
        Re-geocode trips within a date range with progress tracking.

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
                msg = "Invalid date range"
                raise ValueError(msg)
            query = {"$expr": range_expr}
        else:
            start_iso = normalize_calendar_date(start_date)
            end_iso = normalize_calendar_date(end_date)

            if not start_iso or not end_iso:
                msg = "Invalid date range"
                raise ValueError(msg)

            range_expr = build_calendar_date_expr(start_iso, end_iso)
            if not range_expr:
                msg = "Invalid date range"
                raise ValueError(msg)
            query = {"$expr": range_expr}

        metrics = {
            "total": 0,
            "processed": 0,
            "updated": 0,
            "skipped": 0,
            "failed": 0,
        }
        job_handle = await create_job(
            "geocoding",
            operation_id=task_id,
            status="running",
            stage="initializing",
            progress=0.0,
            message="Finding trips to geocode...",
            started_at=datetime.now(UTC),
            metadata=metrics,
        )

        try:
            # Find trips matching query
            trips_list = await Trip.find(query).to_list()
            # Convert transactionId to string to handle ObjectId values from older data
            trip_ids = [
                str(trip.transactionId) for trip in trips_list if trip.transactionId
            ]

            total_trips = len(trip_ids)

            # Update progress with total count
            metrics["total"] = total_trips
            await job_handle.update(
                stage="processing",
                message=f"Found {total_trips} trips to process",
                metadata_patch={"total": total_trips},
            )

            if total_trips == 0:
                await job_handle.update(
                    stage="completed",
                    status="completed",
                    progress=100,
                    message="No trips found matching criteria",
                    completed_at=datetime.now(UTC),
                )
                return {
                    "task_id": task_id,
                    "message": "No trips found matching criteria",
                    "total": 0,
                }

            # Define progress callback
            async def progress_callback(current: int, total: int, trip_id: str) -> None:
                progress_pct = int((current / total) * 100) if total > 0 else 0
                metrics["processed"] = metrics.get("processed", 0) + 1
                metrics["current_trip_id"] = trip_id
                await job_handle.update(
                    progress=progress_pct,
                    message=f"Geocoding trip {current} of {total}",
                    metadata_patch={
                        "processed": metrics["processed"],
                        "current_trip_id": trip_id,
                    },
                )

            # Process geocoding
            result = await self.trip_service.refresh_geocoding(
                trip_ids,
                skip_if_exists=True,
                progress_callback=progress_callback,
            )

            # Update final progress
            message = (
                f"Completed: {result['updated']} updated, "
                f"{result['skipped']} skipped, "
                f"{result['failed']} failed"
            )
            metrics = {
                "total": result["total"],
                "processed": result["total"],
                "updated": result["updated"],
                "skipped": result["skipped"],
                "failed": result["failed"],
            }
            await job_handle.update(
                stage="completed",
                status="completed",
                progress=100,
                message=message,
                metadata_patch=metrics,
                completed_at=datetime.now(UTC),
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
            logger.exception("Error in geocode_trips")
            # Update progress with error
            await job_handle.update(
                stage="error",
                status="failed",
                progress=0,
                message=f"Error: {e!s}",
                error=str(e),
                completed_at=datetime.now(UTC),
            )
            raise

    @staticmethod
    async def get_geocode_progress(task_id: str):
        """
        Get progress for a geocoding task.

        Args:
            task_id: UUID of the geocoding task

        Returns:
            Progress information dict

        Raises:
            ValueError: If task not found
        """
        progress = await find_job("geocoding", operation_id=task_id)

        if not progress:
            msg = "Task not found"
            raise ValueError(msg)

        return {
            "task_id": task_id,
            "stage": progress.stage or "unknown",
            "progress": progress.progress or 0,
            "message": progress.message or "",
            "metrics": progress.metadata or {},
            "current_trip_id": (
                progress.metadata.get("current_trip_id") if progress.metadata else None
            ),
            "error": progress.error,
            "updated_at": (
                progress.updated_at.isoformat() if progress.updated_at else None
            ),
        }

    async def regeocode_single_trip(self, trip_id: str):
        """
        Re-run geocoding for a single trip.

        Args:
            trip_id: Transaction ID of the trip

        Returns:
            Success result

        Raises:
            ValueError: If trip not found or geocoding failed
        """
        trip = await self.trip_service.get_trip_by_id(trip_id)
        if not trip:
            msg = "Trip not found"
            raise ValueError(msg)

        result = await self.trip_service.refresh_geocoding(
            [trip_id],
            skip_if_exists=False,
        )

        if result["updated"] > 0:
            return {
                "status": "success",
                "message": f"Trip {trip_id} re-geocoded successfully.",
            }
        msg = f"Failed to re-geocode trip {trip_id}. Check logs for details."
        raise ValueError(
            msg,
        )
