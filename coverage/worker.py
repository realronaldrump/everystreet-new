"""
Coverage update worker.

This module handles the actual coverage updates when trips complete.
It listens for events and updates CoverageState accordingly.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from beanie import PydanticObjectId

from coverage.events import CoverageEvents, emit_coverage_updated, on_event
from coverage.matching import match_trip_to_streets
from coverage.models import CoverageArea, CoverageState
from coverage.stats import update_area_stats
from date_utils import get_current_utc_time, normalize_to_utc_datetime

logger = logging.getLogger(__name__)


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
            f"across {len(matches)} areas"
        )

    except Exception as e:
        logger.error(f"Error processing coverage for trip {trip_id}: {e}")
        raise


@on_event(CoverageEvents.TRIP_UPLOADED)
async def handle_trip_uploaded(
    trip_id: PydanticObjectId | str,
    trip_data: dict[str, Any] | None = None,
    **kwargs,
) -> None:
    """
    Handle a trip_uploaded event.

    Delegates to the same handler as trip_completed.
    """
    await handle_trip_completed(trip_id=trip_id, trip_data=trip_data, **kwargs)


async def update_coverage_for_segments(
    area_id: PydanticObjectId,
    segment_ids: list[str],
    trip_id: PydanticObjectId | None = None,
    driven_at: datetime | str | None = None,
) -> int:
    """
    Mark segments as driven for an area.

    Uses bulk operations for efficiency.
    Returns the number of segments updated.
    """
    if not segment_ids:
        return 0

    # Skip segments that were manually marked as undriveable
    undriveable_states = await CoverageState.find(
        {
            "area_id": area_id,
            "segment_id": {"$in": segment_ids},
            "status": "undriveable",
        }
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
                                        ]
                                    },
                                    driven_at,
                                    "$$existing",
                                ]
                            },
                        }
                    },
                    "driven_by_trip_id": trip_id,
                    "area_id": area_id,
                    "segment_id": segment_id,
                    "manually_marked": {"$ifNull": ["$manually_marked", False]},
                }
            }
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
            {"area_id": area_id, "segment_id": segment_id}
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
        {"area_id": area_id, "segment_id": segment_id}
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
        {"area_id": area_id, "segment_id": segment_id}
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
) -> int:
    """
    Backfill coverage for an area using existing trips.

    Useful after area ingestion to catch up with historical trips.
    If `since` is provided, only processes trips after that date.

    Returns total number of segments marked as driven.
    """
    from db.models import Trip

    area = await CoverageArea.get(area_id)
    if not area:
        logger.warning(f"Area {area_id} not found for backfill")
        return 0

    # Build query for trips that might intersect this area
    # We use a $geoIntersects query on the gps field if the area has a boundary
    query: dict = {}
    if since:
        query["startTime"] = {"$gte": since}

    # Get bounding box for spatial filtering
    # Create a bounding box polygon for the $geoIntersects query
    if area.bounding_box and len(area.bounding_box) == 4:
        min_lon, min_lat, max_lon, max_lat = area.bounding_box
        # Create a GeoJSON polygon for the bounding box
        bbox_polygon = {
            "type": "Polygon",
            "coordinates": [
                [
                    [min_lon, min_lat],
                    [max_lon, min_lat],
                    [max_lon, max_lat],
                    [min_lon, max_lat],
                    [min_lon, min_lat],  # Close the polygon
                ]
            ],
        }
        # Use $geoIntersects to find trips whose GPS traces intersect the area
        # This is more accurate than checking start/end points
        query["gps"] = {"$geoIntersects": {"$geometry": bbox_polygon}}
    elif area.boundary:
        # Use the actual boundary if available
        query["gps"] = {"$geoIntersects": {"$geometry": area.boundary}}

    total_updated = 0
    trip_count = 0

    logger.info(f"Starting backfill for area {area.display_name} with query: {query}")

    async for trip in Trip.find(query):
        trip_data = trip.model_dump()
        trip_driven_at = get_trip_driven_at(trip_data)
        matches = await match_trip_to_streets(trip_data, area_ids=[area_id])

        if area_id in matches:
            updated = await update_coverage_for_segments(
                area_id=area_id,
                segment_ids=matches[area_id],
                trip_id=trip.id,
                driven_at=trip_driven_at,
            )
            total_updated += updated
            trip_count += 1

    # Update stats after backfill
    await update_area_stats(area_id)

    logger.info(
        f"Backfill complete for area {area.display_name}: "
        f"{total_updated} segments from {trip_count} trips"
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
