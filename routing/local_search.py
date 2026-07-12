"""Local-search improvements for greedy route solutions."""

import logging
import time

import networkx as nx

from .constants import TELEPORT_PENALTY_FACTOR
from .graph import (
    _haversine_distance_m,
    dijkstra_to_best_target,
    edge_length_m,
    get_edge_geometry,
)
from .types import EdgeRef, ReqId

logger = logging.getLogger(__name__)


class _DistanceCache:
    """Lazy cache for real and teleport-penalized node distances."""

    __slots__ = ("_G", "_cache", "_network_cache", "_node_xy")

    def __init__(
        self,
        G: nx.MultiDiGraph,
        node_xy: dict[int, tuple[float, float]] | None = None,
    ) -> None:
        self._G = G
        self._cache: dict[tuple[int, int], float | None] = {}
        self._network_cache: dict[tuple[int, int], float | None] = {}
        self._node_xy = node_xy or {
            node: (float(data["x"]), float(data["y"]))
            for node, data in G.nodes(data=True)
            if data.get("x") is not None and data.get("y") is not None
        }

    def get_network_distance(self, from_node: int, to_node: int) -> float | None:
        """Return the real shortest-path distance, or ``None`` if unreachable."""
        if from_node == to_node:
            return 0.0
        key = (from_node, to_node)
        if key in self._network_cache:
            return self._network_cache[key]
        result = dijkstra_to_best_target(
            self._G,
            from_node,
            {to_node},
            weight="length",
            max_candidates=1,
            distance_cutoff_factor=5.0,
        )
        dist = result[1] if result is not None else None
        self._network_cache[key] = dist
        return dist

    def get(self, from_node: int, to_node: int) -> float | None:
        """Return a finite search cost when coordinates exist for a teleport."""
        if from_node == to_node:
            return 0.0
        key = (from_node, to_node)
        if key in self._cache:
            return self._cache[key]

        dist = self.get_network_distance(from_node, to_node)
        if dist is None:
            from_xy = self._node_xy.get(from_node)
            to_xy = self._node_xy.get(to_node)
            if from_xy is not None and to_xy is not None:
                dist = _haversine_distance_m(*from_xy, *to_xy) * TELEPORT_PENALTY_FACTOR
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
    old_into_i = (
        dist_cache.get(prev_end_old, seg_i_start_old)
        if prev_end_old != seg_i_start_old
        else 0.0
    )
    if old_into_i is None:
        return None

    # Connection out of segment j
    seg_j_end_old = sequence[j][1][1]
    if j + 1 < n:
        seg_j1_start_old = sequence[j + 1][1][0]
        old_out_j = (
            dist_cache.get(seg_j_end_old, seg_j1_start_old)
            if seg_j_end_old != seg_j1_start_old
            else 0.0
        )
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
    new_into = (
        dist_cache.get(prev_end_old, new_first_start)
        if prev_end_old != new_first_start
        else 0.0
    )
    if new_into is None:
        return None

    # Connection out of reversed[-1] = old sequence[i]
    new_last_end = sequence[i][1][1]
    if j + 1 < n:
        seg_j1_start = sequence[j + 1][1][0]
        new_out = (
            dist_cache.get(new_last_end, seg_j1_start)
            if new_last_end != seg_j1_start
            else 0.0
        )
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


def _connection_cost(
    dist_cache: _DistanceCache,
    from_node: int | None,
    to_node: int | None,
) -> float | None:
    """Return a search connection cost, treating an open-route boundary as zero."""
    if from_node is None or to_node is None or from_node == to_node:
        return 0.0
    return dist_cache.get(from_node, to_node)


def _orientation_pass(
    sequence: list[tuple[ReqId, EdgeRef]],
    service_lengths: list[float],
    required_reqs: dict[ReqId, list[EdgeRef]],
    G: nx.MultiDiGraph,
    start_node: int,
    dist_cache: _DistanceCache,
    deadline: float,
) -> int:
    """Flip reversible service edges when doing so reduces adjacent travel."""
    improvements = 0
    for index, (rid, current_edge) in enumerate(sequence):
        if time.monotonic() >= deadline:
            break
        options = required_reqs.get(rid, [])
        if len(options) < 2:
            continue

        prev_end = start_node if index == 0 else sequence[index - 1][1][1]
        next_start = sequence[index + 1][1][0] if index + 1 < len(sequence) else None
        best_edge = current_edge
        best_cost: float | None = None

        for option in options:
            u, v, key = option
            into = _connection_cost(dist_cache, prev_end, u)
            out = _connection_cost(dist_cache, v, next_start)
            if into is None or out is None:
                continue
            cost = into + edge_length_m(G, u, v, key) + out
            if best_cost is None or cost < best_cost:
                best_cost = cost
                best_edge = option

        if best_edge == current_edge or best_cost is None:
            continue

        u, v, key = current_edge
        current_into = _connection_cost(dist_cache, prev_end, u)
        current_out = _connection_cost(dist_cache, v, next_start)
        if current_into is None or current_out is None:
            continue
        current_cost = current_into + edge_length_m(G, u, v, key) + current_out
        if best_cost < current_cost - 1e-6:
            sequence[index] = (rid, best_edge)
            service_lengths[index] = edge_length_m(G, *best_edge)
            improvements += 1

    return improvements


def _relocate_delta(
    sequence: list[tuple[ReqId, EdgeRef]],
    start_node: int,
    dist_cache: _DistanceCache,
    i: int,
    j: int,
) -> float | None:
    """Return the cost delta for removing item ``i`` and inserting it after ``j``."""
    n = len(sequence)
    if not 0 <= i < n or not -1 <= j < n or j in {i, i - 1}:
        return None

    prev_i_end = start_node if i == 0 else sequence[i - 1][1][1]
    item_start = sequence[i][1][0]
    item_end = sequence[i][1][1]
    next_i_start = sequence[i + 1][1][0] if i + 1 < n else None

    insert_after_end = start_node if j == -1 else sequence[j][1][1]
    insert_before_start = sequence[j + 1][1][0] if j + 1 < n else None

    old_pairs = (
        (prev_i_end, item_start),
        (item_end, next_i_start),
        (insert_after_end, insert_before_start),
    )
    new_pairs = (
        (prev_i_end, next_i_start),
        (insert_after_end, item_start),
        (item_end, insert_before_start),
    )

    old_cost = 0.0
    new_cost = 0.0
    for from_node, to_node in old_pairs:
        cost = _connection_cost(dist_cache, from_node, to_node)
        if cost is None:
            return None
        old_cost += cost
    for from_node, to_node in new_pairs:
        cost = _connection_cost(dist_cache, from_node, to_node)
        if cost is None:
            return None
        new_cost += cost
    return new_cost - old_cost


def _apply_relocation(
    sequence: list[tuple[ReqId, EdgeRef]],
    service_lengths: list[float],
    i: int,
    j: int,
) -> None:
    item = sequence.pop(i)
    service_length = service_lengths.pop(i)
    insert_at = j + 1 if j < i else j
    sequence.insert(insert_at, item)
    service_lengths.insert(insert_at, service_length)


def _relocation_pass(
    sequence: list[tuple[ReqId, EdgeRef]],
    service_lengths: list[float],
    start_node: int,
    dist_cache: _DistanceCache,
    deadline: float,
) -> int:
    """Relocate individual service edges without reversing their direction."""
    improvements = 0
    n = len(sequence)
    for i in range(n):
        if time.monotonic() >= deadline:
            break
        candidate_js = (
            range(max(-1, i - 50), min(n - 1, i + 50) + 1) if n > 100 else range(-1, n)
        )
        best_j = None
        best_delta = 0.0
        for j in candidate_js:
            delta = _relocate_delta(sequence, start_node, dist_cache, i, j)
            if delta is not None and delta < best_delta - 1e-6:
                best_delta = delta
                best_j = j
        if best_j is not None:
            _apply_relocation(sequence, service_lengths, i, best_j)
            improvements += 1
    return improvements


def _two_opt_pass(
    sequence: list[tuple[ReqId, EdgeRef]],
    service_lengths: list[float],
    start_node: int,
    dist_cache: _DistanceCache,
    deadline: float,
) -> int:
    """Run one improving 2-opt pass over the current service order."""
    improvements = 0
    n = len(sequence)
    for i in range(n - 1):
        if time.monotonic() >= deadline:
            break
        max_j = min(n, i + 50) if n > 100 else n
        for j in range(i + 2, max_j):
            delta = _swap_delta(sequence, start_node, dist_cache, i, j)
            if delta is not None and delta < -1e-6:
                sequence[i : j + 1] = sequence[i : j + 1][::-1]
                service_lengths[i : j + 1] = service_lengths[i : j + 1][::-1]
                improvements += 1
    return improvements


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
    teleports = 0.0
    current_node = start_node

    for _rid, edge in sequence:
        u, v, k = edge
        if current_node != u:
            dh = dist_cache.get_network_distance(current_node, u)
            if dh is not None:
                deadhead_dist += dh
                total_dist += dh
            else:
                teleports += 1.0
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
        "teleports": teleports,
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
    Improve service order with orientation, 2-opt, and Or-opt passes.

    Returns:
        (route_coords, stats, improved_sequence)
    """
    route_start_node = (
        start_node
        if start_node is not None
        else (service_sequence[0][1][0] if service_sequence else 0)
    )

    dist_cache = _DistanceCache(G, node_xy)

    if not service_sequence:
        coords = _rebuild_route_coords(G, service_sequence, route_start_node, node_xy)
        stats = _build_stats(
            G, service_sequence, route_start_node, required_reqs, dist_cache
        )
        return coords, stats, service_sequence

    service_lengths = _precompute_service_lengths(G, service_sequence)
    best_sequence = list(service_sequence)
    best_cost = _sequence_total_cost_fast(
        best_sequence,
        service_lengths,
        route_start_node,
        dist_cache,
    )

    if best_cost is None:
        logger.warning("Cannot compute initial local-search cost; returning original")
        coords = _rebuild_route_coords(G, service_sequence, route_start_node, node_xy)
        stats = _build_stats(
            G, service_sequence, route_start_node, required_reqs, dist_cache
        )
        return coords, stats, service_sequence

    deadline = time.monotonic() + time_budget_s
    passes = 0
    orientation_improvements = 0
    two_opt_improvements = 0
    relocation_improvements = 0

    while time.monotonic() < deadline:
        passes += 1
        pass_orientation = _orientation_pass(
            best_sequence,
            service_lengths,
            required_reqs,
            G,
            route_start_node,
            dist_cache,
            deadline,
        )
        pass_two_opt = _two_opt_pass(
            best_sequence,
            service_lengths,
            route_start_node,
            dist_cache,
            deadline,
        )
        pass_relocation = _relocation_pass(
            best_sequence,
            service_lengths,
            route_start_node,
            dist_cache,
            deadline,
        )
        orientation_improvements += pass_orientation
        two_opt_improvements += pass_two_opt
        relocation_improvements += pass_relocation
        if pass_orientation + pass_two_opt + pass_relocation == 0:
            break

    final_cost = _sequence_total_cost_fast(
        best_sequence,
        service_lengths,
        route_start_node,
        dist_cache,
    )

    logger.info(
        "Local search completed: %d passes, orientation=%d, 2-opt=%d, "
        "relocation=%d, cost=%.1f->%.1f, %.1fs, cache_size=%d",
        passes,
        orientation_improvements,
        two_opt_improvements,
        relocation_improvements,
        best_cost,
        final_cost if final_cost is not None else best_cost,
        time.monotonic() - (deadline - time_budget_s),
        len(dist_cache._cache),
    )

    coords = _rebuild_route_coords(G, best_sequence, route_start_node, node_xy)
    stats = _build_stats(G, best_sequence, route_start_node, required_reqs, dist_cache)
    return coords, stats, best_sequence
