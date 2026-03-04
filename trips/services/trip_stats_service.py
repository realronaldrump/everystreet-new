"""Business logic for trip statistics and geocoding operations."""

import logging
import uuid
from datetime import UTC, datetime

from core.job_serialization import serialize_job_progress
from core.jobs import create_job, find_job
from core.trip_query_spec import TripQuerySpec
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

        if interval_days < 0:
            msg = "Invalid date range"
            raise ValueError(msg)

        has_window = bool(start_date or end_date or interval_days > 0)
        if has_window and interval_days <= 0 and (not start_date or not end_date):
            msg = "Invalid date range"
            raise ValueError(msg)

        spec = TripQuerySpec(
            start_date=start_date,
            end_date=end_date,
            interval_days=interval_days,
            include_invalid=True,
        )
        try:
            query = spec.to_mongo_query(
                require_complete_bounds=has_window,
                require_valid_range_if_provided=has_window,
                enforce_source=True,
            )
        except ValueError as exc:
            msg = "Invalid date range"
            raise ValueError(msg) from exc

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
            # Normalize transaction IDs to strings for downstream task payloads.
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

        payload = serialize_job_progress(
            progress,
            job_id=task_id,
            metadata_field="metrics",
            include_status=False,
        )
        return {
            "task_id": task_id,
            "stage": payload.get("stage"),
            "progress": payload.get("progress"),
            "message": payload.get("message"),
            "metrics": payload.get("metrics"),
            "current_trip_id": (
                progress.metadata.get("current_trip_id") if progress.metadata else None
            ),
            "error": payload.get("error"),
            "updated_at": payload.get("updated_at"),
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
