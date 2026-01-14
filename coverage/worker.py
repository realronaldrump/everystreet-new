"""
Coverage update worker.

This module handles the actual coverage updates when trips complete. It
listens for events and updates CoverageState accordingly.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId
from pymongo import UpdateOne

from coverage.constants import (
    BACKFILL_BULK_WRITE_SIZE,
    BACKFILL_CONCURRENT_TRIPS,
    BACKFILL_TRIP_BATCH_SIZE,
)
from coverage.events import CoverageEvents, emit_coverage_updated, on_event
from coverage.matching import (
    AreaSegmentIndex,
    match_trip_to_streets,
    trip_to_linestring,
)
from coverage.models import CoverageArea, CoverageState
from coverage.stats import update_area_stats
from date_utils import get_current_utc_time, normalize_to_utc_datetime

logger = logging.getLogger(__name__)

BackfillProgressCallback = Callable[[dict[str, Any]], Awaitable[None]]


@on_event(CoverageEvents.TRIP_COMPLETED)
async def handle_trip_completed(
    trip_id: PydanticObjectId | str,
    trip_data: dict[str, Any] | None = None,
    **kwargs,
) -> None:
    """
    Handle a trip_completed event by updating coverage.

    This is the main entry point for coverage updates.
    """
    logger.info(f"Processing coverage for completed trip {trip_id}")

    try:
        # Get trip data if not provided
        if trip_data is None:
            from db.models import Trip

            trip = await Trip.get(trip_id)
            if trip is None:
                logger.warning(f"Trip {trip_id} not found, skipping coverage update")
                return
            trip_data = trip.model_dump()

        trip_driven_at = get_trip_driven_at(trip_data)

        # Match trip to streets in all relevant areas
        matches = await match_trip_to_streets(trip_data)

        if not matches:
            logger.debug(f"Trip {trip_id} did not match any coverage areas")
            return

        # Update coverage for each area
        total_updated = 0
        for area_id, segment_ids in matches.items():
            updated = await update_coverage_for_segments(
                area_id=area_id,
                segment_ids=segment_ids,
                trip_id=(
                    PydanticObjectId(trip_id) if isinstance(trip_id, str) else trip_id
                ),
                driven_at=trip_driven_at,
            )
            total_updated += updated

            # Update area statistics
            await update_area_stats(area_id)

            # Emit coverage updated event
            await emit_coverage_updated(area_id, updated)

        logger.info(
            f"Trip {trip_id} updated {total_updated} segments "
            f"across {len(matches)} areas",
        )

    except Exception as e:
        logger.exception(f"Error processing coverage for trip {trip_id}: {e}")
        raise


async def update_coverage_for_segments(
    area_id: PydanticObjectId,
    segment_ids: list[str],
    trip_id: PydanticObjectId | None = None,
    driven_at: datetime | str | None = None,
) -> int:
    """
    Mark segments as driven for an area.

    Uses bulk operations for efficiency. Returns the number of segments
    updated.
    """
    if not segment_ids:
        return 0

    # Skip segments that were manually marked as undriveable
    undriveable_states = await CoverageState.find(
        {
            "area_id": area_id,
            "segment_id": {"$in": segment_ids},
            "status": "undriveable",
        },
    ).to_list()
    undriveable_ids = {state.segment_id for state in undriveable_states}
    if undriveable_ids:
        segment_ids = [sid for sid in segment_ids if sid not in undriveable_ids]

    if not segment_ids:
        return 0

    driven_at = normalize_to_utc_datetime(driven_at) or get_current_utc_time()

    updated = 0
    for segment_id in segment_ids:
        update_pipeline = [
            {
                "$set": {
                    "status": "driven",
                    "last_driven_at": driven_at,
                    "first_driven_at": {
                        "$let": {
                            "vars": {"existing": "$first_driven_at"},
                            "in": {
                                "$cond": [
                                    {
                                        "$or": [
                                            {"$eq": ["$$existing", None]},
                                            {"$gt": ["$$existing", driven_at]},
                                        ],
                                    },
                                    driven_at,
                                    "$$existing",
                                ],
                            },
                        },
                    },
                    "driven_by_trip_id": trip_id,
                    "area_id": area_id,
                    "segment_id": segment_id,
                    "manually_marked": {"$ifNull": ["$manually_marked", False]},
                },
            },
        ]

        on_insert = CoverageState(
            area_id=area_id,
            segment_id=segment_id,
            status="driven",
            last_driven_at=driven_at,
            first_driven_at=driven_at,
            driven_by_trip_id=trip_id,
            manually_marked=False,
        )

        result = await CoverageState.find_one(
            {"area_id": area_id, "segment_id": segment_id},
        ).upsert(update_pipeline, on_insert=on_insert)

        if hasattr(result, "modified_count"):
            updated += result.modified_count
        elif hasattr(result, "inserted_id"):
            updated += 1
        else:
            updated += 1

    if updated:
        logger.debug(
            "Updated %d segments for area %s",
            updated,
            area_id,
        )

    return updated


async def mark_segment_undriveable(
    area_id: PydanticObjectId,
    segment_id: str,
) -> bool:
    """
    Mark a segment as undriveable (e.g., highway, private road).

    Returns True if the segment was updated.
    """
    result = await CoverageState.find_one(
        {"area_id": area_id, "segment_id": segment_id},
    )

    if result:
        result.status = "undriveable"
        result.manually_marked = True
        result.marked_at = datetime.now(UTC)
        await result.save()
        return True

    # Create new state record
    state = CoverageState(
        area_id=area_id,
        segment_id=segment_id,
        status="undriveable",
        manually_marked=True,
        marked_at=datetime.now(UTC),
    )
    await state.insert()
    return True


async def mark_segment_undriven(
    area_id: PydanticObjectId,
    segment_id: str,
) -> bool:
    """
    Reset a segment to undriven state.

    Returns True if the segment was updated.
    """
    result = await CoverageState.find_one(
        {"area_id": area_id, "segment_id": segment_id},
    )

    if result:
        result.status = "undriven"
        result.last_driven_at = None
        result.first_driven_at = None
        result.driven_by_trip_id = None
        result.manually_marked = True
        result.marked_at = datetime.now(UTC)
        await result.save()
        return True

    return False


async def backfill_coverage_for_area(
    area_id: PydanticObjectId,
    since: datetime | None = None,
    progress_callback: BackfillProgressCallback | None = None,
    progress_interval: int = 50,
    progress_time_seconds: float = 1.0,
) -> int:
    """
    Backfill coverage for an area using existing trips.

    Optimized version with:
    - Batch trip loading
    - Parallel trip processing with concurrency control
    - STRtree spatial indexing for O(log n) segment lookups
    - Bulk database writes

    Returns total number of segments marked as driven.
    """
    from db.models import Trip

    area = await CoverageArea.get(area_id)
    if not area:
        logger.warning("Area %s not found for backfill", area_id)
        return 0

    # Build spatial index once for the entire backfill
    logger.info("Building spatial index for area %s", area.display_name)
    segment_index = AreaSegmentIndex(area_id, area.area_version)
    await segment_index.build()

    if not segment_index.segments:
        logger.warning("No segments found for area %s", area.display_name)
        return 0

    # Build query for trips that might intersect this area
    query: dict = {}
    if since:
        query["startTime"] = {"$gte": since}

    if area.bounding_box and len(area.bounding_box) == 4:
        min_lon, min_lat, max_lon, max_lat = area.bounding_box
        bbox_polygon = {
            "type": "Polygon",
            "coordinates": [
                [
                    [min_lon, min_lat],
                    [max_lon, min_lat],
                    [max_lon, max_lat],
                    [min_lon, max_lat],
                    [min_lon, min_lat],
                ],
            ],
        }
        geo_filter = {"$geoIntersects": {"$geometry": bbox_polygon}}
        query["$or"] = [{"gps": geo_filter}, {"matchedGps": geo_filter}]
    elif area.boundary:
        geo_filter = {"$geoIntersects": {"$geometry": area.boundary}}
        query["$or"] = [{"gps": geo_filter}, {"matchedGps": geo_filter}]

    # Get total count for progress reporting
    total_trips: int | None = None
    if progress_callback:
        try:
            total_trips = await Trip.find(query).count()
        except Exception as exc:
            logger.warning("Failed to count trips for backfill progress: %s", exc)

    # Progress tracking state
    processed_trips = 0
    matched_trips = 0
    total_updated = 0
    last_reported = 0
    last_reported_time = time.monotonic()

    async def report_progress(force: bool = False) -> None:
        nonlocal last_reported, last_reported_time
        if not progress_callback:
            return
        now = time.monotonic()
        if (
            not force
            and processed_trips - last_reported < progress_interval
            and now - last_reported_time < progress_time_seconds
        ):
            return
        await progress_callback(
            {
                "processed_trips": processed_trips,
                "total_trips": total_trips,
                "matched_trips": matched_trips,
                "segments_updated": total_updated,
            },
        )
        last_reported = processed_trips
        last_reported_time = now

    await report_progress(force=True)

    logger.info(
        "Starting optimized backfill for area %s with %d segments",
        area.display_name,
        len(segment_index.segments),
    )

    # Semaphore for concurrency control
    semaphore = asyncio.Semaphore(BACKFILL_CONCURRENT_TRIPS)

    # Collect all segment updates for bulk write
    all_segment_updates: dict[str, tuple[datetime | None, PydanticObjectId | None]] = {}

    async def process_single_trip(
        trip_data: dict, trip_id: PydanticObjectId
    ) -> tuple[list[str], datetime | None]:
        """Process a single trip and return matched segment IDs."""
        async with semaphore:
            trip_line = trip_to_linestring(trip_data)
            if trip_line is None:
                return [], None

            trip_driven_at = get_trip_driven_at(trip_data)

            # Use spatial index for fast matching
            matched_ids = segment_index.find_matching_segments(trip_line)

            return matched_ids, trip_driven_at

    # Process trips in batches
    batch: list[tuple[dict, PydanticObjectId]] = []

    async for trip in Trip.find(query):
        trip_data = trip.model_dump()
        batch.append((trip_data, trip.id))

        if len(batch) >= BACKFILL_TRIP_BATCH_SIZE:
            # Process batch in parallel
            tasks = [process_single_trip(td, tid) for td, tid in batch]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for i, result in enumerate(results):
                processed_trips += 1
                if isinstance(result, Exception):
                    logger.debug("Trip processing error: %s", result)
                    continue

                matched_ids, trip_driven_at = result
                if matched_ids:
                    matched_trips += 1
                    trip_id = batch[i][1]
                    for seg_id in matched_ids:
                        # Keep earliest driven_at per segment
                        existing = all_segment_updates.get(seg_id)
                        if existing is None or (
                            trip_driven_at
                            and (existing[0] is None or trip_driven_at < existing[0])
                        ):
                            all_segment_updates[seg_id] = (trip_driven_at, trip_id)

            batch = []
            await report_progress()

    # Process remaining trips in final batch
    if batch:
        tasks = [process_single_trip(td, tid) for td, tid in batch]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for i, result in enumerate(results):
            processed_trips += 1
            if isinstance(result, Exception):
                continue

            matched_ids, trip_driven_at = result
            if matched_ids:
                matched_trips += 1
                trip_id = batch[i][1]
                for seg_id in matched_ids:
                    existing = all_segment_updates.get(seg_id)
                    if existing is None or (
                        trip_driven_at
                        and (existing[0] is None or trip_driven_at < existing[0])
                    ):
                        all_segment_updates[seg_id] = (trip_driven_at, trip_id)

    await report_progress()

    # Bulk write all segment updates
    if all_segment_updates:
        logger.info(
            "Bulk updating %d segments for area %s",
            len(all_segment_updates),
            area.display_name,
        )

        # Get undriveable segments to skip
        undriveable_states = await CoverageState.find(
            {"area_id": area_id, "status": "undriveable"},
        ).to_list()
        undriveable_ids = {state.segment_id for state in undriveable_states}

        # Filter out undriveable segments
        segment_updates = {
            seg_id: data
            for seg_id, data in all_segment_updates.items()
            if seg_id not in undriveable_ids
        }

        # Build bulk operations
        operations = []
        for seg_id, (driven_at, trip_id) in segment_updates.items():
            driven_at = driven_at or get_current_utc_time()
            operations.append(
                UpdateOne(
                    {"area_id": area_id, "segment_id": seg_id},
                    {
                        "$set": {
                            "status": "driven",
                            "last_driven_at": driven_at,
                            "driven_by_trip_id": trip_id,
                        },
                        "$min": {"first_driven_at": driven_at},
                        "$setOnInsert": {
                            "area_id": area_id,
                            "segment_id": seg_id,
                            "manually_marked": False,
                        },
                    },
                    upsert=True,
                )
            )

            # Execute in batches to avoid memory issues
            if len(operations) >= BACKFILL_BULK_WRITE_SIZE:
                collection = CoverageState.get_motor_collection()
                result = await collection.bulk_write(operations, ordered=False)
                total_updated += result.modified_count + result.upserted_count
                operations = []

        # Execute remaining operations
        if operations:
            collection = CoverageState.get_motor_collection()
            result = await collection.bulk_write(operations, ordered=False)
            total_updated += result.modified_count + result.upserted_count

    # Update stats after backfill
    await update_area_stats(area_id)
    await report_progress(force=True)

    logger.info(
        "Backfill complete for area %s: %d segments from %d trips",
        area.display_name,
        total_updated,
        matched_trips,
    )

    return total_updated


def get_trip_driven_at(trip_data: dict[str, Any] | None) -> datetime | None:
    if not trip_data:
        return None

    driven_at = (
        trip_data.get("endTime")
        or trip_data.get("startTime")
        or trip_data.get("lastUpdate")
    )
    return normalize_to_utc_datetime(driven_at)
