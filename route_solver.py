"""
Optimal route solver using a connectivity-first greedy coverage strategy.

Key updates:
- Buffer routing graph to avoid artificial disconnections at coverage boundaries.
- Map undriven segments to OSM edges using OSM IDs when available (fallback to nearest).
- Prefer continuing along adjacent undriven edges before deadheading.
- Remove teleport fallback: all geometry stays on-network.
- Validate coverage, gaps, and deadhead ratio before returning.
"""

import contextlib
import heapq
import logging
import math
from datetime import UTC, datetime
from typing import Any

import geopandas as gpd
import networkx as nx
import osmnx as ox
from bson import ObjectId
from shapely.geometry import LineString, box, shape

from db import (
    coverage_metadata_collection,
    find_one_with_retry,
    optimal_route_progress_collection,
    streets_collection,
    update_one_with_retry,
)

logger = logging.getLogger(__name__)

MAX_SEGMENTS = 5000
ROUTING_BUFFER_M = 500.0
MAX_ROUTE_GAP_M = 3000.0
MAX_DEADHEAD_RATIO_WARN = 6.0
MAX_DEADHEAD_RATIO_ERROR = 10.0
MIN_SEGMENT_COVERAGE_RATIO = 0.9
MAX_OSM_MATCH_DISTANCE_M = 500.0

EdgeRef = tuple[int, int, int]  # (u, v, key)
ReqId = frozenset[
    EdgeRef
]  # physical-ish edge requirement; can include reverse if present


def _haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Haversine distance in meters for lon/lat degrees."""
    r = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    )
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def _buffer_polygon_for_routing(polygon: Any, buffer_m: float) -> Any:
    """Buffer a WGS84 polygon by meters (project to UTM, buffer, reproject)."""
    if buffer_m <= 0:
        return polygon
    try:
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
        if isinstance(osmids, (list, set, tuple)):
            candidates = osmids
        else:
            candidates = [osmids]
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


def _map_segment_to_edge(
    G: nx.MultiDiGraph,
    coords: list[list[float]],
    osmid: int | None,
    osmid_index: dict[int, list[EdgeRef]],
    *,
    node_xy: dict[int, tuple[float, float]] | None = None,
    line_cache: dict[EdgeRef, LineString] | None = None,
) -> EdgeRef | None:
    """Map a segment geometry to a routing edge (OSM ID first, nearest fallback)."""
    seg_mid = _segment_midpoint(coords)
    seg_line = None
    if coords and len(coords) >= 2:
        with contextlib.suppress(Exception):
            seg_line = LineString(coords)
    if osmid is not None:
        candidates = osmid_index.get(osmid, [])
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
            if not edge_line or not seg_line:
                continue
            d_deg = edge_line.distance(seg_line)
            d_m = d_deg * 111_000.0
            if d_m < best_dist:
                best_dist = d_m
                best_edge = (u, v, k)
        if best_edge and best_dist <= MAX_OSM_MATCH_DISTANCE_M:
            return best_edge

    if not seg_mid:
        return None
    try:
        u, v, k = ox.distance.nearest_edges(G, seg_mid[0], seg_mid[1])
        return (int(u), int(v), int(k))
    except Exception:
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


def _solve_greedy_route(
    G: nx.MultiDiGraph,
    required_reqs: dict[ReqId, list[EdgeRef]],
    start_node: int | None = None,
    req_segment_counts: dict[ReqId, int] | None = None,
) -> tuple[list[list[float]], dict[str, float], list[EdgeRef]]:
    """
    Solve with connectivity-first greedy strategy:

    Prefer adjacent required edges within the same component before deadheading.
    When deadheading is needed, route to the nearest required start by graph distance.
    """
    route_coords: list[list[float]] = []
    route_edges: list[EdgeRef] = []

    # Pre-calc node coordinates
    node_xy: dict[int, tuple[float, float]] = {
        n: (float(G.nodes[n]["x"]), float(G.nodes[n]["y"]))
        for n in G.nodes
        if "x" in G.nodes[n] and "y" in G.nodes[n]
    }

    # Initialize current
    if start_node is not None and start_node in G.nodes:
        current_node = start_node
    else:
        # pick any requirement start node if possible
        any_req = next(iter(required_reqs.values()))
        current_node = any_req[0][0]  # u of first option

    # Build start-node counts for early-exit Dijkstra targets
    req_to_starts: dict[ReqId, list[int]] = {}
    start_counts: dict[int, int] = {}

    for rid, opts in required_reqs.items():
        starts = sorted({u for (u, _, _) in opts})
        req_to_starts[rid] = starts
        for s in starts:
            start_counts[s] = start_counts.get(s, 0) + 1

    unvisited: set[ReqId] = set(required_reqs.keys())

    # Stats
    total_dist = 0.0
    required_dist = 0.0
    deadhead_dist = 0.0

    # Required distance: count each requirement once (best of its options)
    for _rid, opts in required_reqs.items():
        best = min((_edge_length_m(G, u, v, k) for (u, v, k) in opts), default=0.0)
        required_dist += best

    # Component-aware grouping (undirected connectivity on required edges)
    req_repr_edge: dict[ReqId, EdgeRef] = {}
    req_graph = nx.Graph()
    for rid, opts in required_reqs.items():
        best = min(opts, key=lambda e: _edge_length_m(G, e[0], e[1], e[2]))
        req_repr_edge[rid] = best
        req_graph.add_edge(best[0], best[1])

    node_to_comp: dict[int, int] = {}
    for idx, nodes in enumerate(nx.connected_components(req_graph)):
        for node in nodes:
            node_to_comp[node] = idx

    req_to_comp: dict[ReqId, int] = {}
    comp_to_rids: dict[int, set[ReqId]] = {}
    for rid, edge in req_repr_edge.items():
        comp_id = node_to_comp.get(edge[0])
        if comp_id is None:
            continue
        req_to_comp[rid] = comp_id
        comp_to_rids.setdefault(comp_id, set()).add(rid)

    comp_start_counts: dict[int, dict[int, int]] = {}
    comp_targets: dict[int, set[int]] = {}
    for rid, starts in req_to_starts.items():
        comp_id = req_to_comp.get(rid)
        if comp_id is None:
            continue
        comp_start_counts.setdefault(comp_id, {})
        for s in starts:
            comp_start_counts[comp_id][s] = comp_start_counts[comp_id].get(s, 0) + 1

    for comp_id, counts in comp_start_counts.items():
        comp_targets[comp_id] = set(counts.keys())

    global_targets: set[int] = set(start_counts.keys())

    # Helper to append geometry with stitching
    def _append_coords(coords: list[list[float]]) -> None:
        nonlocal route_coords
        if not coords:
            return
        if route_coords:
            route_coords.extend(coords[1:])
        else:
            route_coords.extend(coords)

    def _append_path_edges(path_edges: list[EdgeRef]) -> None:
        nonlocal route_edges
        for u, v, k in path_edges:
            key = None if k == -1 else k
            geo = _get_edge_geometry(G, u, v, key, node_xy=node_xy)
            _append_coords(geo)
            route_edges.append((u, v, k))

    def _best_service_edge_from_start(rid: ReqId, start: int) -> EdgeRef:
        opts = [e for e in required_reqs[rid] if e[0] == start]
        return min(opts, key=lambda e: _edge_length_m(G, e[0], e[1], e[2]))

    # Greedy loop
    iterations = 0
    active_comp: int | None = None

    while unvisited:
        iterations += 1

        # Determine active component
        if active_comp is None or not (comp_to_rids.get(active_comp, set()) & unvisited):
            # Jump to nearest start among all unvisited requirements
            if not global_targets:
                raise ValueError("No remaining target nodes for routing")
            result = _dijkstra_to_any_target(G, current_node, global_targets, weight="length")
            if result is None:
                raise ValueError(
                    "Routing graph disconnected from remaining undriven segments"
                )
            target_start, d_dead, path_edges = result
            if path_edges:
                deadhead_dist += d_dead
                total_dist += d_dead
                _append_path_edges(path_edges)
            current_node = target_start
            candidates = [rid for rid in unvisited if target_start in req_to_starts[rid]]
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
            result = _dijkstra_to_any_target(G, current_node, comp_target_nodes, weight="length")
            if result is None:
                raise ValueError(
                    "Routing graph disconnected within required-edge component"
                )
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

        def _candidate_score(rid: ReqId) -> tuple[float, float]:
            service_edge = _best_service_edge_from_start(rid, current_node)
            seg_count = float(req_segment_counts.get(rid, 1) if req_segment_counts else 1)
            edge_len = _edge_length_m(G, service_edge[0], service_edge[1], service_edge[2])
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

    stats: dict[str, float] = {
        "total_distance": float(total_dist),
        "required_distance": float(required_dist),
        "deadhead_distance": float(deadhead_dist),
        "deadhead_percentage": float(
            (deadhead_dist / total_dist * 100.0) if total_dist > 0 else 0.0
        ),
        "required_reqs": float(len(required_reqs)),
        "iterations": float(iterations),
    }
    return route_coords, stats, route_edges


def _max_route_gap_m(route_coords: list[list[float]]) -> float:
    """Maximum haversine gap between consecutive route coordinates."""
    max_gap = 0.0
    for idx in range(1, len(route_coords)):
        prev = route_coords[idx - 1]
        cur = route_coords[idx]
        if len(prev) < 2 or len(cur) < 2:
            continue
        d = _haversine_m(prev[0], prev[1], cur[0], cur[1])
        if d > max_gap:
            max_gap = d
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
        float(mapped_segments) / float(total_segments)
        if total_segments > 0
        else 1.0
    )
    details["coverage_ratio"] = coverage_ratio
    if total_segments > 0 and coverage_ratio < MIN_SEGMENT_COVERAGE_RATIO:
        errors.append(
            f"Only {mapped_segments}/{total_segments} undriven segments mapped to the routing graph."
        )

    max_gap = _max_route_gap_m(route_coords)
    details["max_gap_m"] = max_gap
    if max_gap > MAX_ROUTE_GAP_M:
        errors.append(f"Route contains a {max_gap:.1f}m gap between points.")

    required_distance = float(stats.get("required_distance", 0.0))
    total_distance = float(stats.get("total_distance", 0.0))
    if total_distance <= 0:
        errors.append("Route total distance is zero.")

    deadhead_ratio = (
        total_distance / required_distance if required_distance > 0 else 0.0
    )
    details["deadhead_ratio"] = deadhead_ratio
    if deadhead_ratio > MAX_DEADHEAD_RATIO_ERROR:
        errors.append(
            f"Deadhead ratio {deadhead_ratio:.2f} exceeds maximum threshold."
        )
    elif deadhead_ratio > MAX_DEADHEAD_RATIO_WARN:
        warnings.append(
            f"Deadhead ratio {deadhead_ratio:.2f} is high; route may be inefficient."
        )

    return errors, warnings, details


async def _update_db_progress(
    task_id: str,
    location_id: str,
    stage: str,
    progress: int,
    message: str,
    status: str = "running",
    error: str | None = None,
) -> None:
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
    start_coords: tuple[float, float] | None = None,  # (lon, lat)
) -> dict[str, Any]:
    async def update_progress(stage: str, progress: int, message: str) -> None:
        await _update_db_progress(task_id, location_id, stage, progress, message)
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

        await update_progress("fetching_osm", 40, "Downloading OSM street network...")

        routing_polygon = _buffer_polygon_for_routing(polygon, ROUTING_BUFFER_M)

        try:
            # Keep it directed so we respect one-ways.
            G = ox.graph_from_polygon(
                routing_polygon,
                network_type="drive",
                simplify=True,
                truncate_by_edge=True,
                retain_all=True,
            )
            if not isinstance(G, nx.MultiDiGraph):
                # OSMnx should give MultiDiGraph; but keep it safe.
                G = nx.MultiDiGraph(G)
            await update_progress(
                "fetching_osm",
                45,
                f"Downloaded network: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges",
            )
        except Exception as e:
            logger.error("Failed to download OSM data: %s", e)
            raise ValueError(f"Failed to download street network: {e}")

        await update_progress(
            "mapping_segments",
            50,
            "Mapping segments to street network (OSM ID + nearest fallback)...",
        )

        required_reqs: dict[ReqId, list[EdgeRef]] = {}
        req_segment_counts: dict[ReqId, int] = {}
        skipped = 0
        mapped_segments = 0
        total_segs = len(undriven)

        node_xy: dict[int, tuple[float, float]] = {
            n: (float(G.nodes[n]["x"]), float(G.nodes[n]["y"]))
            for n in G.nodes
            if "x" in G.nodes[n] and "y" in G.nodes[n]
        }
        osmid_index = _build_osmid_index(G)
        edge_line_cache: dict[EdgeRef, LineString] = {}

        for idx, seg in enumerate(undriven):
            if idx % 250 == 0 and idx > 0:
                pct = 50 + int((idx / total_segs) * 15)
                await update_progress(
                    "mapping_segments", pct, f"Mapping segment {idx}/{total_segs}..."
                )

            geom = seg.get("geometry", {})
            coords = geom.get("coordinates", [])
            if not coords or len(coords) < 2:
                skipped += 1
                continue

            osmid_raw = seg.get("properties", {}).get("osm_id")
            osmid = None
            if osmid_raw is not None:
                with contextlib.suppress(Exception):
                    osmid = int(osmid_raw)
            edge = _map_segment_to_edge(
                G,
                coords,
                osmid,
                osmid_index,
                node_xy=node_xy,
                line_cache=edge_line_cache,
            )
            if not edge:
                skipped += 1
                continue

            rid, options = _make_req_id(G, edge)
            if rid not in required_reqs:
                required_reqs[rid] = options
                req_segment_counts[rid] = 1
            else:
                req_segment_counts[rid] += 1
            mapped_segments += 1

        if not required_reqs:
            raise ValueError("Could not map any segments to street network")

        await update_progress(
            "mapping_segments",
            65,
            f"Mapped {len(required_reqs)} required edges ({skipped} segments skipped; note MAX_SEGMENTS may truncate).",
        )

        # Determine start node
        start_node_id: int | None = None
        if start_coords:
            with contextlib.suppress(Exception):
                start_node_id = int(
                    ox.distance.nearest_nodes(G, start_coords[0], start_coords[1])
                )

        await update_progress(
            "routing",
            75,
            f"Computing greedy route for {len(required_reqs)} required edges...",
        )

        try:
            route_coords, stats, route_edges = _solve_greedy_route(
                G,
                required_reqs,
                start_node_id,
                req_segment_counts=req_segment_counts,
            )
        except Exception as e:
            logger.error("Greedy solver failed: %s", e, exc_info=True)
            raise ValueError(f"Route solver failed: {e}")

        await update_progress("finalizing", 90, "Finalizing route geometry...")

        if not route_coords:
            raise ValueError("Failed to generate route coordinates")

        errors, warnings, validation_details = _validate_route(
            route_coords, stats, mapped_segments, len(undriven)
        )
        if errors:
            raise ValueError("Validation failed: " + "; ".join(errors))

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
