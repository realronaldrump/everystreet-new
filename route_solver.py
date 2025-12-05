"""Optimal route solver using Rural Postman Problem algorithm.

This module implements the Rural Postman Problem (RPP) solver to find the
optimal route to complete all undriven streets in a coverage area. The RPP
finds the minimum-distance circuit that covers all required edges (undriven
streets) while optionally using other edges (driven streets) for deadheading.

The algorithm:
1. Build a graph with required edges (undriven) and optional edges (driven)
2. Find odd-degree nodes in the required-edge subgraph
3. Compute minimum-weight matching on odd nodes using shortest paths
4. Augment the graph with matching edges to make it Eulerian
5. Find an Eulerian circuit through the augmented graph
"""

import logging
from datetime import UTC, datetime
from typing import Any

import networkx as nx
import osmnx as ox
from bson import ObjectId
from shapely.geometry import box, shape

from db import (
    coverage_metadata_collection,
    find_one_with_retry,
    optimal_route_progress_collection,
    streets_collection,
    update_one_with_retry,
)

logger = logging.getLogger(__name__)

# Maximum segments to process (for performance)
MAX_SEGMENTS = 5000


def _solve_rpp(
    G: nx.Graph,
    required_edges: set[tuple[int, int]],
    start_node: int | None = None,
) -> tuple[list[int], dict[str, float]]:
    """Solve the Rural Postman Problem on a graph.

    Args:
        G: NetworkX graph with 'length' edge attributes
        required_edges: Set of (u, v) tuples that must be traversed
        start_node: Optional starting node for the circuit

    Returns:
        Tuple of (node_circuit, stats_dict)
    """
    # Build subgraph of only required edges
    required_graph = nx.Graph()
    for u, v in required_edges:
        if G.has_edge(u, v):
            required_graph.add_edge(u, v, **G.edges[u, v])

    if required_graph.number_of_edges() == 0:
        return [], {"total_distance": 0, "required_distance": 0, "deadhead_distance": 0}

    # Find nodes with odd degree in the required subgraph
    odd_nodes = [n for n in required_graph.nodes() if required_graph.degree(n) % 2 == 1]

    logger.info(
        "RPP: %d required edges, %d odd-degree nodes",
        required_graph.number_of_edges(),
        len(odd_nodes),
    )

    # Create augmented graph starting with required edges
    augmented = nx.MultiGraph()
    for u, v, data in required_graph.edges(data=True):
        augmented.add_edge(u, v, length=data.get("length", 100), required=True)

    total_required_distance = sum(
        data.get("length", 100) for _, _, data in required_graph.edges(data=True)
    )

    # If there are odd-degree nodes, we need to add edges to make it Eulerian
    deadhead_distance = 0
    if odd_nodes:
        # Compute shortest paths between all pairs of odd nodes using full graph
        # (including optional edges for deadheading)
        odd_pairs_distances = {}
        odd_pairs_paths = {}

        for i, u in enumerate(odd_nodes):
            for v in odd_nodes[i + 1 :]:
                try:
                    path = nx.shortest_path(G, u, v, weight="length")
                    dist = nx.shortest_path_length(G, u, v, weight="length")
                    odd_pairs_distances[(u, v)] = dist
                    odd_pairs_paths[(u, v)] = path
                except nx.NetworkXNoPath:
                    # If no path exists, use a very large distance
                    odd_pairs_distances[(u, v)] = float("inf")
                    odd_pairs_paths[(u, v)] = []

        # Find minimum weight matching on odd nodes
        # Create a complete graph on odd nodes with shortest path distances
        matching_graph = nx.Graph()
        for i, u in enumerate(odd_nodes):
            for v in odd_nodes[i + 1 :]:
                dist = odd_pairs_distances.get((u, v), float("inf"))
                if dist < float("inf"):
                    matching_graph.add_edge(u, v, weight=dist)

        if matching_graph.number_of_edges() > 0:
            # Use NetworkX's min_weight_matching
            try:
                matching = nx.min_weight_matching(matching_graph)
            except Exception as e:
                logger.warning("Matching failed: %s, using greedy approach", e)
                matching = set()
                remaining = set(odd_nodes)
                while len(remaining) >= 2:
                    remaining_list = list(remaining)
                    u = remaining_list[0]
                    best_v = None
                    best_dist = float("inf")
                    for v in remaining_list[1:]:
                        dist = odd_pairs_distances.get(
                            (min(u, v), max(u, v)),
                            odd_pairs_distances.get(
                                (max(u, v), min(u, v)), float("inf")
                            ),
                        )
                        if dist < best_dist:
                            best_dist = dist
                            best_v = v
                    if best_v:
                        matching.add((u, best_v))
                        remaining.remove(u)
                        remaining.remove(best_v)

            # Add the matching edges (as deadhead paths) to the augmented graph
            for u, v in matching:
                key = (min(u, v), max(u, v))
                path = odd_pairs_paths.get(key, odd_pairs_paths.get((v, u), []))
                if path:
                    path_distance = odd_pairs_distances.get(
                        key, odd_pairs_distances.get((v, u), 0)
                    )
                    deadhead_distance += path_distance
                    # Add each edge in the path
                    for j in range(len(path) - 1):
                        p_u, p_v = path[j], path[j + 1]
                        edge_len = G.edges[p_u, p_v].get("length", 100)
                        augmented.add_edge(p_u, p_v, length=edge_len, required=False)

    # Now find Eulerian circuit
    if not nx.is_eulerian(augmented):
        # If still not Eulerian, the graph might be disconnected
        # Find the largest connected component
        components = list(nx.connected_components(augmented))
        if len(components) > 1:
            logger.warning(
                "Graph has %d components, using largest with %d nodes",
                len(components),
                max(len(c) for c in components),
            )
            largest = max(components, key=len)
            augmented = augmented.subgraph(largest).copy()

    try:
        if start_node and start_node in augmented.nodes():
            circuit = list(nx.eulerian_circuit(augmented, source=start_node))
        else:
            circuit = list(nx.eulerian_circuit(augmented))
    except nx.NetworkXError as e:
        logger.error("Failed to find Eulerian circuit: %s", e)
        # Fall back to a simple traversal
        circuit = list(augmented.edges())

    # Convert edge circuit to node circuit
    if circuit:
        node_circuit = [circuit[0][0]]
        for u, v in circuit:
            node_circuit.append(v)
    else:
        node_circuit = list(augmented.nodes())

    total_distance = total_required_distance + deadhead_distance

    stats = {
        "total_distance": total_distance,
        "required_distance": total_required_distance,
        "deadhead_distance": deadhead_distance,
        "deadhead_percentage": (
            (deadhead_distance / total_distance * 100) if total_distance > 0 else 0
        ),
        "required_edges": len(required_edges),
        "circuit_nodes": len(node_circuit),
    }

    return node_circuit, stats


async def _update_db_progress(
    task_id: str,
    location_id: str,
    stage: str,
    progress: int,
    message: str,
    status: str = "running",
    error: str | None = None,
) -> None:
    """Update progress in database for SSE streaming."""
    now = datetime.now(UTC)
    update_doc = {
        "$set": {
            "location_id": location_id,
            "stage": stage,
            "progress": progress,
            "message": message,
            "status": status,
            "updated_at": now,
        },
        "$setOnInsert": {
            "task_id": task_id,
            "started_at": now,
        },
    }
    if error:
        update_doc["$set"]["error"] = error
    if status == "completed":
        update_doc["$set"]["completed_at"] = now
    if status == "failed":
        update_doc["$set"]["failed_at"] = now

    await update_one_with_retry(
        optimal_route_progress_collection,
        {"task_id": task_id},
        update_doc,
        upsert=True,
    )


async def generate_optimal_route_with_progress(
    location_id: str,
    task_id: str,
    start_coords: tuple[float, float] | None = None,
) -> dict[str, Any]:
    """Generate optimal route with database-backed progress tracking.

    This version writes progress updates to the database so they can be
    streamed via SSE to the frontend.

    Args:
        location_id: MongoDB ObjectId string for the coverage area
        task_id: Celery task ID for progress tracking
        start_coords: Optional (lon, lat) to specify route start point

    Returns:
        Dict with route_coordinates, stats, and metadata
    """

    async def update_progress(stage: str, progress: int, message: str) -> None:
        await _update_db_progress(task_id, location_id, stage, progress, message)
        logger.info("Route generation [%s][%d%%]: %s", task_id[:8], progress, message)

    try:
        await update_progress("initializing", 0, "Starting optimal route generation...")

        # 1. Load coverage area and geometry
        obj_id = ObjectId(location_id)
        area = await find_one_with_retry(coverage_metadata_collection, {"_id": obj_id})
        if not area:
            raise ValueError(f"Coverage area {location_id} not found")

        location_info = area.get("location", {})
        location_name = location_info.get("display_name", "Unknown")

        await update_progress(
            "loading_area", 10, f"Loading coverage area: {location_name}"
        )

        # Get boundary polygon
        boundary_geom = location_info.get("geojson", {}).get("geometry")
        if boundary_geom:
            polygon = shape(boundary_geom)
        else:
            bbox = location_info.get("boundingbox")
            if bbox and len(bbox) >= 4:
                polygon = box(
                    float(bbox[2]), float(bbox[0]), float(bbox[3]), float(bbox[1])
                )
            else:
                raise ValueError("No valid boundary for coverage area")

        # 2. Get undriven segments
        await update_progress(
            "loading_segments", 20, "Loading undriven street segments..."
        )

        cursor = streets_collection.find(
            {
                "properties.location": location_name,
                "properties.driven": False,
                "properties.undriveable": {"$ne": True},
            },
            {
                "geometry": 1,
                "properties.segment_id": 1,
                "properties.segment_length": 1,
                "properties.street_name": 1,
            },
        ).limit(MAX_SEGMENTS)

        undriven = await cursor.to_list(length=MAX_SEGMENTS)

        if not undriven:
            await _update_db_progress(
                task_id,
                location_id,
                "complete",
                100,
                "All streets already driven!",
                "completed",
            )
            return {
                "status": "already_complete",
                "message": "All streets already driven!",
            }

        await update_progress(
            "loading_segments", 30, f"Found {len(undriven)} undriven segments to route"
        )

        # 3. Fetch OSM street network
        await update_progress("fetching_osm", 40, "Downloading OSM street network...")

        try:
            G = ox.graph_from_polygon(
                polygon,
                network_type="drive",
                simplify=True,
                truncate_by_edge=True,
            )
            G = ox.convert.to_undirected(G)
            await update_progress(
                "fetching_osm",
                45,
                f"Downloaded network: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges",
            )
        except Exception as e:
            logger.error("Failed to download OSM data: %s", e)
            raise ValueError(f"Failed to download street network: {e}")

        await update_progress(
            "mapping_segments", 50, "Mapping segments to street network..."
        )

        # 4. Map segment endpoints to OSM nodes
        required_edges = set()
        segment_to_edge = {}
        skipped = 0
        total_segs = len(undriven)

        for idx, seg in enumerate(undriven):
            if idx % 100 == 0 and idx > 0:
                pct = 50 + int((idx / total_segs) * 10)
                await update_progress(
                    "mapping_segments", pct, f"Mapping segment {idx}/{total_segs}..."
                )

            geom = seg.get("geometry", {})
            coords = geom.get("coordinates", [])
            if not coords or len(coords) < 2:
                skipped += 1
                continue

            seg_id = seg["properties"]["segment_id"]
            start_pt = coords[0]
            end_pt = coords[-1]

            try:
                start_node = ox.distance.nearest_nodes(G, start_pt[0], start_pt[1])
                end_node = ox.distance.nearest_nodes(G, end_pt[0], end_pt[1])

                if start_node == end_node:
                    skipped += 1
                    continue

                edge_key = (min(start_node, end_node), max(start_node, end_node))
                required_edges.add(edge_key)
                segment_to_edge[seg_id] = edge_key
            except Exception:
                skipped += 1
                continue

        if not required_edges:
            raise ValueError("Could not map any segments to street network")

        await update_progress(
            "finding_odd_nodes",
            62,
            f"Analyzing graph: {len(required_edges)} edges, {skipped} skipped",
        )

        # 5. Determine start node
        start_node_id = None
        if start_coords:
            try:
                start_node_id = ox.distance.nearest_nodes(
                    G, start_coords[0], start_coords[1]
                )
            except Exception:
                pass

        await update_progress(
            "computing_matching",
            65,
            f"Computing optimal route for {len(required_edges)} segments...",
        )

        # 6. Solve RPP
        try:
            node_circuit, stats = _solve_rpp(G, required_edges, start_node_id)
        except Exception as e:
            logger.error("RPP solver failed: %s", e, exc_info=True)
            raise ValueError(f"Route solver failed: {e}")

        await update_progress(
            "building_circuit",
            80,
            f"Building route with {len(node_circuit)} waypoints...",
        )

        # 7. Convert circuit to coordinates
        route_coords = []
        total_nodes = len(node_circuit)
        for idx, node in enumerate(node_circuit):
            if idx % 500 == 0 and idx > 0:
                pct = 80 + int((idx / total_nodes) * 15)
                await update_progress(
                    "converting_coords",
                    pct,
                    f"Converting waypoint {idx}/{total_nodes}...",
                )
            if node in G.nodes:
                route_coords.append([G.nodes[node]["x"], G.nodes[node]["y"]])

        if not route_coords:
            raise ValueError("Failed to generate route coordinates")

        # Force status logic to ensure frontend picks it up
        logger.info("Route generation finished. Updating DB status to completed.")
        try:
            await _update_db_progress(
                task_id,
                location_id,
                "complete",
                100,
                "Route generation complete!",
                "completed",
            )
            logger.info("DB status update successful.")
        except Exception as update_err:
            logger.error("Final DB progress update failed: %s", update_err)
            # Try one more time with a simple update
            await optimal_route_progress_collection.update_one(
                {"task_id": task_id},
                {
                    "$set": {
                        "status": "completed",
                        "progress": 100,
                        "stage": "complete",
                        "completed_at": datetime.now(UTC),
                    }
                },
            )

        return {
            "status": "success",
            "route_coordinates": route_coords,
            "total_distance_m": stats["total_distance"],
            "required_distance_m": stats["required_distance"],
            "deadhead_distance_m": stats["deadhead_distance"],
            "deadhead_percentage": stats["deadhead_percentage"],
            "segment_count": len(required_edges),
            "circuit_nodes": len(node_circuit),
            "generated_at": datetime.now(UTC).isoformat(),
            "location_name": location_name,
        }

    except Exception as e:
        await _update_db_progress(
            task_id,
            location_id,
            "failed",
            0,
            f"Route generation failed: {e}",
            "failed",
            str(e),
        )
        raise


async def generate_optimal_route(
    location_id: str,
    start_coords: tuple[float, float] | None = None,
    progress_callback: Any | None = None,
) -> dict[str, Any]:
    """Generate the optimal completion route for a coverage area.

    Uses OSMnx to fetch the street network and our RPP solver to compute
    the optimal route through all undriven segments.

    Args:
        location_id: MongoDB ObjectId string for the coverage area
        start_coords: Optional (lon, lat) to specify route start point
        progress_callback: Optional async function(stage, progress, message)

    Returns:
        Dict with route_coordinates, stats, and metadata
    """

    async def update_progress(stage: str, progress: int, message: str) -> None:
        if progress_callback:
            await progress_callback(stage, progress, message)
        logger.info("Route generation [%d%%]: %s", progress, message)

    await update_progress("initializing", 0, "Starting optimal route generation...")

    # 1. Load coverage area and geometry
    obj_id = ObjectId(location_id)
    area = await find_one_with_retry(coverage_metadata_collection, {"_id": obj_id})
    if not area:
        raise ValueError(f"Coverage area {location_id} not found")

    location_info = area.get("location", {})
    location_name = location_info.get("display_name", "Unknown")

    await update_progress("loading", 10, f"Loading coverage area: {location_name}")

    # Get boundary polygon
    boundary_geom = location_info.get("geojson", {}).get("geometry")
    if boundary_geom:
        polygon = shape(boundary_geom)
    else:
        # Fall back to bbox
        bbox = location_info.get("boundingbox")
        if bbox and len(bbox) >= 4:
            # bbox is [south, north, west, east] or [min_lat, max_lat, min_lon, max_lon]
            polygon = box(
                float(bbox[2]), float(bbox[0]), float(bbox[3]), float(bbox[1])
            )
        else:
            raise ValueError("No valid boundary for coverage area")

    # 2. Get undriven segments
    await update_progress("loading", 20, "Loading undriven street segments...")

    cursor = streets_collection.find(
        {
            "properties.location": location_name,
            "properties.driven": False,
            "properties.undriveable": {"$ne": True},
        },
        {
            "geometry": 1,
            "properties.segment_id": 1,
            "properties.segment_length": 1,
            "properties.street_name": 1,
        },
    ).limit(MAX_SEGMENTS)

    undriven = await cursor.to_list(length=MAX_SEGMENTS)

    if not undriven:
        return {"status": "already_complete", "message": "All streets already driven!"}

    logger.info("Found %d undriven segments for %s", len(undriven), location_name)
    await update_progress(
        "loading", 30, f"Found {len(undriven)} undriven segments to route"
    )

    # 3. Fetch OSM street network
    await update_progress("fetching_osm", 40, "Downloading OSM street network...")

    try:
        G = ox.graph_from_polygon(
            polygon,
            network_type="drive",
            simplify=True,
            truncate_by_edge=True,
        )
        G = ox.convert.to_undirected(G)
        logger.info(
            "Downloaded OSM graph: %d nodes, %d edges",
            G.number_of_nodes(),
            G.number_of_edges(),
        )
    except Exception as e:
        logger.error("Failed to download OSM data: %s", e)
        raise ValueError(f"Failed to download street network: {e}")

    await update_progress("processing", 50, "Mapping segments to street network...")

    # 4. Map segment endpoints to OSM nodes and build required edges
    required_edges = set()
    segment_to_edge = {}
    skipped = 0

    for seg in undriven:
        geom = seg.get("geometry", {})
        coords = geom.get("coordinates", [])
        if not coords or len(coords) < 2:
            skipped += 1
            continue

        seg_id = seg["properties"]["segment_id"]

        # Get start/end coordinates [lon, lat]
        start_pt = coords[0]
        end_pt = coords[-1]

        try:
            # Find nearest OSM nodes
            start_node = ox.distance.nearest_nodes(G, start_pt[0], start_pt[1])
            end_node = ox.distance.nearest_nodes(G, end_pt[0], end_pt[1])

            if start_node == end_node:
                skipped += 1
                continue

            # Normalize edge key (smaller node first for consistency)
            edge_key = (min(start_node, end_node), max(start_node, end_node))
            required_edges.add(edge_key)
            segment_to_edge[seg_id] = edge_key
        except Exception:
            skipped += 1
            continue

    if skipped > 0:
        logger.info("Skipped %d segments due to mapping issues", skipped)

    if not required_edges:
        return {
            "status": "error",
            "message": "Could not map any segments to street network",
        }

    await update_progress(
        "solving", 60, f"Solving route for {len(required_edges)} street segments..."
    )

    # 5. Determine start node
    start_node = None
    if start_coords:
        try:
            start_node = ox.distance.nearest_nodes(G, start_coords[0], start_coords[1])
        except Exception:
            pass

    # 6. Solve RPP
    logger.info(
        "Solving RPP with %d required edges, %d total edges",
        len(required_edges),
        G.number_of_edges(),
    )

    try:
        node_circuit, stats = _solve_rpp(G, required_edges, start_node)
    except Exception as e:
        logger.error("RPP solver failed: %s", e, exc_info=True)
        raise ValueError(f"Route solver failed: {e}")

    await update_progress("finalizing", 80, "Building route coordinates...")

    # 7. Convert circuit to coordinates
    route_coords = []
    for node in node_circuit:
        if node in G.nodes:
            route_coords.append([G.nodes[node]["x"], G.nodes[node]["y"]])

    if not route_coords:
        return {"status": "error", "message": "Failed to generate route coordinates"}

    await update_progress("complete", 100, "Route generation complete!")

    return {
        "status": "success",
        "route_coordinates": route_coords,
        "total_distance_m": stats["total_distance"],
        "required_distance_m": stats["required_distance"],
        "deadhead_distance_m": stats["deadhead_distance"],
        "deadhead_percentage": stats["deadhead_percentage"],
        "segment_count": len(required_edges),
        "circuit_nodes": len(node_circuit),
        "generated_at": datetime.now(UTC).isoformat(),
        "location_name": location_name,
    }


async def save_optimal_route(location_id: str, route_result: dict[str, Any]) -> None:
    """Save the generated optimal route to the coverage area document."""
    if route_result.get("status") != "success":
        return

    await update_one_with_retry(
        coverage_metadata_collection,
        {"_id": ObjectId(location_id)},
        {
            "$set": {
                "optimal_route": {
                    "coordinates": route_result["route_coordinates"],
                    "total_distance_m": route_result["total_distance_m"],
                    "required_distance_m": route_result["required_distance_m"],
                    "deadhead_distance_m": route_result["deadhead_distance_m"],
                    "deadhead_percentage": route_result["deadhead_percentage"],
                    "segment_count": route_result["segment_count"],
                    "generated_at": datetime.now(UTC),
                }
            }
        },
    )
    logger.info("Saved optimal route for location %s", location_id)


def build_gpx_from_coords(
    coords: list[list[float]], name: str = "Optimal Route"
) -> str:
    """Build GPX XML from coordinate list.

    Args:
        coords: List of [lon, lat] coordinate pairs
        name: Name for the GPX track

    Returns:
        GPX XML string
    """
    gpx_header = f"""<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="EveryStreet"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>{name}</name>
    <time>{datetime.now(UTC).isoformat()}</time>
  </metadata>
  <trk>
    <name>{name}</name>
    <trkseg>
"""
    gpx_footer = """    </trkseg>
  </trk>
</gpx>"""

    points = []
    for coord in coords:
        lon, lat = coord[0], coord[1]
        points.append(f'      <trkpt lat="{lat}" lon="{lon}"></trkpt>')

    return gpx_header + "\n".join(points) + "\n" + gpx_footer
