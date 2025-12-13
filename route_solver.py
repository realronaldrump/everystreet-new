"""
Optimal route solver using a robust Greedy "nearest required edge" strategy.

Key fixes vs prior version:
- Preserve directionality (do NOT convert to undirected)
- Preserve MultiGraph edge keys: required edges are (u, v, key)
- Map undriven segments to OSM edges via ox.distance.nearest_edges (service edges only)
- Choose next required edge by *graph* distance (early-exit Dijkstra to any required start node)
- Geometry is reversed automatically when traversal direction differs
- Teleport fallback draws a straight line AND counts distance (haversine) for honest stats
"""

import contextlib
import heapq
import logging
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Iterable

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
        return [(v, u, rk) for rk in G[v][u].keys()]
    except Exception:
        return [(v, u, rk) for rk in G[v][u].keys()]


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
) -> tuple[list[list[float]], dict[str, float]]:
    """
    Solve with greedy strategy:
    Repeatedly deadhead to the nearest reachable required-start node (by graph distance),
    traverse one required edge, mark it visited.
    """
    route_coords: list[list[float]] = []

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

    targets: set[int] = set(start_counts.keys())
    unvisited: set[ReqId] = set(required_reqs.keys())

    # Stats
    total_dist = 0.0
    required_dist = 0.0
    deadhead_dist = 0.0
    teleport_dist = 0.0
    teleport_count = 0

    # Required distance: count each requirement once (best of its options)
    for rid, opts in required_reqs.items():
        best = min((_edge_length_m(G, u, v, k) for (u, v, k) in opts), default=0.0)
        required_dist += best

    # Helper to append geometry with stitching
    def _append_coords(coords: list[list[float]]) -> None:
        nonlocal route_coords
        if not coords:
            return
        if route_coords:
            route_coords.extend(coords[1:])
        else:
            route_coords.extend(coords)

    # Greedy loop
    iterations = 0
    while unvisited:
        iterations += 1

        # Find nearest reachable start node for ANY unvisited requirement
        # If current targets include starts for already-visited reqs, that’s okay; we’ll pick an unvisited req at that start.
        result = _dijkstra_to_any_target(G, current_node, targets, weight="length")

        if result is None:
            # Disconnected from remaining requirements: teleport to an arbitrary remaining start node
            rid = next(iter(unvisited))
            start_node_choice = req_to_starts[rid][0]
            if current_node in node_xy and start_node_choice in node_xy:
                (cx, cy) = node_xy[current_node]
                (tx, ty) = node_xy[start_node_choice]
                # draw straight connector and count haversine
                _append_coords([[cx, cy], [tx, ty]])
                dtele = _haversine_m(cx, cy, tx, ty)
                teleport_dist += dtele
                deadhead_dist += dtele
                total_dist += dtele
                teleport_count += 1
            current_node = start_node_choice
            continue

        target_start, d_dead, path_edges = result

        # Deadhead: add geometry along path
        if path_edges:
            deadhead_dist += d_dead
            total_dist += d_dead
            for u, v, k in path_edges:
                key = None if k == -1 else k
                geo = _get_edge_geometry(G, u, v, key, node_xy=node_xy)
                _append_coords(geo)

        current_node = target_start

        # Pick an unvisited requirement that can start at this node
        candidates: list[ReqId] = [
            rid for rid in unvisited if target_start in req_to_starts[rid]
        ]
        if not candidates:
            # target_start still has counts > 0 (due to bookkeeping), but nothing unvisited starts here.
            # Clean it up and retry.
            targets.discard(target_start)
            continue

        # Choose the candidate whose service edge from this start is shortest (simple tie-breaker)
        def _best_service_edge_from_start(rid: ReqId) -> EdgeRef:
            opts = [e for e in required_reqs[rid] if e[0] == target_start]
            return min(opts, key=lambda e: _edge_length_m(G, e[0], e[1], e[2]))

        chosen_rid = min(
            candidates,
            key=lambda rid: _edge_length_m(G, *_best_service_edge_from_start(rid)),
        )
        service_edge = _best_service_edge_from_start(chosen_rid)
        su, sv, sk = service_edge

        # Service traversal geometry
        service_geo = _get_edge_geometry(G, su, sv, sk, node_xy=node_xy)
        _append_coords(service_geo)

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
                targets.discard(s)

    stats: dict[str, float] = {
        "total_distance": float(total_dist),
        "required_distance": float(required_dist),
        "deadhead_distance": float(deadhead_dist),
        "teleport_distance": float(teleport_dist),
        "teleport_count": float(teleport_count),
        "deadhead_percentage": float(
            (deadhead_dist / total_dist * 100.0) if total_dist > 0 else 0.0
        ),
        "required_reqs": float(len(required_reqs)),
        "iterations": float(iterations),
    }
    return route_coords, stats


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

        try:
            # Keep it directed so we respect one-ways.
            G = ox.graph_from_polygon(
                polygon,
                network_type="drive",
                simplify=True,
                truncate_by_edge=True,
            )
            if not isinstance(G, (nx.MultiDiGraph,)):
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
            "Mapping segments to street network (nearest_edges)...",
        )

        required_reqs: dict[ReqId, list[EdgeRef]] = {}
        skipped = 0
        total_segs = len(undriven)

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

            # Use a representative point for snapping (midpoint)
            try:
                ls = LineString(coords)
                mid = ls.interpolate(0.5, normalized=True)
                mx, my = float(mid.x), float(mid.y)
            except Exception:
                # fallback to average of endpoints
                mx = float((coords[0][0] + coords[-1][0]) / 2.0)
                my = float((coords[0][1] + coords[-1][1]) / 2.0)

            try:
                # nearest_edges expects x=lon, y=lat
                u, v, k = ox.distance.nearest_edges(G, mx, my)
                edge: EdgeRef = (int(u), int(v), int(k))

                rid, options = _make_req_id(G, edge)
                # Deduplicate requirements
                if rid not in required_reqs:
                    required_reqs[rid] = options
            except Exception:
                skipped += 1
                continue

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
            route_coords, stats = _solve_greedy_route(G, required_reqs, start_node_id)
        except Exception as e:
            logger.error("Greedy solver failed: %s", e, exc_info=True)
            raise ValueError(f"Route solver failed: {e}")

        await update_progress("finalizing", 90, "Finalizing route geometry...")

        if not route_coords:
            raise ValueError("Failed to generate route coordinates")

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
            "route_coordinates": route_coords,
            "total_distance_m": stats["total_distance"],
            "required_distance_m": stats["required_distance"],
            "deadhead_distance_m": stats["deadhead_distance"],
            "deadhead_percentage": stats["deadhead_percentage"],
            "teleport_distance_m": stats["teleport_distance"],
            "teleport_count": int(stats["teleport_count"]),
            # More honest counts:
            "undriven_segments_loaded": len(undriven),
            "required_edge_count": int(stats["required_reqs"]),
            "iterations": int(stats["iterations"]),
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
    task_id = f"manual_{ObjectId()}"
    return await generate_optimal_route_with_progress(
        location_id, task_id, start_coords
    )


async def save_optimal_route(location_id: str, route_result: dict[str, Any]) -> None:
    if route_result.get("status") != "success":
        return

    try:
        await update_one_with_retry(
            coverage_metadata_collection,
            {"_id": ObjectId(location_id)},
            {
                "$set": {
                    "location.optimal_route_data": route_result,
                    "location.optimal_route_metadata": {
                        "generated_at": datetime.now(UTC),
                        "distance_meters": route_result.get("total_distance_m"),
                        "required_edge_count": route_result.get("required_edge_count"),
                        "undriven_segments_loaded": route_result.get(
                            "undriven_segments_loaded"
                        ),
                    },
                }
            },
        )
        logger.info("Saved optimal route for location %s", location_id)
    except Exception as e:
        logger.error("Failed to save optimal route: %s", e)
