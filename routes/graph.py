import contextlib
import heapq

import networkx as nx
from shapely.geometry import LineString

from .constants import FEET_PER_METER, MAX_OSM_MATCH_DISTANCE_FT
from .types import EdgeRef


def edge_length_m(G: nx.Graph, u: int, v: int, key: int | None = None) -> float:
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


def pick_best_key(G: nx.Graph, u: int, v: int, weight: str = "length") -> int | None:
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


def get_edge_geometry(
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
                key = pick_best_key(G, u, v)  # may still be None
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


def edge_linestring(
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
    coords = get_edge_geometry(G, u, v, key, node_xy=node_xy)
    if len(coords) < 2:
        return None
    try:
        line = LineString(coords)
    except Exception:
        return None
    if cache is not None:
        cache[cache_key] = line
    return line


def build_osmid_index(G: nx.MultiDiGraph) -> dict[int, list[EdgeRef]]:
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


def try_match_osmid(
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
        edge_line = edge_linestring(
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


def dijkstra_to_any_target(
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


def reverse_candidates_for_edge(
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
