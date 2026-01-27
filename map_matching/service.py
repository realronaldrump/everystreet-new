"""Map matching job service and runner."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException, status

from core.date_utils import normalize_calendar_date
from db import build_calendar_date_expr
from db.models import ProgressStatus, Trip
from map_matching.schemas import MapMatchJobRequest
from tasks.ops import enqueue_task
from trips.models import TripStatusProjection
from trips.services.trip_batch_service import TripService

logger = logging.getLogger(__name__)

DEFAULT_BATCH_SIZE = 100


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
        self._trip_service = TripService()

    async def run(self, job_id: str, request: MapMatchJobRequest) -> dict[str, Any]:
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
                message="Initializing map matching job",
                started_at=datetime.now(UTC),
                updated_at=datetime.now(UTC),
                metadata={},
            )
            await progress.insert()
        else:
            progress.status = "running"
            progress.stage = "initializing"
            progress.progress = 0
            progress.message = "Finding trips to map match..."
            progress.updated_at = datetime.now(UTC)
            await progress.save()

        try:
            query = self._build_query(request)
            trips_list = (
                await Trip.find(query)
                .project(TripStatusProjection)
                .to_list()
            )

            trip_ids = [
                str(trip.transactionId)
                for trip in trips_list
                if trip.transactionId
            ]

            total_trips = len(trip_ids)
            progress.stage = "processing"
            progress.message = f"Found {total_trips} trips to process"
            progress.metadata = {
                **(progress.metadata or {}),
                "total": total_trips,
                "processed": 0,
                "map_matched": 0,
                "failed": 0,
            }
            progress.updated_at = datetime.now(UTC)
            await progress.save()

            if total_trips == 0:
                progress.status = "completed"
                progress.stage = "completed"
                progress.progress = 100
                progress.message = "No trips found matching criteria"
                progress.updated_at = datetime.now(UTC)
                await progress.save()
                return {
                    "status": "success",
                    "message": "No trips found matching criteria",
                    "total": 0,
                    "map_matched": 0,
                    "failed": 0,
                }

            processed = 0
            matched = 0
            failed = 0

            for chunk in _chunked(trip_ids, DEFAULT_BATCH_SIZE):
                result = await self._trip_service.remap_trips(
                    trip_ids=chunk,
                    limit=len(chunk),
                )
                processed += len(chunk)
                matched += int(result.get("map_matched", 0) or 0)
                failed += int(result.get("failed", 0) or 0)

                progress.progress = int((processed / total_trips) * 100)
                progress.message = f"Processed {processed} of {total_trips} trips"
                progress.metadata = {
                    "total": total_trips,
                    "processed": processed,
                    "map_matched": matched,
                    "failed": failed,
                }
                progress.updated_at = datetime.now(UTC)
                await progress.save()

            progress.status = "completed"
            progress.stage = "completed"
            progress.progress = 100
            progress.message = (
                f"Completed: {matched} matched, {failed} failed"
            )
            progress.updated_at = datetime.now(UTC)
            await progress.save()

            return {
                "status": "success",
                "total": total_trips,
                "map_matched": matched,
                "failed": failed,
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
