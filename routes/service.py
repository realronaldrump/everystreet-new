import contextlib
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import networkx as nx
import osmnx as ox
from beanie import PydanticObjectId

from coverage.models import CoverageArea, CoverageState, Street
from db.models import OptimalRouteProgress
from progress_tracker import ProgressTracker

from .constants import GRAPH_STORAGE_DIR, MAX_SEGMENTS
from .core import make_req_id, solve_greedy_route
from .gaps import fill_route_gaps
from .geometry import _segment_midpoint
from .graph import build_osmid_index, try_match_osmid
from .validation import validate_route

if TYPE_CHECKING:
    from shapely.geometry import LineString

    from .types import EdgeRef, ReqId

logger = logging.getLogger(__name__)


async def generate_optimal_route_with_progress(
    location_id: str,
    task_id: str,
    start_coords: tuple[float, float] | None = None,  # (lon, lat)
) -> dict[str, Any]:
    # Create progress tracker for optimal route progress collection
    # ProgressTracker expects a Beanie model
    tracker = ProgressTracker(
        task_id,
        OptimalRouteProgress,
        location_id=location_id,
        use_task_id_field=True,
    )

    async def update_progress(
        stage: str,
        progress: int,
        message: str,
        metrics: dict[str, Any] | None = None,
    ) -> None:
        await tracker.update(
            stage,
            progress,
            message,
            status="running",
            metrics=metrics,
        )
        logger.info("Route generation [%s][%d%%]: %s", task_id[:8], progress, message)

    try:
        await update_progress("initializing", 0, "Starting optimal route generation...")

        # Find coverage area by ID
        # location_id may be str (from Celery) or PydanticObjectId
        if isinstance(location_id, str):
            location_id = PydanticObjectId(location_id)

        coverage_area = await CoverageArea.get(location_id)
        if not coverage_area:
            msg = f"Coverage area {location_id} not found"
            raise ValueError(msg)

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
                raise ValueError(msg)

        await update_progress(
            "loading_segments",
            20,
            "Loading undriven street segments...",
        )

        # Query Street by area_id, join with CoverageState for status
        # First get all segment IDs that are NOT driven (undriven or not in CoverageState)
        driven_segment_ids = set()
        undriveable_segment_ids = set()

        async for state in CoverageState.find(CoverageState.area_id == location_id):
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
            await tracker.complete("All streets already driven!")
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

        # Auto-generate graph if it doesn't exist
        if not graph_path.exists():
            await update_progress(
                "loading_graph",
                42,
                "Downloading street network from OpenStreetMap (one-time setup)...",
            )

            try:
                # Get the location data for preprocessing
                loc_data = location_info.copy()
                loc_data["_id"] = location_id

                # Ensure storage directory exists
                GRAPH_STORAGE_DIR.mkdir(parents=True, exist_ok=True)

                # Import here to avoid circular import
                from preprocess_streets import preprocess_streets

                await preprocess_streets(loc_data, task_id)

                await update_progress(
                    "loading_graph",
                    44,
                    "Graph downloaded successfully, loading...",
                )
            except Exception as e:
                logger.exception("Failed to auto-generate graph: %s", e)
                msg = (
                    f"Failed to download street network from OpenStreetMap: {e}. "
                    f"This may be due to rate limiting or network issues. Please try again later."
                )
                raise ValueError(
                    msg,
                )

        try:
            G = ox.load_graphml(graph_path)
            # Ensure it's the correct type (OSMnx load_graphml returns MultiDiGraph usually)
            if not isinstance(G, nx.MultiDiGraph):
                G = nx.MultiDiGraph(G)

            await update_progress(
                "loading_graph",
                45,
                f"Loaded network: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges",
            )
        except Exception as e:
            logger.exception("Failed to load graph from disk: %s", e)
            msg = f"Failed to load street network: {e}"
            raise ValueError(msg)

        total_segments = len(undriven)
        await update_progress(
            "mapping_segments",
            50,
            "Mapping segments (Phase 1: OSM ID match)...",
            metrics={
                "total_segments": total_segments,
                "processed_segments": 0,
                "osm_matched": 0,
                "fallback_total": 0,
                "fallback_matched": 0,
                "skipped_segments": 0,
                "mapped_segments": 0,
            },
        )

        required_reqs: dict[ReqId, list[EdgeRef]] = {}
        req_segment_counts: dict[ReqId, int] = {}
        skipped = 0
        mapped_segments = 0

        node_xy: dict[int, tuple[float, float]] = {
            n: (float(G.nodes[n]["x"]), float(G.nodes[n]["y"]))
            for n in G.nodes
            if "x" in G.nodes[n] and "y" in G.nodes[n]
        }
        osmid_index = build_osmid_index(G)
        edge_line_cache: dict[EdgeRef, LineString] = {}

        # Pre-process segments to extract necessary data for parallel execution
        # We need geometry and OSM ID for each segment
        seg_data_list = []
        for i, seg in enumerate(undriven):
            geom = seg.get("geometry", {})
            coords = geom.get("coordinates", [])
            if not coords or len(coords) < 2:
                skipped += 1
                seg_data_list.append(None)
                continue

            osmid_raw = seg.get("properties", {}).get("osm_id")
            osmid = None
            if osmid_raw is not None:
                with contextlib.suppress(Exception):
                    osmid = int(osmid_raw)

            seg_data_list.append({"coords": coords, "osmid": osmid, "index": i})

        # Phase 1: Try to match by OSM ID in parallel
        # This is CPU/IO bound (Shapely ops release GIL), so threading helps
        unmatched_indices = []

        # Helper function for the thread pool
        def process_segment_osmid(data):
            if data is None:
                return None
            return try_match_osmid(
                G,
                data["coords"],
                data["osmid"],
                osmid_index,
                node_xy=node_xy,
                line_cache=edge_line_cache,
            )

        osm_matched = 0
        fallback_matched = 0
        with ThreadPoolExecutor() as executor:
            total_for_progress = max(1, len(seg_data_list))
            progress_interval = max(25, total_for_progress // 40)
            last_update = time.monotonic()

            for i, edge in enumerate(
                executor.map(process_segment_osmid, seg_data_list),
            ):
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
                                "fallback_total": 0,
                                "fallback_matched": fallback_matched,
                                "skipped_segments": skipped,
                                "mapped_segments": osm_matched + fallback_matched,
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
                            "fallback_total": 0,
                            "fallback_matched": fallback_matched,
                            "skipped_segments": skipped,
                            "mapped_segments": osm_matched + fallback_matched,
                        },
                    )
                    last_update = time.monotonic()

        await update_progress(
            "mapping_segments",
            60,
            f"OSM ID match complete. {len(unmatched_indices)} segments need spatial fallback...",
            metrics={
                "total_segments": total_segments,
                "processed_segments": total_segments,
                "osm_matched": osm_matched,
                "fallback_total": len(unmatched_indices),
                "fallback_matched": fallback_matched,
                "skipped_segments": skipped,
                "mapped_segments": osm_matched + fallback_matched,
            },
        )

        # Phase 2: Batch spatial lookup for remaining segments
        # Extract midpoints for all unmatched segments
        X = []
        Y = []
        valid_unmatched_indices = []

        for idx in unmatched_indices:
            data = seg_data_list[idx]
            mid = _segment_midpoint(data["coords"])
            if mid:
                X.append(mid[0])
                Y.append(mid[1])
                valid_unmatched_indices.append(idx)
            else:
                skipped += 1

        fallback_total = len(valid_unmatched_indices)
        if X:
            await update_progress(
                "mapping_segments",
                62,
                f"Running spatial fallback for {fallback_total} segments...",
                metrics={
                    "total_segments": total_segments,
                    "processed_segments": total_segments,
                    "osm_matched": osm_matched,
                    "fallback_total": fallback_total,
                    "fallback_matched": fallback_matched,
                    "skipped_segments": skipped,
                    "mapped_segments": osm_matched + fallback_matched,
                },
            )
            try:
                # Vectorized nearest edge lookup
                nearest_edges = ox.distance.nearest_edges(G, X, Y)
                last_update = time.monotonic()
                progress_interval = max(10, max(1, fallback_total) // 25)
                for i, (u, v, k) in enumerate(nearest_edges, start=1):
                    edge = (int(u), int(v), int(k))
                    rid, options = make_req_id(G, edge)
                    if rid not in required_reqs:
                        required_reqs[rid] = options
                        req_segment_counts[rid] = 1
                    else:
                        req_segment_counts[rid] += 1
                    mapped_segments += 1
                    fallback_matched += 1

                    if (
                        i == fallback_total
                        or i % progress_interval == 0
                        or time.monotonic() - last_update >= 1.0
                    ):
                        progress_pct = 62 + int(3 * i / max(1, fallback_total))
                        await update_progress(
                            "mapping_segments",
                            progress_pct,
                            f"Spatial fallback {i}/{fallback_total}...",
                            metrics={
                                "total_segments": total_segments,
                                "processed_segments": total_segments,
                                "osm_matched": osm_matched,
                                "fallback_total": fallback_total,
                                "fallback_matched": fallback_matched,
                                "skipped_segments": skipped,
                                "mapped_segments": osm_matched + fallback_matched,
                            },
                        )
                        last_update = time.monotonic()
            except Exception as e:
                logger.exception("Batch spatial lookup failed: %s", e)
                # Fallback to individual lookup if batch fails (unlikely)
                last_update = time.monotonic()
                progress_interval = max(10, max(1, fallback_total) // 25)
                for i, _idx in enumerate(valid_unmatched_indices, start=1):
                    try:
                        u, v, k = ox.distance.nearest_edges(G, X[i], Y[i])
                        edge = (int(u), int(v), int(k))
                        rid, options = make_req_id(G, edge)
                        if rid not in required_reqs:
                            required_reqs[rid] = options
                            req_segment_counts[rid] = 1
                        else:
                            req_segment_counts[rid] += 1
                        mapped_segments += 1
                        fallback_matched += 1
                    except Exception:
                        skipped += 1

                    if (
                        i == fallback_total
                        or i % progress_interval == 0
                        or time.monotonic() - last_update >= 1.0
                    ):
                        progress_pct = 62 + int(3 * i / max(1, fallback_total))
                        await update_progress(
                            "mapping_segments",
                            progress_pct,
                            f"Spatial fallback {i}/{fallback_total}...",
                            metrics={
                                "total_segments": total_segments,
                                "processed_segments": total_segments,
                                "osm_matched": osm_matched,
                                "fallback_total": fallback_total,
                                "fallback_matched": fallback_matched,
                                "skipped_segments": skipped,
                                "mapped_segments": osm_matched + fallback_matched,
                            },
                        )
                        last_update = time.monotonic()

        if not required_reqs:
            msg = "Could not map any segments to street network"
            raise ValueError(msg)

        await update_progress(
            "mapping_segments",
            65,
            f"Mapped {len(required_reqs)} required edges ({skipped} segments skipped; note MAX_SEGMENTS may truncate).",
            metrics={
                "total_segments": total_segments,
                "processed_segments": total_segments,
                "osm_matched": osm_matched,
                "fallback_total": fallback_total,
                "fallback_matched": fallback_matched,
                "skipped_segments": skipped,
                "mapped_segments": osm_matched + fallback_matched,
            },
        )

        # Determine start node
        start_node_id: int | None = None
        if start_coords:
            with contextlib.suppress(Exception):
                start_node_id = int(
                    ox.distance.nearest_nodes(G, start_coords[0], start_coords[1]),
                )

        # NOTE: We no longer pre-bridge disconnected clusters with OSM downloads.
        # Instead, we generate the route and fill gaps afterwards with Mapbox routes.
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
            logger.error("Greedy solver failed: %s", e, exc_info=True)
            msg = f"Route solver failed: {e}"
            raise ValueError(msg)

        if not route_coords:
            msg = "Failed to generate route coordinates"
            raise ValueError(msg)

        # Fill gaps in the route with Mapbox driving directions
        await update_progress(
            "filling_gaps",
            85,
            "Filling route gaps with driving routes...",
        )

        try:
            from config import get_app_settings

            settings = await get_app_settings()
            if settings.get("mapbox_access_token"):

                async def gap_progress(_stage: str, pct: int, msg: str) -> None:
                    # Map gap-fill progress (0-100) to overall progress (85-95)
                    overall_pct = 85 + int(pct * 0.1)
                    await update_progress("filling_gaps", overall_pct, msg)

                route_coords = await fill_route_gaps(
                    route_coords,
                    max_gap_ft=1000.0,  # Fill gaps > 1000ft (~0.2 miles)
                    progress_callback=gap_progress,
                )
            else:
                logger.warning("Mapbox token not configured; skipping gap-filling")
        except Exception as e:
            logger.warning("Gap-filling failed (continuing with gaps): %s", e)

        await update_progress("finalizing", 95, "Finalizing route geometry...")

        errors, warnings, validation_details = validate_route(
            route_coords,
            stats,
            mapped_segments,
            len(undriven),
        )
        if errors:
            msg = f"Validation failed: {'; '.join(errors)}"
            raise ValueError(msg)

        logger.info("Route generation finished. Updating DB status to completed.")
        try:
            await tracker.complete("Route generation complete!")
        except Exception as update_err:
            logger.exception("Final DB progress update failed: %s", update_err)
            # Use Beanie update
            await OptimalRouteProgress.find_one(
                OptimalRouteProgress.task_id == task_id,
            ).update(
                {
                    "$set": {
                        "status": "completed",
                        "progress": 100,
                        "stage": "complete",
                        "completed_at": datetime.now(UTC),
                    },
                },
            )

        return {
            "status": "success",
            "coordinates": route_coords,
            "total_distance_m": stats["total_distance"],
            "required_distance_m": stats["required_distance"],
            "deadhead_distance_m": stats["deadhead_distance"],
            "deadhead_percentage": stats["deadhead_percentage"],
            # More honest counts:
            "undriven_segments_loaded": len(undriven),
            "segment_count": len(undriven),
            "mapped_segments": mapped_segments,
            "segment_coverage_ratio": validation_details.get("coverage_ratio", 1.0),
            "max_gap_m": validation_details.get("max_gap_m", 0.0),
            "deadhead_ratio": validation_details.get("deadhead_ratio", 0.0),
            "required_edge_count": int(stats["required_reqs"]),
            "iterations": int(stats["iterations"]),
            "validation_warnings": warnings,
            "generated_at": datetime.now(UTC).isoformat(),
            "location_name": location_name,
        }

    except Exception as e:
        error_msg = str(e)
        # Check if this is a gap validation error and if we're missing the token
        if "gap between points" in error_msg:
            from config import get_app_settings

            settings = await get_app_settings()
            if not settings.get("mapbox_access_token"):
                # Enhance the error message
                detailed_msg = (
                    f"Route generation failed: {error_msg} "
                    "This large gap likely indicates the street network is disconnected. "
                    "To fix this, please configure the Mapbox Access Token in App Settings "
                    "to allow bridging between disconnected areas."
                )
                await tracker.fail(error_msg, detailed_msg)
                # Re-raise with the enhanced message so it propagates clearly if needed,
                # though tracker.fail should handle the UI notification.
                # We'll re-raise a clean ValueError to avoid confusing tracebacks if this is caught upstream
                raise ValueError(detailed_msg) from e

        await tracker.fail(error_msg, f"Route generation failed: {e}")
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
        # location_id may be str (from Celery) or PydanticObjectId
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

    except Exception as e:
        logger.exception("Failed to save optimal route: %s", e)
