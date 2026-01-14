"""
Area ingestion pipeline.

This module handles the complete lifecycle of adding a coverage area:
1. Fetch boundary from geocoding/Nominatim
2. Fetch streets from OSM Overpass API
3. Segment streets and store in database
4. Initialize coverage state for all segments
5. Backfill with historical trips
"""

from __future__ import annotations

import asyncio
import logging
import math
from datetime import UTC, datetime
from typing import Any

import aiohttp
from beanie import PydanticObjectId
from shapely.geometry import LineString, mapping, shape
from shapely.ops import transform

from coverage.constants import (
    BATCH_SIZE,
    MAX_INGESTION_RETRIES,
    METERS_TO_MILES,
    OSM_REFRESH_DAYS,
    RETRY_BASE_DELAY_SECONDS,
    SEGMENT_LENGTH_METERS,
)
from coverage.events import CoverageEvents, emit_area_created, on_event
from coverage.geo_utils import geodesic_length_meters, get_local_transformers
from coverage.models import CoverageArea, CoverageState, Job, Street
from coverage.stats import update_area_stats
from coverage.worker import backfill_coverage_for_area

logger = logging.getLogger(__name__)

# OSM highway types to include (driveable roads)
DRIVEABLE_HIGHWAY_TYPES = {
    "motorway",
    "trunk",
    "primary",
    "secondary",
    "tertiary",
    "unclassified",
    "residential",
    "motorway_link",
    "trunk_link",
    "primary_link",
    "secondary_link",
    "tertiary_link",
    "living_street",
    "service",
}

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

    logger.info(f"Created coverage area: {display_name} ({area.id})")

    # Emit event to trigger async ingestion
    await emit_area_created(area.id, display_name)

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

    # Delete the area itself
    await area.delete()

    logger.info(f"Deleted coverage area: {area.display_name} ({area_id})")

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
    await area.save()

    # Create ingestion job
    job = Job(
        job_type="area_rebuild",
        area_id=area_id,
        status="pending",
        stage="Queued",
    )
    await job.insert()

    # Queue the ingestion (fire and forget)
    asyncio.create_task(_run_ingestion_pipeline(area_id, job.id))

    return job


# =============================================================================
# Event Handlers
# =============================================================================


@on_event(CoverageEvents.AREA_CREATED)
async def handle_area_created(
    area_id: PydanticObjectId | str,
    display_name: str,
    **kwargs,
) -> None:
    """Handle area_created event by running the ingestion pipeline."""
    area_id = PydanticObjectId(area_id) if isinstance(area_id, str) else area_id

    # Create ingestion job
    job = Job(
        job_type="area_ingestion",
        area_id=area_id,
        status="pending",
        stage="Queued",
    )
    await job.insert()

    # Run ingestion
    asyncio.create_task(_run_ingestion_pipeline(area_id, job.id))


# =============================================================================
# Ingestion Pipeline
# =============================================================================


async def _run_ingestion_pipeline(
    area_id: PydanticObjectId,
    job_id: PydanticObjectId,
) -> None:
    """
    Execute the full ingestion pipeline for an area.

    This is the main orchestrator that runs all ingestion stages.
    """
    job = await Job.get(job_id)
    area = await CoverageArea.get(area_id)

    if not job or not area:
        logger.error(f"Job {job_id} or area {area_id} not found")
        return

    try:

        async def update_job(
            stage: str | None = None,
            progress: float | None = None,
            message: str | None = None,
        ) -> None:
            if stage is not None:
                job.stage = stage
            if progress is not None:
                job.progress = progress
            if message is not None:
                job.message = message
            await job.save()

        # Mark job as running
        job.status = "running"
        job.started_at = datetime.now(UTC)
        await update_job(message="Starting ingestion pipeline")

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

        # Stage 2: Fetch streets from OSM
        await update_job(
            stage="Fetching streets from OpenStreetMap",
            progress=20,
            message="Querying Overpass API",
        )

        osm_ways = await _fetch_osm_streets(area.boundary)
        logger.info(f"Fetched {len(osm_ways)} ways from OSM for {area.display_name}")

        # Stage 3: Segment streets
        await update_job(
            stage="Processing streets",
            progress=40,
            message=f"Segmenting {len(osm_ways):,} OSM ways",
        )

        segments = _segment_streets(osm_ways, area.id, area.area_version)
        logger.info(f"Created {len(segments)} segments for {area.display_name}")

        await update_job(message=f"Created {len(segments):,} segments")

        # Stage 4: Clear any partial data for this version
        await update_job(
            stage="Clearing existing street data",
            progress=45,
            message=f"Clearing data for version {area.area_version}",
        )

        await _clear_existing_area_version_data(area.id, area.area_version)

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
            message=f"Initializing {len(segments):,} segments",
        )

        await _initialize_coverage_state(area.id, segments)

        # Stage 7: Update statistics
        await update_job(
            stage="Calculating statistics",
            progress=75,
            message="Aggregating coverage stats",
        )

        await area.set({"osm_fetched_at": datetime.now(UTC)})
        stats_area = await update_area_stats(area.id)
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
            area.id,
            progress_callback=handle_backfill_progress,
        )
        backfill_state["segments_updated"] = segments_updated
        await update_job(
            stage="Processing historical trips",
            progress=BACKFILL_PROGRESS_END,
            message=format_backfill_message(backfill_state),
        )

        # Complete
        job.status = "completed"
        job.stage = "Complete"
        job.progress = 100
        if backfill_state.get("matched_trips", 0) > 0:
            job.message = (
                "Backfill updated "
                f"{backfill_state['segments_updated']:,} segments from "
                f"{backfill_state['matched_trips']:,} trips"
            )
        else:
            job.message = "Complete"
        job.completed_at = datetime.now(UTC)
        await job.save()

        await area.set(
            {
                "status": "ready",
                "health": "healthy",
                "last_error": None,
            },
        )

        logger.info(f"Ingestion complete for area {area.display_name}")

    except Exception as e:
        logger.exception(f"Ingestion failed for area {area_id}: {e}")

        job.retry_count += 1
        job.error = str(e)

        area_updates: dict[str, Any] = {}
        if job.retry_count >= MAX_INGESTION_RETRIES:
            job.status = "needs_attention"
            job.stage = "Failed - manual intervention required"
            area_updates = {
                "status": "error",
                "health": "unavailable",
                "last_error": str(e),
            }
        else:
            job.status = "pending"
            job.stage = f"Retry {job.retry_count} scheduled"
            # Schedule retry with exponential backoff
            delay = RETRY_BASE_DELAY_SECONDS * (2 ** (job.retry_count - 1))
            asyncio.create_task(_delayed_retry(area_id, job_id, delay))

        await job.save()
        if area_updates:
            await area.set(area_updates)


async def _delayed_retry(
    area_id: PydanticObjectId,
    job_id: PydanticObjectId,
    delay_seconds: float,
) -> None:
    """Schedule a retry after a delay."""
    await asyncio.sleep(delay_seconds)
    await _run_ingestion_pipeline(area_id, job_id)


# =============================================================================
# Pipeline Stages
# =============================================================================


async def _fetch_boundary(location_name: str) -> dict[str, Any]:
    """Fetch boundary polygon from Nominatim geocoding."""
    url = "https://nominatim.openstreetmap.org/search"
    params = {
        "q": location_name,
        "format": "json",
        "polygon_geojson": 1,
        "limit": 1,
    }
    headers = {
        "User-Agent": "EveryStreet/1.0",
    }

    async with aiohttp.ClientSession() as session:
        async with session.get(url, params=params, headers=headers) as response:
            response.raise_for_status()
            data = await response.json()

    if not data:
        msg = f"Location not found: {location_name}"
        raise ValueError(msg)

    result = data[0]
    geojson = result.get("geojson")

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


def _split_bounding_box(
    minx: float,
    miny: float,
    maxx: float,
    maxy: float,
    rows: int = 2,
    cols: int = 2,
) -> list[list[float]]:
    """Split bounding box into smaller boxes for parallel fetching."""
    dx = (maxx - minx) / cols
    dy = (maxy - miny) / rows
    boxes = []
    for i in range(rows):
        for j in range(cols):
            sub_minx = minx + j * dx
            sub_maxx = minx + (j + 1) * dx
            sub_miny = miny + i * dy
            sub_maxy = miny + (i + 1) * dy
            boxes.append([sub_minx, sub_miny, sub_maxx, sub_maxy])
    return boxes


async def _fetch_single_box(
    highway_filter: str,
    minx: float,
    miny: float,
    maxx: float,
    maxy: float,
) -> dict[str, Any]:
    """Fetch OSM data for a single bounding box with retry."""
    query = f"""
    [out:json][timeout:300];
    (
      way["highway"~"^({highway_filter})$"]({miny},{minx},{maxy},{maxx});
    );
    out body;
    >;
    out skel qt;
    """

    url = "https://overpass-api.de/api/interpreter"
    max_retries = 3
    for attempt in range(max_retries):
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, data={"data": query}) as response:
                    response.raise_for_status()
                    return await response.json()
        except aiohttp.ClientResponseError as e:
            if e.status in (504, 502, 503) and attempt < max_retries - 1:
                await asyncio.sleep(30 * (2**attempt))  # exponential backoff
                continue
            raise
    msg = "Max retries exceeded"
    raise RuntimeError(msg)


async def _fetch_osm_streets(boundary: dict[str, Any]) -> list[dict[str, Any]]:
    """Fetch street ways from OSM Overpass API within a boundary."""
    geom = shape(boundary)
    minx, miny, maxx, maxy = geom.bounds
    area = geom.area  # in degrees²

    highway_filter = "|".join(DRIVEABLE_HIGHWAY_TYPES)

    if area > 0.05:  # approx 600 km², split into 4
        boxes = _split_bounding_box(minx, miny, maxx, maxy, rows=2, cols=2)
        tasks = [_fetch_single_box(highway_filter, *box) for box in boxes]
        responses = await asyncio.gather(*tasks)
        # Merge elements
        all_elements = []
        for resp in responses:
            all_elements.extend(resp.get("elements", []))
    else:
        data = await _fetch_single_box(highway_filter, minx, miny, maxx, maxy)
        all_elements = data.get("elements", [])

    # Parse response into ways with geometries
    nodes = {}
    ways = []

    for element in all_elements:
        if element["type"] == "node":
            nodes[element["id"]] = (element["lon"], element["lat"])
        elif element["type"] == "way":
            ways.append(element)

    # Remove duplicate ways by osm_id
    ways_dict = {way["id"]: way for way in ways}
    ways = list(ways_dict.values())

    # Build way geometries
    result = []
    boundary_shape = shape(boundary)

    for way in ways:
        coords = []
        for node_id in way.get("nodes", []):
            if node_id in nodes:
                coords.append(nodes[node_id])

        if len(coords) >= 2:
            line = LineString(coords)

            # Clip to boundary
            if boundary_shape.intersects(line):
                clipped = boundary_shape.intersection(line)
                if not clipped.is_empty:
                    result.append(
                        {
                            "osm_id": way["id"],
                            "tags": way.get("tags", {}),
                            "geometry": (
                                mapping(clipped)
                                if hasattr(clipped, "geoms")
                                else mapping(clipped)
                            ),
                        },
                    )

    return result


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

    logger.debug(f"Stored {len(segments)} street segments")


async def _clear_existing_area_version_data(
    area_id: PydanticObjectId,
    area_version: int,
) -> None:
    """
    Clear any existing street data for the current area version.

    This keeps rebuilds and retries idempotent without deleting past
    versions.
    """
    await Street.find({"area_id": area_id, "area_version": area_version}).delete()

    segment_prefix = f"{area_id}-{area_version}-"
    await CoverageState.find(
        {
            "area_id": area_id,
            "segment_id": {"$regex": f"^{segment_prefix}"},
        },
    ).delete()


async def _initialize_coverage_state(
    area_id: PydanticObjectId,
    segments: list[dict[str, Any]],
) -> None:
    """Initialize coverage state for all segments as undriven."""
    if not segments:
        return

    # Create state records in batches
    for i in range(0, len(segments), BATCH_SIZE):
        batch = segments[i : i + BATCH_SIZE]
        state_docs = [
            CoverageState(
                area_id=area_id,
                segment_id=seg["segment_id"],
                status="undriven",
            )
            for seg in batch
        ]
        await CoverageState.insert_many(state_docs)

    logger.debug(f"Initialized coverage state for {len(segments)} segments")


# =============================================================================
# Maintenance
# =============================================================================


async def check_areas_needing_refresh() -> list[CoverageArea]:
    """Find areas that need OSM data refresh (older than 90 days)."""
    from datetime import timedelta

    cutoff = datetime.now(UTC) - timedelta(days=OSM_REFRESH_DAYS)

    return await CoverageArea.find(
        {
            "status": "ready",
            "$or": [
                {"osm_fetched_at": None},
                {"osm_fetched_at": {"$lt": cutoff}},
            ],
        },
    ).to_list()


async def refresh_stale_areas() -> int:
    """
    Trigger rebuilds for all areas needing refresh.

    Returns number of areas queued for rebuild.
    """
    areas = await check_areas_needing_refresh()

    for area in areas:
        await rebuild_area(area.id)

    return len(areas)
