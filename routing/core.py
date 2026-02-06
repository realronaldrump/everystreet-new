import logging

import networkx as nx

from core.spatial import log_jump_distance

from .graph import (
    dijkstra_to_best_target,
    edge_length_m,
    get_edge_geometry,
    reverse_candidates_for_edge,
)
from .types import EdgeRef, ReqId

logger = logging.getLogger(__name__)


def make_req_id(G: nx.MultiDiGraph, edge: EdgeRef) -> tuple[ReqId, list[EdgeRef]]:
    """
    Build a requirement ID for a physical-ish segment:

    include the mapped directed edge, and include reverse edge(s) if they exist.
    ReqId is a frozenset of EdgeRef(s); options is the list of directed edges you can traverse to satisfy it.
    """
    u, v, k = edge
    options: list[EdgeRef] = [(u, v, k)]
    if G.is_multigraph() and G.is_directed():
        revs = reverse_candidates_for_edge(G, u, v, k)
        # keep only one reverse option (best length) to avoid weird parallels unless you want more
        if revs:
            best_rev = min(revs, key=lambda e: edge_length_m(G, e[0], e[1], e[2]))
            options.append(best_rev)
    req_id: ReqId = frozenset(options)
    return req_id, options


def initialize_route_state(
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


def build_requirement_indices(
    required_reqs: dict[ReqId, list[EdgeRef]],
) -> tuple[dict[ReqId, list[int]], dict[int, int], dict[int, set[ReqId]]]:
    """Build indices mapping requirements to start nodes."""
    req_to_starts: dict[ReqId, list[int]] = {}
    start_counts: dict[int, int] = {}
    start_to_rids: dict[int, set[ReqId]] = {}

    for rid, opts in required_reqs.items():
        starts = sorted({u for (u, _, _) in opts})
        req_to_starts[rid] = starts
        for s in starts:
            start_counts[s] = start_counts.get(s, 0) + 1
            start_to_rids.setdefault(s, set()).add(rid)

    return req_to_starts, start_counts, start_to_rids


def calculate_required_distance(
    G: nx.MultiDiGraph,
    required_reqs: dict[ReqId, list[EdgeRef]],
) -> float:
    """Calculate total required distance from all requirements."""
    required_dist = 0.0
    for opts in required_reqs.values():
        best = min((edge_length_m(G, u, v, k) for (u, v, k) in opts), default=0.0)
        required_dist += best
    return required_dist


def build_component_structure(
    G: nx.MultiDiGraph,
    required_reqs: dict[ReqId, list[EdgeRef]],
    req_to_starts: dict[ReqId, list[int]],
) -> tuple[
    dict[ReqId, int],
    dict[int, set[ReqId]],
    dict[int, set[int]],
    dict[int, int],
]:
    """Build component-aware grouping for required edges."""
    # We want to group requirements by actual road-network connectivity, not
    # just whether required edges touch each other. Use weakly-connected
    # components of the full routing graph (treating one-ways as connected).
    required_nodes: set[int] = set()
    for starts in req_to_starts.values():
        required_nodes.update(starts)

    node_to_comp: dict[int, int] = {}
    remaining = set(required_nodes)
    for comp_id, nodes in enumerate(nx.weakly_connected_components(G)):
        if not remaining:
            break
        touched = remaining.intersection(nodes)
        if not touched:
            continue
        for n in touched:
            node_to_comp[n] = comp_id
        remaining.difference_update(touched)

    start_to_comp = {n: node_to_comp.get(n, -1) for n in required_nodes}

    req_to_comp: dict[ReqId, int] = {}
    comp_to_rids: dict[int, set[ReqId]] = {}
    comp_targets: dict[int, set[int]] = {}

    for rid, opts in required_reqs.items():
        best = min(opts, key=lambda e: edge_length_m(G, e[0], e[1], e[2]))
        comp_id = node_to_comp.get(best[0], -1)
        req_to_comp[rid] = comp_id
        comp_to_rids.setdefault(comp_id, set()).add(rid)
        comp_targets.setdefault(comp_id, set()).update(req_to_starts.get(rid, []))

    return req_to_comp, comp_to_rids, comp_targets, start_to_comp


def solve_greedy_route(
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
    current_node, node_xy = initialize_route_state(G, required_reqs, start_node)
    req_to_starts, start_counts, start_to_rids = build_requirement_indices(required_reqs)
    unvisited: set[ReqId] = set(required_reqs.keys())

    # Requirement <-> edge indices (so we can opportunistically service required edges
    # while deadheading along shortest paths).
    edge_to_rid: dict[EdgeRef, ReqId] = {}
    for rid, opts in required_reqs.items():
        for e in opts:
            edge_to_rid.setdefault(e, rid)

    # Distance accounting (meters)
    total_dist = 0.0
    service_dist = 0.0
    deadhead_dist = 0.0
    required_dist_all = calculate_required_distance(G, required_reqs)

    # Build component structure + targets
    req_to_comp, comp_to_rids, comp_targets, start_to_comp = build_component_structure(
        G,
        required_reqs,
        req_to_starts,
    )
    global_targets: set[int] = set(start_counts.keys())

    comp_remaining_req_count: dict[int, int] = {
        comp_id: len(rids) for comp_id, rids in comp_to_rids.items()
    }
    comp_remaining_seg_count: dict[int, float] = {}
    for comp_id, rids in comp_to_rids.items():
        comp_remaining_seg_count[comp_id] = float(
            sum(
                int(req_segment_counts.get(rid, 1) if req_segment_counts else 1)
                for rid in rids
            ),
        )

    # Geometry cache
    edge_geo_cache: dict[EdgeRef, list[list[float]]] = {}

    def _append_coords(coords: list[list[float]]) -> None:
        if not coords:
            return
        if route_coords:
            route_coords.extend(coords[1:])
        else:
            route_coords.extend(coords)

    def _append_edge_geometry(u: int, v: int, k: int) -> None:
        cache_key: EdgeRef = (u, v, k)
        geo = edge_geo_cache.get(cache_key)
        if geo is None:
            key = None if k == -1 else k
            geo = get_edge_geometry(G, u, v, key, node_xy=node_xy)
            edge_geo_cache[cache_key] = geo
        _append_coords(geo)
        route_edges.append(cache_key)

    def _best_service_edge_from_start(rid: ReqId, start: int) -> EdgeRef:
        opts = [e for e in required_reqs[rid] if e[0] == start]
        return min(opts, key=lambda e: edge_length_m(G, e[0], e[1], e[2]))

    def _seg_count(rid: ReqId) -> float:
        return float(req_segment_counts.get(rid, 1) if req_segment_counts else 1)

    def _remove_req_from_targets(rid: ReqId) -> None:
        comp_id = req_to_comp.get(rid, -1)
        for s in req_to_starts.get(rid, []):
            start_counts[s] = start_counts.get(s, 0) - 1
            if start_counts[s] <= 0:
                global_targets.discard(s)
                comp_targets.get(comp_id, set()).discard(s)

    completed_reqs = 0
    opportunistic_reqs = 0
    teleports = 0

    def _mark_completed(rid: ReqId, *, opportunistic: bool) -> None:
        nonlocal completed_reqs, opportunistic_reqs
        if rid not in unvisited:
            return
        unvisited.discard(rid)
        comp_id = req_to_comp.get(rid, -1)
        comp_remaining_req_count[comp_id] = comp_remaining_req_count.get(comp_id, 0) - 1
        comp_remaining_seg_count[comp_id] = comp_remaining_seg_count.get(comp_id, 0.0) - _seg_count(rid)
        _remove_req_from_targets(rid)
        completed_reqs += 1
        if opportunistic:
            opportunistic_reqs += 1

    def _mark_skipped(rid: ReqId) -> None:
        if rid not in unvisited:
            return
        unvisited.discard(rid)
        skipped_disconnected.add(rid)
        comp_id = req_to_comp.get(rid, -1)
        comp_remaining_req_count[comp_id] = comp_remaining_req_count.get(comp_id, 0) - 1
        comp_remaining_seg_count[comp_id] = comp_remaining_seg_count.get(comp_id, 0.0) - _seg_count(rid)
        _remove_req_from_targets(rid)

    def _traverse_edge(edge: EdgeRef, *, opportunistic: bool) -> None:
        nonlocal total_dist, service_dist, deadhead_dist
        u, v, k = edge
        _append_edge_geometry(u, v, k)
        length_m = edge_length_m(G, u, v, k)

        rid = edge_to_rid.get(edge)
        if rid is not None and rid in unvisited:
            # Treat this traversal as servicing the requirement even if we were
            # conceptually deadheading to somewhere else.
            service_dist += length_m
            total_dist += length_m
            _mark_completed(rid, opportunistic=opportunistic)
        else:
            deadhead_dist += length_m
            total_dist += length_m

    def _traverse_path(path_edges: list[EdgeRef]) -> None:
        nonlocal current_node
        for e in path_edges:
            _traverse_edge(e, opportunistic=True)
            current_node = e[1]

    def _teleport_to_best_start(targets: set[int]) -> int | None:
        nonlocal teleports, current_node
        if not targets:
            return None
        old_node = current_node
        old_xy = node_xy.get(old_node)
        if old_xy is None:
            return None
        best_start: int | None = None
        best_score = float("inf")
        for s in targets:
            if s not in G.nodes:
                continue
            if G.out_degree(s) <= 0:
                continue
            xy = node_xy.get(s)
            if xy is None:
                continue
            dx = float(xy[0] - old_xy[0])
            dy = float(xy[1] - old_xy[1])
            jump_score = dx * dx + dy * dy
            comp_id = start_to_comp.get(s, -1)
            benefit = comp_remaining_seg_count.get(comp_id, 1.0)
            score = jump_score / max(benefit, 1.0)
            if score < best_score:
                best_score = score
                best_start = s
        if best_start is None:
            return None
        teleports += 1
        current_node = best_start
        log_jump_distance(old_node, best_start, node_xy)
        return best_start

    # Greedy loop
    iterations = 0
    active_comp: int | None = None
    max_iterations = max(1_000, len(required_reqs) * 10)

    while unvisited and iterations < max_iterations:
        iterations += 1

        # Select an active component when needed.
        if active_comp is None or comp_remaining_req_count.get(active_comp, 0) <= 0:
            if not global_targets:
                # Should not happen if bookkeeping is correct, but don't spin.
                logger.warning(
                    "No remaining target starts but %d requirements are unvisited; skipping the rest",
                    len(unvisited),
                )
                for rid in list(unvisited):
                    _mark_skipped(rid)
                break

            def _global_score(node: int, d: float) -> float:
                comp_id = start_to_comp.get(node, -1)
                benefit = comp_remaining_seg_count.get(comp_id, 1.0)
                return float(d) / max(float(benefit), 1.0)

            result = dijkstra_to_best_target(
                G,
                current_node,
                global_targets,
                weight="length",
                score_fn=_global_score,
            )
            if result is None:
                # Teleport to a new component to continue coverage; gaps are filled later.
                if _teleport_to_best_start(global_targets) is None:
                    for rid in list(unvisited):
                        _mark_skipped(rid)
                    break
                active_comp = start_to_comp.get(current_node)
                continue

            target_start, _d_dead, path_edges = result
            if path_edges:
                _traverse_path(path_edges)
            current_node = target_start
            active_comp = start_to_comp.get(target_start)
            continue

        # Prefer adjacent required edges in the active component.
        start_rids = start_to_rids.get(current_node, set())
        candidates = [
            rid
            for rid in start_rids
            if rid in unvisited and req_to_comp.get(rid, -1) == active_comp
        ]

        if not candidates:
            comp_target_nodes = comp_targets.get(active_comp, set())
            if not comp_target_nodes:
                active_comp = None
                continue

            def _comp_score(node: int, d: float) -> float:
                # Prefer starts with more remaining work.
                return float(d) / max(float(start_counts.get(node, 1)), 1.0)

            result = dijkstra_to_best_target(
                G,
                current_node,
                comp_target_nodes,
                weight="length",
                score_fn=_comp_score,
            )
            if result is None:
                # Try a local teleport within the component before giving up.
                if _teleport_to_best_start(comp_target_nodes) is not None:
                    continue

                comp_rids = [rid for rid in list(unvisited) if req_to_comp.get(rid, -1) == active_comp]
                if comp_rids:
                    logger.warning(
                        "Skipping %d requirements in unreachable component %s",
                        len(comp_rids),
                        active_comp,
                    )
                    for rid in comp_rids:
                        _mark_skipped(rid)
                active_comp = None
                continue

            target_start, _d_dead, path_edges = result
            if path_edges:
                _traverse_path(path_edges)
            current_node = target_start
            continue

        def _candidate_score(rid: ReqId) -> tuple[float, float, float]:
            service_edge = _best_service_edge_from_start(rid, current_node)
            seg_count = _seg_count(rid)
            edge_len = edge_length_m(G, service_edge[0], service_edge[1], service_edge[2])
            next_node_score = float(start_counts.get(service_edge[1], 0))
            return (-seg_count, -edge_len, -next_node_score)

        chosen_rid = min(candidates, key=_candidate_score)
        service_edge = _best_service_edge_from_start(chosen_rid, current_node)
        _traverse_edge(service_edge, opportunistic=False)
        current_node = service_edge[1]

    # If we bailed out, don't claim success on leftovers.
    if unvisited:
        logger.warning(
            "Greedy solver exited with %d unvisited requirements; marking them as skipped",
            len(unvisited),
        )
        for rid in list(unvisited):
            _mark_skipped(rid)

    if skipped_disconnected:
        logger.warning(
            "Route generation completed with %d/%d requirements skipped (likely disconnected graph components)",
            len(skipped_disconnected),
            len(required_reqs),
        )

    stats: dict[str, float] = {
        "total_distance": float(total_dist),
        "required_distance": float(required_dist_all),
        "required_distance_completed": float(service_dist),
        "service_distance": float(service_dist),
        "deadhead_distance": float(deadhead_dist),
        "deadhead_percentage": float(
            (deadhead_dist / total_dist * 100.0) if total_dist > 0 else 0.0,
        ),
        "deadhead_ratio_all": float(total_dist / required_dist_all) if required_dist_all > 0 else 0.0,
        "deadhead_ratio_completed": float(total_dist / service_dist) if service_dist > 0 else 0.0,
        "required_reqs": float(len(required_reqs)),
        "completed_reqs": float(completed_reqs),
        "skipped_disconnected": float(len(skipped_disconnected)),
        "opportunistic_completed": float(opportunistic_reqs),
        "teleports": float(teleports),
        "iterations": float(iterations),
    }
    return route_coords, stats, route_edges
