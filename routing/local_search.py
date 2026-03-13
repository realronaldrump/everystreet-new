"""
2-opt local search improvement for greedy route solutions.

Takes the ordered sequence of service edges from the greedy solver and
attempts pairwise reversals of sub-sequences to reduce total deadhead
distance.

Uses a lazily-populated distance cache so each (from_node, to_node) pair
is computed at most once per run, and evaluates swap candidates via
O(1) delta computation rather than rescanning the entire sequence.
"""

import logging
import time

import networkx as nx

from .graph import dijkstra_to_best_target, edge_length_m, get_edge_geometry
from .types import EdgeRef, ReqId

logger = logging.getLogger(__name__)


class _DistanceCache:
    """Lazy cache for node-to-node shortest-path distances."""

    __slots__ = ("_G", "_cache")

    def __init__(self, G: nx.MultiDiGraph) -> None:
        self._G = G
        self._cache: dict[tuple[int, int], float | None] = {}

    def get(self, from_node: int, to_node: int) -> float | None:
        """Return cached shortest-path distance, computing on first access."""
        if from_node == to_node:
            return 0.0
        key = (from_node, to_node)
        if key in self._cache:
            return self._cache[key]
        result = dijkstra_to_best_target(
            self._G,
            from_node,
            {to_node},
            weight="length",
            max_candidates=1,
            distance_cutoff_factor=5.0,
        )
        dist = result[1] if result is not None else None
        self._cache[key] = dist
        return dist


def _precompute_service_lengths(
    G: nx.MultiDiGraph,
    sequence: list[tuple[ReqId, EdgeRef]],
) -> list[float]:
    """Pre-compute service edge lengths for the entire sequence."""
    return [edge_length_m(G, u, v, k) for _rid, (u, v, k) in sequence]


def _sequence_total_cost_fast(
    sequence: list[tuple[ReqId, EdgeRef]],
    service_lengths: list[float],
    start_node: int,
    dist_cache: _DistanceCache,
) -> float | None:
    """Compute total route cost using cached distances."""
    total = 0.0
    current_node = start_node

    for i, (_rid, edge) in enumerate(sequence):
        u, v, _k = edge
        if current_node != u:
            dh = dist_cache.get(current_node, u)
            if dh is None:
                return None
            total += dh
        total += service_lengths[i]
        current_node = v

    return total


def _swap_delta(
    sequence: list[tuple[ReqId, EdgeRef]],
    start_node: int,
    dist_cache: _DistanceCache,
    i: int,
    j: int,
) -> float | None:
    """
    Compute the cost difference of reversing sequence[i..j] (inclusive).

    Returns (new_cost - old_cost).  Negative means improvement.
    Only the affected connecting segments are re-evaluated.
    """
    n = len(sequence)

    # --- Old connecting costs ---
    # Connection into segment i
    prev_end_old = start_node if i == 0 else sequence[i - 1][1][1]
    seg_i_start_old = sequence[i][1][0]
    old_into_i = dist_cache.get(prev_end_old, seg_i_start_old) if prev_end_old != seg_i_start_old else 0.0
    if old_into_i is None:
        return None

    # Connection out of segment j
    seg_j_end_old = sequence[j][1][1]
    if j + 1 < n:
        seg_j1_start_old = sequence[j + 1][1][0]
        old_out_j = dist_cache.get(seg_j_end_old, seg_j1_start_old) if seg_j_end_old != seg_j1_start_old else 0.0
        if old_out_j is None:
            return None
    else:
        old_out_j = 0.0

    # Internal connections within [i..j]
    old_internal = 0.0
    for idx in range(i, j):
        seg_end = sequence[idx][1][1]
        seg_next_start = sequence[idx + 1][1][0]
        if seg_end != seg_next_start:
            d = dist_cache.get(seg_end, seg_next_start)
            if d is None:
                return None
            old_internal += d

    old_total = old_into_i + old_internal + old_out_j

    # --- New connecting costs (reversed sub-sequence) ---
    # After reversal, segment j is now at position i, segment i at position j
    # The reversed sub-sequence is sequence[j], sequence[j-1], ..., sequence[i]

    # Connection into reversed[0] = old sequence[j]
    new_first_start = sequence[j][1][0]
    new_into = dist_cache.get(prev_end_old, new_first_start) if prev_end_old != new_first_start else 0.0
    if new_into is None:
        return None

    # Connection out of reversed[-1] = old sequence[i]
    new_last_end = sequence[i][1][1]
    if j + 1 < n:
        seg_j1_start = sequence[j + 1][1][0]
        new_out = dist_cache.get(new_last_end, seg_j1_start) if new_last_end != seg_j1_start else 0.0
        if new_out is None:
            return None
    else:
        new_out = 0.0

    # Internal connections in reversed order
    new_internal = 0.0
    for idx in range(j, i, -1):
        seg_end = sequence[idx][1][1]
        seg_prev_start = sequence[idx - 1][1][0]
        if seg_end != seg_prev_start:
            d = dist_cache.get(seg_end, seg_prev_start)
            if d is None:
                return None
            new_internal += d

    new_total = new_into + new_internal + new_out

    return new_total - old_total


def _rebuild_route_coords(
    G: nx.MultiDiGraph,
    sequence: list[tuple[ReqId, EdgeRef]],
    start_node: int,
    node_xy: dict[int, tuple[float, float]] | None,
) -> list[list[float]]:
    """Rebuild full route coordinates from a service sequence with connecting paths."""
    coords: list[list[float]] = []
    current_node = start_node

    def _append(new_coords: list[list[float]]) -> None:
        if not new_coords:
            return
        if coords:
            coords.extend(new_coords[1:])
        else:
            coords.extend(new_coords)

    for _rid, edge in sequence:
        u, v, k = edge
        # Deadhead: get connecting path
        if current_node != u:
            result = dijkstra_to_best_target(
                G,
                current_node,
                {u},
                weight="length",
                max_candidates=1,
                distance_cutoff_factor=5.0,
            )
            if result is not None:
                _, _, path_edges = result
                for pe in path_edges:
                    key = None if pe[2] == -1 else pe[2]
                    geo = get_edge_geometry(G, pe[0], pe[1], key, node_xy=node_xy)
                    _append(geo)

        # Service edge
        key = None if k == -1 else k
        geo = get_edge_geometry(G, u, v, key, node_xy=node_xy)
        _append(geo)
        current_node = v

    return coords


def _build_stats(
    G: nx.MultiDiGraph,
    sequence: list[tuple[ReqId, EdgeRef]],
    start_node: int,
    required_reqs: dict[ReqId, list[EdgeRef]],
    dist_cache: _DistanceCache,
) -> dict[str, float]:
    """Build stats dict for an optimized route."""
    total_dist = 0.0
    service_dist = 0.0
    deadhead_dist = 0.0
    current_node = start_node

    for _rid, edge in sequence:
        u, v, k = edge
        if current_node != u:
            dh = dist_cache.get(current_node, u)
            if dh is not None:
                deadhead_dist += dh
                total_dist += dh
        el = edge_length_m(G, u, v, k)
        service_dist += el
        total_dist += el
        current_node = v

    # Required distance is the sum of all required edges (not just those in sequence)
    required_dist = 0.0
    for opts in required_reqs.values():
        best = min((edge_length_m(G, u, v, k) for (u, v, k) in opts), default=0.0)
        required_dist += best

    return {
        "total_distance": total_dist,
        "required_distance": required_dist,
        "required_distance_completed": service_dist,
        "service_distance": service_dist,
        "deadhead_distance": deadhead_dist,
        "deadhead_percentage": (
            (deadhead_dist / total_dist * 100.0) if total_dist > 0 else 0.0
        ),
        "deadhead_ratio_all": (
            (total_dist / required_dist) if required_dist > 0 else 0.0
        ),
        "deadhead_ratio_completed": (
            (total_dist / service_dist) if service_dist > 0 else 0.0
        ),
        "required_reqs": float(len(required_reqs)),
        "completed_reqs": float(len(sequence)),
        "skipped_disconnected": float(max(0, len(required_reqs) - len(sequence))),
        "opportunistic_completed": 0.0,
        "teleports": 0.0,
        "iterations": 0.0,
    }


def improve_route_2opt(
    G: nx.MultiDiGraph,
    service_sequence: list[tuple[ReqId, EdgeRef]],
    required_reqs: dict[ReqId, list[EdgeRef]],
    *,
    start_node: int | None = None,
    node_xy: dict[int, tuple[float, float]] | None = None,
    time_budget_s: float = 30.0,
) -> tuple[list[list[float]], dict[str, float], list[tuple[ReqId, EdgeRef]]]:
    """
    Apply 2-opt local search to improve the service edge ordering.

    Tries reversing sub-sequences of the service order. If a reversal
    reduces total deadhead cost, it is accepted. Runs until no improvement
    is found or the time budget is exhausted.

    Uses a distance cache so each (from_node → to_node) pair is computed
    at most once, and evaluates swaps via O(1) delta evaluation rather
    than rescanning the full sequence each time.

    Returns:
        (route_coords, stats, improved_sequence)
    """
    route_start_node = (
        start_node
        if start_node is not None
        else (service_sequence[0][1][0] if service_sequence else 0)
    )

    dist_cache = _DistanceCache(G)

    if len(service_sequence) < 3:
        coords = _rebuild_route_coords(G, service_sequence, route_start_node, node_xy)
        stats = _build_stats(G, service_sequence, route_start_node, required_reqs, dist_cache)
        return coords, stats, service_sequence

    service_lengths = _precompute_service_lengths(G, service_sequence)
    best_sequence = list(service_sequence)
    best_cost = _sequence_total_cost_fast(
        best_sequence, service_lengths, route_start_node, dist_cache,
    )

    if best_cost is None:
        logger.warning("Cannot compute initial cost for 2-opt; returning original")
        coords = _rebuild_route_coords(G, service_sequence, route_start_node, node_xy)
        stats = _build_stats(G, service_sequence, route_start_node, required_reqs, dist_cache)
        return coords, stats, service_sequence

    deadline = time.monotonic() + time_budget_s
    improved = True
    passes = 0
    total_improvements = 0
    n = len(best_sequence)

    while improved and time.monotonic() < deadline:
        improved = False
        passes += 1

        for i in range(n - 1):
            if time.monotonic() >= deadline:
                break

            # Limit inner loop to nearby swaps for large sequences
            max_j = min(n, i + 50) if n > 100 else n
            for j in range(i + 2, max_j):
                # Delta evaluation: only recompute affected connections
                delta = _swap_delta(
                    best_sequence, route_start_node,
                    dist_cache, i, j,
                )
                if delta is not None and delta < -1e-6:
                    # Accept the swap
                    best_sequence[i : j + 1] = best_sequence[i : j + 1][::-1]
                    service_lengths[i : j + 1] = service_lengths[i : j + 1][::-1]
                    best_cost += delta
                    improved = True
                    total_improvements += 1

    logger.info(
        "2-opt completed: %d passes, %d improvements, %.1fs, cache_size=%d",
        passes,
        total_improvements,
        time.monotonic() - (deadline - time_budget_s),
        len(dist_cache._cache),
    )

    coords = _rebuild_route_coords(G, best_sequence, route_start_node, node_xy)
    stats = _build_stats(G, best_sequence, route_start_node, required_reqs, dist_cache)
    return coords, stats, best_sequence
