import contextlib
import heapq
import logging
import math
from collections.abc import Callable

import networkx as nx
from shapely.geometry import LineString

from .constants import FEET_PER_METER, MAX_OSM_MATCH_DISTANCE_FT
from .types import EdgeRef

logger = logging.getLogger(__name__)


def _identity_xy(x: float, y: float) -> tuple[float, float]:
    return float(x), float(y)


def _get_crs_obj(G: nx.Graph) -> object | None:
    crs = getattr(G, "graph", {}).get("crs") if hasattr(G, "graph") else None
    if crs is None:
        return None
    with contextlib.suppress(Exception):
        import pyproj

        return pyproj.CRS.from_user_input(crs)
    return None


def _is_projected_graph(G: nx.Graph) -> bool:
    crs_obj = _get_crs_obj(G)
    return bool(getattr(crs_obj, "is_projected", False))


def _meters_per_graph_unit(G: nx.Graph) -> float | None:
    crs_obj = _get_crs_obj(G)
    if crs_obj is None or not getattr(crs_obj, "is_projected", False):
        return None

    axis_info = getattr(crs_obj, "axis_info", None) or []
    if axis_info:
        factor = getattr(axis_info[0], "unit_conversion_factor", None)
        with contextlib.suppress(Exception):
            if factor is not None and float(factor) > 0:
                return float(factor)

    # Most projected OSMnx graphs use meter units.
    return 1.0


def _reference_latitude(G: nx.Graph) -> float:
    ys: list[float] = []
    for _n, data in G.nodes(data=True):
        y = data.get("y")
        if y is None:
            continue
        with contextlib.suppress(Exception):
            ys.append(float(y))
        if len(ys) >= 256:
            break
    if not ys:
        return 0.0
    return float(sum(ys) / len(ys))


def graph_units_to_feet(G: nx.Graph, distance: float) -> float:
    """
    Convert a distance measured in the graph's coordinate units to feet.

    OSMnx returns distances from nearest-node/edge queries in the same
    units as the graph's CRS. For accurate distance-based thresholds, use a
    projected graph. This function still provides a latitude-aware fallback
    when only geographic degrees are available.
    """
    try:
        distance = float(distance)
    except Exception:
        return float("inf")

    meters_per_unit = _meters_per_graph_unit(G)
    if meters_per_unit is not None:
        return distance * meters_per_unit * FEET_PER_METER

    lat = _reference_latitude(G)
    lat_rad = math.radians(lat)
    meters_per_lat = (
        111_132.92
        - 559.82 * math.cos(2 * lat_rad)
        + 1.175 * math.cos(4 * lat_rad)
    )
    meters_per_lon = 111_412.84 * math.cos(lat_rad) - 93.5 * math.cos(3 * lat_rad)
    meters_per_degree = (abs(meters_per_lat) + abs(meters_per_lon)) / 2.0
    return distance * meters_per_degree * FEET_PER_METER


def _build_point_projector(
    src_crs: object | None,
    dst_crs: object | None,
) -> Callable[[float, float], tuple[float, float]] | None:
    if src_crs is None or dst_crs is None:
        return None
    with contextlib.suppress(Exception):
        if src_crs == dst_crs:
            return _identity_xy

    try:
        import pyproj

        transformer = pyproj.Transformer.from_crs(
            src_crs,
            dst_crs,
            always_xy=True,
        )
    except Exception:
        return None

    def _project_xy(x: float, y: float) -> tuple[float, float]:
        px, py = transformer.transform(float(x), float(y))
        return float(px), float(py)

    return _project_xy


def prepare_spatial_matching_graph(
    G: nx.MultiDiGraph,
) -> tuple[nx.MultiDiGraph, Callable[[float, float], tuple[float, float]]]:
    """
    Return a projected graph plus point-projector for accurate matching.

    Falls back to the original graph and identity projector if projection
    cannot be prepared.
    """
    source_crs = None
    with contextlib.suppress(Exception):
        import pyproj

        source_crs = pyproj.CRS.from_epsg(4326)

    if _is_projected_graph(G):
        projector = _build_point_projector(source_crs, _get_crs_obj(G))
        if projector is None:
            logger.warning(
                "Projected graph is missing CRS transform metadata; using identity projector.",
            )
            return G, _identity_xy
        return G, projector

    try:
        import osmnx as ox

        projected = ox.projection.project_graph(G)
    except Exception as exc:
        logger.warning(
            "Failed to project graph for spatial matching; using original CRS: %s",
            exc,
        )
        return G, _identity_xy

    projector = _build_point_projector(source_crs, _get_crs_obj(projected))
    if projector is None:
        logger.warning(
            "Missing CRS metadata for projected matching; using original graph.",
        )
        return G, _identity_xy

    return projected, projector


def project_linestring_coords(
    coords: list[list[float]],
    project_xy: Callable[[float, float], tuple[float, float]],
) -> list[list[float]] | None:
    """Project a [x, y] coordinate sequence to the matching graph's CRS."""
    projected: list[list[float]] = []
    for pt in coords:
        if not isinstance(pt, list | tuple) or len(pt) < 2:
            continue
        with contextlib.suppress(Exception):
            x, y = project_xy(float(pt[0]), float(pt[1]))
            projected.append([float(x), float(y)])
    if len(projected) < 2:
        return None
    return projected


def project_xy_point(
    x: float,
    y: float,
    project_xy: Callable[[float, float], tuple[float, float]],
) -> tuple[float, float] | None:
    with contextlib.suppress(Exception):
        px, py = project_xy(float(x), float(y))
        return float(px), float(py)
    return None


def choose_consensus_edge_match(
    candidates: list[tuple[EdgeRef, float]],
) -> tuple[EdgeRef | None, float]:
    """
    Pick an edge by vote count first, then average distance tie-break.

    This improves robustness in dense networks where mid/start/end samples may
    snap to different but nearby edges.
    """
    if not candidates:
        return None, float("inf")

    grouped: dict[EdgeRef, list[float]] = {}
    for edge, dist_ft in candidates:
        with contextlib.suppress(Exception):
            grouped.setdefault(edge, []).append(float(dist_ft))

    if not grouped:
        return None, float("inf")

    best_edge: EdgeRef | None = None
    best_votes = -1
    best_avg = float("inf")
    best_min = float("inf")

    for edge, dists in grouped.items():
        if not dists:
            continue
        votes = len(dists)
        avg_dist = sum(dists) / votes
        min_dist = min(dists)
        rank = (-votes, avg_dist, min_dist)
        best_rank = (-best_votes, best_avg, best_min)
        if best_edge is None or rank < best_rank:
            best_edge = edge
            best_votes = votes
            best_avg = avg_dist
            best_min = min_dist

    return best_edge, best_avg


def _reconstruct_path_edges(
    source: int,
    target: int,
    prev: dict[int, tuple[int, int | None]],
) -> list[EdgeRef]:
    edges: list[EdgeRef] = []
    cur = target
    while cur != source:
        p, k = prev[cur]
        if k is None:
            edges.append((p, cur, -1))
        else:
            edges.append((p, cur, k))
        cur = p
    edges.reverse()
    return edges


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
    except Exception:
        return None
    else:
        return best_key


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

    def _node_coords(node_id: int) -> tuple[float, float] | None:
        if node_xy and node_id in node_xy:
            return node_xy[node_id]
        with contextlib.suppress(Exception):
            return (
                float(G.nodes[node_id]["x"]),
                float(G.nodes[node_id]["y"]),
            )
        return None

    try:
        if not G.has_edge(u, v):
            return []

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
    except Exception:
        coords = []

    # Some graph builders omit per-edge geometry. Fall back to straight-line
    # node coordinates so OSM-ID matching still works.
    if len(coords) < 2:
        u_coords = _node_coords(u)
        v_coords = _node_coords(v)
        if u_coords and v_coords:
            coords = [
                [float(u_coords[0]), float(u_coords[1])],
                [float(v_coords[0]), float(v_coords[1])],
            ]

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
        osmids = data.get("osmid") or data.get("id")
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

        d_units = edge_line.distance(seg_line)
        d_ft = graph_units_to_feet(G, d_units)
        if d_ft < best_dist:
            best_dist = d_ft
            best_edge = (u, v, k)

    if best_edge and best_dist <= MAX_OSM_MATCH_DISTANCE_FT:
        return best_edge

    return None


def dijkstra_to_best_target(
    G: nx.DiGraph | nx.MultiDiGraph,
    source: int,
    targets: set[int],
    *,
    weight: str = "length",
    max_candidates: int = 25,
    distance_cutoff_factor: float = 3.0,
    score_fn: Callable[[int, float], float] | None = None,
) -> tuple[int, float, list[EdgeRef]] | None:
    """
    Dijkstra from source to select a "best" target among the closest candidates.

    This explores the graph once and collects up to `max_candidates` target nodes
    in increasing path-distance order (bounded by `distance_cutoff_factor` times
    the nearest target distance). The returned target is the one with the lowest
    score (lower is better).

    If `score_fn` is omitted, this behaves like "nearest by distance".
    """
    if source in targets:
        return (source, 0.0, [])

    if not targets:
        return None

    dist: dict[int, float] = {source: 0.0}
    prev: dict[int, tuple[int, int | None]] = {}
    heap: list[tuple[float, int]] = [(0.0, source)]
    visited: set[int] = set()

    candidates: list[tuple[int, float, float]] = []  # (node, dist, score)
    nearest_target_dist: float | None = None

    while heap:
        d, u = heapq.heappop(heap)
        if u in visited:
            continue
        visited.add(u)

        if nearest_target_dist is not None:
            cutoff = nearest_target_dist * float(distance_cutoff_factor)
            if d > cutoff:
                break

        if u in targets:
            if nearest_target_dist is None:
                nearest_target_dist = float(d)
            score = float(score_fn(u, float(d))) if score_fn else float(d)
            candidates.append((u, float(d), score))
            if len(candidates) >= max_candidates:
                break

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

    if not candidates:
        return None

    best_node, best_dist, _best_score = min(candidates, key=lambda item: item[2])
    return (best_node, best_dist, _reconstruct_path_edges(source, best_node, prev))


def reverse_candidates_for_edge(
    G: nx.MultiDiGraph,
    u: int,
    v: int,
    key: int,
) -> list[EdgeRef]:
    """Find plausible reverse edges v->u (keys) if present."""
    if not G.has_edge(v, u):
        return []
    # Try to match by osmid when possible; otherwise return all reverse edges.
    try:
        fwd = G.edges[u, v, key]
        f_osmid = fwd.get("osmid") or fwd.get("id")
        revs: list[EdgeRef] = []
        for rk, rdata in G[v][u].items():
            r_osmid = rdata.get("osmid") or rdata.get("id")
            if f_osmid is not None and r_osmid == f_osmid:
                revs.append((v, u, rk))
        if revs:
            return revs
        return [(v, u, rk) for rk in G[v][u]]
    except Exception:
        return [(v, u, rk) for rk in G[v][u]]
