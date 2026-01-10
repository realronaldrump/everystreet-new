"""
Optimal route solver using a connectivity-first greedy coverage strategy.

Key features:
- Buffer routing graph to avoid artificial disconnections at coverage boundaries.
- Map undriven segments to OSM edges using OSM IDs when available (fallback to nearest).
- Prefer continuing along adjacent undriven edges before deadheading.
- Post-process to fill gaps with Mapbox driving routes.
- Validate coverage, gaps, and deadhead ratio before returning.
"""

import contextlib
import heapq
import logging
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import geopandas as gpd
import networkx as nx
import osmnx as ox
from bson import ObjectId
from shapely.geometry import LineString

from db import (
    coverage_metadata_collection,
    find_one_with_retry,
    optimal_route_progress_collection,
    streets_collection,
    update_one_with_retry,
)
from geometry_service import GeometryService
from progress_tracker import ProgressTracker

logger = logging.getLogger(__name__)

# Distance constants in FEET (user preference: imperial units)
FEET_PER_METER = 3.28084
MAX_SEGMENTS = 5000
ROUTING_BUFFER_FT = 6500.0  # ~2000m - buffer to include connecting highways/roads
MAX_ROUTE_GAP_FT = 10000.0  # ~3000m (~1.9 miles) - max allowed gap between route points
MAX_DEADHEAD_RATIO_WARN = 6.0
MAX_DEADHEAD_RATIO_ERROR = 10.0
MIN_SEGMENT_COVERAGE_RATIO = 0.9
MAX_OSM_MATCH_DISTANCE_FT = 1640.0  # ~500m - max distance for OSM ID matching
GRAPH_STORAGE_DIR = Path("data/graphs")

EdgeRef = tuple[int, int, int]  # (u, v, key)
ReqId = frozenset[
    EdgeRef
]  # physical-ish edge requirement; can include reverse if present


def _buffer_polygon_for_routing(polygon: Any, buffer_ft: float) -> Any:
    """Buffer a WGS84 polygon by feet (project to UTM, buffer, reproject)."""
    if buffer_ft <= 0:
        return polygon
    try:
        # Convert feet to meters for internal projection operations
        buffer_m = buffer_ft / FEET_PER_METER
        gdf = gpd.GeoDataFrame(geometry=[polygon], crs="EPSG:4326")
        projected = ox.projection.project_gdf(gdf)
        buffered = projected.geometry.iloc[0].buffer(buffer_m)
        buffered_gdf = gpd.GeoDataFrame(geometry=[buffered], crs=projected.crs)
        return buffered_gdf.to_crs("EPSG:4326").geometry.iloc[0]
    except Exception as e:
        logger.warning("Routing buffer failed, using original polygon: %s", e)
        return polygon


def _edge_length_m(G: nx.Graph, u: int, v: int, key: int | None = None) -> float:
    """Best-effort edge length in meters."""
    try:
        if G.is_multigraph():
            if key is None:
                # choose minimum length among parallel edges
                return float(min(data.get("length", 0.0) for data in G[u][v].values()))
            return float(G.edges[u, v, key].get("length", 0.0))
        return float(G.edges[u, v].get("length", 0.0))
    except Exception:
        return 0.0


def _pick_best_key(G: nx.Graph, u: int, v: int, weight: str = "length") -> int | None:
    """For MultiGraphs, pick the best key for u->v (min weight)."""
    if not G.is_multigraph():
        return None
    try:
        best_key = None
        best_w = float("inf")
        for k, data in G[u][v].items():
            w = float(data.get(weight, 1.0))
            if w < best_w:
                best_w = w
                best_key = k
        return best_key
    except Exception:
        return None


def _get_edge_geometry(
    G: nx.Graph | nx.MultiGraph,
    u: int,
    v: int,
    key: int | None = None,
    *,
    node_xy: dict[int, tuple[float, float]] | None = None,
) -> list[list[float]]:
    """
    Extract road geometry for an edge, automatically oriented u->v.

    Returns a list of [lon, lat] coordinates.
    """
    coords: list[list[float]] = []

    # Fallback: straight line between node coordinates
    def _fallback() -> list[list[float]]:
        if node_xy and u in node_xy and v in node_xy:
            (ux, uy) = node_xy[u]
            (vx, vy) = node_xy[v]
            return [[ux, uy], [vx, vy]]
        if u in G.nodes and v in G.nodes:
            return [
                [G.nodes[u]["x"], G.nodes[u]["y"]],
                [G.nodes[v]["x"], G.nodes[v]["y"]],
            ]
        return []

    try:
        if not G.has_edge(u, v):
            return _fallback()

        if G.is_multigraph():
            if key is None:
                key = _pick_best_key(G, u, v)  # may still be None
            data = G.edges[u, v, key] if key is not None else None
        else:
            data = G.edges[u, v]

        if data and "geometry" in data and data["geometry"] is not None:
            geom = data["geometry"]
            try:
                coords = [[float(x), float(y)] for (x, y) in geom.coords]
            except Exception:
                coords = []
        if not coords:
            coords = _fallback()
    except Exception:
        coords = _fallback()

    # Ensure orientation is u->v (reverse if needed)
    if coords and node_xy and u in node_xy:
        ux, uy = node_xy[u]
        # compare which end is closer to u
        d0 = (coords[0][0] - ux) ** 2 + (coords[0][1] - uy) ** 2
        d1 = (coords[-1][0] - ux) ** 2 + (coords[-1][1] - uy) ** 2
        if d1 < d0:
            coords.reverse()

    return coords


def _edge_linestring(
    G: nx.Graph | nx.MultiGraph,
    u: int,
    v: int,
    key: int | None,
    *,
    node_xy: dict[int, tuple[float, float]] | None = None,
    cache: dict[EdgeRef, LineString] | None = None,
) -> LineString | None:
    """Build a LineString for an edge (cached when provided)."""
    cache_key: EdgeRef = (u, v, -1 if key is None else int(key))
    if cache is not None and cache_key in cache:
        return cache[cache_key]
    coords = _get_edge_geometry(G, u, v, key, node_xy=node_xy)
    if len(coords) < 2:
        return None
    try:
        line = LineString(coords)
    except Exception:
        return None
    if cache is not None:
        cache[cache_key] = line
    return line


def _build_osmid_index(G: nx.MultiDiGraph) -> dict[int, list[EdgeRef]]:
    """Index OSM IDs to edges in the routing graph."""
    index: dict[int, list[EdgeRef]] = {}
    for u, v, k, data in G.edges(keys=True, data=True):
        osmids = data.get("osmid")
        if osmids is None:
            continue
        candidates = osmids if isinstance(osmids, list | set | tuple) else [osmids]
        for osmid in candidates:
            with contextlib.suppress(Exception):
                oid = int(osmid)
                index.setdefault(oid, []).append((int(u), int(v), int(k)))
    return index


def _segment_midpoint(coords: list[list[float]]) -> tuple[float, float] | None:
    """Midpoint (lon, lat) for a LineString coordinate list."""
    if not coords or len(coords) < 2:
        return None
    try:
        ls = LineString(coords)
        mid = ls.interpolate(0.5, normalized=True)
        return (float(mid.x), float(mid.y))
    except Exception:
        try:
            mx = float((coords[0][0] + coords[-1][0]) / 2.0)
            my = float((coords[0][1] + coords[-1][1]) / 2.0)
            return (mx, my)
        except Exception:
            return None


def _try_match_osmid(
    G: nx.MultiDiGraph,
    coords: list[list[float]],
    osmid: int | None,
    osmid_index: dict[int, list[EdgeRef]],
    *,
    node_xy: dict[int, tuple[float, float]] | None = None,
    line_cache: dict[EdgeRef, LineString] | None = None,
) -> EdgeRef | None:
    """Try to map a segment to an edge using OSM ID matching only."""
    if osmid is None:
        return None

    candidates = osmid_index.get(osmid, [])
    if not candidates:
        return None

    seg_line = None
    if coords and len(coords) >= 2:
        with contextlib.suppress(Exception):
            seg_line = LineString(coords)

    if not seg_line:
        return None

    best_edge: EdgeRef | None = None
    best_dist = float("inf")

    for u, v, k in candidates:
        edge_line = _edge_linestring(
            G,
            u,
            v,
            k,
            node_xy=node_xy,
            cache=line_cache,
        )
        if not edge_line:
            continue

        d_deg = edge_line.distance(seg_line)
        d_ft = d_deg * 111_000.0 * FEET_PER_METER  # degrees to feet
        if d_ft < best_dist:
            best_dist = d_ft
            best_edge = (u, v, k)

    if best_edge and best_dist <= MAX_OSM_MATCH_DISTANCE_FT:
        return best_edge

    return None


def _dijkstra_to_any_target(
    G: nx.DiGraph | nx.MultiDiGraph,
    source: int,
    targets: set[int],
    *,
    weight: str = "length",
) -> tuple[int, float, list[EdgeRef]] | None:
    """
    Early-exit Dijkstra: find shortest path from source to ANY node in targets.

    Returns (target_node, distance, path_edges[(u,v,key), ...]) or None.
    """
    if source in targets:
        return (source, 0.0, [])

    dist: dict[int, float] = {source: 0.0}
    prev: dict[int, tuple[int, int | None]] = {}  # node -> (prev_node, prev_key)
    heap: list[tuple[float, int]] = [(0.0, source)]
    visited: set[int] = set()

    while heap:
        d, u = heapq.heappop(heap)
        if u in visited:
            continue
        visited.add(u)

        if u in targets:
            # reconstruct edges
            edges: list[EdgeRef] = []
            cur = u
            while cur != source:
                p, k = prev[cur]
                if k is None:
                    # non-multigraph: no key; store -1
                    edges.append((p, cur, -1))
                else:
                    edges.append((p, cur, k))
                cur = p
            edges.reverse()
            return (u, d, edges)

        # Iterate outgoing edges
        if G.is_multigraph():
            for _, v, k, data in G.out_edges(u, keys=True, data=True):
                w = float(data.get(weight, 1.0))
                if w < 0:
                    continue
                nd = d + w
                if nd < dist.get(v, float("inf")):
                    dist[v] = nd
                    prev[v] = (u, k)
                    heapq.heappush(heap, (nd, v))
        else:
            for _, v, data in G.out_edges(u, data=True):
                w = float(data.get(weight, 1.0))
                if w < 0:
                    continue
                nd = d + w
                if nd < dist.get(v, float("inf")):
                    dist[v] = nd
                    prev[v] = (u, None)
                    heapq.heappush(heap, (nd, v))

    return None


def _reverse_candidates_for_edge(
    G: nx.MultiDiGraph, u: int, v: int, key: int
) -> list[EdgeRef]:
    """Find plausible reverse edges v->u (keys) if present."""
    if not G.has_edge(v, u):
        return []
    # Try to match by osmid when possible; otherwise return all reverse edges.
    try:
        fwd = G.edges[u, v, key]
        f_osmid = fwd.get("osmid")
        revs: list[EdgeRef] = []
        for rk, rdata in G[v][u].items():
            if f_osmid is not None and rdata.get("osmid") == f_osmid:
                revs.append((v, u, rk))
        if revs:
            return revs
        return [(v, u, rk) for rk in G[v][u]]
    except Exception:
        return [(v, u, rk) for rk in G[v][u]]


def _make_req_id(G: nx.MultiDiGraph, edge: EdgeRef) -> tuple[ReqId, list[EdgeRef]]:
    """
    Build a requirement ID for a physical-ish segment:

    include the mapped directed edge, and include reverse edge(s) if they exist.
    ReqId is a frozenset of EdgeRef(s); options is the list of directed edges you can traverse to satisfy it.
    """
    u, v, k = edge
    options: list[EdgeRef] = [(u, v, k)]
    if G.is_multigraph() and G.is_directed():
        revs = _reverse_candidates_for_edge(G, u, v, k)
        # keep only one reverse option (best length) to avoid weird parallels unless you want more
        if revs:
            best_rev = min(revs, key=lambda e: _edge_length_m(G, e[0], e[1], e[2]))
            options.append(best_rev)
    req_id: ReqId = frozenset(options)
    return req_id, options


def _initialize_route_state(
    G: nx.MultiDiGraph,
    required_reqs: dict[ReqId, list[EdgeRef]],
    start_node: int | None,
) -> tuple[int, dict[int, tuple[float, float]]]:
    """Initialize routing state and return starting node and node coordinates."""
    node_xy: dict[int, tuple[float, float]] = {
        n: (float(G.nodes[n]["x"]), float(G.nodes[n]["y"]))
        for n in G.nodes
        if "x" in G.nodes[n] and "y" in G.nodes[n]
    }

    if start_node is not None and start_node in G.nodes:
        current_node = start_node
    else:
        # pick any requirement start node if possible
        any_req = next(iter(required_reqs.values()))
        current_node = any_req[0][0]  # u of first option

    return current_node, node_xy


def _build_requirement_indices(
    required_reqs: dict[ReqId, list[EdgeRef]],
) -> tuple[dict[ReqId, list[int]], dict[int, int]]:
    """Build indices mapping requirements to start nodes."""
    req_to_starts: dict[ReqId, list[int]] = {}
    start_counts: dict[int, int] = {}

    for rid, opts in required_reqs.items():
        starts = sorted({u for (u, _, _) in opts})
        req_to_starts[rid] = starts
        for s in starts:
            start_counts[s] = start_counts.get(s, 0) + 1

    return req_to_starts, start_counts


def _calculate_required_distance(
    G: nx.MultiDiGraph,
    required_reqs: dict[ReqId, list[EdgeRef]],
) -> float:
    """Calculate total required distance from all requirements."""
    required_dist = 0.0
    for _rid, opts in required_reqs.items():
        best = min((_edge_length_m(G, u, v, k) for (u, v, k) in opts), default=0.0)
        required_dist += best
    return required_dist


def _build_component_structure(
    G: nx.MultiDiGraph,
    required_reqs: dict[ReqId, list[EdgeRef]],
    req_to_starts: dict[ReqId, list[int]],
) -> tuple[
    dict[ReqId, int],
    dict[int, set[ReqId]],
    dict[int, set[int]],
]:
    """Build component-aware grouping for required edges."""
    # Build undirected graph of requirements
    req_repr_edge: dict[ReqId, EdgeRef] = {}
    req_graph = nx.Graph()
    for rid, opts in required_reqs.items():
        best = min(opts, key=lambda e: _edge_length_m(G, e[0], e[1], e[2]))
        req_repr_edge[rid] = best
        req_graph.add_edge(best[0], best[1])

    # Find connected components
    node_to_comp: dict[int, int] = {}
    for idx, nodes in enumerate(nx.connected_components(req_graph)):
        for node in nodes:
            node_to_comp[node] = idx

    # Map requirements to components
    req_to_comp: dict[ReqId, int] = {}
    comp_to_rids: dict[int, set[ReqId]] = {}
    for rid, edge in req_repr_edge.items():
        comp_id = node_to_comp.get(edge[0])
        if comp_id is None:
            continue
        req_to_comp[rid] = comp_id
        comp_to_rids.setdefault(comp_id, set()).add(rid)

    # Build component targets
    comp_start_counts: dict[int, dict[int, int]] = {}
    for rid, starts in req_to_starts.items():
        comp_id = req_to_comp.get(rid)
        if comp_id is None:
            continue
        comp_start_counts.setdefault(comp_id, {})
        for s in starts:
            comp_start_counts[comp_id][s] = comp_start_counts[comp_id].get(s, 0) + 1

    comp_targets: dict[int, set[int]] = {}
    for comp_id, counts in comp_start_counts.items():
        comp_targets[comp_id] = set(counts.keys())

    return req_to_comp, comp_to_rids, comp_targets


def _handle_no_global_targets(
    unvisited: set[ReqId],
    skipped_disconnected: set[ReqId],
) -> bool:
    """Handle case when no more global targets are available."""
    logger.warning(
        "Routing complete with %d unreachable segments (disconnected graph components)",
        len(unvisited),
    )
    for rid in list(unvisited):
        skipped_disconnected.add(rid)
        unvisited.discard(rid)
    return True  # Signal to break main loop


def _find_alternative_start(
    G: nx.MultiDiGraph,
    unvisited: set[ReqId],
    req_to_starts: dict[ReqId, list[int]],
    current_node: int,
    node_xy: dict[int, tuple[float, float]],
) -> int | None:
    """Try to find an alternative starting point from unvisited requirements."""
    old_node = current_node
    for rid in list(unvisited):
        for start in req_to_starts.get(rid, []):
            if start in G.nodes and G.out_degree(start) > 0:
                logger.info("Jumping to disconnected component at node %d", start)
                _log_jump_distance(old_node, start, node_xy)
                return start
    return None


def _log_jump_distance(
    old_node: int,
    new_node: int,
    node_xy: dict[int, tuple[float, float]],
) -> None:
    """Log distance of jump between disconnected components."""
    old_xy = node_xy.get(old_node)
    new_xy = node_xy.get(new_node)
    if old_xy and new_xy:
        jump_dist = GeometryService.haversine_distance(
            old_xy[0], old_xy[1], new_xy[0], new_xy[1], unit="miles"
        )
        logger.warning(
            "Route contains %.2f mile gap between disconnected components "
            "(nodes %d -> %d). Run bridge_disconnected_clusters() to fix.",
            jump_dist,
            old_node,
            new_node,
        )


def _handle_unreachable_segments(
    unvisited: set[ReqId],
    skipped_disconnected: set[ReqId],
    req_to_starts: dict[ReqId, list[int]],
    start_counts: dict[int, int],
    global_targets: set[int],
    req_to_comp: dict[ReqId, int],
    comp_targets: dict[int, set[int]],
) -> None:
    """Handle case when no reachable segments remain."""
    logger.warning(
        "Cannot reach %d remaining segments (graph disconnected). "
        "Consider running bridge_disconnected_clusters() before solving.",
        len(unvisited),
    )
    for rid in list(unvisited):
        skipped_disconnected.add(rid)
        # Remove from bookkeeping
        for s in req_to_starts.get(rid, []):
            start_counts[s] = start_counts.get(s, 1) - 1
            if start_counts.get(s, 0) <= 0:
                global_targets.discard(s)
                comp_id = req_to_comp.get(rid)
                if comp_id is not None:
                    comp_targets.get(comp_id, set()).discard(s)
    unvisited.clear()


def _skip_unreachable_component(
    active_comp: int,
    comp_to_rids: dict[int, set[ReqId]],
    unvisited: set[ReqId],
    skipped_disconnected: set[ReqId],
    req_to_starts: dict[ReqId, list[int]],
    start_counts: dict[int, int],
    global_targets: set[int],
    req_to_comp: dict[ReqId, int],
    comp_targets: dict[int, set[int]],
) -> None:
    """Skip segments in an unreachable component."""
    comp_rids = comp_to_rids.get(active_comp, set()) & unvisited
    if comp_rids:
        logger.warning(
            "Skipping %d segments in unreachable component %s",
            len(comp_rids),
            active_comp,
        )
        for rid in comp_rids:
            skipped_disconnected.add(rid)
            # Remove from bookkeeping
            for s in req_to_starts.get(rid, []):
                start_counts[s] = start_counts.get(s, 1) - 1
                if start_counts.get(s, 0) <= 0:
                    global_targets.discard(s)
                    comp_id = req_to_comp.get(rid)
                    if comp_id is not None:
                        comp_targets.get(comp_id, set()).discard(s)
            unvisited.discard(rid)


def _create_route_stats(
    total_dist: float,
    required_dist: float,
    deadhead_dist: float,
    required_reqs_count: int,
    skipped_count: int,
    iterations: int,
) -> dict[str, float]:
    """Create statistics dictionary for the route."""
    return {
        "total_distance": float(total_dist),
        "required_distance": float(required_dist),
        "deadhead_distance": float(deadhead_dist),
        "deadhead_percentage": float(
            (deadhead_dist / total_dist * 100.0) if total_dist > 0 else 0.0
        ),
        "required_reqs": float(required_reqs_count),
        "completed_reqs": float(required_reqs_count - skipped_count),
        "skipped_disconnected": float(skipped_count),
        "iterations": float(iterations),
    }


def _solve_greedy_route(
    G: nx.MultiDiGraph,
    required_reqs: dict[ReqId, list[EdgeRef]],
    start_node: int | None = None,
    req_segment_counts: dict[ReqId, int] | None = None,
    node_xy: dict[int, tuple[float, float]] | None = None,
) -> tuple[list[list[float]], dict[str, float], list[EdgeRef]]:
    """
    Solve with connectivity-first greedy strategy:

    Prefer adjacent required edges within the same component before deadheading.
    When deadheading is needed, route to the nearest required start by graph distance.

    Handles disconnected graph components gracefully by skipping unreachable segments
    rather than failing. This is common in real-world geographies with rivers, highways,
    or one-way streets that create barriers.
    """
    route_coords: list[list[float]] = []
    route_edges: list[EdgeRef] = []
    skipped_disconnected: set[ReqId] = set()

    # Initialize state
    current_node, node_xy = _initialize_route_state(G, required_reqs, start_node)
    req_to_starts, start_counts = _build_requirement_indices(required_reqs)
    unvisited: set[ReqId] = set(required_reqs.keys())

    # Calculate distances
    total_dist = 0.0
    required_dist = _calculate_required_distance(G, required_reqs)
    deadhead_dist = 0.0

    # Build component structure
    req_to_comp, comp_to_rids, comp_targets = _build_component_structure(
        G, required_reqs, req_to_starts
    )
    global_targets: set[int] = set(start_counts.keys())

    # Helper to append geometry with stitching
    def _append_coords(coords: list[list[float]]) -> None:
        if not coords:
            return
        if route_coords:
            route_coords.extend(coords[1:])
        else:
            route_coords.extend(coords)

    def _append_path_edges(path_edges: list[EdgeRef]) -> None:
        for u, v, k in path_edges:
            key = None if k == -1 else k
            geo = _get_edge_geometry(G, u, v, key, node_xy=node_xy)
            _append_coords(geo)
            route_edges.append((u, v, k))

    def _best_service_edge_from_start(rid: ReqId, start: int) -> EdgeRef:
        opts = [e for e in required_reqs[rid] if e[0] == start]
        return min(opts, key=lambda e: _edge_length_m(G, e[0], e[1], e[2]))

    def _remove_req_from_bookkeeping(rid: ReqId) -> None:
        """Remove a requirement from all tracking structures."""
        for s in req_to_starts.get(rid, []):
            start_counts[s] = start_counts.get(s, 1) - 1
            if start_counts.get(s, 0) <= 0:
                global_targets.discard(s)
                comp_id = req_to_comp.get(rid)
                if comp_id is not None:
                    comp_targets.get(comp_id, set()).discard(s)

    # Greedy loop
    iterations = 0
    active_comp: int | None = None
    max_iterations = len(required_reqs) * 3  # Safety limit to prevent infinite loops

    while unvisited and iterations < max_iterations:
        iterations += 1

        # Determine active component
        if active_comp is None or not (
            comp_to_rids.get(active_comp, set()) & unvisited
        ):
            # Jump to nearest start among all unvisited requirements
            if not global_targets:
                # No more reachable targets - remaining segments are disconnected
                logger.warning(
                    "Routing complete with %d unreachable segments (disconnected graph components)",
                    len(unvisited),
                )
                for rid in list(unvisited):
                    skipped_disconnected.add(rid)
                    unvisited.discard(rid)
                break

            result = _dijkstra_to_any_target(
                G, current_node, global_targets, weight="length"
            )
            if result is None:
                # Current position is disconnected from remaining segments
                # Try to find an alternative starting point from unvisited requirements
                # and fetch connecting road network to get there
                found_alternative = False
                old_node = current_node
                for rid in list(unvisited):
                    for start in req_to_starts.get(rid, []):
                        if start in G.nodes and G.out_degree(start) > 0:
                            current_node = start
                            found_alternative = True
                            logger.info(
                                "Jumping to disconnected component at node %d",
                                start,
                            )
                            break
                    if found_alternative:
                        break

                if not found_alternative:
                    # No reachable segments remain - skip all unvisited
                    # Note: This should rarely happen if bridge_disconnected_clusters()
                    # was called before running the solver
                    logger.warning(
                        "Cannot reach %d remaining segments (graph disconnected). "
                        "Consider running bridge_disconnected_clusters() before solving.",
                        len(unvisited),
                    )
                    for rid in list(unvisited):
                        skipped_disconnected.add(rid)
                        _remove_req_from_bookkeeping(rid)
                    unvisited.clear()
                    break

                # Note: We no longer create interpolated "teleport" paths
                # The graph should have been bridged before calling the solver.
                # If we reach here, log a warning about the jump.
                old_xy = node_xy.get(old_node)
                new_xy = node_xy.get(current_node)
                if old_xy and new_xy:
                    jump_dist = GeometryService.haversine_distance(
                        old_xy[0], old_xy[1], new_xy[0], new_xy[1], unit="miles"
                    )
                    logger.warning(
                        "Route contains %.2f mile gap between disconnected components "
                        "(nodes %d -> %d). Run bridge_disconnected_clusters() to fix.",
                        jump_dist,
                        old_node,
                        current_node,
                    )

                # Continue to process from the new starting point
                continue

            target_start, d_dead, path_edges = result
            if path_edges:
                deadhead_dist += d_dead
                total_dist += d_dead
                _append_path_edges(path_edges)
            current_node = target_start
            candidates = [
                rid for rid in unvisited if target_start in req_to_starts[rid]
            ]
            if not candidates:
                global_targets.discard(target_start)
                continue
            active_comp = req_to_comp.get(candidates[0])

        # Prefer adjacent required edges in the active component
        candidates = [
            rid
            for rid in unvisited
            if req_to_comp.get(rid) == active_comp
            and current_node in req_to_starts[rid]
        ]

        if not candidates:
            comp_target_nodes = comp_targets.get(active_comp, set())
            if not comp_target_nodes:
                active_comp = None
                continue
            result = _dijkstra_to_any_target(
                G, current_node, comp_target_nodes, weight="length"
            )
            if result is None:
                # Component is unreachable from current position
                # Skip remaining segments in this component and try another
                comp_rids = comp_to_rids.get(active_comp, set()) & unvisited
                if comp_rids:
                    logger.warning(
                        "Skipping %d segments in unreachable component %s",
                        len(comp_rids),
                        active_comp,
                    )
                    for rid in comp_rids:
                        skipped_disconnected.add(rid)
                        _remove_req_from_bookkeeping(rid)
                        unvisited.discard(rid)
                active_comp = None
                continue

            target_start, d_dead, path_edges = result
            if path_edges:
                deadhead_dist += d_dead
                total_dist += d_dead
                _append_path_edges(path_edges)
            current_node = target_start
            candidates = [
                rid
                for rid in unvisited
                if req_to_comp.get(rid) == active_comp
                and target_start in req_to_starts[rid]
            ]
            if not candidates:
                comp_targets.get(active_comp, set()).discard(target_start)
                global_targets.discard(target_start)
                continue

        def _candidate_score(
            rid: ReqId, _node: int = current_node
        ) -> tuple[float, float]:
            service_edge = _best_service_edge_from_start(rid, _node)
            seg_count = float(
                req_segment_counts.get(rid, 1) if req_segment_counts else 1
            )
            edge_len = _edge_length_m(
                G, service_edge[0], service_edge[1], service_edge[2]
            )
            return (-seg_count, -edge_len)

        chosen_rid = min(candidates, key=_candidate_score)
        service_edge = _best_service_edge_from_start(chosen_rid, current_node)
        su, sv, sk = service_edge

        # Service traversal geometry
        service_geo = _get_edge_geometry(G, su, sv, sk, node_xy=node_xy)
        _append_coords(service_geo)
        route_edges.append((su, sv, sk))

        # Dist update
        s_len = _edge_length_m(G, su, sv, sk)
        total_dist += s_len

        # Advance
        current_node = sv

        # Mark visited + update targets bookkeeping
        unvisited.remove(chosen_rid)
        for s in req_to_starts[chosen_rid]:
            start_counts[s] -= 1
            if start_counts[s] <= 0:
                global_targets.discard(s)
                comp_id = req_to_comp.get(chosen_rid)
                if comp_id is not None:
                    comp_targets.get(comp_id, set()).discard(s)

    # Log warning if segments were skipped
    if skipped_disconnected:
        logger.warning(
            "Route generation completed with %d/%d segments skipped due to disconnected graph",
            len(skipped_disconnected),
            len(required_reqs),
        )

    stats: dict[str, float] = {
        "total_distance": float(total_dist),
        "required_distance": float(required_dist),
        "deadhead_distance": float(deadhead_dist),
        "deadhead_percentage": float(
            (deadhead_dist / total_dist * 100.0) if total_dist > 0 else 0.0
        ),
        "required_reqs": float(len(required_reqs)),
        "completed_reqs": float(len(required_reqs) - len(skipped_disconnected)),
        "skipped_disconnected": float(len(skipped_disconnected)),
        "iterations": float(iterations),
    }
    return route_coords, stats, route_edges


def _max_route_gap_ft(route_coords: list[list[float]]) -> float:
    """Maximum haversine gap between consecutive route coordinates in feet."""
    max_gap = 0.0
    for idx in range(1, len(route_coords)):
        prev = route_coords[idx - 1]
        cur = route_coords[idx]
        if len(prev) < 2 or len(cur) < 2:
            continue
        d_miles = GeometryService.haversine_distance(
            prev[0],
            prev[1],
            cur[0],
            cur[1],
            unit="miles",
        )
        d_ft = d_miles * 5280.0
        if d_ft > max_gap:
            max_gap = d_ft
    return max_gap


def _validate_route(
    route_coords: list[list[float]],
    stats: dict[str, float],
    mapped_segments: int,
    total_segments: int,
) -> tuple[list[str], list[str], dict[str, float]]:
    """Validate route connectivity and coverage; return (errors, warnings, details)."""
    errors: list[str] = []
    warnings: list[str] = []
    details: dict[str, float] = {}

    if not route_coords or len(route_coords) < 2:
        errors.append("Route has insufficient coordinates.")

    coverage_ratio = (
        float(mapped_segments) / float(total_segments) if total_segments > 0 else 1.0
    )
    details["coverage_ratio"] = coverage_ratio
    if total_segments > 0 and coverage_ratio < MIN_SEGMENT_COVERAGE_RATIO:
        errors.append(
            f"Only {mapped_segments}/{total_segments} undriven segments mapped to the routing graph."
        )

    max_gap_ft = _max_route_gap_ft(route_coords)
    details["max_gap_ft"] = max_gap_ft
    if max_gap_ft > MAX_ROUTE_GAP_FT:
        gap_miles = max_gap_ft / 5280.0
        errors.append(
            f"Route contains a {max_gap_ft:.0f}ft ({gap_miles:.2f} miles) gap between points."
        )

    required_distance = float(stats.get("required_distance", 0.0))
    total_distance = float(stats.get("total_distance", 0.0))
    if total_distance <= 0:
        errors.append("Route total distance is zero.")

    deadhead_ratio = (
        total_distance / required_distance if required_distance > 0 else 0.0
    )
    details["deadhead_ratio"] = deadhead_ratio
    if deadhead_ratio > MAX_DEADHEAD_RATIO_ERROR:
        errors.append(f"Deadhead ratio {deadhead_ratio:.2f} exceeds maximum threshold.")
    elif deadhead_ratio > MAX_DEADHEAD_RATIO_WARN:
        warnings.append(
            f"Deadhead ratio {deadhead_ratio:.2f} is high; route may be inefficient."
        )

    return errors, warnings, details


async def fill_route_gaps(
    route_coords: list[list[float]],
    max_gap_ft: float = 1000.0,
    progress_callback: Any | None = None,
) -> list[list[float]]:
    """
    Fill gaps in a route with actual driving routes from Mapbox.

    This is a simple post-processing step that finds any gaps larger than
    max_gap_ft and fetches real driving routes to fill them.

    Args:
        route_coords: List of [lon, lat] coordinates
        max_gap_ft: Threshold gap size in feet to trigger filling
        progress_callback: Optional async callback(stage, pct, message)

    Returns:
        Route coordinates with gaps filled
    """
    if len(route_coords) < 2:
        return route_coords

    from graph_connectivity import fetch_bridge_route

    gaps_to_fill: list[tuple[int, float]] = []  # (index, gap_ft)

    # Find gaps
    for i in range(1, len(route_coords)):
        prev = route_coords[i - 1]
        cur = route_coords[i]
        if len(prev) < 2 or len(cur) < 2:
            continue

        d_miles = GeometryService.haversine_distance(
            prev[0], prev[1], cur[0], cur[1], unit="miles"
        )
        d_ft = d_miles * 5280.0

        if d_ft > max_gap_ft:
            gaps_to_fill.append((i, d_ft))

    if not gaps_to_fill:
        logger.info("No gaps > %.0f ft found in route", max_gap_ft)
        return route_coords

    logger.info("Found %d gaps to fill in route", len(gaps_to_fill))

    # Fill gaps (process in reverse order to preserve indices)
    filled_coords = list(route_coords)
    gaps_filled = 0

    for idx, (gap_idx, gap_ft) in enumerate(reversed(gaps_to_fill)):
        if progress_callback:
            pct = int((idx + 1) / len(gaps_to_fill) * 100)
            await progress_callback(
                "filling_gaps",
                pct,
                f"Filling gap {idx + 1}/{len(gaps_to_fill)} ({gap_ft / 5280:.2f} mi)",
            )

        prev = filled_coords[gap_idx - 1]
        cur = filled_coords[gap_idx]

        from_xy = (prev[0], prev[1])
        to_xy = (cur[0], cur[1])

        # Fetch route from Mapbox
        bridge_coords = await fetch_bridge_route(from_xy, to_xy)

        if bridge_coords and len(bridge_coords) >= 2:
            # Insert the bridge coordinates (excluding first/last which are the gap endpoints)
            # to avoid duplicating points
            insert_coords = bridge_coords[1:-1] if len(bridge_coords) > 2 else []
            if insert_coords:
                filled_coords = (
                    filled_coords[:gap_idx] + insert_coords + filled_coords[gap_idx:]
                )
            gaps_filled += 1
            logger.debug(
                "Filled gap at index %d with %d coordinates",
                gap_idx,
                len(insert_coords),
            )
        else:
            logger.warning(
                "Could not fill gap at index %d (%.2f mi) - Mapbox returned no route",
                gap_idx,
                gap_ft / 5280,
            )

    logger.info("Filled %d/%d gaps in route", gaps_filled, len(gaps_to_fill))
    return filled_coords


async def generate_optimal_route_with_progress(
    location_id: str,
    task_id: str,
    start_coords: tuple[float, float] | None = None,  # (lon, lat)
) -> dict[str, Any]:
    # Create progress tracker for optimal route progress collection
    tracker = ProgressTracker(
        task_id,
        optimal_route_progress_collection,
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

        obj_id = ObjectId(location_id)
        area = await find_one_with_retry(coverage_metadata_collection, {"_id": obj_id})
        if not area:
            raise ValueError(f"Coverage area {location_id} not found")

        location_info = area.get("location", {})
        location_name = location_info.get("display_name", "Unknown")

        await update_progress(
            "loading_area", 10, f"Loading coverage area: {location_name}"
        )

        # Validate that the coverage area has a valid geometry
        boundary_geom = location_info.get("geojson", {}).get("geometry")
        if not boundary_geom:
            bbox = location_info.get("boundingbox")
            if not (bbox and len(bbox) >= 4):
                raise ValueError("No valid boundary for coverage area")

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
            await tracker.complete("All streets already driven!")
            return {
                "status": "already_complete",
                "message": "All streets already driven!",
            }

        await update_progress(
            "loading_segments", 30, f"Found {len(undriven)} undriven segments to route"
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
                # Import and use the preprocessing function
                from preprocess_streets import preprocess_streets

                # Get the location data for preprocessing
                loc_data = location_info.copy()
                loc_data["_id"] = location_id

                # Ensure storage directory exists
                GRAPH_STORAGE_DIR.mkdir(parents=True, exist_ok=True)

                await preprocess_streets(loc_data, task_id)

                await update_progress(
                    "loading_graph", 44, "Graph downloaded successfully, loading..."
                )
            except Exception as e:
                logger.error("Failed to auto-generate graph: %s", e)
                raise ValueError(
                    f"Failed to download street network from OpenStreetMap: {e}. "
                    f"This may be due to rate limiting or network issues. Please try again later."
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
            logger.error("Failed to load graph from disk: %s", e)
            raise ValueError(f"Failed to load street network: {e}")

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
        len(undriven)

        node_xy: dict[int, tuple[float, float]] = {
            n: (float(G.nodes[n]["x"]), float(G.nodes[n]["y"]))
            for n in G.nodes
            if "x" in G.nodes[n] and "y" in G.nodes[n]
        }
        osmid_index = _build_osmid_index(G)
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
        from concurrent.futures import ThreadPoolExecutor

        unmatched_indices = []

        # Helper function for the thread pool
        def process_segment_osmid(data):
            if data is None:
                return None
            return _try_match_osmid(
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
                executor.map(process_segment_osmid, seg_data_list)
            ):
                processed_segments = i + 1
                if seg_data_list[i] is None:
                    if (
                        processed_segments == total_for_progress
                        or processed_segments % progress_interval == 0
                        or time.monotonic() - last_update >= 1.0
                    ):
                        progress_pct = 50 + int(
                            8 * processed_segments / total_for_progress
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
                    rid, options = _make_req_id(G, edge)
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
                    rid, options = _make_req_id(G, edge)
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
                logger.error("Batch spatial lookup failed: %s", e)
                # Fallback to individual lookup if batch fails (unlikely)
                last_update = time.monotonic()
                progress_interval = max(10, max(1, fallback_total) // 25)
                for i, _idx in enumerate(valid_unmatched_indices, start=1):
                    try:
                        u, v, k = ox.distance.nearest_edges(G, X[i], Y[i])
                        edge = (int(u), int(v), int(k))
                        rid, options = _make_req_id(G, edge)
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
            raise ValueError("Could not map any segments to street network")

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
                    ox.distance.nearest_nodes(G, start_coords[0], start_coords[1])
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
            route_coords, stats, _ = _solve_greedy_route(
                G,
                required_reqs,
                start_node_id,
                req_segment_counts=req_segment_counts,
            )
        except Exception as e:
            logger.error("Greedy solver failed: %s", e, exc_info=True)
            raise ValueError(f"Route solver failed: {e}")

        if not route_coords:
            raise ValueError("Failed to generate route coordinates")

        # Fill gaps in the route with Mapbox driving directions
        await update_progress(
            "filling_gaps", 85, "Filling route gaps with driving routes..."
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

        errors, warnings, validation_details = _validate_route(
            route_coords, stats, mapped_segments, len(undriven)
        )
        if errors:
            raise ValueError(f"Validation failed: {'; '.join(errors)}")

        logger.info("Route generation finished. Updating DB status to completed.")
        try:
            await tracker.complete("Route generation complete!")
        except Exception as update_err:
            logger.error("Final DB progress update failed: %s", update_err)
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
    task_id = f"manual_{ObjectId()}"
    return await generate_optimal_route_with_progress(
        location_id, task_id, start_coords
    )


async def save_optimal_route(location_id: str, route_result: dict[str, Any]) -> None:
    if route_result.get("status") != "success":
        return

    try:
        route_doc = dict(route_result)
        await update_one_with_retry(
            coverage_metadata_collection,
            {"_id": ObjectId(location_id)},
            {
                "$set": {
                    "optimal_route": route_doc,
                    "optimal_route_metadata": {
                        "generated_at": datetime.now(UTC),
                        "distance_meters": route_result.get("total_distance_m"),
                        "required_edge_count": route_result.get("required_edge_count"),
                        "undriven_segments_loaded": route_result.get(
                            "undriven_segments_loaded"
                        ),
                        "segment_coverage_ratio": route_result.get(
                            "segment_coverage_ratio"
                        ),
                    },
                }
            },
        )
        logger.info("Saved optimal route for location %s", location_id)
    except Exception as e:
        logger.error("Failed to save optimal route: %s", e)
