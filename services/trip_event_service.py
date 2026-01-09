"""TripEventService for handling TripCompleted events.

This service:
1. Receives TripCompleted events from various sources
2. Finds areas that intersect the trip
3. Queues incremental coverage updates for intersecting areas
"""

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any

from coverage_models.job_status import JobType
from events.trip_completed import TripCompleted, compute_trip_bbox
from services.area_manager import area_manager
from services.job_manager import job_manager

logger = logging.getLogger(__name__)


class TripEventService:
    """Handles TripCompleted events and triggers coverage updates."""

    async def emit_trip_completed(
        self,
        trip_id: str,
        gps_geometry: dict[str, Any] | None = None,
        source: str = "unknown",
        timestamp: datetime | None = None,
    ) -> TripCompleted:
        """Emit a TripCompleted event and trigger coverage updates.

        This is the single entry point for triggering coverage updates
        whenever a trip is completed.

        Args:
            trip_id: Transaction ID of the completed trip
            gps_geometry: GeoJSON geometry (Point or LineString)
            source: Source of the trip ("webhook", "upload", "fetch", "live_tracking")
            timestamp: Trip completion timestamp (defaults to now)

        Returns:
            The TripCompleted event that was emitted
        """
        if timestamp is None:
            timestamp = datetime.now(UTC)

        # Compute bounding box from geometry
        bbox = compute_trip_bbox(gps_geometry)

        event = TripCompleted(
            trip_id=trip_id,
            bbox=bbox,
            timestamp=timestamp,
            source=source,
            gps_geometry=gps_geometry,
        )

        logger.info(
            "TripCompleted event: trip=%s, source=%s, bbox=%s",
            trip_id,
            source,
            bbox,
        )

        # Handle the event (find intersecting areas and queue updates)
        await self.handle_trip_completed(event)

        return event

    async def handle_trip_completed(self, event: TripCompleted) -> int:
        """Handle a TripCompleted event.

        1. Find areas that intersect the trip bbox
        2. For each area, refine with geometry intersection
        3. Queue incremental coverage update jobs

        Args:
            event: TripCompleted event

        Returns:
            Number of areas that will be updated
        """
        try:
            # Find areas with bbox overlap
            areas = await area_manager.get_areas_intersecting_bbox(event.bbox)

            if not areas:
                logger.debug(
                    "No areas intersect trip %s bbox %s",
                    event.trip_id,
                    event.bbox,
                )
                return 0

            # If we have geometry, refine with actual intersection
            if event.gps_geometry:
                from shapely.geometry import shape

                try:
                    trip_geom = shape(event.gps_geometry)
                    refined_areas = []
                    for area in areas:
                        try:
                            area_geom = shape(area.boundary)
                            if area_geom.intersects(trip_geom):
                                refined_areas.append(area)
                        except Exception:
                            # Include area if geometry check fails
                            refined_areas.append(area)
                    areas = refined_areas
                except Exception as e:
                    logger.warning(
                        "Failed to refine areas with geometry for trip %s: %s",
                        event.trip_id,
                        e,
                    )

            if not areas:
                logger.debug(
                    "No areas intersect trip %s after geometry refinement",
                    event.trip_id,
                )
                return 0

            logger.info(
                "Trip %s intersects %d areas: %s",
                event.trip_id,
                len(areas),
                [a.display_name for a in areas],
            )

            # Queue coverage update jobs for each area
            for area in areas:
                await self._queue_coverage_update(area, event)

            return len(areas)

        except Exception as e:
            logger.exception(
                "Error handling TripCompleted for trip %s: %s",
                event.trip_id,
                e,
            )
            return 0

    async def _queue_coverage_update(self, area, event: TripCompleted) -> None:
        """Queue a coverage update job for an area.

        Args:
            area: Area to update
            event: TripCompleted event
        """
        try:
            # Check if there's already a running coverage job for this area
            active_job = await job_manager.get_active_job_for_area(
                str(area.id),
                job_type=JobType.TRIP_COVERAGE,
            )

            if active_job:
                logger.debug(
                    "Coverage job already running for area %s, skipping trip %s",
                    area.display_name,
                    event.trip_id,
                )
                return

            # Create coverage update job
            job = await job_manager.create_job(
                job_type=JobType.TRIP_COVERAGE,
                area_id=str(area.id),
                trip_id=event.trip_id,
            )

            # Start coverage update in background
            asyncio.create_task(
                self._run_coverage_update(
                    area_id=str(area.id),
                    trip_id=event.trip_id,
                    job_id=str(job.id),
                    gps_geometry=event.gps_geometry,
                )
            )

            logger.debug(
                "Queued coverage update for area %s, trip %s, job %s",
                area.display_name,
                event.trip_id,
                job.id,
            )

        except Exception as e:
            logger.exception(
                "Error queuing coverage update for area %s, trip %s: %s",
                area.display_name,
                event.trip_id,
                e,
            )

    async def _run_coverage_update(
        self,
        area_id: str,
        trip_id: str,
        job_id: str,
        gps_geometry: dict[str, Any] | None,
    ) -> None:
        """Run coverage update in background.

        Args:
            area_id: Area ID to update
            trip_id: Trip ID that triggered the update
            job_id: Job ID for tracking
            gps_geometry: Trip geometry for matching
        """
        try:
            from services.coverage_service import coverage_service

            await coverage_service.process_trip_for_area(
                area_id=area_id,
                trip_id=trip_id,
                job_id=job_id,
                gps_geometry=gps_geometry,
            )
        except Exception as e:
            logger.exception(
                "Coverage update failed for area %s, trip %s: %s",
                area_id,
                trip_id,
                e,
            )


# Singleton instance
trip_event_service = TripEventService()


async def emit_trip_completed(
    trip_id: str,
    gps_geometry: dict[str, Any] | None = None,
    source: str = "unknown",
    timestamp: datetime | None = None,
) -> TripCompleted:
    """Convenience function to emit a TripCompleted event.

    This is the main entry point for triggering coverage updates.
    Call this whenever a trip is completed.
    """
    return await trip_event_service.emit_trip_completed(
        trip_id=trip_id,
        gps_geometry=gps_geometry,
        source=source,
        timestamp=timestamp,
    )
