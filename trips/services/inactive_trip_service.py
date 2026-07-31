"""Helpers for marking historical trips inactive and refreshing derived data."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from core.cache import invalidate_cache_prefixes
from core.spatial import bboxes_intersect, extract_line_sequences
from core.trip_map_cache import bump_trip_map_revision
from db.models import CoverageArea, CoverageState, Job, Trip
from geo_coverage.services.geo_coverage_service import (
    recalculate as recalculate_geo_coverage,
)
from recurring_routes.models import BuildRecurringRoutesRequest
from street_coverage.ingestion import backfill_area
from tasks.ops import enqueue_task
from trips.services.trip_map_geometry import bbox_for_coords

if TYPE_CHECKING:
    from beanie import PydanticObjectId

logger = logging.getLogger(__name__)

_ACTIVE_JOB_STATUSES = {"queued", "pending", "running"}
_COVERAGE_JOB_TYPES = {"area_backfill", "area_rebuild"}
_ANALYTICS_CACHE_PREFIXES = (
    "metrics",
    "driving_insights",
    "trip_analytics",
    "driver_behavior",
)


class InactiveTripService:
    """Persist inactive trip state and refresh downstream derived data."""

    @staticmethod
    async def set_inactive_state(
        trip: Trip,
        *,
        inactive: bool,
    ) -> dict[str, Any]:
        """Update inactive state on a persisted trip and clear dependent caches."""
        current_state = bool(getattr(trip, "inactive", False))
        target_state = bool(inactive)
        changed = current_state != target_state

        if changed:
            trip.inactive = target_state
            trip.inactive_at = datetime.now(UTC) if target_state else None
            trip.inactive_reason = None
            trip.mobility_synced_at = None
            if target_state:
                trip.recurringRouteId = None
            await trip.save()
            await bump_trip_map_revision()

        cache_entries_deleted = await invalidate_cache_prefixes(
            *_ANALYTICS_CACHE_PREFIXES,
        )

        return {
            "changed": changed,
            "trip": trip,
            "cache_entries_deleted": cache_entries_deleted,
        }

    @staticmethod
    async def sync_mobility_profile(
        trip: Trip,
        *,
        inactive: bool,
    ) -> None:
        """Remove or rebuild mobility profile to match current inactive state."""
        trip_id = getattr(trip, "id", None)
        if trip_id is None:
            return

        from analytics.services.mobility_insights_service import MobilityInsightsService

        if inactive:
            await MobilityInsightsService.remove_trip(
                trip_id,
                getattr(trip, "transactionId", None),
            )
            return

        try:
            await MobilityInsightsService.sync_trip(trip)
        except Exception:
            logger.exception(
                "Failed to resync mobility profile after reactivating trip %s",
                trip.transactionId,
            )

    @classmethod
    async def queue_recurring_routes_refresh(cls) -> dict[str, Any]:
        """Ensure recurring-route aggregates are rebuilt after trip activity changes."""
        active_job = await Job.find_one(
            {
                "job_type": "recurring_routes_build",
                "status": {"$in": list(_ACTIVE_JOB_STATUSES)},
            },
        )
        if active_job:
            return {
                "status": "already_running",
                "job_id": str(active_job.id),
            }

        enqueue_result = await enqueue_task(
            "build_recurring_routes",
            build_request=BuildRecurringRoutesRequest().model_dump(),
            manual_run=True,
        )
        return {
            "status": "queued",
            "job_id": enqueue_result.get("job_id"),
        }

    @classmethod
    async def queue_geo_coverage_refresh(cls, background_tasks) -> dict[str, Any]:
        """Queue a full Region Explorer cache rebuild after trip state changes."""
        response = await recalculate_geo_coverage(background_tasks)
        return {
            "status": (
                "already_running" if response.get("alreadyRunning") else "queued"
            ),
            "job_id": response.get("jobId"),
        }

    @classmethod
    async def queue_coverage_reprocessing_for_trip(
        cls,
        trip: Trip,
    ) -> dict[str, Any]:
        """
        Rebuild driven coverage state for any areas touched by this trip.

        We clear derived non-manual driven rows and re-run a full
        backfill so street coverage reflects the current inactive/active
        state of historical trips.
        """
        return await cls.queue_coverage_reprocessing_for_trips([trip])

    @classmethod
    async def queue_coverage_reprocessing_for_trips(
        cls,
        trips: list[Trip],
    ) -> dict[str, Any]:
        """Queue one full coverage refresh per area touched by any trip."""
        area_by_id: dict[str, CoverageArea] = {}
        for trip in trips:
            for area in await cls._find_affected_coverage_areas(trip):
                area_by_id[str(area.id)] = area
        areas = list(area_by_id.values())
        if not areas:
            return {
                "queued": 0,
                "skipped": 0,
                "job_ids": [],
            }

        queued = 0
        deferred = 0
        job_ids: list[str] = []

        for area in areas:
            # Publish the durable request *before* inspecting the active job.
            # If that job finishes concurrently, either its completion hook or
            # this caller atomically claims the marker; neither can miss it.
            await area.set({"coverage_refresh_pending": True})
            refresh = await cls.consume_pending_coverage_refresh(area.id)
            if refresh.get("queued"):
                if refresh.get("job_id") is not None:
                    job_ids.append(str(refresh["job_id"]))
                queued += 1
            else:
                deferred += 1

        return {
            "queued": queued,
            "deferred": deferred,
            # Retained for existing callers that read "skipped".
            "skipped": deferred,
            "job_ids": job_ids,
        }

    @classmethod
    async def _start_area_refresh(cls, area: CoverageArea) -> str | None:
        """Clear derived driven state for an area and queue a fresh backfill."""
        await CoverageState.find(
            {
                "area_id": area.id,
                "status": "driven",
                "manually_marked": {"$ne": True},
            },
        ).delete()
        await area.set(
            {
                "last_backfill_trip_endtime": None,
            },
        )

        job = await backfill_area(area.id)
        return str(job.id) if getattr(job, "id", None) is not None else None

    @classmethod
    async def consume_pending_coverage_refresh(
        cls,
        area_id: PydanticObjectId,
    ) -> dict[str, Any]:
        """
        Run a refresh that was coalesced while a coverage job was active.

        Called when a coverage job finishes. Does nothing unless a request
        arrived while that job was running.
        """
        area = await CoverageArea.get(area_id)
        if area is None or not getattr(area, "coverage_refresh_pending", False):
            return {"queued": False, "deferred": False, "job_id": None}

        active_job = await Job.find_one(
            {
                "area_id": area.id,
                "job_type": {"$in": list(_COVERAGE_JOB_TYPES)},
                "status": {"$in": list(_ACTIVE_JOB_STATUSES)},
            },
        )
        if active_job:
            return {
                "queued": False,
                "deferred": True,
                "job_id": str(active_job.id),
            }

        claim = await CoverageArea.get_pymongo_collection().update_one(
            {
                "_id": area.id,
                "coverage_refresh_pending": True,
            },
            {"$set": {"coverage_refresh_pending": False}},
        )
        if int(getattr(claim, "modified_count", 0) or 0) != 1:
            return {"queued": False, "deferred": False, "job_id": None}

        try:
            job_id = await cls._start_area_refresh(area)
        except Exception:
            # Retain the request so a later completion hook or user action can
            # retry it rather than silently losing a failed enqueue.
            await area.set({"coverage_refresh_pending": True})
            raise
        logger.info(
            "Ran deferred coverage refresh for area %s (job %s)",
            area_id,
            job_id,
        )
        return {"queued": True, "deferred": False, "job_id": job_id}

    @classmethod
    async def _find_affected_coverage_areas(cls, trip: Trip) -> list[CoverageArea]:
        areas = await CoverageArea.find_all().to_list()
        if not areas:
            return []

        trip_bbox = cls._trip_bbox(trip)
        if trip_bbox is None:
            return areas

        matched: list[CoverageArea] = []
        fallback: list[CoverageArea] = []
        for area in areas:
            area_bbox = cls._area_bbox(area)
            if area_bbox is None:
                fallback.append(area)
                continue
            if bboxes_intersect(trip_bbox, area_bbox):
                matched.append(area)

        return matched or fallback or areas

    @staticmethod
    def _trip_bbox(trip: Trip) -> tuple[float, float, float, float] | None:
        coords: list[list[float]] = []
        for geometry in (
            getattr(trip, "matchedGps", None),
            getattr(trip, "gps", None),
            getattr(trip, "startGeoPoint", None),
            getattr(trip, "destinationGeoPoint", None),
        ):
            for sequence in extract_line_sequences(geometry, include_point=True):
                coords.extend(sequence)

        if not coords:
            return None

        bbox = bbox_for_coords(coords)
        return (bbox[0], bbox[1], bbox[2], bbox[3])

    @staticmethod
    def _area_bbox(area: CoverageArea) -> tuple[float, float, float, float] | None:
        raw_bbox = getattr(area, "bounding_box", None)
        if (
            not isinstance(raw_bbox, list)
            or len(raw_bbox) != 4
            or not all(isinstance(value, int | float) for value in raw_bbox)
        ):
            return None
        min_lon, min_lat, max_lon, max_lat = map(float, raw_bbox)
        return (min_lon, min_lat, max_lon, max_lat)
