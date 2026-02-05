from __future__ import annotations

from pathlib import Path

import networkx as nx
import osmnx as ox
import pytest
from shapely.geometry import LineString

from core.osmnx_graphml import load_graphml_robust


def test_load_graphml_robust_repairs_invalid_bool_literals(tmp_path: Path) -> None:
    # Create a minimal GraphML that triggers OSMnx's bool conversion error:
    # `oneway` must be "True"/"False" but here we write "yes".
    G = nx.MultiDiGraph()
    G.add_node(1, x="0.0", y="0.0")
    G.add_node(2, x="1.0", y="1.0")
    G.add_edge(
        1,
        2,
        key=0,
        oneway="yes",
        geometry="LINESTRING (0 0, 1 1)",
        length="1.0",
    )

    graph_path = tmp_path / "bad.graphml"
    nx.write_graphml(G, graph_path)

    with pytest.raises(ValueError, match="Invalid literal for boolean"):
        ox.load_graphml(graph_path)

    repaired = load_graphml_robust(graph_path)
    assert isinstance(repaired, nx.MultiDiGraph)

    # Ensure the robust loader returned a graph with correctly-typed attributes.
    assert repaired.edges[1, 2, 0]["oneway"] is True
    assert isinstance(repaired.edges[1, 2, 0]["geometry"], LineString)
