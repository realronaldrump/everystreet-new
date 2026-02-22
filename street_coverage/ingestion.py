"""
Area ingestion pipeline.

This module handles the complete lifecycle of adding a coverage area:
1. Fetch boundary from geocoding/Nominatim
2. Load streets from a local OSM graph extract
3. Segment streets and store in database
4. Initialize coverage state for all segments
5. Backfill with historical trips
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from shapely.geometry import LineString, MultiLineString, mapping, shape
from shapely.ops import transform

from core.coverage import backfill_coverage_for_area
from core.spatial import geodesic_length_meters, get_local_transformers
from db.models import CoverageArea, CoverageState, Job, Street
from map_data.us_states import get_state
from street_coverage.constants import (
    BATCH_SIZE,
    MAX_INGESTION_RETRIES,
    METERS_TO_MILES,
    RETRY_BASE_DELAY_SECONDS,
    SEGMENT_LENGTH_METERS,
)
from street_coverage.public_road_filter import (
    GRAPH_ROAD_FILTER_SIGNATURE_KEY,
    GRAPH_ROAD_FILTER_STATS_KEY,
    PublicRoadFilterAudit,
    classify_public_road,
    extract_relevant_tags,
    get_public_road_filter_signature,
)
from street_coverage.stats import update_area_stats

if TYPE_CHECKING:
    from pathlib import Path

    from beanie import PydanticObjectId

logger = logging.getLogger(__name__)
_background_tasks: set[asyncio.Task] = set()
_job_tasks: dict[str, set[asyncio.Task]] = {}


def _track_task(
    task: asyncio.Task,
    *,
    job_id: PydanticObjectId | None = None,
) -> None:
    _background_tasks.add(task)

    job_key = str(job_id) if job_id is not None else None
    if job_key is not None:
        _job_tasks.setdefault(job_key, set()).add(task)

    def _cleanup(done: asyncio.Task) -> None:
        _background_tasks.discard(done)
        if job_key is None:
            return
        tasks = _job_tasks.get(job_key)
        if not tasks:
            return
        tasks.discard(done)
        if not tasks:
            _job_tasks.pop(job_key, None)

    task.add_done_callback(_cleanup)


def cancel_ingestion_job(job_id: PydanticObjectId) -> bool:
    """
    Attempt to cancel any in-process ingestion tasks for a job.

    Note: This only affects tasks running in the current process.
    Callers should still mark the Job document as cancelled so the
    pipeline can self-abort on the next progress update.
    """
    job_key = str(job_id)
    tasks = _job_tasks.get(job_key)
    if not tasks:
        return False
    for task in list(tasks):
        task.cancel()
    return True


BACKFILL_PROGRESS_START = 75.0
BACKFILL_PROGRESS_END = 99.0


# =============================================================================
# Public API
# =============================================================================


async def create_area(
    display_name: str,
    area_type: str = "city",
    boundary: dict[str, Any] | None = None,
) -> CoverageArea:
    """
    Create a new coverage area and trigger ingestion.

    If boundary is not provided, it will be fetched via geocoding.
    Returns the created area (in "initializing" status).
    """
    # Check for duplicate name
    existing = await CoverageArea.find_one({"display_name": display_name})
    if existing:
        msg = f"Area with name '{display_name}' already exists"
        raise ValueError(msg)

    # Create the area record
    area = CoverageArea(
        display_name=display_name,
        area_type=area_type,
        boundary=boundary or {},
        status="initializing",
        health="unavailable",
    )
    await area.insert()

    logger.info("Created coverage area: %s (%s)", display_name, area.id)

    if area.id is None:
        msg = "Coverage area insert failed (missing id)"
        raise RuntimeError(msg)

    area_id: PydanticObjectId = area.id
    job = Job(
        job_type="area_ingestion",
        area_id=area_id,
        status="pending",
        stage="Queued",
    )
    await job.insert()

    if job.id is None:
        logger.error("Coverage ingestion job insert failed (missing id)")
        return area

    task = asyncio.create_task(_run_ingestion_pipeline(area_id, job.id))
    _track_task(task, job_id=job.id)

    return area


async def delete_area(area_id: PydanticObjectId) -> bool:
    """
    Delete a coverage area and all associated data.

    Returns True if deleted, False if not found.
    """
    area = await CoverageArea.get(area_id)
    if not area:
        return False

    # Delete all streets for this area
    await Street.find({"area_id": area_id}).delete()

    # Delete all coverage state for this area
    await CoverageState.find({"area_id": area_id}).delete()

    # Delete any pending jobs for this area
    await Job.find({"area_id": area_id}).delete()

    # Remove cached graph file (if present)
    with contextlib.suppress(Exception):
        from routing.constants import GRAPH_STORAGE_DIR

        graph_path = GRAPH_STORAGE_DIR / f"{area_id}.graphml"
        if graph_path.exists():
            graph_path.unlink()

    # Delete the area itself
    await area.delete()

    logger.info("Deleted coverage area: %s (%s)", area.display_name, area_id)

    return True


async def rebuild_area(area_id: PydanticObjectId) -> Job:
    """
    Trigger a rebuild of an area with fresh OSM data.

    Returns the created job for tracking progress.
    """
    area = await CoverageArea.get(area_id)
    if not area:
        msg = f"Area {area_id} not found"
        raise ValueError(msg)

    # Update area status
    area.status = "rebuilding"
    area.area_version += 1
    area.optimal_route = None
    area.optimal_route_generated_at = None
    area.last_error = None
    area.road_filter_version = None
    area.road_filter_stats = {}
    area.last_synced = None
    area.total_length_miles = 0.0
    area.driveable_length_miles = 0.0
    area.driven_length_miles = 0.0
    area.coverage_percentage = 0.0
    area.total_segments = 0
    area.driven_segments = 0
    area.undriveable_segments = 0
    area.undriveable_length_miles = 0.0
    await area.save()

    # Rebuilds are a clean slate: remove all prior derived data and cached graphs
    await Street.find({"area_id": area_id}).delete()
    await CoverageState.find({"area_id": area_id}).delete()
    with contextlib.suppress(Exception):
        from routing.constants import GRAPH_STORAGE_DIR

        graph_path = GRAPH_STORAGE_DIR / f"{area_id}.graphml"
        if graph_path.exists():
            graph_path.unlink()

    # Create ingestion job
    job = Job(
        job_type="area_rebuild",
        area_id=area_id,
        status="pending",
        stage="Queued",
    )
    await job.insert()

    if job.id is None:
        msg = "Coverage ingestion job insert failed (missing id)"
        raise RuntimeError(msg)

    # Queue the ingestion (fire and forget)
    task = asyncio.create_task(_run_ingestion_pipeline(area_id, job.id))
    _track_task(task, job_id=job.id)

    return job


async def backfill_area(area_id: PydanticObjectId) -> Job:
    """
    Trigger a backfill of an area using historical trips.

    Returns the created job for tracking progress.
    """
    area = await CoverageArea.get(area_id)
    if not area:
        msg = f"Area {area_id} not found"
        raise ValueError(msg)

    job = Job(
        job_type="area_backfill",
        area_id=area_id,
        status="pending",
        stage="Queued",
        message="Queued",
    )
    await job.insert()

    if job.id is None:
        msg = "Coverage backfill job insert failed (missing id)"
        raise RuntimeError(msg)

    task = asyncio.create_task(_run_backfill_pipeline(area_id, job.id))
    _track_task(task, job_id=job.id)

    return job


# =============================================================================
# Ingestion Pipeline
# =============================================================================


def _validate_area_id(area: CoverageArea) -> PydanticObjectId:
    if area.id is None:
        msg = "Coverage area missing id during ingestion"
        raise RuntimeError(msg)
    return area.id


def _raise_cancelled() -> None:
    """Raise CancelledError; abstracted for linting compliance."""
    raise asyncio.CancelledError


async def _run_backfill_pipeline(
    area_id: PydanticObjectId,
    job_id: PydanticObjectId,
) -> None:
    """Run a backfill job for an area and update Job status/progress."""
    area = await CoverageArea.get(area_id)
    if not area:
        logger.error("Area %s not found for backfill job %s", area_id, job_id)
        return

    async def update_job(
        *,
        stage: str | None = None,
        progress: float | None = None,
        message: str | None = None,
        status: str | None = None,
        error: str | None = None,
        started_at: datetime | None = None,
        completed_at: datetime | None = None,
        result: dict[str, Any] | None = None,
    ) -> None:
        job = await Job.get(job_id)
        if not job:
            return

        # Honor cancellation without allowing this pipeline to overwrite it.
        if job.status == "cancelled":
            _raise_cancelled()

        updates: dict[str, Any] = {"updated_at": datetime.now(UTC)}
        if stage is not None:
            updates["stage"] = stage
        if progress is not None:
            updates["progress"] = float(progress)
        if message is not None:
            updates["message"] = message
        if status is not None:
            updates["status"] = status
        if error is not None:
            updates["error"] = error
        if started_at is not None:
            updates["started_at"] = started_at
        if completed_at is not None:
            updates["completed_at"] = completed_at
        if result is not None:
            updates["result"] = result

        await job.set(updates)

    def format_backfill_message(state: dict[str, Any]) -> str:
        processed = int(state.get("processed_trips", 0) or 0)
        total = state.get("total_trips")
        matched = int(state.get("matched_trips", 0) or 0)
        segments = int(state.get("segments_updated", 0) or 0)
        if isinstance(total, int) and total > 0:
            return (
                f"Matching trips: {processed:,}/{total:,} "
                f"(matched {matched:,}, segments {segments:,})"
            )
        return f"Matching trips: {processed:,} (matched {matched:,}, segments {segments:,})"

    try:
        await update_job(
            status="running",
            started_at=datetime.now(UTC),
            stage="Backfill",
            progress=0.0,
            message=f"Starting backfill for {area.display_name}",
        )

        backfill_state: dict[str, Any] = {}
        last_progress = 0.0

        async def handle_backfill_progress(payload: dict[str, Any]) -> None:
            nonlocal last_progress
            backfill_state.update(payload)

            total = payload.get("total_trips")
            processed = int(payload.get("processed_trips", 0) or 0)
            progress = last_progress
            if isinstance(total, int) and total > 0:
                ratio = min(1.0, processed / max(1, total))
                progress = ratio * 99.0
            progress = max(last_progress, float(progress))
            last_progress = progress

            await update_job(
                stage="Backfill",
                progress=progress,
                message=format_backfill_message(backfill_state),
            )

        segments_updated = await backfill_coverage_for_area(
            area_id,
            progress_callback=handle_backfill_progress,
        )

        result = {
            "segments_updated": segments_updated,
            "processed_trips": int(backfill_state.get("processed_trips", 0) or 0),
            "matched_trips": int(backfill_state.get("matched_trips", 0) or 0),
        }

        await update_job(
            status="completed",
            completed_at=datetime.now(UTC),
            stage="Completed",
            progress=100.0,
            message=f"Backfill complete. Updated {segments_updated} segments.",
            result=result,
        )
    except asyncio.CancelledError:
        logger.info("Backfill job %s cancelled", job_id)
    except Exception as exc:
        logger.exception("Backfill job %s failed", job_id)
        await update_job(
            status="failed",
            completed_at=datetime.now(UTC),
            stage="Failed",
            progress=100.0,
            message="Backfill failed",
            error=str(exc),
        )


async def _run_ingestion_pipeline(
    area_id: PydanticObjectId,
    job_id: PydanticObjectId,
) -> None:
    """
    Execute the full ingestion pipeline for an area.

    This is the main orchestrator that runs all ingestion stages.
    """
    area = await CoverageArea.get(area_id)

    if not area:
        logger.error("Area %s not found for job %s", area_id, job_id)
        return

    try:

        async def update_job(
            stage: str | None = None,
            progress: float | None = None,
            message: str | None = None,
            status: str | None = None,
            error: str | None = None,
            started_at: datetime | None = None,
            completed_at: datetime | None = None,
            retry_count: int | None = None,
            result: dict[str, Any] | None = None,
        ) -> None:
            job = await Job.get(job_id)
            if not job:
                return

            # Honor cancellation without allowing this pipeline to overwrite it.
            if job.status == "cancelled":
                _raise_cancelled()

            updates: dict[str, Any] = {"updated_at": datetime.now(UTC)}
            if stage is not None:
                updates["stage"] = stage
            if progress is not None:
                updates["progress"] = float(progress)
            if message is not None:
                updates["message"] = message
            if status is not None:
                updates["status"] = status
            if error is not None:
                updates["error"] = error
            if started_at is not None:
                updates["started_at"] = started_at
            if completed_at is not None:
                updates["completed_at"] = completed_at
            if retry_count is not None:
                updates["retry_count"] = int(retry_count)
            if result is not None:
                updates["result"] = result

            await job.set(updates)

        # Mark job as running
        await update_job(
            status="running",
            started_at=datetime.now(UTC),
            message="Starting ingestion pipeline",
        )

        # Stage 1: Fetch boundary if needed
        await update_job(
            stage="Fetching boundary",
            progress=5,
            message="Checking boundary data",
        )

        area_updated = False
        if not area.boundary:
            area.boundary = await _fetch_boundary(area.display_name)
            area_updated = True

        if area.boundary and not area.bounding_box:
            area.bounding_box = _calculate_bounding_box(area.boundary)
            area_updated = True

        if area_updated:
            await area.save()

        await update_job(message="Boundary ready")

        # Stage 2: Load streets from local OSM graph
        await update_job(
            stage="Loading streets from local OSM graph",
            progress=20,
            message="Loading graph data",
        )

        osm_ways, road_filter_stats = await _load_osm_streets_from_graph(area, job_id)
        logger.info(
            "Loaded %s ways from local graph for %s",
            len(osm_ways),
            area.display_name,
        )
        logger.info(
            ("Road filter stats for %s: included=%s excluded=%s ambiguous_included=%s"),
            area.display_name,
            road_filter_stats.get("included_count", 0),
            road_filter_stats.get("excluded_count", 0),
            road_filter_stats.get("ambiguous_included_count", 0),
        )

        # Stage 3: Segment streets
        await update_job(
            stage="Processing streets",
            progress=40,
            message=f"Segmenting {len(osm_ways):,} OSM ways",
        )

        area_doc_id = _validate_area_id(area)

        segments = _segment_streets(osm_ways, area_doc_id, area.area_version)
        logger.info(
            "Created %s segments for %s",
            len(segments),
            area.display_name,
        )

        await update_job(
            message=(
                f"Created {len(segments):,} segments "
                f"(excluded {road_filter_stats.get('excluded_count', 0):,} ways)"
            ),
        )

        # Stage 4: Clear any partial data for this version
        await update_job(
            stage="Clearing existing street data",
            progress=45,
            message="Clearing existing street data",
        )

        await _clear_existing_area_data(area_doc_id)

        # Stage 5: Store segments
        await update_job(
            stage="Storing street data",
            progress=60,
            message=f"Storing {len(segments):,} segments",
        )

        await _store_segments(segments)

        # Stage 6: Initialize coverage state
        await update_job(
            stage="Initializing coverage",
            progress=70,
            message="Preparing coverage state",
        )

        # CoverageState documents are created only for non-default statuses
        # (driven/undriveable). Missing states imply "undriven".
        await _initialize_coverage_state(area_doc_id, segments)

        # Stage 7: Update statistics
        await update_job(
            stage="Calculating statistics",
            progress=75,
            message="Aggregating coverage stats",
        )

        await area.set(
            {
                "osm_fetched_at": datetime.now(UTC),
                "road_filter_version": road_filter_stats.get(
                    "road_filter_signature",
                    get_public_road_filter_signature(),
                ),
                "road_filter_stats": road_filter_stats,
            },
        )
        stats_area = await update_area_stats(area_doc_id)
        if stats_area:
            await update_job(
                message=(
                    "Coverage "
                    f"{stats_area.coverage_percentage:.1f}% "
                    f"({stats_area.driven_length_miles:.2f}/"
                    f"{stats_area.driveable_length_miles:.2f} mi driveable)"
                ),
            )

        # Stage 8: Backfill with historical trips
        await update_job(
            stage="Processing historical trips",
            progress=BACKFILL_PROGRESS_START,
            message="Scanning trips for coverage matches",
        )

        backfill_state = {
            "processed_trips": 0,
            "total_trips": None,
            "matched_trips": 0,
            "segments_updated": 0,
        }
        last_backfill_progress = BACKFILL_PROGRESS_START

        def format_backfill_message(state: dict[str, Any]) -> str:
            processed = state.get("processed_trips", 0)
            total = state.get("total_trips")
            matched = state.get("matched_trips", 0)
            updated = state.get("segments_updated", 0)

            if isinstance(total, int):
                trip_part = f"Trips processed: {processed:,}/{total:,}"
            else:
                trip_part = f"Trips processed: {processed:,}"

            return (
                f"{trip_part} | "
                f"Trips matched: {matched:,} | "
                f"Segments updated: {updated:,}"
            )

        async def handle_backfill_progress(stats: dict[str, Any]) -> None:
            nonlocal last_backfill_progress
            backfill_state.update(stats)

            total = backfill_state.get("total_trips")
            processed = backfill_state.get("processed_trips", 0)

            if isinstance(total, int):
                ratio = 1.0 if total <= 0 else min(1.0, processed / total)
                progress = BACKFILL_PROGRESS_START + (
                    (BACKFILL_PROGRESS_END - BACKFILL_PROGRESS_START) * ratio
                )
            else:
                progress = last_backfill_progress

            progress = max(last_backfill_progress, progress)
            last_backfill_progress = progress

            await update_job(
                stage="Processing historical trips",
                progress=progress,
                message=format_backfill_message(backfill_state),
            )

        segments_updated = await backfill_coverage_for_area(
            area_doc_id,
            progress_callback=handle_backfill_progress,
        )
        backfill_state["segments_updated"] = segments_updated
        await update_job(
            stage="Processing historical trips",
            progress=BACKFILL_PROGRESS_END,
            message=format_backfill_message(backfill_state),
        )

        # Complete
        message = "Complete"
        if backfill_state.get("matched_trips", 0) > 0:
            message = (
                "Backfill updated "
                f"{backfill_state['segments_updated']:,} segments from "
                f"{backfill_state['matched_trips']:,} trips"
            )
        job_result = {
            "road_filter_version": road_filter_stats.get("road_filter_version"),
            "road_filter_signature": road_filter_stats.get("road_filter_signature"),
            "included_count": int(road_filter_stats.get("included_count", 0) or 0),
            "excluded_count": int(road_filter_stats.get("excluded_count", 0) or 0),
            "ambiguous_included_count": int(
                road_filter_stats.get("ambiguous_included_count", 0) or 0,
            ),
            "excluded_by_reason": dict(
                road_filter_stats.get("excluded_by_reason") or {},
            ),
            "sample_excluded_osm_ids": list(
                road_filter_stats.get("sample_excluded_osm_ids") or [],
            ),
            "backfill_processed_trips": int(
                backfill_state.get("processed_trips", 0) or 0,
            ),
            "backfill_total_trips": backfill_state.get("total_trips"),
            "backfill_matched_trips": int(backfill_state.get("matched_trips", 0) or 0),
            "backfill_segments_updated": int(
                backfill_state.get("segments_updated", 0) or 0,
            ),
        }
        await update_job(
            status="completed",
            stage="Complete",
            progress=100,
            message=message,
            completed_at=datetime.now(UTC),
            result=job_result,
        )

        await area.set(
            {
                "status": "ready",
                "health": "healthy",
                "last_error": None,
            },
        )

        logger.info("Ingestion complete for area %s", area.display_name)

    except asyncio.CancelledError:
        logger.info("Ingestion cancelled for area %s (job %s)", area_id, job_id)
        now = datetime.now(UTC)
        job = await Job.get(job_id)
        if job:
            await job.set(
                {
                    "status": "cancelled",
                    "stage": "Cancelled by user",
                    "message": "Cancelled",
                    "completed_at": job.completed_at or now,
                    "updated_at": now,
                },
            )
        await area.set(
            {
                "status": "error",
                "health": "unavailable",
                "last_error": "Cancelled by user",
            },
        )
        return
    except Exception as e:
        logger.exception("Ingestion failed for area %s", area_id)

        job = await Job.get(job_id)
        if not job:
            return
        if job.status == "cancelled":
            return

        retry_count = int(job.retry_count or 0) + 1
        err_str = str(e)
        now = datetime.now(UTC)

        area_updates: dict[str, Any] = {}
        if retry_count >= MAX_INGESTION_RETRIES:
            await job.set(
                {
                    "status": "needs_attention",
                    "stage": "Failed - manual intervention required",
                    "error": err_str,
                    "retry_count": retry_count,
                    "message": f"Failed: {err_str}",
                    "completed_at": now,
                    "updated_at": now,
                },
            )
            area_updates = {
                "status": "error",
                "health": "unavailable",
                "last_error": err_str,
            }
        else:
            # Schedule retry with exponential backoff
            delay = RETRY_BASE_DELAY_SECONDS * (2 ** (retry_count - 1))
            await job.set(
                {
                    "status": "pending",
                    "stage": f"Retry {retry_count} scheduled",
                    "error": err_str,
                    "retry_count": retry_count,
                    "message": f"Retrying in {delay:.0f}s: {err_str}",
                    "updated_at": now,
                },
            )
            task = asyncio.create_task(_delayed_retry(area_id, job_id, delay))
            _track_task(task, job_id=job_id)

        if area_updates:
            await area.set(area_updates)


async def _delayed_retry(
    area_id: PydanticObjectId,
    job_id: PydanticObjectId,
    delay_seconds: float,
) -> None:
    """Schedule a retry after a delay."""
    try:
        await asyncio.sleep(delay_seconds)
    except asyncio.CancelledError:
        return

    job = await Job.get(job_id)
    if not job or job.status == "cancelled":
        return

    await _run_ingestion_pipeline(area_id, job_id)


# =============================================================================
# Pipeline Stages
# =============================================================================


async def _fetch_boundary(location_name: str) -> dict[str, Any]:
    """Fetch boundary polygon from Nominatim geocoding."""
    from core.http.nominatim import NominatimClient

    client = NominatimClient()
    data: list[dict[str, Any]] = []

    def _candidate_queries(name: str) -> list[str]:
        base = " ".join((name or "").split())
        if not base:
            return []

        candidates = [base]

        title = ", ".join(part.strip().title() for part in base.split(","))
        if title and title not in candidates:
            candidates.append(title)

        parts = [part.strip() for part in base.split(",") if part.strip()]
        if len(parts) >= 2:
            city = parts[0].title()
            state_raw = parts[-1]
            state_code = state_raw.strip().upper()
            state_info = get_state(state_code)
            if state_info and state_info.get("name"):
                state_name = str(state_info["name"])
                expanded = f"{city}, {state_name}"
                if expanded not in candidates:
                    candidates.append(expanded)
                expanded_us = f"{expanded}, USA"
                if expanded_us not in candidates:
                    candidates.append(expanded_us)
            state_code_query = f"{city}, {state_code}"
            if state_code_query not in candidates:
                candidates.append(state_code_query)

        for candidate in list(candidates):
            lower = candidate.lower()
            if "usa" not in lower and "united states" not in lower:
                with_country = f"{candidate}, USA"
                if with_country not in candidates:
                    candidates.append(with_country)

        return candidates

    for query in _candidate_queries(location_name):
        data = await client.search_raw(
            query=query,
            limit=1,
            polygon_geojson=True,
        )
        if data:
            break

    if not data:
        msg = f"Location not found: {location_name}"
        raise ValueError(msg)

    result = data[0]
    geojson = result.get("geojson")

    if not geojson:
        bbox = result.get("boundingbox")
        if isinstance(bbox, list) and len(bbox) == 4:
            try:
                south, north, west, east = map(float, bbox)
                geojson = {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [west, south],
                            [west, north],
                            [east, north],
                            [east, south],
                            [west, south],
                        ],
                    ],
                }
                logger.warning(
                    "Using bounding box geometry for %s due to missing polygon",
                    location_name,
                )
            except (TypeError, ValueError):
                geojson = None

    if not geojson:
        msg = f"No boundary polygon for: {location_name}"
        raise ValueError(msg)

    # Ensure it's a Polygon or MultiPolygon
    geom_type = geojson.get("type")
    if geom_type not in ("Polygon", "MultiPolygon"):
        msg = f"Invalid geometry type for boundary: {geom_type}"
        raise ValueError(msg)

    return geojson


def _calculate_bounding_box(boundary: dict[str, Any]) -> list[float]:
    """Calculate bounding box [min_lon, min_lat, max_lon, max_lat] from GeoJSON."""
    geom = shape(boundary)
    minx, miny, maxx, maxy = geom.bounds
    return [minx, miny, maxx, maxy]


def _coerce_osm_id(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, list | tuple | set):
        for item in value:
            try:
                return int(item)
            except (TypeError, ValueError):
                continue
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_line_geometry(geom: Any) -> Any | None:
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in ("LineString", "MultiLineString"):
        return geom
    if geom.geom_type == "GeometryCollection":
        lines = []
        for item in geom.geoms:
            if item.geom_type == "LineString":
                lines.append(item)
            elif item.geom_type == "MultiLineString":
                lines.extend(list(item.geoms))
        if not lines:
            return None
        if len(lines) == 1:
            return lines[0]
        return MultiLineString(lines)
    return None


def _edge_geometry(G: Any, u: Any, v: Any, data: dict[str, Any]) -> Any | None:
    geom = data.get("geometry")
    if geom is not None:
        return geom
    try:
        return LineString(
            [
                (float(G.nodes[u]["x"]), float(G.nodes[u]["y"])),
                (float(G.nodes[v]["x"]), float(G.nodes[v]["y"])),
            ],
        )
    except Exception:
        return None


def _coerce_name(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, list | tuple | set):
        for item in value:
            if item is None:
                continue
            return str(item)
        return None
    return str(value)


async def _ensure_area_graph(
    area: CoverageArea,
    job_id: PydanticObjectId | None = None,
) -> Path:
    from routing.constants import GRAPH_STORAGE_DIR

    graph_path = GRAPH_STORAGE_DIR / f"{area.id}.graphml"
    if graph_path.exists():
        from core.osmnx_graphml import load_graphml_robust

        expected_signature = get_public_road_filter_signature()
        try:
            graph = load_graphml_robust(graph_path)
            stored_signature = str(
                graph.graph.get(GRAPH_ROAD_FILTER_SIGNATURE_KEY) or "",
            ).strip()
            if stored_signature == expected_signature:
                return graph_path
            logger.info(
                (
                    "Graph road-filter signature mismatch for %s "
                    "(stored=%s expected=%s); rebuilding graph."
                ),
                area.display_name,
                stored_signature or "missing",
                expected_signature,
            )
        except Exception:
            logger.warning(
                "Unable to validate existing graph metadata for %s; rebuilding.",
                area.display_name,
                exc_info=True,
            )
        with contextlib.suppress(FileNotFoundError):
            graph_path.unlink()

    from street_coverage.preprocessing import preprocess_streets

    loc_data = {
        "_id": str(area.id),
        "id": str(area.id),
        "display_name": area.display_name,
        "boundary": area.boundary,
        "bounding_box": area.bounding_box,
        "area_version": area.area_version,
    }
    await preprocess_streets(loc_data, task_id=str(job_id) if job_id else None)

    if not graph_path.exists():
        msg = f"Graph file was not created: {graph_path}"
        raise FileNotFoundError(msg)

    return graph_path


async def _load_osm_streets_from_graph(
    area: Any,
    job_id: PydanticObjectId | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Load street ways from the local graph built from self-hosted OSM data."""
    import networkx as nx
    import osmnx as ox

    from core.osmnx_graphml import load_graphml_robust

    graph_path = await _ensure_area_graph(area, job_id)
    G = load_graphml_robust(graph_path)
    if not isinstance(G, nx.MultiDiGraph):
        G = nx.MultiDiGraph(G)

    Gu = ox.convert.to_undirected(G)

    boundary_geojson = area.boundary
    if isinstance(boundary_geojson, dict) and boundary_geojson.get("type") == "Feature":
        boundary_geojson = boundary_geojson.get("geometry")
    boundary_shape = shape(boundary_geojson) if boundary_geojson else None

    result: list[dict[str, Any]] = []
    road_filter_audit = PublicRoadFilterAudit()
    for u, v, _k, data in Gu.edges(keys=True, data=True):
        tags = extract_relevant_tags(data)
        decision = classify_public_road(tags)
        road_filter_audit.record(decision, osm_id=data.get("osmid") or data.get("id"))

        if not decision.include:
            continue
        highway_type = decision.highway_type or "unclassified"

        line = _edge_geometry(Gu, u, v, data)
        if line is None:
            continue

        if boundary_shape is not None:
            if not boundary_shape.intersects(line):
                continue
            line = _coerce_line_geometry(boundary_shape.intersection(line))
            if line is None:
                continue

        result.append(
            {
                # Pyrosm graphs sometimes use `id` instead of `osmid`.
                "osm_id": _coerce_osm_id(data.get("osmid") or data.get("id")),
                "tags": {
                    "name": _coerce_name(tags.get("name") or data.get("name")),
                    "highway": highway_type,
                },
                "geometry": mapping(line),
            },
        )

    graph_stats_raw = G.graph.get(GRAPH_ROAD_FILTER_STATS_KEY)
    graph_stats: dict[str, Any] = {}
    if isinstance(graph_stats_raw, dict):
        graph_stats = dict(graph_stats_raw)
    elif isinstance(graph_stats_raw, str) and graph_stats_raw.strip():
        try:
            import json

            parsed = json.loads(graph_stats_raw)
            if isinstance(parsed, dict):
                graph_stats = parsed
        except Exception:
            logger.warning(
                "Invalid graph road-filter stats metadata for %s",
                area.display_name,
            )

    audit_stats = road_filter_audit.to_dict()
    if graph_stats:
        audit_stats.setdefault("graph_build_filter_stats", graph_stats)

    return result, audit_stats


def _segment_streets(
    osm_ways: list[dict[str, Any]],
    area_id: PydanticObjectId,
    area_version: int,
) -> list[dict[str, Any]]:
    """Segment OSM ways into fixed-length segments."""
    segments = []
    seq = 0

    for way in osm_ways:
        geom = way["geometry"]
        tags = way["tags"]
        osm_id = way["osm_id"]

        street_name = tags.get("name")
        highway_type = tags.get("highway", "unclassified")

        # Handle both LineString and MultiLineString
        if geom["type"] == "LineString":
            lines = [shape(geom)]
        elif geom["type"] == "MultiLineString":
            lines = list(shape(geom).geoms)
        else:
            continue

        for line in lines:
            to_meters, to_wgs84 = get_local_transformers(line)
            # Project to meters for accurate segmentation
            line_m = transform(to_meters, line)
            total_length = line_m.length

            if total_length < SEGMENT_LENGTH_METERS:
                # Keep as single segment
                segments.append(
                    {
                        "segment_id": f"{area_id}-{area_version}-{seq}",
                        "area_id": area_id,
                        "area_version": area_version,
                        "geometry": mapping(line),
                        "street_name": street_name,
                        "highway_type": highway_type,
                        "osm_id": osm_id,
                        "length_miles": geodesic_length_meters(line) * METERS_TO_MILES,
                    },
                )
                seq += 1
            else:
                # Split into segments
                num_segments = max(
                    1,
                    math.ceil(total_length / SEGMENT_LENGTH_METERS),
                )
                segment_length = total_length / num_segments

                for i in range(num_segments):
                    start_dist = i * segment_length
                    end_dist = min((i + 1) * segment_length, total_length)

                    # Get the actual line segment
                    segment_m = _extract_line_segment(line_m, start_dist, end_dist)
                    if segment_m is None or segment_m.is_empty:
                        continue

                    # Project back to WGS84
                    segment_wgs = transform(to_wgs84, segment_m)

                    segments.append(
                        {
                            "segment_id": f"{area_id}-{area_version}-{seq}",
                            "area_id": area_id,
                            "area_version": area_version,
                            "geometry": mapping(segment_wgs),
                            "street_name": street_name,
                            "highway_type": highway_type,
                            "osm_id": osm_id,
                            "length_miles": geodesic_length_meters(segment_wgs)
                            * METERS_TO_MILES,
                        },
                    )
                    seq += 1

    return segments


def _extract_line_segment(
    line: LineString,
    start_dist: float,
    end_dist: float,
) -> LineString | None:
    """Extract a segment of a line between two distances."""
    if start_dist >= end_dist:
        return None

    coords = list(line.coords)
    result_coords = []
    current_dist = 0.0

    for i in range(len(coords) - 1):
        p1 = coords[i]
        p2 = coords[i + 1]
        segment = LineString([p1, p2])
        segment_len = segment.length

        next_dist = current_dist + segment_len

        if next_dist < start_dist:
            # Haven't reached start yet
            current_dist = next_dist
            continue

        if current_dist > end_dist:
            # Past the end
            break

        # This segment overlaps our range
        seg_start = max(0, start_dist - current_dist)
        seg_end = min(segment_len, end_dist - current_dist)

        if seg_start < seg_end:
            start_point = segment.interpolate(seg_start)
            end_point = segment.interpolate(seg_end)

            if not result_coords:
                result_coords.append((start_point.x, start_point.y))
            result_coords.append((end_point.x, end_point.y))

        current_dist = next_dist

    if len(result_coords) >= 2:
        return LineString(result_coords)
    return None


async def _store_segments(segments: list[dict[str, Any]]) -> None:
    """Store street segments in the database using bulk operations."""
    if not segments:
        return

    # Process in batches
    for i in range(0, len(segments), BATCH_SIZE):
        batch = segments[i : i + BATCH_SIZE]
        street_docs = [Street(**seg) for seg in batch]
        await Street.insert_many(street_docs)

    logger.debug("Stored %s street segments", len(segments))


async def _clear_existing_area_data(area_id: PydanticObjectId) -> None:
    """
    Clear existing derived data for an area.

    Rebuilds are treated as clean slates, and ingestion retries should
    be idempotent. We delete *all* streets and coverage state for the
    area to avoid accumulating old versions.
    """
    await Street.find({"area_id": area_id}).delete()
    await CoverageState.find({"area_id": area_id}).delete()


async def _initialize_coverage_state(
    area_id: PydanticObjectId,
    segments: list[dict[str, Any]],
) -> None:
    """
    Initialize coverage state for an area.

    CoverageState rows are only stored for non-default statuses
    (driven/undriveable). Missing rows imply "undriven", so there is
    nothing to initialize here.
    """
    _ = area_id
    _ = segments
