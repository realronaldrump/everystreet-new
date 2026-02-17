import contextlib
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

import networkx as nx
from beanie import PydanticObjectId

from core.jobs import JobHandle, create_job, find_job
from db.models import CoverageArea, CoverageState, Street

from .constants import (
    GRAPH_STORAGE_DIR,
    MAX_SEGMENTS,
)
from .core import make_req_id, solve_greedy_route
from .gaps import fill_route_gaps
from .graph import (
    build_osmid_index,
    prepare_spatial_matching_graph,
    project_linestring_coords,
    try_match_osmid,
)
from .validation import validate_route

if TYPE_CHECKING:
    from shapely.geometry import LineString

    from .types import EdgeRef, ReqId

logger = logging.getLogger(__name__)


def _get_osmnx():
    import osmnx as ox

    return ox


async def generate_optimal_route_with_progress(
    location_id: str | PydanticObjectId,
    task_id: str,
    start_coords: tuple[float, float] | None = None,  # (lon, lat)
) -> dict[str, Any]:
    """Public entrypoint for background/manual route generation."""
    return await _generate_optimal_route_with_progress_impl(
        location_id=location_id,
        task_id=task_id,
        start_coords=start_coords,
    )


async def _generate_optimal_route_with_progress_impl(
    location_id: str | PydanticObjectId,
    task_id: str,
    start_coords: tuple[float, float] | None = None,  # (lon, lat)
    *,
    mapping_retry_attempted: bool = False,
) -> dict[str, Any]:
    location_id_str = str(location_id)
    existing_job = await find_job("optimal_route", task_id=task_id)
    if existing_job:
        if not existing_job.location:
            existing_job.location = location_id_str
        if isinstance(location_id, PydanticObjectId) and not existing_job.area_id:
            existing_job.area_id = location_id
        job_handle = JobHandle(existing_job)
        await job_handle.update(
            status="running",
            stage="initializing",
            progress=0,
            message="Starting optimal route generation...",
            started_at=existing_job.started_at or datetime.now(UTC),
        )
    else:
        job_handle = await create_job(
            "optimal_route",
            task_id=task_id,
            area_id=location_id if isinstance(location_id, PydanticObjectId) else None,
            location=location_id_str,
            status="running",
            stage="initializing",
            progress=0.0,
            message="Starting optimal route generation...",
            started_at=datetime.now(UTC),
        )

    async def update_progress(
        stage: str,
        progress: int,
        message: str,
        metrics: dict[str, Any] | None = None,
    ) -> None:
        await job_handle.update(
            stage=stage,
            progress=progress,
            message=message,
            status="running",
            metrics=metrics,
        )
        logger.info("Route generation [%s][%d%%]: %s", task_id[:8], progress, message)

    def _raise_value_error(message: str) -> None:
        raise ValueError(message)

    def _purge_cached_area_extracts(area_id_str: str) -> int:
        try:
            from config import get_osm_extracts_path
        except Exception:
            return 0

        extracts_root = (get_osm_extracts_path() or "").strip()
        if not extracts_root:
            return 0

        area_extract_dir = Path(extracts_root) / "coverage" / "areas"
        if not area_extract_dir.exists():
            return 0

        removed = 0
        patterns = (
            f"{area_id_str}.osm.pbf",
            f"{area_id_str}.geojson",
            f"{area_id_str}-v*.osm.pbf",
            f"{area_id_str}-v*.geojson",
        )
        for pattern in patterns:
            for path in area_extract_dir.glob(pattern):
                with contextlib.suppress(OSError):
                    path.unlink()
                    removed += 1
        return removed

    def _is_lonlat_bbox(
        bounds: tuple[float, float, float, float] | list[float] | None,
    ) -> bool:
        if not bounds or len(bounds) != 4:
            return False
        try:
            min_x, min_y, max_x, max_y = (float(bounds[0]), float(bounds[1]), float(bounds[2]), float(bounds[3]))
        except Exception:
            return False
        return (
            -180.0 <= min_x <= 180.0
            and -180.0 <= max_x <= 180.0
            and -90.0 <= min_y <= 90.0
            and -90.0 <= max_y <= 90.0
            and min_x <= max_x
            and min_y <= max_y
        )

    def _bbox_intersects(
        a: tuple[float, float, float, float],
        b: tuple[float, float, float, float],
    ) -> bool:
        return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])

    try:
        await update_progress("initializing", 0, "Starting optimal route generation...")

        # Find coverage area by ID
        # location_id may be str (from background job) or PydanticObjectId
        if isinstance(location_id, str):
            location_id = PydanticObjectId(location_id)

        coverage_area = await CoverageArea.get(location_id)
        if not coverage_area:
            msg = f"Coverage area {location_id} not found"
            _raise_value_error(msg)

        location_name = coverage_area.display_name
        if (
            isinstance(coverage_area.boundary, dict)
            and coverage_area.boundary.get("type") == "Feature"
        ):
            boundary_geom = coverage_area.boundary.get("geometry")
            geojson = coverage_area.boundary
        else:
            boundary_geom = coverage_area.boundary
            geojson = (
                {
                    "type": "Feature",
                    "geometry": coverage_area.boundary,
                    "properties": {},
                }
                if coverage_area.boundary
                else None
            )
        location_info = {
            "id": str(coverage_area.id),
            "display_name": coverage_area.display_name,
            "boundary": coverage_area.boundary,
            "bounding_box": coverage_area.bounding_box,
            "area_version": coverage_area.area_version,
            "geojson": geojson,
        }

        await update_progress(
            "loading_area",
            10,
            f"Loading coverage area: {location_name}",
        )

        # Validate that the coverage area has a valid geometry
        if not boundary_geom:
            bbox = coverage_area.bounding_box
            if not (bbox and len(bbox) == 4):
                msg = "No valid boundary for coverage area"
                _raise_value_error(msg)

        await update_progress(
            "loading_segments",
            20,
            "Loading undriven street segments...",
        )

        # Query Street by area_id, join with CoverageState for status
        # First get all segment IDs that are NOT driven (undriven or not in CoverageState)
        driven_segment_ids = set()
        undriveable_segment_ids = set()

        # CoverageState may omit explicit "undriven" rows; only fetch the
        # non-default statuses to avoid scanning an entire area worth of segments.
        async for state in CoverageState.find(
            {
                "area_id": location_id,
                "status": {"$in": ["driven", "undriveable"]},
            },
        ):
            if state.status == "driven":
                driven_segment_ids.add(state.segment_id)
            elif state.status == "undriveable":
                undriveable_segment_ids.add(state.segment_id)

        # Query streets for this area
        undriven_objs = []
        async for street in Street.find(
            Street.area_id == location_id,
            Street.area_version == coverage_area.area_version,
            limit=MAX_SEGMENTS,
        ):
            # Skip driven or undriveable segments
            if street.segment_id in driven_segment_ids:
                continue
            if street.segment_id in undriveable_segment_ids:
                continue

            # Convert to downstream format for route generation
            undriven_objs.append(
                {
                    "_id": street.id,
                    "geometry": street.geometry,
                    "properties": {
                        "segment_id": street.segment_id,
                        "segment_length": street.length_miles
                        * 5280,  # Convert miles to feet
                        "street_name": street.street_name,
                        "osm_id": street.osm_id,
                    },
                },
            )

        # Convert to list of dicts to match expected structure
        undriven = [
            u if isinstance(u, dict) else u.model_dump(by_alias=True)
            for u in undriven_objs
        ]

        # undriven is already a list from code above

        if not undriven:
            await job_handle.complete("All streets already driven!")
            return {
                "status": "already_complete",
                "message": "All streets already driven!",
            }

        await update_progress(
            "loading_segments",
            30,
            f"Found {len(undriven)} undriven segments to route",
        )

        await update_progress("loading_graph", 40, "Loading street network...")

        graph_path = GRAPH_STORAGE_DIR / f"{location_id}.graphml"

        async def _build_graph_from_extract(progress_message: str) -> None:
            await update_progress(
                "loading_graph",
                42,
                progress_message,
            )

            try:
                # Get the location data for preprocessing
                loc_data = location_info.copy()
                loc_data["_id"] = location_id

                # Ensure storage directory exists
                GRAPH_STORAGE_DIR.mkdir(parents=True, exist_ok=True)

                # Import here to avoid circular import
                from street_coverage.preprocessing import preprocess_streets

                await preprocess_streets(loc_data, task_id)

                await update_progress(
                    "loading_graph",
                    44,
                    "Graph built successfully, loading...",
                )
            except Exception as e:
                logger.exception("Failed to auto-generate graph")
                msg = (
                    f"Failed to build street network from local OSM extract: {e}. "
                    "Ensure OSM_DATA_PATH points to the same OSM extract used by Valhalla/Nominatim."
                )
                _raise_value_error(msg)

        # Auto-generate graph if it doesn't exist (or is obviously empty/corrupt)
        graph_needs_build = not graph_path.exists()
        if not graph_needs_build:
            with contextlib.suppress(OSError):
                if graph_path.stat().st_size <= 0:
                    graph_path.unlink()
                    graph_needs_build = True

        if graph_needs_build:
            await _build_graph_from_extract(
                "Building street network from local OSM extract (one-time setup)...",
            )

        try:
            from core.osmnx_graphml import load_graphml_robust

            G = load_graphml_robust(graph_path)
            # Ensure it's the correct type (OSMnx load_graphml returns MultiDiGraph usually)
            if not isinstance(G, nx.MultiDiGraph):
                G = nx.MultiDiGraph(G)

            await update_progress(
                "loading_graph",
                45,
                f"Loaded network: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges",
            )
        except Exception as e:
            message = str(e).lower()
            looks_corrupt = (
                "no element found" in message
                or "parseerror" in message
                or "not well-formed" in message
            )
            if looks_corrupt:
                logger.warning(
                    "Graph cache appears corrupted for %s (%s). Rebuilding.",
                    location_id,
                    e,
                )
                with contextlib.suppress(OSError):
                    graph_path.unlink()

                await _build_graph_from_extract(
                    "Detected corrupted graph cache, rebuilding street network...",
                )
                try:
                    from core.osmnx_graphml import load_graphml_robust

                    G = load_graphml_robust(graph_path)
                    if not isinstance(G, nx.MultiDiGraph):
                        G = nx.MultiDiGraph(G)
                    await update_progress(
                        "loading_graph",
                        45,
                        f"Loaded network: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges",
                    )
                except Exception as rebuild_error:
                    logger.exception("Failed to load graph after rebuilding cache")
                    msg = f"Failed to load street network: {rebuild_error}"
                    _raise_value_error(msg)
            else:
                logger.exception("Failed to load graph from disk")
                msg = f"Failed to load street network: {e}"
                _raise_value_error(msg)

        graph_bbox: tuple[float, float, float, float] | None = None
        min_x = float("inf")
        min_y = float("inf")
        max_x = float("-inf")
        max_y = float("-inf")
        for _, node_data in G.nodes(data=True):
            try:
                x = float(node_data.get("x"))
                y = float(node_data.get("y"))
            except Exception:
                continue
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)

        if min_x != float("inf") and min_y != float("inf"):
            graph_bbox = (min_x, min_y, max_x, max_y)

        area_bbox = (
            tuple(float(v) for v in coverage_area.bounding_box)
            if coverage_area.bounding_box and len(coverage_area.bounding_box) == 4
            else None
        )
        if (
            graph_bbox
            and area_bbox
            and _is_lonlat_bbox(graph_bbox)
            and _is_lonlat_bbox(area_bbox)
            and not _bbox_intersects(graph_bbox, area_bbox)
        ):
            msg = (
                "Street network does not overlap this coverage area. "
                f"graph_bbox={graph_bbox}, area_bbox={area_bbox}. "
                "Rebuild map data for this area and ensure the local OSM extract covers it."
            )
            _raise_value_error(msg)

        total_segments = len(undriven)
        await update_progress(
            "mapping_segments",
            50,
            "Mapping segments (Phase 1: OSM ID match)...",
            metrics={
                "total_segments": total_segments,
                "processed_segments": 0,
                "osm_matched": 0,
                "unmatched_segments": total_segments,
                "skipped_segments": 0,
                "mapped_segments": 0,
            },
        )

        required_reqs: dict[ReqId, list[EdgeRef]] = {}
        req_segment_counts: dict[ReqId, int] = {}
        mapped_segments = 0
        skipped_invalid_geometry = 0
        skipped_mapping_distance = 0
        skipped_match_errors = 0

        matching_graph, project_xy = prepare_spatial_matching_graph(G)
        node_xy: dict[int, tuple[float, float]] = {
            n: (
                float(matching_graph.nodes[n]["x"]),
                float(matching_graph.nodes[n]["y"]),
            )
            for n in matching_graph.nodes
            if "x" in matching_graph.nodes[n] and "y" in matching_graph.nodes[n]
        }
        osmid_index = build_osmid_index(matching_graph)
        edge_line_cache: dict[EdgeRef, LineString] = {}

        # Pre-process segments to extract necessary data for parallel execution
        # We need geometry and OSM ID for each segment
        seg_data_list = []
        for i, seg in enumerate(undriven):
            geom = seg.get("geometry", {})
            coords = geom.get("coordinates", [])
            if not coords or len(coords) < 2:
                skipped_invalid_geometry += 1
                seg_data_list.append(None)
                continue

            projected_coords = project_linestring_coords(coords, project_xy)
            if not projected_coords:
                skipped_match_errors += 1
                seg_data_list.append(None)
                continue

            osmid_raw = seg.get("properties", {}).get("osm_id")
            osmid = None
            if osmid_raw is not None:
                with contextlib.suppress(Exception):
                    osmid = int(osmid_raw)

            seg_data_list.append(
                {
                    "coords": coords,
                    "match_coords": projected_coords,
                    "osmid": osmid,
                    "index": i,
                },
            )

        # Phase 1: Try to match by OSM ID in parallel
        # This is CPU/IO bound (Shapely ops release GIL), so threading helps
        unmatched_indices = []

        # Helper function for the thread pool
        def process_segment_osmid(data):
            if data is None:
                return None
            return try_match_osmid(
                matching_graph,
                data["match_coords"],
                data["osmid"],
                osmid_index,
                node_xy=node_xy,
                line_cache=edge_line_cache,
            )

        osm_matched = 0
        total_for_progress = max(1, len(seg_data_list))
        progress_interval = max(25, total_for_progress // 40)
        last_update = time.monotonic()

        configured_workers = os.getenv("ROUTE_MATCH_MAX_WORKERS", "").strip()
        with contextlib.suppress(Exception):
            configured_workers = str(int(configured_workers))
        max_match_workers = int(configured_workers) if configured_workers else 4
        max_match_workers = max(1, min(max_match_workers, 8))

        executor: ThreadPoolExecutor | None = None
        edge_iter = None
        if max_match_workers > 1:
            try:
                executor = ThreadPoolExecutor(
                    max_workers=max_match_workers,
                    thread_name_prefix="route-osmid",
                )
                edge_iter = executor.map(process_segment_osmid, seg_data_list)
            except RuntimeError as thread_err:
                logger.warning(
                    "Thread pool unavailable for OSM matching (%s); falling back to single-threaded mode.",
                    thread_err,
                )
                edge_iter = None

        if edge_iter is None:
            edge_iter = map(process_segment_osmid, seg_data_list)

        for i, edge in enumerate(edge_iter):
                processed_segments = i + 1
                if seg_data_list[i] is None:
                    if (
                        processed_segments == total_for_progress
                        or processed_segments % progress_interval == 0
                        or time.monotonic() - last_update >= 1.0
                    ):
                        progress_pct = 50 + int(
                            8 * processed_segments / total_for_progress,
                        )
                        await update_progress(
                            "mapping_segments",
                            progress_pct,
                            f"Matching segments by OSM ID {processed_segments}/{total_segments}...",
                            metrics={
                                "total_segments": total_segments,
                                "processed_segments": processed_segments,
                                "osm_matched": osm_matched,
                                "unmatched_segments": len(unmatched_indices),
                                "skipped_segments": (
                                    skipped_invalid_geometry
                                    + skipped_match_errors
                                    + skipped_mapping_distance
                                ),
                                "skipped_invalid_geometry": skipped_invalid_geometry,
                                "skipped_mapping_distance": skipped_mapping_distance,
                                "skipped_match_errors": skipped_match_errors,
                                "mapped_segments": osm_matched,
                            },
                        )
                        last_update = time.monotonic()
                    continue

                if edge:
                    rid, options = make_req_id(G, edge)
                    if rid not in required_reqs:
                        required_reqs[rid] = options
                        req_segment_counts[rid] = 1
                    else:
                        req_segment_counts[rid] += 1
                    mapped_segments += 1
                    osm_matched += 1
                else:
                    unmatched_indices.append(i)

                if (
                    processed_segments == total_for_progress
                    or processed_segments % progress_interval == 0
                    or time.monotonic() - last_update >= 1.0
                ):
                    progress_pct = 50 + int(8 * processed_segments / total_for_progress)
                    await update_progress(
                        "mapping_segments",
                        progress_pct,
                        f"Matching segments by OSM ID {processed_segments}/{total_segments}...",
                        metrics={
                            "total_segments": total_segments,
                            "processed_segments": processed_segments,
                            "osm_matched": osm_matched,
                            "unmatched_segments": len(unmatched_indices),
                            "skipped_segments": (
                                skipped_invalid_geometry
                                + skipped_match_errors
                                + skipped_mapping_distance
                            ),
                            "skipped_invalid_geometry": skipped_invalid_geometry,
                            "skipped_mapping_distance": skipped_mapping_distance,
                            "skipped_match_errors": skipped_match_errors,
                            "mapped_segments": osm_matched,
                        },
                    )
                    last_update = time.monotonic()

        if executor is not None:
            executor.shutdown(wait=True)

        await update_progress(
            "mapping_segments",
            60,
            f"OSM ID match complete. {len(unmatched_indices)} segments remain unmatched.",
            metrics={
                "total_segments": total_segments,
                "processed_segments": total_segments,
                "osm_matched": osm_matched,
                "unmatched_segments": len(unmatched_indices),
                "skipped_segments": (
                    skipped_invalid_geometry
                    + skipped_match_errors
                    + skipped_mapping_distance
                ),
                "skipped_invalid_geometry": skipped_invalid_geometry,
                "skipped_mapping_distance": skipped_mapping_distance,
                "skipped_match_errors": skipped_match_errors,
                "mapped_segments": osm_matched,
            },
        )

        unmatched_total = len(unmatched_indices)
        skipped_mapping_distance += unmatched_total

        if not required_reqs:
            mapping_summary = (
                f"loaded_segments={total_segments}, "
                f"invalid_geometry={skipped_invalid_geometry}, "
                f"match_errors={skipped_match_errors}, "
                f"unmatched_segments={skipped_mapping_distance}, "
                f"graph_nodes={G.number_of_nodes()}, "
                f"graph_edges={G.number_of_edges()}"
            )
            if not mapping_retry_attempted:
                removed_extracts = _purge_cached_area_extracts(location_id_str)
                with contextlib.suppress(OSError):
                    graph_path.unlink()
                await update_progress(
                    "loading_graph",
                    44,
                    "No segments matched. Refreshing graph/extract cache and retrying once...",
                )
                logger.warning(
                    "Retrying optimal-route mapping once for area %s after zero matches. Purged graph cache and %d area extract file(s).",
                    location_id_str,
                    removed_extracts,
                )
                return await _generate_optimal_route_with_progress_impl(
                    location_id=location_id,
                    task_id=task_id,
                    start_coords=start_coords,
                    mapping_retry_attempted=True,
                )
            if skipped_invalid_geometry + skipped_match_errors >= total_segments:
                msg = (
                    "Could not map any segments to street network because all loaded "
                    f"segments failed geometry preparation ({mapping_summary})."
                )
            else:
                msg = (
                    "Could not map any segments to street network. "
                    f"{mapping_summary}. "
                    "This usually means the local street network graph does not overlap "
                    "the selected coverage area or the graph cache is stale."
                )
            _raise_value_error(msg)

        await update_progress(
            "mapping_segments",
            65,
            (
                f"Mapped {len(required_reqs)} required edges "
                f"(invalid geometry: {skipped_invalid_geometry}, "
                f"unmatched: {skipped_mapping_distance}, "
                f"match errors: {skipped_match_errors}; "
                "note MAX_SEGMENTS may truncate)."
            ),
            metrics={
                "total_segments": total_segments,
                "processed_segments": total_segments,
                "osm_matched": osm_matched,
                "unmatched_segments": unmatched_total,
                "skipped_segments": (
                    skipped_invalid_geometry
                    + skipped_match_errors
                    + skipped_mapping_distance
                ),
                "skipped_invalid_geometry": skipped_invalid_geometry,
                "skipped_mapping_distance": skipped_mapping_distance,
                "skipped_match_errors": skipped_match_errors,
                "mapped_segments": osm_matched,
            },
        )

        # Determine start node
        start_node_id: int | None = None
        if start_coords:
            with contextlib.suppress(Exception):
                start_node_id = int(
                    _get_osmnx().distance.nearest_nodes(
                        G,
                        start_coords[0],
                        start_coords[1],
                    ),
                )

        # NOTE: We no longer pre-bridge disconnected clusters with OSM downloads.
        # Instead, we generate the route and fill gaps afterwards with Valhalla routes.
        # This is much faster and simpler.
        await update_progress(
            "routing",
            75,
            f"Computing optimal route for {len(required_reqs)} required edges...",
        )

        try:
            route_coords, stats, _ = solve_greedy_route(
                G,
                required_reqs,
                start_node_id,
                req_segment_counts=req_segment_counts,
            )
        except Exception as e:
            logger.exception("Greedy solver failed")
            msg = f"Route solver failed: {e}"
            _raise_value_error(msg)

        if not route_coords:
            msg = "Failed to generate route coordinates"
            _raise_value_error(msg)

        # Fill gaps in the route with Valhalla driving directions
        await update_progress(
            "filling_gaps",
            85,
            "Filling route gaps with driving routes...",
        )

        try:

            async def gap_progress(_stage: str, pct: int, msg: str) -> None:
                # Map gap-fill progress (0-100) to overall progress (85-95)
                overall_pct = 85 + int(pct * 0.1)
                await update_progress("filling_gaps", overall_pct, msg)

            route_coords, gap_fill_stats = await fill_route_gaps(
                route_coords,
                max_gap_ft=1000.0,  # Fill gaps > 1000ft (~0.2 miles)
                progress_callback=gap_progress,
            )
        except Exception as e:
            gap_fill_stats = None
            logger.warning("Gap-filling failed (continuing with gaps): %s", e)

        # Fold gap-bridge distance into stats so validation matches final geometry.
        if gap_fill_stats is not None and gap_fill_stats.bridge_distance_m:
            bridge_m = float(gap_fill_stats.bridge_distance_m or 0.0)
            stats["gap_bridge_distance_m"] = bridge_m
            stats["deadhead_distance"] = (
                float(stats.get("deadhead_distance", 0.0)) + bridge_m
            )
            stats["total_distance"] = float(stats.get("total_distance", 0.0)) + bridge_m
            total_m = float(stats.get("total_distance", 0.0))
            dead_m = float(stats.get("deadhead_distance", 0.0))
            stats["deadhead_percentage"] = (
                (dead_m / total_m * 100.0) if total_m > 0 else 0.0
            )
            req_all_m = float(stats.get("required_distance", 0.0))
            req_done_m = float(
                stats.get(
                    "required_distance_completed",
                    stats.get("service_distance", 0.0),
                ),
            )
            stats["deadhead_ratio_all"] = (
                (total_m / req_all_m) if req_all_m > 0 else 0.0
            )
            stats["deadhead_ratio_completed"] = (
                (total_m / req_done_m) if req_done_m > 0 else 0.0
            )

        await update_progress("finalizing", 95, "Finalizing route geometry...")

        errors, warnings, validation_details = validate_route(
            route_coords,
            stats,
            mapped_segments,
            len(undriven),
            eligible_segments=max(0, total_segments - skipped_invalid_geometry),
            skipped_invalid_geometry=skipped_invalid_geometry,
            skipped_mapping_distance=skipped_mapping_distance,
            gap_fill_stats=gap_fill_stats,
        )
        if errors:
            msg = f"Validation failed: {'; '.join(errors)}"
            _raise_value_error(msg)

        logger.info("Route generation finished. Updating DB status to completed.")
        try:
            await job_handle.complete("Route generation complete!")
        except Exception:
            logger.exception("Final job progress update failed")

        return {
            "status": "success",
            "coordinates": route_coords,
            "total_distance_m": stats["total_distance"],
            "required_distance_m": stats["required_distance"],
            "required_distance_completed_m": stats.get(
                "required_distance_completed",
                stats.get("service_distance", 0.0),
            ),
            "deadhead_distance_m": stats["deadhead_distance"],
            "deadhead_percentage": stats["deadhead_percentage"],
            # More honest counts:
            "undriven_segments_loaded": len(undriven),
            "segment_count": len(undriven),
            "mapped_segments": mapped_segments,
            "eligible_segments": max(0, total_segments - skipped_invalid_geometry),
            "skipped_invalid_geometry_segments": skipped_invalid_geometry,
            "unmapped_segments": skipped_mapping_distance,
            "valhalla_trace_attempted": valhalla_trace_attempted,
            "valhalla_trace_matched": valhalla_trace_matched,
            "segment_coverage_ratio": validation_details.get("coverage_ratio", 1.0),
            "max_gap_m": validation_details.get("max_gap_m", 0.0),
            "max_gap_ft": validation_details.get("max_gap_ft", 0.0),
            "deadhead_ratio": validation_details.get("deadhead_ratio_completed", 0.0),
            "deadhead_ratio_all": validation_details.get("deadhead_ratio_all", 0.0),
            "deadhead_ratio_eval": validation_details.get("deadhead_ratio_eval", 0.0),
            "required_edge_count": int(stats["required_reqs"]),
            "completed_required_edge_count": int(stats.get("completed_reqs", 0.0)),
            "skipped_required_edge_count": int(stats.get("skipped_disconnected", 0.0)),
            "iterations": int(stats["iterations"]),
            "validation_warnings": warnings,
            "validation_details": validation_details,
            "generated_at": datetime.now(UTC).isoformat(),
            "location_name": location_name,
        }

    except Exception as e:
        error_msg = str(e)
        # Check if this is a gap validation error and if we're missing the token
        if "gap between points" in error_msg:
            detailed_msg = (
                f"Route generation failed: {error_msg} "
                "This large gap likely indicates the street network is disconnected. "
                "Ensure Valhalla routing is reachable so gap-filling can bridge "
                "disconnected areas."
            )
            await job_handle.fail(error_msg, message=detailed_msg)
            # Re-raise with the enhanced message so it propagates clearly if needed,
            # though tracker.fail should handle the UI notification.
            # We'll re-raise a clean ValueError to avoid confusing tracebacks if this is caught upstream
            raise ValueError(detailed_msg) from e

        await job_handle.fail(error_msg, message=f"Route generation failed: {e}")
        raise


async def generate_optimal_route(
    location_id: str,
    start_coords: tuple[float, float] | None = None,
) -> dict[str, Any]:
    import uuid

    task_id = f"manual_{uuid.uuid4()}"
    return await generate_optimal_route_with_progress(
        location_id,
        task_id,
        start_coords,
    )


async def save_optimal_route(
    location_id: str | PydanticObjectId,
    route_result: dict[str, Any],
) -> None:
    if route_result.get("status") != "success":
        return

    try:
        route_doc = dict(route_result)
        # location_id may be str (from background job) or PydanticObjectId
        if isinstance(location_id, str):
            location_id = PydanticObjectId(location_id)

        coverage_area = await CoverageArea.get(location_id)
        if not coverage_area:
            logger.warning(
                "Could not find coverage area for %s to save route",
                location_id,
            )
            return

        await coverage_area.update(
            {
                "$set": {
                    "optimal_route": route_doc,
                    "optimal_route_generated_at": datetime.now(UTC),
                },
            },
        )
        logger.info("Saved optimal route to CoverageArea %s", location_id)

    except Exception:
        logger.exception("Failed to save optimal route")
