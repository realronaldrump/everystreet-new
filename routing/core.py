import logging
from dataclasses import dataclass, field

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
        if G.nodes[n].get("x") is not None and G.nodes[n].get("y") is not None
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


@dataclass
class GreedySolverState:
    G: nx.MultiDiGraph
    required_reqs: dict[ReqId, list[EdgeRef]]
    req_segment_counts: dict[ReqId, int] | None
    node_xy: dict[int, tuple[float, float]]
    current_node: int
    req_to_starts: dict[ReqId, list[int]]
    start_counts: dict[int, int]
    start_to_rids: dict[int, set[ReqId]]
    unvisited: set[ReqId]
    edge_to_rid: dict[EdgeRef, ReqId]
    req_to_comp: dict[ReqId, int]
    comp_to_rids: dict[int, set[ReqId]]
    comp_targets: dict[int, set[int]]
    start_to_comp: dict[int, int]
    global_targets: set[int]
    comp_remaining_req_count: dict[int, int]
    comp_remaining_seg_count: dict[int, float]
    route_coords: list[list[float]] = field(default_factory=list)
    route_edges: list[EdgeRef] = field(default_factory=list)
    edge_geo_cache: dict[EdgeRef, list[list[float]]] = field(default_factory=dict)
    skipped_disconnected: set[ReqId] = field(default_factory=set)
    service_sequence: list[tuple[ReqId, EdgeRef]] = field(default_factory=list)
    teleport_pairs: list[tuple[tuple[float, float], tuple[float, float]]] = field(
        default_factory=list,
    )
    total_dist: float = 0.0
    service_dist: float = 0.0
    deadhead_dist: float = 0.0
    completed_reqs: int = 0
    opportunistic_reqs: int = 0
    teleports: int = 0
    iterations: int = 0

    def seg_count(self, rid: ReqId) -> float:
        if self.req_segment_counts is None:
            return 1.0
        return float(self.req_segment_counts.get(rid, 1))

    def append_coords(self, coords: list[list[float]]) -> None:
        if not coords:
            return
        if self.route_coords:
            self.route_coords.extend(coords[1:])
        else:
            self.route_coords.extend(coords)

    def append_edge_geometry(self, edge: EdgeRef) -> None:
        u, v, k = edge
        geo = self.edge_geo_cache.get(edge)
        if geo is None:
            key = None if k == -1 else k
            geo = get_edge_geometry(self.G, u, v, key, node_xy=self.node_xy)
            self.edge_geo_cache[edge] = geo
        self.append_coords(geo)
        self.route_edges.append(edge)

    def best_service_edge_from_start(self, rid: ReqId, start: int) -> EdgeRef:
        opts = [e for e in self.required_reqs[rid] if e[0] == start]
        return min(opts, key=lambda e: edge_length_m(self.G, e[0], e[1], e[2]))

    def remove_req_from_targets(self, rid: ReqId) -> None:
        comp_id = self.req_to_comp.get(rid, -1)
        for start in self.req_to_starts.get(rid, []):
            self.start_counts[start] = self.start_counts.get(start, 0) - 1
            if self.start_counts[start] <= 0:
                self.global_targets.discard(start)
                self.comp_targets.get(comp_id, set()).discard(start)

    def mark_completed(self, rid: ReqId, *, opportunistic: bool) -> None:
        if rid not in self.unvisited:
            return
        self.unvisited.discard(rid)
        comp_id = self.req_to_comp.get(rid, -1)
        self.comp_remaining_req_count[comp_id] = (
            self.comp_remaining_req_count.get(comp_id, 0) - 1
        )
        self.comp_remaining_seg_count[comp_id] = self.comp_remaining_seg_count.get(
            comp_id,
            0.0,
        ) - self.seg_count(rid)
        self.remove_req_from_targets(rid)
        self.completed_reqs += 1
        if opportunistic:
            self.opportunistic_reqs += 1

    def mark_skipped(self, rid: ReqId) -> None:
        if rid not in self.unvisited:
            return
        self.unvisited.discard(rid)
        self.skipped_disconnected.add(rid)
        comp_id = self.req_to_comp.get(rid, -1)
        self.comp_remaining_req_count[comp_id] = (
            self.comp_remaining_req_count.get(comp_id, 0) - 1
        )
        self.comp_remaining_seg_count[comp_id] = self.comp_remaining_seg_count.get(
            comp_id,
            0.0,
        ) - self.seg_count(rid)
        self.remove_req_from_targets(rid)

    def traverse_edge(self, edge: EdgeRef, *, opportunistic: bool) -> None:
        self.append_edge_geometry(edge)
        length_m = edge_length_m(self.G, edge[0], edge[1], edge[2])
        rid = self.edge_to_rid.get(edge)
        if rid is not None and rid in self.unvisited:
            self.service_dist += length_m
            self.total_dist += length_m
            self.service_sequence.append((rid, edge))
            self.mark_completed(rid, opportunistic=opportunistic)
            return
        self.deadhead_dist += length_m
        self.total_dist += length_m

    def traverse_path(self, path_edges: list[EdgeRef]) -> None:
        for edge in path_edges:
            self.traverse_edge(edge, opportunistic=True)
            self.current_node = edge[1]

    def teleport_to_best_start(self, targets: set[int]) -> int | None:
        if not targets:
            return None
        old_node = self.current_node
        old_xy = self.node_xy.get(old_node)
        if old_xy is None:
            return None

        best_start: int | None = None
        best_score = float("inf")
        for start in targets:
            if start not in self.G.nodes or self.G.out_degree(start) <= 0:
                continue
            xy = self.node_xy.get(start)
            if xy is None:
                continue
            dx = float(xy[0] - old_xy[0])
            dy = float(xy[1] - old_xy[1])
            jump_score = dx * dx + dy * dy
            comp_id = self.start_to_comp.get(start, -1)
            benefit = self.comp_remaining_seg_count.get(comp_id, 1.0)
            score = jump_score / max(benefit, 1.0)
            if score < best_score:
                best_score = score
                best_start = start

        if best_start is None:
            return None
        self.teleports += 1
        new_xy = self.node_xy.get(best_start)
        if old_xy and new_xy:
            self.teleport_pairs.append((old_xy, new_xy))
        self.current_node = best_start
        log_jump_distance(old_node, best_start, self.node_xy)
        return best_start

    def skip_all_unvisited(self) -> None:
        for rid in list(self.unvisited):
            self.mark_skipped(rid)


def _build_edge_to_requirement(
    required_reqs: dict[ReqId, list[EdgeRef]],
) -> dict[EdgeRef, ReqId]:
    edge_to_rid: dict[EdgeRef, ReqId] = {}
    for rid, options in required_reqs.items():
        for edge in options:
            edge_to_rid.setdefault(edge, rid)
    return edge_to_rid


def _build_component_remaining_counts(
    comp_to_rids: dict[int, set[ReqId]],
    req_segment_counts: dict[ReqId, int] | None,
) -> tuple[dict[int, int], dict[int, float]]:
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
    return comp_remaining_req_count, comp_remaining_seg_count


def _pick_global_target_component(
    state: GreedySolverState,
    *,
    active_comp: int | None,
) -> tuple[int | None, bool]:
    if (
        active_comp is not None
        and state.comp_remaining_req_count.get(active_comp, 0) > 0
    ):
        return active_comp, False

    if not state.global_targets:
        logger.warning(
            "No remaining target starts but %d requirements are unvisited; skipping the rest",
            len(state.unvisited),
        )
        state.skip_all_unvisited()
        return None, True

    def global_score(node: int, dist_m: float) -> float:
        comp_id = state.start_to_comp.get(node, -1)
        benefit = state.comp_remaining_seg_count.get(comp_id, 1.0)
        return float(dist_m) / max(float(benefit), 1.0)

    result = dijkstra_to_best_target(
        state.G,
        state.current_node,
        state.global_targets,
        weight="length",
        score_fn=global_score,
    )
    if result is None:
        if state.teleport_to_best_start(state.global_targets) is None:
            state.skip_all_unvisited()
            return None, True
        return state.start_to_comp.get(state.current_node), True

    target_start, _distance, path_edges = result
    if path_edges:
        state.traverse_path(path_edges)
    state.current_node = target_start
    return state.start_to_comp.get(target_start), True


def _try_service_adjacent_requirement(
    state: GreedySolverState,
    *,
    active_comp: int,
) -> bool:
    start_rids = state.start_to_rids.get(state.current_node, set())
    candidates = [
        rid
        for rid in start_rids
        if rid in state.unvisited and state.req_to_comp.get(rid, -1) == active_comp
    ]
    if not candidates:
        return False

    def candidate_score(rid: ReqId) -> tuple[float, float, float]:
        service_edge = state.best_service_edge_from_start(rid, state.current_node)
        seg_count = state.seg_count(rid)
        edge_len = edge_length_m(
            state.G,
            service_edge[0],
            service_edge[1],
            service_edge[2],
        )
        next_node_score = float(state.start_counts.get(service_edge[1], 0))
        return (-seg_count, -edge_len, -next_node_score)

    chosen_rid = min(candidates, key=candidate_score)
    service_edge = state.best_service_edge_from_start(chosen_rid, state.current_node)
    state.traverse_edge(service_edge, opportunistic=False)
    state.current_node = service_edge[1]
    return True


def _move_within_component_or_skip(
    state: GreedySolverState,
    *,
    active_comp: int,
) -> tuple[int | None, bool]:
    comp_target_nodes = state.comp_targets.get(active_comp, set())
    if not comp_target_nodes:
        return None, True

    def comp_score(node: int, dist_m: float) -> float:
        return float(dist_m) / max(float(state.start_counts.get(node, 1)), 1.0)

    result = dijkstra_to_best_target(
        state.G,
        state.current_node,
        comp_target_nodes,
        weight="length",
        score_fn=comp_score,
    )
    if result is None:
        if state.teleport_to_best_start(comp_target_nodes) is not None:
            return active_comp, True

        comp_rids = [
            rid
            for rid in list(state.unvisited)
            if state.req_to_comp.get(rid, -1) == active_comp
        ]
        if comp_rids:
            logger.warning(
                "Skipping %d requirements in unreachable component %s",
                len(comp_rids),
                active_comp,
            )
            for rid in comp_rids:
                state.mark_skipped(rid)
        return None, True

    target_start, _distance, path_edges = result
    if path_edges:
        state.traverse_path(path_edges)
    state.current_node = target_start
    return active_comp, True


def _run_greedy_iterations(
    state: GreedySolverState,
    *,
    max_iterations: int,
) -> None:
    active_comp: int | None = None
    while state.unvisited and state.iterations < max_iterations:
        state.iterations += 1

        active_comp, should_continue = _pick_global_target_component(
            state,
            active_comp=active_comp,
        )
        if should_continue:
            continue
        if active_comp is None:
            break

        if _try_service_adjacent_requirement(state, active_comp=active_comp):
            continue

        active_comp, should_continue = _move_within_component_or_skip(
            state,
            active_comp=active_comp,
        )
        if should_continue:
            continue


def _build_solver_state(
    G: nx.MultiDiGraph,
    required_reqs: dict[ReqId, list[EdgeRef]],
    *,
    start_node: int | None,
    req_segment_counts: dict[ReqId, int] | None,
    node_xy: dict[int, tuple[float, float]] | None,
) -> tuple[GreedySolverState, float]:
    current_node, resolved_node_xy = initialize_route_state(
        G,
        required_reqs,
        start_node,
    )
    if node_xy is None:
        node_xy = resolved_node_xy

    req_to_starts, start_counts, start_to_rids = build_requirement_indices(
        required_reqs,
    )
    unvisited: set[ReqId] = set(required_reqs.keys())
    edge_to_rid = _build_edge_to_requirement(required_reqs)
    required_dist_all = calculate_required_distance(G, required_reqs)

    req_to_comp, comp_to_rids, comp_targets, start_to_comp = build_component_structure(
        G,
        required_reqs,
        req_to_starts,
    )
    global_targets: set[int] = set(start_counts.keys())
    comp_remaining_req_count, comp_remaining_seg_count = (
        _build_component_remaining_counts(comp_to_rids, req_segment_counts)
    )

    state = GreedySolverState(
        G=G,
        required_reqs=required_reqs,
        req_segment_counts=req_segment_counts,
        node_xy=node_xy,
        current_node=current_node,
        req_to_starts=req_to_starts,
        start_counts=start_counts,
        start_to_rids=start_to_rids,
        unvisited=unvisited,
        edge_to_rid=edge_to_rid,
        req_to_comp=req_to_comp,
        comp_to_rids=comp_to_rids,
        comp_targets=comp_targets,
        start_to_comp=start_to_comp,
        global_targets=global_targets,
        comp_remaining_req_count=comp_remaining_req_count,
        comp_remaining_seg_count=comp_remaining_seg_count,
    )
    return state, required_dist_all


def _build_solver_stats(
    state: GreedySolverState,
    *,
    required_dist_all: float,
    required_reqs_count: int,
) -> dict[str, float]:
    return {
        "total_distance": float(state.total_dist),
        "required_distance": float(required_dist_all),
        "required_distance_completed": float(state.service_dist),
        "service_distance": float(state.service_dist),
        "deadhead_distance": float(state.deadhead_dist),
        "deadhead_percentage": float(
            (
                (state.deadhead_dist / state.total_dist * 100.0)
                if state.total_dist > 0
                else 0.0
            ),
        ),
        "deadhead_ratio_all": (
            float(state.total_dist / required_dist_all)
            if required_dist_all > 0
            else 0.0
        ),
        "deadhead_ratio_completed": (
            float(state.total_dist / state.service_dist)
            if state.service_dist > 0
            else 0.0
        ),
        "required_reqs": float(required_reqs_count),
        "completed_reqs": float(state.completed_reqs),
        "skipped_disconnected": float(len(state.skipped_disconnected)),
        "opportunistic_completed": float(state.opportunistic_reqs),
        "teleports": float(state.teleports),
        "iterations": float(state.iterations),
    }


def solve_greedy_route(
    G: nx.MultiDiGraph,
    required_reqs: dict[ReqId, list[EdgeRef]],
    start_node: int | None = None,
    req_segment_counts: dict[ReqId, int] | None = None,
    node_xy: dict[int, tuple[float, float]] | None = None,
) -> tuple[
    list[list[float]],
    dict[str, float],
    list[EdgeRef],
    list[tuple[ReqId, EdgeRef]],
]:
    """
    Solve with connectivity-first greedy strategy:

    Prefer adjacent required edges within the same component before deadheading.
    When deadheading is needed, route to the nearest required start by graph distance.

    Handles disconnected graph components gracefully by skipping unreachable segments
    rather than failing. This is common in real-world geographies with rivers, highways,
    or one-way streets that create barriers.
    """
    state, required_dist_all = _build_solver_state(
        G,
        required_reqs,
        start_node=start_node,
        req_segment_counts=req_segment_counts,
        node_xy=node_xy,
    )
    max_iterations = max(1_000, len(required_reqs) * 10)
    _run_greedy_iterations(state, max_iterations=max_iterations)

    if state.unvisited:
        logger.warning(
            "Greedy solver exited with %d unvisited requirements; marking them as skipped",
            len(state.unvisited),
        )
        state.skip_all_unvisited()

    if state.skipped_disconnected:
        logger.warning(
            "Route generation completed with %d/%d requirements skipped (likely disconnected graph components)",
            len(state.skipped_disconnected),
            len(required_reqs),
        )

    stats = _build_solver_stats(
        state,
        required_dist_all=required_dist_all,
        required_reqs_count=len(required_reqs),
    )
    return state.route_coords, stats, state.route_edges, state.service_sequence
