from __future__ import annotations

import math

import networkx as nx

from routing.graph import (
    choose_consensus_edge_match,
    graph_units_to_feet,
    prepare_spatial_matching_graph,
    project_linestring_coords,
)


def test_choose_consensus_edge_match_prefers_vote_count() -> None:
    edge, dist_ft = choose_consensus_edge_match(
        [
            ((1, 2, 0), 20.0),
            ((1, 2, 0), 24.0),
            ((3, 4, 0), 8.0),
        ],
    )
    assert edge == (1, 2, 0)
    assert math.isclose(dist_ft, 22.0, rel_tol=1e-6)


def test_graph_units_to_feet_uses_projected_crs_units() -> None:
    G = nx.MultiDiGraph()
    G.graph["crs"] = "EPSG:3857"
    distance_ft = graph_units_to_feet(G, 100.0)
    assert math.isclose(distance_ft, 328.084, rel_tol=1e-4)


def test_graph_units_to_feet_geographic_is_latitude_aware() -> None:
    equator = nx.MultiDiGraph()
    equator.graph["crs"] = "EPSG:4326"
    equator.add_node(1, x=-80.0, y=0.0)
    equator.add_node(2, x=-80.1, y=0.1)

    high_lat = nx.MultiDiGraph()
    high_lat.graph["crs"] = "EPSG:4326"
    high_lat.add_node(1, x=-80.0, y=60.0)
    high_lat.add_node(2, x=-80.1, y=60.1)

    d_units = 0.001
    equator_ft = graph_units_to_feet(equator, d_units)
    high_lat_ft = graph_units_to_feet(high_lat, d_units)
    assert high_lat_ft < equator_ft


def test_prepare_spatial_matching_graph_keeps_projected_graph() -> None:
    G = nx.MultiDiGraph()
    G.graph["crs"] = "EPSG:3857"
    projected, project_xy = prepare_spatial_matching_graph(G)

    assert projected is G
    x, y = project_xy(1.0, 1.0)
    assert x > 100_000.0
    assert y > 100_000.0


def test_project_linestring_coords_projects_points() -> None:
    coords = [[1.0, 2.0], [3.0, 4.0]]
    projected = project_linestring_coords(coords, lambda x, y: (x + 10.0, y - 5.0))
    assert projected == [[11.0, -3.0], [13.0, -1.0]]
