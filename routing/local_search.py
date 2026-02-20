"""
2-opt local search improvement for greedy route solutions.

Takes the ordered sequence of service edges from the greedy solver and
attempts pairwise reversals of sub-sequences to reduce total deadhead distance.
"""

import logging
import time

import networkx as nx

from .graph import dijkstra_to_best_target, edge_length_m, get_edge_geometry
from .types import EdgeRef, ReqId

logger = logging.getLogger(__name__)


def _connecting_distance(
    G: nx.MultiDiGraph,
    from_node: int,
    to_node: int,
) -> float | None:
    """Compute shortest-path distance between two nodes. Returns None if unreachable."""
    if from_node == to_node:
        return 0.0
    result = dijkstra_to_best_target(
        G,
        from_node,
        {to_node},
        weight="length",
        max_candidates=1,
        distance_cutoff_factor=5.0,
    )
    if result is None:
        return None
    return result[1]


def _sequence_total_cost(
    G: nx.MultiDiGraph,
    sequence: list[tuple[ReqId, EdgeRef]],
    start_node: int,
) -> float | None:
    """Compute total route cost (service + deadhead) for a given sequence ordering."""
    total = 0.0
    current_node = start_node

    for _rid, edge in sequence:
        u, v, _k = edge
        # Deadhead to reach the start of this edge
        if current_node != u:
            dh = _connecting_distance(G, current_node, u)
            if dh is None:
                return None
            total += dh
        # Service the edge
        total += edge_length_m(G, u, v, _k)
        current_node = v

    return total


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
) -> dict[str, float]:
    """Build stats dict for an optimized route."""
    total_dist = 0.0
    service_dist = 0.0
    deadhead_dist = 0.0
    current_node = start_node

    for _rid, edge in sequence:
        u, v, k = edge
        if current_node != u:
            dh = _connecting_distance(G, current_node, u)
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
        "deadhead_percentage": (deadhead_dist / total_dist * 100.0) if total_dist > 0 else 0.0,
        "deadhead_ratio_all": (total_dist / required_dist) if required_dist > 0 else 0.0,
        "deadhead_ratio_completed": (total_dist / service_dist) if service_dist > 0 else 0.0,
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

    Returns:
        (route_coords, stats, improved_sequence)
    """
    route_start_node = (
        start_node if start_node is not None else (service_sequence[0][1][0] if service_sequence else 0)
    )

    if len(service_sequence) < 3:
        coords = _rebuild_route_coords(G, service_sequence, route_start_node, node_xy)
        stats = _build_stats(G, service_sequence, route_start_node, required_reqs)
        return coords, stats, service_sequence

    best_sequence = list(service_sequence)
    best_cost = _sequence_total_cost(G, best_sequence, route_start_node)

    if best_cost is None:
        logger.warning("Cannot compute initial cost for 2-opt; returning original")
        coords = _rebuild_route_coords(G, service_sequence, route_start_node, node_xy)
        stats = _build_stats(G, service_sequence, route_start_node, required_reqs)
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
                # Reverse the sub-sequence between i and j
                candidate = best_sequence[:i] + best_sequence[i : j + 1][::-1] + best_sequence[j + 1 :]
                cost = _sequence_total_cost(G, candidate, route_start_node)
                if cost is not None and cost < best_cost:
                    best_cost = cost
                    best_sequence = candidate
                    improved = True
                    total_improvements += 1

    logger.info(
        "2-opt completed: %d passes, %d improvements, %.1fs",
        passes,
        total_improvements,
        time.monotonic() - (deadline - time_budget_s),
    )

    coords = _rebuild_route_coords(G, best_sequence, route_start_node, node_xy)
    stats = _build_stats(G, best_sequence, route_start_node, required_reqs)
    return coords, stats, best_sequence
