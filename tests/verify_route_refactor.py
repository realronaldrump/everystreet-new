import networkx as nx

from routes.core import solve_greedy_route
from routes.graph import dijkstra_to_any_target
from routes.types import ReqId


def test_greedy_solver_disconnected():
    print("Testing greedy solver with disconnected graph...")

    # Create two disconnected components
    G = nx.MultiDiGraph()
    # Component 1: 0 -> 1
    G.add_node(0, x=0, y=0)
    G.add_node(1, x=1, y=1)
    G.add_edge(0, 1, key=0, length=100)

    # Component 2: 2 -> 3
    G.add_node(2, x=10, y=10)
    G.add_node(3, x=11, y=11)
    G.add_edge(2, 3, key=0, length=100)

    # Requirements: both edges
    req1: ReqId = frozenset([(0, 1, 0)])
    req2: ReqId = frozenset([(2, 3, 0)])

    required_reqs = {req1: [(0, 1, 0)], req2: [(2, 3, 0)]}

    # Run solver starting at 0
    route_coords, stats, route_edges = solve_greedy_route(
        G, required_reqs, start_node=0
    )

    print("Route stats:", stats)

    # Expectation:
    # It should visit 0->1.
    # It will jump to 2->3 (disconnected) with a warning (logged).
    # It should complete both.

    assert (
        stats["completed_reqs"] == 2.0
    ), f"Expected 2 completed req, got {stats['completed_reqs']}"
    assert (
        stats["skipped_disconnected"] == 0.0
    ), f"Expected 0 skipped req, got {stats['skipped_disconnected']}"

    print("SUCCESS: Disconnected graph handled correctly.")


def test_dijkstra():
    print("Testing Dijkstra...")
    G = nx.MultiDiGraph()
    G.add_edge(0, 1, length=10)
    G.add_edge(1, 2, length=10)
    G.add_edge(0, 2, length=50)  # longer direct path

    target = 2
    res = dijkstra_to_any_target(G, 0, {target})

    assert res is not None
    u, dist, edges = res
    assert u == 2
    assert dist == 20.0
    assert len(edges) == 2  # 0->1, 1->2
    print("SUCCESS: Dijkstra found shortest path.")


if __name__ == "__main__":
    test_dijkstra()
    test_greedy_solver_disconnected()
