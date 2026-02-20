from __future__ import annotations

import networkx as nx

from routing.core import make_req_id, solve_greedy_route


def test_solver_teleports_between_disconnected_components_and_counts_it() -> None:
    G = nx.MultiDiGraph()

    # Component A
    G.add_node(1, x=0.0, y=0.0)
    G.add_node(2, x=0.0, y=0.001)
    G.add_edge(1, 2, key=0, length=10.0)

    # Component B
    G.add_node(100, x=1.0, y=1.0)
    G.add_node(101, x=1.0, y=1.001)
    G.add_edge(100, 101, key=0, length=20.0)

    required_reqs = {}
    req_counts = {}
    for edge in [(1, 2, 0), (100, 101, 0)]:
        rid, options = make_req_id(G, edge)
        required_reqs[rid] = options
        req_counts[rid] = 1

    coords, stats, _edges, _sequence = solve_greedy_route(
        G,
        required_reqs,
        start_node=1,
        req_segment_counts=req_counts,
    )

    assert coords
    assert stats["required_distance"] == 30.0
    assert stats["required_distance_completed"] == 30.0
    assert stats["deadhead_distance"] == 0.0
    assert stats["total_distance"] == 30.0
    assert stats["teleports"] == 1.0
    assert stats["skipped_disconnected"] == 0.0
