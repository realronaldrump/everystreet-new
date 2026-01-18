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
import logging
import math
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import aiohttp
from beanie import PydanticObjectId
from shapely.geometry import LineString, MultiLineString, mapping, shape
from shapely.ops import transform

from street_coverage.constants import (
    BATCH_SIZE,
    MAX_INGESTION_RETRIES,
    METERS_TO_MILES,
    OSM_REFRESH_DAYS,
    RETRY_BASE_DELAY_SECONDS,
    SEGMENT_LENGTH_METERS,
)
from street_coverage.events import CoverageEvents, emit_area_created, on_event
from street_coverage.geo_utils import geodesic_length_meters, get_local_transformers
from street_coverage.models import CoverageArea, CoverageState, Job, Street
from street_coverage.osm_filters import get_driveable_highway
from street_coverage.stats import update_area_stats
from street_coverage.worker import backfill_coverage_for_area

logger = logging.getLogger(__name__)
_background_tasks: set[asyncio.Task] = set()


def _track_task(task: asyncio.Task) -> None:
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

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
    task = asyncio.create_task(_run_ingestion_pipeline(area_id, job.id))
    _track_task(task)

    return job


# =============================================================================
# Event Handlers
# =============================================================================


@on_event(CoverageEvents.AREA_CREATED)
async def handle_area_created(
    area_id: PydanticObjectId | str,
    display_name: str | None = None,
    **_kwargs,
) -> None:
    """Handle area_created event by running the ingestion pipeline."""
    _ = display_name
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
    task = asyncio.create_task(_run_ingestion_pipeline(area_id, job.id))
    _track_task(task)


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
        logger.error("Job %s or area %s not found", job_id, area_id)
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

        # Stage 2: Load streets from local OSM graph
        await update_job(
            stage="Loading streets from local OSM graph",
            progress=20,
            message="Loading graph data",
        )

        osm_ways = await _load_osm_streets_from_graph(area, job.id)
        logger.info(
            "Loaded %s ways from local graph for %s",
            len(osm_ways),
            area.display_name,
        )

        # Stage 3: Segment streets
        await update_job(
            stage="Processing streets",
            progress=40,
            message=f"Segmenting {len(osm_ways):,} OSM ways",
        )

        segments = _segment_streets(osm_ways, area.id, area.area_version)
        logger.info(
            "Created %s segments for %s",
            len(segments),
            area.display_name,
        )

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

        logger.info("Ingestion complete for area %s", area.display_name)

    except Exception as e:
        logger.exception("Ingestion failed for area %s", area_id)

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
            task = asyncio.create_task(_delayed_retry(area_id, job_id, delay))
            _track_task(task)

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
    from config import require_nominatim_search_url, require_nominatim_user_agent

    url = require_nominatim_search_url()
    params = {
        "q": location_name,
        "format": "json",
        "polygon_geojson": 1,
        "limit": 1,
    }
    headers = {
        "User-Agent": require_nominatim_user_agent(),
    }

    async with aiohttp.ClientSession() as session, session.get(
        url,
        params=params,
        headers=headers,
    ) as response:
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
    from routes.constants import GRAPH_STORAGE_DIR

    graph_path = GRAPH_STORAGE_DIR / f"{area.id}.graphml"
    if graph_path.exists():
        return graph_path

    from preprocess_streets import preprocess_streets

    loc_data = {
        "_id": str(area.id),
        "id": str(area.id),
        "display_name": area.display_name,
        "boundary": area.boundary,
        "bounding_box": area.bounding_box,
    }
    await preprocess_streets(loc_data, task_id=str(job_id) if job_id else None)

    if not graph_path.exists():
        msg = f"Graph file was not created: {graph_path}"
        raise FileNotFoundError(msg)

    return graph_path


async def _load_osm_streets_from_graph(
    area: CoverageArea,
    job_id: PydanticObjectId | None = None,
) -> list[dict[str, Any]]:
    """Load street ways from the local graph built from self-hosted OSM data."""
    import networkx as nx
    import osmnx as ox

    graph_path = await _ensure_area_graph(area, job_id)
    G = ox.load_graphml(graph_path)
    if not isinstance(G, nx.MultiDiGraph):
        G = nx.MultiDiGraph(G)

    Gu = ox.convert.to_undirected(G)

    boundary_geojson = area.boundary
    if (
        isinstance(boundary_geojson, dict)
        and boundary_geojson.get("type") == "Feature"
    ):
        boundary_geojson = boundary_geojson.get("geometry")
    boundary_shape = shape(boundary_geojson) if boundary_geojson else None

    result: list[dict[str, Any]] = []
    for u, v, _k, data in Gu.edges(keys=True, data=True):
        highway_type = get_driveable_highway(data.get("highway"))
        if highway_type is None:
            continue

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
                "osm_id": _coerce_osm_id(data.get("osmid")),
                "tags": {
                    "name": _coerce_name(data.get("name")),
                    "highway": highway_type,
                },
                "geometry": mapping(line),
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

    logger.debug("Stored %s street segments", len(segments))


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

    logger.debug("Initialized coverage state for %s segments", len(segments))


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
