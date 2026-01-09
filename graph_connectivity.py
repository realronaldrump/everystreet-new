"""
Graph connectivity analysis and bridge-and-merge logic for route solving.

This module handles disconnected graph components by:
1. Identifying clusters of required segments
2. Finding bridge routes between clusters via Mapbox Directions API
3. Downloading narrow corridor graphs to connect clusters
4. Merging corridors into the main graph

This eliminates the need for "teleportation" (straight-line interpolation)
when the route solver encounters disconnected components.
"""

from __future__ import annotations

import logging
from typing import Any

import geopandas as gpd
import httpx
import networkx as nx
import osmnx as ox
from shapely.geometry import LineString

# EdgeRef and ReqId imported conditionally for type hints would cause circular import
# Type hints using string literals instead

logger = logging.getLogger(__name__)

# Constants
FEET_PER_METER = 3.28084
MAX_BRIDGE_DISTANCE_MILES = 15.0  # Maximum distance we'll attempt to bridge
CORRIDOR_BUFFER_FT = 150.0  # Buffer width for corridor download (thin strip)
MAX_BRIDGES_PER_ITERATION = 50  # Process this many bridges concurrently per iteration
MAX_BRIDGING_ITERATIONS = 100  # Safety limit on iterations
MAX_TOTAL_BRIDGES = 2000  # Maximum total bridges to create


def _edge_length_m(G: nx.Graph, u: int, v: int, k: int | None = None) -> float:
    """Best-effort edge length in meters."""
    try:
        if G.is_multigraph():
            if k is None:
                return float(min(data.get("length", 0.0) for data in G[u][v].values()))
            return float(G.edges[u, v, k].get("length", 0.0))
        return float(G.edges[u, v].get("length", 0.0))
    except Exception:
        return 0.0


def _haversine_distance_miles(
    lon1: float, lat1: float, lon2: float, lat2: float
) -> float:
    """Calculate haversine distance between two points in miles."""
    import math

    R = 3958.8  # Earth's radius in miles

    lat1_rad = math.radians(lat1)
    lat2_rad = math.radians(lat2)
    delta_lat = math.radians(lat2 - lat1)
    delta_lon = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(delta_lon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    return R * c


def _buffer_linestring_for_corridor(line: LineString, buffer_ft: float) -> Any:
    """Buffer a WGS84 linestring by feet (project to UTM, buffer, reproject)."""
    if buffer_ft <= 0:
        return line.buffer(0.0001)  # Minimal buffer in degrees
    try:
        buffer_m = buffer_ft / FEET_PER_METER
        gdf = gpd.GeoDataFrame(geometry=[line], crs="EPSG:4326")
        projected = ox.projection.project_gdf(gdf)
        buffered = projected.geometry.iloc[0].buffer(buffer_m)
        buffered_gdf = gpd.GeoDataFrame(geometry=[buffered], crs=projected.crs)
        return buffered_gdf.to_crs("EPSG:4326").geometry.iloc[0]
    except Exception as e:
        logger.warning("Corridor buffer failed, using degree-based buffer: %s", e)
        # Fallback: ~0.001 degrees per ~100m at mid-latitudes
        return line.buffer(buffer_ft * 0.000003)


def analyze_required_connectivity(
    G: nx.MultiDiGraph,
    required_reqs: dict[Any, list[tuple[int, int, int]]],
) -> list[set[int]]:
    """
    Identify clusters of required edges by graph connectivity.

    Args:
        G: The routing graph
        required_reqs: Dictionary mapping requirement IDs to edge options

    Returns:
        List of node sets, each representing a connected component of required edges
    """
    req_graph = nx.Graph()

    for _rid, opts in required_reqs.items():
        # Use the shortest edge option as representative
        best = min(opts, key=lambda e: _edge_length_m(G, e[0], e[1], e[2]))
        req_graph.add_edge(best[0], best[1])

    clusters = [set(nodes) for nodes in nx.connected_components(req_graph)]

    if len(clusters) > 1:
        logger.info(
            "Found %d disconnected clusters of required segments", len(clusters)
        )
        for i, cluster in enumerate(clusters):
            logger.debug("  Cluster %d: %d nodes", i, len(cluster))

    return clusters


def find_closest_cluster_pair(
    cluster_a: set[int],
    cluster_b: set[int],
    node_xy: dict[int, tuple[float, float]],
) -> tuple[int | None, int | None, float]:
    """
    Find the two closest nodes between two clusters.

    Args:
        cluster_a: Set of node IDs in first cluster
        cluster_b: Set of node IDs in second cluster
        node_xy: Dictionary mapping node IDs to (lon, lat) coordinates

    Returns:
        Tuple of (node_a, node_b, distance_miles)
    """
    best_pair: tuple[int | None, int | None] = (None, None)
    best_dist = float("inf")

    for a in cluster_a:
        if a not in node_xy:
            continue
        ax, ay = node_xy[a]
        for b in cluster_b:
            if b not in node_xy:
                continue
            bx, by = node_xy[b]
            dist = _haversine_distance_miles(ax, ay, bx, by)
            if dist < best_dist:
                best_dist = dist
                best_pair = (a, b)

    return (*best_pair, best_dist)


def find_bridge_pairs(
    clusters: list[set[int]],
    node_xy: dict[int, tuple[float, float]],
    max_distance_miles: float = MAX_BRIDGE_DISTANCE_MILES,
) -> list[tuple[int, int, int, int, float]]:
    """
    Find pairs of clusters to bridge, ordered by distance.

    Uses a greedy approach: connect closest clusters first.

    Args:
        clusters: List of node sets (connected components)
        node_xy: Dictionary mapping node IDs to (lon, lat) coordinates
        max_distance_miles: Maximum bridge distance to attempt

    Returns:
        List of (cluster_idx_a, cluster_idx_b, node_a, node_b, distance_miles)
        sorted by distance ascending
    """
    pairs: list[tuple[int, int, int, int, float]] = []

    for i in range(len(clusters)):
        for j in range(i + 1, len(clusters)):
            node_a, node_b, dist = find_closest_cluster_pair(
                clusters[i], clusters[j], node_xy
            )
            if node_a is not None and node_b is not None and dist <= max_distance_miles:
                pairs.append((i, j, node_a, node_b, dist))

    # Sort by distance (connect closest clusters first)
    pairs.sort(key=lambda x: x[4])

    return pairs


async def fetch_bridge_route(
    from_xy: tuple[float, float],
    to_xy: tuple[float, float],
    timeout: float = 30.0,
) -> list[list[float]] | None:
    """
    Get driveable route between two points via Mapbox Directions API.

    Args:
        from_xy: (lon, lat) of start point
        to_xy: (lon, lat) of end point
        timeout: Request timeout in seconds

    Returns:
        List of [lon, lat] coordinates for the route, or None if failed
    """
    from config import get_app_settings

    settings = await get_app_settings()
    token = settings.get("mapbox_access_token")
    if not token:
        logger.warning("Mapbox token not configured; cannot fetch bridge route")
        return None

    coords_str = f"{from_xy[0]},{from_xy[1]};{to_xy[0]},{to_xy[1]}"
    url = f"https://api.mapbox.com/directions/v5/mapbox/driving/{coords_str}"
    params = {
        "access_token": token,
        "geometries": "geojson",
        "overview": "full",
    }

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(url, params=params, timeout=timeout)
            response.raise_for_status()
            data = response.json()

            if routes := data.get("routes"):
                coords = routes[0]["geometry"]["coordinates"]
                logger.info(
                    "Fetched bridge route with %d coordinates (%.2f miles)",
                    len(coords),
                    routes[0].get("distance", 0) / 1609.34,  # meters to miles
                )
                return coords

            logger.warning("No route found by Mapbox Directions API")
            return None

    except httpx.HTTPStatusError as e:
        logger.error("Mapbox Directions API HTTP error: %s", e.response.status_code)
        return None
    except httpx.RequestError as e:
        logger.error("Mapbox Directions API request error: %s", e)
        return None
    except Exception as e:
        logger.error("Unexpected error fetching bridge route: %s", e)
        return None


def download_corridor_graph(
    route_coords: list[list[float]],
    buffer_ft: float = CORRIDOR_BUFFER_FT,
) -> nx.MultiDiGraph | None:
    """
    Download OSM road network within a buffered corridor of the route.

    Args:
        route_coords: List of [lon, lat] coordinates for the route
        buffer_ft: Buffer width in feet

    Returns:
        NetworkX MultiDiGraph of the corridor, or None if failed
    """
    if not route_coords or len(route_coords) < 2:
        logger.warning("Invalid route coordinates for corridor download")
        return None

    try:
        line = LineString(route_coords)
        corridor = _buffer_linestring_for_corridor(line, buffer_ft)

        logger.info(
            "Downloading corridor graph (%.4f sq deg)...",
            corridor.area if hasattr(corridor, "area") else 0,
        )

        G = ox.graph_from_polygon(
            corridor,
            network_type="drive",
            simplify=False,  # CRITICAL: Do not simplify, otherwise we lose connection nodes that aren't intersections in the corridor
            truncate_by_edge=True,
            retain_all=True,
        )

        logger.info(
            "Downloaded corridor graph: %d nodes, %d edges",
            G.number_of_nodes(),
            G.number_of_edges(),
        )

        return G

    except Exception as e:
        logger.error("Failed to download corridor graph: %s", e)
        return None


def merge_graphs(
    main_graph: nx.MultiDiGraph,
    corridor_graph: nx.MultiDiGraph,
) -> nx.MultiDiGraph:
    """
    Merge corridor graph into main graph.

    Nodes and edges with matching OSM IDs will be unified.

    Args:
        main_graph: The primary routing graph
        corridor_graph: The corridor graph to merge in

    Returns:
        Combined MultiDiGraph
    """
    # NetworkX compose handles node/edge overlap correctly
    merged = nx.compose(main_graph, corridor_graph)

    logger.info(
        "Merged graphs: %d nodes, %d edges (was %d/%d + %d/%d)",
        merged.number_of_nodes(),
        merged.number_of_edges(),
        main_graph.number_of_nodes(),
        main_graph.number_of_edges(),
        corridor_graph.number_of_nodes(),
        corridor_graph.number_of_edges(),
    )

    return merged


async def bridge_disconnected_clusters(
    G: nx.MultiDiGraph,
    required_reqs: dict[Any, list[tuple[int, int, int]]],
    node_xy: dict[int, tuple[float, float]],
    progress_callback: Any | None = None,
) -> nx.MultiDiGraph:
    """
    Orchestrate the full bridging flow for disconnected clusters.

    Iterates until all clusters are connected or no more progress can be made:
    1. Analyze connectivity to find clusters
    2. For each pair of clusters (closest first):
       a. Fetch bridge route via Mapbox
       b. Download corridor graph
       c. Merge into main graph
    3. Re-analyze to confirm connectivity
    4. Repeat if clusters remain disconnected

    Args:
        G: The routing graph
        required_reqs: Dictionary mapping requirement IDs to edge options
        node_xy: Dictionary mapping node IDs to (lon, lat) coordinates
        progress_callback: Optional async callback(stage, percent, message)

    Returns:
        The augmented graph with bridge corridors merged in
    """
    import asyncio
    import functools

    initial_clusters = analyze_required_connectivity(G, required_reqs)
    initial_count = len(initial_clusters)

    if initial_count <= 1:
        logger.info("All required segments are connected; no bridging needed")
        return G

    if progress_callback:
        await progress_callback(
            "bridging",
            0,
            f"Found {initial_count} disconnected clusters; starting bridge iterations...",
        )

    total_bridges_created = 0
    iteration = 0
    prev_cluster_count = initial_count

    while iteration < MAX_BRIDGING_ITERATIONS:
        iteration += 1

        # Re-analyze clusters after each iteration
        clusters = analyze_required_connectivity(G, required_reqs)
        current_count = len(clusters)

        if current_count <= 1:
            logger.info(
                "All clusters connected after %d iterations (%d bridges)",
                iteration,
                total_bridges_created,
            )
            break

        # Check if we made progress
        if iteration > 1 and current_count >= prev_cluster_count:
            logger.warning(
                "No progress in iteration %d (still %d clusters); stopping",
                iteration,
                current_count,
            )
            break

        if total_bridges_created >= MAX_TOTAL_BRIDGES:
            logger.warning(
                "Reached maximum total bridges (%d); stopping with %d clusters",
                MAX_TOTAL_BRIDGES,
                current_count,
            )
            break

        prev_cluster_count = current_count

        # Find bridge pairs for current cluster state
        bridge_pairs = find_bridge_pairs(clusters, node_xy)

        if not bridge_pairs:
            logger.warning(
                "No bridgeable pairs found within %.1f miles in iteration %d; "
                "%d clusters remain disconnected",
                MAX_BRIDGE_DISTANCE_MILES,
                iteration,
                current_count,
            )
            break

        # Use Union-Find to track which clusters are connected in this iteration
        parent = list(range(len(clusters)))

        def find(x: int) -> int:
            if parent[x] != x:
                parent[x] = find(parent[x])
            return parent[x]

        def union(x: int, y: int) -> None:
            px, py = find(x), find(y)
            if px != py:
                parent[px] = py

        # Plan bridges for this iteration
        bridges_remaining = MAX_TOTAL_BRIDGES - total_bridges_created
        max_this_iteration = min(
            len(bridge_pairs), MAX_BRIDGES_PER_ITERATION, bridges_remaining
        )

        planned_bridges = []
        for idx, (ci, cj, node_a, node_b, dist) in enumerate(
            bridge_pairs[:max_this_iteration]
        ):
            if find(ci) == find(cj):
                continue

            union(ci, cj)
            planned_bridges.append((idx, ci, cj, node_a, node_b, dist))

        if not planned_bridges:
            logger.info(
                "All reachable clusters bridged in iteration %d; %d clusters remain isolated",
                iteration,
                current_count,
            )
            break

        logger.info(
            "Iteration %d: building %d bridges (%d clusters remaining)...",
            iteration,
            len(planned_bridges),
            current_count,
        )

        progress_pct = min(
            90, 10 + (total_bridges_created * 80) // max(initial_count, 1)
        )
        if progress_callback:
            await progress_callback(
                "bridging",
                progress_pct,
                f"Iteration {iteration}: processing {len(planned_bridges)} bridges ({current_count} clusters)...",
            )

        # Execution phase: Fetch and download in parallel
        async def process_bridge(bridge_info):
            idx, ci, cj, node_a, node_b, dist = bridge_info

            if progress_callback:
                # Rough progress update (fire and forget)
                await progress_callback(
                    "bridging",
                    progress_pct,
                    f"Fetching bridge {idx + 1}: cluster {ci}->{cj} ({dist:.2f} mi)",
                )

            xy_a = node_xy.get(node_a)
            xy_b = node_xy.get(node_b)

            if not xy_a or not xy_b:
                logger.warning(
                    "Missing coordinates for bridge nodes %d or %d", node_a, node_b
                )
                return None

            # Fetch bridge route from Mapbox
            route_coords = await fetch_bridge_route(xy_a, xy_b)
            if not route_coords:
                logger.warning("Could not fetch bridge route from %s to %s", xy_a, xy_b)
                return None

            # Download corridor graph (run in thread to avoid blocking event loop)
            loop = asyncio.get_running_loop()
            corridor = await loop.run_in_executor(
                None, functools.partial(download_corridor_graph, route_coords)
            )

            if not corridor:
                logger.warning("Could not download corridor graph for bridge")
                return None

            # Verify connection nodes are present
            if node_a not in corridor.nodes:
                logger.warning(
                    "Corridor graph missing start node %d (may cause disconnect)",
                    node_a,
                )
            if node_b not in corridor.nodes:
                logger.warning(
                    "Corridor graph missing end node %d (may cause disconnect)", node_b
                )

            return (corridor, bridge_info)

        # Run all tasks for this iteration
        results = await asyncio.gather(*(process_bridge(b) for b in planned_bridges))

        # Merging phase: Integrate successful results
        iteration_bridges_created = 0
        for res in results:
            if not res:
                continue

            corridor, (idx, ci, cj, node_a, node_b, dist) = res

            # Merge into main graph
            G = merge_graphs(G, corridor)
            iteration_bridges_created += 1
            total_bridges_created += 1

            logger.info(
                "Successfully created bridge %d: cluster %d <-> %d (%.2f miles)",
                total_bridges_created,
                ci,
                cj,
                dist,
            )

        # Update node_xy with any new nodes from corridors
        for n in G.nodes:
            if n not in node_xy and "x" in G.nodes[n] and "y" in G.nodes[n]:
                node_xy[n] = (float(G.nodes[n]["x"]), float(G.nodes[n]["y"]))

        logger.info(
            "Iteration %d complete: %d bridges created this iteration, %d total",
            iteration,
            iteration_bridges_created,
            total_bridges_created,
        )

    # End of while loop - log final status
    if progress_callback:
        await progress_callback(
            "bridging",
            100,
            f"Created {total_bridges_created} bridge corridors",
        )

    # Log final connectivity status
    final_clusters = analyze_required_connectivity(G, required_reqs)
    if len(final_clusters) > 1:
        logger.warning(
            "After bridging: %d clusters remain disconnected (started with %d)",
            len(final_clusters),
            initial_count,
        )
    else:
        logger.info(
            "Bridging successful: all %d original clusters now connected",
            initial_count,
        )

    return G
