"""
Zone decomposition for large coverage areas.

Splits large sets of required edges into geographic zones using K-Means
clustering, solves each zone independently, then stitches the results
together. Gap-filling handles inter-zone connections.
"""

import logging
import math
from dataclasses import dataclass, field

import networkx as nx

from .core import solve_greedy_route
from .graph import edge_length_m
from .types import EdgeRef, ReqId

logger = logging.getLogger(__name__)


@dataclass
class Zone:
    """A geographic cluster of required edges."""

    zone_id: int
    required_reqs: dict[ReqId, list[EdgeRef]] = field(default_factory=dict)
    req_segment_counts: dict[ReqId, int] = field(default_factory=dict)
    centroid_x: float = 0.0
    centroid_y: float = 0.0


def _edge_midpoint(
    edge: EdgeRef,
    node_xy: dict[int, tuple[float, float]],
) -> tuple[float, float] | None:
    """Get the midpoint of an edge in lon/lat coordinates."""
    u, v, _k = edge
    ux = node_xy.get(u)
    vx = node_xy.get(v)
    if ux and vx:
        return ((ux[0] + vx[0]) / 2.0, (ux[1] + vx[1]) / 2.0)
    return None


def decompose_into_zones(
    G: nx.MultiDiGraph,
    required_reqs: dict[ReqId, list[EdgeRef]],
    req_segment_counts: dict[ReqId, int] | None,
    node_xy: dict[int, tuple[float, float]],
    max_zone_size: int = 1500,
) -> list[Zone]:
    """
    Decompose required edges into geographic zones using K-Means clustering.

    Falls back to simple geographic grid splitting if sklearn is
    unavailable.
    """
    if len(required_reqs) <= max_zone_size:
        zone = Zone(zone_id=0)
        zone.required_reqs = dict(required_reqs)
        zone.req_segment_counts = dict(req_segment_counts) if req_segment_counts else {}
        return [zone]

    n_zones = max(2, math.ceil(len(required_reqs) / max_zone_size))

    # Collect midpoints for each requirement
    rid_list: list[ReqId] = []
    points: list[tuple[float, float]] = []
    for rid, opts in required_reqs.items():
        best_edge = min(opts, key=lambda e: edge_length_m(G, e[0], e[1], e[2]))
        mid = _edge_midpoint(best_edge, node_xy)
        if mid:
            rid_list.append(rid)
            points.append(mid)

    if not points:
        zone = Zone(zone_id=0)
        zone.required_reqs = dict(required_reqs)
        zone.req_segment_counts = dict(req_segment_counts) if req_segment_counts else {}
        return [zone]

    # Try K-Means clustering
    labels: list[int] | None = None
    try:
        import numpy as np
        from sklearn.cluster import KMeans

        X = np.array(points)
        kmeans = KMeans(n_clusters=n_zones, n_init=3, max_iter=100, random_state=42)
        labels = kmeans.fit_predict(X).tolist()
    except ImportError:
        logger.warning("sklearn not available; using grid-based zone decomposition")
    except Exception:
        logger.warning(
            "K-Means clustering failed; using grid-based decomposition",
            exc_info=True,
        )

    if labels is None:
        # Fallback: grid-based decomposition by sorting on x then chunking
        sorted_indices = sorted(
            range(len(points)),
            key=lambda i: (points[i][0], points[i][1]),
        )
        chunk_size = max(1, len(sorted_indices) // n_zones)
        labels = [0] * len(points)
        for chunk_idx in range(n_zones):
            start = chunk_idx * chunk_size
            end = (
                len(sorted_indices)
                if chunk_idx == n_zones - 1
                else (chunk_idx + 1) * chunk_size
            )
            for i in range(start, end):
                labels[sorted_indices[i]] = chunk_idx

    # Build zones from labels
    zone_map: dict[int, Zone] = {}
    for rid, label in zip(rid_list, labels, strict=False):
        if label not in zone_map:
            zone_map[label] = Zone(zone_id=label)
        zone = zone_map[label]
        zone.required_reqs[rid] = required_reqs[rid]
        if req_segment_counts and rid in req_segment_counts:
            zone.req_segment_counts[rid] = req_segment_counts[rid]

    # Compute centroids
    for label, zone in zone_map.items():
        zone_points = [points[i] for i in range(len(labels)) if labels[i] == label]
        if zone_points:
            zone.centroid_x = sum(p[0] for p in zone_points) / len(zone_points)
            zone.centroid_y = sum(p[1] for p in zone_points) / len(zone_points)

    # Include any requirements that didn't get a midpoint (shouldn't happen but be safe)
    assigned_rids = set()
    for zone in zone_map.values():
        assigned_rids.update(zone.required_reqs.keys())
    unassigned = {
        rid: opts for rid, opts in required_reqs.items() if rid not in assigned_rids
    }
    if unassigned:
        # Add to the first zone
        first_zone = next(iter(zone_map.values()))
        first_zone.required_reqs.update(unassigned)
        if req_segment_counts:
            for rid in unassigned:
                if rid in req_segment_counts:
                    first_zone.req_segment_counts[rid] = req_segment_counts[rid]

    zones = sorted(zone_map.values(), key=lambda z: z.zone_id)
    logger.info(
        "Decomposed %d requirements into %d zones (sizes: %s)",
        len(required_reqs),
        len(zones),
        [len(z.required_reqs) for z in zones],
    )
    return zones


def order_zones(
    zones: list[Zone],
    start_xy: tuple[float, float] | None = None,
) -> list[Zone]:
    """Order zones by nearest-neighbor starting from start_xy or first zone centroid."""
    if len(zones) <= 1:
        return zones

    if start_xy is None:
        start_xy = (zones[0].centroid_x, zones[0].centroid_y)

    remaining = list(zones)
    ordered: list[Zone] = []
    cx, cy = start_xy

    while remaining:
        best_idx = 0
        best_dist = float("inf")
        for i, zone in enumerate(remaining):
            dx = zone.centroid_x - cx
            dy = zone.centroid_y - cy
            dist = dx * dx + dy * dy
            if dist < best_dist:
                best_dist = dist
                best_idx = i
        chosen = remaining.pop(best_idx)
        ordered.append(chosen)
        cx, cy = chosen.centroid_x, chosen.centroid_y

    return ordered


def solve_zones(
    G: nx.MultiDiGraph,
    zones: list[Zone],
    start_node: int | None = None,
    node_xy: dict[int, tuple[float, float]] | None = None,
) -> tuple[list[list[float]], dict[str, float], list[tuple[ReqId, EdgeRef]]]:
    """
    Solve each zone independently and stitch results together.

    Returns combined (route_coords, stats, service_sequence).
    """
    all_coords: list[list[float]] = []
    all_service_sequence: list[tuple[ReqId, EdgeRef]] = []
    total_stats = {
        "total_distance": 0.0,
        "required_distance": 0.0,
        "required_distance_completed": 0.0,
        "service_distance": 0.0,
        "deadhead_distance": 0.0,
        "required_reqs": 0.0,
        "completed_reqs": 0.0,
        "skipped_disconnected": 0.0,
        "opportunistic_completed": 0.0,
        "teleports": 0.0,
        "iterations": 0.0,
    }

    current_start = start_node

    for i, zone in enumerate(zones):
        if not zone.required_reqs:
            continue

        logger.info(
            "Solving zone %d/%d (%d requirements)",
            i + 1,
            len(zones),
            len(zone.required_reqs),
        )

        coords, stats, _, sequence = solve_greedy_route(
            G,
            zone.required_reqs,
            current_start,
            req_segment_counts=zone.req_segment_counts or None,
            node_xy=node_xy,
        )

        if coords:
            if all_coords:
                # Gap between zones will be filled by Valhalla gap-filling later
                all_coords.extend(coords)
            else:
                all_coords = coords

            # Update start node for next zone to be the end of this zone's route
            if sequence:
                last_edge = sequence[-1][1]
                current_start = last_edge[1]  # v node of last service edge

        all_service_sequence.extend(sequence)

        # Accumulate stats
        for key in total_stats:
            if key in stats:
                total_stats[key] += float(stats[key])

    # Compute derived stats
    total_dist = total_stats["total_distance"]
    dead_dist = total_stats["deadhead_distance"]
    req_dist = total_stats["required_distance"]
    svc_dist = total_stats["service_distance"]
    total_stats["deadhead_percentage"] = (
        (dead_dist / total_dist * 100.0) if total_dist > 0 else 0.0
    )
    total_stats["deadhead_ratio_all"] = (total_dist / req_dist) if req_dist > 0 else 0.0
    total_stats["deadhead_ratio_completed"] = (
        (total_dist / svc_dist) if svc_dist > 0 else 0.0
    )

    return all_coords, total_stats, all_service_sequence
