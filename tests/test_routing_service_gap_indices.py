from __future__ import annotations

import networkx as nx
from shapely.geometry import LineString

from routing.service import _derive_explicit_gap_indices_from_edges


def test_derive_explicit_gap_indices_from_edges_marks_discontinuities() -> None:
    G = nx.MultiDiGraph()
    G.graph["crs"] = "epsg:4326"

    G.add_node(1, x=0.0, y=0.0)
    G.add_node(2, x=0.0, y=0.01)
    G.add_node(3, x=1.0, y=1.0)
    G.add_node(4, x=1.0, y=1.01)

    G.add_edge(
        1,
        2,
        key=0,
        length=100.0,
        geometry=LineString([(0.0, 0.0), (0.0, 0.01)]),
    )
    G.add_edge(
        3,
        4,
        key=0,
        length=100.0,
        geometry=LineString([(1.0, 1.0), (1.0, 1.01)]),
    )

    # Route coords shape matches append logic:
    # first edge contributes 2 points, second contributes 1 (geometry[1:]).
    route_coord_count = 3
    route_edges = [(1, 2, 0), (3, 4, 0)]

    indices = _derive_explicit_gap_indices_from_edges(
        G,
        route_edges,
        route_coord_count,
    )

    assert indices == [2]
