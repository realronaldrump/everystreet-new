"""Map matching job service and runner."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException, status

from core.date_utils import get_current_utc_time, normalize_calendar_date
from db import build_calendar_date_expr
from db.models import ProgressStatus, Trip
from geo_service import MapMatchingService, extract_timestamps_for_coordinates
from geo_service.geometry import GeometryService
from map_data.services import check_service_health
from map_matching.schemas import MapMatchJobRequest
from tasks.config import update_task_history_entry
from tasks.ops import abort_job, enqueue_task
from trips.models import TripMapMatchProjection, TripPreviewProjection, TripStatusProjection

logger = logging.getLogger(__name__)

DEFAULT_BATCH_SIZE = 50  # Smaller batches for better progress feedback
TERMINAL_STAGES = {"completed", "failed", "error", "cancelled"}


def _is_terminal_stage(stage: str | None) -> bool:
    return stage in TERMINAL_STAGES


def _is_terminal_progress(progress: ProgressStatus) -> bool:
    return _is_terminal_stage(progress.stage) or _is_terminal_stage(progress.status)


class MapMatchingJobService:
    """Create and inspect map matching jobs."""

    async def enqueue_job(
        self,
        request: MapMatchJobRequest,
        *,
        source: str = "manual",
    ) -> dict[str, Any]:
        normalized = self._normalize_request(request)

        result = await enqueue_task(
            "map_match_trips",
            job_request=normalized.model_dump(),
            manual_run=source == "manual",
        )
        job_id = result.get("job_id")
        await self._create_progress(job_id, normalized, source)

        return {
            "status": "queued",
            "job_id": job_id,
        }

    async def get_job(self, job_id: str) -> dict[str, Any]:
        progress = await ProgressStatus.find_one(
            ProgressStatus.operation_id == job_id,
            ProgressStatus.operation_type == "map_matching",
        )
        if not progress:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Job not found",
            )

        return {
            "job_id": job_id,
            "stage": progress.stage or "unknown",
            "progress": progress.progress or 0,
            "message": progress.message or "",
            "metrics": progress.metadata or {},
            "error": progress.error,
            "updated_at": (
                progress.updated_at.isoformat() if progress.updated_at else None
            ),
        }

    async def list_jobs(self, limit: int = 20, offset: int = 0) -> dict[str, Any]:
        cursor = (
            ProgressStatus.find(ProgressStatus.operation_type == "map_matching")
            .sort(-ProgressStatus.updated_at)
            .skip(offset)
            .limit(limit)
        )
        jobs = []
        async for entry in cursor:
            jobs.append(
                {
                    "job_id": entry.operation_id,
                    "stage": entry.stage or "unknown",
                    "progress": entry.progress or 0,
                    "message": entry.message or "",
                    "metrics": entry.metadata or {},
                    "error": entry.error,
                    "updated_at": (
                        entry.updated_at.isoformat() if entry.updated_at else None
                    ),
                },
            )

        total = await ProgressStatus.find(
            ProgressStatus.operation_type == "map_matching",
        ).count()
        return {"total": total, "jobs": jobs}

    async def delete_job(
        self,
        job_id: str,
        *,
        allow_active: bool = False,
    ) -> dict[str, Any]:
        progress = await ProgressStatus.find_one(
            ProgressStatus.operation_id == job_id,
            ProgressStatus.operation_type == "map_matching",
        )
        if not progress:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Job not found",
            )

        if not allow_active and not _is_terminal_progress(progress):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Job is still running",
            )

        await progress.delete()
        return {"status": "success", "deleted": 1}

    async def cancel_job(
        self,
        job_id: str,
        *,
        reason: str = "Cancelled by user",
    ) -> dict[str, Any]:
        progress = await ProgressStatus.find_one(
            ProgressStatus.operation_id == job_id,
            ProgressStatus.operation_type == "map_matching",
        )
        if not progress:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Job not found",
            )

        if _is_terminal_progress(progress):
            return {
                "status": (
                    "cancelled"
                    if progress.stage == "cancelled" or progress.status == "cancelled"
                    else "already_finished"
                ),
                "job": await self.get_job(job_id),
            }

        aborted = False
        try:
            aborted = await abort_job(job_id)
        except Exception as exc:
            logger.warning("Failed to abort map matching job %s: %s", job_id, exc)

        now = datetime.now(UTC)
        progress.status = "cancelled"
        progress.stage = "cancelled"
        progress.message = reason
        progress.updated_at = now
        progress.completed_at = now
        metadata = progress.metadata or {}
        metadata["cancelled"] = True
        progress.metadata = metadata
        await progress.save()

        try:
            await update_task_history_entry(
                job_id=job_id,
                task_name="map_match_trips",
                status="CANCELLED",
                manual_run=bool(metadata.get("source") == "manual"),
                error=reason,
                end_time=now,
            )
        except Exception as exc:
            logger.warning(
                "Failed to update task history for cancelled map matching job %s: %s",
                job_id,
                exc,
            )

        return {
            "status": "cancelled",
            "aborted": aborted,
            "job": await self.get_job(job_id),
        }

    async def clear_history(self, *, include_active: bool = False) -> dict[str, Any]:
        entries = await ProgressStatus.find(
            ProgressStatus.operation_type == "map_matching",
        ).to_list()

        deletable = [
            entry
            for entry in entries
            if include_active or _is_terminal_progress(entry)
        ]

        for entry in deletable:
            await entry.delete()

        skipped = len(entries) - len(deletable)
        return {
            "status": "success",
            "deleted": len(deletable),
            "skipped_active": skipped,
        }

    async def preview(
        self,
        request: MapMatchJobRequest,
        limit: int = 25,
    ) -> dict[str, Any]:
        normalized = self._normalize_request(request)
        query = MapMatchingJobRunner._build_query(normalized)

        total = await Trip.find(query).count()
        trips = (
            await Trip.find(query)
            .sort(-Trip.endTime)
            .project(TripPreviewProjection)
            .limit(limit)
            .to_list()
        )

        sample = []
        for trip in trips:
            trip_dict = trip.model_dump() if hasattr(trip, "model_dump") else dict(trip)
            sample.append(
                {
                    "transactionId": trip_dict.get("transactionId"),
                    "startTime": trip_dict.get("startTime"),
                    "endTime": trip_dict.get("endTime"),
                    "distance": trip_dict.get("distance"),
                    "matchStatus": trip_dict.get("matchStatus"),
                    "matchedGps": trip_dict.get("matchedGps"),
                },
            )

        return {
            "total": total,
            "sample": sample,
        }

    async def preview_matches(
        self,
        job_id: str,
        limit: int = 120,
    ) -> dict[str, Any]:
        progress = await ProgressStatus.find_one(
            ProgressStatus.operation_id == job_id,
            ProgressStatus.operation_type == "map_matching",
        )
        if not progress:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Job not found",
            )

        metadata = progress.metadata or {}
        mode = metadata.get("mode") or "unmatched"

        query: dict[str, Any] = {"invalid": {"$ne": True}, "matchedGps": {"$ne": None}}
        window: dict[str, Any] | None = None

        if mode == "trip_id":
            trip_id = metadata.get("trip_id")
            if not trip_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Trip ID not available for this job",
                )
            query["transactionId"] = trip_id
        elif mode == "trip_ids":
            trip_ids = metadata.get("trip_ids")
            if not trip_ids:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Trip IDs not available for this job",
                )
            query["transactionId"] = {"$in": trip_ids}
        elif mode == "date_range":
            start_iso = normalize_calendar_date(metadata.get("start_date"))
            end_iso = normalize_calendar_date(metadata.get("end_date"))
            interval_days = int(metadata.get("interval_days") or 0)
            if interval_days > 0 and (not start_iso or not end_iso):
                anchor = progress.started_at or datetime.now(UTC)
                end_dt = anchor.date()
                start_dt = (anchor - timedelta(days=interval_days)).date()
                start_iso = start_dt.isoformat()
                end_iso = end_dt.isoformat()
            if not start_iso or not end_iso:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Date range not available for this job",
                )
            range_expr = build_calendar_date_expr(start_iso, end_iso)
            if not range_expr:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid date range for preview",
                )
            query["$expr"] = range_expr
            window = {"start": start_iso, "end": end_iso}
        elif mode == "unmatched":
            if not progress.started_at:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Job timing not available for preview",
                )
            start_dt = progress.started_at
            end_dt = progress.updated_at or datetime.now(UTC)
            query["matched_at"] = {"$gte": start_dt, "$lte": end_dt}
            window = {"start": start_dt.isoformat(), "end": end_dt.isoformat()}
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unsupported preview mode",
            )

        total = await Trip.find(query).count()
        trips = (
            await Trip.find(query)
            .sort(-Trip.matched_at)
            .project(TripPreviewProjection)
            .limit(limit)
            .to_list()
        )

        sample: list[dict[str, Any]] = []
        features: list[dict[str, Any]] = []
        skipped = 0

        for trip in trips:
            trip_dict = trip.model_dump() if hasattr(trip, "model_dump") else dict(trip)
            matched_geom = GeometryService.parse_geojson(trip_dict.get("matchedGps"))
            if not matched_geom or not matched_geom.get("coordinates"):
                skipped += 1
                continue

            sample.append(
                {
                    "transactionId": trip_dict.get("transactionId"),
                    "startTime": trip_dict.get("startTime"),
                    "endTime": trip_dict.get("endTime"),
                    "distance": trip_dict.get("distance"),
                    "matchStatus": trip_dict.get("matchStatus"),
                    "matched_at": trip_dict.get("matched_at"),
                },
            )
            features.append(
                GeometryService.feature_from_geometry(
                    matched_geom,
                    {
                        "transactionId": trip_dict.get("transactionId"),
                        "matchStatus": trip_dict.get("matchStatus"),
                        "startTime": (
                            trip_dict.get("startTime").isoformat()
                            if hasattr(trip_dict.get("startTime"), "isoformat")
                            else trip_dict.get("startTime")
                        ),
                        "endTime": (
                            trip_dict.get("endTime").isoformat()
                            if hasattr(trip_dict.get("endTime"), "isoformat")
                            else trip_dict.get("endTime")
                        ),
                        "distance": trip_dict.get("distance"),
                    },
                ),
            )

        return {
            "job_id": job_id,
            "stage": progress.stage or "unknown",
            "mode": mode,
            "window": window,
            "total": total,
            "sample": sample,
            "skipped": skipped,
            "geojson": {"type": "FeatureCollection", "features": features},
        }

    @staticmethod
    def _normalize_request(request: MapMatchJobRequest) -> MapMatchJobRequest:
        if request.rematch:
            request.unmatched_only = False

        if request.mode == "trip_id" and not request.trip_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="trip_id is required",
            )
        if request.mode == "trip_ids" and not request.trip_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="trip_ids are required",
            )
        if request.mode == "date_range":
            has_interval = request.interval_days and request.interval_days > 0
            has_dates = bool(request.start_date and request.end_date)
            if not has_interval and not has_dates:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="start/end date or interval_days is required",
                )
        return request

    @staticmethod
    async def _create_progress(
        job_id: str | None,
        request: MapMatchJobRequest,
        source: str,
    ) -> None:
        if not job_id:
            return

        progress = ProgressStatus(
            operation_id=job_id,
            operation_type="map_matching",
            status="queued",
            stage="queued",
            progress=0,
            message="Queued map matching job",
            started_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            metadata={
                "source": source,
                "mode": request.mode,
                "start_date": request.start_date,
                "end_date": request.end_date,
                "interval_days": request.interval_days,
                "trip_id": request.trip_id,
                "trip_ids": request.trip_ids,
                "trip_ids_count": len(request.trip_ids or []),
                "unmatched_only": request.unmatched_only,
                "rematch": request.rematch,
                "total": 0,
                "processed": 0,
                "map_matched": 0,
                "failed": 0,
            },
        )
        await progress.insert()


class MapMatchingJobRunner:
    """Execute map matching jobs and update progress."""

    def __init__(self) -> None:
        self._map_matching_service = MapMatchingService()

    async def run(self, job_id: str, request: MapMatchJobRequest) -> dict[str, Any]:
        """
        Run map matching directly on trips without going through full processing.

        This is a streamlined flow that:
        1. Loads trips with GPS data
        2. Calls Valhalla directly for each trip
        3. Updates the matchedGps field in the database
        """
        progress = await self._get_or_create_progress(job_id)
        if progress.stage == "cancelled" or progress.status == "cancelled":
            return {
                "status": "cancelled",
                "total": 0,
                "map_matched": 0,
                "failed": 0,
                "skipped": 0,
            }

        try:
            health = await check_service_health(force_refresh=True)
            if not health.valhalla_healthy:
                message = (
                    f"Valhalla not ready: {health.valhalla_error or 'routing unavailable'}"
                )
                await self._update_progress(
                    progress,
                    status="failed",
                    stage="blocked",
                    progress_pct=0,
                    message=message,
                )
                logger.warning("Map matching blocked: %s", message)
                return {
                    "status": "blocked",
                    "message": message,
                    "total": 0,
                    "map_matched": 0,
                    "failed": 0,
                    "skipped": 0,
                }

            # Find trips to process
            query = self._build_query(request)
            trips = await Trip.find(query).project(TripMapMatchProjection).to_list()

            total_trips = len(trips)
            await self._update_progress(
                progress,
                stage="processing",
                message=f"Found {total_trips} trips to map match",
                total=total_trips,
            )

            if total_trips == 0:
                await self._update_progress(
                    progress,
                    status="completed",
                    stage="completed",
                    progress_pct=100,
                    message="No trips found matching criteria",
                )
                return {
                    "status": "success",
                    "message": "No trips found matching criteria",
                    "total": 0,
                    "map_matched": 0,
                    "failed": 0,
                    "skipped": 0,
                }

            # Process trips directly
            results = await self._process_trips_directly(
                trips,
                progress,
                total_trips,
                job_id,
            )

            if results.get("cancelled"):
                progress_pct = (
                    int((results.get("processed", 0) / total_trips) * 100)
                    if total_trips
                    else 0
                )
                await self._update_progress(
                    progress,
                    status="cancelled",
                    stage="cancelled",
                    progress_pct=progress_pct,
                    message="Cancelled by user",
                    **results,
                )
                return {
                    "status": "cancelled",
                    "total": total_trips,
                    "map_matched": results["matched"],
                    "failed": results["failed"],
                    "skipped": results["skipped"],
                }

            # Final update
            await self._update_progress(
                progress,
                status="completed",
                stage="completed",
                progress_pct=100,
                message=f"Done: {results['matched']} matched, {results['skipped']} skipped, {results['failed']} failed",
                **results,
            )

            return {
                "status": "success",
                "total": total_trips,
                "map_matched": results["matched"],
                "failed": results["failed"],
                "skipped": results["skipped"],
            }

        except Exception as exc:
            logger.exception("Map matching job failed")
            progress.status = "failed"
            progress.stage = "error"
            progress.progress = 0
            progress.message = f"Error: {exc!s}"
            progress.error = str(exc)
            progress.updated_at = datetime.now(UTC)
            await progress.save()
            raise

    async def _process_trips_directly(
        self,
        trips: list[TripMapMatchProjection],
        progress: ProgressStatus,
        total: int,
        job_id: str,
    ) -> dict[str, int | bool]:
        """Process trips directly without going through the complex pipeline."""
        matched = 0
        failed = 0
        skipped = 0
        processed = 0

        for trip in trips:
            if processed % 5 == 0 and await self._is_cancelled(job_id):
                return {
                    "matched": matched,
                    "failed": failed,
                    "skipped": skipped,
                    "processed": processed,
                    "cancelled": True,
                }
            processed += 1
            trip_id = trip.transactionId or "unknown"

            try:
                result = await self._map_match_single_trip(trip)

                if result == "matched":
                    matched += 1
                elif result == "skipped":
                    skipped += 1
                else:
                    failed += 1

            except Exception as e:
                logger.warning("Map matching failed for trip %s: %s", trip_id, e)
                failed += 1

            # Update progress every trip (for responsiveness)
            if processed % 5 == 0 or processed == total:
                if await self._is_cancelled(job_id):
                    return {
                        "matched": matched,
                        "failed": failed,
                        "skipped": skipped,
                        "processed": processed,
                        "cancelled": True,
                    }
                await self._update_progress(
                    progress,
                    progress_pct=int((processed / total) * 100),
                    message=f"Processing: {processed}/{total} trips",
                    matched=matched,
                    failed=failed,
                    skipped=skipped,
                    processed=processed,
                    total=total,
                )

        return {"matched": matched, "failed": failed, "skipped": skipped, "processed": processed}

    async def _map_match_single_trip(self, trip: TripMapMatchProjection) -> str:
        """
        Map match a single trip and update it in the database.

        Returns: "matched", "skipped", or "failed"
        """
        trip_id = trip.transactionId
        gps_data = trip.gps

        # Check if we have valid GPS data
        if not gps_data or not isinstance(gps_data, dict):
            logger.debug("Trip %s: No GPS data, skipping", trip_id)
            await self._update_trip_match_status(trip_id, "skipped:no-gps")
            return "skipped"

        gps_type = gps_data.get("type")
        coords = gps_data.get("coordinates", [])

        if gps_type == "Point":
            logger.debug("Trip %s: Single point GPS, skipping", trip_id)
            await self._update_trip_match_status(trip_id, "skipped:single-point")
            return "skipped"

        if gps_type != "LineString":
            logger.debug("Trip %s: Unsupported GPS type '%s', skipping", trip_id, gps_type)
            await self._update_trip_match_status(trip_id, f"skipped:unsupported-type:{gps_type}")
            return "skipped"

        if not coords or len(coords) < 2:
            logger.debug("Trip %s: Insufficient coordinates, skipping", trip_id)
            await self._update_trip_match_status(trip_id, "skipped:insufficient-coords")
            return "skipped"

        # Extract timestamps for better matching
        trip_dict = trip.model_dump()
        timestamps = extract_timestamps_for_coordinates(coords, trip_dict)

        # Call Valhalla
        logger.debug("Trip %s: Calling Valhalla with %d coordinates", trip_id, len(coords))
        result = await self._map_matching_service.map_match_coordinates(coords, timestamps)

        if result.get("code") != "Ok":
            error_msg = result.get("message", "Unknown error")
            logger.warning("Trip %s: Map matching failed: %s", trip_id, error_msg)
            await self._update_trip_match_status(trip_id, f"error:{error_msg[:50]}")
            return "failed"

        # Extract matched geometry
        matchings = result.get("matchings", [])
        if not matchings or not matchings[0].get("geometry"):
            logger.warning("Trip %s: No geometry returned", trip_id)
            await self._update_trip_match_status(trip_id, "error:no-geometry")
            return "failed"

        matched_geometry = matchings[0]["geometry"]
        geom_type = matched_geometry.get("type", "unknown")

        # Update the trip in the database
        await self._update_trip_matched_gps(trip_id, matched_geometry)
        logger.debug("Trip %s: Successfully matched", trip_id)
        return "matched"

    async def _update_trip_match_status(self, trip_id: str, status: str) -> None:
        """Update just the match status for a trip."""
        trip = await Trip.find_one(Trip.transactionId == trip_id)
        if trip:
            trip.matchStatus = status
            trip.matched_at = get_current_utc_time()
            await trip.save()

    async def _update_trip_matched_gps(self, trip_id: str, geometry: dict[str, Any]) -> None:
        """Update the matched GPS geometry for a trip."""
        trip = await Trip.find_one(Trip.transactionId == trip_id)
        if trip:
            trip.matchedGps = geometry
            trip.matchStatus = f"matched:{geometry.get('type', 'unknown').lower()}"
            trip.matched_at = get_current_utc_time()
            await trip.save()

    async def _get_or_create_progress(self, job_id: str) -> ProgressStatus:
        """Get existing progress or create new one."""
        progress = await ProgressStatus.find_one(
            ProgressStatus.operation_id == job_id,
            ProgressStatus.operation_type == "map_matching",
        )
        if not progress:
            progress = ProgressStatus(
                operation_id=job_id,
                operation_type="map_matching",
                status="running",
                stage="initializing",
                progress=0,
                message="Starting map matching...",
                started_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
                metadata={},
            )
            await progress.insert()
        else:
            if _is_terminal_progress(progress):
                return progress
            progress.status = "running"
            progress.stage = "initializing"
            progress.progress = 0
            progress.message = "Finding trips to map match..."
            progress.updated_at = datetime.now(UTC)
            await progress.save()
        return progress

    async def _is_cancelled(self, job_id: str) -> bool:
        progress = await ProgressStatus.find_one(
            ProgressStatus.operation_id == job_id,
            ProgressStatus.operation_type == "map_matching",
        )
        if not progress:
            return False
        return progress.stage == "cancelled" or progress.status == "cancelled"

    async def _update_progress(
        self,
        progress: ProgressStatus,
        *,
        status: str | None = None,
        stage: str | None = None,
        progress_pct: int | None = None,
        message: str | None = None,
        **metrics: Any,
    ) -> None:
        """Update progress with given values."""
        if status:
            progress.status = status
        if stage:
            progress.stage = stage
        if progress_pct is not None:
            progress.progress = progress_pct
        if message:
            progress.message = message

        # Merge metrics into metadata
        if metrics:
            progress.metadata = {**(progress.metadata or {}), **metrics}

        progress.updated_at = datetime.now(UTC)
        await progress.save()

    @staticmethod
    def _build_query(request: MapMatchJobRequest) -> dict[str, Any]:
        query: dict[str, Any] = {"invalid": {"$ne": True}}

        if request.mode == "unmatched":
            query["matchedGps"] = None
            return query

        if request.mode == "trip_id":
            query["transactionId"] = request.trip_id
            return query

        if request.mode == "trip_ids":
            query["transactionId"] = {"$in": request.trip_ids}
            return query

        if request.mode == "date_range":
            if request.interval_days and request.interval_days > 0:
                end_dt = datetime.now(UTC)
                start_dt = end_dt - timedelta(days=request.interval_days)
                start_iso = start_dt.date().isoformat()
                end_iso = end_dt.date().isoformat()
            else:
                start_iso = normalize_calendar_date(request.start_date)
                end_iso = normalize_calendar_date(request.end_date)

            range_expr = build_calendar_date_expr(start_iso, end_iso)
            if not range_expr:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid date range",
                )
            query["$expr"] = range_expr
            if request.unmatched_only:
                query["matchedGps"] = None
            return query

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported map matching mode",
        )


def _chunked(items: list[str], size: int) -> list[list[str]]:
    if size <= 0:
        return [items]
    return [items[i : i + size] for i in range(0, len(items), size)]
