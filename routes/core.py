import logging

import networkx as nx

from .geometry import log_jump_distance
from .graph import (dijkstra_to_any_target, edge_length_m, get_edge_geometry,
                    reverse_candidates_for_edge)
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


def calculate_required_distance(
    G: nx.MultiDiGraph,
    required_reqs: dict[ReqId, list[EdgeRef]],
) -> float:
    """Calculate total required distance from all requirements."""
    required_dist = 0.0
    for _rid, opts in required_reqs.items():
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
]:
    """Build component-aware grouping for required edges."""
    # Build undirected graph of requirements
    req_repr_edge: dict[ReqId, EdgeRef] = {}
    req_graph = nx.Graph()
    for rid, opts in required_reqs.items():
        best = min(opts, key=lambda e: edge_length_m(G, e[0], e[1], e[2]))
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
    req_to_starts, start_counts = build_requirement_indices(required_reqs)
    unvisited: set[ReqId] = set(required_reqs.keys())

    # Calculate distances
    total_dist = 0.0
    required_dist = calculate_required_distance(G, required_reqs)
    deadhead_dist = 0.0

    # Build component structure
    req_to_comp, comp_to_rids, comp_targets = build_component_structure(
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
            geo = get_edge_geometry(G, u, v, key, node_xy=node_xy)
            _append_coords(geo)
            route_edges.append((u, v, k))

    def _best_service_edge_from_start(rid: ReqId, start: int) -> EdgeRef:
        opts = [e for e in required_reqs[rid] if e[0] == start]
        return min(opts, key=lambda e: edge_length_m(G, e[0], e[1], e[2]))

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

            result = dijkstra_to_any_target(
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
                log_jump_distance(old_node, current_node, node_xy)

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
            result = dijkstra_to_any_target(
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
            edge_len = edge_length_m(
                G, service_edge[0], service_edge[1], service_edge[2]
            )
            return (-seg_count, -edge_len)

        chosen_rid = min(candidates, key=_candidate_score)
        service_edge = _best_service_edge_from_start(chosen_rid, current_node)
        su, sv, sk = service_edge

        # Service traversal geometry
        service_geo = get_edge_geometry(G, su, sv, sk, node_xy=node_xy)
        _append_coords(service_geo)
        route_edges.append((su, sv, sk))

        # Dist update
        s_len = edge_length_m(G, su, sv, sk)
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
