"""
Coverage update worker.

This module handles the actual coverage updates when trips complete. It
listens for events and updates CoverageState accordingly.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId
from pymongo import UpdateOne

from street_coverage.constants import BACKFILL_BULK_WRITE_SIZE, BACKFILL_TRIP_BATCH_SIZE
from street_coverage.events import CoverageEvents, emit_coverage_updated, on_event
from street_coverage.matching import (
    AreaSegmentIndex,
    match_trip_to_streets,
    trip_to_linestring,
)
from street_coverage.models import CoverageArea, CoverageState
from street_coverage.stats import update_area_stats
from date_utils import get_current_utc_time, normalize_to_utc_datetime

logger = logging.getLogger(__name__)

BackfillProgressCallback = Callable[[dict[str, Any]], Awaitable[None]]


@on_event(CoverageEvents.TRIP_COMPLETED)
async def handle_trip_completed(
    trip_id: PydanticObjectId | str,
    trip_data: dict[str, Any] | None = None,
    **_kwargs,
) -> None:
    """
    Handle a trip_completed event by updating coverage.

    This is the main entry point for coverage updates.
    """
    logger.info("Processing coverage for completed trip %s", trip_id)

    try:
        # Get trip data if not provided
        if trip_data is None:
            from db.models import Trip

            trip = await Trip.get(trip_id)
            if trip is None:
                logger.warning(
                    "Trip %s not found, skipping coverage update",
                    trip_id,
                )
                return
            trip_data = trip.model_dump()

        trip_driven_at = get_trip_driven_at(trip_data)

        # Match trip to streets in all relevant areas
        matches = await match_trip_to_streets(trip_data)

        if not matches:
            logger.debug(
                "Trip %s did not match any coverage areas",
                trip_id,
            )
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
            "Trip %s updated %s segments across %s areas",
            trip_id,
            total_updated,
            len(matches),
        )

    except Exception:
        logger.exception("Error processing coverage for trip %s", trip_id)
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
    progress_interval: int = 100,
    progress_time_seconds: float = 0.5,
) -> int:
    """
    Backfill coverage for an area using existing trips.

    Ultra-optimized version with:
    - Batch geometry union for single-pass matching
    - All trips loaded upfront
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

    # Progress tracking state
    processed_trips = 0
    matched_batches = 0
    total_updated = 0
    last_reported_time = time.monotonic()

    async def report_progress(
        total_trips: int | None = None,
        segments_found: int = 0,
        force: bool = False,
    ) -> None:
        nonlocal last_reported_time
        if not progress_callback:
            return
        now = time.monotonic()
        if (
            not force
            and progress_interval > 0
            and processed_trips % progress_interval != 0
        ):
            return
        if not force and now - last_reported_time < progress_time_seconds:
            return
        await progress_callback(
            {
                "processed_trips": processed_trips,
                "total_trips": total_trips,
                "matched_trips": matched_batches,
                "segments_updated": segments_found,
            },
        )
        last_reported_time = now

    # Load ALL trips upfront for batch processing
    logger.info("Loading all trips for area %s", area.display_name)
    await report_progress(force=True)

    all_trips = await Trip.find(query).to_list()
    total_trip_count = len(all_trips)

    logger.info(
        "Loaded %d trips for area %s, starting batch matching",
        total_trip_count,
        area.display_name,
    )

    await report_progress(total_trips=total_trip_count, force=True)

    # Convert all trips to LineStrings in parallel using ProcessPoolExecutor
    logger.info("Converting %d trips to geometries", total_trip_count)

    trip_lines = []
    earliest_driven_at: datetime | None = None

    # Process trips in chunks to convert to geometry
    chunk_size = BACKFILL_TRIP_BATCH_SIZE
    for chunk_start in range(0, total_trip_count, chunk_size):
        chunk_end = min(chunk_start + chunk_size, total_trip_count)
        chunk = all_trips[chunk_start:chunk_end]

        for trip in chunk:
            trip_data = trip.model_dump()
            line = trip_to_linestring(trip_data)
            if line is not None:
                trip_lines.append(line)
                # Track earliest trip date
                trip_time = get_trip_driven_at(trip_data)
                if trip_time and (
                    earliest_driven_at is None or trip_time < earliest_driven_at
                ):
                    earliest_driven_at = trip_time

        processed_trips = chunk_end
        await report_progress(total_trips=total_trip_count)

    logger.info(
        "Converted %d/%d trips to valid geometries",
        len(trip_lines),
        total_trip_count,
    )

    if not trip_lines:
        logger.warning("No valid trip geometries found for area %s", area.display_name)
        await update_area_stats(area_id)
        return 0

    # Process trip lines in smaller batches for geometry union matching
    # 50 trips per batch is a good balance between speed and memory
    mega_batch_size = 50
    all_matched_segments: set[str] = set()
    total_batches = (len(trip_lines) + mega_batch_size - 1) // mega_batch_size

    logger.info(
        "Starting batch matching: %d trips in %d batches",
        len(trip_lines),
        total_batches,
    )

    for batch_start in range(0, len(trip_lines), mega_batch_size):
        batch_end = min(batch_start + mega_batch_size, len(trip_lines))
        batch_lines = trip_lines[batch_start:batch_end]
        batch_num = batch_start // mega_batch_size + 1

        logger.debug(
            "Processing batch %d/%d (%d trips)",
            batch_num,
            total_batches,
            len(batch_lines),
        )

        # Use batch matching with geometry union
        matched = segment_index.find_matching_segments_batch(batch_lines)
        all_matched_segments.update(matched)
        matched_batches += 1

        await report_progress(
            total_trips=total_trip_count,
            segments_found=len(all_matched_segments),
        )

    logger.info(
        "Batch matching complete: %d segments matched from %d trips",
        len(all_matched_segments),
        len(trip_lines),
    )

    # Bulk write all segment updates
    if all_matched_segments:
        logger.info(
            "Bulk updating %d segments for area %s",
            len(all_matched_segments),
            area.display_name,
        )

        # Get undriveable segments to skip
        undriveable_states = await CoverageState.find(
            {"area_id": area_id, "status": "undriveable"},
        ).to_list()
        undriveable_ids = {state.segment_id for state in undriveable_states}

        # Filter out undriveable segments
        segments_to_update = all_matched_segments - undriveable_ids

        # Use earliest trip date as driven_at for all segments
        driven_at = earliest_driven_at or get_current_utc_time()

        # Build bulk operations
        operations = []
        for seg_id in segments_to_update:
            operations.append(
                UpdateOne(
                    {"area_id": area_id, "segment_id": seg_id},
                    {
                        "$set": {
                            "status": "driven",
                            "last_driven_at": driven_at,
                        },
                        "$min": {"first_driven_at": driven_at},
                        "$setOnInsert": {
                            "area_id": area_id,
                            "segment_id": seg_id,
                            "manually_marked": False,
                            "driven_by_trip_id": None,
                        },
                    },
                    upsert=True,
                ),
            )

            # Execute in batches to avoid memory issues
            if len(operations) >= BACKFILL_BULK_WRITE_SIZE:
                collection = CoverageState.get_pymongo_collection()
                result = await collection.bulk_write(operations, ordered=False)
                total_updated += result.modified_count + result.upserted_count
                operations = []
                await report_progress(
                    total_trips=total_trip_count,
                    segments_found=len(all_matched_segments),
                )

        # Execute remaining operations
        if operations:
            collection = CoverageState.get_pymongo_collection()
            result = await collection.bulk_write(operations, ordered=False)
            total_updated += result.modified_count + result.upserted_count

    # Update stats after backfill
    await update_area_stats(area_id)
    await report_progress(
        total_trips=total_trip_count,
        segments_found=len(all_matched_segments),
        force=True,
    )

    logger.info(
        "Backfill complete for area %s: %d segments from %d trips in %d batches",
        area.display_name,
        total_updated,
        len(trip_lines),
        matched_batches,
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
